/**
 * Pure rules for mirroring the on-chain `player_state` accounts into the game (no DOM, no RPC):
 * chain state -> the game's equipment / synthesis / aquarium shapes, Config prices -> the game's
 * price tables, which aquarium fish a pour can feed (the program's feed_one rule), and whether a
 * payment whose confirmation was lost already shows in the re-read accounts.
 *
 * The chain is the source of truth: the game never bumps a level, a material or a growth entry
 * itself. player-chain.ts reads the accounts and sends the instructions; main.ts renders.
 */
import { BOAT_ORDER, fishKey, MAP_ORDER, toAquariumGrowth, toEquipmentState, toSynthesisState, SLOT_ORDER } from './player-state';
import type { AquariumAccount, FishGrowthEntry, PlayerStateAccount, PriceTable, ProgressAccount, ProgressRules } from './player-state';
import type { BoatId } from './gear-nft';
import type { MapId } from './maps';
import type { EquipmentPaths, EquipmentSlot, EquipmentState, UpgradeSlot } from './equipment';
import type { MaterialId, RecipeDef, SynthesisState } from './synthesis';
import type { FishFoodId } from './fish-food';
import type { AquariumGrowth } from './aquarium-state';

/** The game's starting paths (equipment.ts DEFAULT_EQUIPMENT_PATHS), path 0 on chain. */
const DEFAULT_PATHS: EquipmentPaths = { rod: 'far', net: 'wide', fins: 'sprint', tank: 'long', lamp: 'focus', reel: 'fastReel' };

const num = (v: bigint): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`price out of range: ${v}`);
  return n;
};

// ---- Prices ------------------------------------------------------------------------

/** The Config's prices as whole-PEARL numbers, in the shapes the game's tables use. */
export interface GamePrices {
  /** Per slot: [Lv1 (0), Lv2, Lv3]. */
  upgrade: Record<UpgradeSlot, [number, number, number]>;
  /** Per slot: the station fee for [Lv1->2, Lv2->3]. */
  synthUpgrade: Record<UpgradeSlot, [number, number]>;
  recipe: Record<RecipeDef['id'], number>;
  food: Record<FishFoodId, number>;
}

export function gamePrices(p: PriceTable): GamePrices {
  const map = <K extends string, V, W>(r: Record<K, V>, f: (v: V) => W) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, f(v as V)])) as Record<K, W>;
  return {
    upgrade: map(p.upgrade, (t) => [num(t[0]), num(t[1]), num(t[2])] as [number, number, number]),
    synthUpgrade: map(p.synthUpgrade, (t) => [num(t[0]), num(t[1])] as [number, number]),
    recipe: map(p.recipeCost, num),
    food: map(p.foodPrice, num),
  };
}

/** What buying the next level of `slot` costs at Config prices, or null at the top level. */
export function upgradeQuote(prices: PriceTable, levels: Record<UpgradeSlot, number>, slot: UpgradeSlot, pearls: number) {
  const level = levels[slot] ?? 1;
  if (level >= 3) return null;
  const cost = num(prices.upgrade[slot][level]);
  return { level: level + 1, cost, short: Math.max(0, cost - pearls) };
}

export type SynthBlock = 'max' | 'no-composite';

/** What a synthesis-station upgrade of `slot` costs, or why it cannot happen. */
export function synthQuote(
  prices: PriceTable,
  levels: Record<UpgradeSlot, number>,
  crafted: SynthesisState['crafted'],
  slot: UpgradeSlot,
  pearls: number,
): { level: number; cost: number; short: number } | { blocked: SynthBlock } {
  const level = levels[slot] ?? 1;
  if (level >= 3) return { blocked: 'max' };
  if (crafted.composite < 1) return { blocked: 'no-composite' };
  const cost = num(prices.synthUpgrade[slot][level - 1]);
  return { level: level + 1, cost, short: Math.max(0, cost - pearls) };
}

/** What one craft costs, or null when the materials are short (the program would refuse it). */
export function craftQuote(prices: PriceTable, materials: Record<MaterialId, number>, recipe: RecipeDef['id'], pearls: number) {
  const needs = prices.recipeNeeds[recipe];
  for (const m of Object.keys(needs) as MaterialId[]) if ((materials[m] ?? 0) < needs[m]) return null;
  const cost = num(prices.recipeCost[recipe]);
  return { cost, short: Math.max(0, cost - pearls) };
}

// ---- State -> game ---------------------------------------------------------------

/** Chain levels by slot, Lv1 everywhere for a player with no account yet. */
export function chainLevels(player: PlayerStateAccount | null): Record<UpgradeSlot, number> {
  return Object.fromEntries(SLOT_ORDER.map((s) => [s, player ? player.levels[s] : 1])) as Record<UpgradeSlot, number>;
}

/**
 * The game's equipment from the chain: levels and paths come from the PlayerState (all Lv1 and
 * default paths when it does not exist yet: everyone starts from zero); the PEARL cache and the
 * legacy Pearls are kept from `current`. With `biteUnsettled` (a shark bite not yet on chain),
 * the dive gear shows reset, exactly as shark_bite will leave it.
 */
export function equipmentFromChain(current: EquipmentState, player: PlayerStateAccount | null, biteUnsettled = false): EquipmentState {
  const base: EquipmentState = { ...current, paths: { ...DEFAULT_PATHS } };
  if (!player || biteUnsettled) {
    return { ...base, rodLevel: 1, netLevel: 1, rodGearLevel: 1, reelLevel: 1, finsLevel: 1, tankLevel: 1, lampLevel: 1, sonarLevel: 1 };
  }
  return { ...base, ...toEquipmentState(player) };
}

/** Synthesis materials and crafted items from the chain (Config's starting materials before the account exists). */
export function synthesisFromChain(player: PlayerStateAccount | null, prices: PriceTable): SynthesisState {
  if (player) return toSynthesisState(player);
  return { materials: { ...prices.startingMaterials }, crafted: { bait: 0, composite: 0 } };
}

/** True when a shark bite has nothing left to reset on chain (no account, or all Lv1 and default paths). */
export function biteSettled(player: PlayerStateAccount | null): boolean {
  if (!player) return true;
  return SLOT_ORDER.every((s) => player.levels[s] === 1) && (Object.keys(DEFAULT_PATHS) as EquipmentSlot[]).every((s) => player.paths[s] === DEFAULT_PATHS[s]);
}

// ---- Aquarium ----------------------------------------------------------------------

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The hex of a fish's on-chain growth key (player-state.ts fishKey), or null for an id that is not a hex seed. */
export function fishKeyHex(id: string): string | null {
  try {
    return toHex(fishKey(id));
  } catch {
    return null;
  }
}

/** Growth per fish id, from the Aquarium account. Fish it has no entry for are absent (never fed). */
export function growthByFishId(aquarium: AquariumAccount | null, ids: readonly string[]): Record<string, AquariumGrowth> {
  const out: Record<string, AquariumGrowth> = {};
  if (!aquarium) return out;
  const byKey = new Map(aquarium.entries.map((e) => [e.keyHex, e]));
  for (const id of ids) {
    const key = fishKeyHex(id);
    const entry = key ? byKey.get(key) : undefined;
    if (entry) out[id] = toAquariumGrowth(entry);
  }
  return out;
}

export type FeedBlock = 'max' | 'cooldown';

/**
 * lib.rs feed_one: fully grown first, then the cooldown of the food the fish last ate.
 * `marginMs` keeps the client a little stricter than the validator's clock, so a pour the
 * client allows is not refused on chain for a second of clock drift.
 */
export function feedBlock(entry: FishGrowthEntry | undefined, nowSec: number, prices: PriceTable, marginMs = 2000): FeedBlock | null {
  if (!entry) return null;
  if (entry.growthMilli >= prices.maxGrowthMilli) return 'max';
  if (entry.lastFed !== 0) {
    const cooldownMs = Math.floor((prices.feedCooldownMs * prices.foodCooldownMilli[entry.food]) / 1000);
    const elapsedMs = Math.max(0, Math.floor(nowSec) - entry.lastFed) * 1000;
    if (elapsedMs < cooldownMs + marginMs) return 'cooldown';
  }
  return null;
}

export interface FeedPlan {
  /** Fish ids that will eat, in the order given (one per distinct key). */
  ids: string[];
  /** Their 8-byte keys for the feed instruction. */
  keys: Uint8Array[];
  keysHex: string[];
  /** Why nothing can eat, when `ids` is empty. */
  blocked: FeedBlock | null;
  /** Feeds recorded on chain for these fish before the pour (to recognise it later). */
  feedsBefore: number;
}

/** Which of `ids` one pour can feed now, at most `max` fish (the program's MAX_FISH_PER_CALL). */
export function planFeed(aquarium: AquariumAccount | null, ids: readonly string[], nowSec: number, prices: PriceTable, max = 64): FeedPlan {
  const byKey = new Map((aquarium?.entries ?? []).map((e) => [e.keyHex, e]));
  const plan: FeedPlan = { ids: [], keys: [], keysHex: [], blocked: null, feedsBefore: 0 };
  const seen = new Set<string>();
  for (const id of ids) {
    if (plan.ids.length >= max) break;
    const hex = fishKeyHex(id);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    const entry = byKey.get(hex);
    const block = feedBlock(entry, nowSec, prices);
    if (block) {
      plan.blocked ??= block;
      continue;
    }
    plan.ids.push(id);
    plan.keys.push(fishKey(id));
    plan.keysHex.push(hex);
    plan.feedsBefore += entry?.feedCount ?? 0;
  }
  if (plan.ids.length) plan.blocked = null;
  return plan;
}

// ---- Progress (v2: boats, ships, lifetime banked value) -----------------------------

/** The Progress account as the game uses it (plain numbers). */
export interface ProgressView {
  /** Value of every fish the market recorded (record_catch with each co-signed mint); never decreases. */
  lifetime: number;
  best: number;
  catches: number;
  boatLevels: Record<BoatId, number>;
  /** SHIPS index sailed. */
  ship: number;
}

/**
 * Progress -> the game's numbers. No account yet (no boat bought, no fish recorded): lifetime 0,
 * every boat piece Lv1, the starter ship. Everyone starts from zero.
 */
export function progressView(progress: ProgressAccount | null): ProgressView {
  if (!progress) {
    return { lifetime: 0, best: 0, catches: 0, boatLevels: Object.fromEntries(BOAT_ORDER.map((b) => [b, 1])) as Record<BoatId, number>, ship: 0 };
  }
  return {
    lifetime: num(progress.lifetimeValue),
    best: num(progress.bestValue),
    catches: progress.catches,
    boatLevels: Object.fromEntries(BOAT_ORDER.map((b) => [b, progress.boatLevels[b]])) as Record<BoatId, number>,
    ship: progress.ship,
  };
}

/** ProgressConfig's rules as whole-PEARL / whole-value numbers. */
export interface GameProgressRules {
  /** Per boat piece: [Lv1 (0), Lv2, Lv3] in PEARL. */
  boatPrices: Record<BoatId, [number, number, number]>;
  /** Lifetime banked value per SHIPS index. */
  shipThresholds: number[];
  /** Lifetime banked value per map. */
  mapThresholds: Record<MapId, number>;
}

export function gameProgressRules(r: ProgressRules): GameProgressRules {
  return {
    boatPrices: Object.fromEntries(BOAT_ORDER.map((b) => [b, r.boatPrices[b].map(num) as [number, number, number]])) as Record<BoatId, [number, number, number]>,
    shipThresholds: r.shipThresholds.map(num),
    mapThresholds: Object.fromEntries(MAP_ORDER.map((m) => [m, num(r.mapThresholds[m])])) as Record<MapId, number>,
  };
}

/** What buy_boat for the next level of `boat` costs at ProgressConfig prices, or null at the top level. */
export function boatQuote(rules: ProgressRules, levels: Record<BoatId, number>, boat: BoatId, pearls: number) {
  const level = levels[boat] ?? 1;
  if (level >= 3) return null;
  const cost = num(rules.boatPrices[boat][level]);
  return { level: (level + 1) as 2 | 3, cost, short: Math.max(0, cost - pearls) };
}

/** Maps open at this lifetime value (ProgressConfig thresholds). */
export function mapsOpen(lifetime: number, rules: GameProgressRules): MapId[] {
  return MAP_ORDER.filter((m) => lifetime >= rules.mapThresholds[m]);
}

/** Can SHIPS index `ship` be sailed at this lifetime value? */
export function shipOpen(lifetime: number, rules: GameProgressRules, ship: number): boolean {
  const need = rules.shipThresholds[ship];
  return need !== undefined && lifetime >= need;
}

// ---- Lost confirmations -----------------------------------------------------------

/**
 * What a player_state payment buys, stored with it in the pending journal (JSON-safe). Each
 * carries what the accounts looked like before, so a re-read tells whether it landed.
 */
export type ChainPurchase = (
  | { v: 1; kind: 'upgrade'; slot: UpgradeSlot; level: number }
  | { v: 1; kind: 'synth-upgrade'; slot: UpgradeSlot; level: number; composite: number }
  | { v: 1; kind: 'craft'; recipe: RecipeDef['id']; crafted: number }
  | { v: 1; kind: 'food'; food: FishFoodId; keys: string[]; feeds: number }
  | { v: 1; kind: 'path'; slot: EquipmentSlot; path: string }
  /** v2: buy_boat to `level` (Progress.boat_levels), set_ship to `ship` (Progress.ship). */
  | { v: 1; kind: 'boat'; boat: BoatId; level: number }
  | { v: 1; kind: 'ship'; ship: number }
  /** init_player / set_session / an owed shark_bite sent on their own before a purchase. */
  | { v: 1; kind: 'setup' }
) & {
  /** An owed shark_bite rode in front of it: the levels before it are not evidence either way. */
  bite?: boolean;
};

export function isChainPurchase(what: unknown): what is ChainPurchase {
  return !!what && typeof what === 'object' && (what as { v?: unknown }).v === 1 && typeof (what as { kind?: unknown }).kind === 'string';
}

/**
 * Does the re-read state already show this purchase? True only on evidence that the transaction
 * landed (a level reached, a composite plate consumed, a craft or a feed counted); false means
 * "not visible", and the signature status decides.
 */
export function purchaseVisible(
  what: ChainPurchase,
  player: PlayerStateAccount | null,
  aquarium: AquariumAccount | null,
  progress: ProgressAccount | null = null,
): boolean {
  switch (what.kind) {
    case 'upgrade':
      return !!player && player.levels[what.slot] >= what.level;
    case 'synth-upgrade':
      // Only synth_upgrade consumes a composite plate.
      return !!player && player.crafted.composite < what.composite;
    case 'craft':
      return !!player && player.crafted[what.recipe] > what.crafted;
    case 'food': {
      if (!aquarium) return false;
      const keys = new Set(what.keys);
      const feeds = aquarium.entries.filter((e) => keys.has(e.keyHex)).reduce((n, e) => n + e.feedCount, 0);
      return feeds > what.feeds;
    }
    case 'path':
      return !!player && (player.paths as unknown as Record<string, string>)[what.slot] === what.path;
    case 'boat':
      // Only buy_boat raises a boat level, and nothing lowers one.
      return !!progress && (progress.boatLevels[what.boat] ?? 1) >= what.level;
    case 'ship':
      return !!progress && progress.ship === what.ship;
    default:
      return false;
  }
}

export interface RecordStatus {
  error: unknown;
  commitment?: string | null;
}
export type Settlement = 'delivered' | 'dropped' | 'kept';

/**
 * How one journaled payment settles. Its signature decides first: confirmed -> delivered (or
 * dropped when it failed on chain). A transaction not found may still land until its blockhash
 * expires, so until then it is kept (and purchases stay locked) whatever the accounts show:
 * buy_upgrade, craft and feed add one, and another device can reach the same state meanwhile.
 * Only once it can no longer land does the re-read state break the tie (it shows the purchase ->
 * delivered, the status lookup missed it; else dropped). A record carrying a shark bite, a
 * player setup and one from before player_state are never "visible".
 */
export function settleRecord(
  rec: { what: unknown; ts: number; lastValid?: number },
  status: RecordStatus | null,
  height: number | undefined,
  now: number,
  player: PlayerStateAccount | null,
  aquarium: AquariumAccount | null,
  maxAgeMs: number,
  progress: ProgressAccount | null = null,
): Settlement {
  if (status) {
    if (status.commitment === 'processed') return 'kept'; // seen, not final yet
    return status.error ? 'dropped' : 'delivered';
  }
  // Past its blockhash expiry, or (block height unreadable, or no expiry stored) older than
  // maxAgeMs: a blockhash lives about a minute, so it can no longer land either way.
  const expired = (rec.lastValid !== undefined && height !== undefined && height > rec.lastValid) || now - rec.ts > maxAgeMs;
  if (!expired) return 'kept';
  return isChainPurchase(rec.what) && !rec.what.bite && purchaseVisible(rec.what, player, aquarium, progress) ? 'delivered' : 'dropped';
}

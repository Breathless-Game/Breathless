// The player's upgrades as two Metaplex Core NFTs, owned by the player's wallet and kept in step by
// the game (session) wallet, which holds their update authority (gear-sync.ts runs it):
//
//   Boat      the ship sailed (the shipyard's 0-5) and the boat-group upgrades
//   Dive Kit  the dive gear levels and the branch each piece runs from Lv2
//
// Levels live on chain twice, always as absolute values (never deltas):
//   - the Core Attributes plugin (authority: the update authority, so the owner never signs);
//   - the asset URI, a path on our server that encodes every level, so explorers that read the
//     JSON show the current levels and a card (sensor/nft-gear.mjs serves it).
//
//   /api/nft/gear/v1/boat/<ship>/<bait>-<boat>-<boatSpeed>-<boatHull>-<boatDeck>.json  (.svg: the card)
//   /api/nft/gear/v1/kit/<rod>-<reel>-<net>-<fins>-<tank>-<lamp>-<sonar>/<rod>-<net>-<fins>-<tank>-<lamp>-<reel branch>.json
//
// The meta path is also the sync key: the asset is in step when the path it was last given equals
// the path of the levels now. No runtime imports, so tests load this file straight from TypeScript
// (game/tests/gear-nft.test.mjs checks the grammar against sensor/nft-gear.mjs).

export type GearKind = 'boat' | 'kit';
export type GearLevel = 1 | 2 | 3;

export const GEAR_KINDS: readonly GearKind[] = ['boat', 'kit'];

/** Boat-group upgrade ids (upgrades.ts group 'boat'), in path order. */
export const BOAT_IDS = ['bait', 'boat', 'boatSpeed', 'boatHull', 'boatDeck'] as const;
/** Dive-group upgrade ids (upgrades.ts group 'dive'), in path order. */
export const KIT_IDS = ['rod', 'reel', 'net', 'fins', 'tank', 'lamp', 'sonar'] as const;
/** Pieces with two branches from Lv2 (equipment.ts EQUIPMENT_PATHS), in path order. */
export const BRANCH_SLOTS = ['rod', 'net', 'fins', 'tank', 'lamp', 'reel'] as const;
/** The two branches of each piece; the first is the default (equipment.ts DEFAULT_EQUIPMENT_PATHS). */
export const BRANCHES = {
  rod: ['far', 'fast'],
  net: ['wide', 'fine'],
  fins: ['sprint', 'silent'],
  tank: ['long', 'light'],
  lamp: ['focus', 'wideLamp'],
  reel: ['fastReel', 'silentReel'],
} as const;
/** The shipyard's ships by index (ships.ts SHIPS[].en). */
export const SHIP_NAMES = ['Homeward', 'First Tide', 'Twin Cast', 'Echo Scout', 'Ocean Vanguard', 'Abyss Atlas'] as const;

export type BoatId = (typeof BOAT_IDS)[number];
export type KitId = (typeof KIT_IDS)[number];
export type BranchSlot = (typeof BRANCH_SLOTS)[number];

export type BoatLevels = { ship: number } & Record<BoatId, GearLevel>;
export type KitLevels = Record<KitId, GearLevel> & { branches: { [S in BranchSlot]: string } };
export interface GearLevels {
  boat: BoatLevels;
  kit: KitLevels;
}

export const GEAR_PREFIX = '/api/nft/gear/v1/';
/** On-chain names. Never changed by an update: only the URI and the Attributes follow the levels. */
export const GEAR_NAMES: Record<GearKind, string> = { boat: 'Breathless Boat', kit: 'Breathless Dive Kit' };
/** Bump when the attribute layout changes. */
export const GEAR_SCHEMA = '1';

export const gearLevel = (x: unknown): GearLevel => {
  const n = Math.floor(Number(x));
  return (Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : 1) as GearLevel;
};
const shipIndex = (x: unknown) => {
  const n = Math.floor(Number(x));
  return Number.isFinite(n) ? Math.min(SHIP_NAMES.length - 1, Math.max(0, n)) : 0;
};
/** A branch is only in force from Lv2; below that (or unknown) it is the default, so Lv1 never differs on chain. */
const branch = (slot: BranchSlot, level: GearLevel, x: unknown): string => {
  const choices: readonly string[] = BRANCHES[slot];
  return level >= 2 && typeof x === 'string' && choices.includes(x) ? x : choices[0];
};

export function normalizeBoat(b: Partial<Record<string, unknown>>): BoatLevels {
  const out = { ship: shipIndex(b.ship) } as BoatLevels;
  for (const id of BOAT_IDS) out[id] = gearLevel(b[id]);
  return out;
}

export function normalizeKit(k: Partial<Record<string, unknown>> & { branches?: Partial<Record<string, unknown>> }): KitLevels {
  const out = {} as KitLevels;
  for (const id of KIT_IDS) out[id] = gearLevel(k[id]);
  const raw = k.branches ?? {};
  out.branches = {} as KitLevels['branches'];
  for (const slot of BRANCH_SLOTS) out.branches[slot] = branch(slot, out[slot], raw[slot]);
  return out;
}

// ---- Paths and attributes -----------------------------------------------------------

function boatStem(b: BoatLevels): string {
  const n = normalizeBoat(b);
  return `boat/${n.ship}/${BOAT_IDS.map((id) => n[id]).join('-')}`;
}

function kitStem(k: KitLevels): string {
  const n = normalizeKit(k);
  return `kit/${KIT_IDS.map((id) => n[id]).join('-')}/${BRANCH_SLOTS.map((s) => n.branches[s]).join('-')}`;
}

const stem = (kind: GearKind, levels: GearLevels) => (kind === 'boat' ? boatStem(levels.boat) : kitStem(levels.kit));

/** The metadata path for one NFT at these levels (also its sync key). */
export const gearMetaPath = (kind: GearKind, levels: GearLevels) => `${GEAR_PREFIX}${stem(kind, levels)}.json`;
/** The card image for one NFT at these levels. */
export const gearImagePath = (kind: GearKind, levels: GearLevels) => `${GEAR_PREFIX}${stem(kind, levels)}.svg`;

/** The metadata path inside a full URI (any origin), or null if it is not one of ours. */
export function gearPathOfUri(uri: string): string | null {
  const i = uri.indexOf(GEAR_PREFIX);
  return i >= 0 && uri.endsWith('.json') ? uri.slice(i) : null;
}

export interface GearAttribute {
  key: string;
  value: string;
}

/** The Core Attributes plugin list: every level as an absolute value. */
export function gearAttributes(kind: GearKind, levels: GearLevels): GearAttribute[] {
  const head = [
    { key: 'kind', value: kind },
    { key: 'schema', value: GEAR_SCHEMA },
  ];
  if (kind === 'boat') {
    const b = normalizeBoat(levels.boat);
    return [
      ...head,
      { key: 'ship', value: String(b.ship) },
      { key: 'shipName', value: SHIP_NAMES[b.ship] },
      ...BOAT_IDS.map((id) => ({ key: id, value: String(b[id]) })),
    ];
  }
  const k = normalizeKit(levels.kit);
  return [
    ...head,
    ...KIT_IDS.map((id) => ({ key: id, value: String(k[id]) })),
    ...BRANCH_SLOTS.map((s) => ({ key: `${s}Branch`, value: k.branches[s] })),
  ];
}

/** Read levels back from an Attributes list (e.g. fetched from chain); null if it is not this kind. */
export function levelsFromAttributes(kind: 'boat', list: readonly GearAttribute[]): BoatLevels | null;
export function levelsFromAttributes(kind: 'kit', list: readonly GearAttribute[]): KitLevels | null;
export function levelsFromAttributes(kind: GearKind, list: readonly GearAttribute[]): BoatLevels | KitLevels | null {
  const map = new Map(list.map((a) => [a.key, a.value]));
  if (map.get('kind') !== kind) return null;
  if (kind === 'boat') return normalizeBoat({ ship: map.get('ship'), ...Object.fromEntries(BOAT_IDS.map((id) => [id, map.get(id)])) });
  return normalizeKit({
    ...Object.fromEntries(KIT_IDS.map((id) => [id, map.get(id)])),
    branches: Object.fromEntries(BRANCH_SLOTS.map((s) => [s, map.get(`${s}Branch`)])),
  });
}

// ---- Sync state (per owner, deepbreath.<owner>.gear-nft) ----------------------------

export interface GearAssetRecord {
  /** The Core asset, once minted. */
  asset?: string;
  /** The session key that minted it (its update authority). Another key: mint a fresh one. */
  authority?: string;
  /** The meta path the chain last confirmed for it. */
  synced?: string;
  /** The last transaction (mint or update). */
  tx?: string;
  /**
   * The new asset's 64-byte secret, saved before its mint is sent. A retry reuses it, so a mint
   * that landed while the page closed is found (and adopted) instead of minted twice.
   */
  pendingKey?: number[];
  /** Consecutive failures, and when to try again. */
  fails?: number;
  retryAt?: number;
  /** Assets this record used to sync but no longer can (other device's key, burned). Newest last. */
  orphaned?: string[];
}

export type GearRecord = Record<GearKind, GearAssetRecord>;

/** After this many failures in a row the sync pauses (local levels keep working) until a level changes or the page reloads. */
export const MAX_GEAR_FAILS = 5;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const cleanAsset = (r: unknown): GearAssetRecord => {
  if (!r || typeof r !== 'object') return {};
  const x = r as Record<string, unknown>;
  const out: GearAssetRecord = {};
  if (typeof x.asset === 'string' && BASE58.test(x.asset)) out.asset = x.asset;
  if (typeof x.authority === 'string' && BASE58.test(x.authority)) out.authority = x.authority;
  if (typeof x.synced === 'string' && x.synced.startsWith(GEAR_PREFIX)) out.synced = x.synced;
  if (typeof x.tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(x.tx)) out.tx = x.tx;
  if (Array.isArray(x.pendingKey) && x.pendingKey.length === 64 && x.pendingKey.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    out.pendingKey = x.pendingKey as number[];
  }
  if (Number.isInteger(x.fails) && (x.fails as number) > 0) out.fails = x.fails as number;
  if (Number.isFinite(x.retryAt)) out.retryAt = x.retryAt as number;
  if (Array.isArray(x.orphaned)) out.orphaned = x.orphaned.filter((a): a is string => typeof a === 'string' && BASE58.test(a)).slice(-8);
  return out;
};

/** The stored record, or an empty one. Anything malformed is dropped, never thrown. */
export function parseGearRecord(raw: string | null): GearRecord {
  try {
    const x = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { boat: cleanAsset(x?.boat), kit: cleanAsset(x?.kit) };
  } catch {
    return { boat: {}, kit: {} };
  }
}

export type GearJob = 'mint' | 'update' | 'wait' | 'paused' | null;

/**
 * What one NFT needs now: 'mint' (none yet, or minted by another session key, which cannot update
 * it), 'update' (its levels moved on), 'wait' (backing off after a failure), 'paused' (failed too
 * often), or null (in step).
 */
export function gearJob(rec: GearAssetRecord, desired: string, session: string, now: number): GearJob {
  const mine = rec.asset !== undefined && (rec.authority === undefined || rec.authority === session);
  if (mine && rec.synced === desired) return null;
  if ((rec.fails ?? 0) >= MAX_GEAR_FAILS) return 'paused';
  if (rec.retryAt !== undefined && rec.retryAt > now) return 'wait';
  return mine ? 'update' : 'mint';
}

/** Backoff after `fails` failures in a row: 5 s, 10 s, 20 s, … capped at 10 min. */
export function gearRetryDelay(fails: number): number {
  return Math.min(10 * 60_000, 5000 * 2 ** Math.max(0, fails - 1));
}

/**
 * Coalescing: when the debounced sync fires after level changes that started at `firstAt` and last
 * happened at `lastAt`. It waits for `quietMs` without changes, but never longer than `maxWaitMs`
 * after the first, so a steady stream of upgrades still lands.
 */
export function gearDebounceDue(firstAt: number, lastAt: number, quietMs: number, maxWaitMs: number): number {
  return Math.min(lastAt + quietMs, firstAt + maxWaitMs);
}

export type GearFunds = 'unknown' | 'ok' | 'needs-sol' | 'offline';
export type GearState = 'off' | 'syncing' | 'synced' | 'needs-sol' | 'offline' | 'retrying' | 'paused';

export interface GearStatusInput {
  rec: GearAssetRecord;
  /** The meta path of the levels now, or null with no wallet/levels yet. */
  desired: string | null;
  session: string | null;
  funds: GearFunds;
  /** This NFT has a transaction in flight. */
  active: boolean;
  /** Level changes are waiting out the debounce (shown as syncing only if a level really moved). */
  pending: boolean;
  now: number;
}

/** One NFT's status for the UI. */
export function gearState(s: GearStatusInput): GearState {
  if (!s.desired || !s.session) return 'off';
  if (s.active) return 'syncing';
  const job = gearJob(s.rec, s.desired, s.session, s.now);
  // In step: a pending debounce with no level actually moved (a balance refresh) changes nothing.
  if (job === null) return 'synced';
  if (job === 'paused') return 'paused';
  if (s.funds === 'needs-sol') return 'needs-sol';
  if (s.funds === 'offline') return 'offline';
  if (job === 'wait') return 'retrying';
  return 'syncing';
}

export const GEAR_STATE_LABELS: Record<GearState, string> = {
  off: 'Not synced',
  syncing: 'Syncing to chain…',
  synced: 'On-chain ✓',
  'needs-sol': 'Waiting for SOL',
  offline: 'Offline · will retry',
  retrying: 'Retrying soon…',
  paused: 'Sync paused · local levels in use',
};

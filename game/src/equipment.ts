/**
 * Persistent equipment progression for the fishing net (the game's fishing
 * rod concept).  The module deliberately keeps progression state separate
 * from the Three.js mesh in `gear.ts`, so a visual rebuild cannot reset a
 * player's upgrades.  Saves live under the connected wallet's storage keys.
 */

import { storageKey } from './wallet';
import { lampProfile } from './lamp-lighting';

export type RodLevel = 1 | 2 | 3;
export type EquipmentLevel = RodLevel;

/** Persistent slots that can be packed on the dive workbench. */
export type EquipmentSlot = 'net' | 'rod' | 'reel' | 'fins' | 'tank' | 'lamp';

/**
 * Everything the gear panel can level up with Pearls: the six loadout slots
 * plus the deployable deep sonar. The sonar has no specialisation paths and is
 * not a quick-wheel tool, so it stays out of `EquipmentSlot`.
 */
export type UpgradeSlot = EquipmentSlot | 'sonar';

/**
 * Specialisation paths are deliberately separate from level progression. A
 * player first buys a slot's Lv2 module, then chooses one of two mutually
 * exclusive handling styles. This keeps old saves (which only contain level
 * numbers) valid while giving the workbench a Tomb Raider-style choice with a
 * readable downside.
 */
export type EquipmentPathId =
  | 'far' | 'fast' // rod shaft: reach or quick handling
  | 'wide' | 'fine' // net: capacity or precision
  | 'sprint' | 'silent' // fins: speed or low disturbance
  | 'focus' | 'wideLamp' // lamp: long focus or broad beam
  | 'long' | 'light' // tank: reserve duration or lower drag
  | 'fastReel' | 'silentReel'; // reel: recovery or quiet operation

export interface EquipmentPaths {
  rod: 'far' | 'fast';
  net: 'wide' | 'fine';
  fins: 'sprint' | 'silent';
  lamp: 'focus' | 'wideLamp';
  tank: 'long' | 'light';
  reel: 'fastReel' | 'silentReel';
}

export interface RodTier {
  /** The user-facing upgrade level. */
  readonly level: RodLevel;
  /** Short label used by the gear panel. */
  readonly name: string;
  /** Maximum number of fish the net can hold before banking. */
  readonly capacity: number;
  /** Horizontal distance from the hoop used by catch detection. */
  readonly catchRadius: number;
  /** Pearl cost to unlock this tier from the previous tier. */
  readonly cost: number;
  /** Alias retained for callers that describe the cost as an unlock threshold. */
  readonly threshold: number;
}

/**
 * Rod/net progression.  `threshold` is the Pearl cost of the upgrade into
 * that tier; level one is the starting tier and therefore costs nothing.
 */
export const ROD_TIERS: readonly RodTier[] = Object.freeze([
  Object.freeze({
    level: 1 as const,
    name: 'Basic Net',
    capacity: 6,
    catchRadius: 2.4,
    cost: 0,
    threshold: 0,
  }),
  Object.freeze({
    level: 2 as const,
    name: 'Reinforced Net',
    capacity: 8,
    catchRadius: 2.8,
    cost: 300,
    threshold: 300,
  }),
  Object.freeze({
    level: 3 as const,
    name: 'Abyssal Net',
    capacity: 10,
    catchRadius: 3.2,
    cost: 1200,
    threshold: 1200,
  }),
]);

export interface EquipmentState {
  /**
   * Legacy name retained for saves and callers from the first prototype. It
   * is always kept in sync with `netLevel` by the normalizer.
   */
  rodLevel: RodLevel;
  /** Catching net tier. */
  netLevel: EquipmentLevel;
  /** Shaft/handle tier: extends tool reach but does not alter breathing. */
  rodGearLevel: EquipmentLevel;
  /** Reel tier: controls the recovery between net swings. */
  reelLevel: EquipmentLevel;
  /** Diver accessory tiers. */
  finsLevel: EquipmentLevel;
  tankLevel: EquipmentLevel;
  lampLevel: EquipmentLevel;
  /** Deep sonar tier: the deployed cable's reach (10 / 17 / 26 m). */
  sonarLevel: EquipmentLevel;
  /** On-chain PEARL, as last read with pearlBalance(): a cache for instant UI. */
  pearls: number;
  /**
   * Pearls earned locally before PEARL went on-chain. Kept in the save untouched, but no longer
   * spendable or shown: every purchase burns on-chain PEARL only (see spendablePearls()).
   */
  legacyPearls: number;
  /**
   * One selected module path per slot. Older localStorage records omit this
   * field and are normalised to the balanced starting paths below.
   */
  paths: EquipmentPaths;
}

export interface EquipmentStats {
  netCapacity: number;
  catchRadius: number;
  rodRange: number;
  /** Multiplier applied to the net swing recovery speed. */
  reelRecovery: number;
  swimSpeed: number;
  swimAcceleration: number;
  emergencySeconds: number;
  lampDistance: number;
  lampIntensity: number;
  lampAngle: number;
  /** Strength of nearby reflected illumination. */
  lampScatter: number;
  /** Physical falloff and water absorption controls used by the diver light. */
  lampDecay: number;
  lampPenumbra: number;
  lampExtinction: number;
}

export interface SlotTier {
  readonly slot: UpgradeSlot;
  readonly level: EquipmentLevel;
  readonly name: string;
  readonly effect: string;
  readonly cost: number;
}

export interface PathTier {
  readonly level: EquipmentLevel;
  readonly effect: string;
}

/** A branch shown by the gear panel. `modifiers` are applied at each level. */
export interface EquipmentPathDef {
  readonly slot: EquipmentSlot;
  readonly id: EquipmentPathId;
  readonly name: string;
  readonly nameZh: string;
  readonly summary: string;
  readonly tiers: readonly [PathTier, PathTier, PathTier];
  readonly modifiers: readonly [PathModifier, PathModifier, PathModifier];
}

/** Additive deltas to derived stats; zero at Lv1 keeps legacy behaviour. */
export interface PathModifier {
  readonly netCapacity?: number;
  readonly catchRadius?: number;
  readonly rodRange?: number;
  readonly reelRecovery?: number;
  readonly swimSpeed?: number;
  readonly swimAcceleration?: number;
  readonly emergencySeconds?: number;
  readonly lampDistance?: number;
  readonly lampIntensity?: number;
  readonly lampAngle?: number;
}

export const EQUIPMENT_STORAGE_KEY = 'deepbreath.equipment';

const LEGACY_ROD_KEY = 'deepbreath.rod';
const LEGACY_PEARLS_KEYS = ['deepbreath.pearls', 'deepbreath.pearl'] as const;
export const DEFAULT_EQUIPMENT_PATHS: EquipmentPaths = Object.freeze({
  rod: 'far',
  net: 'wide',
  fins: 'sprint',
  tank: 'long',
  lamp: 'focus',
  reel: 'fastReel',
});
const DEFAULT_STATE: EquipmentState = {
  rodLevel: 1,
  netLevel: 1,
  rodGearLevel: 1,
  reelLevel: 1,
  finsLevel: 1,
  tankLevel: 1,
  lampLevel: 1,
  sonarLevel: 1,
  pearls: 0,
  legacyPearls: 0,
  paths: DEFAULT_EQUIPMENT_PATHS,
};

const SLOT_LEVELS: Record<UpgradeSlot, readonly SlotTier[]> = {
  net: ROD_TIERS.map((tier) => ({
    slot: 'net', level: tier.level, name: tier.name, effect: `${tier.capacity} fish · ${tier.catchRadius.toFixed(1)} m catch radius`, cost: tier.cost,
  })),
  rod: [
    { slot: 'rod', level: 1, name: 'Short shaft', effect: 'Base tool reach', cost: 0 },
    { slot: 'rod', level: 2, name: 'Telescopic shaft', effect: '+0.2 m tool reach', cost: 100 },
    { slot: 'rod', level: 3, name: 'Abyssal shaft', effect: '+0.4 m tool reach', cost: 500 },
  ],
  reel: [
    { slot: 'reel', level: 1, name: 'Hand reel', effect: 'Base swing recovery', cost: 0 },
    { slot: 'reel', level: 2, name: 'Ball-bearing reel', effect: '20% faster recovery', cost: 120 },
    { slot: 'reel', level: 3, name: 'Magnetic reel', effect: '40% faster recovery', cost: 600 },
  ],
  fins: [
    { slot: 'fins', level: 1, name: 'Standard fins', effect: '7.5 m/s swim speed', cost: 0 },
    { slot: 'fins', level: 2, name: 'Flow fins', effect: '8.5 m/s swim speed', cost: 150 },
    { slot: 'fins', level: 3, name: 'Current fins', effect: '9.5 m/s swim speed', cost: 750 },
  ],
  tank: [
    { slot: 'tank', level: 1, name: 'No reserve', effect: '3.2 s emergency return', cost: 0 },
    { slot: 'tank', level: 2, name: 'Emergency bottle', effect: '4.2 s emergency return', cost: 180 },
    { slot: 'tank', level: 3, name: 'Twin reserve bottle', effect: '5.2 s emergency return', cost: 900 },
  ],
  lamp: [
    { slot: 'lamp', level: 1, name: 'Mask lamp', effect: '18 m beam', cost: 0 },
    { slot: 'lamp', level: 2, name: 'Dive lamp', effect: '33 m focus / 24 m wide', cost: 100 },
    { slot: 'lamp', level: 3, name: 'Abyss lamp', effect: '48 m focus / 32 m wide', cost: 500 },
  ],
  // Keep in step with DEEP_SONAR_LENGTH_TIERS in deep-sonar.ts (checked by tests/deep-sonar.test.mjs).
  sonar: [
    { slot: 'sonar', level: 1, name: 'Deep sonar', effect: '10 m cable · 3 pulse nodes', cost: 0 },
    { slot: 'sonar', level: 2, name: 'Long-line sonar', effect: '17 m cable · 4 pulse nodes', cost: 300 },
    { slot: 'sonar', level: 3, name: 'Abyssal sonar', effect: '26 m cable · 5 pulse nodes', cost: 1200 },
  ],
};

/** Tier metadata for the multi-slot workshop UI. */
export const EQUIPMENT_TIERS: Readonly<Record<UpgradeSlot, readonly SlotTier[]>> = SLOT_LEVELS;

/**
 * Replace the PEARL price of Lv2 and Lv3 per slot with the on-chain Config's (player-chain.ts),
 * so the gear panel, the workbench and every affordability check show what buy_upgrade burns.
 * `costs[slot]` is [Lv1, Lv2, Lv3]; Lv1 stays 0.
 */
export function setUpgradeCosts(costs: Partial<Record<UpgradeSlot, readonly number[]>>): void {
  for (const [slot, list] of Object.entries(costs) as [UpgradeSlot, readonly number[]][]) {
    const tiers = SLOT_LEVELS[slot] as SlotTier[] | undefined;
    if (!tiers) continue;
    for (let i = 1; i < tiers.length; i++) {
      const cost = list[i];
      if (Number.isSafeInteger(cost) && cost > 0) tiers[i] = { ...tiers[i], cost };
    }
  }
}
function pathDef(
  slot: EquipmentSlot,
  id: EquipmentPathId,
  name: string,
  nameZh: string,
  summary: string,
  effects: readonly [string, string, string],
  modifiers: readonly [PathModifier, PathModifier, PathModifier],
): EquipmentPathDef {
  return Object.freeze({
    slot,
    id,
    name,
    nameZh,
    summary,
    tiers: Object.freeze([
      Object.freeze({ level: 1 as const, effect: effects[0] }),
      Object.freeze({ level: 2 as const, effect: effects[1] }),
      Object.freeze({ level: 3 as const, effect: effects[2] }),
    ]) as readonly [PathTier, PathTier, PathTier],
    modifiers: Object.freeze(modifiers) as readonly [PathModifier, PathModifier, PathModifier],
  });
}

/**
 * Mutually exclusive module paths. Every path is levelled by its existing
 * equipment slot, so no second currency or save migration is needed. The
 * deltas are intentionally modest: a branch should change how a dive feels,
 * not invalidate the base equipment balance.
 */
export const EQUIPMENT_PATHS: Readonly<Record<EquipmentSlot, readonly EquipmentPathDef[]>> = Object.freeze({
  rod: [
    pathDef('rod', 'far', 'Long reach', '远射杆身', 'Reach farther, recover a little slower.',
      ['Base reach', '+0.18 m reach · −4% recovery', '+0.36 m reach · −8% recovery'],
      [{}, { rodRange: 0.18, reelRecovery: -0.04 }, { rodRange: 0.36, reelRecovery: -0.08 }]),
    pathDef('rod', 'fast', 'Quick handling', '快抽杆身', 'Shorter reach, faster follow-up swings.',
      ['Base handling', '−0.12 m reach · +12% recovery', '−0.24 m reach · +24% recovery'],
      [{}, { rodRange: -0.12, reelRecovery: 0.12 }, { rodRange: -0.24, reelRecovery: 0.24 }]),
  ],
  net: [
    pathDef('net', 'wide', 'Wide mouth', '宽口网圈', 'Carry more, with extra drag on the swing.',
      ['Base mesh', '+1 capacity · +0.12 m radius · −5% recovery', '+2 capacity · +0.24 m radius · −10% recovery'],
      [{}, { netCapacity: 1, catchRadius: 0.12, reelRecovery: -0.05 }, { netCapacity: 2, catchRadius: 0.24, reelRecovery: -0.1 }]),
    pathDef('net', 'fine', 'Fine mesh', '细目网袋', 'A wider capture window with a smaller carrying capacity.',
      ['Base mesh', '+0.28 m radius · +3% recovery', '+0.56 m radius · +6% recovery'],
      [{}, { catchRadius: 0.28, reelRecovery: 0.03 }, { netCapacity: 1, catchRadius: 0.56, reelRecovery: 0.06 }]),
  ],
  fins: [
    pathDef('fins', 'sprint', 'Sprint fins', '竞速脚蹼', 'Higher top speed and acceleration.',
      ['Base thrust', '+0.7 m/s speed · +2 acceleration', '+1.4 m/s speed · +4 acceleration'],
      [{}, { swimSpeed: 0.7, swimAcceleration: 2 }, { swimSpeed: 1.4, swimAcceleration: 4 }]),
    pathDef('fins', 'silent', 'Steady fins', '稳控脚蹼', 'A smaller speed bonus for a steadier swim cadence.',
      ['Base thrust', '+0.2 m/s speed · +0.5 acceleration', '+0.4 m/s speed · +1 acceleration'],
      [{}, { swimSpeed: 0.2, swimAcceleration: 0.5 }, { swimSpeed: 0.4, swimAcceleration: 1 }]),
  ],
  tank: [
    pathDef('tank', 'long', 'Long reserve', '长效气瓶', 'More emergency return time after a confirmed underwater breath.',
      ['Base reserve', '+0.8 s emergency window', '+1.6 s emergency window'],
      [{}, { emergencySeconds: 0.8 }, { emergencySeconds: 1.6 }]),
    pathDef('tank', 'light', 'Light rig', '轻量气瓶', 'A light reserve setup trades return time for a little more swim speed.',
      ['Base reserve', '+0.35 s reserve · +0.15 m/s speed', '+0.7 s reserve · +0.3 m/s speed'],
      [{}, { emergencySeconds: 0.35, swimSpeed: 0.15 }, { emergencySeconds: 0.7, swimSpeed: 0.3 }]),
  ],
  lamp: [
    pathDef('lamp', 'focus', 'Long focus', '长焦反射杯', 'A narrow, brighter beam for deep targets.',
      ['18 m range · intensity 48', '33 m range · intensity 74', '48 m range · intensity 102'],
      [{}, {}, {}]),
    pathDef('lamp', 'wideLamp', 'Wide diffuser', '广角扩散罩', 'See more of the local area at the cost of throw distance.',
      ['18 m range · intensity 48', '24 m range · intensity 60', '32 m range · intensity 74'],
      [{}, {}, {}]),
  ],
  reel: [
    pathDef('reel', 'fastReel', 'Fast reel', '快收线轮', 'Shorter recovery between swings.',
      ['Base recovery', '+12% recovery', '+24% recovery'],
      [{}, { reelRecovery: 0.12 }, { reelRecovery: 0.24 }]),
    pathDef('reel', 'silentReel', 'Measured reel', '稳控线轮', 'A measured swing cadence with a smaller recovery gain.',
      ['Base recovery', '+5% recovery', '+10% recovery'],
      [{}, { reelRecovery: 0.05 }, { reelRecovery: 0.1 }]),
  ],
});

type EquipmentInput = EquipmentState | RodLevel | number | null | undefined;

function cloneDefault(): EquipmentState {
  return { ...DEFAULT_STATE };
}

function validLevel(value: unknown): RodLevel {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_STATE.rodLevel;
  return Math.min(3, Math.max(1, Math.floor(n))) as RodLevel;
}

function validPearls(value: unknown): number {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_STATE.pearls;
  return Math.max(0, Math.floor(n));
}

function validPath(slot: EquipmentSlot, value: unknown): EquipmentPathId {
  if (typeof value === 'string' && EQUIPMENT_PATHS[slot].some((path) => path.id === value)) {
    return value as EquipmentPathId;
  }
  return DEFAULT_EQUIPMENT_PATHS[slot];
}

function normalizePaths(record: Record<string, unknown>): EquipmentPaths {
  const raw = record.paths && typeof record.paths === 'object' ? record.paths as Record<string, unknown> : {};
  return {
    rod: validPath('rod', raw.rod ?? record.rodPath) as EquipmentPaths['rod'],
    net: validPath('net', raw.net ?? record.netPath) as EquipmentPaths['net'],
    fins: validPath('fins', raw.fins ?? record.finsPath) as EquipmentPaths['fins'],
    tank: validPath('tank', raw.tank ?? record.tankPath) as EquipmentPaths['tank'],
    lamp: validPath('lamp', raw.lamp ?? record.lampPath) as EquipmentPaths['lamp'],
    reel: validPath('reel', raw.reel ?? record.reelPath) as EquipmentPaths['reel'],
  };
}

/** Normalize untrusted data from localStorage or an older save format. */
function normalize(value: unknown): EquipmentState {
  if (!value || typeof value !== 'object') return cloneDefault();
  const record = value as Record<string, unknown>;
  // `level` was used by an early prototype; retain it during migration.
  const net = validLevel(record.netLevel ?? record.rodLevel ?? record.level);
  // Saves from before on-chain PEARL have no legacyPearls: every Pearl in them was earned locally.
  const preChain = !('legacyPearls' in record);
  return {
    rodLevel: net,
    netLevel: net,
    rodGearLevel: validLevel(record.rodGearLevel ?? record.shaftLevel),
    reelLevel: validLevel(record.reelLevel),
    finsLevel: validLevel(record.finsLevel),
    tankLevel: validLevel(record.tankLevel),
    lampLevel: validLevel(record.lampLevel),
    sonarLevel: validLevel(record.sonarLevel),
    pearls: preChain ? 0 : validPearls(record.pearls),
    legacyPearls: validPearls(preChain ? record.pearls : record.legacyPearls),
    paths: normalizePaths(record),
  };
}

function readNumber(storage: Storage, key: string): number | undefined {
  try {
    const value = storage.getItem(storageKey(key));
    if (value == null) return undefined;
    const parsed = JSON.parse(value) as unknown;
    const n = Number(parsed);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load equipment progression, migrating the small prototype formats that
 * predate this module.  Malformed values are clamped to a safe default and
 * never make the game fail to boot.
 */
export function loadEquipment(): EquipmentState {
  if (typeof localStorage === 'undefined') return cloneDefault();

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey(EQUIPMENT_STORAGE_KEY));
  } catch {
    return cloneDefault();
  }

  if (raw != null) {
    try {
      const state = normalize(JSON.parse(raw) as unknown);
      // Rewrite old/invalid-but-readable values in the canonical shape.  A
      // failed write is harmless; the normalized in-memory state is usable.
      saveEquipment(state);
      return state;
    } catch {
      return cloneDefault();
    }
  }

  // No canonical save yet: migrate independent keys written by prototypes.
  const legacyLevel = readNumber(localStorage, LEGACY_ROD_KEY);
  let legacyPearls: number | undefined;
  for (const key of LEGACY_PEARLS_KEYS) {
    legacyPearls = readNumber(localStorage, key);
    if (legacyPearls !== undefined) break;
  }
  if (legacyLevel === undefined && legacyPearls === undefined) return cloneDefault();

  const migrated = normalize({ rodLevel: legacyLevel, pearls: legacyPearls });
  saveEquipment(migrated);
  return migrated;
}

/** Save a normalized equipment state.  Storage failures are intentionally ignored. */
export function saveEquipment(state: EquipmentState): void {
  const safe = normalize(state);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(EQUIPMENT_STORAGE_KEY), JSON.stringify(safe));
  } catch {
    // Private browsing/quota errors should not interrupt a dive.
  }
}

function inputLevel(input: EquipmentInput): RodLevel {
  if (input && typeof input === 'object') return validLevel(input.netLevel ?? input.rodLevel);
  return validLevel(input);
}

/** Return the tier for a level or a complete equipment state. */
export function rodTier(input?: EquipmentInput): RodTier {
  const level = input == null ? DEFAULT_STATE.rodLevel : inputLevel(input);
  return ROD_TIERS[level - 1] ?? ROD_TIERS[0];
}

/** Return the next tier, or null when the maximum level is already equipped. */
export function nextRodTier(input?: EquipmentInput): RodTier | null {
  const level = input == null ? DEFAULT_STATE.rodLevel : inputLevel(input);
  return ROD_TIERS[level] ?? null;
}

/**
 * The Pearls the player can spend and is shown: the cached on-chain PEARL balance only.
 * legacyPearls stay in the save but are deliberately ignored here.
 */
export function spendablePearls(state: EquipmentState): number {
  return normalize(state).pearls;
}

/**
 * Plan paying a flat `cost` (fish food, synthesis fees): the PEARL to burn on-chain, which is
 * always exactly `cost`. Null when unaffordable or the cost is not a positive whole number.
 */
export function planPearlSpend(state: EquipmentState, cost: number): number | null {
  if (!Number.isSafeInteger(cost) || cost <= 0) return null;
  return spendablePearls(state) >= cost ? cost : null;
}

/** Take a burned amount off the cached on-chain balance, once the burn has landed. */
export function applyPearlSpend(state: EquipmentState, burned: number): EquipmentState {
  const current = normalize(state);
  return { ...current, pearls: Math.max(0, current.pearls - burned) };
}

export interface UpgradePlan {
  /** Its cost must be burned on-chain with spendPearls() before the tier applies. */
  tier: RodTier;
}

/**
 * Plan buying the next rod/net tier, or null when it is maxed out or
 * unaffordable.  Pure: the caller spends the on-chain part, then applies it.
 */
export function planUpgrade(state: EquipmentState): UpgradePlan | null {
  const current = normalize(state);
  const tier = nextRodTier(current.rodLevel);
  if (!tier || spendablePearls(current) < tier.cost) return null;
  return { tier };
}

function slotLevel(state: EquipmentState, slot: UpgradeSlot): EquipmentLevel {
  const value = state[slot === 'rod' ? 'rodGearLevel' : `${slot}Level` as keyof EquipmentState];
  return validLevel(value);
}

/** The level owned of a slot (1 = the starting gear), for the workbench and its inspector. */
export function ownedLevel(state: EquipmentState, slot: UpgradeSlot): EquipmentLevel {
  return slotLevel(normalize(state), slot);
}

function withSlotLevel(state: EquipmentState, slot: UpgradeSlot, level: EquipmentLevel): EquipmentState {
  const next = { ...state };
  if (slot === 'net') {
    next.netLevel = level;
    next.rodLevel = level;
  } else if (slot === 'rod') next.rodGearLevel = level;
  else if (slot === 'reel') next.reelLevel = level;
  else if (slot === 'fins') next.finsLevel = level;
  else if (slot === 'tank') next.tankLevel = level;
  else if (slot === 'sonar') next.sonarLevel = level;
  else next.lampLevel = level;
  return next;
}

/** Return the selected module path for a slot (safe for old save objects). */
export function activePath(state: EquipmentState, slot: EquipmentSlot): EquipmentPathId {
  const safe = normalize(state);
  const selected = safe.paths[slot];
  // A path is only meaningful after the slot reaches Lv2. Returning the
  // default at Lv1 also makes a partially migrated save deterministic.
  if (slotLevel(safe, slot) < 2) return DEFAULT_EQUIPMENT_PATHS[slot];
  return validPath(slot, selected);
}

/** Look up branch metadata for a slot/path pair. */
export function equipmentPath(slot: EquipmentSlot, path: EquipmentPathId = DEFAULT_EQUIPMENT_PATHS[slot]): EquipmentPathDef {
  return EQUIPMENT_PATHS[slot].find((candidate) => candidate.id === path) ?? EQUIPMENT_PATHS[slot][0];
}

/** Current branch tier (the branch shares the slot's existing level). */
export function pathTier(state: EquipmentState, slot: EquipmentSlot): PathTier {
  const safe = normalize(state);
  const path = equipmentPath(slot, activePath(safe, slot));
  return path.tiers[slotLevel(safe, slot) - 1] ?? path.tiers[0];
}

/** Next branch tier, or null when the slot is already at Lv3. */
export function nextPathTier(state: EquipmentState, slot: EquipmentSlot): PathTier | null {
  const safe = normalize(state);
  const path = equipmentPath(slot, activePath(safe, slot));
  const nextIndex = slotLevel(safe, slot);
  return nextIndex >= path.tiers.length ? null : path.tiers[nextIndex as 0 | 1 | 2] ?? null;
}

/**
 * Select a branch after the slot is Lv2+. Branch switching is free; the
 * irreversible choice is the Pearl cost of the underlying level upgrade. A
 * caller that wants a respec fee can subtract it before calling this pure
 * helper.
 */
export function setEquipmentPath(state: EquipmentState, slot: EquipmentSlot, path: EquipmentPathId): EquipmentState | null {
  const safe = normalize(state);
  if (slotLevel(safe, slot) < 2 || !EQUIPMENT_PATHS[slot].some((candidate) => candidate.id === path)) return null;
  return { ...safe, paths: { ...safe.paths, [slot]: path } };
}

/** Return the current tier metadata for any equipment slot. */
export function slotTier(state: EquipmentState, slot: UpgradeSlot): SlotTier {
  const level = slotLevel(normalize(state), slot);
  return SLOT_LEVELS[slot][level - 1] ?? SLOT_LEVELS[slot][0];
}

/** Return the next tier metadata, or null at max level. */
export function nextSlotTier(state: EquipmentState, slot: UpgradeSlot): SlotTier | null {
  const level = slotLevel(normalize(state), slot);
  return SLOT_LEVELS[slot][level] ?? null;
}

export interface SlotUpgradePlan {
  slot: UpgradeSlot;
  /** Its cost must be burned on-chain with spendPearls() before the tier applies. */
  tier: SlotTier;
}

/**
 * Plan buying the next tier for one slot, or null when it is maxed out or
 * unaffordable (on-chain PEARL only).  Same rule as planUpgrade().
 */
export function planSlotUpgrade(state: EquipmentState, slot: UpgradeSlot): SlotUpgradePlan | null {
  const current = normalize(state);
  const tier = nextSlotTier(current, slot);
  if (!tier || spendablePearls(current) < tier.cost) return null;
  return { slot, tier };
}

/**
 * Apply a slot plan once its cost has been burned on-chain, preserving all other upgrade levels.
 * `burned` is what was actually burned (defaults to the tier cost; the synthesis station passes its own fee).
 */
export function applySlotUpgrade(state: EquipmentState, plan: SlotUpgradePlan, burned = plan.tier.cost): EquipmentState {
  return applyPearlSpend(withSlotLevel(normalize(state), plan.slot, plan.tier.level), burned);
}

/** Pure preview of buying the next tier for one slot (no on-chain spend happens here). */
export function upgradeSlot(state: EquipmentState, slot: UpgradeSlot): EquipmentState | null {
  const plan = planSlotUpgrade(state, slot);
  return plan ? applySlotUpgrade(state, plan) : null;
}

function pathModifier(state: EquipmentState, slot: EquipmentSlot, level: EquipmentLevel): PathModifier {
  if (level < 2) return {};
  const path = equipmentPath(slot, activePath(state, slot));
  return path.modifiers[level - 1] ?? {};
}

/**
 * Derive gameplay values from persistent levels. `loadout` is optional: when
 * provided, only packed workbench slots above level one are active for this
 * dive. A missing optional accessory therefore falls back to its base tier.
 */
export function deriveStats(state: EquipmentState, loadout?: readonly string[]): EquipmentStats {
  const safe = normalize(state);
  const packed = loadout == null ? null : new Set(loadout);
  const active = (slot: EquipmentSlot) => packed == null || packed.has(slot);
  const netLevel = active('net') ? safe.netLevel : 1;
  const rodLevel = active('rod') ? safe.rodGearLevel : 1;
  const reelLevel = active('reel') ? safe.reelLevel : 1;
  const finsLevel = active('fins') ? safe.finsLevel : 1;
  const tankLevel = active('tank') ? safe.tankLevel : 1;
  const lampLevel = active('lamp') ? safe.lampLevel : 1;
  const tier = ROD_TIERS[netLevel - 1] ?? ROD_TIERS[0];
  const netPath = pathModifier(safe, 'net', netLevel);
  const rodPath = pathModifier(safe, 'rod', rodLevel);
  const reelPath = pathModifier(safe, 'reel', reelLevel);
  const finsPath = pathModifier(safe, 'fins', finsLevel);
  const tankPath = pathModifier(safe, 'tank', tankLevel);
  const lampPath = activePath(safe, 'lamp');
  const lampOptics = lampProfile(lampLevel, lampPath === 'wideLamp' ? 'wideLamp' : 'focus');
  return {
    netCapacity: Math.max(1, tier.capacity + (netPath.netCapacity ?? 0)),
    catchRadius: Math.max(0.5, tier.catchRadius + (rodLevel - 1) * 0.18 + (netPath.catchRadius ?? 0)),
    rodRange: Math.max(0.5, 1.2 + (rodLevel - 1) * 0.35 + (rodPath.rodRange ?? 0)),
    reelRecovery: Math.max(0.25, 1 + (reelLevel - 1) * 0.2 + (rodPath.reelRecovery ?? 0) + (netPath.reelRecovery ?? 0) + (reelPath.reelRecovery ?? 0)),
    swimSpeed: Math.max(1, [7.5, 8.5, 9.5][finsLevel - 1] + (finsPath.swimSpeed ?? 0) + (tankPath.swimSpeed ?? 0)),
    swimAcceleration: Math.max(1, [24, 27, 30][finsLevel - 1] + (finsPath.swimAcceleration ?? 0)),
    // Tank branches only affect the emergency return timer after the breath
    // detector has confirmed an underwater breath. They never touch the true
    // breath threshold or the player's normal hold time.
    emergencySeconds: Math.max(0.1, [3.2, 4.2, 5.2][tankLevel - 1] + (tankPath.emergencySeconds ?? 0)),
    // The optical profile is the single source for lamp distance, direct
    // intensity and beam shape. It keeps focus and wide diffuser paths
    // physically distinct instead of applying a cosmetic angle-only bonus.
    lampDistance: lampOptics.distance,
    lampIntensity: lampOptics.intensity,
    lampAngle: lampOptics.angle,
    lampScatter: lampOptics.scatter,
    lampDecay: lampOptics.decay,
    lampPenumbra: lampOptics.penumbra,
    lampExtinction: lampOptics.extinction,
  };
}

/**
 * The dive-kit upgrades a shark bite on the Open Ocean takes back (main.ts
 * resetDiveGearAfterBite): every `group: 'dive'` piece in upgrades.ts. The boat
 * pieces (bait, boat, boatSpeed, boatHull, boatDeck) are not in EquipmentState
 * at all (the boat is the shipyard's), so a reset never touches them.
 */
export const DIVE_GEAR_SLOTS: readonly UpgradeSlot[] = Object.freeze(['rod', 'reel', 'net', 'fins', 'tank', 'lamp', 'sonar'] as const);

export interface DiveGearReset {
  /** The new state: every dive slot at level 1, its module path back to the default, Pearls untouched. */
  state: EquipmentState;
  /** The slots that were above level 1, with the level they had. */
  dropped: { slot: UpgradeSlot; from: EquipmentLevel }[];
}

/**
 * Pure: every dive slot back to level 1 and its branch back to the default
 * path, so no path bonus survives and buying Lv2 again starts from the
 * default branch. Pearls spent are not refunded; both balances are kept.
 */
export function resetDiveGear(state: EquipmentState): DiveGearReset {
  const safe = normalize(state);
  const dropped = DIVE_GEAR_SLOTS.filter((slot) => slotLevel(safe, slot) > 1).map((slot) => ({ slot, from: slotLevel(safe, slot) }));
  let next = safe;
  for (const slot of DIVE_GEAR_SLOTS) next = withSlotLevel(next, slot, 1);
  return { state: { ...next, paths: { ...DEFAULT_EQUIPMENT_PATHS } }, dropped };
}


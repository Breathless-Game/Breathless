/**
 * Persistent equipment progression for the fishing net (the game's fishing
 * rod concept).  The module deliberately keeps progression state separate
 * from the Three.js mesh in `gear.ts`, so a visual rebuild cannot reset a
 * player's upgrades.
 */

export type RodLevel = 1 | 2 | 3;
export type EquipmentLevel = RodLevel;

/** Persistent slots that can be packed on the dive workbench. */
export type EquipmentSlot = 'net' | 'rod' | 'reel' | 'fins' | 'tank' | 'lamp';

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
  pearls: number;
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
}

export interface SlotTier {
  readonly slot: EquipmentSlot;
  readonly level: EquipmentLevel;
  readonly name: string;
  readonly effect: string;
  readonly cost: number;
}

export const EQUIPMENT_STORAGE_KEY = 'deepbreath.equipment';

const LEGACY_ROD_KEY = 'deepbreath.rod';
const LEGACY_PEARLS_KEYS = ['deepbreath.pearls', 'deepbreath.pearl'] as const;
const DEFAULT_STATE: EquipmentState = {
  rodLevel: 1,
  netLevel: 1,
  rodGearLevel: 1,
  reelLevel: 1,
  finsLevel: 1,
  tankLevel: 1,
  lampLevel: 1,
  pearls: 0,
};

const SLOT_LEVELS: Record<EquipmentSlot, readonly SlotTier[]> = {
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
    { slot: 'lamp', level: 2, name: 'Long-focus reflector', effect: '28 m beam', cost: 100 },
    { slot: 'lamp', level: 3, name: 'Wide diffuser', effect: '38 m wide beam', cost: 500 },
  ],
};

/** Tier metadata for the multi-slot workshop UI. */
export const EQUIPMENT_TIERS: Readonly<Record<EquipmentSlot, readonly SlotTier[]>> = SLOT_LEVELS;

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

/** Normalize untrusted data from localStorage or an older save format. */
function normalize(value: unknown): EquipmentState {
  if (!value || typeof value !== 'object') return cloneDefault();
  const record = value as Record<string, unknown>;
  // `level` was used by an early prototype; retain it during migration.
  const net = validLevel(record.netLevel ?? record.rodLevel ?? record.level);
  return {
    rodLevel: net,
    netLevel: net,
    rodGearLevel: validLevel(record.rodGearLevel ?? record.shaftLevel),
    reelLevel: validLevel(record.reelLevel),
    finsLevel: validLevel(record.finsLevel),
    tankLevel: validLevel(record.tankLevel),
    lampLevel: validLevel(record.lampLevel),
    pearls: validPearls(record.pearls),
  };
}

function readNumber(storage: Storage, key: string): number | undefined {
  try {
    const value = storage.getItem(key);
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
    raw = localStorage.getItem(EQUIPMENT_STORAGE_KEY);
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
    localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(safe));
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
 * Attempt to buy the next rod/net tier.  This is pure so callers can decide
 * when to persist the result; the returned state has the upgrade cost removed.
 */
export function upgrade(state: EquipmentState): EquipmentState | null {
  return upgradeSlot(state, 'net');
}

function slotLevel(state: EquipmentState, slot: EquipmentSlot): EquipmentLevel {
  const value = state[slot === 'rod' ? 'rodGearLevel' : `${slot}Level` as keyof EquipmentState];
  return validLevel(value);
}

function withSlotLevel(state: EquipmentState, slot: EquipmentSlot, level: EquipmentLevel): EquipmentState {
  const next = { ...state };
  if (slot === 'net') {
    next.netLevel = level;
    next.rodLevel = level;
  } else if (slot === 'rod') next.rodGearLevel = level;
  else if (slot === 'reel') next.reelLevel = level;
  else if (slot === 'fins') next.finsLevel = level;
  else if (slot === 'tank') next.tankLevel = level;
  else next.lampLevel = level;
  return next;
}

/** Return the current tier metadata for any equipment slot. */
export function slotTier(state: EquipmentState, slot: EquipmentSlot): SlotTier {
  const level = slotLevel(normalize(state), slot);
  return SLOT_LEVELS[slot][level - 1] ?? SLOT_LEVELS[slot][0];
}

/** Return the next tier metadata, or null at max level. */
export function nextSlotTier(state: EquipmentState, slot: EquipmentSlot): SlotTier | null {
  const level = slotLevel(normalize(state), slot);
  return SLOT_LEVELS[slot][level] ?? null;
}

/** Buy the next tier for one slot, preserving all other upgrade levels. */
export function upgradeSlot(state: EquipmentState, slot: EquipmentSlot): EquipmentState | null {
  const current = normalize(state);
  const next = nextSlotTier(current, slot);
  if (!next || current.pearls < next.cost) return null;
  return { ...withSlotLevel(current, slot, next.level), pearls: current.pearls - next.cost };
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
  return {
    netCapacity: tier.capacity,
    catchRadius: tier.catchRadius + (rodLevel - 1) * 0.18,
    rodRange: 1.2 + (rodLevel - 1) * 0.35,
    reelRecovery: 1 + (reelLevel - 1) * 0.2,
    swimSpeed: [7.5, 8.5, 9.5][finsLevel - 1],
    swimAcceleration: [24, 27, 30][finsLevel - 1],
    emergencySeconds: [3.2, 4.2, 5.2][tankLevel - 1],
    lampDistance: [18, 28, 38][lampLevel - 1],
    lampIntensity: [48, 64, 82][lampLevel - 1],
    lampAngle: [0.65, 0.85, 1.05][lampLevel - 1],
  };
}


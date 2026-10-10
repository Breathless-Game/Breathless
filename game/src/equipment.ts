/**
 * Persistent equipment progression for the fishing net (the game's fishing
 * rod concept).  The module deliberately keeps progression state separate
 * from the Three.js mesh in `gear.ts`, so a visual rebuild cannot reset a
 * player's upgrades.  Saves live under the connected wallet's storage keys.
 */

import { storageKey } from './wallet';

export type RodLevel = 1 | 2 | 3;

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
  rodLevel: RodLevel;
  pearls: number;
}

export const EQUIPMENT_STORAGE_KEY = 'deepbreath.equipment';

const LEGACY_ROD_KEY = 'deepbreath.rod';
const LEGACY_PEARLS_KEYS = ['deepbreath.pearls', 'deepbreath.pearl'] as const;
const DEFAULT_STATE: EquipmentState = { rodLevel: 1, pearls: 0 };

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
  const level = record.rodLevel ?? record.level;
  return { rodLevel: validLevel(level), pearls: validPearls(record.pearls) };
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
  if (input && typeof input === 'object') return validLevel(input.rodLevel);
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
  const current = normalize(state);
  const next = nextRodTier(current.rodLevel);
  if (!next || current.pearls < next.cost) return null;
  return { rodLevel: next.level, pearls: current.pearls - next.cost };
}


/**
 * Persistent equipment progression for the fishing net (the game's fishing
 * rod concept).  The module deliberately keeps progression state separate
 * from the Three.js mesh in `gear.ts`, so a visual rebuild cannot reset a
 * player's upgrades.  Saves live under the connected wallet's storage keys.
 */

import { storageKey } from './wallet';

export type RodLevel = 1 | 2 | 3;
export type SonarLevel = 1 | 2 | 3;

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

export interface SonarTier {
  readonly level: SonarLevel;
  readonly length: number;
  readonly nodes: number;
  readonly cost: number;
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

/** Cable reach progression for the deployable deep sonar. */
export const SONAR_TIERS: readonly SonarTier[] = Object.freeze([
  Object.freeze({ level: 1 as const, length: 10, nodes: 3, cost: 0 }),
  Object.freeze({ level: 2 as const, length: 17, nodes: 4, cost: 300 }),
  Object.freeze({ level: 3 as const, length: 26, nodes: 5, cost: 1200 }),
]);

export interface EquipmentState {
  rodLevel: RodLevel;
  sonarLevel: SonarLevel;
  /** On-chain PEARL, as last read with pearlBalance(): a cache for instant UI. */
  pearls: number;
  /** Pearls earned locally before PEARL went on-chain. Spent before on-chain PEARL. */
  legacyPearls: number;
}

export const EQUIPMENT_STORAGE_KEY = 'deepbreath.equipment';

const LEGACY_ROD_KEY = 'deepbreath.rod';
const LEGACY_PEARLS_KEYS = ['deepbreath.pearls', 'deepbreath.pearl'] as const;
const DEFAULT_STATE: EquipmentState = { rodLevel: 1, sonarLevel: 1, pearls: 0, legacyPearls: 0 };

type EquipmentInput = EquipmentState | RodLevel | number | null | undefined;

function cloneDefault(): EquipmentState {
  return { ...DEFAULT_STATE };
}

function validLevel(value: unknown): RodLevel {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_STATE.rodLevel;
  return Math.min(3, Math.max(1, Math.floor(n))) as RodLevel;
}

function validSonarLevel(value: unknown): SonarLevel {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_STATE.sonarLevel;
  return Math.min(3, Math.max(1, Math.floor(n))) as SonarLevel;
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
  // Saves from before on-chain PEARL have no legacyPearls: every Pearl in them was earned locally.
  const sonarLevel = validSonarLevel(record.sonarLevel);
  if (!('legacyPearls' in record)) return { rodLevel: validLevel(level), sonarLevel, pearls: 0, legacyPearls: validPearls(record.pearls) };
  return { rodLevel: validLevel(level), sonarLevel, pearls: validPearls(record.pearls), legacyPearls: validPearls(record.legacyPearls) };
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

function sonarInputLevel(input: EquipmentInput): SonarLevel {
  if (input && typeof input === 'object') return validSonarLevel(input.sonarLevel);
  return validSonarLevel(input);
}

export function sonarTier(input?: EquipmentInput): SonarTier {
  const level = input == null ? DEFAULT_STATE.sonarLevel : sonarInputLevel(input);
  return SONAR_TIERS[level - 1] ?? SONAR_TIERS[0];
}

export function nextSonarTier(input?: EquipmentInput): SonarTier | null {
  const level = input == null ? DEFAULT_STATE.sonarLevel : sonarInputLevel(input);
  return SONAR_TIERS[level] ?? null;
}

/** Every Pearl the player can spend: legacy local Pearls plus cached on-chain PEARL. */
export function totalPearls(state: EquipmentState): number {
  return state.legacyPearls + state.pearls;
}

export interface UpgradePlan {
  tier: RodTier;
  /** Taken from the local legacy balance, which is spent first. */
  fromLegacy: number;
  /** Must be burned on-chain with spendPearls() before the tier applies. */
  fromChain: number;
}

/**
 * Plan buying the next rod/net tier, or null when it is maxed out or
 * unaffordable.  Pure: the caller spends the on-chain part, then applies it.
 */
export function planUpgrade(state: EquipmentState): UpgradePlan | null {
  const current = normalize(state);
  const tier = nextRodTier(current.rodLevel);
  if (!tier || totalPearls(current) < tier.cost) return null;
  const fromLegacy = Math.min(current.legacyPearls, tier.cost);
  return { tier, fromLegacy, fromChain: tier.cost - fromLegacy };
}

/** Plan buying the next sonar cable tier using the same Pearl balance rules as the net. */
export function planSonarUpgrade(state: EquipmentState): UpgradePlan | null {
  const current = normalize(state);
  const tier = nextSonarTier(current.sonarLevel);
  if (!tier || totalPearls(current) < tier.cost) return null;
  const fromLegacy = Math.min(current.legacyPearls, tier.cost);
  return { tier: tier as unknown as RodTier, fromLegacy, fromChain: tier.cost - fromLegacy };
}


/**
 * The small, browser-independent part of the aquarium.
 *
 * Rendering lives in aquarium.ts, while this module owns the state that is
 * safe to keep in localStorage: how often a fish has been fed and the colour
 * of the tank's ambient lamp.  Keeping these rules here makes the UI easy to
 * exercise without a DOM or a canvas and, more importantly, means a larger
 * BankedFish is never written back to the NFT bank by accident.
 */

import { fishFood, parseFishFood, type FishFoodId } from './fish-food';

export const AQUARIUM_STORAGE_KEY = 'deepbreath.aquarium';
export const DEFAULT_AQUARIUM_LIGHT = '#42e8d2';

/** A fish can be fed this many times before it reaches its aquarium size cap. */
export const MAX_FEEDS = 5;

/** Feeding the same fish again too quickly has no effect. */
export const FEED_COOLDOWN_MS = 15_000;

/** Fractional visual size increase per accepted feeding. */
export const GROWTH_PER_FEED = 0.08;
/** Growth units retain the old +40% visual cap while better food reaches it sooner. */
export const MAX_GROWTH_UNITS = MAX_FEEDS;
export const FOOD_EFFECT_MS = 90_000;

export interface AquariumGrowth {
  feedCount: number;
  /** Epoch milliseconds of the most recent accepted feeding, or null. */
  lastFedAt: number | null;
  /** Weighted growth units; old saves omit this and use feedCount as the fallback. */
  growthUnits?: number;
  /** Last food used, so cooldown and the visual buff survive a reload. */
  food?: FishFoodId;
}

export interface AquariumLightConfig {
  color: string;
}

/** State persisted for one wallet. Fish records are keyed by BankedFish.id. */
export interface AquariumState {
  growth: Record<string, AquariumGrowth>;
  light: AquariumLightConfig;
}

export type FeedReason = 'fed' | 'cooldown' | 'max' | 'invalid-id';

export interface FeedResult {
  growth: AquariumGrowth;
  fed: boolean;
  reason: FeedReason;
}

export interface AquariumFeedResult {
  state: AquariumState;
  fed: boolean;
  reason: FeedReason;
  growth: AquariumGrowth;
}

/** The minimal storage surface keeps tests independent of browser globals. */
export interface AquariumStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEFAULT_GROWTH: AquariumGrowth = { feedCount: 0, lastFedAt: null };

export const defaultAquariumState = (): AquariumState => ({
  growth: {},
  light: { color: DEFAULT_AQUARIUM_LIGHT },
});

/** Normalize a CSS colour input to the compact form used by the canvas. */
export function normalizeLightColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_AQUARIUM_LIGHT;
  const color = value.trim();
  return /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_AQUARIUM_LIGHT;
}

function finiteTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeGrowth(value: unknown): AquariumGrowth {
  if (!value || typeof value !== 'object') return { ...DEFAULT_GROWTH };
  const record = value as Record<string, unknown>;
  const rawCount = typeof record.feedCount === 'number' || typeof record.feedCount === 'string'
    ? Number(record.feedCount)
    : 0;
  const feedCount = Number.isFinite(rawCount) ? Math.min(MAX_FEEDS, Math.max(0, Math.floor(rawCount))) : 0;
  const lastFedAt = finiteTime(record.lastFedAt);
  const rawUnits = typeof record.growthUnits === 'number' || typeof record.growthUnits === 'string' ? Number(record.growthUnits) : NaN;
  const growthUnits = Number.isFinite(rawUnits) ? Math.min(MAX_GROWTH_UNITS, Math.max(0, rawUnits)) : undefined;
  const food = parseFishFood(record.food)?.id;
  return {
    feedCount, lastFedAt,
    ...(growthUnits === undefined ? {} : { growthUnits }),
    ...(food ? { food } : {}),
  };
}

/** Normalize untrusted localStorage data and tolerate the old `fish`/`lightColor` spellings. */
export function normalizeAquariumState(value: unknown): AquariumState {
  const state = defaultAquariumState();
  if (!value || typeof value !== 'object') return state;
  const record = value as Record<string, unknown>;

  // `growth` is canonical. Accepting these aliases costs nothing and lets a
  // prototype save survive a UI rename without losing its feed progress.
  const growthValue = record.growth ?? record.fish;
  if (growthValue && typeof growthValue === 'object' && !Array.isArray(growthValue)) {
    for (const [id, growth] of Object.entries(growthValue as Record<string, unknown>)) {
      // Fish ids are generated hex seeds. Keep arbitrary localStorage keys
      // from becoming object-prototype mutations.
      if (/^[a-z0-9:_-]+$/i.test(id)) state.growth[id] = normalizeGrowth(growth);
    }
  }

  const light = record.light;
  const lightColor = light && typeof light === 'object'
    ? (light as Record<string, unknown>).color
    : record.lightColor;
  state.light.color = normalizeLightColor(lightColor);
  return state;
}

/** Visual scale to apply to a fish sprite. The banked fish's dimensions stay untouched. */
export function growthScale(feedCount: number): number {
  const count = Number.isFinite(feedCount) ? Math.min(MAX_FEEDS, Math.max(0, Math.floor(feedCount))) : 0;
  return 1 + count * GROWTH_PER_FEED;
}

/** Visual scale from weighted food growth, with legacy saves using feedCount. */
export function growthScaleForGrowth(growth: AquariumGrowth | undefined): number {
  const units = growth?.growthUnits ?? growth?.feedCount ?? 0;
  const safe = Number.isFinite(units) ? Math.min(MAX_GROWTH_UNITS, Math.max(0, units)) : 0;
  return 1 + safe * GROWTH_PER_FEED;
}

/** Food energy and glow last 90 seconds; growth itself is permanent. */
export function activeFoodEffects(growth: AquariumGrowth | undefined, now = Date.now()) {
  const food = growth?.food ? fishFood(growth.food) : null;
  const elapsed = growth?.lastFedAt === null || growth?.lastFedAt === undefined ? Infinity : now - growth.lastFedAt;
  if (!food || elapsed < 0 || elapsed >= FOOD_EFFECT_MS) return { speed: 1, glow: 0 };
  return { speed: food.swimSpeedMultiplier, glow: food.glowIntensity };
}

/**
 * Apply one feeding to a single growth record. The function is immutable and
 * deterministic when `now` is supplied, which keeps the game and tests in
 * agreement about cooldown boundaries.
 */
export function feedFish(growth: AquariumGrowth | undefined, foodIdOrTime: FishFoodId | number = 'plankton', now = Date.now()): FeedResult {
  const current = normalizeGrowth(growth);
  const legacy = typeof foodIdOrTime === 'number';
  const food = fishFood(legacy ? 'pellet' : foodIdOrTime);
  const timestamp = legacy
    ? (Number.isFinite(foodIdOrTime) && foodIdOrTime >= 0 ? foodIdOrTime : Date.now())
    : (Number.isFinite(now) && now >= 0 ? now : Date.now());
  if ((current.growthUnits ?? current.feedCount) >= MAX_GROWTH_UNITS) return { growth: current, fed: false, reason: 'max' };
  const previousFood = current.food ? fishFood(current.food) : fishFood('pellet');
  if (current.lastFedAt !== null && timestamp - current.lastFedAt < FEED_COOLDOWN_MS * previousFood.feedCooldownMultiplier) {
    return { growth: current, fed: false, reason: 'cooldown' };
  }
  if (legacy) {
    const next: AquariumGrowth = { feedCount: current.feedCount + 1, lastFedAt: timestamp };
    return { growth: next, fed: true, reason: 'fed' };
  }
  const units = Math.min(MAX_GROWTH_UNITS, (current.growthUnits ?? current.feedCount) + food.growthMultiplier);
  const next: AquariumGrowth = {
    feedCount: current.feedCount + 1,
    lastFedAt: timestamp,
    growthUnits: units,
    food: food.id,
  };
  return { growth: next, fed: true, reason: 'fed' };
}

/** Feed a fish in a state map, returning a new state suitable for persistence. */
export function feedAquariumFish(state: AquariumState, id: string, foodIdOrTime: FishFoodId | number = 'plankton', now = Date.now()): AquariumFeedResult {
  const normalized = normalizeAquariumState(state);
  if (typeof id !== 'string' || !id.trim()) {
    const growth = { ...DEFAULT_GROWTH };
    return { state: normalized, growth, fed: false, reason: 'invalid-id' };
  }
  const result = feedFish(normalized.growth[id], foodIdOrTime, now);
  if (!result.fed) return { state: normalized, ...result };
  const next: AquariumState = {
    growth: { ...normalized.growth, [id]: result.growth },
    light: { ...normalized.light },
  };
  return { state: next, ...result };
}

function browserStorage(): AquariumStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Load state from a supplied storage object, falling back safely on bad data. */
export function loadAquariumState(
  storage: AquariumStorage | null = browserStorage(),
  key = AQUARIUM_STORAGE_KEY,
): AquariumState {
  if (!storage) return defaultAquariumState();
  try {
    const raw = storage.getItem(key);
    return raw == null ? defaultAquariumState() : normalizeAquariumState(JSON.parse(raw) as unknown);
  } catch {
    return defaultAquariumState();
  }
}

/** Normalize before writing so malformed values never become a future crash. */
export function saveAquariumState(
  state: AquariumState,
  storage: AquariumStorage | null = browserStorage(),
  key = AQUARIUM_STORAGE_KEY,
): AquariumState {
  const normalized = normalizeAquariumState(state);
  if (!storage) return normalized;
  try {
    storage.setItem(key, JSON.stringify(normalized));
  } catch {
    // Preferences are best effort; rendering the tank must keep working when
    // private browsing or a full quota blocks localStorage.
  }
  return normalized;
}

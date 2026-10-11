import { storageKey } from './wallet';
import type { UpgradeSlot } from './equipment';

export type MaterialId = 'scale' | 'fiber' | 'scrap' | 'crystal';

export interface SynthesisState {
  materials: Record<MaterialId, number>;
  crafted: { bait: number; composite: number };
}

export interface RecipeDef {
  readonly id: 'bait' | 'composite';
  readonly name: string;
  readonly nameZh: string;
  readonly needs: Readonly<Partial<Record<MaterialId, number>>>;
  readonly output: keyof SynthesisState['crafted'];
}

export const MATERIALS: readonly { id: MaterialId; name: string; nameZh: string; color: string }[] = Object.freeze([
  { id: 'scale', name: 'Fish scale', nameZh: '鱼鳞片', color: '#d5a957' },
  { id: 'fiber', name: 'Reef fiber', nameZh: '珊瑚纤维', color: '#55c7b4' },
  { id: 'scrap', name: 'Iron scrap', nameZh: '铁屑', color: '#9ba6a2' },
  { id: 'crystal', name: 'Depth crystal', nameZh: '深度晶体', color: '#7da9ff' },
]);

export const RECIPES: readonly RecipeDef[] = Object.freeze([
  { id: 'bait', name: 'Tide bait', nameZh: '潮汐鱼饵', needs: { scale: 2, fiber: 1 }, output: 'bait' },
  { id: 'composite', name: 'Composite plate', nameZh: '复合护板', needs: { scrap: 3, crystal: 1, fiber: 2 }, output: 'composite' },
]);

/** Synthesis upgrade prices. They deliberately replace the old workshop prices only in this station. */
export const SYNTHESIS_UPGRADE_COSTS: Readonly<Record<UpgradeSlot, readonly [number, number]>> = Object.freeze({
  net: [89, 499], rod: [68, 329], reel: [78, 389], fins: [99, 549], tank: [119, 699], lamp: [58, 299], sonar: [149, 899],
});
export const SYNTHESIS_RECIPE_COSTS: Readonly<Record<RecipeDef['id'], number>> = Object.freeze({ bait: 38, composite: 128 });

export const SYNTHESIS_STORAGE_KEY = 'deepbreath.synthesis';

export const DEFAULT_SYNTHESIS: SynthesisState = Object.freeze({
  materials: Object.freeze({ scale: 8, fiber: 8, scrap: 10, crystal: 3 }),
  crafted: Object.freeze({ bait: 0, composite: 0 }),
});

const nonNegative = (value: unknown, fallback = 0) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, n);
};
const storedCount = (value: unknown, fallback: number) => value === undefined ? fallback : nonNegative(value);

export function normalizeSynthesis(input: unknown): SynthesisState {
  const raw = input && typeof input === 'object' ? input as Partial<SynthesisState> : {};
  const materials: Partial<SynthesisState['materials']> = raw.materials && typeof raw.materials === 'object' ? raw.materials : {};
  const crafted: Partial<SynthesisState['crafted']> = raw.crafted && typeof raw.crafted === 'object' ? raw.crafted : {};
  return {
    materials: {
      scale: storedCount(materials.scale, DEFAULT_SYNTHESIS.materials.scale),
      fiber: storedCount(materials.fiber, DEFAULT_SYNTHESIS.materials.fiber),
      scrap: storedCount(materials.scrap, DEFAULT_SYNTHESIS.materials.scrap),
      crystal: storedCount(materials.crystal, DEFAULT_SYNTHESIS.materials.crystal),
    },
    crafted: { bait: nonNegative(crafted.bait), composite: nonNegative(crafted.composite) },
  };
}

export function loadSynthesis(): SynthesisState {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(SYNTHESIS_STORAGE_KEY)) ?? 'null');
    const state = normalizeSynthesis(raw ?? DEFAULT_SYNTHESIS);
    saveSynthesis(state);
    return state;
  } catch {
    return normalizeSynthesis(DEFAULT_SYNTHESIS);
  }
}

export function saveSynthesis(state: SynthesisState): void {
  try { localStorage.setItem(storageKey(SYNTHESIS_STORAGE_KEY), JSON.stringify(normalizeSynthesis(state))); } catch { /* wallet not connected or storage unavailable */ }
}

export function recipe(id: RecipeDef['id']): RecipeDef {
  return RECIPES.find((entry) => entry.id === id) ?? RECIPES[0];
}

export function canCraft(state: SynthesisState, id: RecipeDef['id']): boolean {
  const def = recipe(id);
  return Object.entries(def.needs).every(([key, amount]) => state.materials[key as MaterialId] >= (amount ?? 0));
}

/** Consume one recipe atomically and return a new state. */
export function craft(state: SynthesisState, id: RecipeDef['id']): SynthesisState | null {
  if (!canCraft(state, id)) return null;
  const def = recipe(id);
  const next = normalizeSynthesis(state);
  for (const [key, amount] of Object.entries(def.needs)) next.materials[key as MaterialId] -= amount ?? 0;
  next.crafted[def.output] += 1;
  return next;
}

export function synthesisUpgradeCost(slot: UpgradeSlot, currentLevel: number): number | null {
  const costs = SYNTHESIS_UPGRADE_COSTS[slot];
  return currentLevel >= 1 && currentLevel <= 2 ? costs[currentLevel - 1] : null;
}

export const SYNTHESIS_SLOT_COUNT = 2 as const;
export const MIN_SYNTHESIS_COST = 38;
export const MAX_SYNTHESIS_COST = 899;
export const DEFAULT_CRAFT_DURATION = 0.72;

export type SynthesisAnimationPhase = 'empty' | 'ready' | 'crafting' | 'complete';

/** A thing that can be put in one of the two input slots. */
export interface SynthesisAnimationSlot {
  readonly id: string;
  /** Item level. Values below one are treated as level one for pricing. */
  readonly level?: number;
  /** Relative effect/strength used by the price calculation. */
  readonly effect?: number;
}

export type SynthesisAnimationSlots = readonly [SynthesisAnimationSlot | null, SynthesisAnimationSlot | null];

export interface SynthesisAnimationState {
  readonly slots: SynthesisAnimationSlots;
  readonly phase: SynthesisAnimationPhase;
  /** Normalised craft animation progress in the closed interval [0, 1]. */
  readonly progress: number;
  /** Duration in seconds used by advanceCraft when no duration is supplied. */
  readonly duration: number;
  /** Number of times this state has crossed into the complete phase. */
  readonly completions: number;
  /** Price for the currently occupied slots. */
  readonly cost: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A screen-space drop area. x/y identify its top-left corner. */
export interface DropZone {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const finite = (value: unknown, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const animationNonNegative = (value: unknown): number => Math.max(0, finite(value));

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function cleanDuration(value: unknown): number {
  // A zero/negative duration would make a frame-dependent jump to completion,
  // so callers get a stable, useful animation even when input is malformed.
  return Math.max(1e-6, finite(value, DEFAULT_CRAFT_DURATION));
}

function cleanSlot(slot: SynthesisAnimationSlot | null | undefined): SynthesisAnimationSlot | null {
  if (!slot || typeof slot.id !== 'string' || slot.id.length === 0) return null;
  const level = finite(slot.level, 1);
  const effect = finite(slot.effect, 0);
  return {
    id: slot.id,
    ...(Number.isFinite(level) ? { level } : {}),
    ...(Number.isFinite(effect) ? { effect } : {}),
  };
}

function phaseFor(slots: SynthesisAnimationSlots): SynthesisAnimationPhase {
  return slots[0] && slots[1] ? 'ready' : 'empty';
}

/**
 * Calculate a deterministic token fee from level and effect.
 *
 * The linear part keeps small combinations affordable while the clamp makes
 * the economy safe for arbitrary item data. Non-finite values contribute zero.
 * Increasing either argument can never lower the returned fee.
 */
export function synthesisCost(level: number, effect: number): number {
  const safeLevel = animationNonNegative(level);
  const safeEffect = animationNonNegative(effect);
  const raw = MIN_SYNTHESIS_COST + safeLevel * 61 + safeEffect * 47;
  return Math.round(clamp(raw, MIN_SYNTHESIS_COST, MAX_SYNTHESIS_COST));
}

/** Alias for callers that prefer a verb in the name. */
export const calculateSynthesisCost = synthesisCost;

/** Price the two currently selected inputs. Empty slots contribute no level/effect. */
export function costForSlots(slots: SynthesisAnimationSlots): number {
  let level = 0;
  let effect = 0;
  for (const slot of slots) {
    if (!slot) continue;
    level += animationNonNegative(slot.level);
    effect += animationNonNegative(slot.effect);
  }
  return synthesisCost(level, effect);
}

/** Create a fresh idle state. No object from a previous state is reused. */
export function createSynthesisAnimationState(duration = DEFAULT_CRAFT_DURATION): SynthesisAnimationState {
  const slots: SynthesisAnimationSlots = [null, null];
  return {
    slots,
    phase: 'empty',
    progress: 0,
    duration: cleanDuration(duration),
    completions: 0,
    cost: costForSlots(slots),
  };
}

/** Put an input in one of the two slots, preserving animation progress only when possible. */
export function setSynthesisAnimationSlot(
  state: SynthesisAnimationState,
  index: 0 | 1,
  slot: SynthesisAnimationSlot | null,
): SynthesisAnimationState {
  if (state.phase === 'crafting' || state.phase === 'complete') return state;
  const slots: [SynthesisAnimationSlot | null, SynthesisAnimationSlot | null] = [state.slots[0], state.slots[1]];
  slots[index] = cleanSlot(slot);
  const phase = phaseFor(slots);
  return {
    ...state,
    slots,
    phase,
    progress: 0,
    completions: state.completions,
    cost: costForSlots(slots),
  };
}

/** Remove one input from an idle/ready state. */
export function clearSynthesisAnimationSlot(state: SynthesisAnimationState, index: 0 | 1): SynthesisAnimationState {
  return setSynthesisAnimationSlot(state, index, null);
}

/** Begin the one-shot craft animation once both input slots are occupied. */
export function beginCraft(state: SynthesisAnimationState): SynthesisAnimationState {
  if (state.phase !== 'ready') return state;
  return { ...state, phase: 'crafting', progress: 0 };
}

/** Alias used by UI code that calls the operation “start synthesis”. */
export const startSynthesis = beginCraft;

/**
 * Advance the craft animation by a number of seconds.
 *
 * Progress is monotonic. Once it reaches one, subsequent frames are no-ops;
 * `completions` therefore increments exactly once for a craft.
 */
export function advanceCraft(state: SynthesisAnimationState, dt: number): SynthesisAnimationState {
  if (state.phase !== 'crafting') return state;
  const seconds = Math.max(0, finite(dt));
  const progress = clamp(state.progress + seconds / state.duration, 0, 1);
  if (progress < 1) return { ...state, progress };
  return {
    ...state,
    phase: 'complete',
    progress: 1,
    completions: state.completions + 1,
  };
}

/** Read progress in a form suitable for CSS/GL animation. */
export function animationProgress(state: SynthesisAnimationState): number;
export function animationProgress(elapsed: number, duration?: number): number;
export function animationProgress(value: SynthesisAnimationState | number, duration = DEFAULT_CRAFT_DURATION): number {
  if (typeof value === 'number') return clamp(Math.max(0, finite(value)) / cleanDuration(duration), 0, 1);
  return clamp(finite(value.progress), 0, 1);
}

/** Alias retained for animation-oriented callers. */
export const synthesisAnimationProgress = animationProgress;

function rectHit(point: Point, zone: DropZone, pad: number): boolean {
  const x = finite(point.x, Number.NaN);
  const y = finite(point.y, Number.NaN);
  const left = finite(zone.x, Number.NaN);
  const top = finite(zone.y, Number.NaN);
  const width = finite(zone.width, Number.NaN);
  const height = finite(zone.height, Number.NaN);
  if (![x, y, left, top, width, height].every(Number.isFinite)) return false;
  const inset = Math.max(0, finite(pad));
  return x >= left - inset && x <= left + width + inset
    && y >= top - inset && y <= top + height + inset;
}

/**
 * Test whether a released point is in a drop target.
 *
 * With a numeric second argument, the point is local to the target and `pad`
 * is a half-size tolerance. With a DropZone, the zone is expanded by `pad`.
 */
export function dropTarget(point: Point, pad: number): boolean;
export function dropTarget(point: Point, zone: DropZone, pad?: number): boolean;
export function dropTarget(point: Point, padOrZone: number | DropZone, pad = 0): boolean {
  if (typeof padOrZone === 'number') {
    const x = finite(point.x, Number.NaN);
    const y = finite(point.y, Number.NaN);
    const tolerance = Math.max(0, finite(padOrZone));
    return Number.isFinite(x) && Number.isFinite(y)
      && Math.abs(x) <= tolerance && Math.abs(y) <= tolerance;
  }
  return rectHit(point, padOrZone, pad);
}

/** Return the first of two zones containing a release, or null when it misses. */
export function releaseSlot(
  point: Point,
  zones: readonly [DropZone, DropZone],
  pad = 0,
): 0 | 1 | null {
  if (dropTarget(point, zones[0], pad)) return 0;
  if (dropTarget(point, zones[1], pad)) return 1;
  return null;
}


// Friendly names kept for the workbench animation API. The persisted wallet
// state above intentionally keeps the original SynthesisState shape.
export const createSynthesisState = createSynthesisAnimationState;
export const setSynthesisSlot = setSynthesisAnimationSlot;
export const clearSynthesisSlot = clearSynthesisAnimationSlot;

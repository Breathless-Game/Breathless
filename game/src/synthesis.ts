/**
 * Small, DOM-free state machine for the synthesis station.
 *
 * The workbench owns the visuals and pointer events.  This module only deals
 * with values that can be tested without a browser: two input slots, the
 * token price, drop hit testing, and the progress of the craft animation.
 */

export const SYNTHESIS_SLOT_COUNT = 2 as const;
export const MIN_SYNTHESIS_COST = 38;
export const MAX_SYNTHESIS_COST = 899;
export const DEFAULT_CRAFT_DURATION = 0.72;

export type SynthesisPhase = 'empty' | 'ready' | 'crafting' | 'complete';

/** A thing that can be put in one of the two input slots. */
export interface SynthesisSlot {
  readonly id: string;
  /** Item level. Values below one are treated as level one for pricing. */
  readonly level?: number;
  /** Relative effect/strength used by the price calculation. */
  readonly effect?: number;
}

export type SynthesisSlots = readonly [SynthesisSlot | null, SynthesisSlot | null];

export interface SynthesisState {
  readonly slots: SynthesisSlots;
  readonly phase: SynthesisPhase;
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

const nonNegative = (value: unknown): number => Math.max(0, finite(value));

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function cleanDuration(value: unknown): number {
  // A zero/negative duration would make a frame-dependent jump to completion,
  // so callers get a stable, useful animation even when input is malformed.
  return Math.max(1e-6, finite(value, DEFAULT_CRAFT_DURATION));
}

function cleanSlot(slot: SynthesisSlot | null | undefined): SynthesisSlot | null {
  if (!slot || typeof slot.id !== 'string' || slot.id.length === 0) return null;
  const level = finite(slot.level, 1);
  const effect = finite(slot.effect, 0);
  return {
    id: slot.id,
    ...(Number.isFinite(level) ? { level } : {}),
    ...(Number.isFinite(effect) ? { effect } : {}),
  };
}

function phaseFor(slots: SynthesisSlots): SynthesisPhase {
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
  const safeLevel = nonNegative(level);
  const safeEffect = nonNegative(effect);
  const raw = MIN_SYNTHESIS_COST + safeLevel * 61 + safeEffect * 47;
  return Math.round(clamp(raw, MIN_SYNTHESIS_COST, MAX_SYNTHESIS_COST));
}

/** Alias for callers that prefer a verb in the name. */
export const calculateSynthesisCost = synthesisCost;

/** Price the two currently selected inputs. Empty slots contribute no level/effect. */
export function costForSlots(slots: SynthesisSlots): number {
  let level = 0;
  let effect = 0;
  for (const slot of slots) {
    if (!slot) continue;
    level += nonNegative(slot.level);
    effect += nonNegative(slot.effect);
  }
  return synthesisCost(level, effect);
}

/** Create a fresh idle state. No object from a previous state is reused. */
export function createSynthesisState(duration = DEFAULT_CRAFT_DURATION): SynthesisState {
  const slots: SynthesisSlots = [null, null];
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
export function setSynthesisSlot(
  state: SynthesisState,
  index: 0 | 1,
  slot: SynthesisSlot | null,
): SynthesisState {
  if (state.phase === 'crafting' || state.phase === 'complete') return state;
  const slots: [SynthesisSlot | null, SynthesisSlot | null] = [state.slots[0], state.slots[1]];
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
export function clearSynthesisSlot(state: SynthesisState, index: 0 | 1): SynthesisState {
  return setSynthesisSlot(state, index, null);
}

/** Begin the one-shot craft animation once both input slots are occupied. */
export function beginCraft(state: SynthesisState): SynthesisState {
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
export function advanceCraft(state: SynthesisState, dt: number): SynthesisState {
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
export function animationProgress(state: SynthesisState): number;
export function animationProgress(elapsed: number, duration?: number): number;
export function animationProgress(value: SynthesisState | number, duration = DEFAULT_CRAFT_DURATION): number {
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


import type { MapId } from './maps';

// When random world events happen and which one. Pure logic with no runtime
// imports, so the tests can load it straight from TypeScript; events.ts owns
// the visuals.

export interface EventDef {
  id: string;
  /** Short line the game toasts when the event starts. */
  label: string;
  map: MapId | 'any';
  /** Seen from below the water (only picked when the diver is deep). */
  underwater: boolean;
  /** Surface events: the deepest the diver can be and still see it. Defaults to SURFACE_VIEW_DEPTH. */
  maxDepth?: number;
  /** Restrict to the night or the day. */
  when?: 'night' | 'day';
  /** Relative chance among the events that fit. Defaults to 1. */
  weight?: number;
  /** Weight multiplier once the diver is below the shelf (the trench). */
  deepBias?: number;
}

export interface ScheduleContext {
  depth: number;
  night: boolean;
  shelfDepth: number;
}

/** Underwater events only start below this depth (metres). */
export const UNDERWATER_DEPTH = 6;
/** The game camera rises above the water while the diver is shallower than this. */
export const SURFACE_VIEW_DEPTH = 2.5;
/** Seconds from a map load to its first event. */
export const FIRST_DELAY: readonly [number, number] = [20, 40];
/** Seconds between the end of one event and the start of the next. */
export const EVENT_GAP: readonly [number, number] = [45, 100];

export const EVENT_DEFS: readonly EventDef[] = [
  { id: 'avalanche', label: 'Avalanche on the north face!', map: 'fjord', underwater: false },
  // The calved berg drifts close enough to be seen from just under the surface.
  { id: 'calving', label: 'Iceberg calving! A chunk of ice breaks away.', map: 'fjord', underwater: false, maxDepth: UNDERWATER_DEPTH },
  { id: 'aurora', label: 'The aurora flares overhead!', map: 'fjord', underwater: false, when: 'night', weight: 1.5 },
  { id: 'rockfall', label: 'Rockfall! Stones tumble from a pillar.', map: 'tianchi', underwater: false },
  { id: 'cranes', label: 'A flock of cranes crosses the sky.', map: 'tianchi', underwater: false, when: 'day' },
  { id: 'mist', label: 'A mist surge rolls across the lake.', map: 'tianchi', underwater: false },
  { id: 'whale', label: 'A whale breaches in the distance!', map: 'ocean', underwater: false },
  { id: 'lightning', label: 'Lightning strikes the sea!', map: 'ocean', underwater: false },
  { id: 'ship', label: 'A ship passes on the horizon.', map: 'ocean', underwater: false },
  { id: 'leviathan', label: 'Something huge glides past in the deep...', map: 'any', underwater: true },
  { id: 'vent', label: 'A bubble vent bursts below!', map: 'any', underwater: true },
  { id: 'jellies', label: 'A bloom of glowing jellyfish drifts by.', map: 'any', underwater: true, deepBias: 4 },
];

export function eventsForMap(map: MapId, defs: readonly EventDef[] = EVENT_DEFS): EventDef[] {
  return defs.filter((d) => d.map === map || d.map === 'any');
}

/** Could the player see this event right now? */
export function isEligible(d: EventDef, ctx: ScheduleContext): boolean {
  const deep = ctx.depth > UNDERWATER_DEPTH;
  if (d.underwater !== deep) return false;
  if (!d.underwater && ctx.depth > (d.maxDepth ?? SURFACE_VIEW_DEPTH)) return false;
  if (d.when === 'night' && !ctx.night) return false;
  if (d.when === 'day' && ctx.night) return false;
  return true;
}

/** The events the player could actually see right now. */
export function eligible(defs: readonly EventDef[], ctx: ScheduleContext): EventDef[] {
  return defs.filter((d) => isEligible(d, ctx));
}

export function eventWeight(def: EventDef, ctx: ScheduleContext): number {
  const base = def.weight ?? 1;
  return ctx.depth > ctx.shelfDepth && def.deepBias ? base * def.deepBias : base;
}

/**
 * Weighted pick among the eligible events, avoiding a repeat of the last one
 * when there is a choice. Allocation-free: it may run every frame while waiting.
 */
export function pickEvent(
  defs: readonly EventDef[],
  ctx: ScheduleContext,
  rng: () => number,
  lastId: string | null = null,
): EventDef | null {
  let count = 0;
  for (let i = 0; i < defs.length; i++) if (isEligible(defs[i], ctx)) count++;
  if (count === 0) return null;
  const skip = count > 1 ? lastId : null;
  let total = 0;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (d.id !== skip && isEligible(d, ctx)) total += eventWeight(d, ctx);
  }
  if (total <= 0) return null;
  let r = rng() * total;
  let last: EventDef | null = null;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (d.id === skip || !isEligible(d, ctx)) continue;
    last = d;
    r -= eventWeight(d, ctx);
    if (r < 0) return d;
  }
  return last;
}

export interface ScheduleOptions {
  rng?: () => number;
  first?: readonly [number, number];
  gap?: readonly [number, number];
  defs?: readonly EventDef[];
}

/**
 * One event at a time: wait a random gap, then start whichever visible event
 * fits the diver's depth. If nothing fits (e.g. the diver hangs just under the
 * surface), it waits rather than playing something nobody can see.
 */
export class EventSchedule {
  private rng: () => number;
  private first: readonly [number, number];
  private gap: readonly [number, number];
  private defs: readonly EventDef[];
  private mapDefs: EventDef[] = [];
  private due: number | null = null;
  private last: string | null = null;
  private current: EventDef | null = null;

  constructor(map: MapId, opts: ScheduleOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.first = opts.first ?? FIRST_DELAY;
    this.gap = opts.gap ?? EVENT_GAP;
    this.defs = opts.defs ?? EVENT_DEFS;
    this.setMap(map);
  }

  /** The events possible on the current map. */
  get events(): readonly EventDef[] {
    return this.mapDefs;
  }

  get running(): EventDef | null {
    return this.current;
  }

  /** Time the next event becomes due, or null before the first tick / while one runs. */
  get dueAt(): number | null {
    return this.due;
  }

  /** New map: forget the running event and wait the first-event delay again. */
  setMap(map: MapId) {
    this.mapDefs = eventsForMap(map, this.defs);
    this.current = null;
    this.last = null;
    this.due = null;
  }

  /** Call every frame. Returns the event to start now, if any. */
  tick(now: number, ctx: ScheduleContext): EventDef | null {
    if (this.current) return null;
    // The delay is armed on the first tick, since the clock is unknown before then.
    if (this.due === null) this.due = now + this.roll(this.first);
    if (now < this.due) return null;
    const pick = pickEvent(this.mapDefs, ctx, this.rng, this.last);
    if (pick) this.begin(pick);
    return pick;
  }

  /** Start an event by hand (lab page / debugging). Replaces any running one. */
  force(id: string): EventDef | null {
    const def = this.mapDefs.find((d) => d.id === id) ?? null;
    if (def) this.begin(def);
    return def;
  }

  /** The running event finished: the next gap counts from now. */
  end(now: number) {
    if (!this.current) return;
    this.current = null;
    this.due = now + this.roll(this.gap);
  }

  private begin(def: EventDef) {
    this.current = def;
    this.last = def.id;
    this.due = null;
  }

  private roll([min, max]: readonly [number, number]) {
    return min + (max - min) * this.rng();
  }
}

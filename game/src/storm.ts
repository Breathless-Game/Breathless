// Heavy weather on a map with rough seas (the Open Ocean): in a storm, a rogue
// wave now and then sweeps across the water toward the boat and turns it over.
// Pure logic with no rendering, so the tests can load it straight from
// TypeScript: World draws the wave and rolls the boat, main.ts applies the losses.

export const ROGUE = {
  /** Storm strength (WeatherState.storm, 0..1) a rogue wave needs. */
  minStorm: 0.55,
  /** Seconds from the storm reaching that strength to the first wave, and between waves after it. */
  first: [10, 22],
  gap: [38, 70],
  /** The wave starts this far (m) to one side of the boat and crosses to as far on the other. */
  from: 150,
  /** Along x, in m/s: about 14 s from first sight to the boat. */
  speed: 11,
  /** Crest height (m) and half-width (m) at full strength. */
  height: 3.2,
  width: 9,
  /** The face that leads is this share of the half-width and the back this share: steep in front, long behind. */
  steep: 0.5,
  back: 1.4,
  /** The boat starts to go over when the crest is this close (m): it rolls as the crest passes under it. */
  strike: 3.5,
  /** The wave carries the capsizing boat this far (m) along with it. */
  carry: 5,
  /** Seconds the boat takes to go over, and to come back when righted. */
  rollSeconds: 1.6,
  rightSeconds: 1.8,
  /** To right the boat the diver must be within this far of it (m, along x) and no deeper than this (m). */
  reach: 9,
  depth: 3,
} as const;

export type StormEvent = 'wave' | 'capsize' | 'righted';

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Shape of a rogue wave, 0..1 of its height, `ahead` metres in front of the crest
 * (negative: behind it). The water shader draws the same curve.
 */
export function rogueProfile(ahead: number): number {
  const across = ahead / (ROGUE.width * (ahead > 0 ? ROGUE.steep : ROGUE.back));
  return Math.exp(-across * across);
}

/** How the boat lies in the water, on top of its ordinary bobbing. Angles in radians, lengths in metres. */
export interface BoatPose {
  /** Turned over about its length: 0 upright, PI keel up. */
  roll: number;
  /** Bow thrown up (positive) or down. */
  pitch: number;
  /** Slewed round, seen from above. */
  yaw: number;
  /** Carried along x by the wave. */
  surge: number;
  /** How much lower the hull floats. */
  sink: number;
}

/** Rogue waves and the state of the boat. The boat sits at x = 0. */
export class RogueWaves {
  /** Where the crest is (x, m), or null between waves. */
  x: number | null = null;
  /** +1 if the wave travels toward +x, -1 toward -x. */
  dir: 1 | -1 = 1;
  /** The boat is over (or going over, or being righted). No fish can be banked meanwhile. */
  capsized = false;
  /** 0 upright to 1 keel up. */
  roll = 0;
  private righting = false;
  private wait: number | null = null;
  /** Seconds since the boat came to rest keel up: it rocks for a while. */
  private rest = 0;
  /** Which way the wave that capsized it was travelling. */
  private thrown: 1 | -1 = 1;
  private readonly lie: BoatPose = { roll: 0, pitch: 0, yaw: 0, surge: 0, sink: 0 };

  constructor(private rng: () => number = Math.random) {}

  /** A new dive: calm water and an upright boat. */
  reset() {
    this.x = null;
    this.capsized = false;
    this.roll = 0;
    this.righting = false;
    this.wait = null;
    this.rest = 0;
  }

  /** Height (m) of the crest right now: it swells up as it sets out and sinks away after it has passed. */
  get height(): number {
    if (this.x === null) return 0;
    const travelled = ROGUE.from + this.x * this.dir;
    return ROGUE.height * smoothstep(0, 40, travelled) * (1 - smoothstep(ROGUE.from * 2 - 50, ROGUE.from * 2, travelled));
  }

  /**
   * How the capsize has left the boat. Going over, it is flung past keel-up and comes
   * back, its bow kicks, it slews round and the wave carries it along; then it rocks
   * to rest. Righting brings all of it back. The same object is returned every call.
   */
  get pose(): BoatPose {
    const p = this.roll;
    const lie = this.lie;
    if (this.righting) {
      const back = p * p * (3 - 2 * p);
      lie.roll = Math.PI * back;
      lie.pitch = 0.18 * Math.sin(Math.PI * p) * this.thrown;
      lie.yaw = 0.42 * this.thrown * back;
      lie.surge = ROGUE.carry * this.thrown * back;
      lie.sink = 0.3 * back;
      return lie;
    }
    // Overshoots by a tenth and settles exactly keel up. (An upright boat is exactly upright.)
    const over = p === 0 ? 0 : 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
    const rock = Math.exp(-this.rest / 1.6);
    lie.roll = Math.PI * (over + (p === 1 ? 0.06 * rock * Math.sin(this.rest * 3.6) : 0));
    lie.pitch = -this.thrown * (0.55 * Math.sin(Math.PI * Math.min(1, p * 1.25)) * (1 - 0.5 * p) + (p === 1 ? 0.05 * rock * Math.sin(this.rest * 2.7) : 0));
    lie.yaw = 0.42 * this.thrown * p * p * (3 - 2 * p);
    lie.surge = ROGUE.carry * this.thrown * (1 - Math.pow(1 - p, 2));
    lie.sink = 0.3 * Math.min(1, over);
    return lie;
  }

  /**
   * Advance by `dt` seconds in a storm of strength `storm` (0..1). `live` is false
   * outside a dive and on maps with calm seas: no wave forms then. Returns what
   * just happened, if anything.
   */
  tick(dt: number, storm: number, live: boolean): StormEvent | null {
    let event: StormEvent | null = null;
    // The boat turns over fast and comes back slower.
    if (this.capsized) {
      if (this.righting) {
        this.roll = Math.max(0, this.roll - dt / ROGUE.rightSeconds);
        if (this.roll === 0) {
          this.capsized = false;
          this.righting = false;
          event = 'righted';
        }
      } else if (this.roll < 1) {
        this.roll = Math.min(1, this.roll + dt / ROGUE.rollSeconds);
      } else {
        this.rest += dt;
      }
    }

    if (this.x === null) {
      if (!live || storm < ROGUE.minStorm) {
        // The count starts again when the storm returns.
        this.wait = null;
        return event;
      }
      if (this.wait === null) this.wait = this.between(ROGUE.first);
      this.wait -= dt;
      if (this.wait > 0) return event;
      this.dir = this.rng() < 0.5 ? 1 : -1;
      this.x = -this.dir * ROGUE.from;
      return event ?? 'wave';
    }

    const before = this.x;
    this.x += this.dir * ROGUE.speed * dt;
    // The steep face reaches the boat: an upright boat starts to go over, and is
    // rolling as the crest passes under it.
    if (before * this.dir < -ROGUE.strike && this.x * this.dir >= -ROGUE.strike && !this.capsized && live) {
      this.capsized = true;
      this.thrown = this.dir;
      this.rest = 0;
      event = 'capsize';
    }
    if (this.x * this.dir >= ROGUE.from) {
      this.x = null;
      this.wait = this.between(ROGUE.gap);
    }
    return event;
  }

  /** Start turning a capsized boat back over. False if there is nothing to right, or it is already coming back. */
  right(): boolean {
    if (!this.capsized || this.righting) return false;
    this.righting = true;
    return true;
  }

  /** Where the boat lies along x: at 0 unless a wave has carried it. */
  get boatX(): number {
    return this.pose.surge;
  }

  private between([min, max]: readonly [number, number]) {
    return min + (max - min) * this.rng();
  }
}

/** Can a diver at (x, depth) reach the boat to right it? */
export function canRight(x: number, depth: number): boolean {
  return Math.abs(x) <= ROGUE.reach && depth <= ROGUE.depth;
}

/**
 * What goes overboard when the boat capsizes: a third of the fish in the net
 * (rounded up) and one piece of the gear packed for this dive. The net itself
 * is never lost, so the dive can go on. Fish are returned as indices into the
 * net, highest first, so they can be spliced out in order.
 */
export function capsizeLoss<T extends string>(
  netCount: number, packed: readonly T[], rng: () => number = Math.random,
): { fish: number[]; gear: T | null } {
  const left = Array.from({ length: Math.max(0, netCount) }, (_, i) => i);
  const fish: number[] = [];
  for (let n = Math.ceil(left.length / 3); n > 0; n--) fish.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
  fish.sort((a, b) => b - a);
  const loose = packed.filter((slot) => slot !== 'net');
  return { fish, gear: loose.length ? loose[Math.floor(rng() * loose.length)] : null };
}

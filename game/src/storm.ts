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
  /** Seconds the boat takes to go over. */
  rollSeconds: 1.6,
  /**
   * Righting it is hard work: each press of F heaves it this share of the way up, and it
   * slumps back this share per second. Fewer than two presses a second gets nowhere;
   * a steady five a second takes about four seconds and twenty presses.
   */
  heave: 0.085,
  slump: 0.16,
  /** Heaving alone brings it this share of the way round; past that it tips and falls upright in `rightSeconds`. */
  tip: 0.8,
  rightSeconds: 0.7,
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
  /** 0 upright to 1 keel up. It stays at 1 while the boat lies capsized, however far it has been heaved. */
  roll = 0;
  /** How far the diver has heaved it back up, 0 to 1. At 1 it tips and rights itself. */
  effort = 0;
  private righting = false;
  /** 0 to 1 through the final fall upright. */
  private back = 0;
  /** The lurch of the last heave, 1 fading to 0. */
  private jolt = 0;
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
    this.effort = 0;
    this.righting = false;
    this.back = 0;
    this.jolt = 0;
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
   * to rest. Each heave brings it part of the way back with a lurch, and if the
   * heaving stops it slumps over again. The same object is returned every call.
   */
  get pose(): BoatPose {
    const p = this.roll;
    const lie = this.lie;
    if (p < 1 && !this.righting) {
      // Going over. Overshoots by a tenth and settles exactly keel up. (An upright boat is exactly upright.)
      const over = p === 0 ? 0 : 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
      lie.roll = Math.PI * over;
      lie.pitch = -this.thrown * 0.55 * Math.sin(Math.PI * Math.min(1, p * 1.25)) * (1 - 0.5 * p);
      lie.yaw = 0.42 * this.thrown * p * p * (3 - 2 * p);
      lie.surge = ROGUE.carry * this.thrown * (1 - Math.pow(1 - p, 2));
      lie.sink = 0.3 * Math.min(1, over);
      return lie;
    }
    // Keel up, heaved some of the way back, or falling upright: `stay` is how far over it still lies.
    const lifted = this.effort * this.effort * (3 - 2 * this.effort);
    const fall = this.back * this.back * (3 - 2 * this.back);
    const stay = this.righting ? (1 - ROGUE.tip) * (1 - fall) : 1 - ROGUE.tip * lifted;
    const rock = this.righting ? 0 : Math.exp(-this.rest / 1.6) * (1 - lifted);
    lie.roll = Math.PI * (stay + 0.06 * rock * Math.sin(this.rest * 3.6)) - 0.16 * this.jolt * stay;
    lie.pitch = -this.thrown * 0.05 * rock * Math.sin(this.rest * 2.7) + 0.05 * this.jolt * stay
      + (this.righting ? 0.14 * Math.sin(Math.PI * this.back) * this.thrown : 0);
    lie.yaw = 0.42 * this.thrown * stay;
    lie.surge = ROGUE.carry * this.thrown * stay;
    lie.sink = 0.3 * stay;
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
      this.jolt = Math.max(0, this.jolt - dt * 5);
      if (this.righting) {
        // Past the tipping point it falls upright by itself.
        this.back = Math.min(1, this.back + dt / ROGUE.rightSeconds);
        if (this.back === 1) {
          this.capsized = false;
          this.righting = false;
          this.roll = 0;
          this.effort = 0;
          this.back = 0;
          this.jolt = 0;
          event = 'righted';
        }
      } else if (this.roll < 1) {
        this.roll = Math.min(1, this.roll + dt / ROGUE.rollSeconds);
      } else {
        this.rest += dt;
        // Left alone, it slumps back over.
        this.effort = Math.max(0, this.effort - ROGUE.slump * dt);
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

  /**
   * One heave on the capsized boat (one press of F): it comes a little way up with a lurch.
   * Enough of them in quick succession tip it past the point where it rights itself.
   * False if there is nothing to heave on: upright, still going over, or already falling back.
   */
  heave(): boolean {
    if (!this.capsized || this.righting || this.roll < 1) return false;
    this.effort = Math.min(1, this.effort + ROGUE.heave);
    this.jolt = 1;
    if (this.effort === 1) {
      this.righting = true;
      this.back = 0;
    }
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

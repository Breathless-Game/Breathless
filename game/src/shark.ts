// Sharks on the Open Ocean at night, if the player opts in. They hunt by the
// diver's heartbeat: the faster it beats, the more of them come, the sooner
// they notice, the faster they charge and the more fish a bite costs. Pure
// rules with no rendering, so the tests can load this straight from
// TypeScript: shark-fx.ts draws them, main.ts applies the bites.

export const SHARK = {
  /** Resting pulse (bpm) assumed until one has been measured at the surface. */
  rest: 68,
  /** Beats above rest where sharks start to take notice, and where they are at their worst. */
  calm: 4,
  frenzy: 42,
  /** How near (m) a shark notices the diver at a calm pulse, and how much farther in a frenzy. */
  sense: 9,
  senseGain: 22,
  /** Speeds in m/s: circling, and charging at a calm pulse plus the extra in a frenzy. The diver swims about 7.5. */
  cruise: 3.2,
  charge: 4.6,
  chargeGain: 5.4,
  /** How hard it can pull its course round while charging (m/s²), calm and extra in a frenzy. */
  grip: 9,
  gripGain: 12,
  /** A charge that has not caught the diver in this long (s) is broken off. */
  chargeSeconds: 6,
  /** Close enough (m) to bite. */
  bite: 1.5,
  /** Seconds a shark keeps away after a bite or a failed charge, at a calm pulse and in a frenzy. */
  wait: 9,
  waitFrenzy: 4,
  /** Sharks do not follow the diver this close (m) to the surface, and never swim higher than `ceiling` m deep. */
  safeDepth: 3.5,
  ceiling: 2.5,
  /** They circle this far (m) from the diver, and arrive from this far to one side. */
  orbit: [14, 20],
  arrive: [36, 46],
  /** Pulse levels (0..1) at which a second and a third shark join. */
  second: 0.45,
  third: 0.8,
} as const;

export type SharkEvent = 'arrive' | 'charge' | 'bite';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** How worked up the sharks are, 0 (calm) to 1 (frenzy), for a pulse of `bpm` against a resting `rest`. */
export function sharkIntensity(bpm: number, rest: number = SHARK.rest): number {
  if (!Number.isFinite(bpm) || !Number.isFinite(rest)) return 0;
  return clamp01((bpm - rest - SHARK.calm) / (SHARK.frenzy - SHARK.calm));
}

/** How many sharks a pulse level brings. */
export function sharkCount(intensity: number): 1 | 2 | 3 {
  return intensity >= SHARK.third ? 3 : intensity >= SHARK.second ? 2 : 1;
}

/**
 * Which fish a bite tears out of a net of `netCount`: one at a calm pulse, up to
 * three in a frenzy. Indices into the net, highest first, to splice in order.
 */
export function biteFish(netCount: number, intensity: number, rng: () => number = Math.random): number[] {
  const left = Array.from({ length: Math.max(0, netCount) }, (_, i) => i);
  const taken: number[] = [];
  for (let n = Math.min(left.length, 1 + Math.round(2 * clamp01(intensity))); n > 0; n--) {
    taken.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
  }
  return taken.sort((a, b) => b - a);
}

/**
 * A stand-in pulse for play without a heart-rate sensor (keyboard mode): it
 * climbs with how hard the diver swims and settles when they drift. Swimming
 * slowly past a shark keeps it low, as staying calm does with a real one.
 */
export class PulseEstimate {
  bpm: number = SHARK.rest;

  /** `effort` is 0 (drifting) to 1 (flat out). */
  tick(dt: number, effort: number): number {
    const target = SHARK.rest + 46 * clamp01(effort);
    // The heart speeds up faster than it calms down.
    const pace = target > this.bpm ? 3.5 : 8;
    this.bpm += (target - this.bpm) * (1 - Math.exp(-dt / pace));
    return this.bpm;
  }
}

/** The diver's resting pulse, learned from the sensor while they float at the surface. */
export class RestingPulse {
  bpm: number = SHARK.rest;
  private seen = false;

  /** Feed the measured pulse while the diver rests at the surface. */
  tick(dt: number, pulse: number | null, resting: boolean) {
    if (pulse == null || !resting || !(pulse > 30 && pulse < 220)) return;
    if (!this.seen) {
      this.bpm = pulse;
      this.seen = true;
      return;
    }
    this.bpm += (pulse - this.bpm) * (1 - Math.exp(-dt / 20));
  }
}

/** The diver, as a shark sees them. Depth is -y. */
export interface Prey {
  x: number;
  y: number;
}

export class Shark {
  vx = 0;
  vy = 0;
  mode: 'patrol' | 'charge' | 'flee' | 'leave' = 'patrol';
  /** Seconds left in the current charge or flight. */
  timer = 0;
  /** Seconds until it may charge again. */
  wait: number;
  /** Where on its circle round the diver it is heading (rad), which way round, and how wide. */
  private angle: number;
  private turn: 1 | -1;
  private radius: number;
  /** Set once it has swum off for good. */
  gone = false;

  constructor(public x: number, public y: number, rng: () => number) {
    this.angle = rng() * Math.PI * 2;
    this.turn = rng() < 0.5 ? 1 : -1;
    this.radius = SHARK.orbit[0] + (SHARK.orbit[1] - SHARK.orbit[0]) * rng();
    // A moment to be seen before the first charge.
    this.wait = 3 + rng() * 3;
  }

  /** Swim off and do not come back (dawn, or the pulse has calmed and the pack thins). */
  dismiss() {
    if (this.mode !== 'leave') this.mode = 'leave';
  }

  /**
   * Advance by `dt`. `floor` is the lowest y it may swim at (the seabed, or -Infinity over the
   * trench). Returns 'charge' when it turns on the diver and 'bite' when it catches them.
   */
  step(dt: number, prey: Prey, intensity: number, floor: number): SharkEvent | null {
    const dx = prey.x - this.x, dy = prey.y - this.y;
    const dist = Math.hypot(dx, dy);
    let event: SharkEvent | null = null;
    let tx: number, ty: number, speed: number, grip: number;

    if (this.mode === 'leave') {
      // Straight away from the diver, level, until out of sight.
      tx = this.x - Math.sign(dx || 1) * 30;
      ty = this.y;
      speed = SHARK.cruise * 1.9;
      grip = 6;
      if (dist > 55) this.gone = true;
    } else if (this.mode === 'flee') {
      tx = this.x - dx;
      ty = this.y - dy - 2;
      speed = SHARK.cruise * 1.7;
      grip = 8;
      this.timer -= dt;
      if (this.timer <= 0) this.mode = 'patrol';
    } else if (this.mode === 'charge') {
      tx = prey.x;
      ty = prey.y;
      speed = SHARK.charge + SHARK.chargeGain * intensity;
      grip = SHARK.grip + SHARK.gripGain * intensity;
      this.timer -= dt;
      const safe = -prey.y < SHARK.safeDepth;
      if (dist < SHARK.bite && !safe) {
        event = 'bite';
        this.breakOff(intensity, 1);
        this.mode = 'flee';
        this.timer = 2.2;
      } else if (this.timer <= 0 || safe) {
        // Missed, or the diver reached the surface: it gives up for a while.
        this.breakOff(intensity, 0.6);
      }
    } else {
      // Circling: a point on a flattened ring round the diver, a little below them.
      this.angle += (this.turn * SHARK.cruise * dt) / this.radius;
      tx = prey.x + Math.cos(this.angle) * this.radius;
      ty = prey.y + Math.sin(this.angle) * this.radius * 0.4 - 2;
      speed = SHARK.cruise;
      grip = 5;
      this.wait -= dt;
      const sense = SHARK.sense + SHARK.senseGain * intensity;
      if (this.wait <= 0 && dist < sense && -prey.y >= SHARK.safeDepth) {
        this.mode = 'charge';
        this.timer = SHARK.chargeSeconds;
        event = 'charge';
      }
    }

    // Steer: pull the velocity toward the wanted one, no harder than its grip allows.
    const to = Math.hypot(tx - this.x, ty - this.y) || 1;
    const wantX = ((tx - this.x) / to) * speed, wantY = ((ty - this.y) / to) * speed;
    const pull = Math.hypot(wantX - this.vx, wantY - this.vy);
    const step = Math.min(1, (grip * dt) / (pull || 1));
    this.vx += (wantX - this.vx) * step;
    this.vy += (wantY - this.vy) * step;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // Never at the surface, never through the seabed.
    const top = -SHARK.ceiling, bottom = floor + 1.5;
    if (this.y > top) {
      this.y = top;
      this.vy = Math.min(0, this.vy);
    } else if (this.y < bottom) {
      this.y = bottom;
      this.vy = Math.max(0, this.vy);
    }
    return event;
  }

  private breakOff(intensity: number, share: number) {
    this.mode = 'patrol';
    this.wait = (SHARK.wait + (SHARK.waitFrenzy - SHARK.wait) * intensity) * share;
  }
}

/** The sharks in the water: how many there should be, and each one's swimming. */
export class SharkPack {
  readonly sharks: Shark[] = [];
  private next = 0;
  private announced = false;

  constructor(private rng: () => number = Math.random) {}

  /** Empty water at once: a new dive, another map. */
  reset() {
    this.sharks.length = 0;
    this.next = 0;
    this.announced = false;
  }

  /**
   * Advance by `dt`. `out` is whether sharks hunt right now (the mode is on, on a map with
   * sharks, at night, during a dive). Events come back in `events`, which is cleared first.
   */
  tick(dt: number, prey: Prey, intensity: number, out: boolean, floor: number, events: SharkEvent[]) {
    events.length = 0;
    const want = out ? sharkCount(intensity) : 0;
    const hunting = this.sharks.filter((s) => s.mode !== 'leave');
    if (hunting.length > want) {
      // The farthest one loses interest first.
      hunting.sort((a, b) => Math.hypot(b.x - prey.x, b.y - prey.y) - Math.hypot(a.x - prey.x, a.y - prey.y));
      for (const shark of hunting.slice(0, hunting.length - want)) shark.dismiss();
    } else if (hunting.length < want) {
      this.next -= dt;
      if (this.next <= 0) {
        const side = this.rng() < 0.5 ? -1 : 1;
        const far = SHARK.arrive[0] + (SHARK.arrive[1] - SHARK.arrive[0]) * this.rng();
        const y = Math.max(floor + 3, Math.min(-SHARK.ceiling - 3, prey.y - 4 + this.rng() * 6));
        this.sharks.push(new Shark(prey.x + side * far, y, this.rng));
        this.next = 5 + this.rng() * 5;
        if (!this.announced) {
          this.announced = true;
          events.push('arrive');
        }
      }
    }
    if (!out) this.announced = false;
    for (let i = this.sharks.length - 1; i >= 0; i--) {
      const shark = this.sharks[i];
      const event = shark.step(dt, prey, intensity, floor);
      if (event) events.push(event);
      if (shark.gone) this.sharks.splice(i, 1);
    }
  }
}

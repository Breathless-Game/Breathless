// BreathDetector on synthetic chest traces: the baseline is learned once (or seeded
// with a known one) and then stays fixed however long the player plays.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BreathDetector, DEFAULTS, SEED_MAX, SEED_MIN, parseSeedBaseline } from '../breath-detector.mjs';

const A = 1; // normal breathing amplitude (trace units)
const PERIOD_S = 4;
const HZ = 30;
const DT_US = Math.round(1e6 / HZ);

// Deterministic noise so every run sees the same trace.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// Builds a trace shaped like Presage's: sine breathing; a hold is the last inhale,
// then a high-pass decay back to flat; a release starts with an exhale well below it.
// Each sample goes straight into the detector, and every state change is logged.
class Session {
  constructor(det = new BreathDetector(), seed = 1, startUs = 1_000_000) {
    this.det = det;
    this.noise = rng(seed);
    this.tUs = startUs;
    this.v = -A;
    this.events = []; // {ts, holding}
    this.calibratedAt = null;
    this.calibrations = 0;
    this.baselines = new Set();
    this.holds = []; // {startUs, exhaleUs}
  }

  #push(v) {
    this.v = v;
    this.tUs += DT_US;
    const was = this.det.holding;
    const wasCal = this.det.snapshot().calibrated;
    this.det.pushTrace([{ value: v + (this.noise() - 0.5) * 0.004 * A, timestamp: this.tUs }]);
    const s = this.det.snapshot();
    if (s.calibrated && !wasCal) {
      this.calibrations++;
      this.calibratedAt ??= this.tUs;
    }
    if (this.det.baseline != null) this.baselines.add(this.det.baseline);
    if (this.det.holding !== was) this.events.push({ ts: this.tUs, holding: this.det.holding, why: this.det.releaseReason });
  }

  /** `cycles` whole breaths, trough to trough, around `center`. */
  breathe(cycles, amp = A, center = 0) {
    const n = Math.round(cycles * PERIOD_S * HZ);
    for (let i = 1; i <= n; i++) this.#push(center - amp * Math.cos((2 * Math.PI * i) / (PERIOD_S * HZ)));
    return this;
  }

  /** The last inhale (to 1.5 A), then `seconds` of a hold decaying to flat. */
  settle(seconds) {
    const from = this.v;
    const inhale = (PERIOD_S / 2) * HZ;
    for (let i = 1; i <= inhale; i++) this.#push(from + (1.5 * A - from) * (1 - Math.cos((Math.PI * i) / inhale)) / 2);
    this.holdUs = this.tUs;
    for (let i = 1; i <= seconds * HZ; i++) this.#push(1.5 * A * Math.exp(-i / HZ));
    return this;
  }

  /** A smooth move from here to `to` over `ms`. */
  moveTo(to, ms) {
    const from = this.v;
    const n = Math.max(1, Math.round((ms / 1000) * HZ));
    for (let i = 1; i <= n; i++) this.#push(from + (to - from) * (1 - Math.cos((Math.PI * i) / n)) / 2);
    return this;
  }

  /** A blip off the level by `by`, `ms` long in all: a quarter out, half there, a quarter back. */
  blip(by, ms) {
    const at = this.v;
    return this.moveTo(at + by, ms / 4).flat(ms / 2000).moveTo(at, ms / 4);
  }

  /** One sample off the level, then straight back. */
  spike(by) {
    const at = this.v;
    this.#push(at + by);
    this.#push(at);
    return this;
  }

  releases() {
    return this.events.filter((e) => !e.holding);
  }

  /** Flat (a pause, or holding before calibration has finished). */
  flat(seconds) {
    for (let i = 0; i < seconds * HZ; i++) this.#push(this.v);
    return this;
  }

  /** Presage's start-up swings: ~10x normal breathing, fast. */
  swing(seconds) {
    for (let i = 1; i <= seconds * HZ; i++) this.#push(10 * A * Math.sin((2 * Math.PI * i) / HZ));
    this.#push(-A);
    return this;
  }

  /** The last inhale (to 1.5 A), a hold that decays to flat, then the exhale (to -1.5 A). */
  hold(seconds) {
    const from = this.v;
    const inhale = (PERIOD_S / 2) * HZ;
    for (let i = 1; i <= inhale; i++) this.#push(from + (1.5 * A - from) * (1 - Math.cos((Math.PI * i) / inhale)) / 2);
    const startUs = this.tUs;
    for (let i = 1; i <= seconds * HZ; i++) this.#push(1.5 * A * Math.exp(-i / HZ));
    const exhaleUs = this.tUs;
    const top = this.v;
    const exhale = 0.5 * HZ;
    for (let i = 1; i <= exhale; i++) this.#push(top + (-1.5 * A - top) * (1 - Math.cos((Math.PI * i) / exhale)) / 2);
    this.holds.push({ startUs, exhaleUs });
    return this;
  }

  /** For each scripted hold: when it was called and released, relative to the script. */
  results() {
    return this.holds.map(({ startUs, exhaleUs }) => {
      const on = this.events.find((e) => e.holding && e.ts >= startUs - 2_000_000 && e.ts <= exhaleUs);
      const off = on && this.events.find((e) => !e.holding && e.ts > on.ts);
      return {
        detectMs: on ? (on.ts - startUs) / 1000 : null,
        releaseMs: off ? (off.ts - exhaleUs) / 1000 : null,
        why: off?.why ?? null,
        atS: startUs / 1e6,
      };
    });
  }
}

test('calibration finishes once, about warmup + minBaselineUs into the session, then the baseline is fixed', () => {
  const s = new Session();
  assert.equal(s.det.snapshot().calibrated, false);
  s.breathe(20); // 80 s of plain breathing
  const expected = 1_000_000 + DEFAULTS.warmupUs + DEFAULTS.minBaselineUs;
  assert.equal(s.calibrations, 1);
  assert.ok(Math.abs(s.calibratedAt - expected) <= 300_000, `calibrated at ${s.calibratedAt}, expected ~${expected}`);
  assert.equal(s.baselines.size, 1, 'baseline never changes after it is set');
  // Any 2 s window of a 4 s sine travels 2 A, so the baseline is ~A per second.
  assert.ok(Math.abs(s.det.baseline - A) < 0.1 * A, `baseline ${s.det.baseline}`);
  assert.equal(s.events.length, 0, 'plain breathing never reads as a hold');
});

test('no hold is called before calibration, and a short pause during it does not spoil the baseline', () => {
  const s = new Session();
  s.breathe(2).flat(1.5).breathe(3); // the pause falls inside the 9-15 s calibration window
  assert.equal(s.events.length, 0);
  s.breathe(4);
  assert.equal(s.calibrations, 1);
  assert.ok(Math.abs(s.det.baseline - A) < 0.15 * A, `baseline ${s.det.baseline}`);
});

test('a dead-flat start never freezes a zero baseline: calibration waits for real breathing', () => {
  const det = new BreathDetector();
  let ts = 0;
  for (let i = 0; i < 30 * HZ; i++) det.pushTrace([{ value: 0, timestamp: (ts += DT_US) }]);
  assert.equal(det.snapshot().calibrated, false);
  for (let i = 0; i < 20 * HZ; i++) det.pushTrace([{ value: -A * Math.cos((2 * Math.PI * i) / (PERIOD_S * HZ)), timestamp: (ts += DT_US) }]);
  assert.equal(det.snapshot().calibrated, true);
  assert.ok(Math.abs(det.baseline - A) < 0.15 * A, `baseline ${det.baseline}`);
});

test('a ten-minute session with many holds and big recovery breaths: no drift, same hold at minute 1 and minute 10', () => {
  const s = new Session();
  s.breathe(14).hold(15); // calibrate, breathe normally, first hold just before minute 1
  // Play: after every hold, deep recovery gasps (2x normal), then normal breathing, then hold again.
  while (s.tUs < 560_000_000) s.breathe(3, 2 * A).breathe(2).hold(15);
  s.breathe(3, 2 * A).breathe(2).hold(15); // the last hold, at minute ~10
  s.breathe(2);

  assert.equal(s.calibrations, 1, 'calibrated exactly once');
  assert.equal(s.baselines.size, 1, `baseline drifted: ${[...s.baselines].join(', ')}`);

  const r = s.results();
  const first = r[0];
  const last = r.at(-1);
  assert.ok(first.atS > 50 && first.atS < 70, `first hold at ${first.atS}s`);
  assert.ok(last.atS > 570, `last hold at ${last.atS}s`);
  assert.ok(r.length >= 15, `${r.length} holds`);
  for (const h of r) {
    assert.notEqual(h.detectMs, null, `hold at ${h.atS}s was never called`);
    assert.equal(h.why, 'exhale', `hold at ${h.atS}s ended by ${h.why}`);
  }
  // Within one 100 ms step: same trace shape, same frozen thresholds, same answer.
  assert.ok(Math.abs(first.detectMs - last.detectMs) <= 100, `detect ${first.detectMs} vs ${last.detectMs} ms`);
  assert.ok(Math.abs(first.releaseMs - last.releaseMs) <= 100, `release ${first.releaseMs} vs ${last.releaseMs} ms`);
  // The exhale crosses 1.1 B ~0.37 s in, + 0.1 s exhaleHoldUs, + releaseConfirmUs (was ~0.47 s).
  assert.ok(Math.abs(first.releaseMs - (470 + DEFAULTS.releaseConfirmUs / 1000)) <= 100, `release took ${first.releaseMs} ms`);
});

test('a new detector with no known baseline learns one from scratch', () => {
  const s = new Session();
  s.breathe(8);
  assert.equal(s.det.snapshot().calibrated, true);
  const fresh = new Session(new BreathDetector(), 2);
  assert.equal(fresh.det.snapshot().calibrated, false);
  assert.equal(fresh.det.baseline, null);
  fresh.breathe(8, 2 * A);
  assert.equal(fresh.calibrations, 1);
  assert.ok(Math.abs(fresh.det.baseline - 2 * A) < 0.2 * A, `baseline ${fresh.det.baseline}`);
});

test('a seeded detector skips learning: it is ready after the short warmup and calls a hold right away', () => {
  const s = new Session(new BreathDetector({ baseline: A }));
  assert.equal(s.det.seeded, true);
  assert.equal(s.det.snapshot().calibrated, false, 'not ready before any trace');
  s.flat(0.5);
  assert.equal(s.det.snapshot().calibrated, false, 'baseline known but still warming up');
  assert.equal(s.det.snapshot().warm, false);
  s.breathe(1).hold(10).breathe(2);
  const expected = 1_000_000 + DEFAULTS.seededWarmupUs;
  assert.ok(Math.abs(s.calibratedAt - expected) <= 100_000, `ready at ${s.calibratedAt}, expected ~${expected}`);
  assert.ok(DEFAULTS.seededWarmupUs < DEFAULTS.warmupUs + DEFAULTS.minBaselineUs);
  const [h] = s.results();
  assert.notEqual(h.detectMs, null, 'the hold was never called');
  const calledAtUs = h.atS * 1e6 + h.detectMs * 1000;
  assert.ok(calledAtUs < 1_000_000 + DEFAULTS.warmupUs + DEFAULTS.minBaselineUs, 'called before an unseeded detector could even finish learning');
  assert.equal(h.why, 'exhale');
  assert.equal(s.calibrations, 1);
});

test('a seeded baseline never moves, whatever the player breathes like', () => {
  const s = new Session(new BreathDetector({ baseline: A }));
  s.breathe(10, 2 * A).breathe(5, 0.6 * A).hold(15).breathe(10, 2 * A);
  assert.deepEqual([...s.baselines], [A]);
  assert.equal(s.det.base.length, 0, 'nothing is collected for learning');
});

test('a Presage restart in the same connection keeps the learned baseline (no relearning)', () => {
  const first = new Session();
  first.breathe(6).hold(15).breathe(2);
  const learned = first.det.baseline;
  assert.notEqual(learned, null);
  // What index.mjs does when a new pipeline starts: a fresh detector, seeded with the
  // connection's baseline. The new pipeline starts after a gap, with its start-up swings.
  const next = new Session(new BreathDetector({ baseline: first.det.baseline }), 3, first.tUs + 5_000_000);
  next.swing(2).breathe(1).hold(15).breathe(2);
  assert.deepEqual([...next.baselines], [learned]);
  assert.equal(next.calibrations, 1);
  assert.ok(next.calibratedAt - (first.tUs + 5_000_000) <= DEFAULTS.seededWarmupUs + 100_000);
  const [h] = next.results();
  assert.notEqual(h.detectMs, null);
  assert.equal(h.why, 'exhale');
  assert.equal(next.events.filter((e) => e.holding).length, 1, 'the start-up swings never read as a hold');
  // Same hold, same answer as on the first pipeline.
  const [h0] = first.results();
  assert.ok(Math.abs(h.detectMs - h0.detectMs) <= 100, `detect ${h0.detectMs} vs ${h.detectMs} ms`);
  assert.ok(Math.abs(h.releaseMs - h0.releaseMs) <= 100, `release ${h0.releaseMs} vs ${h.releaseMs} ms`);
});

test('seed validation: only a finite number in [SEED_MIN, SEED_MAX] is accepted', () => {
  for (const bad of [NaN, -1, -0.5, 0, -0, SEED_MIN / 2, SEED_MAX * 2, 1e9, Infinity, -Infinity, '1', '0.8', null, undefined, {}, [1], true]) {
    assert.equal(parseSeedBaseline(bad), null, `accepted ${String(bad)}`);
    const det = new BreathDetector({ baseline: bad });
    assert.equal(det.baseline, null);
    assert.equal(det.seeded, false);
  }
  for (const good of [SEED_MIN, 0.05, 1, 3.7, SEED_MAX]) assert.equal(parseSeedBaseline(good), good);
});

test('a seed never replaces a baseline the detector already has', () => {
  const s = new Session();
  s.breathe(5);
  const learned = s.det.baseline;
  assert.equal(s.det.seed(2 * A), false);
  assert.equal(s.det.baseline, learned);
  const seeded = new BreathDetector({ baseline: A });
  assert.equal(seeded.seed(3 * A), false);
  assert.equal(seeded.baseline, A);
});

// ---- Release tolerance: a blip mid-hold is not a breath ------------------------

/** A seeded detector (B = A) past its warmup, `seconds` into a settled hold. */
function holding(seconds) {
  const s = new Session(new BreathDetector({ baseline: A }), 7);
  s.breathe(2).settle(seconds);
  assert.equal(s.det.holding, true, 'the hold was called');
  return s;
}

function assertStillHolding(s, label) {
  assert.deepEqual(s.releases(), [], `${label}: released by ${s.releases()[0]?.why}`);
  assert.equal(s.det.holding, true);
  assert.equal(s.det.snapshot().releasing, false, `${label}: still pending`);
  // The hold keeps its original start: holdMs counts from it.
  const heldMs = s.det.snapshot().holdMs;
  const sinceStartMs = (s.tUs - s.holdUs) / 1000;
  assert.ok(Math.abs(heldMs - sinceStartMs) <= 600, `${label}: holdMs ${heldMs} vs ${sinceStartMs} since the hold began`);
}

test('tolerance: a single-sample spike up early in a hold does not end it', () => {
  const s = holding(3.2); // still inside trustAfterUs, where any activity used to end a hold
  s.spike(1.0 * A).flat(4);
  assertStillHolding(s, 'spike');
  // The spike stays in the 0.75 s activity window a little after the first cancel, so it may fire twice.
  assert.ok(s.det.blips >= 1);
});

test('tolerance: a 300 ms dip of 1.5 B that comes back to the level does not end the hold', () => {
  const s = holding(8);
  s.blip(-1.5 * A, 300).flat(4);
  assertStillHolding(s, 'dip');
  assert.equal(s.det.blips, 1);
  // ...and a real exhale afterwards still ends it.
  s.moveTo(-1.5 * A, 500).breathe(2);
  assert.equal(s.releases()[0]?.why, 'exhale');
});

test('tolerance: two blips 1 s apart (a dip, then a 300 ms twitch up) do not end the hold', () => {
  const s = holding(8);
  s.blip(-1.5 * A, 300).flat(0.7).blip(2.5 * A, 300).flat(4);
  assertStillHolding(s, 'two blips');
  assert.equal(s.det.blips, 2);
});

test('tolerance: a real exhale into normal breathing releases in ~0.47 s + releaseConfirmUs', () => {
  const s = holding(10);
  const exhaleUs = s.tUs;
  s.moveTo(-1.5 * A, 500).breathe(3);
  const [r] = s.releases();
  assert.equal(r?.why, 'exhale');
  const ms = (r.ts - exhaleUs) / 1000;
  const expected = 470 + DEFAULTS.releaseConfirmUs / 1000; // 1270 ms; 470 ms before this change
  assert.ok(Math.abs(ms - expected) <= 100, `released ${ms} ms after the exhale began, expected ~${expected}`);
});

test('tolerance: an exhale that stays empty still releases', () => {
  const s = holding(10);
  const exhaleUs = s.tUs;
  s.moveTo(-1.5 * A, 500).flat(3);
  const [r] = s.releases();
  assert.equal(r?.why, 'exhale');
  const ms = (r.ts - exhaleUs) / 1000;
  assert.ok(Math.abs(ms - (470 + DEFAULTS.releaseConfirmUs / 1000)) <= 100, `released after ${ms} ms`);
});

test('tolerance: an inhale-first release (held with empty lungs) still releases', () => {
  const s = holding(10);
  const inhaleUs = s.tUs;
  s.moveTo(2.5 * A, 500).breathe(2, A, 3.5 * A);
  const [r] = s.releases();
  assert.equal(r?.why, 'inhale');
  const ms = (r.ts - inhaleUs) / 1000;
  // Crosses 2 B ~0.35 s in, + 0.1 s, + releaseConfirmUs.
  assert.ok(ms > DEFAULTS.releaseConfirmUs / 1000 && ms <= 450 + DEFAULTS.releaseConfirmUs / 1000 + 100, `released after ${ms} ms`);
});

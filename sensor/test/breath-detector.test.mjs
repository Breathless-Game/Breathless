// BreathDetector on synthetic chest traces: the baseline is learned once, during
// calibration, and then stays fixed however long the player plays.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BreathDetector, DEFAULTS } from '../breath-detector.mjs';

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
  constructor(det = new BreathDetector(), seed = 1) {
    this.det = det;
    this.noise = rng(seed);
    this.tUs = 1_000_000;
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

  /** `cycles` whole breaths, trough to trough. */
  breathe(cycles, amp = A) {
    const n = Math.round(cycles * PERIOD_S * HZ);
    for (let i = 1; i <= n; i++) this.#push(-amp * Math.cos((2 * Math.PI * i) / (PERIOD_S * HZ)));
    return this;
  }

  /** Flat (a pause, or holding before calibration has finished). */
  flat(seconds) {
    for (let i = 0; i < seconds * HZ; i++) this.#push(this.v);
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

test('calibration finishes once, about warmup + calibrationUs into the session, then the baseline is fixed', () => {
  const s = new Session();
  assert.equal(s.det.snapshot().calibrated, false);
  s.breathe(20); // 80 s of plain breathing
  const expected = 1_000_000 + DEFAULTS.warmupUs + DEFAULTS.calibrationUs;
  assert.equal(s.calibrations, 1);
  assert.ok(Math.abs(s.calibratedAt - expected) <= 300_000, `calibrated at ${s.calibratedAt}, expected ~${expected}`);
  assert.equal(s.baselines.size, 1, 'baseline never changes after it is set');
  // Any 2 s window of a 4 s sine travels 2 A, so the baseline is ~A per second.
  assert.ok(Math.abs(s.det.baseline - A) < 0.1 * A, `baseline ${s.det.baseline}`);
  assert.equal(s.events.length, 0, 'plain breathing never reads as a hold');
});

test('no hold is called before calibration, and a short pause during it does not spoil the baseline', () => {
  const s = new Session();
  s.breathe(3).flat(4).breathe(2); // the pause falls inside the calibration window
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
  assert.ok(first.releaseMs < 1000, `release took ${first.releaseMs} ms`);
});

test('a new detector (new session or Presage restart) calibrates from scratch', () => {
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

// Turns Presage's chest breathing trace into a real-time HOLD / BREATHE signal.
//
// Presage gives us a breathing waveform (upper_trace) plus an apnea flag, but
// the apnea flag is tuned for clinical pauses, not a game that needs to react
// within a second. So we run our own detector on the raw trace:
//   - learn this person's normal breathing amplitude while they breathe
//   - HOLD when the trace has been flat (peak-to-peak << normal) for a short window
//   - BREATHE again as soon as the trace moves away from where the hold started
// Presage's apnea flag and talking flag are folded in as extra evidence.

const HOLD_WINDOW_US = 1_300_000; // flat for this long => holding
const AMP_WINDOW_US = 4_000_000; // window used to measure a normal breath's amplitude
const FLAT_RATIO = 0.22; // window peak-to-peak below this * baseline => flat
const RELEASE_RATIO = 0.4; // drift from hold reference above this * baseline => breathing
const MIN_SAMPLES = 8;

export class BreathDetector {
  constructor() {
    this.samples = []; // {ts, v}, ts in microseconds
    this.lastTs = 0;
    this.baseline = null; // typical peak-to-peak of one breath
    this.holding = false;
    this.holdStartTs = 0;
    this.holdRef = 0;
    this.apnea = null;
    this.talking = null;
    this.flatness = 0; // 0 = breathing hard, 1 = perfectly flat
  }

  pushTrace(points) {
    for (const p of points) {
      const ts = Number(p.timestamp ?? 0);
      if (!Number.isFinite(p.value) || ts <= this.lastTs) continue;
      this.samples.push({ ts, v: p.value });
      this.lastTs = ts;
    }
    const cutoff = this.lastTs - 30_000_000;
    while (this.samples.length && this.samples[0].ts < cutoff) this.samples.shift();
    this.#update();
  }

  setApnea(detected) {
    this.apnea = detected;
  }

  setTalking(detected) {
    this.talking = detected;
  }

  #window(us) {
    const from = this.lastTs - us;
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].ts >= from; i--) {
      const v = this.samples[i].v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      n++;
    }
    return { p2p: hi - lo, n };
  }

  #update() {
    const amp = this.#window(AMP_WINDOW_US);
    const flat = this.#window(HOLD_WINDOW_US);
    if (amp.n < MIN_SAMPLES || flat.n < MIN_SAMPLES / 2) return;

    // Only learn the baseline while visibly breathing, so a long hold can't
    // shrink "normal" down to "flat".
    if (!this.holding && amp.p2p > 0) {
      this.baseline = this.baseline == null ? amp.p2p : this.baseline * 0.9 + amp.p2p * 0.1;
    }
    if (!this.baseline) return;

    this.flatness = Math.max(0, Math.min(1, 1 - flat.p2p / (this.baseline * 0.6)));
    const current = this.samples[this.samples.length - 1].v;

    if (!this.holding) {
      const isFlat = flat.p2p < FLAT_RATIO * this.baseline;
      if ((isFlat || this.apnea === true) && this.talking !== true) {
        this.holding = true;
        this.holdStartTs = this.lastTs - HOLD_WINDOW_US;
        this.holdRef = current;
      }
    } else {
      const drift = Math.abs(current - this.holdRef);
      if (drift > RELEASE_RATIO * this.baseline || this.talking === true) {
        this.holding = false;
      }
    }
  }

  snapshot() {
    const recent = this.samples.slice(-90).map((s) => s.v);
    return {
      holding: this.holding,
      holdMs: this.holding ? Math.round((this.lastTs - this.holdStartTs) / 1000) : 0,
      calibrated: this.baseline != null,
      flatness: Number(this.flatness.toFixed(3)),
      apnea: this.apnea,
      talking: this.talking,
      trace: recent,
    };
  }
}

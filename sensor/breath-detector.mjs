// Turns Presage's chest breathing trace into a real-time HOLD / BREATHE signal.
//
// What real recordings showed (sensor/recordings, analyze.mjs):
//   - Presage's trace starts with a few seconds of huge start-up swings.
//   - The trace is high-pass filtered: when you hold, it jumps with the last
//     inhale and then decays back to flat over ~3 s instead of staying put.
//   - Presage's apnea flag never fired during 15 s holds.
// So we measure *activity*: how far the trace travels per second (path
// length), which is high while breathing, falls once the post-inhale decay
// settles, and jumps the instant you breathe again. Thresholds are ratios of
// this person's own breathing activity, learned with a robust median that
// ignores the start-up transient and the seconds leading into a hold.
//
// Every threshold is an option so sensor/analyze.mjs can replay a recording
// with different settings.

export const DEFAULTS = {
  activityWindowUs: 2_000_000, // window for the hold test
  releaseWindowUs: 750_000, // short window for the release test, so breathing again shows fast
  holdRatio: 0.38, // activity below this * baseline => holding
  releaseRatio: 0.5, // short-window activity above this * baseline => breathing again
  releaseHoldUs: 200_000, // ...and it has to stay there this long
  baselineWindowUs: 30_000_000, // learn "normal breathing" over this much history
  warmupUs: 8_000_000, // ignore Presage's start-up swings
  minBaselineUs: 6_000_000, // clean breathing needed before we call any hold
  talkingHoldUs: 500_000, // talking this long ends a hold
  useApnea: false, // Presage's apnea flag: never fired in testing, off by default
};

const SAMPLE_EVERY_US = 100_000;

export class BreathDetector {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.samples = []; // {ts, v}, ts in microseconds
    this.firstTs = 0;
    this.lastTs = 0;
    this.base = []; // {ts, a}: activity while breathing, for the baseline
    this.baseline = null; // median breathing activity (trace units per second)
    this.lastBaseTs = 0;
    this.holding = false;
    this.holdStartTs = 0;
    this.releaseSince = null;
    this.releasedTs = 0;
    this.talkingSince = null;
    this.apnea = null;
    this.talking = null;
    this.flatness = 0; // 0 = breathing hard, 1 = perfectly still
  }

  pushTrace(points) {
    for (const p of points) {
      const ts = Number(p.timestamp ?? 0);
      if (!Number.isFinite(p.value) || ts <= this.lastTs) continue;
      if (!this.firstTs) this.firstTs = ts;
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
    if (!detected) this.talkingSince = null;
    else this.talkingSince ??= this.lastTs;
  }

  /** Path length per second over the last `us` microseconds. */
  #activity(us) {
    const from = this.lastTs - us;
    let path = 0;
    let n = 0;
    for (let i = this.samples.length - 1; i > 0 && this.samples[i - 1].ts >= from; i--) {
      path += Math.abs(this.samples[i].v - this.samples[i - 1].v);
      n++;
    }
    return n < 4 ? null : path / (us / 1e6);
  }

  #learn(a) {
    const o = this.o;
    if (this.lastTs - this.lastBaseTs < SAMPLE_EVERY_US) return;
    this.lastBaseTs = this.lastTs;
    this.base.push({ ts: this.lastTs, a });
    while (this.base.length && this.base[0].ts < this.lastTs - o.baselineWindowUs) this.base.shift();
    if (this.base.length && this.lastTs - this.base[0].ts >= o.minBaselineUs) {
      const sorted = this.base.map((b) => b.a).sort((x, y) => x - y);
      this.baseline = sorted[sorted.length >> 1];
    }
  }

  #update() {
    const o = this.o;
    if (this.lastTs - this.firstTs < o.warmupUs) return;
    const a = this.#activity(o.activityWindowUs);
    if (a == null) return;
    if (!this.holding) this.#learn(a);
    const B = this.baseline;
    if (!B) return;
    this.flatness = Math.max(0, Math.min(1, 1 - a / (B * 0.8)));
    const talkingLong = this.talkingSince != null && this.lastTs - this.talkingSince >= o.talkingHoldUs;

    if (!this.holding) {
      // Right after a release the long window still contains the flat hold.
      if (this.lastTs - this.releasedTs < o.activityWindowUs) return;
      if ((a < o.holdRatio * B || (o.useApnea && this.apnea === true)) && !talkingLong) {
        this.holding = true;
        this.holdStartTs = this.lastTs - o.activityWindowUs;
        this.releaseSince = null;
        // The seconds sliding into a hold are not "normal breathing".
        const cut = this.holdStartTs - 1_000_000;
        while (this.base.length && this.base.at(-1).ts > cut) this.base.pop();
      }
      return;
    }
    const r = this.#activity(o.releaseWindowUs);
    if ((r != null && r > o.releaseRatio * B) || talkingLong) {
      this.releaseSince ??= this.lastTs;
      if (this.lastTs - this.releaseSince >= o.releaseHoldUs || talkingLong) {
        this.holding = false;
        this.releasedTs = this.lastTs;
      }
    } else {
      this.releaseSince = null;
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

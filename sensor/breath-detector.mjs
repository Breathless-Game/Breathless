// Turns Presage's chest breathing trace into a real-time HOLD / BREATHE signal.
//
// What real recordings showed (sensor/recordings, analyze.mjs):
//   - Presage's trace starts with a few seconds of huge start-up swings.
//   - The trace is high-pass filtered: when you hold, it jumps with the last
//     inhale and then decays back to flat over ~3 s instead of staying put.
//   - Presage's apnea flag never fired during 15 s holds.
//   - Every real release starts with an exhale: the trace drops 1.5-3.5x the
//     breathing baseline below the hold level. Glitches mid-hold can be just
//     as "active" but jump up, or dip only ~1x, so activity alone can't tell
//     them apart from breathing again.
// So we measure *activity*: how far the trace travels per second (path
// length), which is high while breathing, falls once the post-inhale decay
// settles, and jumps the instant you breathe again. Thresholds are ratios of
// this person's own breathing activity: a robust median of the first
// `calibrationUs` of breathing after the start-up transient. It is learned
// once and then frozen for the rest of the session, so the breathing a player
// does while playing (deep breaths before a dive, gasps after one) can never
// drag it around. A new session (a new detector) calibrates again.
// A hold ends on the exhale (a big drop below the hold level), on a big jump
// up (someone who held with empty lungs breathes in first), or, as a slow
// fallback, on sustained breathing-sized activity. Only in its first moments,
// when a "hold" may just be a pause between breaths, does any activity end it.
//
// Every threshold is an option so sensor/analyze.mjs can replay a recording
// with different settings.

export const DEFAULTS = {
  activityWindowUs: 2_000_000, // window for the hold test
  holdRatio: 0.38, // activity below this * baseline => holding
  exhaleRatio: 1.1, // trace drops this * baseline below the hold level => breathed out
  inhaleRatio: 2.0, // or jumps this * baseline above it => breathed in
  exhaleWindowUs: 1_500_000, // the drop has to happen within this window
  exhaleHoldUs: 100_000, // ...and stay there this long
  quietRatio: 0.5, // hold level only follows the trace while short-window activity is below this * baseline
  levelTauUs: 1_000_000, // how fast the hold level follows the trace
  trustAfterUs: 2_000_000, // for this long after a hold is detected, activity alone ends it:
  releaseWindowUs: 750_000, //   short-window activity...
  releaseRatio: 0.5, //   ...above this * baseline...
  releaseHoldUs: 200_000, //   ...for this long
  sustainedRatio: 0.8, // later, only hold-window activity above this * baseline...
  sustainedUs: 4_000_000, // ...for this long counts without an exhale
  warmupUs: 8_000_000, // ignore Presage's start-up swings
  calibrationUs: 10_000_000, // breathing learned once, before any hold is called; then frozen
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
    this.base = []; // {ts, a}: activity while breathing, during calibration only
    this.baseline = null; // median breathing activity (trace units per second), fixed once set
    this.lastBaseTs = 0;
    this.holding = false;
    this.holdStartTs = 0;
    this.detectedTs = 0;
    this.releaseSince = null;
    this.sustainedSince = null;
    this.exhaleSince = null;
    this.level = 0; // trace level while holding, following only quiet stretches
    this.lastUpdateTs = 0;
    this.releasedTs = 0;
    this.releaseReason = null; // what ended the last hold, for analyze.mjs
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

  /** Highest trace value over the last `us` microseconds. */
  #maxSince(us) {
    const from = this.lastTs - us;
    let m = -Infinity;
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].ts >= from; i--) m = Math.max(m, this.samples[i].v);
    return m;
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

  // Calibration: no hold can be called before the baseline exists, so every
  // sample here is breathing. Once enough is collected the median is frozen.
  #learn(a) {
    if (this.baseline != null) return;
    if (this.lastTs - this.lastBaseTs < SAMPLE_EVERY_US) return;
    this.lastBaseTs = this.lastTs;
    this.base.push({ ts: this.lastTs, a });
    if (this.lastTs - this.base[0].ts >= this.o.calibrationUs) {
      const sorted = this.base.map((b) => b.a).sort((x, y) => x - y);
      const median = sorted[sorted.length >> 1];
      // A dead-flat trace (no breathing seen) would freeze a useless 0: start over.
      if (median > 0) this.baseline = median;
      this.base = [];
    }
  }

  #update() {
    const o = this.o;
    const dt = this.lastTs - this.lastUpdateTs;
    this.lastUpdateTs = this.lastTs;
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
        this.detectedTs = this.lastTs;
        this.releaseSince = null;
        this.sustainedSince = null;
        this.exhaleSince = null;
        this.level = this.samples.at(-1).v;
      }
      return;
    }
    const v = this.samples.at(-1).v;
    const r = this.#activity(o.releaseWindowUs);
    // The hold level follows the slow post-inhale decay, but freezes while the
    // trace is jumping around so a glitch can't drag it along.
    if (r != null && r < o.quietRatio * B) this.level += (v - this.level) * (1 - Math.exp(-dt / o.levelTauUs));
    // An exhale is a drop both from the hold level and within the last moment,
    // so neither a frozen level nor the slow decay alone can fake one.
    const drop = Math.min(this.level - v, this.#maxSince(o.exhaleWindowUs) - v);
    const breathed = drop > o.exhaleRatio * B || v - this.level > o.inhaleRatio * B;
    this.exhaleSince = breathed ? (this.exhaleSince ?? this.lastTs) : null;
    const young = this.lastTs - this.detectedTs < o.trustAfterUs;
    this.releaseSince = young && r != null && r > o.releaseRatio * B ? (this.releaseSince ?? this.lastTs) : null;
    this.sustainedSince = a > o.sustainedRatio * B ? (this.sustainedSince ?? this.lastTs) : null;
    const since = (t, us) => t != null && this.lastTs - t >= us;
    const why = talkingLong
      ? 'talking'
      : since(this.exhaleSince, o.exhaleHoldUs)
        ? drop > o.exhaleRatio * B
          ? 'exhale'
          : 'inhale'
        : since(this.releaseSince, o.releaseHoldUs)
          ? 'activity'
          : since(this.sustainedSince, o.sustainedUs)
            ? 'sustained'
            : null;
    if (why) {
      this.releaseReason = why;
      this.holding = false;
      this.releasedTs = this.lastTs;
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

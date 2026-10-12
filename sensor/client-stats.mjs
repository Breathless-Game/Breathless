// The game's camera-pipeline numbers, `{ t: 'stats', ... }` every ~10 s while live
// (game/src/frame-pump.ts). Performance numbers only, never breath or health data: they are
// validated here and only ever appended to index.mjs's once-a-minute "frames" log line,
// never recorded, stored or sent anywhere.

/** Field: [min, max, kind]. Rates are averaged over a log window, counts are summed. */
export const CLIENT_STATS_FIELDS = Object.freeze({
  camFps: [0, 240, 'rate'],
  capFps: [0, 240, 'rate'],
  rvfcFps: [0, 240, 'rate'],
  renderFps: [0, 240, 'rate'],
  sentFps: [0, 240, 'rate'],
  skippedEncoder: [0, 100_000, 'count'],
  skippedBackpressure: [0, 100_000, 'count'],
  encodeMsAvg: [0, 10_000, 'rate'],
  quality: [0, 1, 'rate'],
});
export const CLIENT_PIPES = Object.freeze(['mstp', 'bitmap', 'canvas', 'raw']);
/** Reports per log window beyond this are ignored (the game sends ~6 a minute). */
export const MAX_REPORTS_PER_WINDOW = 30;

/**
 * Keeps only the known fields: finite numbers, clamped to their range and rounded to 0.01,
 * and `pipe` from CLIENT_PIPES. Returns null when nothing usable is left.
 */
export function parseClientStats(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const out = {};
  for (const [key, [min, max]] of Object.entries(CLIENT_STATS_FIELDS)) {
    const v = msg[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[key] = Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
  }
  if (typeof msg.pipe === 'string' && CLIENT_PIPES.includes(msg.pipe)) out.pipe = msg.pipe;
  return Object.keys(out).length ? out : null;
}

/** The reports of one log window, summarised for the log line. */
export class ClientStatsWindow {
  constructor() {
    this.#reset();
  }

  #reset() {
    this.reports = 0;
    this.sums = {};
    this.counts = {};
    this.pipe = null;
  }

  /** Adds one report (from parseClientStats); false when the window is full. */
  add(stats) {
    if (!stats || this.reports >= MAX_REPORTS_PER_WINDOW) return false;
    this.reports++;
    for (const [key, [, , kind]] of Object.entries(CLIENT_STATS_FIELDS)) {
      if (stats[key] === undefined) continue;
      this.sums[key] = (this.sums[key] ?? 0) + stats[key];
      if (kind === 'rate') this.counts[key] = (this.counts[key] ?? 0) + 1;
    }
    if (stats.pipe) this.pipe = stats.pipe;
    return true;
  }

  /** e.g. "client (6 reports): mstp, camera 30 fps, captured 29.8, ..."; '' with no reports. `reset` starts a new window. */
  summary(reset = false) {
    const { reports, sums, counts, pipe } = this;
    if (reset) this.#reset();
    if (!reports) return '';
    const avg = (k, digits = 1) => (counts[k] ? (sums[k] / counts[k]).toFixed(digits) : '-');
    const sum = (k) => (sums[k] === undefined ? '-' : String(Math.round(sums[k])));
    return (
      `client (${reports} report${reports === 1 ? '' : 's'}): ${pipe ?? '?'}, camera ${avg('camFps')} fps, ` +
      `captured ${avg('capFps')}, rVFC ${avg('rvfcFps')}, render ${avg('renderFps')}, sent ${avg('sentFps')}; ` +
      `skipped ${sum('skippedEncoder')} encoder busy, ${sum('skippedBackpressure')} backpressure; ` +
      `encode avg ${avg('encodeMsAvg')} ms, quality ${avg('quality', 2)}`
    );
  }
}

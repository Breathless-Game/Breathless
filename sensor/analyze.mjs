// Replays a recorded Presage session through the breath detector and reports
// how well it matches the player's own labels (Shift held = really holding).
//
//   node analyze.mjs                         latest recording, default settings
//   node analyze.mjs rec.jsonl --trace=lo    use the abdominal trace instead of chest
//   node analyze.mjs --exhaleRatio=1.3 --holdRatio=0.45
//   node analyze.mjs --sweep                 grid-search the main thresholds

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BreathDetector, DEFAULTS } from './breath-detector.mjs';

const DIR = fileURLToPath(new URL('./recordings/', import.meta.url));

// ---- args ---------------------------------------------------------------
const opts = {};
let file = null;
let trace = 'up';
let sweep = false;
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--(\w+)(?:=(.+))?$/);
  if (!m) file = a;
  else if (m[1] === 'trace') trace = m[2];
  else if (m[1] === 'sweep') sweep = true;
  else opts[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
}
if (!file) {
  const all = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();
  if (!all.length) throw new Error(`no recordings in ${DIR}`);
  file = DIR + all.at(-1);
}
const lines = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

// ---- helpers ------------------------------------------------------------
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const metrics = lines.filter((l) => l.k === 'm');
const labels = lines.filter((l) => l.k === 'label');
if (!metrics.length) throw new Error('recording has no metrics lines');

// ---- session ------------------------------------------------------------
const t0 = lines[0].at;
const t1 = lines.at(-1).at;
const allPts = (key) => {
  const seen = new Map();
  for (const m of metrics) for (const [ts, v] of m[key] ?? []) if (Number.isFinite(v)) seen.set(ts, v);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
};
const up = allPts('up');
const lo = allPts('lo');
const dts = up.slice(1).map((p, i) => (p[0] - up[i][0]) / 1000);
const gaps = metrics.slice(1).map((m, i) => m.at - metrics[i].at);
const latency = metrics.filter((m) => m.up?.length).map((m) => m.at - m.up.at(-1)[0] / 1000);
const fps = lines.filter((l) => l.k === 'fps').map((l) => l.n);
const hints = {};
for (const l of lines.filter((l) => l.k === 'hint')) hints[l.hint] = (hints[l.hint] ?? 0) + 1;

console.log(`\n== ${file.split('/').at(-1)}  (${f((t1 - t0) / 1000, 0)} s)`);
console.log(`camera fps        median ${f(median(fps), 0)}  (p10 ${f(pct(fps, 0.1), 0)})${median(fps) < 15 ? '  ⚠ low: Presage trace degrades' : ''}`);
console.log(`metrics batches   ${metrics.length}, every ${f(median(gaps), 0)} ms (p90 ${f(pct(gaps, 0.9), 0)})`);
console.log(`trace samples     up ${up.length}, lo ${lo.length}, every ${f(median(dts), 0)} ms ≈ ${f(1000 / median(dts), 1)} Hz`);
console.log(`trace latency     median ${f(median(latency), 0)} ms, p90 ${f(pct(latency, 0.9), 0)} ms (receipt − newest sample)`);
const firstStable = metrics.flatMap((m) => m.up ?? []).find((p) => p[2] === 1);
if (up.length) console.log(`trace stable      ${firstStable ? `after ${f((firstStable[0] - up[0][0]) / 1e6, 1)} s` : 'never'} (Presage marks the trace stable once breathing rate confidence ≥ 45)`);
if (Object.keys(hints).length) console.log(`presage hints     ${JSON.stringify(hints)}`);

// ---- labels -------------------------------------------------------------
const holds = [];
let open = null;
for (const l of labels) {
  if (l.holding && open == null) open = l.ts;
  else if (!l.holding && open != null) {
    holds.push([open, l.ts]);
    open = null;
  }
}
if (open != null) holds.push([open, t1]);
const labelAt = (t) => holds.some(([a, b]) => t >= a && t < b);
console.log(`labels            ${holds.length} hold(s): ${holds.map(([a, b]) => f((b - a) / 1000, 1) + 's').join(', ') || 'none (hold Shift while really holding)'}`);

// ---- signal separation ----------------------------------------------------
function separation(pts, name) {
  if (pts.length < 20 || !holds.length) return;
  const W = 2000; // ms
  const hold = [];
  const breathe = [];
  for (let t = pts[0][0] / 1000 + W; t < pts.at(-1)[0] / 1000; t += 250) {
    let lo_ = Infinity;
    let hi = -Infinity;
    for (const [ts, v] of pts) {
      const tm = ts / 1000;
      if (tm < t - W || tm > t) continue;
      lo_ = Math.min(lo_, v);
      hi = Math.max(hi, v);
    }
    if (!Number.isFinite(hi)) continue;
    const inHold = holds.some(([a, b]) => t - W >= a + 1000 && t <= b);
    const clear = !holds.some(([a, b]) => t >= a - 1500 && t - W <= b + 3000);
    if (inHold) hold.push(hi - lo_);
    else if (clear) breathe.push(hi - lo_);
  }
  const ratio = median(breathe) / median(hold);
  console.log(
    `${name.padEnd(17)} 2s p2p breathing ${f(median(breathe), 4)} vs holding ${f(median(hold), 4)} → ratio ${f(ratio, 1)}${ratio < 2.5 ? '  ⚠ weak separation' : ''}`,
  );
  for (const [a, b] of holds) {
    const seg = pts.filter(([ts]) => ts / 1000 >= a + 1000 && ts / 1000 <= b);
    if (seg.length < 5) continue;
    const span = Math.max(...seg.map((p) => p[1])) - Math.min(...seg.map((p) => p[1]));
    const net = seg.at(-1)[1] - seg[0][1];
    console.log(`  hold ${f((b - a) / 1000, 1)}s: total span ${f(span / median(breathe), 2)}× breath, net drift ${f(net / median(breathe), 2)}× breath`);
  }
}
separation(up, 'chest (up)');
separation(lo, 'abdomen (lo)');

// ---- replay -----------------------------------------------------------------
function replay(o) {
  const det = new BreathDetector(o);
  const out = []; // [at, holding]
  out.reasons = {}; // what ended each hold
  for (const m of metrics) {
    const pts = m[trace];
    const was = det.holding;
    if (pts?.length) det.pushTrace(pts.map(([timestamp, value]) => ({ timestamp, value })));
    if (o.useApnea !== false && m.apnea?.length) det.setApnea(Boolean(m.apnea.at(-1)[1]));
    if (m.talking?.length) det.setTalking(Boolean(m.talking.at(-1)[1]));
    if (was && !det.holding) out.reasons[det.releaseReason] = (out.reasons[det.releaseReason] ?? 0) + 1;
    out.push([m.at, det.holding]);
  }
  return out;
}

function score(series) {
  const start = series.find(([, h], i) => i > 5)?.[0] ?? t0;
  let i = 0;
  let cur = false;
  let n = 0;
  let agree = 0;
  let holdN = 0;
  let holdHit = 0;
  let breatheN = 0;
  let falseHold = 0;
  let toggles = 0;
  for (let t = start; t <= t1; t += 100) {
    while (i < series.length && series[i][0] <= t) {
      if (series[i][1] !== cur) toggles++;
      cur = series[i][1];
      i++;
    }
    const lab = labelAt(t);
    n++;
    if (lab === cur) agree++;
    if (lab) {
      holdN++;
      if (cur) holdHit++;
    } else {
      breatheN++;
      if (cur) falseHold++;
    }
  }
  const delays = [];
  const releases = [];
  let midHold = 0; // the game would say "you breathed" while the player is still holding
  for (const [a, b] of holds) {
    const on = series.findIndex(([at, h]) => h && at >= a - 500 && at <= b);
    if (on >= 0) {
      delays.push(series[on][0] - a);
      for (let j = on + 1; j < series.length && series[j][0] < b - 1000; j++) if (series[j - 1][1] && !series[j][1]) midHold++;
    }
    const off = series.find(([at, h]) => !h && at >= b - 500);
    if (off) releases.push(off[0] - b);
  }
  const minutes = (t1 - start) / 60000;
  return {
    acc: agree / n,
    recall: holdN ? holdHit / holdN : NaN,
    falseHold: breatheN ? falseHold / breatheN : NaN,
    togglesPerMin: toggles / minutes,
    labelTogglesPerMin: (holds.length * 2) / minutes,
    delay: median(delays),
    release: median(releases),
    missed: holds.length - delays.length,
    midHold,
  };
}

const show = (name, s) =>
  console.log(
    `${name.padEnd(17)} acc ${f(s.acc * 100, 0)}%  hold-recall ${f(s.recall * 100, 0)}%  false-hold ${f(s.falseHold * 100, 0)}%  toggles ${f(s.togglesPerMin, 1)}/min (truth ${f(s.labelTogglesPerMin, 1)})  detect +${f(s.delay / 1000, 1)}s  release +${f(s.release / 1000, 1)}s  missed ${s.missed}  mid-hold releases ${s.midHold}`,
  );

console.log('');
show('live (recorded)', score(metrics.map((m) => [m.at, Boolean(m.holding)])));
const settings = { ...DEFAULTS, ...opts };
const rep = replay(settings);
show(`replay ${trace}`, score(rep));
console.log(`release reasons   ${JSON.stringify(rep.reasons)}`);
console.log(`settings          ${JSON.stringify(settings)}`);

if (sweep && holds.length) {
  const rows = [];
  for (const holdRatio of [0.3, 0.38, 0.45])
    for (const exhaleRatio of [0.9, 1.1, 1.3, 1.5])
      for (const exhaleWindowUs of [1_000_000, 1_500_000, 2_500_000])
        for (const trustAfterUs of [1_000_000, 2_000_000, 3_000_000]) {
          const o = { ...settings, holdRatio, exhaleRatio, exhaleWindowUs, trustAfterUs };
          const s = score(replay(o));
          // Reward agreement; punish flicker beyond what the labels themselves do,
          // and above all telling a diver they breathed while they're still holding.
          const objective =
            s.acc - 0.02 * Math.max(0, s.togglesPerMin - s.labelTogglesPerMin) - 0.1 * s.missed - 0.1 * s.midHold;
          rows.push({ objective, o, s });
        }
  rows.sort((a, b) => b.objective - a.objective);
  console.log('\nbest settings:');
  for (const r of rows.slice(0, 5)) {
    show(`  H${r.o.holdRatio} x${r.o.exhaleRatio} w${r.o.exhaleWindowUs / 1e6}s t${r.o.trustAfterUs / 1e6}s`, r.s);
  }
}

import type { DiveRecord, HealthLog } from './health';

// The health report is built only when the player presses the button. It reads
// the dive log, works out a handful of wellness numbers, and draws two charts.

const $ = (id: string) => document.getElementById(id)!;

const C = {
  hold: '#3ef0a8',
  breathe: '#6ab8ff',
  danger: '#ff4d5e',
  gold: '#ffcc4d',
  ink: 'rgba(234,248,255,0.9)',
  muted: 'rgba(234,248,255,0.45)',
  grid: 'rgba(160,230,255,0.12)',
};

const OUTCOME_COLOR = { banked: C.hold, surfaced: C.breathe, blackout: C.danger };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const nonNull = <T,>(xs: (T | null)[]) => xs.filter((x): x is T => x != null);

export interface Stats {
  n: number;
  vitals: DiveRecord[];
  best: DiveRecord;
  recentAvg: number;
  earlierAvg: number | null;
  totalUnderMs: number;
  deepest: number;
  fish: number;
  blackouts: number;
  restPulse: number | null;
  restRate: number | null;
  reflexDrop: number | null;
  reflexPct: number | null;
  recovery: number | null;
  /** Dives with sharks in the water: counted for breath holds, left out of every heart-rate figure. */
  sharkDives: number;
}

export function compute(dives: DiveRecord[]): Stats {
  // A shark chase drives the pulse up: those dives say nothing about rest, the dive reflex or recovery.
  const steady = dives.filter((d) => !d.shark);
  const vitals = steady.filter((d) => d.pulse.length >= 3 && d.restPulse != null);
  const holds = dives.map((d) => d.holdMs);
  const recent = holds.slice(-10);
  const earlier = holds.slice(-20, -10);
  const drops = vitals.map((d) => d.restPulse! - d.minPulse!);
  const restPulse = median(nonNull(steady.map((d) => d.restPulse)));
  const reflexDrop = median(drops);
  return {
    n: dives.length,
    vitals,
    best: dives.reduce((a, d) => (d.holdMs > a.holdMs ? d : a)),
    recentAvg: mean(recent)!,
    earlierAvg: earlier.length >= 3 ? mean(earlier) : null,
    totalUnderMs: dives.reduce((a, d) => a + d.durationMs, 0),
    deepest: Math.max(...dives.map((d) => d.maxDepth)),
    fish: dives.reduce((a, d) => a + (d.outcome === 'blackout' ? 0 : d.fish), 0),
    blackouts: dives.filter((d) => d.outcome === 'blackout').length,
    restPulse,
    restRate: median(nonNull(steady.map((d) => d.restRate))),
    reflexDrop,
    reflexPct: reflexDrop != null && restPulse ? (reflexDrop / restPulse) * 100 : null,
    recovery: median(nonNull(steady.map((d) => d.recoveryS))),
    sharkDives: dives.length - steady.length,
  };
}

function insights(s: Stats): string[] {
  const out: string[] = [];
  if (s.earlierAvg != null) {
    const pct = ((s.recentAvg - s.earlierAvg) / s.earlierAvg) * 100;
    out.push(
      pct >= 3
        ? `Your average breath hold rose ${pct.toFixed(0)}% (${sec(s.earlierAvg)} → ${sec(s.recentAvg)}) over your last dives. Relaxed, regular practice is what moves this number.`
        : pct <= -3
          ? `Your average hold dipped ${Math.abs(pct).toFixed(0)}% recently (${sec(s.earlierAvg)} → ${sec(s.recentAvg)}). Fatigue does that; a few minutes of calm breathing before the next session usually helps.`
          : `Your breath hold is steady at about ${sec(s.recentAvg)}.`,
    );
  } else {
    out.push(`Your longest hold so far is ${sec(s.best.holdMs)}. A few more dives will reveal a trend.`);
  }
  if (s.reflexDrop != null) {
    out.push(
      s.reflexDrop >= 3
        ? `Your heart slowed by about ${s.reflexDrop.toFixed(0)} bpm while you held your breath. That is the mammalian dive reflex, a normal response that helps the body save oxygen.`
        : s.reflexDrop <= -3
          ? `Your heart rate rose during holds. That is common when tense; loosening the shoulders and jaw before a dive often lets the dive reflex show up.`
          : `Your heart rate stayed about level during holds.`,
    );
  }
  if (s.recovery != null) {
    out.push(`After surfacing, your heart rate returned to its resting level in about ${s.recovery.toFixed(0)} s.`);
  }
  if (s.restRate != null) {
    out.push(`Your resting breathing rate before dives was about ${s.restRate.toFixed(0)} breaths/min.`);
  }
  if (s.blackouts) {
    out.push(
      `${s.blackouts} dive${s.blackouts > 1 ? 's' : ''} ended in a game blackout. That is the game's warning, not a goal: in real life, stop a hold well before you feel dizzy.`,
    );
  }
  if (s.sharkDives) {
    out.push(
      `${s.sharkDives} dive${s.sharkDives > 1 ? 's were' : ' was'} made with sharks in the water. Being hunted raises the pulse, so ${s.sharkDives > 1 ? 'they are' : 'it is'} left out of the heart-rate figures above; ${s.sharkDives > 1 ? 'their' : 'its'} breath-hold time still counts.`,
    );
  }
  if (!s.vitals.length) {
    out.push(
      s.sharkDives === s.n
        ? 'Every dive so far had sharks in the water. Dive without them (Esc → Settings) to get heart-rate figures.'
        : 'Play with the camera to add heart rate and breathing rate to this report.',
    );
  }
  return out;
}

function canvas(el: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth;
  const h = el.clientHeight;
  el.width = w * dpr;
  el.height = h * dpr;
  const ctx = el.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  return { ctx, w, h };
}

function drawHolds(el: HTMLCanvasElement, dives: DiveRecord[], bestMs: number) {
  const { ctx, w, h } = canvas(el);
  const pad = { l: 36, r: 8, t: 10, b: 20 };
  const show = dives.slice(-30);
  const step = Math.max(2, Math.ceil(((bestMs / 1000) * 1.1) / 4));
  const maxS = step * 4;
  const y = (s: number) => h - pad.b - (s / maxS) * (h - pad.t - pad.b);
  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  for (let s = 0; s <= maxS; s += step) {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(s));
    ctx.lineTo(w - pad.r, y(s));
    ctx.stroke();
    ctx.fillText(`${s.toFixed(0)}s`, pad.l - 6, y(s) + 4);
  }
  const bw = (w - pad.l - pad.r) / Math.max(show.length, 8);
  show.forEach((d, i) => {
    ctx.fillStyle = OUTCOME_COLOR[d.outcome];
    const top = y(d.holdMs / 1000);
    ctx.fillRect(pad.l + i * bw + bw * 0.15, top, bw * 0.7, h - pad.b - top);
  });
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = C.gold;
  ctx.beginPath();
  ctx.moveTo(pad.l, y(bestMs / 1000));
  ctx.lineTo(w - pad.r, y(bestMs / 1000));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = C.gold;
  ctx.textAlign = 'left';
  ctx.fillText('best', pad.l + 4, y(bestMs / 1000) - 4);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.fillText(`last ${show.length} dives →`, w / 2, h - 4);
}

function drawPulse(el: HTMLCanvasElement, d: DiveRecord) {
  const { ctx, w, h } = canvas(el);
  const pad = { l: 36, r: 8, t: 10, b: 20 };
  const bpms = d.pulse.map(([, b]) => b);
  const lo = Math.floor(Math.min(...bpms, d.restPulse!) - 4);
  const hi = Math.ceil(Math.max(...bpms, d.restPulse!) + 4);
  const tMax = Math.max(d.pulse.at(-1)![0], 1);
  const x = (t: number) => pad.l + (t / tMax) * (w - pad.l - pad.r);
  const y = (b: number) => h - pad.b - ((b - lo) / (hi - lo)) * (h - pad.t - pad.b);
  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) {
    const b = lo + ((hi - lo) * k) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(b));
    ctx.lineTo(w - pad.r, y(b));
    ctx.stroke();
    ctx.fillText(b.toFixed(0), pad.l - 6, y(b) + 4);
  }
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = C.breathe;
  ctx.beginPath();
  ctx.moveTo(pad.l, y(d.restPulse!));
  ctx.lineTo(w - pad.r, y(d.restPulse!));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = C.breathe;
  ctx.textAlign = 'left';
  ctx.fillText(`resting ${d.restPulse!.toFixed(0)} bpm`, pad.l + 4, y(d.restPulse!) - 4);
  ctx.strokeStyle = C.danger;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  d.pulse.forEach(([t, b], i) => (i ? ctx.lineTo(x(t), y(b)) : ctx.moveTo(x(t), y(b))));
  ctx.stroke();
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.fillText(`seconds underwater (0 – ${tMax.toFixed(0)} s)`, w / 2, h - 4);
}

export class Report {
  private panel = $('report');

  constructor(private log: HealthLog) {}

  get open() {
    return !this.panel.classList.contains('hidden');
  }

  toggle(show = !this.open) {
    this.panel.classList.toggle('hidden', !show);
    if (show) this.render();
  }

  private render() {
    const dives = this.log.dives;
    const when = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const head = `
      <div class="report-head">
        <div>
          <h2>Breath &amp; Heart Report</h2>
          <div class="small muted">Generated ${when} · stored only on this device</div>
        </div>
        <div class="report-actions">
          <button id="report-print" class="mini">Save PDF</button>
          <button id="report-close" class="mini">Close (H)</button>
        </div>
      </div>`;
    if (!dives.length) {
      this.panel.innerHTML = `${head}<p class="report-empty">No dives recorded yet. Hold your breath, dive, and come back.</p>`;
      this.wire();
      return;
    }
    const s = compute(dives);
    const tile = (label: string, value: string, sub = '', color = '') =>
      `<div class="tile"><div class="small muted">${label}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${value}</div><div class="small sub">${sub}</div></div>`;
    const trend =
      s.earlierAvg != null ? `${s.recentAvg >= s.earlierAvg ? '▲' : '▼'} from ${sec(s.earlierAvg)}` : 'last 10 dives';
    const longest = s.vitals.length ? s.vitals.reduce((a, d) => (d.holdMs > a.holdMs ? d : a)) : null;
    this.panel.innerHTML = `${head}
      <div class="small muted basis">Based on ${s.n} dive${s.n > 1 ? 's' : ''}${s.vitals.length ? `, ${s.vitals.length} with heart-rate data` : ''}${s.sharkDives ? `; ${s.sharkDives} with sharks, not used for heart rate` : ''}.</div>
      <div class="tiles">
        ${tile('Longest breath hold', sec(s.best.holdMs), new Date(s.best.at).toLocaleDateString(), C.hold)}
        ${tile('Average hold', sec(s.recentAvg), trend)}
        ${tile('Resting heart rate', s.restPulse != null ? `${s.restPulse.toFixed(0)} bpm` : '—', 'before dives')}
        ${tile('Dive reflex', s.reflexDrop != null ? `${s.reflexDrop >= 0 ? '−' : '+'}${Math.abs(s.reflexDrop).toFixed(0)} bpm` : '—', s.reflexPct != null ? `${Math.abs(s.reflexPct).toFixed(0)}% ${s.reflexDrop! >= 0 ? 'slower' : 'faster'} while holding` : 'needs camera', C.danger)}
        ${tile('Recovery', s.recovery != null ? `${s.recovery.toFixed(0)} s` : '—', 'heart back to rest')}
        ${tile('Breathing rate', s.restRate != null ? `${s.restRate.toFixed(0)} /min` : '—', 'at rest')}
        ${tile('Time on one breath', sec(s.totalUnderMs), 'all dives')}
        ${tile('Deepest dive', `${s.deepest} m`, `${s.fish} fish banked`)}
      </div>
      <section class="chart">
        <div class="row small"><b>Breath hold per dive</b><span class="legend"><i style="--c:${C.hold}"></i>banked <i style="--c:${C.breathe}"></i>surfaced <i style="--c:${C.danger}"></i>blackout</span></div>
        <canvas id="chart-holds"></canvas>
      </section>
      ${
        longest
          ? `<section class="chart">
        <div class="row small"><b>Heart rate during your longest dive</b><span class="muted">${sec(longest.holdMs)} hold · ${longest.maxDepth} m</span></div>
        <canvas id="chart-pulse"></canvas>
      </section>`
          : ''
      }
      <section class="insights"><b class="small">What this means</b><ul>${insights(s)
        .map((t) => `<li>${t}</li>`)
        .join('')}</ul></section>
      <p class="disclaimer small">Wellness insights only, from camera-based Presage SmartSpectra estimates. Not a medical device and not medical advice. Never practice breath holds in or near water, and stop if you feel dizzy or light-headed.</p>
      <button id="report-delete" class="link small">Delete my health data</button>`;
    this.wire();
    drawHolds($('chart-holds') as HTMLCanvasElement, dives, s.best.holdMs);
    if (longest) drawPulse($('chart-pulse') as HTMLCanvasElement, longest);
  }

  private wire() {
    $('report-close').addEventListener('click', () => this.toggle(false));
    $('report-print').addEventListener('click', () => window.print());
    document.getElementById('report-delete')?.addEventListener('click', () => {
      if (!confirm('Delete all recorded dives and vitals from this device?')) return;
      this.log.clear();
      this.render();
    });
  }
}

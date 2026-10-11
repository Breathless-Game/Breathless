import type { DiveRecord, HealthLog } from './health';
import { lang, onLangChange, t } from './i18n';
import { hasHealthData } from './wallet-storage';

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
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} ${t('s', '秒')}`;
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
        ? t(
            `Your average breath hold rose ${pct.toFixed(0)}% (${sec(s.earlierAvg)} → ${sec(s.recentAvg)}) over your last dives. Relaxed, regular practice is what moves this number.`,
            `你的平均屏息时间提升了 ${pct.toFixed(0)}%（${sec(s.earlierAvg)} → ${sec(s.recentAvg)}）。放松、规律的练习才是提升这个数字的关键。`,
          )
        : pct <= -3
          ? t(
              `Your average hold dipped ${Math.abs(pct).toFixed(0)}% recently (${sec(s.earlierAvg)} → ${sec(s.recentAvg)}). Fatigue does that; a few minutes of calm breathing before the next session usually helps.`,
              `你的平均屏息时间最近下降了 ${Math.abs(pct).toFixed(0)}%（${sec(s.earlierAvg)} → ${sec(s.recentAvg)}）。疲劳会这样；下次下潜前先平静呼吸几分钟通常会有帮助。`,
            )
          : t(`Your breath hold is steady at about ${sec(s.recentAvg)}.`, `你的屏息时间稳定在约 ${sec(s.recentAvg)}。`),
    );
  } else {
    out.push(t(
        `Your longest hold so far is ${sec(s.best.holdMs)}. A few more dives will reveal a trend.`,
        `目前你最长的一次屏息是 ${sec(s.best.holdMs)}。再多下潜几次就能看出趋势。`,
      ));
  }
  if (s.reflexDrop != null) {
    out.push(
      s.reflexDrop >= 3
        ? t(
            `Your heart slowed by about ${s.reflexDrop.toFixed(0)} bpm while you held your breath. That is the mammalian dive reflex, a normal response that helps the body save oxygen.`,
            `屏息时你的心率下降了约 ${s.reflexDrop.toFixed(0)} bpm。这是哺乳动物潜水反射，一种帮助身体节省氧气的正常反应。`,
          )
        : s.reflexDrop <= -3
          ? t(
              `Your heart rate rose during holds. That is common when tense; loosening the shoulders and jaw before a dive often lets the dive reflex show up.`,
              `屏息时你的心率上升了。紧张时很常见；下潜前放松肩膀和下巴，往往能让潜水反射出现。`,
            )
          : t(`Your heart rate stayed about level during holds.`, `屏息时你的心率基本持平。`),
    );
  }
  if (s.recovery != null) {
    out.push(t(
        `After surfacing, your heart rate returned to its resting level in about ${s.recovery.toFixed(0)} s.`,
        `浮出水面后，你的心率在约 ${s.recovery.toFixed(0)} 秒内恢复到静息水平。`,
      ));
  }
  if (s.restRate != null) {
    out.push(t(
        `Your resting breathing rate before dives was about ${s.restRate.toFixed(0)} breaths/min.`,
        `下潜前你的静息呼吸频率约为每分钟 ${s.restRate.toFixed(0)} 次。`,
      ));
  }
  if (s.blackouts) {
    out.push(
      t(
        `${s.blackouts} dive${s.blackouts > 1 ? 's' : ''} ended in a game blackout. That is the game's warning, not a goal: in real life, stop a hold well before you feel dizzy.`,
        `${s.blackouts} 次下潜以游戏内昏厥告终。那是游戏的警告，而不是目标：现实中请在感到头晕之前就停止屏息。`,
      ),
    );
  }
  if (s.sharkDives) {
    out.push(
      t(
        `${s.sharkDives} dive${s.sharkDives > 1 ? 's were' : ' was'} made with sharks in the water. Being hunted raises the pulse, so ${s.sharkDives > 1 ? 'they are' : 'it is'} left out of the heart-rate figures above; ${s.sharkDives > 1 ? 'their' : 'its'} breath-hold time still counts.`,
        `有 ${s.sharkDives} 次下潜水中有鲨鱼。被追猎会让脉搏加快，所以这些下潜不计入上面的心率数据；屏息时间仍然计入。`,
      ),
    );
  }
  if (!s.vitals.length) {
    out.push(
      s.sharkDives === s.n
        ? t(
            'Every dive so far had sharks in the water. Dive the Fjord or Heaven Lake, where there are none, to get heart-rate figures.',
            '到目前为止每次下潜水里都有鲨鱼。去没有鲨鱼的峡湾或天池下潜，才能得到心率数据。',
          )
        : t('Play with the camera to add heart rate and breathing rate to this report.', '开启摄像头游玩，即可把心率和呼吸频率加入本报告。'),
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
    ctx.fillText(`${s.toFixed(0)}${t('s', '秒')}`, pad.l - 6, y(s) + 4);
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
  ctx.fillText(t('best', '最佳'), pad.l + 4, y(bestMs / 1000) - 4);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.fillText(t(`last ${show.length} dives →`, `最近 ${show.length} 次下潜 →`), w / 2, h - 4);
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
  ctx.fillText(t(`resting ${d.restPulse!.toFixed(0)} bpm`, `静息 ${d.restPulse!.toFixed(0)} bpm`), pad.l + 4, y(d.restPulse!) - 4);
  ctx.strokeStyle = C.danger;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  d.pulse.forEach(([t, b], i) => (i ? ctx.lineTo(x(t), y(b)) : ctx.moveTo(x(t), y(b))));
  ctx.stroke();
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.fillText(t(`seconds underwater (0 – ${tMax.toFixed(0)} s)`, `水下秒数（0 – ${tMax.toFixed(0)} 秒）`), w / 2, h - 4);
}

/** The wellness-only line under every health figure: this report, the trip report and the health desk. */
export function wellnessDisclaimer() {
  return t('Wellness insights only, from camera-based Presage SmartSpectra estimates. Not a medical device and not medical advice. Never practice breath holds in or near water, and stop if you feel dizzy or light-headed.', '仅为健康参考，基于摄像头的 Presage SmartSpectra 估算。不是医疗设备，也不构成医疗建议。切勿在水中或水边练习屏息，感到头晕或眩晕时请立即停止。');
}

export class Report {
  private panel = $('report');

  /** `deleted`: after the player deleted their health data here (the trips go with it). */
  constructor(private log: HealthLog, private deleted: () => void = () => {}) {
    onLangChange(() => {
      if (this.open) this.render();
    });
  }

  get open() {
    return !this.panel.classList.contains('hidden');
  }

  toggle(show = !this.open) {
    this.panel.classList.toggle('hidden', !show);
    if (show) this.render();
  }

  private render() {
    const dives = this.log.dives;
    const when = new Date().toLocaleString(lang() === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' });
    const head = `
      <div class="report-head">
        <div>
          <h2>${t('Breath &amp; Heart Report', '呼吸与心率报告')}</h2>
          <div class="small muted">${t('Generated', '生成于')} ${when} · ${t('stored only on this device', '仅存储在本设备')}</div>
        </div>
        <div class="report-actions">
          <button id="report-print" class="mini">${t('Save PDF', '保存 PDF')}</button>
          <button id="report-close" class="mini">${t('Close (H)', '关闭 (H)')}</button>
        </div>
      </div>`;
    if (!dives.length) {
      this.panel.innerHTML = `${head}<p class="report-empty">${t('No dives recorded yet. Hold your breath, dive, and come back.', '还没有下潜记录。屏住呼吸，潜一次，再回来看看。')}</p>${
        hasHealthData() ? `<button id="report-delete" class="link small">${t('Delete my health data', '删除我的健康数据')}</button>` : ''
      }`;
      this.wire();
      return;
    }
    const s = compute(dives);
    const tile = (label: string, value: string, sub = '', color = '') =>
      `<div class="tile"><div class="small muted">${label}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${value}</div><div class="small sub">${sub}</div></div>`;
    const trend =
      s.earlierAvg != null ? `${s.recentAvg >= s.earlierAvg ? '▲' : '▼'} ${t('from', '此前')} ${sec(s.earlierAvg)}` : t('last 10 dives', '最近 10 次下潜');
    const longest = s.vitals.length ? s.vitals.reduce((a, d) => (d.holdMs > a.holdMs ? d : a)) : null;
    this.panel.innerHTML = `${head}
      <div class="small muted basis">${t(`Based on ${s.n} dive${s.n > 1 ? 's' : ''}${s.vitals.length ? `, ${s.vitals.length} with heart-rate data` : ''}${s.sharkDives ? `; ${s.sharkDives} with sharks, not used for heart rate` : ''}.`, `基于 ${s.n} 次下潜${s.vitals.length ? `，其中 ${s.vitals.length} 次有心率数据` : ''}${s.sharkDives ? `；${s.sharkDives} 次有鲨鱼，不计入心率` : ''}。`)}</div>
      <div class="tiles">
        ${tile(t('Longest breath hold', '最长屏息'), sec(s.best.holdMs), new Date(s.best.at).toLocaleDateString(), C.hold)}
        ${tile(t('Average hold', '平均屏息'), sec(s.recentAvg), trend)}
        ${tile(t('Resting heart rate', '静息心率'), s.restPulse != null ? `${s.restPulse.toFixed(0)} bpm` : '—', t('before dives', '下潜前'))}
        ${tile(t('Dive reflex', '潜水反射'), s.reflexDrop != null ? `${s.reflexDrop >= 0 ? '−' : '+'}${Math.abs(s.reflexDrop).toFixed(0)} bpm` : '—', s.reflexPct != null ? `${Math.abs(s.reflexPct).toFixed(0)}% ${s.reflexDrop! >= 0 ? t('slower', '更慢') : t('faster', '更快')} ${t('while holding', '屏息时')}` : t('needs camera', '需要摄像头'), C.danger)}
        ${tile(t('Recovery', '恢复'), s.recovery != null ? `${s.recovery.toFixed(0)} s` : '—', t('heart back to rest', '心率恢复静息'))}
        ${tile(t('Breathing rate', '呼吸频率'), s.restRate != null ? `${s.restRate.toFixed(0)} /min` : '—', t('at rest', '静息时'))}
        ${tile(t('Time on one breath', '单口气总时长'), sec(s.totalUnderMs), t('all dives', '全部下潜'))}
        ${tile(t('Deepest dive', '最深下潜'), `${s.deepest} m`, t(`${s.fish} fish banked`, `已存入 ${s.fish} 条鱼`))}
      </div>
      <section class="chart">
        <div class="row small"><b>${t('Breath hold per dive', '每次下潜的屏息时间')}</b><span class="legend"><i style="--c:${C.hold}"></i>${t('banked', '已存入')} <i style="--c:${C.breathe}"></i>${t('surfaced', '已上浮')} <i style="--c:${C.danger}"></i>${t('blackout', '昏厥')}</span></div>
        <canvas id="chart-holds"></canvas>
      </section>
      ${
        longest
          ? `<section class="chart">
        <div class="row small"><b>${t('Heart rate during your longest dive', '最长一次下潜中的心率')}</b><span class="muted">${sec(longest.holdMs)} ${t('hold', '屏息')} · ${longest.maxDepth} m</span></div>
        <canvas id="chart-pulse"></canvas>
      </section>`
          : ''
      }
      <section class="insights"><b class="small">${t('What this means', '这意味着什么')}</b><ul>${insights(s)
        .map((line) => `<li>${line}</li>`)
        .join('')}</ul></section>
      <p class="disclaimer small">${wellnessDisclaimer()}</p>
      <button id="report-delete" class="link small">${t('Delete my health data', '删除我的健康数据')}</button>`;
    this.wire();
    drawHolds($('chart-holds') as HTMLCanvasElement, dives, s.best.holdMs);
    if (longest) drawPulse($('chart-pulse') as HTMLCanvasElement, longest);
  }

  private wire() {
    $('report-close').addEventListener('click', () => this.toggle(false));
    $('report-print').addEventListener('click', () => window.print());
    document.getElementById('report-delete')?.addEventListener('click', () => {
      if (!confirm(t('Delete all recorded dives and vitals from this device?', '删除本设备上所有已记录的下潜和体征数据？'))) return;
      this.log.clear();
      this.deleted();
      this.render();
    });
  }
}

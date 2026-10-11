import type { BreathState } from './breath';
import { fishValue, RARITY, RARITY_ORDER, type FishSpec, type Rarity } from './fish';
import type { DiveRecord } from './health';
import { t } from './i18n';
import { MAPS, type MapId } from './maps';
import { compute, wellnessDisclaimer } from './report';
import { storageKey } from './wallet';

// A trip: from the first dive off the title until you're back at the main menu.
// Climbing aboard, changing maps and diving again all count toward the same trip.
// While it runs it samples heart and breathing rate once a second and notes every
// fish caught; at the end it scores the trip, works out the health figures from
// its dives (report.ts), keeps the record (the health desk shows them), and shows
// the trip report.

const SAMPLE_MS = 1000;
const MAX_SAMPLES = 3600; // an hour at one a second
const SPARK_POINTS = 120; // a saved record keeps this many per trace
const HISTORY = 30;
const STORE = 'trips';

export interface TripFish {
  name: string;
  rarity: Rarity;
  value: number;
  map?: string;
}

export interface TripRecord {
  at: number; // epoch ms the trip started
  endAt: number;
  maps: MapId[];
  caught: TripFish[];
  banked: number;
  dives: number;
  deepest: number;
  longestHoldMs: number;
  avgHoldMs: number;
  blackouts: number;
  /** From the sensor's samples over the whole trip; null with no sensor (keyboard / simulator). */
  heart: { avg: number; min: number; peak: number } | null;
  breathRate: number | null;
  /** From the trip's dives (report.ts): resting pulse before a dive, its drop, the recovery. */
  restPulse: number | null;
  reflexPct: number | null;
  recoveryS: number | null;
  score: { total: number; fish: number; hold: number; depth: number; penalty: number };
  grade: string;
  pulse: number[]; // bpm, evenly spaced over the trip (≤ SPARK_POINTS)
  breath: number[]; // br/min, likewise
}

/** Even-spaced picks from a series, at most n of them. */
function thin(xs: number[], n: number): number[] {
  if (xs.length <= n) return xs.map((x) => Math.round(x));
  return Array.from({ length: n }, (_, i) => Math.round(xs[Math.floor((i * (xs.length - 1)) / (n - 1))]));
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function gradeFor(score: number) {
  return score >= 600 ? 'S' : score >= 300 ? 'A' : score >= 120 ? 'B' : score >= 40 ? 'C' : 'D';
}

export class Trip {
  private startAt = 0;
  private maps: MapId[] = [];
  private caught: TripFish[] = [];
  private banked = 0;
  private pulse: number[] = [];
  private breath: number[] = [];
  private lastSample = 0;
  active = false;

  /** Drop the trip under way, samples and all (the player deleted their health data). */
  reset() {
    this.active = false;
    this.startAt = 0;
    this.maps = [];
    this.caught = [];
    this.banked = 0;
    this.pulse = [];
    this.breath = [];
    this.lastSample = 0;
  }

  /** The first dive of a trip (later dives in the same trip just carry on). */
  start(map: MapId) {
    if (this.active) return this.visit(map);
    this.active = true;
    this.startAt = Date.now();
    this.maps = [map];
    this.caught = [];
    this.banked = 0;
    this.pulse = [];
    this.breath = [];
    this.lastSample = 0;
  }

  visit(map: MapId) {
    if (this.active && !this.maps.includes(map)) this.maps.push(map);
  }

  catch(f: FishSpec) {
    if (this.active) this.caught.push({ name: f.name, rarity: f.rarity, value: fishValue(f), map: f.map });
  }

  bank(n: number) {
    if (this.active) this.banked += n;
  }

  /** Once a second: the sensor's heart and breathing rate, when it has them. */
  sample(s: BreathState) {
    const now = performance.now();
    if (!this.active || now - this.lastSample < SAMPLE_MS) return;
    this.lastSample = now;
    if (s.pulse != null && this.pulse.length < MAX_SAMPLES) this.pulse.push(s.pulse);
    if (s.rate != null && this.breath.length < MAX_SAMPLES) this.breath.push(s.rate);
  }

  /** Ends the trip: the record of it (null if nothing happened: no dive was logged). */
  end(allDives: readonly DiveRecord[]): TripRecord | null {
    if (!this.active) return null;
    this.active = false;
    const dives = allDives.filter((d) => d.at >= this.startAt);
    if (!dives.length && !this.caught.length) return null;
    const stats = dives.length ? compute(dives) : null;
    const longestHoldMs = stats?.best.holdMs ?? 0;
    const deepest = stats?.deepest ?? 0;
    const blackouts = stats?.blackouts ?? 0;
    const fishPts = this.caught.reduce((a, f) => a + f.value, 0);
    const holdPts = Math.round((longestHoldMs / 1000) * 2);
    const depthPts = Math.round(deepest);
    const penalty = blackouts * 20;
    const total = Math.max(0, fishPts + holdPts + depthPts - penalty);
    const record: TripRecord = {
      at: this.startAt,
      endAt: Date.now(),
      maps: this.maps,
      caught: this.caught,
      banked: this.banked,
      dives: dives.length,
      deepest,
      longestHoldMs,
      avgHoldMs: avg(dives.map((d) => d.holdMs)) ?? 0,
      blackouts,
      heart: this.pulse.length ? { avg: avg(this.pulse)!, min: Math.min(...this.pulse), peak: Math.max(...this.pulse) } : null,
      breathRate: avg(this.breath),
      restPulse: stats?.restPulse ?? null,
      reflexPct: stats?.reflexPct ?? null,
      recoveryS: stats?.recovery ?? null,
      score: { total, fish: fishPts, hold: holdPts, depth: depthPts, penalty },
      grade: gradeFor(total),
      pulse: thin(this.pulse, SPARK_POINTS),
      breath: thin(this.breath, SPARK_POINTS),
    };
    saveTrip(record);
    return record;
  }
}

// ---- History ----------------------------------------------------------------

function key() {
  try {
    return storageKey(STORE); // per wallet when one is connected
  } catch {
    return `deepbreath.${STORE}`;
  }
}

/** Past trips, newest first. */
export function loadTrips(): TripRecord[] {
  try {
    const xs = JSON.parse(localStorage.getItem(key()) ?? '[]');
    return Array.isArray(xs) ? xs : [];
  } catch {
    return [];
  }
}

/**
 * Delete every saved trip (they hold heart and breathing traces): this wallet's, and the
 * unscoped fallback written while no wallet was connected.
 */
export function clearTrips() {
  const keys = new Set([`deepbreath.${STORE}`, key()]);
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {}
  }
}

function saveTrip(r: TripRecord) {
  try {
    localStorage.setItem(key(), JSON.stringify([r, ...loadTrips()].slice(0, HISTORY)));
  } catch {}
}

// ---- Words for a record (the report, and the health desk's sheets) ----------

export function tripDate(r: TripRecord) {
  const d = new Date(r.at);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function mapNames(r: TripRecord) {
  return r.maps.map((m) => (m in MAPS ? MAPS[m].name : m)).join(' · ');
}

/** Rarity → how many, rarest first (only the ones caught). */
export function rarityCounts(r: TripRecord): [Rarity, number][] {
  return [...RARITY_ORDER]
    .reverse()
    .map((k): [Rarity, number] => [k, r.caught.filter((f) => f.rarity === k).length])
    .filter(([, n]) => n > 0);
}

/** The health lines, label → value ("—" when there's no reading). */
export function healthLines(r: TripRecord): [string, string][] {
  const n = (v: number | null, unit: string, d = 0) => (v == null ? '—' : `${v.toFixed(d)} ${unit}`);
  return [
    [t('Average heart rate', '平均心率'), r.heart ? `${Math.round(r.heart.avg)} bpm` : '—'],
    [t('Heart rate range', '心率范围'), r.heart ? `${Math.round(r.heart.min)}–${Math.round(r.heart.peak)} bpm` : '—'],
    [t('Breathing rate', '呼吸频率'), n(r.breathRate, 'br/min')],
    [t('Resting pulse', '静息心率'), n(r.restPulse, 'bpm')],
    [t('Dive reflex', '潜水反射'), r.reflexPct == null ? '—' : `−${r.reflexPct.toFixed(0)}%`],
    [t('Recovery', '恢复时间'), n(r.recoveryS, 's')],
    [t('Longest hold', '最长屏息'), secs(r.longestHoldMs)],
    [t('Average hold', '平均屏息'), secs(r.avgHoldMs)],
  ];
}

/** A line chart of heart rate (red) and breathing rate (blue) over the trip. */
export function drawTraces(c: CanvasRenderingContext2D, r: TripRecord, x: number, y: number, w: number, h: number) {
  const line = (xs: number[], color: string) => {
    if (xs.length < 2) return;
    const lo = Math.min(...xs) - 2;
    const hi = Math.max(...xs) + 2;
    c.strokeStyle = color;
    c.lineWidth = Math.max(2, h / 40);
    c.beginPath();
    xs.forEach((v, i) => {
      const px = x + (i / (xs.length - 1)) * w;
      const py = y + h - ((v - lo) / (hi - lo)) * h;
      if (i) c.lineTo(px, py);
      else c.moveTo(px, py);
    });
    c.stroke();
  };
  line(r.pulse, '#e8505b');
  line(r.breath, '#4a9be0');
}

// ---- The report as a sheet of paper ------------------------------------------

/** The grade stamp's ink. */
export const GRADE_COLOR: Record<string, string> = { S: '#d0359f', A: '#c8901c', B: '#2a9d6a', C: '#3a7fc0', D: '#8a8a8a' };

/**
 * The trip report drawn as a sheet of cream paper (W×H canvas pixels): the health
 * desk's sheet on the table, and the report at the end of a trip. null: no trips yet.
 */
export function drawTripSheet(c: CanvasRenderingContext2D, r: TripRecord | null, W: number, H: number) {
  drawSheet(c, r, W, H);
  // Along the foot of the sheet, under the traces: wellness only, not medical advice (as in report.ts).
  c.save();
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = 'rgba(58, 34, 16, 0.6)';
  // Two lines at most between the traces and the border: a smaller font rather than a cut-off line.
  let px = Math.round(H * 0.018);
  let lines: string[];
  for (;;) {
    c.font = `500 ${px}px Inter, system-ui, sans-serif`;
    lines = wrapText(c, wellnessDisclaimer(), W - 140);
    if (lines.length <= 2 || px <= 10) break;
    px--;
  }
  const step = Math.round(px * 1.25);
  lines.forEach((l, i) => c.fillText(l, 70, H - 34 - (lines.length - 1 - i) * step));
  c.restore();
}

/** Break `text` into lines no wider than `max`: at spaces, or between CJK characters. */
function wrapText(c: CanvasRenderingContext2D, text: string, max: number): string[] {
  const parts = text.match(/[^\s\u3000-\u9fff\uff00-\uffef]+\s*|[\u3000-\u9fff\uff00-\uffef]\s*|\s+/g) ?? [];
  const lines: string[] = [];
  let line = '';
  for (const p of parts) {
    if (line && c.measureText(line + p).width > max) {
      lines.push(line.trimEnd());
      line = p.trimStart();
    } else line += p;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

function drawSheet(c: CanvasRenderingContext2D, r: TripRecord | null, W: number, H: number) {
  // Cream paper, a ruled border.
  c.fillStyle = '#f3ead6';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(90, 60, 30, 0.35)';
  c.lineWidth = 4;
  c.strokeRect(24, 24, W - 48, H - 48);
  const ink = '#3a2210';
  const soft = 'rgba(58, 34, 16, 0.55)';
  c.textBaseline = 'alphabetic';
  if (!r) {
    c.fillStyle = ink;
    c.font = '800 64px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(t('No trips yet', '还没有记录'), W / 2, H / 2 - 20);
    c.font = '500 36px Inter, system-ui, sans-serif';
    c.fillStyle = soft;
    c.fillText(t('Dive, then come back to the main menu: the trip report lands here.', '下潜一趟再回到主菜单，本次报告会放在这里。'), W / 2, H / 2 + 50);

    return;
  }
  c.textAlign = 'left';
  const L = 70;
  c.fillStyle = soft;
  c.font = '700 30px Inter, system-ui, sans-serif';
  c.fillText(`${t('TRIP REPORT', '本次报告')} · ${tripDate(r)}`, L, 92);
  c.fillStyle = ink;
  c.font = '900 64px Inter, system-ui, sans-serif';
  c.fillText(mapNames(r), L, 160);
  // The grade, stamped in the corner.
  c.save();
  c.translate(W - 180, 130);
  c.rotate(-0.12);
  c.strokeStyle = GRADE_COLOR[r.grade];
  c.fillStyle = GRADE_COLOR[r.grade];
  c.lineWidth = 8;
  c.beginPath();
  c.arc(0, 0, 78, 0, Math.PI * 2);
  c.stroke();
  c.font = '900 92px Inter, system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(r.grade, 0, 4);
  c.restore();
  c.textAlign = 'right';
  c.fillStyle = ink;
  c.font = '800 44px Inter, system-ui, sans-serif';
  c.fillText(`${r.score.total} pts`, W - 290, 150);

  // Left column: the catch and the dives. Right column: health.
  const line = (x: number, y: number, w: number, k: string, v: string) => {
    c.textAlign = 'left';
    c.fillStyle = soft;
    c.font = '600 30px Inter, system-ui, sans-serif';
    c.fillText(k, x, y);
    c.textAlign = 'right';
    c.fillStyle = ink;
    c.font = '800 32px Inter, system-ui, sans-serif';
    c.fillText(v, x + w, y);
    c.strokeStyle = 'rgba(90, 60, 30, 0.15)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, y + 12);
    c.lineTo(x + w, y + 12);
    c.stroke();
  };
  const head = (x: number, y: number, text: string) => {
    c.textAlign = 'left';
    c.fillStyle = '#8a5a2a';
    c.font = '800 28px Inter, system-ui, sans-serif';
    c.fillText(text, x, y);
  };
  const colW = 560;
  let y = 240;
  head(L, y, t('CATCH', '渔获'));
  y += 50;
  line(L, y, colW, t('Caught', '捕获'), String(r.caught.length));
  y += 48;
  line(L, y, colW, t('Banked', '入库'), String(r.banked));
  y += 48;
  const counts = rarityCounts(r);
  c.font = '700 26px Inter, system-ui, sans-serif';
  let cx = L;
  for (const [k, n] of counts) {
    const text = `${RARITY[k].label} ×${n}`;
    const w = c.measureText(text).width + 30;
    c.strokeStyle = RARITY[k].color;
    c.fillStyle = RARITY[k].color;
    c.lineWidth = 3;
    c.beginPath();
    c.roundRect(cx, y - 30, w, 42, 21);
    c.stroke();
    c.textAlign = 'left';
    c.fillText(text, cx + 15, y);
    cx += w + 12;
  }
  y += 64;
  head(L, y, t('DIVES', '下潜'));
  y += 50;
  line(L, y, colW, t('Dives', '次数'), String(r.dives));
  y += 48;
  line(L, y, colW, t('Deepest', '最深'), `${Math.round(r.deepest)} m`);
  y += 48;
  line(L, y, colW, t('Longest hold', '最长屏息'), secs(r.longestHoldMs));
  y += 48;
  line(L, y, colW, t('Blackouts', '昏厥'), String(r.blackouts));

  const R = L + colW + 90;
  const rw = W - R - 70;
  let ry = 240;
  head(R, ry, t('HEALTH', '健康指标'));
  ry += 50;
  for (const [k, v] of healthLines(r).slice(0, 6)) {
    line(R, ry, rw, k, v);
    ry += 48;
  }
  // Heart (red) and breathing (blue) over the trip.
  const gy = ry + 10;
  c.fillStyle = 'rgba(90, 60, 30, 0.06)';
  c.fillRect(R, gy, rw, H - gy - 84);
  if (r.pulse.length > 1 || r.breath.length > 1) drawTraces(c, r, R + 8, gy + 10, rw - 16, H - gy - 104);
  else {
    c.textAlign = 'center';
    c.fillStyle = soft;
    c.font = '600 26px Inter, system-ui, sans-serif';
    c.fillText(t('No sensor this trip', '无传感器数据'), R + rw / 2, gy + (H - gy - 84) / 2);
  }
}

// ---- The report -------------------------------------------------------------

const SHEET_W = 1400;
const SHEET_H = 985; // the health desk's sheet's proportions

/**
 * The trip report over the title, between the trip and the main menu: the same
 * sheet of paper as on the health desk, dropped in at a slight tilt. Put away, it
 * shrinks and flies into the HEALTH fish on the rope (where the reports are kept),
 * which bobs as it swallows it.
 */
export class TripReport {
  private root: HTMLElement;
  private sheet: HTMLCanvasElement;
  private done: (() => void) | null = null;
  private closing = false;
  /** Where the report goes: the HEALTH fish's middle on screen (null: it just fades), and its gulp. */
  target: () => { x: number; y: number } | null = () => null;
  swallowed: () => void = () => {};

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'trip-report';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="trip-paper">
        <canvas width="${SHEET_W}" height="${SHEET_H}"></canvas>
        <button class="primary" id="trip-done">Keep it · 收起报告</button>
      </div>
      <div class="table-hint small">Click anywhere or press Esc to put it away</div>`;
    this.sheet = this.root.querySelector('canvas')!;
    document.body.append(this.root);
    this.root.addEventListener('click', () => this.close());
  }

  get open() {
    return !this.root.classList.contains('hidden') && !this.closing;
  }

  show(r: TripRecord, done?: () => void) {
    this.done = done ?? null;
    this.closing = false;
    drawTripSheet(this.sheet.getContext('2d')!, r, SHEET_W, SHEET_H);
    const paper = this.root.querySelector<HTMLElement>('.trip-paper')!;
    paper.getAnimations().forEach((a) => a.cancel());
    this.root.classList.remove('hidden', 'leaving');
    paper.animate(
      [
        { transform: 'translateY(-60vh) rotate(-9deg)', opacity: 0 },
        { transform: 'translateY(2vh) rotate(1.5deg)', opacity: 1, offset: 0.75 },
        { transform: 'translateY(0) rotate(-1.2deg)' },
      ],
      { duration: 650, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)', fill: 'forwards' },
    );
    this.root.querySelector<HTMLButtonElement>('#trip-done')!.focus();
  }

  /** Put away: it rolls up small and flies into the HEALTH fish. */
  close() {
    if (!this.open) return;
    this.closing = true;
    const paper = this.root.querySelector<HTMLElement>('.trip-paper')!;
    const box = paper.getBoundingClientRect();
    const to = this.target();
    const dx = to ? to.x - (box.left + box.width / 2) : 0;
    const dy = to ? to.y - (box.top + box.height / 2) : -window.innerHeight * 0.6;
    this.root.classList.add('leaving'); // the backdrop clears
    const fly = paper.animate(
      [
        { transform: 'translate(0, 0) rotate(-1.2deg) scale(1)', opacity: 1 },
        { transform: `translate(0, -2vh) rotate(-1.2deg) scale(0.92, 0.5)`, opacity: 1, offset: 0.25 }, // rolls up
        { transform: `translate(${dx}px, ${dy}px) rotate(150deg) scale(0.04)`, opacity: 0.9 },
      ],
      { duration: 750, easing: 'cubic-bezier(0.45, 0, 0.4, 1)', fill: 'forwards' },
    );
    fly.onfinish = () => {
      this.root.classList.add('hidden');
      this.closing = false;
      if (to) this.swallowed();
      const done = this.done;
      this.done = null;
      done?.();
    };
  }
}

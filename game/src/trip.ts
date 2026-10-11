import type { BreathState } from './breath';
import { fishValue, RARITY, RARITY_ORDER, type FishSpec, type Rarity } from './fish';
import type { DiveRecord } from './health';
import { MAPS, type MapId } from './maps';
import { compute } from './report';
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
    ['Average heart rate · 平均心率', r.heart ? `${Math.round(r.heart.avg)} bpm` : '—'],
    ['Heart rate range · 心率范围', r.heart ? `${Math.round(r.heart.min)}–${Math.round(r.heart.peak)} bpm` : '—'],
    ['Breathing rate · 呼吸频率', n(r.breathRate, 'br/min')],
    ['Resting pulse · 静息心率', n(r.restPulse, 'bpm')],
    ['Dive reflex · 潜水反射', r.reflexPct == null ? '—' : `−${r.reflexPct.toFixed(0)}%`],
    ['Recovery · 恢复时间', n(r.recoveryS, 's')],
    ['Longest hold · 最长屏息', secs(r.longestHoldMs)],
    ['Average hold · 平均屏息', secs(r.avgHoldMs)],
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

// ---- The report -------------------------------------------------------------

/** The trip report over the title, between the trip and the main menu. */
export class TripReport {
  private root: HTMLElement;
  private done: (() => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'trip-report';
    this.root.className = 'hidden';
    document.body.append(this.root);
  }

  get open() {
    return !this.root.classList.contains('hidden');
  }

  show(r: TripRecord, done?: () => void) {
    this.done = done ?? null;
    const counts = rarityCounts(r);
    const mins = Math.max(1, Math.round((r.endAt - r.at) / 60000));
    this.root.innerHTML = `
      <div class="card">
        <div class="trip-head">
          <div>
            <div class="small muted">TRIP REPORT · 本次报告 · ${tripDate(r)} · ${mins} min</div>
            <h2>${mapNames(r)}</h2>
          </div>
          <div class="trip-score">
            <div class="trip-grade grade-${r.grade}">${r.grade}</div>
            <div><b>${r.score.total}</b><span class="small muted"> pts</span></div>
          </div>
        </div>
        <div class="trip-cols">
          <section>
            <h3>Score · 评分</h3>
            <div class="trip-line"><span>Fish · 渔获</span><b>+${r.score.fish}</b></div>
            <div class="trip-line"><span>Longest hold · 屏息</span><b>+${r.score.hold}</b></div>
            <div class="trip-line"><span>Deepest · 深度</span><b>+${r.score.depth}</b></div>
            ${r.score.penalty ? `<div class="trip-line"><span>Blackouts · 昏厥</span><b class="bad">−${r.score.penalty}</b></div>` : ''}
            <h3>Catch · 渔获统计</h3>
            <div class="trip-line"><span>Caught · 捕获</span><b>${r.caught.length}</b></div>
            <div class="trip-line"><span>Banked · 入库</span><b>${r.banked}</b></div>
            <div class="trip-rarity">${counts.map(([k, n]) => `<span style="border-color:${RARITY[k].color};color:${RARITY[k].color}">${RARITY[k].label} ×${n}</span>`).join('') || '<span class="muted">No fish this trip</span>'}</div>
            <h3>Dives · 下潜</h3>
            <div class="trip-line"><span>Dives · 次数</span><b>${r.dives}</b></div>
            <div class="trip-line"><span>Deepest · 最深</span><b>${Math.round(r.deepest)} m</b></div>
            <div class="trip-line"><span>Blackouts · 昏厥</span><b>${r.blackouts}</b></div>
          </section>
          <section>
            <h3>Health · 健康指标</h3>
            ${healthLines(r).map(([k, v]) => `<div class="trip-line"><span>${k}</span><b>${v}</b></div>`).join('')}
            <canvas class="trip-traces" width="640" height="160"></canvas>
            <div class="small muted">${r.heart || r.breathRate ? '<span style="color:#e8505b">━</span> heart rate · <span style="color:#4a9be0">━</span> breathing rate' : 'No sensor this trip (keyboard): heart and breathing figures need the camera.'}</div>
          </section>
        </div>
        <div class="trip-foot"><button class="primary" id="trip-done">Main menu · 返回主菜单</button></div>
      </div>`;
    const canvas = this.root.querySelector<HTMLCanvasElement>('.trip-traces')!;
    drawTraces(canvas.getContext('2d')!, r, 4, 8, canvas.width - 8, canvas.height - 16);
    this.root.querySelector('#trip-done')!.addEventListener('click', () => this.close());
    this.root.classList.remove('hidden');
    this.root.querySelector<HTMLButtonElement>('#trip-done')!.focus();
  }

  close() {
    if (!this.open) return;
    this.root.classList.add('hidden');
    const done = this.done;
    this.done = null;
    done?.();
  }
}

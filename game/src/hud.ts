import type { BreathState } from './breath';
import { FishSpec, RARITY, fishValue } from './fish';
import { fishIcon } from './portrait';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SOURCE_LABEL = {
  presage: 'Presage · live camera',
  sim: 'Simulator · hold Shift',
  keyboard: 'Keyboard · hold Shift',
};

// ---- depth gauge: the sea has no bottom, so the bar uses a compressive scale ----
/** Depth (m) that lands at the middle of the bar. */
const DEPTH_HALF_M = 60;
/** Bar position (fraction from the top) for a depth in metres: 0 m → 0, 60 m → 0.5, 540 m → 0.9, ∞ → 1. */
const depthPos = (d: number) => (Number.isFinite(d) ? Math.max(0, d) / (Math.max(0, d) + DEPTH_HALF_M) : 1);

/** Band tint for each open zone, counted down from the surface (see setZones). */
const ZONE_TINT = ['', 'reef', 'abyss'];
const DEPTH_TICKS = [0, 20, 60, 100, 200, 500];
/** Only mark a "best" depth once the player has actually dived. */
const BEST_MIN_M = 5;
/** Hide the "best" text when it would sit on top of the current-depth label (fraction of bar). */
const BEST_LABEL_GAP = 0.04;

export class Hud {
  private chip = $('breath-chip');
  private holdTime = $('hold-time');
  private trace = $<HTMLCanvasElement>('trace');
  private traceCtx = this.trace.getContext('2d')!;
  private source = $('source');
  private vitals = $('vitals');
  private hint = $('hint');
  private camWrap = $('cam-wrap');
  private depthGauge = $('depth');
  private depthMarker = $('depth-marker');
  private depthLabel = $('depth-label');
  private depthBest = $('depth-best');
  private depthBestLabel = $('depth-best-label');
  /** Deepest depth passed to setDepth since page load (no persistence). */
  private bestDepth = 0;
  private emergency = $('emergency');
  private emergencyFill = $('emergency-fill');
  private centerMsg = $('center-msg');
  private netSlots = $('net-slots');
  private bankCount = $('bank-count');
  private bankValue = $('bank-value');
  private toasts = $('toasts');
  private msgTimer = 0;

  constructor() {
    this.buildDepthTicks();
  }

  /** Tick marks (right of the bar), placed with the same scale as the marker. */
  private buildDepthTicks() {
    const frag = document.createDocumentFragment();
    for (const m of DEPTH_TICKS) {
      const el = document.createElement('div');
      el.className = 'tick';
      el.textContent = String(m);
      el.style.top = `${(depthPos(m) * 100).toFixed(2)}%`;
      frag.appendChild(el);
    }
    // Before the markers, so the best tick and the current marker draw on top.
    this.depthGauge.insertBefore(frag, this.depthBest);
  }

  /**
   * Rebuild the zone bands (left of the bar) for a map: one per open zone with
   * the map's labels, then the bottomless trench from the shelf down. The bar is
   * tinted with the map's water, each colour at its depth on the same scale.
   */
  setZones(
    zones: { label: string; top: number; bottom: number }[],
    shelfM: number,
    water: readonly (readonly [number, string])[],
  ) {
    const gauge = this.depthGauge;
    gauge.querySelectorAll('.zone').forEach((el) => el.remove());
    const stops = water.map(([d, c]) => `${c} ${(depthPos(d) * 100).toFixed(1)}%`);
    gauge.style.background = `linear-gradient(${[...stops, '#000408'].join(', ')})`;
    const bands = [
      ...zones.map((z, i) => ({ ...z, cls: ZONE_TINT[i] ?? '' })),
      { label: 'Trench', top: shelfM, bottom: Infinity, cls: 'trench' },
    ];
    const frag = document.createDocumentFragment();
    for (const b of bands) {
      const top = depthPos(b.top);
      const el = document.createElement('div');
      el.className = `zone ${b.cls}`.trim();
      el.textContent = b.label;
      el.style.setProperty('--top', `${(top * 100).toFixed(2)}%`);
      el.style.setProperty('--h', `${((depthPos(b.bottom) - top) * 100).toFixed(2)}%`);
      frag.appendChild(el);
    }
    gauge.insertBefore(frag, this.depthBest);
  }

  show() {
    $('hud').classList.remove('hidden');
  }

  hide() {
    $('hud').classList.add('hidden');
  }

  setBreath(s: BreathState, danger: boolean) {
    const holding = s.holding;
    this.chip.textContent = danger ? 'OUT OF AIR' : holding ? 'HOLDING' : 'BREATHING';
    this.chip.className = `chip ${danger ? 'danger' : holding ? 'holding' : 'breathing'}`;
    this.holdTime.textContent = `${(s.holdMs / 1000).toFixed(1)}s`;
    this.camWrap.className = danger ? 'danger' : holding ? 'holding' : '';
    this.source.textContent =
      s.mode === 'presage' && !s.connected
        ? 'Presage · sensor offline'
        : s.label
          ? 'Presage · ⏺ marking your hold'
          : SOURCE_LABEL[s.mode];
    const parts = [];
    if (s.rate != null && s.mode === 'presage') parts.push(`${Math.round(s.rate)} br/min`);
    if (s.pulse != null && s.mode === 'presage') parts.push(`♥ ${Math.round(s.pulse)}`);
    this.vitals.textContent = parts.join(' · ');
    this.hint.textContent = s.mode === 'presage' ? s.hint || (s.calibrated ? '' : 'Calibrating: breathe normally') : '';
    this.drawTrace(s.trace, holding, danger);
  }

  private drawTrace(trace: number[], holding: boolean, danger: boolean) {
    const ctx = this.traceCtx;
    const { width: w, height: h } = this.trace;
    ctx.clearRect(0, 0, w, h);
    if (trace.length < 2) return;
    let lo = Math.min(...trace);
    let hi = Math.max(...trace);
    if (hi - lo < 1e-6) {
      lo -= 1;
      hi += 1;
    }
    ctx.lineWidth = 4;
    ctx.strokeStyle = danger ? '#ff4d5e' : holding ? '#3ef0a8' : '#6ab8ff';
    ctx.beginPath();
    trace.forEach((v, i) => {
      const x = (i / (trace.length - 1)) * w;
      const y = h - 8 - ((v - lo) / (hi - lo)) * (h - 16);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  setDepth(depth: number) {
    const d = Number.isFinite(depth) ? Math.max(0, depth) : 0;
    const pos = depthPos(d);
    this.depthMarker.style.top = `${pos * 100}%`;
    const label = `${d.toFixed(0)} m`;
    if (this.depthLabel.textContent !== label) this.depthLabel.textContent = label;

    if (d > this.bestDepth) {
      this.bestDepth = d;
      if (d >= BEST_MIN_M) {
        this.depthBest.classList.remove('hidden');
        this.depthBest.style.top = `${pos * 100}%`;
        const best = `best ${d.toFixed(0)} m`;
        if (this.depthBestLabel.textContent !== best) this.depthBestLabel.textContent = best;
      }
    }
    if (this.bestDepth >= BEST_MIN_M) {
      // While descending the best tick sits under the marker; only label it once the diver rises off it.
      this.depthBestLabel.classList.toggle('hidden', depthPos(this.bestDepth) - pos < BEST_LABEL_GAP);
    }
  }

  setEmergency(fraction: number | null) {
    this.emergency.classList.toggle('hidden', fraction == null);
    if (fraction != null) this.emergencyFill.style.width = `${Math.max(0, fraction) * 100}%`;
  }

  message(text: string, ms = 1800) {
    this.centerMsg.textContent = text;
    this.centerMsg.classList.add('show');
    clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.centerMsg.classList.remove('show'), ms);
  }

  setNet(net: FishSpec[], capacity: number) {
    this.netSlots.innerHTML = '';
    for (let i = 0; i < capacity; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const f = net[i];
      if (f) {
        slot.classList.add('filled');
        slot.style.borderColor = RARITY[f.rarity].color;
        const img = document.createElement('img');
        img.src = fishIcon(f);
        slot.appendChild(img);
      }
      this.netSlots.appendChild(slot);
    }
  }

  setBank(bank: FishSpec[]) {
    this.bankCount.textContent = `${bank.length} fish`;
    const best = bank.reduce<FishSpec | null>(
      (a, f) => (!a || fishValue(f) > fishValue(a) ? f : a),
      null,
    );
    this.bankValue.textContent = best
      ? `best: ${RARITY[best.rarity].label} ${best.species} · ${fishValue(best)} pts`
      : 'surface to bank your net';
  }

  toast(spec: FishSpec, title?: string) {
    const r = RARITY[spec.rarity];
    const el = document.createElement('div');
    const big = spec.rarity === 'legendary' || spec.rarity === 'mythic';
    el.className = `toast${big ? ' big' : ''}`;
    el.style.setProperty('--c', r.color);
    el.innerHTML = `<img alt=""><div><div class="r">${title ?? r.label.toUpperCase()}</div><div class="n"></div></div>`;
    el.querySelector('img')!.src = fishIcon(spec);
    el.querySelector('.n')!.textContent = `${spec.name} · ${spec.weightKg} kg · ${fishValue(spec)} pts`;
    this.toasts.prepend(el);
    setTimeout(() => el.remove(), 3100);
  }
}

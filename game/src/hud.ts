import type { BreathState } from './breath';
import { FishSpec, RARITY, fishValue } from './fish';
import { fishIcon } from './portrait';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SOURCE_LABEL = {
  presage: 'Presage · live camera',
  sim: 'Simulator · hold Shift',
  keyboard: 'Keyboard · hold Shift',
};

export class Hud {
  private chip = $('breath-chip');
  private holdTime = $('hold-time');
  private trace = $<HTMLCanvasElement>('trace');
  private traceCtx = this.trace.getContext('2d')!;
  private source = $('source');
  private vitals = $('vitals');
  private hint = $('hint');
  private camWrap = $('cam-wrap');
  private depthMarker = $('depth-marker');
  private depthLabel = $('depth-label');
  private emergency = $('emergency');
  private emergencyFill = $('emergency-fill');
  private centerMsg = $('center-msg');
  private netSlots = $('net-slots');
  private bankCount = $('bank-count');
  private bankValue = $('bank-value');
  private toasts = $('toasts');
  private msgTimer = 0;

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

  /** Rebuild the depth gauge for a map: one label per open zone, tinted with that map's water. */
  setZones(zones: { label: string; top: number; bottom: number }[], maxDepth: number, water: string[]) {
    const gauge = $('depth');
    gauge.querySelectorAll('.zone').forEach((el) => el.remove());
    gauge.style.background = `linear-gradient(${water.join(', ')})`;
    const tint = ['', 'reef', 'abyss'];
    zones.forEach((z, i) => {
      const el = document.createElement('div');
      el.className = `zone ${tint[i] ?? ''}`.trim();
      el.style.setProperty('--top', `${(z.top / maxDepth) * 100}%`);
      el.style.setProperty('--h', `${((z.bottom - z.top) / maxDepth) * 100}%`);
      el.textContent = z.label;
      gauge.insertBefore(el, this.depthMarker);
    });
  }

  setDepth(depth: number, maxDepth: number) {
    const d = Math.max(0, depth);
    this.depthMarker.style.top = `${Math.min(100, (d / maxDepth) * 100)}%`;
    this.depthLabel.textContent = `${d.toFixed(0)} m`;
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

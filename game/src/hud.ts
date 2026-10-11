import type { BreathState } from './breath';
import { FishSpec, RARITY, fishValue } from './fish';
import { formatSerial, isSerial, type Numbered } from './nft-uri';
import { fishIcon } from './portrait';
import { t, onLangChange } from './i18n';
import { totalPearls, type EquipmentSlot, type EquipmentState, type RodTier } from './equipment';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const sourceLabel = (mode: 'presage' | 'sim' | 'keyboard') =>
  ({
    presage: t('Presage · live camera', 'Presage · 实时摄像头'),
    sim: t('Simulator · hold Shift', '模拟器 · 按住 Shift'),
    keyboard: t('Keyboard · hold Shift', '键盘 · 按住 Shift'),
  })[mode];

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
  private alert = $('alert');
  private mash = $('mash');
  private mashArc = $('mash-arc');
  private shark = $('shark');
  private sharkLabel = $('shark-label');
  private sharkPulse = $('shark-pulse');
  private sharkFill = $('shark-fill');
  private emergencyFill = $('emergency-fill');
  private centerMsg = $('center-msg');
  private boardPrompt = $('board-prompt');
  private netSlots = $('net-slots');
  private bankCount = $('bank-count');
  private bankValue = $('bank-value');
  private gearSummary = $('gear-summary');
  private activeGear = $('active-gear');
  private activeNumber = $('active-gear-number');
  private activeGearLabel = $('active-gear-label');
  private activeGearHint = $('active-gear-hint');
  private toasts = $('toasts');
  private msgTimer = 0;

  // Last inputs, replayed when the language changes.
  private lastBreath: { s: BreathState; danger: boolean } | null = null;
  private lastZones: Parameters<Hud['setZones']> | null = null;
  private lastBank: FishSpec[] | null = null;
  private lastEquip: [EquipmentState, RodTier] | null = null;
  private lastGear: [EquipmentSlot, boolean] | null = null;
  private lastSharks: Parameters<Hud['setSharks']>[0] = null;
  private lastBest = 0;

  constructor() {
    this.buildDepthTicks();
    onLangChange(() => {
      if (this.lastBreath) this.setBreath(this.lastBreath.s, this.lastBreath.danger);
      if (this.lastZones) this.setZones(...this.lastZones);
      if (this.lastBank) this.setBank(this.lastBank);
      if (this.lastEquip) this.setEquipment(...this.lastEquip);
      if (this.lastGear) this.setActiveGear(...this.lastGear);
      if (this.lastSharks) this.setSharks(this.lastSharks);
      if (this.lastBest) this.depthBestLabel.textContent = t(`best ${this.lastBest} m`, `最深 ${this.lastBest} m`);
    });
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
    this.lastZones = [zones, shelfM, water];
    const gauge = this.depthGauge;
    gauge.querySelectorAll('.zone').forEach((el) => el.remove());
    const stops = water.map(([d, c]) => `${c} ${(depthPos(d) * 100).toFixed(1)}%`);
    gauge.style.background = `linear-gradient(${[...stops, '#000408'].join(', ')})`;
    const bands = [
      ...zones.map((z, i) => ({ ...z, cls: ZONE_TINT[i] ?? '' })),
      { label: t('Trench', '海沟'), top: shelfM, bottom: Infinity, cls: 'trench' },
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
    this.lastBreath = { s, danger };
    const holding = s.holding;
    this.chip.textContent = danger ? t('OUT OF AIR', '缺氧') : holding ? t('HOLDING', '屏息中') : t('BREATHING', '呼吸中');
    this.chip.className = `chip ${danger ? 'danger' : holding ? 'holding' : 'breathing'}`;
    this.holdTime.textContent = `${(s.holdMs / 1000).toFixed(1)}s`;
    this.camWrap.className = danger ? 'danger' : holding ? 'holding' : '';
    this.source.textContent =
      s.mode === 'presage' && !s.connected
        ? t('Presage · sensor offline', 'Presage · 传感器离线')
        : s.label
          ? t('Presage · ⏺ marking your hold', 'Presage · ⏺ 正在标记你的屏息')
          : sourceLabel(s.mode);
    const parts = [];
    if (s.rate != null && s.mode === 'presage') parts.push(`${Math.round(s.rate)} ${t('br/min', '次/分')}`);
    if (s.pulse != null && s.mode === 'presage') parts.push(`♥ ${Math.round(s.pulse)}`);
    this.vitals.textContent = parts.join(' · ');
    this.hint.textContent = s.mode === 'presage' ? s.hint || (s.calibrated ? '' : t('Calibrating: breathe normally', '校准中：请正常呼吸')) : s.error;
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
        this.lastBest = Math.round(d);
        const best = t(`best ${d.toFixed(0)} m`, `最深 ${d.toFixed(0)} m`);
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

  /** The "F: climb aboard" prompt, shown while floating beside the boat. */
  setBoardPrompt(show: boolean) {
    this.boardPrompt.classList.toggle('hidden', !show);
  }

  /** The key to mash, in the middle of the screen, with a ring `progress` (0..1) full. Null hides it. */
  setMash(progress: number | null) {
    this.mash.classList.toggle('hidden', progress == null);
    if (progress != null) this.mashArc.style.strokeDashoffset = `${326.73 * (1 - Math.min(1, Math.max(0, progress)))}`;
  }

  /** One press landed: the key punches. */
  punchMash() {
    this.mash.classList.remove('hit');
    // Reading the width restarts the animation when presses come faster than it runs.
    void this.mash.offsetWidth;
    this.mash.classList.add('hit');
  }

  /** A warning that stays up until cleared with null. `key` is the key to press, shown as a keycap. */
  setAlert(text: string | null, key?: string) {
    this.alert.classList.toggle('hidden', text == null);
    if (text == null) return;
    this.alert.textContent = text;
    if (key) {
      const cap = document.createElement('b');
      cap.textContent = key;
      this.alert.append(' ', cap);
    }
  }

  /**
   * Sharks are out: how many, the pulse they hunt by (`estimated` when no sensor measures it)
   * and how worked up they are, 0..1. Null hides it.
   */
  setSharks(state: { count: number; bpm: number; estimated: boolean; intensity: number } | null) {
    this.lastSharks = state;
    this.shark.classList.toggle('hidden', state == null);
    if (!state) return;
    this.sharkLabel.textContent =
      state.count > 1 ? t(`${state.count} SHARKS`, `${state.count} 条鲨鱼`) : state.count ? t('SHARK', '鲨鱼') : t('SHARK WATERS', '鲨鱼海域');
    this.sharkPulse.textContent = `♥ ${state.estimated ? '~' : ''}${Math.round(state.bpm)}`;
    this.sharkFill.style.width = `${Math.round(Math.max(0.04, state.intensity) * 100)}%`;
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
    this.lastBank = bank;
    this.bankCount.textContent = t(`${bank.length} fish`, `${bank.length} 条鱼`);
    const best = bank.reduce<FishSpec | null>(
      (a, f) => (!a || fishValue(f) > fishValue(a) ? f : a),
      null,
    );
    this.bankValue.textContent = best
      ? t(`best: ${RARITY[best.rarity].label} ${best.species} · ${fishValue(best)} pts`, `最佳：${RARITY[best.rarity].label} ${best.species} · ${fishValue(best)} 分`)
      : t('surface to bank your net', '浮出水面以存入渔获');
  }

  setEquipment(state: EquipmentState, tier: RodTier) {
    this.lastEquip = [state, tier];
    this.gearSummary.textContent = t(
      `NET Lv${tier.level} · Rod ${state.rodGearLevel} · Reel ${state.reelLevel} · Fins ${state.finsLevel} · Tank ${state.tankLevel} · Lamp ${state.lampLevel} · ${totalPearls(state)} ◇`,
      `渔网 Lv${tier.level} · 杆身 ${state.rodGearLevel} · 线轮 ${state.reelLevel} · 脚蹼 ${state.finsLevel} · 气瓶 ${state.tankLevel} · 灯 ${state.lampLevel} · ${totalPearls(state)} ◇`,
    );
  }

  /** Show the currently selected quick slot beside the net inventory. */
  setActiveGear(slot: EquipmentSlot, packed = true) {
    this.lastGear = [slot, packed];
    const labels: Record<EquipmentSlot, string> = {
      net: t('Net', '捕捞网'),
      rod: t('Rod', '杆身'),
      reel: t('Reel', '线轮'),
      fins: t('Fins', '脚蹼'),
      tank: t('Emergency tank', '应急气瓶'),
      lamp: t('Lamp', '探照灯'),
    };
    const keys: Record<EquipmentSlot, number> = { net: 1, rod: 2, reel: 3, fins: 4, tank: 5, lamp: 6 };
    this.activeGear.classList.toggle('unavailable', !packed);
    this.activeNumber.textContent = String(keys[slot]);
    this.activeGearLabel.textContent = packed ? labels[slot] : `${labels[slot]} · ${t('not equipped', '未装配')}`;
    this.activeGearHint.textContent = t(`Press ${keys[slot]} to switch · Tab wheel`, `按 ${keys[slot]} 快速切换 · Tab 轮盘`);
  }

  toast(spec: FishSpec & Numbered, title?: string) {
    const r = RARITY[spec.rarity];
    const el = document.createElement('div');
    const big = spec.rarity === 'legendary' || spec.rarity === 'mythic';
    el.className = `toast${big ? ' big' : ''}`;
    el.style.setProperty('--c', r.color);
    el.innerHTML = `<img alt=""><div><div class="r">${title ?? r.label.toUpperCase()}</div><div class="n"></div></div>`;
    el.querySelector('img')!.src = fishIcon(spec);
    const n = el.querySelector('.n')!;
    n.textContent = `${spec.name} · ${spec.weightKg} kg · ${fishValue(spec)} ${t('pts', '分')}`;
    // A minted fish (e.g. the SOLD toast) carries its number, dimmed after the name.
    if (isSerial(spec.serial)) {
      const tag = document.createElement('span');
      tag.className = 'serial';
      tag.textContent = formatSerial(spec.serial);
      n.replaceChildren(spec.name, ' ', tag, ` · ${spec.weightKg} kg · ${fishValue(spec)} ${t('pts', '分')}`);
    }
    this.toasts.prepend(el);
    setTimeout(() => el.remove(), 3100);
  }
}

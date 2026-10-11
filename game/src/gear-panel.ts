import {
  activePath,
  EQUIPMENT_TIERS,
  EQUIPMENT_PATHS,
  deriveStats,
  equipmentPath,
  nextSlotTier,
  pathTier,
  slotTier,
  totalPearls,
  upgradeSlot,
  type EquipmentSlot,
  type EquipmentPathId,
  type UpgradeSlot,
  type EquipmentState,
} from './equipment';
import { ACCESSORIES, type AccessoryDef, type AccessoryId, type AccessorySlot } from './accessories';
import { pearls as pearlText } from './market';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface SlotUi {
  slot: UpgradeSlot;
  title: string;
  icon: string;
  tradeoff: string;
}

const SLOT_UI: readonly SlotUi[] = [
  { slot: 'net', title: '网片 / 网圈', icon: '◌', tradeoff: '容量和收网判定距离提升；不改变憋气时间。' },
  { slot: 'rod', title: '伸缩碳纤杆身', icon: '╱', tradeoff: '射程增加，远距离收网更依赖瞄准。' },
  { slot: 'reel', title: '高速回收线轮', icon: '◎', tradeoff: '挥网恢复更快；不会提高鱼的稀有度。' },
  { slot: 'fins', title: '流线脚蹼', icon: '≋', tradeoff: '游速和加速度提升；紧急上浮速度不变。' },
  { slot: 'tank', title: '应急气瓶', icon: '▣', tradeoff: '只延长水下换气后的紧急返航窗口。' },
  { slot: 'lamp', title: '探照灯', icon: '✦', tradeoff: '照明距离和亮度提升；光束角度随等级变化。' },
  { slot: 'sonar', title: '深潜声纳', icon: '⌇', tradeoff: '缆绳更长、脉冲节点更多；只提供微光和快速引导，不延长憋气时间。下潜中按 V 投放。' },
];

const ACCESSORY_SLOT_NAMES: Record<AccessorySlot, string> = {
  fins: '脚蹼',
  finPlugin: '脚蹼插件',
  lampCore: '灯体',
  lampAttachment: '灯光附件',
  tank: '气瓶',
  suit: '潜水服',
  belt: '配重带',
  gloves: '手套',
  mask: '面镜',
  chestPlugin: '胸口插件',
};

function statSummary(stats: ReturnType<typeof deriveStats>, slot: EquipmentSlot): string {
  switch (slot) {
    case 'net': return `${stats.netCapacity} 条容量 · ${stats.catchRadius.toFixed(1)} m 捕捞范围`;
    case 'rod': return `${stats.rodRange.toFixed(1)} m 杆身射程`;
    case 'reel': return `恢复倍率 ${Math.round(stats.reelRecovery * 100)}%`;
    case 'fins': return `${stats.swimSpeed.toFixed(1)} m/s 游速 · ${stats.swimAcceleration.toFixed(1)} 加速度`;
    case 'tank': return `${stats.emergencySeconds.toFixed(1)} s 紧急返航窗口`;
    case 'lamp': return `${stats.lampDistance.toFixed(0)} m 光距 · ${Math.round(stats.lampAngle * 57.3)}° 光束`;
  }
}

function statCompare(before: ReturnType<typeof deriveStats>, after: ReturnType<typeof deriveStats>, slot: EquipmentSlot): string {
  switch (slot) {
    case 'net': return `容量 ${before.netCapacity} → ${after.netCapacity} · 范围 ${before.catchRadius.toFixed(1)} → ${after.catchRadius.toFixed(1)} m`;
    case 'rod': return `射程 ${before.rodRange.toFixed(1)} → ${after.rodRange.toFixed(1)} m`;
    case 'reel': return `回收效率 ${Math.round(before.reelRecovery * 100)}% → ${Math.round(after.reelRecovery * 100)}%`;
    case 'fins': return `游速 ${before.swimSpeed.toFixed(1)} → ${after.swimSpeed.toFixed(1)} m/s`;
    case 'tank': return `返航窗口 ${before.emergencySeconds.toFixed(1)} → ${after.emergencySeconds.toFixed(1)} s`;
    case 'lamp': return `光距 ${before.lampDistance.toFixed(0)} → ${after.lampDistance.toFixed(0)} m · 角度 ${Math.round(before.lampAngle * 57.3)} → ${Math.round(after.lampAngle * 57.3)}°`;
  }
}

/** Multi-slot workshop for the diver's catching tool and personal equipment. */
export class GearPanel {
  private panel = $('gear-panel');
  private level = $('gear-level');
  private effect = $('gear-effect');
  private pearls = $('gear-pearls');
  private slots = $('gear-slots');
  private progress = $<HTMLProgressElement>('gear-progress');
  private progressLabel = $('gear-progress-label');
  private next = $('gear-next');
  private compare = $('gear-compare');
  private upgrade = $<HTMLButtonElement>('gear-upgrade');
  private notice = $('gear-notice');
  private icon = $('gear-icon');
  private onUpgrade: (slot: UpgradeSlot) => void;
  private onPathChange: (slot: EquipmentSlot, path: EquipmentPathId) => void;
  private upgradeView = $('gear-upgrade-view');
  private assemblyView = $('gear-assembly-view');
  private tabUpgrades = $<HTMLButtonElement>('gear-tab-upgrades');
  private tabAssembly = $<HTMLButtonElement>('gear-tab-assembly');
  private assemblyGrid = $('gear-assembly-grid');
  private assemblySummary = $('gear-assembly-summary');
  private assembly: Partial<Record<AccessorySlot, AccessoryId>> = this.loadAssembly();
  private view: 'upgrades' | 'assembly' = 'upgrades';
  private selectedSlot: UpgradeSlot = 'net';
  private lastState: EquipmentState | null = null;
  private busy = false;

  constructor(onUpgrade: (slot: UpgradeSlot) => void, onPathChange: (slot: EquipmentSlot, path: EquipmentPathId) => void = () => {}) {
    this.onUpgrade = onUpgrade;
    this.onPathChange = onPathChange;
    $('gear-close').addEventListener('click', () => this.toggle(false));
    this.upgrade.addEventListener('click', () => this.onUpgrade(this.selectedSlot));
    this.tabUpgrades.addEventListener('click', () => this.setView('upgrades'));
    this.tabAssembly.addEventListener('click', () => this.setView('assembly'));
    $('gear-assembly-clear').addEventListener('click', () => {
      this.assembly = {};
      this.saveAssembly();
      this.renderAssembly();
    });
    window.addEventListener('keydown', (event) => {
      if (!this.open || this.view !== 'upgrades' || event.defaultPrevented) return;
      const columns = window.matchMedia('(max-width: 640px)').matches ? 1 : 2;
      const delta = event.key === 'ArrowLeft' ? -1
        : event.key === 'ArrowRight' ? 1
          : event.key === 'ArrowUp' ? -columns
            : event.key === 'ArrowDown' ? columns : 0;
      if (!delta) return;
      event.preventDefault();
      this.selectSlot(this.offsetSlot(delta));
    });
  }

  get open() {
    return !this.panel.classList.contains('hidden');
  }

  toggle(show = !this.open) {
    this.panel.classList.toggle('hidden', !show);
    if (show) this.focusSelected();
  }

  showNotice(message: string) {
    this.notice.textContent = message;
    this.notice.classList.remove('hidden');
    window.setTimeout(() => this.notice.classList.add('hidden'), 2400);
  }

  /** While an upgrade's on-chain PEARL spend is in flight. */
  setBusy(busy: boolean) {
    this.busy = busy;
    if (this.lastState) this.render(this.lastState);
  }

  render(state: EquipmentState) {
    this.lastState = state;
    this.renderSlots(state);
    this.renderDetail(state);
    this.renderAssembly();
  }

  private setView(view: 'upgrades' | 'assembly') {
    this.view = view;
    const assembly = view === 'assembly';
    this.upgradeView.classList.toggle('hidden', assembly);
    this.assemblyView.classList.toggle('hidden', !assembly);
    this.tabUpgrades.classList.toggle('selected', !assembly);
    this.tabAssembly.classList.toggle('selected', assembly);
    this.tabUpgrades.setAttribute('aria-selected', String(!assembly));
    this.tabAssembly.setAttribute('aria-selected', String(assembly));
    if (assembly) this.renderAssembly();
    else if (this.lastState) this.renderSlots(this.lastState);
  }

  private loadAssembly(): Partial<Record<AccessorySlot, AccessoryId>> {
    try {
      const raw = JSON.parse(localStorage.getItem('deepbreath.assembly') ?? '{}') as Record<string, unknown>;
      const valid: Partial<Record<AccessorySlot, AccessoryId>> = {};
      for (const def of ACCESSORIES) {
        if (raw[def.slot] === def.id) valid[def.slot] = def.id;
      }
      return valid;
    } catch {
      return {};
    }
  }

  private saveAssembly() {
    try {
      localStorage.setItem('deepbreath.assembly', JSON.stringify(this.assembly));
    } catch {
      // Cosmetic assembly remains available for the current session if storage is blocked.
    }
  }

  private selectAccessory(def: AccessoryDef) {
    if (this.assembly[def.slot] === def.id) delete this.assembly[def.slot];
    else this.assembly[def.slot] = def.id;
    this.saveAssembly();
    this.renderAssembly();
  }

  private renderAssembly() {
    if (!this.assemblyGrid || !this.assemblySummary) return;
    const selected = ACCESSORIES.filter((def) => this.assembly[def.slot] === def.id);
    this.assemblySummary.replaceChildren(
      ...(selected.length
        ? selected.map((def) => {
            const tag = document.createElement('span');
            tag.className = 'assembly-chip';
            tag.textContent = `${ACCESSORY_SLOT_NAMES[def.slot]} · ${def.nameZh}`;
            return tag;
          })
        : [Object.assign(document.createElement('span'), { className: 'muted', textContent: '尚未装配配件 · 选择下方卡片开始' })]),
    );
    this.assemblyGrid.replaceChildren(
      ...ACCESSORIES.map((def) => {
        const active = this.assembly[def.slot] === def.id;
        const card = document.createElement('article');
        card.className = `assembly-card${active ? ' selected' : ''}`;
        card.dataset.accessory = def.id;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-pressed', String(active));
        const head = document.createElement('div');
        head.className = 'assembly-card-head';
        const title = document.createElement('div');
        title.className = 'assembly-card-title';
        title.textContent = def.nameZh;
        const slot = document.createElement('span');
        slot.className = 'assembly-card-slot';
        slot.textContent = ACCESSORY_SLOT_NAMES[def.slot];
        head.append(title, slot);
        const effect = document.createElement('p');
        effect.textContent = def.effectZh;
        const status = document.createElement('div');
        status.className = 'assembly-card-status';
        status.textContent = active ? '已装配 · 点击拆下' : '可装配';
        card.append(head, effect, status);
        card.addEventListener('click', () => this.selectAccessory(def));
        card.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          this.selectAccessory(def);
        });
        return card;
      }),
    );
  }

  private renderDetail(state: EquipmentState) {
    const ui = SLOT_UI.find((item) => item.slot === this.selectedSlot) ?? SLOT_UI[0];
    const current = slotTier(state, ui.slot);
    const next = nextSlotTier(state, ui.slot);
    const stats = deriveStats(state);
    const pearls = totalPearls(state);
    this.icon.textContent = ui.icon;
    this.level.textContent = `${ui.title} · Lv${current.level} · ${current.name}`;
    this.effect.textContent = ui.slot === 'sonar' ? current.effect : statSummary(stats, ui.slot);
    this.pearls.textContent = `${pearlText(pearls)}${state.legacyPearls ? ` (${state.legacyPearls} legacy, spent first)` : ''} · 选择模块后再打包下潜`;

    if (!next) {
      this.progress.max = 1;
      this.progress.value = 1;
      this.progressLabel.textContent = 'Fully upgraded';
      this.next.textContent = '已达最高等级 · 当前模块效果已完全解锁';
      this.compare.textContent = '当前属性已达到该配件上限';
      this.upgrade.textContent = 'MAX LEVEL';
      this.upgrade.disabled = true;
      return;
    }

    // Give a real preview even when the player cannot yet afford the tier.
    const preview = upgradeSlot({ ...state, pearls: Math.max(state.pearls, next.cost) }, ui.slot);
    const missing = Math.max(0, next.cost - pearls);
    this.progress.max = next.cost;
    this.progress.value = Math.min(next.cost, pearls);
    this.progressLabel.textContent = `${Math.min(next.cost, pearls)} / ${pearlText(next.cost)}`;
    this.next.textContent = `Lv${next.level} · ${next.name} · ${next.effect}`;
    this.compare.textContent = !preview
      ? '升级预览暂不可用'
      : ui.slot === 'sonar'
        ? `升级预览：${current.effect} → ${next.effect}`
        : `升级预览：${statCompare(stats, deriveStats(preview), ui.slot)}`;
    this.upgrade.textContent = this.busy ? 'Spending PEARL…' : missing ? `还差 ${missing} ◇` : `升级 ${next.cost} ◇`;
    this.upgrade.disabled = this.busy || missing > 0;
  }

  private offsetSlot(delta: number): UpgradeSlot {
    const index = SLOT_UI.findIndex((item) => item.slot === this.selectedSlot);
    return SLOT_UI[(index + delta + SLOT_UI.length) % SLOT_UI.length].slot;
  }

  private selectSlot(slot: UpgradeSlot) {
    if (this.selectedSlot === slot && this.lastState) {
      this.focusSelected();
      return;
    }
    this.selectedSlot = slot;
    if (this.lastState) {
      this.renderSlots(this.lastState);
      this.renderDetail(this.lastState);
    }
    this.focusSelected();
  }

  private focusSelected() {
    window.setTimeout(() => {
      this.slots.querySelector<HTMLElement>(`[data-slot="${this.selectedSlot}"]`)?.focus();
    }, 0);
  }

  private renderPaths(state: EquipmentState, slot: EquipmentSlot, level: number): HTMLElement {
    const paths = document.createElement('div');
    paths.className = 'gear-paths';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'gear-path-label';
    pathLabel.textContent = level >= 2 ? '分支模块' : 'Lv2 解锁分支模块';
    paths.appendChild(pathLabel);
    const selectedPath = activePath(state, slot);
    const selectedDef = equipmentPath(slot, selectedPath);
    const selectedTier = pathTier(state, slot);
    for (const path of EQUIPMENT_PATHS[slot]) {
      const pathButton = document.createElement('button');
      pathButton.type = 'button';
      pathButton.className = 'gear-path-button';
      pathButton.textContent = path.nameZh;
      pathButton.title = `${path.name}: ${path.summary}`;
      const pathSelected = level >= 2 && path.id === selectedPath;
      pathButton.setAttribute('aria-pressed', String(pathSelected));
      pathButton.disabled = level < 2;
      pathButton.classList.toggle('selected', pathSelected);
      pathButton.addEventListener('click', () => {
        this.selectSlot(slot);
        this.onPathChange(slot, path.id);
      });
      paths.appendChild(pathButton);
    }
    const pathSummary = document.createElement('div');
    pathSummary.className = 'gear-path-summary';
    pathSummary.textContent = level >= 2
      ? `${selectedDef.summary} · Lv${selectedTier.level}: ${selectedTier.effect}`
      : '升级到 Lv2 后可选择专精路线';
    paths.appendChild(pathSummary);
    return paths;
  }

  private renderSlots(state: EquipmentState) {
    this.slots.innerHTML = '';
    for (const ui of SLOT_UI) {
      const current = slotTier(state, ui.slot);
      const next = nextSlotTier(state, ui.slot);
      const card = document.createElement('article');
      card.className = 'gear-slot-card';
      card.dataset.slot = ui.slot;
      card.tabIndex = 0;
      card.setAttribute('role', 'group');
      card.setAttribute('aria-current', ui.slot === this.selectedSlot ? 'true' : 'false');
      card.classList.toggle('selected', ui.slot === this.selectedSlot);
      card.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        this.selectSlot(ui.slot);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.selectSlot(ui.slot);
      });

      const head = document.createElement('div');
      head.className = 'gear-slot-head';
      const icon = document.createElement('span');
      icon.className = 'gear-slot-icon';
      icon.textContent = ui.icon;
      const title = document.createElement('div');
      title.className = 'gear-slot-title';
      title.textContent = ui.title;
      const level = document.createElement('span');
      level.className = 'gear-slot-level';
      level.textContent = `Lv${current.level}`;
      title.appendChild(level);
      head.append(icon, title);

      const currentLine = document.createElement('div');
      currentLine.className = 'gear-slot-current';
      currentLine.textContent = `${current.name} · ${current.effect}`;
      const tradeoff = document.createElement('div');
      tradeoff.className = 'gear-slot-tradeoff';
      tradeoff.textContent = ui.tradeoff;

      // The sonar levels its cable reach only; it has no specialisation branches.
      if (ui.slot !== 'sonar') card.appendChild(this.renderPaths(state, ui.slot, current.level));

      const footer = document.createElement('div');
      footer.className = 'gear-slot-footer';
      const nextLine = document.createElement('div');
      nextLine.className = 'gear-slot-next';
      const button = document.createElement('button');
      button.className = 'mini gear-slot-button';
      if (!next) {
        nextLine.textContent = '已达最高等级';
        button.textContent = 'MAX';
        button.disabled = true;
      } else {
        const missing = Math.max(0, next.cost - totalPearls(state));
        nextLine.textContent = `下一级：${next.name} · ${next.effect}`;
        button.textContent = this.busy ? 'Spending PEARL…' : missing ? `还差 ${missing} ◇` : `升级 · ${next.cost} ◇`;
        button.disabled = this.busy || missing > 0;
        button.addEventListener('click', () => {
          this.selectSlot(ui.slot);
          this.onUpgrade(ui.slot);
        });
      }
      footer.append(nextLine, button);
      card.append(head, currentLine, tradeoff, footer);
      this.slots.appendChild(card);
    }
  }
}

export { EQUIPMENT_TIERS };

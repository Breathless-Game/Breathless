import {
  activePath,
  EQUIPMENT_TIERS,
  EQUIPMENT_PATHS,
  deriveStats,
  nextRodTier,
  nextSlotTier,
  rodTier,
  slotTier,
  type EquipmentSlot,
  type EquipmentPathId,
  type EquipmentState,
} from './equipment';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface SlotUi {
  slot: EquipmentSlot;
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
];

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
  private upgrade = $<HTMLButtonElement>('gear-upgrade');
  private notice = $('gear-notice');
  private onUpgrade: (slot: EquipmentSlot) => void;
  private onPathChange: (slot: EquipmentSlot, path: EquipmentPathId) => void;

  constructor(onUpgrade: (slot: EquipmentSlot) => void, onPathChange: (slot: EquipmentSlot, path: EquipmentPathId) => void = () => {}) {
    this.onUpgrade = onUpgrade;
    this.onPathChange = onPathChange;
    $('gear-close').addEventListener('click', () => this.toggle(false));
    // Keep the legacy button useful as a keyboard-friendly net shortcut.
    this.upgrade.addEventListener('click', () => this.onUpgrade('net'));
  }

  get open() {
    return !this.panel.classList.contains('hidden');
  }

  toggle(show = !this.open) {
    this.panel.classList.toggle('hidden', !show);
  }

  showNotice(message: string) {
    this.notice.textContent = message;
    this.notice.classList.remove('hidden');
    window.setTimeout(() => this.notice.classList.add('hidden'), 2400);
  }

  render(state: EquipmentState) {
    const net = rodTier(state);
    const nextNet = nextRodTier(state);
    const stats = deriveStats(state);
    this.level.textContent = `NET Lv${net.level} · ${net.name}`;
    this.effect.textContent = `${stats.netCapacity} fish · ${stats.catchRadius.toFixed(1)} m catch · ${stats.rodRange.toFixed(1)} m shaft reach`;
    this.pearls.textContent = `${state.pearls} Pearls`;
    this.renderSlots(state);

    // The compact legacy card mirrors the net slot and remains a convenient
    // one-click upgrade target for players who only want the net.
    if (!nextNet) {
      this.progress.max = 1;
      this.progress.value = 1;
      this.progressLabel.textContent = 'Fully upgraded';
      this.next.textContent = 'The net is at its largest size.';
      this.upgrade.textContent = 'MAX LEVEL';
      this.upgrade.disabled = true;
      return;
    }

    const missing = Math.max(0, nextNet.cost - state.pearls);
    this.progress.max = nextNet.cost;
    this.progress.value = Math.min(nextNet.cost, state.pearls);
    this.progressLabel.textContent = `${Math.min(nextNet.cost, state.pearls)} / ${nextNet.cost} Pearls`;
    this.next.textContent = `Next: Lv${nextNet.level} · ${nextNet.capacity} capacity · ${nextNet.catchRadius.toFixed(1)} m radius`;
    this.upgrade.textContent = missing ? `Need ${missing} more Pearls` : `Upgrade net for ${nextNet.cost} Pearls`;
    this.upgrade.disabled = missing > 0;
  }

  private renderSlots(state: EquipmentState) {
    this.slots.innerHTML = '';
    for (const ui of SLOT_UI) {
      const current = slotTier(state, ui.slot);
      const next = nextSlotTier(state, ui.slot);
      const card = document.createElement('article');
      card.className = 'gear-slot-card';

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

      const paths = document.createElement('div');
      paths.className = 'gear-paths';
      const pathLabel = document.createElement('span');
      pathLabel.className = 'gear-path-label';
      pathLabel.textContent = current.level >= 2 ? '分支模块' : 'Lv2 解锁分支模块';
      paths.appendChild(pathLabel);
      const selectedPath = activePath(state, ui.slot);
      for (const path of EQUIPMENT_PATHS[ui.slot]) {
        const pathButton = document.createElement('button');
        pathButton.type = 'button';
        pathButton.className = 'gear-path-button';
        pathButton.textContent = path.nameZh;
        pathButton.title = `${path.name}: ${path.summary}`;
        pathButton.disabled = current.level < 2;
        pathButton.classList.toggle('selected', path.id === selectedPath);
        pathButton.addEventListener('click', () => this.onPathChange(ui.slot, path.id));
        paths.appendChild(pathButton);
      }
      card.appendChild(paths);

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
        const missing = Math.max(0, next.cost - state.pearls);
        nextLine.textContent = `下一级：${next.name} · ${next.effect}`;
        button.textContent = missing ? `还差 ${missing} ◇` : `升级 · ${next.cost} ◇`;
        button.disabled = missing > 0;
        button.addEventListener('click', () => this.onUpgrade(ui.slot));
      }
      footer.append(nextLine, button);
      card.append(head, currentLine, tradeoff, footer);
      this.slots.appendChild(card);
    }
  }
}

export { EQUIPMENT_TIERS };

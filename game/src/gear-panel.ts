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
  titleZh: string;
  titleEn: string;
  icon: string;
  tradeoffZh: string;
  tradeoffEn: string;
}

const SLOT_UI: readonly SlotUi[] = [
  { slot: 'net', titleZh: '网片 / 网圈', titleEn: 'Net', icon: '◌', tradeoffZh: '容量和收网判定距离提升；不改变憋气时间。', tradeoffEn: 'More capacity and catch range; breath time is unchanged.' },
  { slot: 'rod', titleZh: '伸缩碳纤杆身', titleEn: 'Telescopic shaft', icon: '╱', tradeoffZh: '射程增加，远距离收网更依赖瞄准。', tradeoffEn: 'Longer reach; distant catches require more precise aim.' },
  { slot: 'reel', titleZh: '高速回收线轮', titleEn: 'High-speed reel', icon: '◎', tradeoffZh: '挥网恢复更快；不会提高鱼的稀有度。', tradeoffEn: 'Faster recovery; it does not change fish rarity.' },
  { slot: 'fins', titleZh: '流线脚蹼', titleEn: 'Streamlined fins', icon: '≋', tradeoffZh: '游速和加速度提升；紧急上浮速度不变。', tradeoffEn: 'Improves swim speed and acceleration; emergency ascent is unchanged.' },
  { slot: 'tank', titleZh: '应急气瓶', titleEn: 'Emergency tank', icon: '▣', tradeoffZh: '只延长水下换气后的紧急返航窗口。', tradeoffEn: 'Only extends the emergency return window after underwater breathing.' },
  { slot: 'lamp', titleZh: '探照灯', titleEn: 'Searchlight', icon: '✦', tradeoffZh: '照明距离和亮度提升；光束角度随等级变化。', tradeoffEn: 'Improves light range and intensity; beam angle changes by level.' },
  { slot: 'sonar', titleZh: '深潜声纳', titleEn: 'Deep sonar', icon: '⌇', tradeoffZh: '缆绳更长、脉冲节点更多；只提供微光和快速引导，不延长憋气时间。下潜中按 V 投放。', tradeoffEn: 'Longer cable and more pulse nodes; it guides dives but never extends breath time. Press V underwater.' },
];

const ACCESSORY_SLOT_NAMES: Record<AccessorySlot, { zh: string; en: string }> = {
  fins: { zh: '脚蹼', en: 'Fins' },
  finPlugin: { zh: '脚蹼插件', en: 'Fin plugin' },
  lampCore: { zh: '灯体', en: 'Lamp core' },
  lampAttachment: { zh: '灯光附件', en: 'Lamp attachment' },
  tank: { zh: '气瓶', en: 'Tank' },
  suit: { zh: '潜水服', en: 'Wetsuit' },
  belt: { zh: '配重带', en: 'Weight belt' },
  gloves: { zh: '手套', en: 'Gloves' },
  mask: { zh: '面镜', en: 'Mask' },
  chestPlugin: { zh: '胸口插件', en: 'Chest plugin' },
};

type GearLanguage = 'zh' | 'en';
const LANGUAGE_KEY = 'deepbreath.language';

const COPY = {
  zh: {
    language: 'EN', languageLabel: '切换到英文', kicker: '潜水装备', title: '改装工作台', close: '关闭 (G)',
    upgrades: '合成箱 · 升级', assembly: '装配箱 · 配件', selected: '当前模块', next: '下一次升级', upgrade: '升级',
    assemblyKicker: '配件装配', assemblyTitle: '把配件装到装备上', clear: '清空装配',
    assemblyHelp: '点击配件即可装配到对应卡槽；每个卡槽保留一个配件。装配预览独立于合成箱，不会改变现有等级、价格或下潜属性。',
    footnote: '在图鉴 (C) 出售鱼来赚取珍珠。每次下潜前可自由组合配件；升级只改变装备属性，绝不延长真实憋气时间。气瓶只在水下换气后提供紧急返航窗口。',
    selectedPearls: '选择模块后再打包下潜', max: 'MAX', fullyUpgraded: '已达最高等级', highest: '当前属性已达到该配件上限',
    previewUnavailable: '升级预览暂不可用', preview: '升级预览', nextLevel: '下一级', need: '还差', spending: '正在消耗 PEARL…',
    branch: '分支模块', branchUnlock: 'Lv2 解锁分支模块', chooseBranch: '升级到 Lv2 后可选择专精路线', equipped: '已装配', canEquip: '可装配', remove: '点击拆下', empty: '尚未装配配件 · 选择下方卡片开始',
  },
  en: {
    language: '中文', languageLabel: '切换到中文', kicker: 'DIVER LOADOUT', title: 'Loadout workshop', close: 'Close (G)',
    upgrades: 'UPGRADES', assembly: 'ASSEMBLY', selected: 'SELECTED MODULE', next: 'NEXT UPGRADE', upgrade: 'Upgrade',
    assemblyKicker: 'ACCESSORY FITTING', assemblyTitle: 'Fit accessories to your gear', clear: 'Clear assembly',
    assemblyHelp: 'Click an accessory to fit it into its slot; each slot keeps one accessory. This preview is separate from upgrades and does not change levels, prices, or dive attributes.',
    footnote: 'Sell fish in the collection (C) to earn Pearls. Combine accessories before each dive; upgrades change equipment attributes but never extend real breath time. The tank only opens an emergency return window after underwater breathing.',
    selectedPearls: 'Choose modules before packing a dive', max: 'MAX', fullyUpgraded: 'Fully upgraded', highest: 'This module is at its attribute cap',
    previewUnavailable: 'Upgrade preview unavailable', preview: 'Upgrade preview', nextLevel: 'Next', need: 'Need', spending: 'Spending PEARL…',
    branch: 'SPECIALISATION', branchUnlock: 'SPECIALISATION AT LV2', chooseBranch: 'Reach Lv2 to choose a specialisation path', equipped: 'Fitted', canEquip: 'Available', remove: 'Click to remove', empty: 'No accessories fitted · Choose a card below',
  },
} as const;

const TIER_ZH: Record<UpgradeSlot, readonly { name: string; effect: string }[]> = {
  net: [
    { name: '基础网', effect: '6 条鱼 · 2.4 m 捕捞范围' },
    { name: '强化网', effect: '8 条鱼 · 2.8 m 捕捞范围' },
    { name: '深渊网', effect: '10 条鱼 · 3.2 m 捕捞范围' },
  ],
  rod: [
    { name: '短杆身', effect: '基础工具射程' },
    { name: '伸缩杆身', effect: '+0.2 m 工具射程' },
    { name: '深渊杆身', effect: '+0.4 m 工具射程' },
  ],
  reel: [
    { name: '手摇线轮', effect: '基础挥网恢复' },
    { name: '滚珠线轮', effect: '恢复速度提升 20%' },
    { name: '磁力线轮', effect: '恢复速度提升 40%' },
  ],
  fins: [
    { name: '标准脚蹼', effect: '7.5 m/s 游速' },
    { name: '导流脚蹼', effect: '8.5 m/s 游速' },
    { name: '顺流脚蹼', effect: '9.5 m/s 游速' },
  ],
  tank: [
    { name: '无备用气瓶', effect: '3.2 s 紧急返航' },
    { name: '应急气瓶', effect: '4.2 s 紧急返航' },
    { name: '双备用气瓶', effect: '5.2 s 紧急返航' },
  ],
  lamp: [
    { name: '面镜灯', effect: '18 m 光束' },
    { name: '远距反射器', effect: '28 m 光束' },
    { name: '广角扩散器', effect: '38 m 广角光束' },
  ],
  sonar: [
    { name: '深潜声纳', effect: '10 m 缆绳 · 3 个脉冲节点' },
    { name: '长线声纳', effect: '17 m 缆绳 · 4 个脉冲节点' },
    { name: '深渊声纳', effect: '26 m 缆绳 · 5 个脉冲节点' },
  ],
};

function tierText(tier: { level: number; name: string; effect: string }, slot: UpgradeSlot, language: GearLanguage) {
  return language === 'zh' ? TIER_ZH[slot][tier.level - 1] : tier;
}

function loadLanguage(): GearLanguage {
  try { return localStorage.getItem(LANGUAGE_KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

function saveLanguage(language: GearLanguage) {
  try { localStorage.setItem(LANGUAGE_KEY, language); } catch {}
}

function statSummary(stats: ReturnType<typeof deriveStats>, slot: EquipmentSlot, language: GearLanguage): string {
  switch (slot) {
    case 'net': return language === 'zh' ? `${stats.netCapacity} 条容量 · ${stats.catchRadius.toFixed(1)} m 捕捞范围` : `${stats.netCapacity} capacity · ${stats.catchRadius.toFixed(1)} m catch range`;
    case 'rod': return language === 'zh' ? `${stats.rodRange.toFixed(1)} m 杆身射程` : `${stats.rodRange.toFixed(1)} m tool reach`;
    case 'reel': return language === 'zh' ? `恢复倍率 ${Math.round(stats.reelRecovery * 100)}%` : `${Math.round(stats.reelRecovery * 100)}% recovery rate`;
    case 'fins': return language === 'zh' ? `${stats.swimSpeed.toFixed(1)} m/s 游速 · ${stats.swimAcceleration.toFixed(1)} 加速度` : `${stats.swimSpeed.toFixed(1)} m/s swim speed · ${stats.swimAcceleration.toFixed(1)} acceleration`;
    case 'tank': return language === 'zh' ? `${stats.emergencySeconds.toFixed(1)} s 紧急返航窗口` : `${stats.emergencySeconds.toFixed(1)} s emergency return window`;
    case 'lamp': return language === 'zh' ? `${stats.lampDistance.toFixed(0)} m 光距 · 直射 ${Math.round(stats.lampIntensity)} · 散射 ${Math.round(stats.lampScatter * 100)}% · ${Math.round(stats.lampAngle * 57.3)}°` : `${stats.lampDistance.toFixed(0)} m range · direct ${Math.round(stats.lampIntensity)} · scatter ${Math.round(stats.lampScatter * 100)}% · ${Math.round(stats.lampAngle * 57.3)}°`;
  }
}

function statCompare(before: ReturnType<typeof deriveStats>, after: ReturnType<typeof deriveStats>, slot: EquipmentSlot, language: GearLanguage): string {
  switch (slot) {
    case 'net': return language === 'zh' ? `容量 ${before.netCapacity} → ${after.netCapacity} · 范围 ${before.catchRadius.toFixed(1)} → ${after.catchRadius.toFixed(1)} m` : `Capacity ${before.netCapacity} → ${after.netCapacity} · range ${before.catchRadius.toFixed(1)} → ${after.catchRadius.toFixed(1)} m`;
    case 'rod': return language === 'zh' ? `射程 ${before.rodRange.toFixed(1)} → ${after.rodRange.toFixed(1)} m` : `Reach ${before.rodRange.toFixed(1)} → ${after.rodRange.toFixed(1)} m`;
    case 'reel': return language === 'zh' ? `回收效率 ${Math.round(before.reelRecovery * 100)}% → ${Math.round(after.reelRecovery * 100)}%` : `Recovery ${Math.round(before.reelRecovery * 100)}% → ${Math.round(after.reelRecovery * 100)}%`;
    case 'fins': return language === 'zh' ? `游速 ${before.swimSpeed.toFixed(1)} → ${after.swimSpeed.toFixed(1)} m/s` : `Swim speed ${before.swimSpeed.toFixed(1)} → ${after.swimSpeed.toFixed(1)} m/s`;
    case 'tank': return language === 'zh' ? `返航窗口 ${before.emergencySeconds.toFixed(1)} → ${after.emergencySeconds.toFixed(1)} s` : `Return window ${before.emergencySeconds.toFixed(1)} → ${after.emergencySeconds.toFixed(1)} s`;
    case 'lamp': return language === 'zh' ? `光距 ${before.lampDistance.toFixed(0)} → ${after.lampDistance.toFixed(0)} m · 直射 ${Math.round(before.lampIntensity)} → ${Math.round(after.lampIntensity)} · 散射 ${Math.round(before.lampScatter * 100)}% → ${Math.round(after.lampScatter * 100)}% · ${Math.round(after.lampAngle * 57.3)}°` : `Range ${before.lampDistance.toFixed(0)} → ${after.lampDistance.toFixed(0)} m · direct ${Math.round(before.lampIntensity)} → ${Math.round(after.lampIntensity)} · scatter ${Math.round(before.lampScatter * 100)}% → ${Math.round(after.lampScatter * 100)}% · ${Math.round(after.lampAngle * 57.3)}°`;
  }
}

/** Multi-slot workshop for the diver's catching tool and personal equipment. */
export class GearPanel {
  private panel = $('gear-panel');
  private languageButton = $<HTMLButtonElement>('gear-language');
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
  private language: GearLanguage = loadLanguage();
  private view: 'upgrades' | 'assembly' = 'upgrades';
  private selectedSlot: UpgradeSlot = 'net';
  private lastState: EquipmentState | null = null;
  private busy = false;
  private closeTimer = 0;

  constructor(onUpgrade: (slot: UpgradeSlot) => void, onPathChange: (slot: EquipmentSlot, path: EquipmentPathId) => void = () => {}) {
    this.onUpgrade = onUpgrade;
    this.onPathChange = onPathChange;
    this.renderLanguage();
    $('gear-close').addEventListener('click', () => this.toggle(false));
    this.languageButton.addEventListener('click', () => {
      this.language = this.language === 'zh' ? 'en' : 'zh';
      saveLanguage(this.language);
      this.renderLanguage();
      if (this.lastState) {
        this.renderSlots(this.lastState);
        this.renderDetail(this.lastState);
      }
      this.renderAssembly();
    });
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
    return this.panel.classList.contains('is-open');
  }

  toggle(show = !this.open) {
    window.clearTimeout(this.closeTimer);
    if (show) {
      this.panel.classList.remove('hidden');
      this.panel.setAttribute('aria-hidden', 'false');
      void this.panel.offsetWidth;
      this.panel.classList.add('is-open');
      this.focusSelected();
      return;
    }
    this.panel.classList.remove('is-open');
    this.panel.setAttribute('aria-hidden', 'true');
    this.closeTimer = window.setTimeout(() => {
      if (!this.panel.classList.contains('is-open')) this.panel.classList.add('hidden');
    }, 280);
  }

  private renderLanguage() {
    const copy = COPY[this.language];
    $('gear-kicker').textContent = copy.kicker;
    $('gear-title').textContent = copy.title;
    $('gear-close').textContent = copy.close;
    this.languageButton.textContent = copy.language;
    this.languageButton.setAttribute('aria-label', copy.languageLabel);
    $('gear-tabs').setAttribute('aria-label', this.language === 'zh' ? '装备工作台' : 'Equipment workshop');
    this.tabUpgrades.textContent = copy.upgrades;
    this.tabAssembly.textContent = copy.assembly;
    $('gear-selected-label').textContent = copy.selected;
    $('gear-next-label').textContent = copy.next;
    $('gear-footnote').textContent = copy.footnote;
    $('gear-assembly-kicker').textContent = copy.assemblyKicker;
    $('gear-assembly-title').textContent = copy.assemblyTitle;
    $('gear-assembly-clear').textContent = copy.clear;
    $('gear-assembly-help').textContent = copy.assemblyHelp;
    this.upgradeView.setAttribute('aria-label', this.language === 'zh' ? '合成箱' : 'Upgrade box');
    this.assemblyView.setAttribute('aria-label', this.language === 'zh' ? '装配箱' : 'Assembly box');
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
    if (this.view === view) return;
    this.view = view;
    const assembly = view === 'assembly';
    const incoming = assembly ? this.assemblyView : this.upgradeView;
    const outgoing = assembly ? this.upgradeView : this.assemblyView;
    const forward = assembly;
    incoming.classList.remove('hidden', 'active', 'enter-left', 'enter-right', 'exit-left', 'exit-right');
    outgoing.classList.remove('active', 'enter-left', 'enter-right', 'exit-left', 'exit-right');
    incoming.classList.add(forward ? 'enter-right' : 'enter-left');
    outgoing.classList.add(forward ? 'exit-left' : 'exit-right');
    void incoming.offsetWidth;
    requestAnimationFrame(() => {
      incoming.classList.add('active');
      incoming.classList.remove('enter-left', 'enter-right');
    });
    this.tabUpgrades.classList.toggle('selected', !assembly);
    this.tabAssembly.classList.toggle('selected', assembly);
    this.tabUpgrades.setAttribute('aria-selected', String(!assembly));
    this.tabAssembly.setAttribute('aria-selected', String(assembly));
    this.upgradeView.setAttribute('aria-hidden', String(assembly));
    this.assemblyView.setAttribute('aria-hidden', String(!assembly));
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
    const copy = COPY[this.language];
    const selected = ACCESSORIES.filter((def) => this.assembly[def.slot] === def.id);
    this.assemblySummary.replaceChildren(
      ...(selected.length
        ? selected.map((def) => {
            const tag = document.createElement('span');
            tag.className = 'assembly-chip';
            tag.textContent = `${ACCESSORY_SLOT_NAMES[def.slot][this.language]} · ${this.language === 'zh' ? def.nameZh : def.name}`;
            return tag;
          })
        : [Object.assign(document.createElement('span'), { className: 'muted', textContent: copy.empty })]),
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
        title.textContent = this.language === 'zh' ? def.nameZh : def.name;
        const slot = document.createElement('span');
        slot.className = 'assembly-card-slot';
        slot.textContent = ACCESSORY_SLOT_NAMES[def.slot][this.language];
        head.append(title, slot);
        const effect = document.createElement('p');
        effect.textContent = this.language === 'zh' ? def.effectZh : def.effect;
        const status = document.createElement('div');
        status.className = 'assembly-card-status';
        status.textContent = active ? `${copy.equipped} · ${copy.remove}` : copy.canEquip;
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
    const copy = COPY[this.language];
    const ui = SLOT_UI.find((item) => item.slot === this.selectedSlot) ?? SLOT_UI[0];
    const current = slotTier(state, ui.slot);
    const next = nextSlotTier(state, ui.slot);
    const stats = deriveStats(state);
    const pearls = totalPearls(state);
    const currentText = tierText(current, ui.slot, this.language);
    this.icon.textContent = ui.icon;
    this.level.textContent = `${this.language === 'zh' ? ui.titleZh : ui.titleEn} · Lv${current.level} · ${currentText.name}`;
    this.effect.textContent = ui.slot === 'sonar' ? currentText.effect : statSummary(stats, ui.slot, this.language);
    this.pearls.textContent = this.language === 'zh'
      ? `${pearlText(pearls)}${state.legacyPearls ? `（${state.legacyPearls} legacy，优先消耗）` : ''} · ${copy.selectedPearls}`
      : `${pearlText(pearls)}${state.legacyPearls ? ` (${state.legacyPearls} legacy, spent first)` : ''} · ${copy.selectedPearls}`;

    if (!next) {
      this.progress.max = 1;
      this.progress.value = 1;
      this.progressLabel.textContent = copy.fullyUpgraded;
      this.next.textContent = this.language === 'zh' ? '已达最高等级 · 当前模块效果已完全解锁' : 'Fully upgraded · all module effects unlocked';
      this.compare.textContent = copy.highest;
      this.upgrade.textContent = copy.max;
      this.upgrade.disabled = true;
      return;
    }

    // Give a real preview even when the player cannot yet afford the tier.
    const preview = upgradeSlot({ ...state, pearls: Math.max(state.pearls, next.cost) }, ui.slot);
    const nextText = tierText(next, ui.slot, this.language);
    const missing = Math.max(0, next.cost - pearls);
    this.progress.max = next.cost;
    this.progress.value = Math.min(next.cost, pearls);
    this.progressLabel.textContent = `${Math.min(next.cost, pearls)} / ${pearlText(next.cost)}`;
    this.next.textContent = `${copy.nextLevel} Lv${next.level} · ${nextText.name} · ${nextText.effect}`;
    this.compare.textContent = !preview
      ? copy.previewUnavailable
      : ui.slot === 'sonar'
        ? `${copy.preview}: ${currentText.effect} → ${nextText.effect}`
        : `${copy.preview}: ${statCompare(stats, deriveStats(preview), ui.slot, this.language)}`;
    this.upgrade.textContent = this.busy ? copy.spending : missing ? `${copy.need} ${missing} ◇` : `${copy.upgrade} ${next.cost} ◇`;
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
    const copy = COPY[this.language];
    const paths = document.createElement('div');
    paths.className = 'gear-paths';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'gear-path-label';
    pathLabel.textContent = level >= 2 ? copy.branch : copy.branchUnlock;
    paths.appendChild(pathLabel);
    const selectedPath = activePath(state, slot);
    const selectedDef = equipmentPath(slot, selectedPath);
    const selectedTier = pathTier(state, slot);
    for (const path of EQUIPMENT_PATHS[slot]) {
      const pathButton = document.createElement('button');
      pathButton.type = 'button';
      pathButton.className = 'gear-path-button';
      pathButton.textContent = this.language === 'zh' ? path.nameZh : path.name;
      pathButton.title = this.language === 'zh' ? path.nameZh : `${path.name}: ${path.summary}`;
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
      ? this.language === 'zh'
        ? `${selectedDef.nameZh} · Lv${selectedTier.level}：已启用`
        : `${selectedDef.name} · Lv${selectedTier.level}: ${selectedTier.effect}`
      : copy.chooseBranch;
    paths.appendChild(pathSummary);
    return paths;
  }

  private renderSlots(state: EquipmentState) {
    const copy = COPY[this.language];
    this.slots.innerHTML = '';
    for (const ui of SLOT_UI) {
      const current = slotTier(state, ui.slot);
      const next = nextSlotTier(state, ui.slot);
      const currentText = tierText(current, ui.slot, this.language);
      const nextText = next ? tierText(next, ui.slot, this.language) : null;
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
      title.textContent = this.language === 'zh' ? ui.titleZh : ui.titleEn;
      const level = document.createElement('span');
      level.className = 'gear-slot-level';
      level.textContent = `Lv${current.level}`;
      title.appendChild(level);
      head.append(icon, title);

      const currentLine = document.createElement('div');
      currentLine.className = 'gear-slot-current';
      currentLine.textContent = `${currentText.name} · ${currentText.effect}`;
      const tradeoff = document.createElement('div');
      tradeoff.className = 'gear-slot-tradeoff';
      tradeoff.textContent = this.language === 'zh' ? ui.tradeoffZh : ui.tradeoffEn;

      // The sonar levels its cable reach only; it has no specialisation branches.
      if (ui.slot !== 'sonar') card.appendChild(this.renderPaths(state, ui.slot, current.level));

      const footer = document.createElement('div');
      footer.className = 'gear-slot-footer';
      const nextLine = document.createElement('div');
      nextLine.className = 'gear-slot-next';
      const button = document.createElement('button');
      button.className = 'mini gear-slot-button';
      if (!next) {
        nextLine.textContent = copy.fullyUpgraded;
        button.textContent = copy.max;
        button.disabled = true;
      } else {
        const missing = Math.max(0, next.cost - totalPearls(state));
        nextLine.textContent = `${copy.nextLevel}: ${nextText!.name} · ${nextText!.effect}`;
        button.textContent = this.busy ? copy.spending : missing ? `${copy.need} ${missing} ◇` : `${copy.upgrade} · ${next.cost} ◇`;
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

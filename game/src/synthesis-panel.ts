import { MATERIALS, RECIPES, synthesisUpgradeCost, SYNTHESIS_RECIPE_COSTS, type MaterialId, type RecipeDef, type SynthesisState } from './synthesis';
import type { EquipmentState, UpgradeSlot } from './equipment';
import { onLangChange, pickName, t } from './i18n';

export interface SynthesisPanelHooks {
  state(): SynthesisState;
  equipment(): EquipmentState;
  pearls(): number;
  upgrade(slot: UpgradeSlot): Promise<void>;
  craft(id: RecipeDef['id']): Promise<void>;
  close(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const UPGRADE_SLOTS: readonly UpgradeSlot[] = ['net', 'rod', 'reel', 'fins', 'tank', 'lamp', 'sonar'];
const label = (slot: UpgradeSlot) => ({
  net: t('Net', '网具'), rod: t('Rod', '杆身'), reel: t('Reel', '线轮'), fins: t('Fins', '脚蹼'), tank: t('Tank', '气瓶'), lamp: t('Lamp', '头灯'), sonar: t('Sonar', '声纳'),
})[slot];
const levelOf = (equipment: EquipmentState, slot: UpgradeSlot) => slot === 'rod' ? equipment.rodGearLevel : equipment[`${slot}Level` as keyof EquipmentState] as number;

/** DOM half of the workshop. Pointer and drag interactions share the same material drop path. */
export class SynthesisPanel {
  private readonly root = $('wb-synth');
  private readonly materialsEl = $('wb-synth-materials');
  private readonly materialsRightEl = $('wb-synth-materials-right');
  private readonly workingEl = $('wb-synth-working');
  private readonly recipesEl = $('wb-synth-recipes');
  private readonly upgradesEl = $('wb-synth-upgrades');
  private readonly balanceEl = $('wb-synth-balance');
  private working: Partial<Record<MaterialId, number>> = {};
  private busy = false;

  constructor(private readonly hooks: SynthesisPanelHooks) {
    $('wb-synth-close').addEventListener('click', () => hooks.close());
    this.workingEl.addEventListener('dragover', (event) => event.preventDefault());
    this.workingEl.addEventListener('drop', (event) => {
      event.preventDefault();
      const payload = (event as DragEvent).dataTransfer?.getData('text/plain') ?? '';
      if (payload.startsWith('upgrade:')) {
        const slot = payload.slice('upgrade:'.length) as UpgradeSlot;
        if (UPGRADE_SLOTS.includes(slot) && !this.busy) void this.hooks.upgrade(slot).then(() => this.render());
      } else if (payload) this.addMaterial(payload as MaterialId);
    });
    this.render();
    onLangChange(() => this.render());
  }

  get open() { return !this.root.classList.contains('hidden'); }

  show() { this.root.classList.remove('hidden'); this.working = {}; this.render(); }
  hide() { this.root.classList.add('hidden'); this.working = {}; }

  private addMaterial(id: MaterialId) {
    const available = this.hooks.state().materials[id] - (this.working[id] ?? 0);
    if (available <= 0 || this.busy) return;
    this.working[id] = (this.working[id] ?? 0) + 1;
    this.renderWorking();
    const hit = RECIPES.find((def) => Object.keys(def.needs).length === Object.keys(this.working).length
      && Object.entries(def.needs).every(([key, amount]) => this.working[key as MaterialId] === amount));
    if (hit) {
      this.busy = true;
      void this.hooks.craft(hit.id).finally(() => { this.busy = false; this.working = {}; this.render(); });
    }
  }

  private renderWorking() {
    const parts = MATERIALS.flatMap((mat) => Array.from({ length: this.working[mat.id] ?? 0 }, () => `<span class="wb-synth-chip" style="--chip:${mat.color}">${pickName(mat)}</span>`));
    this.workingEl.innerHTML = parts.length ? parts.join('') : `<span class="small muted">${t('Drop parts here', '将材料拖入中央')}</span>`;
  }

  private render() {
    const state = this.hooks.state();
    this.balanceEl.textContent = `${this.hooks.pearls()} ${t('Pearls', '珍珠')} · ${state.crafted.bait} ${t('bait', '鱼饵')} / ${state.crafted.composite} ${t('plates', '护板')}`;
    const materialButton = (mat: typeof MATERIALS[number]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wb-synth-material';
      button.draggable = true;
      button.dataset.material = mat.id;
      button.innerHTML = `<i style="--mat:${mat.color}"></i><span>${pickName(mat)}</span><b>${state.materials[mat.id]}</b>`;
      button.addEventListener('click', () => this.addMaterial(mat.id));
      button.addEventListener('dragstart', (event) => event.dataTransfer?.setData('text/plain', mat.id));
      return button;
    };
    this.materialsEl.replaceChildren(...MATERIALS.slice(0, 2).map(materialButton));
    this.materialsRightEl.replaceChildren(...MATERIALS.slice(2).map(materialButton));
    this.renderWorking();
    this.recipesEl.replaceChildren(...RECIPES.map((def) => {
      const row = document.createElement('div');
      row.className = 'wb-synth-recipe';
      row.innerHTML = `<div><b>${pickName(def)}</b></div><small>${Object.entries(def.needs).map(([key, n]) => `${n} ${pickName(MATERIALS.find((m) => m.id === key)!)}`).join(' + ')} · ${SYNTHESIS_RECIPE_COSTS[def.id]} ✦</small><button type="button">${t('Craft', '合成')}</button>`;
      row.querySelector('button')!.addEventListener('click', () => { if (!this.busy) void this.hooks.craft(def.id).then(() => this.render()); });
      return row;
    }));
    this.upgradesEl.replaceChildren(...UPGRADE_SLOTS.map((slot) => {
      const level = levelOf(this.hooks.equipment(), slot);
      const cost = synthesisUpgradeCost(slot, level);
      const row = document.createElement('div');
      row.className = `wb-synth-upgrade${cost == null ? ' max' : ''}`;
      row.draggable = cost != null;
      row.addEventListener('dragstart', (event) => event.dataTransfer?.setData('text/plain', `upgrade:${slot}`));
      row.innerHTML = `<span><b>${label(slot)}</b><small>Lv ${level} → ${cost == null ? t('MAX', '满级') : level + 1}</small></span><strong>${cost == null ? t('Max level', '已满级') : `${cost} ✦`}</strong><button type="button" ${cost == null ? 'disabled' : ''}>${t('Upgrade', '升级')}</button>`;
      row.querySelector('button')!.addEventListener('click', () => { if (cost != null && !this.busy) void this.hooks.upgrade(slot).then(() => this.render()); });
      return row;
    }));
  }
}

import type { EquipmentSlot } from './equipment';

/**
 * The six slots that can be packed on the dive bench.  The order is stable so
 * number keys work as quick slots and the radial positions never move between
 * dives.  Holding Tab mirrors Tomb Raider's weapon wheel; releasing Tab
 * confirms the highlighted slot.  Number keys remain useful when the player
 * wants the Sons of the Forest style instant equip.
 */
export const QUICK_SLOTS: readonly {
  readonly slot: EquipmentSlot;
  readonly label: string;
  readonly shortLabel: string;
  readonly icon: string;
}[] = Object.freeze([
  { slot: 'net', label: '捕捞网', shortLabel: 'NET', icon: '◌' },
  { slot: 'rod', label: '杆身', shortLabel: 'SHAFT', icon: '╱' },
  { slot: 'reel', label: '线轮', shortLabel: 'REEL', icon: '◎' },
  { slot: 'fins', label: '脚蹼', shortLabel: 'FINS', icon: '≋' },
  { slot: 'tank', label: '应急气瓶', shortLabel: 'TANK', icon: '▣' },
  { slot: 'lamp', label: '探照灯', shortLabel: 'LAMP', icon: '✦' },
]);

export interface LoadoutWheelHooks {
  /** Whether the slot is packed for this dive. */
  isAvailable: (slot: EquipmentSlot) => boolean;
  /** Called after a slot is confirmed. */
  onSelect: (slot: EquipmentSlot) => void;
  /** Called when a player tries to select an unpacked slot. */
  onUnavailable?: (slot: EquipmentSlot) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class LoadoutWheel {
  private readonly root = $<HTMLDivElement>('loadout-wheel');
  private readonly slots = $<HTMLDivElement>('loadout-wheel-slots');
  private readonly center = $<HTMLDivElement>('loadout-wheel-center');
  private readonly activeLabel = $<HTMLSpanElement>('active-gear-label');
  private readonly activeNumber = $<HTMLSpanElement>('active-gear-number');
  private activeIndex = 0;
  private highlightedIndex = 0;

  constructor(private readonly hooks: LoadoutWheelHooks) {
    QUICK_SLOTS.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'loadout-wheel-slot';
      button.dataset.index = String(index);
      button.style.setProperty('--slot-index', String(index));
      button.setAttribute('aria-label', `${index + 1}: ${item.label}`);
      button.innerHTML = `<span class="loadout-wheel-key">${index + 1}</span><span class="loadout-wheel-icon">${item.icon}</span><span class="loadout-wheel-name">${item.label}</span>`;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.highlight(index);
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this.highlight(index);
        if (this.open) this.commit();
        else this.select(index);
      });
      this.slots.appendChild(button);
    });
    this.render();
  }

  get open() {
    return !this.root.classList.contains('hidden');
  }

  get activeSlot(): EquipmentSlot {
    return QUICK_SLOTS[this.activeIndex].slot;
  }

  /** Keep the selected radial sector in sync after a new dive loadout starts. */
  setActive(slot: EquipmentSlot) {
    const index = QUICK_SLOTS.findIndex((item) => item.slot === slot);
    if (index < 0) return;
    this.activeIndex = index;
    this.highlightedIndex = index;
    this.render();
  }

  /** Open the wheel, retaining the current item until the key is released. */
  openWheel() {
    if (this.open) return;
    this.highlightedIndex = this.activeIndex;
    this.root.classList.remove('hidden');
    this.root.setAttribute('aria-hidden', 'false');
    this.render();
  }

  closeWheel(commit = false) {
    if (!this.open) return;
    if (commit) this.commit();
    else {
      this.root.classList.add('hidden');
      this.root.setAttribute('aria-hidden', 'true');
      this.highlightedIndex = this.activeIndex;
      this.render();
    }
  }

  /**
   * Feed a keydown event from main.ts. Returning true means the wheel consumed
   * it and the normal dive action should not also run (Space is important here).
   */
  handleKeyDown(event: KeyboardEvent, canOpen: boolean): boolean {
    const key = event.key.toLowerCase();
    if (event.key === 'Tab') {
      if (!this.open && canOpen) {
        event.preventDefault();
        this.openWheel();
      }
      return true;
    }

    if (this.open) {
      event.preventDefault();
      if (event.key === 'Escape') {
        this.closeWheel(false);
      } else if (event.key === 'Enter' || event.key === ' ') {
        this.commit();
      } else if (key === 'arrowright' || key === 'arrowdown' || key === 'd' || key === 's' || key === 'e') {
        this.highlight(this.highlightedIndex + 1);
      } else if (key === 'arrowleft' || key === 'arrowup' || key === 'a' || key === 'w' || key === 'q') {
        this.highlight(this.highlightedIndex - 1);
      } else {
        const index = this.numberIndex(event);
        if (index != null) this.highlight(index);
      }
      return true;
    }

    if (!canOpen) return false;
    const index = this.numberIndex(event);
    if (index != null) {
      event.preventDefault();
      this.select(index);
      return true;
    }
    if (key === 'q' || key === 'e') {
      event.preventDefault();
      this.select(this.activeIndex + (key === 'e' ? 1 : -1));
      return true;
    }
    return false;
  }

  handleKeyUp(event: KeyboardEvent): boolean {
    if (event.key !== 'Tab') return false;
    event.preventDefault();
    if (this.open) this.closeWheel(true);
    return true;
  }

  private numberIndex(event: KeyboardEvent): number | null {
    const match = event.code.match(/^Digit([1-6])$/);
    if (match) return Number(match[1]) - 1;
    const value = Number(event.key);
    return Number.isInteger(value) && value >= 1 && value <= QUICK_SLOTS.length ? value - 1 : null;
  }

  private highlight(index: number) {
    this.highlightedIndex = (index + QUICK_SLOTS.length) % QUICK_SLOTS.length;
    this.render();
  }

  private select(index: number) {
    const item = QUICK_SLOTS[(index + QUICK_SLOTS.length) % QUICK_SLOTS.length];
    if (!this.hooks.isAvailable(item.slot)) {
      this.hooks.onUnavailable?.(item.slot);
      return;
    }
    this.activeIndex = (index + QUICK_SLOTS.length) % QUICK_SLOTS.length;
    this.highlightedIndex = this.activeIndex;
    this.render();
    this.hooks.onSelect(item.slot);
  }

  private commit() {
    const item = QUICK_SLOTS[this.highlightedIndex];
    if (!this.hooks.isAvailable(item.slot)) {
      this.hooks.onUnavailable?.(item.slot);
      this.closeWheel(false);
      return;
    }
    this.activeIndex = this.highlightedIndex;
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
    this.render();
    this.hooks.onSelect(item.slot);
  }

  private render() {
    const highlighted = QUICK_SLOTS[this.highlightedIndex];
    const active = QUICK_SLOTS[this.activeIndex];
    this.center.innerHTML = `<strong>${highlighted.label}</strong><small>松开 Tab 确认</small>`;
    this.activeLabel.textContent = active.label;
    this.activeNumber.textContent = `${this.activeIndex + 1}`;
    for (const button of Array.from(this.slots.querySelectorAll<HTMLButtonElement>('.loadout-wheel-slot'))) {
      const index = Number(button.dataset.index);
      const item = QUICK_SLOTS[index];
      const available = this.hooks.isAvailable(item.slot);
      button.classList.toggle('highlighted', index === this.highlightedIndex && this.open);
      button.classList.toggle('active', index === this.activeIndex);
      button.classList.toggle('unavailable', !available);
      button.disabled = !available;
    }
  }
}


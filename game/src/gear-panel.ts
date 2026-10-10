import { ROD_TIERS, nextRodTier, rodTier, totalPearls, type EquipmentState } from './equipment';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The small workshop UI for the diver's fishing-net/rod upgrades. */
export class GearPanel {
  private panel = $('gear-panel');
  private level = $('gear-level');
  private effect = $('gear-effect');
  private pearls = $('gear-pearls');
  private progress = $<HTMLProgressElement>('gear-progress');
  private progressLabel = $('gear-progress-label');
  private next = $('gear-next');
  private upgrade = $<HTMLButtonElement>('gear-upgrade');
  private notice = $('gear-notice');
  private onUpgrade: () => void;
  private state: EquipmentState | null = null;
  private busy = false;

  constructor(onUpgrade: () => void) {
    this.onUpgrade = onUpgrade;
    $('gear-close').addEventListener('click', () => this.toggle(false));
    this.upgrade.addEventListener('click', () => this.onUpgrade());
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

  /** While an upgrade's on-chain PEARL spend is in flight. */
  setBusy(busy: boolean) {
    this.busy = busy;
    if (this.state) this.render(this.state);
  }

  render(state: EquipmentState) {
    this.state = state;
    const tier = rodTier(state);
    const nextTier = nextRodTier(state);
    const pearls = totalPearls(state);
    this.level.textContent = `LEVEL ${tier.level} · ${tier.name}`;
    this.effect.textContent = `${tier.capacity} fish capacity · ${tier.catchRadius.toFixed(1)} m catch radius`;
    this.pearls.textContent = `${pearls} Pearls${state.legacyPearls ? ` (${state.legacyPearls} legacy, spent first)` : ''}`;

    if (!nextTier) {
      this.progress.max = 1;
      this.progress.value = 1;
      this.progressLabel.textContent = 'Fully upgraded';
      this.next.textContent = 'The net is at its largest size.';
      this.upgrade.textContent = 'MAX LEVEL';
      this.upgrade.disabled = true;
      return;
    }

    const missing = Math.max(0, nextTier.cost - pearls);
    this.progress.max = nextTier.cost;
    this.progress.value = Math.min(nextTier.cost, pearls);
    this.progressLabel.textContent = `${Math.min(nextTier.cost, pearls)} / ${nextTier.cost} Pearls`;
    this.next.textContent = `Next: Lv${nextTier.level} · ${nextTier.capacity} capacity · ${nextTier.catchRadius.toFixed(1)} m radius`;
    this.upgrade.textContent = this.busy ? 'Spending PEARL…' : missing ? `Need ${missing} more Pearls` : `Upgrade for ${nextTier.cost} Pearls`;
    this.upgrade.disabled = this.busy || missing > 0;
  }
}

export { ROD_TIERS };

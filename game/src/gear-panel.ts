import { ROD_TIERS, SONAR_TIERS, nextRodTier, nextSonarTier, rodTier, sonarTier, totalPearls, type EquipmentState } from './equipment';

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
  private sonarLevel = $('sonar-level');
  private sonarEffect = $('sonar-effect');
  private sonarNext = $('sonar-next');
  private sonarPearlsProgress = $<HTMLProgressElement>('sonar-progress');
  private sonarProgressLabel = $('sonar-progress-label');
  private sonarUpgrade = $<HTMLButtonElement>('sonar-upgrade');
  private sonarNotice = $('sonar-notice');
  private onUpgrade: () => void;
  private onSonarUpgrade: () => void;
  private state: EquipmentState | null = null;
  private busy = false;

  constructor(onUpgrade: () => void, onSonarUpgrade: () => void = () => {}) {
    this.onUpgrade = onUpgrade;
    this.onSonarUpgrade = onSonarUpgrade;
    $('gear-close').addEventListener('click', () => this.toggle(false));
    this.upgrade.addEventListener('click', () => this.onUpgrade());
    this.sonarUpgrade.addEventListener('click', () => this.onSonarUpgrade());
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

  showSonarNotice(message: string) {
    this.sonarNotice.textContent = message;
    this.sonarNotice.classList.remove('hidden');
    window.setTimeout(() => this.sonarNotice.classList.add('hidden'), 2400);
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
    } else {
      const missing = Math.max(0, nextTier.cost - pearls);
      this.progress.max = nextTier.cost;
      this.progress.value = Math.min(nextTier.cost, pearls);
      this.progressLabel.textContent = `${Math.min(nextTier.cost, pearls)} / ${nextTier.cost} Pearls`;
      this.next.textContent = `Next: Lv${nextTier.level} · ${nextTier.capacity} capacity · ${nextTier.catchRadius.toFixed(1)} m radius`;
      this.upgrade.textContent = this.busy ? 'Spending PEARL…' : missing ? `Need ${missing} more Pearls` : `Upgrade for ${nextTier.cost} Pearls`;
      this.upgrade.disabled = this.busy || missing > 0;
    }

    const sonar = sonarTier(state);
    const nextSonar = nextSonarTier(state);
    this.sonarLevel.textContent = `LEVEL ${sonar.level} · ${sonar.length} m cable`;
    this.sonarEffect.textContent = `${sonar.nodes} pulse nodes · weak light · quick guidance`;
    if (!nextSonar) {
      this.sonarPearlsProgress.max = 1;
      this.sonarPearlsProgress.value = 1;
      this.sonarProgressLabel.textContent = 'Fully upgraded';
      this.sonarNext.textContent = 'The sonar cable is at maximum reach.';
      this.sonarUpgrade.textContent = 'MAX LEVEL';
      this.sonarUpgrade.disabled = true;
    } else {
      const sonarMissing = Math.max(0, nextSonar.cost - pearls);
      this.sonarPearlsProgress.max = nextSonar.cost;
      this.sonarPearlsProgress.value = Math.min(nextSonar.cost, pearls);
      this.sonarProgressLabel.textContent = `${Math.min(nextSonar.cost, pearls)} / ${nextSonar.cost} Pearls`;
      this.sonarNext.textContent = `Next: Lv${nextSonar.level} · ${nextSonar.length} m cable · ${nextSonar.nodes} nodes`;
      this.sonarUpgrade.textContent = this.busy ? 'Spending PEARL…' : sonarMissing ? `Need ${sonarMissing} more Pearls` : `Upgrade for ${nextSonar.cost} Pearls`;
      this.sonarUpgrade.disabled = this.busy || sonarMissing > 0;
    }
  }
}

export { ROD_TIERS, SONAR_TIERS };

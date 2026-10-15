import { needsSurfaceGuide } from './dive-visibility';
import { onLangChange, t } from './i18n';

/** Contextual ascent direction and distance, kept separate from the depth gauge's layout. */
export class SurfaceGuide {
  private depth = 0;
  private caught = 0;
  private capacity = 1;
  private outOfAir = false;
  private playing = false;

  constructor(private readonly element = document.getElementById('surface-guide')!) {
    onLangChange(() => this.paint());
  }

  update(depth: number, caught: number, capacity: number, outOfAir: boolean, playing: boolean) {
    this.depth = depth;
    this.caught = caught;
    this.capacity = capacity;
    this.outOfAir = outOfAir;
    this.playing = playing;
    this.paint();
  }

  private paint() {
    const visible = this.playing && needsSurfaceGuide(this.depth, this.caught, this.capacity, this.outOfAir);
    this.element.classList.toggle('hidden', !visible);
    if (!visible) return;
    const label = this.outOfAir ? t('↑ Surface now', '↑ 立即上浮') : t('↑ Surface to bank', '↑ 上浮入库');
    const text = `${label} · ${Math.ceil(this.depth)} m`;
    if (this.element.textContent !== text) this.element.textContent = text;
    this.element.classList.toggle('urgent', this.outOfAir);
  }
}

import { MAPS, MAP_ORDER, isUnlocked, lockProgress, mapDepth, mapPlace, mapBlurb, mapDifficulty, mapZoneLabel, type MapId, type MapProgress } from './maps';
import { t, pickName, onLangChange } from './i18n';

// The three map cards on the start card. Locked maps show what they need: the
// lifetime banked value on chain (player_state Progress) against ProgressConfig's
// threshold.

const $ = (id: string) => document.getElementById(id)!;

export class MapPicker {
  private root = $('map-picker');

  constructor(
    private progress: MapProgress,
    private onPick: (id: MapId) => void,
  ) {
    this.render();
    onLangChange(() => this.render());
  }

  render() {
    this.root.replaceChildren(
      ...MAP_ORDER.map((id) => {
        const map = MAPS[id];
        const open = isUnlocked(map, this.progress);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `map-card${id === this.progress.selected ? ' selected' : ''}${open ? '' : ' locked'}`;
        card.style.setProperty('--sky', map.sky);
        card.style.setProperty('--water', map.water[1][1]);
        card.style.setProperty('--deep', map.water[map.water.length - 1][1]);
        card.disabled = !open;

        const line = (cls: string, text: string) => {
          const el = document.createElement('div');
          el.className = cls;
          el.textContent = text;
          return el;
        };
        const swatch = document.createElement('div');
        swatch.className = 'map-swatch';
        // Two short lines under the meta, so every card keeps one line per row in the
        // three-column layout: the shelf's zones then the trench, or what unlocks the map.
        const [zones, below] = open
          ? [map.zoneLabels.map(mapZoneLabel).join(' · '), t('+ Trench ∞', '+ 海沟 ∞')]
          : [t(`🔒 Bank ${map.unlockValue} value`, `🔒 入库价值 ${map.unlockValue}`), lockProgress(this.progress)];
        card.append(
          swatch,
          line('map-name', pickName(map)),
          line('map-place small muted', mapPlace(map)),
          line('map-meta small', `${mapDifficulty(map)} · ${t('Shelf', '大陆架')} ${mapDepth(map)} m`),
          line('map-lock small', zones),
          line('map-trench small', below),
        );
        card.title = mapBlurb(map);
        card.addEventListener('click', () => this.onPick(id));
        return card;
      }),
    );
  }
}

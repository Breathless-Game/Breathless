import { MAPS, MAP_ORDER, isUnlocked, mapDepth, type MapId, type MapProgress } from './maps';

// The three map cards on the start card. Locked maps show what they need;
// the demo switch underneath opens everything for showing the game off.

const $ = (id: string) => document.getElementById(id)!;

export class MapPicker {
  private root = $('map-picker');
  private demo = $('maps-demo') as HTMLInputElement;

  constructor(
    private progress: MapProgress,
    private onPick: (id: MapId) => void,
    onDemoToggle: (on: boolean) => void,
  ) {
    this.demo.addEventListener('change', () => onDemoToggle(this.demo.checked));
    this.render();
  }

  render() {
    this.demo.checked = this.progress.unlockAll;
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
        card.append(
          swatch,
          line('map-name', `${map.name} · ${map.nameZh}`),
          line('map-place small muted', map.place),
          line('map-meta small', `${map.difficulty} · Shelf ${mapDepth(map)} m · Trench ∞`),
          line(
            'map-lock small',
            open
              ? map.zoneLabels.join(' + ')
              : `🔒 Bank ${map.unlockValue} value (you have ${Math.floor(this.progress.bestValue)})`,
          ),
        );
        card.title = map.blurb;
        card.addEventListener('click', () => this.onPick(id));
        return card;
      }),
    );
  }
}

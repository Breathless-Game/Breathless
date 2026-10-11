import type { TankTable } from './aquarium-tank';
import { coreAsset } from './explorer-links';
import { fishValue, RARITY, zoneForDepth } from './fish';
import { MAPS, type MapId } from './maps';
import type { BankedFish } from './market';
import { nftName } from './nft-uri';
import { fishIcon } from './portrait';
import { storageKey } from './wallet';

// The aquarium (图鉴): the fish you've banked, swimming in a real 3D glass tank on a
// table (aquarium-tank.ts). The table comes up the way the workbench does (the
// title's fish ride up to hang over it), then the tank drops from above and lands
// on it with a thud; leaving, the tank is lifted off and the table sinks. Every
// TANK_SIZE fish fill one tank, in the order they were caught; starred fish move
// to their own Favorites tank instead. This file runs the tanks, the favourites,
// the bar and the fish's card; the table draws and swims them.

export const TANK_SIZE = 50;
const FAVORITES_KEY = 'favorites';

export interface AquariumHooks {
  table: TankTable;
}

type TankId = number | 'fav';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function loadFavorites(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey(FAVORITES_KEY)) ?? '[]') as string[]);
  } catch {
    return new Set(); // no wallet yet, or bad data
  }
}

function saveFavorites(ids: Set<string>) {
  try {
    localStorage.setItem(storageKey(FAVORITES_KEY), JSON.stringify([...ids]));
  } catch {}
}

export class Aquarium {
  private root = $('aquarium');
  private tabs = $('aq-tabs');
  private label = $('aq-label');
  private empty = $('aq-empty');
  private card = $('aq-card');

  private favorites = new Set<string>();
  private tank: TankId = 0;
  private picked: BankedFish | null = null;
  private state: 'closed' | 'opening' | 'open' | 'closing' = 'closed';

  constructor(
    private bank: BankedFish[],
    private hooks: AquariumHooks,
  ) {
    $('aq-close').addEventListener('click', () => this.close());
    $('aq-prev').addEventListener('click', () => this.step(-1));
    $('aq-next').addEventListener('click', () => this.step(1));
    // The fish are in the table's 3D scene: hover and click land on the canvas over it.
    window.addEventListener('pointermove', (e) => {
      if (this.state !== 'open') return;
      const f = this.hooks.table.fishAt(e);
      this.hooks.table.setHover(f);
      document.body.style.cursor = f ? 'pointer' : '';
    });
    window.addEventListener('click', (e) => {
      if (this.state !== 'open' || !(e.target instanceof HTMLCanvasElement)) return;
      this.pick(this.hooks.table.fishAt(e as PointerEvent));
    });
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.key === 'ArrowLeft') this.step(-1);
      else if (e.key === 'ArrowRight') this.step(1);
    });
  }

  /** Up, or on its way up: Esc and the title's keys belong to it. */
  get open() {
    return this.state === 'opening' || this.state === 'open';
  }

  /** The table comes up; once it's there, the tank drops onto it. */
  show() {
    if (this.state !== 'closed') return;
    const table = this.hooks.table;
    this.favorites = loadFavorites(); // per wallet, so read fresh each time
    this.state = 'opening';
    this.root.classList.remove('hidden');
    this.root.classList.remove('landed');
    table.show(() => {
      if (this.state !== 'opening') return;
      table.dropTank(() => {
        this.state = 'open';
        this.root.classList.add('landed'); // the bar fades in
      });
    });
    table.hold();
    this.pick(null);
    this.setTank(0, true);
  }

  /** Esc or ×: the tank is lifted off, then the table sinks and the title's fish come back down. */
  close() {
    if (!this.open) return;
    const table = this.hooks.table;
    const wasOpen = this.state === 'open';
    this.state = 'closing';
    this.pick(null);
    this.root.classList.remove('landed');
    const sink = () =>
      table.leave(() => {
        this.state = 'closed';
        this.root.classList.add('hidden');
        document.body.style.cursor = '';
      });
    // Still up above (the table hadn't arrived, or the tank was falling): nothing to lift.
    if (wasOpen) table.liftTank(sink);
    else sink();
  }

  // ---- Tanks ------------------------------------------------------------

  /** Banked fish not starred, in catch order, TANK_SIZE to a tank (always at least one tank). */
  private regularTanks(): BankedFish[][] {
    const loose = this.bank.filter((f) => !this.favorites.has(f.id));
    const tanks: BankedFish[][] = [];
    for (let i = 0; i < loose.length; i += TANK_SIZE) tanks.push(loose.slice(i, i + TANK_SIZE));
    return tanks.length ? tanks : [[]];
  }

  private favoriteFish(): BankedFish[] {
    return this.bank.filter((f) => this.favorites.has(f.id));
  }

  private fishIn(tank: TankId): BankedFish[] {
    return tank === 'fav' ? this.favoriteFish() : (this.regularTanks()[tank] ?? []);
  }

  private order(): TankId[] {
    return [...this.regularTanks().map((_, i) => i), 'fav'];
  }

  private step(d: number) {
    const order = this.order();
    const i = order.indexOf(this.tank);
    this.setTank(order[(i + d + order.length) % order.length]);
  }

  /** Show a tank: fish no longer in it swim off (shrink away), new ones grow in where they are. */
  private setTank(tank: TankId, fresh = false) {
    const changed = tank !== this.tank || fresh;
    this.tank = tank;
    const table = this.hooks.table;
    if (fresh) table.clearFish();
    const fish = this.fishIn(tank);
    table.setFish(fish);
    if (this.picked && !fish.includes(this.picked)) this.pick(null);
    if (changed) table.setScenery(tank === 'fav' ? 0xfa7 : 0x7a4c + tank * 977, tank === 'fav');
    this.renderBar();
  }

  private renderBar() {
    const regular = this.regularTanks();
    const tabs: HTMLButtonElement[] = regular.map((_, i) => {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = `${i + 1}`;
      b.title = `Tank ${i + 1}`;
      b.classList.toggle('on', this.tank === i);
      b.addEventListener('click', () => this.setTank(i));
      return b;
    });
    const fav = document.createElement('button');
    fav.className = 'mini fav';
    fav.textContent = '★';
    fav.title = 'Favorites tank';
    fav.classList.toggle('on', this.tank === 'fav');
    fav.addEventListener('click', () => this.setTank('fav'));
    this.tabs.replaceChildren(...tabs, fav);
    tabs[this.tank === 'fav' ? -1 : this.tank]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const n = this.fishIn(this.tank).length;
    if (this.tank === 'fav') {
      this.label.textContent = `★ Favorites · 收藏 · ${n} / ${TANK_SIZE}`;
    } else {
      const first = this.tank * TANK_SIZE;
      this.label.textContent = `Tank ${this.tank + 1} · 鱼缸 · ${n ? `#${first + 1}–${first + n}` : 'empty'} · ${n} / ${TANK_SIZE}`;
    }
    this.empty.classList.toggle('hidden', n > 0);
    this.empty.textContent =
      this.tank === 'fav'
        ? 'No favorites yet. Click a fish in a tank and star it to move it here.'
        : this.bank.length
          ? 'This tank is empty.'
          : 'No fish yet. Dive, and what you bring home swims here.';
  }

  // ---- Info card --------------------------------------------------------

  private pick(f: BankedFish | null) {
    this.picked = f;
    this.hooks.table.setPicked(f);
    this.card.classList.toggle('hidden', !f);
    if (!f) return;
    const where = f.map && f.map in MAPS ? MAPS[f.map as MapId].name : zoneForDepth(f.depthM).name;
    const fav = this.favorites.has(f.id);
    const img = document.createElement('img');
    img.src = fishIcon(f);
    const body = document.createElement('div');
    const name = document.createElement('b');
    // Same label the NFT and the Collection use (name plus #serial once minted).
    name.textContent = nftName(f);
    const rarity = document.createElement('div');
    rarity.className = 'aq-rarity';
    rarity.textContent = RARITY[f.rarity].label;
    rarity.style.color = RARITY[f.rarity].color;
    const meta = document.createElement('div');
    meta.className = 'small muted';
    meta.textContent = `${f.lengthCm} cm · ${f.weightKg} kg · ${where} · ${f.depthM} m · ${fishValue(f)} pts`;
    body.append(name, rarity, meta);
    const star = document.createElement('button');
    star.className = fav ? 'mini' : 'mini primary';
    const full = !fav && this.favoriteFish().length >= TANK_SIZE;
    star.textContent = fav ? '☆ Unfavorite · 移出收藏' : full ? 'Favorites tank is full' : '★ Favorite · 收藏';
    star.disabled = full;
    star.addEventListener('click', () => this.toggleFavorite(f));
    const actions = document.createElement('div');
    actions.className = 'aq-actions';
    actions.append(star);
    if (f.nft === 'minted' && f.assetId) {
      const link = document.createElement('a');
      link.className = 'aq-chain';
      link.href = coreAsset(f.assetId);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View NFT on chain ↗';
      link.addEventListener('click', (e) => e.stopPropagation());
      actions.append(link);
    }
    const x = document.createElement('button');
    x.className = 'mini';
    x.textContent = '✕';
    x.title = 'Close';
    x.addEventListener('click', () => this.pick(null));
    this.card.replaceChildren(img, body, actions, x);
  }

  /** Starring moves the fish to the Favorites tank; it swims out of this one. */
  private toggleFavorite(f: BankedFish) {
    if (this.favorites.has(f.id)) this.favorites.delete(f.id);
    else if (this.favoriteFish().length < TANK_SIZE) this.favorites.add(f.id);
    saveFavorites(this.favorites);
    // The tank you're on may have gone (its last fish starred): fall back to the last one.
    const regular = this.regularTanks().length;
    this.setTank(this.tank !== 'fav' && this.tank >= regular ? regular - 1 : this.tank);
    if (this.picked) this.pick(this.picked);
  }
}

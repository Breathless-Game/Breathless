import * as THREE from 'three';
import type { TankTable } from './aquarium-tank';
import { coreAsset } from './explorer-links';
import { fishValue, rarityLabel, RARITY, zoneForDepth, zoneName } from './fish';
import { lang, onLangChange, pickName, t } from './i18n';
import { onPearlBalance } from './pearl-balance';
import { FISH_FOODS, fishFood, type FishFoodDef, type FishFoodId } from './fish-food';
import { buildFishFoodModel } from './fish-food-models';
import { MAPS, type MapId } from './maps';
import type { BankedFish } from './market';
import { nftName } from './nft-uri';
import { fishIcon } from './portrait';
import { storageKey } from './wallet';
import {
  AQUARIUM_STORAGE_KEY,
  feedAquariumFish,
  loadAquariumState,
  normalizeLightColor,
  saveAquariumState,
  growthScaleForGrowth,
  activeFoodEffects,
  type AquariumState,
} from './aquarium-state';

// The aquarium (图鉴): the fish you've banked, swimming in a real 3D glass tank on a
// table (aquarium-tank.ts). The table comes up the way the workbench does (the
// title's fish ride up off the screen), then the tank drops from above and lands on
// it with a thud; leaving, the tank is lifted off and the table sinks. Every
// TANK_SIZE fish fill one tank, in the order they were caught; starred fish move to
// their own Favorites tank instead. Double-click the tank to look down into it.
// Food bought in PEARL is poured in: it sinks, the school rushes over, and fed fish
// grow (and some glow) in the aquarium only; the NFT stays as caught. The ambience
// light tints the lamp and the water. This file runs the tanks, favourites, feeder,
// bar and card; the table draws the tank and swims the fish.

export const TANK_SIZE = 10;
/** Compatibility alias for callers that still display the default pellet cost. */
export const AQUARIUM_FOOD_COST = fishFood('pellet').price;
const FAVORITES_KEY = 'favorites';

export interface AquariumHooks {
  /** The table and tank (aquarium-tank.ts). */
  table: TankTable;
  /**
   * Pay for one food in on-chain PEARL, like gear upgrades.
   * Resolves with the PEARL burned, or null when nothing was spent: the fish is fed only then.
   */
  buyFood(food: FishFoodDef): Promise<number | null>;
  /** Spendable Pearls (the cached on-chain PEARL balance), for the feed button's affordability state. */
  pearls(): number;
  message(text: string): void;
  /** Open the Collection (the C panel) on top of the aquarium, to sell, burn or list fish. */
  openCollection(): void;
  /** Close the Collection again (C while it sits over the tank, same as Esc). */
  closeCollection(): void;
}

type TankId = number | 'fav';

interface FoodPreview {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  model: THREE.Group | null;
}

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
  private t = 0;
  private raf = 0;
  private last = 0;
  private aquariumState: AquariumState = loadAquariumState();
  private lightInput = $<HTMLInputElement>('aq-light');
  private feederModel = $('aq-feeder-model');
  private foodPicker = $('aq-food-picker');
  private foodTrigger = $<HTMLButtonElement>('aq-food-trigger');
  private foodList = $('aq-food-list');
  private foodActive = 0;
  private feederButton = $<HTMLButtonElement>('aq-feed-all');
  private feederStatus = $('aq-feed-status');
  private feeding = false;
  private selectedFood: FishFoodId = 'plankton';
  private foodPreview: FoodPreview | null = null;

  constructor(
    private bank: BankedFish[],
    private hooks: AquariumHooks,
  ) {
    const table = hooks.table;
    // How feeding has changed each fish, for the 3D tank (size, glow, speed).
    table.look = (f) => {
      const growth = this.aquariumState.growth[f.id];
      const effects = activeFoodEffects(growth);
      return { scale: growthScaleForGrowth(growth), glow: effects.glow, speed: effects.speed };
    };
    onLangChange(() => {
      this.renderBar();
      this.renderFoodOptions();
      this.renderFeederText();
      if (this.picked) this.pick(this.picked);
    });
    // The balance often lands after show(): re-render the Pour button's affordability whenever it moves.
    onPearlBalance(() => this.renderFeederButton());
    $('aq-close').addEventListener('click', () => this.close());
    $('aq-manage').addEventListener('click', () => this.manageFish());
    $('aq-prev').addEventListener('click', () => this.step(-1));
    $('aq-next').addEventListener('click', () => this.step(1));
    this.lightInput.addEventListener('input', () => {
      this.aquariumState = {
        ...this.aquariumState,
        light: { color: normalizeLightColor(this.lightInput.value) },
      };
      table.setLight(this.aquariumState.light.color);
      saveAquariumState(this.aquariumState, undefined, this.stateKey());
    });
    this.renderFoodOptions();
    this.initFoodPicker();
    this.feederButton.addEventListener('click', () => void this.feedSchool());
    // The fish are in the table's 3D scene: hover, click and double-click land on the canvas over it.
    window.addEventListener('pointermove', (e) => {
      if (this.state !== 'open') return;
      const f = this.overScene(e) ? table.fishAt(e) : null;
      table.setHover(f);
      document.body.style.cursor = f ? 'pointer' : '';
    });
    window.addEventListener('click', (e) => {
      if (this.state !== 'open' || !this.overScene(e)) return;
      this.pick(table.fishAt(e));
    });
    window.addEventListener('dblclick', (e) => {
      // Look down into the tank, or back to the front.
      if (this.state !== 'open' || !this.overScene(e)) return;
      e.preventDefault();
      table.setTopView(!table.topView);
    });
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const plainC = e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (this.collectionOpen()) {
        // C closes the Collection it opened over the tank. Handled here (not in main.ts) so
        // one key press can't close it and then reopen it in the same dispatch.
        if (plainC && !typing) {
          e.preventDefault();
          if (!e.repeat) this.hooks.closeCollection();
        }
        return;
      }
      if (plainC && !this.foodPickerOpen() && !typing) {
        e.preventDefault();
        if (!e.repeat) this.manageFish();
      } else if (e.key === 'ArrowLeft') this.step(-1);
      else if (e.key === 'ArrowRight') this.step(1);
    });
    // Text only: the 3D food preview (a WebGL context) is built on the first show().
    this.renderFeederText();
  }

  /** Up, or on its way up: Esc and the title's keys belong to it. */
  get open() {
    return this.state === 'opening' || this.state === 'open';
  }

  /** A pointer on the scene itself, not on the bar, the card, the feeder or the Collection. */
  private overScene(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    if (this.collectionOpen()) return false;
    return !el?.closest('#aq-card, .aq-bar, #aq-feeder, button, a, input, select');
  }

  /** The table comes up; once it's there, the tank drops onto it. */
  show() {
    if (this.state !== 'closed') return;
    const table = this.hooks.table;
    this.favorites = loadFavorites(); // per wallet, so read fresh each time
    this.aquariumState = loadAquariumState(undefined, this.stateKey());
    this.lightInput.value = this.aquariumState.light.color;
    table.setLight(this.aquariumState.light.color);
    this.renderFeeder();
    this.state = 'opening';
    this.root.classList.remove('hidden', 'landed');
    table.show(() => {
      if (this.state !== 'opening') return;
      table.dropTank(() => {
        if (this.state !== 'opening') return;
        this.state = 'open';
        this.root.classList.add('landed'); // the bar and the feeder fade in
      });
    });
    table.hold();
    this.pick(null);
    this.setTank(0, true);
    // Spins the food model in the feeder while the aquarium is up.
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  private frame(now: number) {
    if (this.state === 'closed') return;
    this.t += Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    if (this.foodPreview?.model) {
      this.foodPreview.model.rotation.y = this.t * 0.8;
      this.foodPreview.renderer.render(this.foodPreview.scene, this.foodPreview.camera);
    }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Esc or ×: the tank is lifted off, then the table sinks and the title's fish come back down. */
  close() {
    if (!this.open) return;
    const table = this.hooks.table;
    const landed = this.state === 'open';
    this.setFoodPickerOpen(false);
    this.state = 'closing';
    this.pick(null);
    this.root.classList.remove('landed');
    if (table.topView) table.setTopView(false);
    const sink = () =>
      table.leave(() => {
        this.state = 'closed';
        this.root.classList.add('hidden');
        document.body.style.cursor = '';
      });
    if (landed) table.liftTank(sink);
    else sink();
  }

  private collectionOpen() {
    return !document.getElementById('collection')!.classList.contains('hidden');
  }

  /** Open the Collection over the tank; the tank sleeps (inert) until it closes, then re-reads the bank. */
  private manageFish() {
    if (this.state !== 'open' || this.collectionOpen()) return;
    this.setFoodPickerOpen(false);
    const panel = document.getElementById('collection')!;
    panel.classList.add('over-aquarium');
    this.root.inert = true;
    this.hooks.openCollection();
    if (!this.collectionOpen()) {
      panel.classList.remove('over-aquarium');
      this.root.inert = false;
      return;
    }
    const watch = new MutationObserver(() => {
      if (this.collectionOpen()) return;
      watch.disconnect();
      panel.classList.remove('over-aquarium');
      this.root.inert = false;
      this.refreshFromBank();
    });
    watch.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  /** Sold, burned or newly listed fish left or joined the bank: re-lay the tanks, count and label. */
  private refreshFromBank() {
    const order = this.order();
    this.setTank(order.includes(this.tank) ? this.tank : order[order.length - 2] ?? 'fav');
  }

  private stateKey() {
    try {
      return storageKey(AQUARIUM_STORAGE_KEY);
    } catch {
      return AQUARIUM_STORAGE_KEY;
    }
  }

  private disposeFoodPreview(disposeRenderer = false) {
    if (!this.foodPreview) return;
    const { renderer, scene, model } = this.foodPreview;
    if (model) {
      const materials = new Set<THREE.Material>();
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => materials.add(material));
      });
      materials.forEach((material) => material.dispose());
      scene.remove(model);
      this.foodPreview.model = null;
    }
    if (disposeRenderer) {
      // dispose() alone keeps the WebGL context alive until GC; browsers cap live
      // contexts (~16) and then drop the oldest, which can be the game's own.
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
      this.foodPreview = null;
    }
  }

  /** Custom picker (no native select): name and price on separate lines so nothing clips. */
  private renderFoodOptions() {
    const pearls = this.hooks.pearls();
    this.foodList.replaceChildren(...FISH_FOODS.map((food, i) => {
      const option = document.createElement('li');
      option.id = `aq-food-opt-${food.id}`;
      option.className = 'aq-picker-option';
      option.setAttribute('role', 'option');
      option.dataset.food = food.id;
      const selected = food.id === this.selectedFood;
      const short = pearls < food.price;
      option.setAttribute('aria-selected', String(selected));
      option.classList.toggle('selected', selected);
      option.classList.toggle('active', i === this.foodActive);
      option.classList.toggle('short', short);
      const name = document.createElement('span');
      name.className = 'aq-picker-name';
      name.textContent = pickName(food);
      const price = document.createElement('span');
      price.className = 'aq-picker-price';
      price.textContent = `${food.price} PEARL`;
      if (short) {
        const hint = document.createElement('em');
        hint.textContent = t('not enough', '余额不足');
        price.append(hint);
      }
      option.append(name, price);
      return option;
    }));
    const food = fishFood(this.selectedFood);
    const label = document.createElement('span');
    label.className = 'aq-picker-name';
    label.textContent = pickName(food);
    const price = document.createElement('span');
    price.className = 'aq-picker-price';
    price.textContent = `${food.price} PEARL`;
    this.foodTrigger.replaceChildren(label, price);
    this.foodTrigger.setAttribute('aria-label', `${t('Choose fish food', '选择鱼食')}: ${pickName(food)}, ${food.price} PEARL`);
    this.foodList.setAttribute('aria-label', t('Fish food', '鱼食'));
    this.foodList.setAttribute('aria-activedescendant', `aq-food-opt-${FISH_FOODS[this.foodActive].id}`);
  }

  private foodPickerOpen() {
    return !this.foodList.classList.contains('hidden');
  }

  private setFoodPickerOpen(open: boolean) {
    if (open === this.foodPickerOpen()) return;
    if (open) {
      this.foodActive = Math.max(0, FISH_FOODS.findIndex((food) => food.id === this.selectedFood));
      this.renderFoodOptions();
      this.foodList.classList.remove('hidden', 'up');
      this.foodList.style.maxHeight = '';
      // Flip upward when the list would run off the bottom of the viewport; scroll if neither side fits.
      const height = this.foodList.getBoundingClientRect().height;
      const triggerRect = this.foodTrigger.getBoundingClientRect();
      const below = window.innerHeight - triggerRect.bottom - 12;
      const above = triggerRect.top - 12;
      const up = height > below && above > below;
      this.foodList.classList.toggle('up', up);
      this.foodList.style.maxHeight = `${Math.max(120, Math.min(height, up ? above : below))}px`;
      this.foodTrigger.setAttribute('aria-expanded', 'true');
      this.foodList.focus({ preventScroll: true });
      this.scrollActiveFoodIntoView();
    } else {
      this.foodList.classList.add('hidden');
      this.foodList.style.maxHeight = '';
      this.foodTrigger.setAttribute('aria-expanded', 'false');
    }
  }

  private scrollActiveFoodIntoView() {
    const id = `aq-food-opt-${FISH_FOODS[this.foodActive].id}`;
    this.foodList.querySelectorAll('.aq-picker-option').forEach((el) => el.classList.toggle('active', el.id === id));
    this.foodList.setAttribute('aria-activedescendant', id);
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }

  private chooseFood(id: FishFoodId) {
    if (!FISH_FOODS.some((food) => food.id === id)) return;
    this.selectedFood = id;
    this.setFoodPickerOpen(false);
    this.foodTrigger.focus({ preventScroll: true });
    this.renderFeeder();
    this.renderCardFoodHint();
  }

  private initFoodPicker() {
    this.foodTrigger.addEventListener('click', () => this.setFoodPickerOpen(!this.foodPickerOpen()));
    this.foodList.addEventListener('click', (e) => {
      const option = (e.target as HTMLElement).closest<HTMLElement>('[data-food]');
      if (option) this.chooseFood(option.dataset.food as FishFoodId);
    });
    this.foodList.addEventListener('pointermove', (e) => {
      const option = (e.target as HTMLElement).closest<HTMLElement>('[data-food]');
      const i = FISH_FOODS.findIndex((food) => food.id === option?.dataset.food);
      if (i >= 0 && i !== this.foodActive) {
        this.foodActive = i;
        this.scrollActiveFoodIntoView();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.foodPickerOpen() && !this.foodPicker.contains(e.target as Node)) this.setFoodPickerOpen(false);
    });
    // Capture phase on window: Esc closes only the picker, before main.ts's handler can close the whole tank.
    window.addEventListener('keydown', (e) => {
      if (!this.foodPickerOpen()) {
        if (this.open && document.activeElement === this.foodTrigger && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          e.stopPropagation();
          this.setFoodPickerOpen(true);
        }
        return;
      }
      const last = FISH_FOODS.length - 1;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.setFoodPickerOpen(false);
        this.foodTrigger.focus({ preventScroll: true });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        this.foodActive = e.key === 'Home' ? 0 : e.key === 'End' ? last
          : Math.min(last, Math.max(0, this.foodActive + (e.key === 'ArrowDown' ? 1 : -1)));
        this.scrollActiveFoodIntoView();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.stopPropagation(); // do not swap the fish under the open list
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.chooseFood(FISH_FOODS[this.foodActive].id);
      } else if (e.key === 'Tab') {
        this.setFoodPickerOpen(false);
      }
    }, true);
  }

  private renderFeederText() {
    const food = fishFood(this.selectedFood);
    const description = lang() === 'zh' ? food.descriptionZh : food.description;
    this.feederStatus.textContent = `${description}${lang() === 'zh' ? '' : ' '}${t('The whole school will rush in.', '所有鱼会游来抢食。')}`;
    this.renderFeederButton();
  }

  /** The Pour button alone: label, affordability and the in-flight lock. */
  private renderFeederButton() {
    const food = fishFood(this.selectedFood);
    this.renderFoodOptions();
    const pearls = this.hooks.pearls();
    const affordable = pearls >= food.price;
    this.feederButton.textContent = affordable
      ? `${t('Pour into tank', '倒入鱼缸')} · ${pickName(food)} · ${food.price} PEARL`
      : t(`Need ${food.price - pearls} more PEARL`, `还差 ${food.price - pearls} PEARL`);
    this.feederButton.title = `${food.price} PEARL`;
    // Locked while a payment is in flight so rapid clicks cannot pay twice; feedSchool() clears the lock before re-rendering.
    this.feederButton.disabled = !affordable || this.feeding;
  }

  private renderFeeder() {
    const food = fishFood(this.selectedFood);
    this.renderFeederText();
    // Swap the model, keep the renderer: one WebGL context for the Aquarium's whole life.
    this.disposeFoodPreview();
    const modelCanvas = this.makeFoodPreview(food);
    if (modelCanvas) {
      modelCanvas.setAttribute('aria-label', t(`${food.name} · click to pour into the tank`, `${food.nameZh} · 点击倒入鱼缸`));
      if (modelCanvas.parentElement !== this.feederModel) this.feederModel.replaceChildren(modelCanvas);
    } else {
      this.feederModel.replaceChildren();
    }
  }

  /** Render the selected food as a small, real low-poly Three.js model in the fish card. */
  private makeFoodPreview(food: FishFoodDef): HTMLCanvasElement | null {
    try {
      // Rebuild only if the browser took the context away (e.g. too many live contexts).
      if (this.foodPreview?.renderer.getContext().isContextLost()) this.disposeFoodPreview(true);
      if (!this.foodPreview) {
        // One context is shared across selections and reopenings instead of creating
        // one each time. A closed aquarium stops rendering but keeps the renderer.
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.domElement.className = 'aq-food-model';
        // Added once, with the canvas: renderFeeder() runs again on every selection.
        renderer.domElement.addEventListener('click', () => void this.feedSchool());
        renderer.domElement.setAttribute('aria-label', `${food.name} 3D model`);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(96, 96, false);
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight('#e3ffff', '#102a36', 2.2));
        const key = new THREE.DirectionalLight('#ffffff', 2.8);
        key.position.set(2, 3, 4);
        scene.add(key);
        this.foodPreview = { renderer, scene, camera: new THREE.PerspectiveCamera(28, 1, 0.01, 20), model: null };
      }
      const { renderer, scene, camera } = this.foodPreview;
      renderer.domElement.setAttribute('aria-label', `${food.name} 3D model`);
      const model = buildFishFoodModel(food.modelKey, food.tier);
      scene.add(model);
      const box = new THREE.Box3().setFromObject(model);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      // Wrap it so rotating a model with an offset head/tail keeps its centre still.
      model.position.sub(centre);
      const holder = new THREE.Group();
      holder.add(model);
      scene.add(holder);
      camera.position.set(1, 0.7, 1.4).normalize().multiplyScalar(size.length() * 2.5);
      camera.lookAt(0, 0, 0);
      this.foodPreview.model = holder;
      renderer.render(scene, camera);
      return renderer.domElement;
    } catch {
      this.disposeFoodPreview(true);
      return null;
    }
  }

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

  /** Show a tank: the table swaps its school (fish not in it swim off, new ones swim in). */
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
      b.title = t(`Tank ${i + 1}`, `鱼缸 ${i + 1}`);
      b.classList.toggle('on', this.tank === i);
      b.addEventListener('click', () => this.setTank(i));
      return b;
    });
    const fav = document.createElement('button');
    fav.className = 'mini fav';
    fav.textContent = '★';
    fav.title = t('Favorites tank', '收藏鱼缸');
    fav.classList.toggle('on', this.tank === 'fav');
    fav.addEventListener('click', () => this.setTank('fav'));
    this.tabs.replaceChildren(...tabs, fav);
    tabs[this.tank === 'fav' ? -1 : this.tank]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const n = this.fishIn(this.tank).length;
    if (this.tank === 'fav') {
      this.label.textContent = t(`★ Favorites · ${n} / ${TANK_SIZE}`, `★ 收藏 · ${n} / ${TANK_SIZE}`);
    } else {
      const first = this.tank * TANK_SIZE;
      this.label.textContent = t(`Tank ${this.tank + 1} · ${n ? `#${first + 1}–${first + n}` : 'empty'} · ${n} / ${TANK_SIZE}`, `鱼缸 ${this.tank + 1} · ${n ? `#${first + 1}–${first + n}` : '空'} · ${n} / ${TANK_SIZE}`);
    }
    this.empty.classList.toggle('hidden', n > 0);
    this.empty.textContent =
      this.tank === 'fav'
        ? t('No favorites yet. Click a fish in a tank and star it to move it here.', '还没有收藏。点一条鱼并加星，它就会来到这里。')
        : this.bank.length
          ? t('This tank is empty.', '这个鱼缸是空的。')
          : t('No fish yet. Dive, and what you bring home swims here.', '还没有鱼。下潜一趟，带回家的鱼会游在这里。');
  }

  private pick(f: BankedFish | null) {
    this.picked = f;
    this.hooks.table.setPicked(f);
    this.card.classList.toggle('hidden', !f);
    if (!f) return;
    const where = f.map && f.map in MAPS ? pickName(MAPS[f.map as MapId]) : zoneName(zoneForDepth(f.depthM));
    const fav = this.favorites.has(f.id);
    const img = document.createElement('img');
    img.src = fishIcon(f);
    const body = document.createElement('div');
    const name = document.createElement('b');
    // Same label the NFT and the Collection use (name plus #serial once minted).
    name.textContent = nftName(f);
    const rarity = document.createElement('div');
    rarity.className = 'aq-rarity';
    rarity.textContent = rarityLabel(f.rarity);
    rarity.style.color = RARITY[f.rarity].color;
    const meta = document.createElement('div');
    meta.className = 'small muted';
    const growth = this.aquariumState.growth[f.id];
    const feeds = growth?.feedCount ?? 0;
    const scale = growthScaleForGrowth(growth);
    meta.textContent = `${Math.round(f.lengthCm * scale)} cm · ${f.weightKg} kg · ${where} · ${f.depthM} m · ${fishValue(f)} pts`;
    body.append(name, rarity, meta);
    if (feeds > 0) {
      const grown = document.createElement('div');
      grown.className = 'aq-growth';
      grown.textContent = t(`Grown +${Math.round((scale - 1) * 100)}% · fed ${feeds}`, `已长大 +${Math.round((scale - 1) * 100)}% · 喂食 ${feeds}`);
      body.append(grown);
    }
    const foodHint = document.createElement('div');
    foodHint.className = 'aq-card-food-hint';
    foodHint.textContent = t('Choose food beside the tank', '在鱼缸旁选择鱼食');
    body.append(foodHint);
    const star = document.createElement('button');
    star.className = fav ? 'mini' : 'mini primary';
    const full = !fav && this.favoriteFish().length >= TANK_SIZE;
    star.textContent = fav ? t('☆ Unfavorite', '☆ 移出收藏') : full ? t('Favorites tank is full', '收藏鱼缸已满') : t('★ Favorite', '★ 收藏');
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
      link.textContent = t('View NFT on chain ↗', '在链上查看 NFT ↗');
      link.addEventListener('click', (e) => e.stopPropagation());
      actions.append(link);
    }
    const x = document.createElement('button');
    x.className = 'mini';
    x.textContent = '✕';
    x.title = t('Close', '关闭');
    x.addEventListener('click', () => this.pick(null));
    this.card.replaceChildren(img, body, actions, x);
  }

  private renderCardFoodHint() {
    const hint = this.card.querySelector<HTMLElement>('.aq-card-food-hint');
    if (hint) hint.textContent = t(`Selected: ${pickName(fishFood(this.selectedFood))} · click the food beside the tank to feed all fish`, `已选：${pickName(fishFood(this.selectedFood))} · 点击鱼缸旁的鱼食喂所有鱼`);
  }

  private async feedSchool() {
    const food = fishFood(this.selectedFood);
    const fish = this.fishIn(this.tank);
    if (!fish.length) {
      this.hooks.message(t('There are no fish in this tank', '当前鱼缸没有鱼'));
      return;
    }
    if (this.feeding) return;
    const now = Date.now();
    let next = this.aquariumState;
    let fedCount = 0;
    let blockedReason: 'max' | 'cooldown' | null = null;
    for (const f of fish) {
      const result = feedAquariumFish(next, f.id, food.id, now);
      if (result.fed) {
        next = result.state;
        fedCount++;
      } else if (result.reason === 'max' || result.reason === 'cooldown') {
        blockedReason = blockedReason ?? result.reason;
      }
    }
    if (!fedCount) {
      this.hooks.message(blockedReason === 'max' ? t('Every fish here is fully grown', '这里的鱼都长到最大了') : t('The school is still full', '鱼群还在饱腹冷却'));
      return;
    }
    if (this.hooks.pearls() < food.price) {
      this.hooks.message(t(`Need ${food.price - this.hooks.pearls()} more PEARL`, `还差 ${food.price - this.hooks.pearls()} PEARL`));
      this.renderFeederButton();
      return;
    }
    this.feeding = true;
    this.renderFeederButton();
    try {
      const paid = await this.hooks.buyFood(food);
      if (!paid) return;
      this.aquariumState = { ...next, light: { ...this.aquariumState.light } };
      saveAquariumState(this.aquariumState, undefined, this.stateKey());
      // Flakes sink from the surface and the school rushes over; each fed fish swells as it grows.
      const table = this.hooks.table;
      table.pourFood();
      for (const f of fish) if (this.aquariumState.growth[f.id]?.feedCount) table.pulse(f);
      this.feederStatus.textContent = t(`${fedCount} fish are rushing in · ${pickName(food)} is sinking`, `${fedCount} 条鱼正在冲过来 · ${pickName(food)} 正在下落`);
      this.hooks.message(t(`${fedCount} fish rushed in for food · ${spentText(paid)}`, `${fedCount} 条鱼正在抢食 · ${spentText(paid)}`));
    } finally {
      // Release the lock before re-rendering: the feeder renders disabled while `feeding` is set,
      // so this must run on success, on a declined/failed payment (null) and on a throw.
      this.feeding = false;
      this.renderFeederButton();
      if (this.picked) this.pick(this.picked);
    }
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

/** What a feeding cost: on-chain PEARL burned. */
export function spentText(burned: number): string {
  return `−${burned} PEARL`;
}

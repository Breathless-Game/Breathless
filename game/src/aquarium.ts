import * as THREE from 'three';
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
import { Rng } from './rng';
import { storageKey } from './wallet';
import {
  AQUARIUM_STORAGE_KEY,
  DEFAULT_AQUARIUM_LIGHT,
  feedAquariumFish,
  loadAquariumState,
  normalizeLightColor,
  saveAquariumState,
  growthScaleForGrowth,
  activeFoodEffects,
  type AquariumState,
} from './aquarium-state';

// The aquarium (图鉴): the fish you've banked, swimming in a 2.5D glass tank. It comes
// in the way the workbench does: the camera pans down, the title's rope and fish ride
// straight up off the screen, and the tank rises into view from below. Every TANK_SIZE
// fish fill one tank, in the order they were caught; starred fish move to their own
// Favorites tank instead.
// Drawn on a 2D canvas: the tank is a box seen in one-point perspective, and each
// fish is its rendered sprite placed at a depth (smaller, dimmer further back).

export const TANK_SIZE = 50;
/** Compatibility alias for callers that still display the default pellet cost. */
export const AQUARIUM_FOOD_COST = fishFood('pellet').price;
const FAVORITES_KEY = 'favorites';
const ICONS_PER_FRAME = 3; // sprites rendered per frame while a tank fills, so opening never stalls
// The pan in and out, as long as the workbench's.
const OPEN_S = 1.15;
const CLOSE_S = 0.9;
const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export interface AquariumHooks {
  /** 0 = the title, 1 = the aquarium: the title lifts its rope away and the sea camera sinks. */
  pan(u: number): void;
  /**
   * Pay for one food in on-chain PEARL, like gear upgrades.
   * Resolves with the PEARL burned, or null when nothing was spent: the fish is fed only then.
   */
  buyFood(food: FishFoodDef): Promise<number | null>;
  /** Spendable Pearls (the cached on-chain PEARL balance), for the feed button's affordability state. */
  pearls(): number;
  message(text: string): void;
}

// Tank box: where its front glass sits on the canvas (in fractions) when it faces you,
// how much smaller the back wall looks, and the eye height on the canvas (a little
// above the tank, so the floor and the water surface show). The box sways about its
// vertical centre line after the mouse, at most MAX_YAW either way.
const FRONT = { x0: 0.05, x1: 0.95, y0: 0.1, y1: 0.86 };
const BACK_SCALE = 0.72;
const VANISH_Y = 0.02;
const MAX_YAW = 0.09;
const YAW_EASE = 3; // per second: slow enough that it swings rather than snaps
const SURFACE = 0.07; // water line, as a fraction of the tank's height
// Where fish swim, in tank space (x, y: 0..1 across and down the front glass; z: 0 front .. 1 back).
const SWIM = { x0: 0.07, x1: 0.93, y0: 0.17, y1: 0.84, z0: 0.04, z1: 0.94 };

type TankId = number | 'fav';

interface Swimmer {
  fish: BankedFish;
  img: HTMLImageElement | null;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  tx: number;
  ty: number;
  tz: number;
  face: number; // -1..1: which way it faces; passing 0 is the fish turning edge-on
  size: number; // 0..1 by length
  speed: number;
  phase: number;
  alpha: number;
  leaving: boolean;
  growthPulse: number;
  glowIntensity: number;
}

interface FoodPreview {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  model: THREE.Group | null;
}

interface Plant {
  x: number;
  z: number;
  h: number;
  hue: number;
  blades: number;
  phase: number;
}

interface Bubble {
  x: number;
  y: number;
  z: number;
  r: number;
  v: number;
}

interface FoodDrop {
  x: number;
  y: number;
  z: number;
  life: number;
  count: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

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
  private stage = this.root.querySelector<HTMLElement>('.aq-stage')!;
  private bar = this.root.querySelector<HTMLElement>('.aq-bar')!;
  private canvas = $<HTMLCanvasElement>('aq-canvas');
  private tankEl = this.canvas.parentElement!;
  private ctx = this.canvas.getContext('2d')!;
  private tabs = $('aq-tabs');
  private label = $('aq-label');
  private empty = $('aq-empty');
  private card = $('aq-card');

  private favorites = new Set<string>();
  private tank: TankId = 0;
  private swimmers = new Map<BankedFish, Swimmer>();
  private plants: Plant[] = [];
  private bubbles: Bubble[] = [];
  private picked: Swimmer | null = null;
  private hover: Swimmer | null = null;
  private w = 0;
  private h = 0;
  private t = 0;
  private slosh = 0;
  private last = 0;
  private raf = 0;
  private state: 'closed' | 'opening' | 'open' | 'closing' = 'closed';
  private panU = 0;
  private tween: { t: number; dur: number; from: number; to: number } | null = null;
  private yaw = 0; // radians the tank is turned; + brings its right side toward you
  private yawTarget = 0;
  // 0 is the normal eye-level view, 1 is a plan view looking down through the water.
  // It eases between the two so a double-click feels like turning the tank over rather
  // than snapping the fish and glass to a new projection.
  private view = 0;
  private viewTarget = 0;
  private aquariumState: AquariumState = { growth: {}, light: { color: DEFAULT_AQUARIUM_LIGHT } };
  private lightInput = $<HTMLInputElement>('aq-light');
  private lightRgb = this.parseRgb(DEFAULT_AQUARIUM_LIGHT);
  private feederModel = $('aq-feeder-model');
  private feederSelect = $<HTMLSelectElement>('aq-food-select');
  private feederButton = $<HTMLButtonElement>('aq-feed-all');
  private feederStatus = $('aq-feed-status');
  private feeding = false;
  private selectedFood: FishFoodId = 'plankton';
  private foodPreview: FoodPreview | null = null;
  private foodDrop: FoodDrop | null = null;

  constructor(
    private bank: BankedFish[],
    private hooks: AquariumHooks,
  ) {
    onLangChange(() => {
      this.renderBar();
      this.renderFoodOptions();
      this.renderFeederText();
      if (this.picked) this.pick(this.picked);
    });
    // The balance often lands after show(): re-render the Pour button's affordability whenever it moves.
    // While a payment is in flight renderFeederButton() keeps it locked, so no extra guard is needed.
    onPearlBalance(() => this.renderFeederButton());
    $('aq-close').addEventListener('click', () => this.close());
    $('aq-prev').addEventListener('click', () => this.step(-1));
    $('aq-next').addEventListener('click', () => this.step(1));
    this.lightInput.addEventListener('input', () => {
      this.aquariumState = {
        ...this.aquariumState,
        light: { color: normalizeLightColor(this.lightInput.value) },
      };
      this.setAmbientColor(this.aquariumState.light.color);
      saveAquariumState(this.aquariumState, undefined, this.stateKey());
    });
    this.renderFoodOptions();
    this.feederSelect.addEventListener('change', () => {
      const selected = this.feederSelect.value as FishFoodId;
      if (!FISH_FOODS.some((food) => food.id === selected)) return;
      this.selectedFood = selected;
      this.renderFeeder();
      this.renderCardFoodHint();
    });
    this.feederButton.addEventListener('click', () => void this.feedSchool());
    this.canvas.addEventListener('pointermove', (e) => {
      this.hover = this.fishAt(e);
      this.canvas.style.cursor = this.hover ? 'pointer' : '';
    });
    this.canvas.addEventListener('pointerleave', () => (this.hover = null));
    this.canvas.addEventListener('click', (e) => this.pick(this.fishAt(e)));
    this.tankEl.addEventListener('dblclick', (e) => {
      // The info card sits above the canvas. Let a double-click anywhere on the tank
      // switch views, but keep its buttons and links as normal controls.
      if ((e.target as HTMLElement).closest('#aq-card, button, a, input')) return;
      e.preventDefault();
      this.viewTarget = this.viewTarget > 0.5 ? 0 : 1;
      this.canvas.classList.toggle('top-view', this.viewTarget > 0.5);
    });
    // The tank sways gently after the mouse, like a card tilting under it: the side
    // the mouse is on leans away a little.
    window.addEventListener('pointermove', (e) => {
      if (!this.open) return;
      this.yawTarget = -clamp((e.clientX / window.innerWidth) * 2 - 1, -1, 1) * MAX_YAW;
    });
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.key === 'ArrowLeft') this.step(-1);
      else if (e.key === 'ArrowRight') this.step(1);
    });
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.renderFeeder();
  }

  private parseRgb(hex: string) {
    const value = hex.replace('#', '');
    return {
      r: Number.parseInt(value.slice(0, 2), 16),
      g: Number.parseInt(value.slice(2, 4), 16),
      b: Number.parseInt(value.slice(4, 6), 16),
    };
  }

  private setAmbientColor(hex: string) {
    this.lightRgb = this.parseRgb(normalizeLightColor(hex));
  }

  private ambientCss(alpha: number, mix = 1) {
    const r = Math.round(255 * (1 - mix) + this.lightRgb.r * mix);
    const g = Math.round(255 * (1 - mix) + this.lightRgb.g * mix);
    const b = Math.round(255 * (1 - mix) + this.lightRgb.b * mix);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private mixHex(hex: string, amount: number) {
    const base = this.parseRgb(hex);
    const t = clamp(amount, 0, 1);
    return `rgb(${Math.round(base.r + (this.lightRgb.r - base.r) * t)}, ${Math.round(base.g + (this.lightRgb.g - base.g) * t)}, ${Math.round(base.b + (this.lightRgb.b - base.b) * t)})`;
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
      renderer.dispose();
      this.foodPreview = null;
    }
  }

  private renderFoodOptions() {
    this.feederSelect.replaceChildren(...FISH_FOODS.map((food) => {
      const option = document.createElement('option');
      option.value = food.id;
      option.textContent = `${pickName(food)} · ${food.price} PEARL`;
      return option;
    }));
    this.feederSelect.value = this.selectedFood;
  }

  /** Feeder status text plus the Pour button; re-run on language change and food selection. */
  private renderFeederText() {
    const food = fishFood(this.selectedFood);
    this.feederSelect.value = food.id;
    const description = lang() === 'zh' ? food.descriptionZh : food.description;
    this.feederStatus.textContent = `${description} · ${t('the whole school will rush in', '所有鱼会游来抢食')}`;
    this.renderFeederButton();
  }

  /** The Pour button alone: label, affordability and the in-flight lock. */
  private renderFeederButton() {
    const food = fishFood(this.selectedFood);
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
    this.disposeFoodPreview();
    this.feederModel.replaceChildren();
    const modelCanvas = this.makeFoodPreview(food);
    if (modelCanvas) {
      modelCanvas.setAttribute('aria-label', t(`${food.name} · click to pour into the tank`, `${food.nameZh} · 点击倒入鱼缸`));
      modelCanvas.addEventListener('click', () => void this.feedSchool());
      this.feederModel.append(modelCanvas);
    }
  }

  /** Render the selected food as a small, real low-poly Three.js model in the fish card. */
  private makeFoodPreview(food: FishFoodDef): HTMLCanvasElement | null {
    try {
      if (!this.foodPreview) {
        // One context is shared across selections instead of creating one on
        // each click. Hidden cards stop rendering but retain the renderer.
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.domElement.className = 'aq-food-model';
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

  /** Up, or on its way up: Esc and the title's keys belong to it. */
  get open() {
    return this.state === 'opening' || this.state === 'open';
  }

  /** Pan down from the title: its fish ride up out of sight and the tank rises from below. */
  show() {
    if (this.open) return;
    if (this.state === 'closed') {
      this.yaw = this.yawTarget = 0;
      this.view = this.viewTarget = 0;
      this.canvas.classList.remove('top-view');
      this.favorites = loadFavorites(); // per wallet, so read fresh each time
      this.aquariumState = loadAquariumState(undefined, this.stateKey());
      this.lightInput.value = this.aquariumState.light.color;
      this.setAmbientColor(this.aquariumState.light.color);
      this.renderFeeder();
      this.swimmers.clear();
      this.foodDrop = null;
      this.pick(null);
      this.setTank(0, true);
    }
    this.root.classList.remove('hidden');
    this.state = 'opening';
    this.animate(1, OPEN_S);
    this.resize();
    if (!this.raf) {
      this.last = performance.now();
      const loop = (now: number) => {
        this.frame(Math.min((now - this.last) / 1000, 0.05));
        this.last = now;
        if (this.state !== 'closed') this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  /** Esc or ×: the tank sinks away and the title's fish come back down. */
  close() {
    if (!this.open) return;
    this.disposeFoodPreview(true);
    this.state = 'closing';
    this.foodDrop = null;
    this.animate(0, CLOSE_S);
  }

  private animate(to: number, dur: number) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.tween = { t: 0, dur: reduced ? 0.01 : dur, from: this.panU, to };
  }

  /** The tank sits below the screen at 0 and in place at 1; the bar fades in as it arrives. */
  private setPan(u: number) {
    this.panU = u;
    const e = easeInOut(u);
    this.stage.style.transform = e < 1 ? `translateY(${((1 - e) * 110).toFixed(2)}vh)` : 'none';
    this.bar.style.opacity = String(clamp((u - 0.75) / 0.25, 0, 1));
    this.root.style.setProperty('--aq-bg', e.toFixed(3)); // the scene behind blurs as the tank comes up
    this.hooks.pan(e);
  }

  private advance(dt: number) {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(tw.dur, tw.t + dt);
    this.setPan(lerp(tw.from, tw.to, tw.t / tw.dur));
    if (tw.t < tw.dur) return;
    this.tween = null;
    if (this.state === 'opening') {
      this.state = 'open';
      this.slosh = 1; // the water rocks as the tank comes to a stop
    } else if (this.state === 'closing') {
      this.state = 'closed';
      this.root.classList.add('hidden');
      this.raf = 0;
    }
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

  /** Show a tank: fish no longer in it swim off (fade), new ones fade in where they are. */
  private setTank(tank: TankId, fresh = false) {
    const changed = tank !== this.tank || fresh;
    this.tank = tank;
    const fish = this.fishIn(tank);
    const keep = new Set(fish);
    for (const s of this.swimmers.values()) s.leaving = !keep.has(s.fish);
    for (const f of fish) {
      const s = this.swimmers.get(f);
      if (s) s.leaving = false;
      else this.swimmers.set(f, this.spawn(f));
    }
    if (this.picked?.leaving) this.pick(null);
    if (changed) {
      this.plants = this.scenery(tank);
      this.bubbles = [];
    }
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

  // ---- Fish -------------------------------------------------------------

  private spawn(fish: BankedFish): Swimmer {
    const x = lerp(SWIM.x0, SWIM.x1, Math.random());
    const y = lerp(SWIM.y0, SWIM.y1, Math.random());
    const z = lerp(SWIM.z0, SWIM.z1, Math.random());
    const dir = Math.random() < 0.5 ? -1 : 1;
    // 15 cm reads as small, 150 cm as large. Feeding changes only the aquarium
    // presentation; the banked/NFT fish metadata remains unchanged.
    const size = this.sizeFor(fish);
    const growth = this.aquariumState.growth[fish.id];
    return {
      fish,
      img: null,
      x,
      y,
      z,
      vx: dir * 0.02,
      vy: 0,
      vz: 0,
      tx: x,
      ty: y,
      tz: z,
      face: dir,
      size,
      speed: 0.035 + RARITY[fish.rarity].speed * 0.008,
      phase: Math.random() * Math.PI * 2,
      alpha: 0,
      leaving: false,
      growthPulse: 0,
      glowIntensity: activeFoodEffects(growth).glow,
    };
  }

  private sizeFor(fish: BankedFish) {
    const growth = this.aquariumState.growth[fish.id];
    return clamp(Math.log(Math.max(fish.lengthCm * growthScaleForGrowth(growth), 1) / 15) / Math.log(10), 0, 1);
  }

  private swim(s: Swimmer, dt: number) {
    if (Math.hypot(s.tx - s.x, (s.ty - s.y) * 1.5, (s.tz - s.z) * 0.6) < 0.04) {
      if (this.foodDrop && this.foodDrop.life > 0 && !s.leaving && this.fishIn(this.tank).includes(s.fish)) {
        // Keep circling the falling food so the whole school visibly competes for it.
        s.tx = clamp(this.foodDrop.x + (Math.random() - 0.5) * 0.2, SWIM.x0, SWIM.x1);
        s.ty = clamp(this.foodDrop.y + 0.12 + (Math.random() - 0.5) * 0.18, SWIM.y0, SWIM.y1);
        s.tz = clamp(this.foodDrop.z + (Math.random() - 0.5) * 0.2, SWIM.z0, SWIM.z1);
      } else {
        // Mostly sideways, with some drift in height and depth.
        s.tx = clamp(s.x + (Math.random() - 0.5) * 0.9, SWIM.x0, SWIM.x1);
        s.ty = clamp(s.y + (Math.random() - 0.5) * 0.35, SWIM.y0, SWIM.y1);
        s.tz = clamp(s.z + (Math.random() - 0.5) * 0.5, SWIM.z0, SWIM.z1);
      }
    }
    const dx = s.tx - s.x;
    const dy = s.ty - s.y;
    const dz = s.tz - s.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    // The fish you're looking at idles in place.
    const effects = activeFoodEffects(this.aquariumState.growth[s.fish.id]);
    s.glowIntensity = effects.glow;
    const speed = (s === this.picked ? s.speed * 0.15 : s.speed) * effects.speed;
    const k = Math.min(1, dt * 1.4);
    s.vx += ((dx / d) * speed - s.vx) * k;
    s.vy += ((dy / d) * speed * 0.6 - s.vy) * k;
    s.vz += ((dz / d) * speed * 0.5 - s.vz) * k;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;
    if (Math.abs(s.vx) > 0.006) s.face += (Math.sign(s.vx) - s.face) * Math.min(1, dt * 3.5);
    s.alpha = clamp(s.alpha + (s.leaving ? -dt * 2.5 : dt * 1.6), 0, 1);
  }

  // ---- Projection -------------------------------------------------------

  /**
   * Tank space to the eye's space, in pixels: X across, d = distance from the eye.
   * The focal length is the front glass's width, so facing you the front glass
   * is at scale 1 and the back wall at BACK_SCALE, and turning swings the box
   * about its middle.
   */
  private cam(x: number, z: number, view = this.view) {
    const f = (FRONT.x1 - FRONT.x0) * this.w;
    const depth = f * (1 / BACK_SCALE - 1);
    const X = (x - 0.5) * f;
    const Z = (z - 0.5) * depth;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const front = { X: X * c + Z * s, d: f + depth / 2 - X * s + Z * c, f };
    if (view <= 0) return front;
    // In plan view screen depth is the tank's vertical position. X remains the
    // horizontal position so sorting still puts plants/fish nearest the glass first.
    const top = { X: (x - 0.5) * f, d: 1 + (1 - z) * f * 0.5, f };
    return {
      X: lerp(front.X, top.X, view),
      d: lerp(front.d, top.d, view),
      f,
    };
  }

  /**
   * Tank space to canvas pixels, and the scale at that depth. Turned, the near
   * front corner swings toward you; the whole tank shrinks to match, so it never
   * grows out of the canvas.
   */
  private proj(x: number, y: number, z: number) {
    const f = (FRONT.x1 - FRONT.x0) * this.w;
    const depth = f * (1 / BACK_SCALE - 1);
    const X = (x - 0.5) * f;
    const Z = (z - 0.5) * depth;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const frontCam = { X: X * c + Z * s, d: f + depth / 2 - X * s + Z * c };
    // Use the unblended camera here: the front projection must keep its scale
    // stable while the tank eases toward the overhead view.
    const frontNear = Math.min(this.cam(0, 0, 0).d, this.cam(1, 0, 0).d);
    const frontScale = (f / frontCam.d) * Math.min(1, frontNear / f);
    const front = {
      x: this.w / 2 + frontCam.X * frontScale,
      y: VANISH_Y * this.h + (lerp(FRONT.y0, FRONT.y1, y) * this.h - VANISH_Y * this.h) * frontScale,
      s: frontScale,
    };
    if (this.view <= 0) return front;

    // A top-down projection uses z as screen depth and y as a small lift toward
    // the viewer. This keeps the fish and plants readable while exposing the tank floor.
    const topDepth = (FRONT.y1 - FRONT.y0) * this.h;
    const topX = this.w * (FRONT.x0 + x * (FRONT.x1 - FRONT.x0));
    const topY = this.h * (FRONT.y0 + (1 - z) * (FRONT.y1 - FRONT.y0)) + (0.5 - y) * topDepth * 0.18;
    const top = { x: topX, y: topY, s: lerp(1.02, 0.86, clamp(y, 0, 1)) };
    return {
      x: lerp(front.x, top.x, this.view),
      y: lerp(front.y, top.y, this.view),
      s: lerp(front.s, top.s, this.view),
    };
  }

  /** Whether a side wall (x = 0 or 1) faces the eye from outside, so it's in front of the fish. */
  private sideInFront(side: 0 | 1) {
    if (this.view > 0.5) return false;
    const wall = this.cam(side, 0.5);
    const mid = this.cam(0.5, 0.5);
    // The eye is at the origin: is it on the wall's outward side?
    return (wall.X - mid.X) * -wall.X + (wall.d - mid.d) * -wall.d > 0;
  }

  private spriteSize(s: Swimmer, scale: number) {
    return (FRONT.x1 - FRONT.x0) * this.w * lerp(0.085, 0.16, s.size) * scale;
  }

  private fishAt(e: MouseEvent): Swimmer | null {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    // Nearest the glass first: it's drawn on top.
    const near = (s: Swimmer) => this.cam(s.x, s.z).d;
    const list = [...this.swimmers.values()].filter((s) => !s.leaving && s.alpha > 0.3).sort((a, b) => near(a) - near(b));
    for (const s of list) {
      const p = this.proj(s.x, s.y, s.z);
      const size = this.spriteSize(s, p.s);
      if (Math.abs(mx - p.x) < size * 0.42 && Math.abs(my - p.y) < size * 0.26) return s;
    }
    return null;
  }

  // ---- Info card --------------------------------------------------------

  private pick(s: Swimmer | null) {
    this.picked = s;
    this.card.classList.toggle('hidden', !s);
    if (!s) return;
    const f = s.fish;
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
      this.foodDrop = { x: 0.5, y: SURFACE + 0.04, z: 0.25, life: 4.2, count: fedCount };
      for (const f of fish) {
        const swimmer = this.swimmers.get(f);
        if (!swimmer) continue;
        swimmer.size = this.sizeFor(f);
        swimmer.speed = 0.035 + RARITY[f.rarity].speed * 0.008;
        swimmer.glowIntensity = activeFoodEffects(this.aquariumState.growth[f.id]).glow;
        swimmer.growthPulse = 1;
        swimmer.tx = clamp(this.foodDrop.x + (Math.random() - 0.5) * 0.18, SWIM.x0, SWIM.x1);
        swimmer.ty = clamp(this.foodDrop.y + 0.12 + (Math.random() - 0.5) * 0.16, SWIM.y0, SWIM.y1);
        swimmer.tz = clamp(this.foodDrop.z + (Math.random() - 0.5) * 0.18, SWIM.z0, SWIM.z1);
        for (let i = 0; i < 3; i++) this.bubbles.push({
          x: swimmer.x + (Math.random() - 0.5) * 0.06,
          y: swimmer.y + (Math.random() - 0.5) * 0.04,
          z: swimmer.z,
          r: 1.5 + Math.random() * 2.5,
          v: 0.12 + Math.random() * 0.1,
        });
      }
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

  // ---- Scenery ----------------------------------------------------------

  /** Plants seeded by the tank, so each one keeps its own look. */
  private scenery(tank: TankId): Plant[] {
    const rng = new Rng(tank === 'fav' ? 0xfa7 : 0x7a4c + tank * 977);
    const n = rng.int(6, 10);
    return Array.from({ length: n }, () => ({
      x: rng.range(0.04, 0.96),
      z: rng.range(0.15, 1),
      h: rng.range(0.2, 0.55),
      hue: tank === 'fav' ? rng.range(320, 350) : rng.range(95, 160),
      blades: rng.int(2, 4),
      phase: rng.range(0, Math.PI * 2),
    }));
  }

  // ---- Frame ------------------------------------------------------------

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private frame(dt: number) {
    this.advance(dt);
    if (this.state === 'closed') return;
    this.t += dt;
    if (this.foodPreview?.model) {
      this.foodPreview.model.rotation.y = this.t * 0.8;
      this.foodPreview.renderer.render(this.foodPreview.scene, this.foodPreview.camera);
    }
    this.yaw += (this.yawTarget - this.yaw) * Math.min(1, dt * YAW_EASE);
    this.view += (this.viewTarget - this.view) * Math.min(1, dt * 4.5);
    if (Math.abs(this.viewTarget - this.view) < 0.001) this.view = this.viewTarget;
    this.slosh = Math.max(0, this.slosh - dt * 0.35);
    if (this.foodDrop) {
      this.foodDrop.life -= dt;
      this.foodDrop.y = Math.min(SURFACE + 0.04, this.foodDrop.y + dt * 0.28);
      if (this.foodDrop.life <= 0) this.foodDrop = null;
    }
    let budget = ICONS_PER_FRAME;
    for (const [f, s] of this.swimmers) {
      if (!s.img && !s.leaving && budget-- > 0) {
        const img = new Image();
        img.src = fishIcon(f);
        s.img = img;
      }
      this.swim(s, dt);
      s.growthPulse = Math.max(0, s.growthPulse - dt * 1.8);
      if (s.leaving && s.alpha === 0) this.swimmers.delete(f);
    }
    if (Math.random() < dt * 5) {
      for (const bx of [0.22, 0.81]) {
        this.bubbles.push({ x: bx + (Math.random() - 0.5) * 0.02, y: SWIM.y1 + 0.05, z: 0.8, r: 1.5 + Math.random() * 3, v: 0.12 + Math.random() * 0.1 });
      }
    }
    for (const b of this.bubbles) {
      b.y -= b.v * dt;
      b.x += Math.sin(this.t * 3 + b.r * 5) * 0.004 * dt * 10;
    }
    this.bubbles = this.bubbles.filter((b) => b.y > SURFACE + 0.01);
    if (this.w) this.draw();
  }

  private quad(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  private draw() {
    const ctx = this.ctx;
    const P = (x: number, y: number, z: number) => this.proj(x, y, z);
    ctx.clearRect(0, 0, this.w, this.h);
    const fav = this.tank === 'fav';
    const STAND = 1.1; // the stand's bottom, in tank heights

    // Stand under the tank: its sides first (the far one is hidden behind the rest), then its front.
    const sides = ([0, 1] as const).slice().sort((a, b) => this.cam(b, 0.5).d - this.cam(a, 0.5).d);
    for (const side of sides) {
      this.quad(P(side, 1, 0), P(side, 1, 1), P(side, STAND, 1), P(side, STAND, 0));
      ctx.fillStyle = '#0f0b08';
      ctx.fill();
    }
    this.quad(P(0, 1, 0), P(1, 1, 0), P(1, STAND, 0), P(0, STAND, 0));
    ctx.fillStyle = '#1a1410';
    ctx.fill();

    // Back wall: deep water with light shafts.
    const back = [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)] as const;
    const wall = ctx.createLinearGradient(0, Math.min(back[0].y, back[1].y), 0, Math.max(back[2].y, back[3].y));
    wall.addColorStop(0, this.mixHex(fav ? '#2a3b6b' : '#1d5a7a', 0.5));
    wall.addColorStop(1, this.mixHex(fav ? '#120f2e' : '#06233a', 0.42));
    this.quad(...back);
    ctx.fillStyle = wall;
    ctx.fill();
    const ambientGlow = ctx.createRadialGradient(this.w * 0.5, this.h * 0.28, 0, this.w * 0.5, this.h * 0.52, this.w * 0.72);
    ambientGlow.addColorStop(0, this.ambientCss(0.34, 0.85));
    ambientGlow.addColorStop(1, this.ambientCss(0, 0.85));
    this.quad(...back);
    ctx.fillStyle = ambientGlow;
    ctx.fill();
    ctx.save();
    this.quad(...back);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const u = (i + 0.5) / 5 + Math.sin(this.t * 0.25 + i * 1.7) * 0.05;
      const top = P(u, 0, 1);
      const bottom = P(u + 0.03, 1, 1);
      const g = ctx.createLinearGradient(0, top.y, 0, bottom.y);
      g.addColorStop(0, this.ambientCss(0.18, 0.85));
      g.addColorStop(1, this.ambientCss(0, 0.85));
      ctx.fillStyle = g;
      this.quad(P(u - 0.012, 0, 1), P(u + 0.012, 0, 1), P(u + 0.05, 1, 1), P(u - 0.01, 1, 1));
      ctx.fill();
    }
    ctx.restore();

    // Side walls, a little lighter where the glass catches the room. One seen from
    // outside is in front of the fish, so it's drawn after them.
    const sideGlass = (side: 0 | 1) => {
      this.quad(P(side, 0, 0), P(side, 0, 1), P(side, 1, 1), P(side, 1, 0));
      ctx.fillStyle = this.ambientCss(0.27, 0.72);
      ctx.fill();
    };
    const outside = ([0, 1] as const).filter((side) => this.sideInFront(side));
    for (const side of [0, 1] as const) if (!outside.includes(side)) sideGlass(side);

    // Sand floor, lighter toward the glass.
    this.quad(P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1));
    const sand = ctx.createLinearGradient(0, P(0.5, 1, 1).y, 0, P(0.5, 1, 0).y);
    sand.addColorStop(0, this.mixHex('#6f6450', 0.24));
    sand.addColorStop(1, this.mixHex('#c9b48a', 0.2));
    ctx.fillStyle = sand;
    ctx.fill();
    const rng = new Rng(0x5a4d);
    for (let i = 0; i < 40; i++) {
      const p = P(rng.next(), 1, rng.next());
      ctx.fillStyle = `rgba(60, 50, 40, ${0.25 + rng.next() * 0.3})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, (2 + rng.next() * 5) * p.s, (1 + rng.next() * 2) * p.s, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Plants and fish, far to near (by distance from the eye, which turning changes).
    type Item = { d: number; draw: () => void };
    const d = (x: number, z: number) => this.cam(x, z).d;
    const items: Item[] = [
      ...this.plants.map((p) => ({ d: d(p.x, p.z), draw: () => this.drawPlant(p) })),
      ...[...this.swimmers.values()].map((s) => ({ d: d(s.x, s.z), draw: () => this.drawFish(s) })),
      ...this.bubbles.map((b) => ({ d: d(b.x, b.z), draw: () => this.drawBubble(b) })),
      ...(this.foodDrop ? [{ d: d(this.foodDrop.x, this.foodDrop.z), draw: () => this.drawFoodDrop(this.foodDrop!) }] : []),
    ];
    items.sort((a, b) => b.d - a.d);
    for (const it of items) it.draw();

    // Water surface: a band seen from just above, with a wave that sloshes after the rise.
    const amp = 0.006 + this.slosh * 0.03;
    const wave = (x: number, z: number) => SURFACE + Math.sin(x * 9 + this.t * 2.2 + z * 3) * amp * (1 - z * 0.5) + Math.sin(x * 3 - this.t * 1.3) * this.slosh * 0.02;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const p = P(i / 24, wave(i / 24, 0), 0);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    }
    for (let i = 24; i >= 0; i--) {
      const p = P(i / 24, wave(i / 24, 1), 1);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = this.ambientCss(0.22, 0.82);
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const p = P(i / 24, wave(i / 24, 0), 0);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    }
    ctx.strokeStyle = this.ambientCss(0.68, 0.9);
    ctx.lineWidth = 2;
    ctx.stroke();

    for (const side of outside) sideGlass(side);

    // Front glass: a faint tint, two highlights, and the frame.
    const front = [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)] as const;
    this.quad(...front);
    ctx.fillStyle = this.ambientCss(0.14, 0.86);
    ctx.fill();
    ctx.save();
    this.quad(...front);
    ctx.clip();
    for (const [u, wdt, a] of [[0.12, 0.05, 0.07], [0.2, 0.015, 0.09]] as const) {
      ctx.fillStyle = this.ambientCss(a, 0.15);
      this.quad(P(u, 0, 0), P(u + wdt, 0, 0), P(u + wdt - 0.12, 1, 0), P(u - 0.12, 1, 0));
      ctx.fill();
    }
    ctx.restore();
    // The glass edges: along the top, and the back corners.
    ctx.strokeStyle = this.ambientCss(0.38, 0.88);
    ctx.lineWidth = 1.5;
    const edges = [
      [P(0, 0, 0), P(0, 0, 1)],
      [P(1, 0, 0), P(1, 0, 1)],
      [P(0, 0, 1), P(1, 0, 1)],
      [P(0, 0, 1), P(0, 1, 1)],
      [P(1, 0, 1), P(1, 1, 1)],
    ];
    for (const [a, b] of edges) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    this.quad(...front);
    ctx.strokeStyle = '#11181f';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.strokeStyle = fav ? 'rgba(255, 204, 77, 0.55)' : this.ambientCss(0.46, 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private drawPlant(p: Plant) {
    const ctx = this.ctx;
    const base = this.proj(p.x, 1, p.z);
    const top = this.proj(p.x, 1 - p.h, p.z);
    const len = base.y - top.y;
    const shade = 1 - p.z * 0.45;
    for (let b = 0; b < p.blades; b++) {
      const off = (b - (p.blades - 1) / 2) * 6 * base.s;
      ctx.beginPath();
      ctx.moveTo(base.x + off - 3 * base.s, base.y);
      const segs = 6;
      const pts: [number, number][] = [];
      for (let i = 1; i <= segs; i++) {
        const u = i / segs;
        const sway = Math.sin(this.t * 1.1 + p.phase + b + u * 2.5) * 10 * u * u * base.s;
        pts.push([base.x + off + sway, base.y - len * u * (1 - b * 0.12)]);
      }
      for (const [x, y] of pts) ctx.lineTo(x - 3 * base.s * (1 - y / base.y), y);
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0] + 3 * base.s, pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = `hsl(${p.hue}, 45%, ${Math.round(32 * shade + b * 4)}%)`;
      ctx.fill();
    }
  }

  private drawFish(s: Swimmer) {
    if (!s.img?.complete || !s.img.naturalWidth || s.alpha <= 0) return;
    const ctx = this.ctx;
    const bob = Math.sin(this.t * 1.6 + s.phase) * 0.006;
    const p = this.proj(s.x, s.y + bob, s.z);
    const size = this.spriteSize(s, p.s);
    ctx.save();
    ctx.translate(p.x, p.y);
    // Nose up or down a little with its climb; the sprite faces right, so mirror it to face left.
    // Turning the tank shortens fish swimming across it a little.
    ctx.rotate(clamp(s.vy * 3, -0.25, 0.25) * Math.sign(s.face || 1));
    const pulse = 1 + Math.sin((1 - s.growthPulse) * Math.PI) * 0.1;
    ctx.scale(s.face * Math.cos(this.yaw) * pulse, pulse);
    ctx.globalAlpha = s.alpha * (1 - s.z * 0.25);
    // Further back is dimmer and bluer, as if through more water.
    const ambientLuma = (this.lightRgb.r * 0.299 + this.lightRgb.g * 0.587 + this.lightRgb.b * 0.114) / 255;
    const dim = (1 - s.z * 0.4) * (0.72 + ambientLuma * 0.48);
    ctx.filter = `brightness(${dim.toFixed(2)}) saturate(${(1 - s.z * 0.35 + ambientLuma * 0.22).toFixed(2)})`;
    if (s.glowIntensity > 0) {
      ctx.shadowColor = '#7fffe0';
      ctx.shadowBlur = 8 + s.glowIntensity * 24;
    }
    if (s === this.picked || s === this.hover) {
      ctx.shadowColor = RARITY[s.fish.rarity].color;
      ctx.shadowBlur = Math.max(s.glowIntensity > 0 ? 8 + s.glowIntensity * 24 : 0, s === this.picked ? 24 : 12);
    }
    ctx.drawImage(s.img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  private drawFoodDrop(drop: FoodDrop) {
    const ctx = this.ctx;
    const p = this.proj(drop.x, drop.y, drop.z);
    const pulse = 1 + Math.sin(this.t * 8) * 0.12;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = this.ambientCss(0.9, 0.9);
    ctx.shadowBlur = 14 * p.s;
    ctx.fillStyle = this.ambientCss(0.88, 0.82);
    ctx.beginPath();
    ctx.arc(0, 0, (5 + Math.min(8, drop.count)) * p.s * pulse, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < Math.min(7, drop.count + 2); i++) {
      const a = this.t * 1.8 + i * 2.399;
      const r = (7 + (i % 3) * 4) * p.s;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, (1.5 + (i % 2)) * p.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawBubble(b: Bubble) {
    const ctx = this.ctx;
    const p = this.proj(b.x, b.y, b.z);
    ctx.beginPath();
    ctx.arc(p.x, p.y, b.r * p.s, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(220, 250, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** What a feeding cost: on-chain PEARL burned. */
export function spentText(burned: number): string {
  return `−${burned} PEARL`;
}

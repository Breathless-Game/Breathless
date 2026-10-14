import * as THREE from 'three';
import { buildUpgradeModel, upgradeEffect, type UpgradeDef, type UpgradeLevel } from './upgrades';
import { setDeepSonarColor } from './deep-sonar';
import { loadSonarConfig, saveSonarConfig } from './sonar-config';
import { t, lang, onLangChange } from './i18n';
import { lampEffect, lampPath } from './lamp-upgrades';
import { disposeMeshes } from './headlamp-model';
import type { LampPath } from './lamp-lighting';

// A closer look at one piece of gear from the workbench: it grows from where it
// lies on the table to the middle of the screen over the blurred table, turning
// slowly. What it does is on the left; the upgrade (equipment.ts, through main's
// buyNextUpgrade) and, from Lv2, its branch are on the right. ← / → or a sideways
// swipe flips through its three levels; levels not owned yet show as a dark
// silhouette with their price. The boat opens the same view on the ships
// (ships.ts): ‹ › flips through all six, each with its bonuses, its banked-value
// threshold, and Equip. The diver figure opens it on the diver: click a piece of
// gear in the list to put it on or take it off (that's the ready tray).

const LEVELS: UpgradeLevel[] = [1, 2, 3];
const GROW_S = 0.35;
const SWAP_S = 0.28;
const SWIPE_PX = 70; // a sideways drag this long flips to the next level
const SPIN = 0.5; // radians per second on the turntable
const ORBIT_SENSITIVITY = 0.008; // pointer pixels to radians while examining a model
const ORBIT_TILT = 0.0045;
const MAX_ORBIT_TILT = 0.42;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const easeOut = (u: number) => 1 - (1 - u) ** 3;

export interface InspectHooks {
  /** The highest level the player owns of this gear (1 = the starting gear). */
  owned(def: UpgradeDef): number;
  /** Whether it's in the ready tray. */
  isReady(def: UpgradeDef): boolean;
  /** Put it in the ready tray, or back on the table (dive gear only). */
  setReady(def: UpgradeDef, ready: boolean): void;
  /** Apply the sonar beacon color to the live dive model. */
  sonarColor?(color: string): void;
  /** Buy the next level. Resolves with why it didn't happen, or null once it did. */
  buy(def: UpgradeDef): Promise<string | null>;
  /** Pearls to spend: the cached on-chain PEARL balance. */
  pearls(): number;
  /** The two branches this gear can run from Lv2 (null: it has none), and which one it runs. */
  paths(def: UpgradeDef): { id: string; name: string; nameZh: string; summary: string; effects: readonly string[] }[] | null;
  activePath(def: UpgradeDef): string | null;
  selectPath(def: UpgradeDef, id: string): Promise<void> | void;
  /** The ships, for the boat (showShips). */
  ships: ShipHooks;
  /** Dressing the diver figure (showDiver). What it wears is what's in the ready tray (isReady / setReady). */
  diver: DiverHooks;
  closed(): void;
}

export interface DiverHooks {
  /** Everything the diver can wear (the dive gear). */
  gear(): readonly UpgradeDef[];
  /** How many pieces it can wear at once (the tray's slots). */
  slots: number;
  /** A fresh figure wearing what's in the tray now. */
  model(): THREE.Object3D;
  wearAll(): void;
  takeOffAll(): void;
}

/** One ship as the inspector shows it. */
export interface ShipEntry {
  name: string;
  nameZh: string;
  intro: string;
  introZh: string;
  /** Lifetime banked value that unlocks it (the chain's ProgressConfig). */
  threshold: number;
  /** Its bonuses, one short line each. */
  bonuses: string[];
}

export interface ShipHooks {
  list(): readonly ShipEntry[];
  /** The ship sailed now (index). */
  current(): number;
  /** The lifetime banked value read from the chain (0 until read). */
  progress(): number;
  /** A fresh copy of ship i's model, null while the models load. */
  model(i: number): THREE.Object3D | null;
  /** Sail ship i (player_state set_ship). Resolves with why it didn't happen, or null once it did. */
  equip(i: number): Promise<string | null>;
  /** The boat's parts bought with PEARL (upgrades.ts group 'boat', player_state buy_boat). */
  parts(): readonly UpgradeDef[];
}

export class GearInspector {
  private root = $('wb-inspect');
  private stage = $('wb-inspect-stage');
  private canvas = $<HTMLCanvasElement>('wb-inspect-gl');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private turntable = new THREE.Group();
  /** A small, material-rich plinth makes the contact point and scale of each tool legible. */
  private plinth = new THREE.Group();
  private models = new Map<number, THREE.Group>();

  private def: UpgradeDef | null = null;
  /** Looking at the ships (the boat) rather than one piece of gear's levels. */
  private shipMode = false;
  /** Dressing the diver figure. */
  private diverMode = false;
  private level = 1;
  private spin = 0;
  private swap: { t: number; dir: number; from: THREE.Group; to: THREE.Group } | null = null;
  private swipe: { x: number; y: number; id: number; yaw: number; tilt: number } | null = null;
  private drag = 0; // follows a swipe in progress, in screen px
  private dragY = 0;
  private orbitYaw = 0;
  private orbitTilt = 0;
  private raf = 0;
  private last = 0;
  private buying = false;
  private changingPath = false;
  private previewLampPath: LampPath | null = null;
  private lampModelPath: LampPath | null = null;
  private lampState = '';
  private notice: [string, string] | null = null;
  private noticeText(): string { return this.notice ? t(this.notice[0], this.notice[1]) : ''; }

  constructor(private hooks: InspectHooks) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.add(new THREE.HemisphereLight('#e6f6ff', '#4a3420', 1.4));
    const key = new THREE.DirectionalLight('#fff1dc', 2.6);
    key.position.set(-3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 15;
    const rim = new THREE.DirectionalLight('#9fe8ff', 1.2);
    rim.position.set(3, 1, -3);
    this.buildPlinth();
    this.scene.add(key, rim, this.plinth, this.turntable);
    this.camera.position.set(0, 0.9, 5.2);
    this.camera.lookAt(0, 0, 0);

    $('wb-inspect-prev').addEventListener('click', () => this.step(-1));
    $('wb-inspect-next').addEventListener('click', () => this.step(1));
    $('wb-inspect-close').addEventListener('click', () => this.close());
    $('wb-inspect-buy').addEventListener('click', () => void this.buy());
    $('wb-inspect-ready').addEventListener('click', () => {
      if (this.diverMode) {
        this.hooks.diver.takeOffAll();
        return this.redress();
      }
      if (!this.def) return;
      this.hooks.setReady(this.def, !this.hooks.isReady(this.def));
      this.renderInfo();
    });
    $('wb-inspect-sonar-input').addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      const saved = saveSonarConfig({ ...loadSonarConfig(), color });
      (e.target as HTMLInputElement).value = saved.color;
      this.setSonarColor(saved.color);
      this.hooks.sonarColor?.(saved.color);
    });
    // Clicking the blurred table around it puts it down.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root || e.target === $('wb-inspect-bg')) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.step(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    this.stage.addEventListener('pointerdown', (e) => {
      if (e.target instanceof HTMLButtonElement) return; // ‹ › keep their clicks
      this.swipe = { x: e.clientX, y: e.clientY, id: e.pointerId, yaw: this.orbitYaw, tilt: this.orbitTilt };
      this.stage.setPointerCapture(e.pointerId);
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (this.swipe?.id !== e.pointerId) return;
      this.drag = e.clientX - this.swipe.x;
      this.dragY = e.clientY - this.swipe.y;
      this.orbitYaw = this.swipe.yaw + this.drag * ORBIT_SENSITIVITY;
      this.orbitTilt = THREE.MathUtils.clamp(this.swipe.tilt + this.dragY * ORBIT_TILT, -MAX_ORBIT_TILT, MAX_ORBIT_TILT);
    });
    const endSwipe = (e: PointerEvent) => {
      if (this.swipe?.id !== e.pointerId) return;
      const dx = e.clientX - this.swipe.x;
      const dy = e.clientY - this.swipe.y;
      this.swipe = null;
      this.drag = 0;
      this.dragY = 0;
      // Drag left for the next level, right for the one before: the model goes the way you push it.
      // A mostly horizontal drag changes level; a diagonal drag stays an orbit gesture.
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dy) < SWIPE_PX * 0.52) this.step(dx < 0 ? 1 : -1);
    };
    this.stage.addEventListener('pointerup', endSwipe);
    this.stage.addEventListener('pointercancel', endSwipe);
    window.addEventListener('resize', () => this.open && this.resize());
    onLangChange(() => { if (this.open) this.renderInfo(); });
  }

  get open() {
    return this.def !== null || this.shipMode || this.diverMode;
  }

  /** How many models ‹ › flips through: three levels, every ship, or the one diver. */
  private get count() {
    return this.shipMode ? this.hooks.ships.list().length : this.diverMode ? 1 : 3;
  }

  /** Look at `def`, growing it out of the screen point `from` (where it lies on the table). */
  show(def: UpgradeDef, from: { x: number; y: number }, level?: UpgradeLevel) {
    this.def = def;
    this.shipMode = this.diverMode = false;
    this.level = level ?? Math.min(3, Math.max(1, this.hooks.owned(def)));
    this.previewLampPath = null;
    this.lampModelPath = this.selectedLampPath();
    this.lampState = '';
    this.open3d(from);
  }

  /** The middle of the stage: where a part or the ships grow from when picked inside the inspector. */
  private centre() {
    const r = this.stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /**
   * The boat's parts, under the ships and under each part: the ships first, then each part with
   * its level; click one to look at it (and buy its next level), or the ships to go back.
   */
  private renderParts(current: UpgradeDef | null) {
    const parts = this.hooks.ships.parts();
    const box = $('wb-inspect-parts');
    box.classList.toggle('hidden', !parts.length);
    const item = (label: string, sub: string, on: boolean, go: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `wb-path${on ? ' on' : ''}`;
      const name = document.createElement('b');
      name.textContent = label;
      const small = document.createElement('small');
      small.textContent = sub;
      b.append(name, small);
      b.addEventListener('click', go);
      return b;
    };
    $('wb-inspect-part-list').replaceChildren(
      item(t('Ships', '船只'), t('Unlocked by lifetime banked value', '累计入库价值解锁'), current === null, () => {
        if (current !== null) this.showShips(this.centre());
      }),
      ...parts.map((def) => {
        const owned = Math.min(3, Math.max(1, this.hooks.owned(def)));
        const next = owned >= 3 ? t('max level', '已满级') : t(`next ${def.prices[owned]} Pearls`, `下一级 ${def.prices[owned]} 珍珠`);
        return item(lang() === 'zh' ? def.nameZh : def.name, `${t(`Lv ${owned} / 3`, `${owned} / 3 级`)} · ${next}`, current?.id === def.id, () => {
          if (current?.id !== def.id) this.show(def, this.centre());
        });
      }),
    );
  }

  /** The ships, from the boat on the table: opens on the one sailed now. */
  showShips(from: { x: number; y: number }) {
    this.def = null;
    this.shipMode = true;
    this.diverMode = false;
    this.level = this.hooks.ships.current() + 1;
    this.open3d(from);
  }

  /** The diver figure, to dress. */
  showDiver(from: { x: number; y: number }) {
    this.def = null;
    this.shipMode = false;
    this.diverMode = true;
    this.level = 1;
    this.open3d(from);
  }

  private open3d(from: { x: number; y: number }) {
    this.notice = null;
    this.orbitYaw = 0;
    this.orbitTilt = 0;
    this.clearModels();
    this.swap = null;
    this.spin = -0.6;
    this.turntable.add(this.model(this.level));
    this.root.classList.remove('hidden');
    this.resize();
    this.renderInfo();
    // Grow from the piece on the table to the middle.
    const r = this.stage.getBoundingClientRect();
    const dx = from.x - (r.left + r.width / 2);
    const dy = from.y - (r.top + r.height / 2);
    this.stage.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0.4 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: GROW_S * 1000, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
    );
    this.root.classList.add('open');
    if (!this.raf) {
      this.last = performance.now();
      const loop = (now: number) => {
        if (!this.open) return;
        this.frame(Math.min((now - this.last) / 1000, 0.05));
        this.last = now;
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  close() {
    if (!this.open) return;
    this.def = null;
    this.shipMode = this.diverMode = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.root.classList.remove('open');
    this.root.classList.add('hidden');
    this.hooks.closed();
  }

  /** Keep cached inspection models in sync with the selected sonar accent. */
  setSonarColor(color: string) {
    if (this.def?.id !== 'sonar') return;
    this.models.forEach((model) => setDeepSonarColor(model, color));
  }

  /** The next or previous level; the model slides out that way and the new one slides in. */
  private step(d: number) {
    if (!this.open) return;
    const next = this.level + d;
    if (next < 1 || next > this.count) {
      // Nothing further that way: a little nudge says so.
      this.stage.animate([{ transform: 'none' }, { transform: `translateX(${-d * 14}px)` }, { transform: 'none' }], { duration: 220 });
      return;
    }
    const from = this.model(this.level);
    this.level = next;
    const to = this.model(this.level);
    if (this.swap) this.turntable.remove(this.swap.from);
    this.turntable.add(to);
    this.swap = { t: 0, dir: d, from, to };
    this.renderInfo();
  }

  private model(level: number): THREE.Group {
    let m = this.models.get(level);
    if (!m) {
      if (this.shipMode) {
        // Ships come in their own sizes: centre each and fit it to the same 2 units as the gear.
        const ship = this.hooks.ships.model(level - 1) ?? buildUpgradeModel('boat', 1);
        const box = new THREE.Box3().setFromObject(ship);
        const k = 2 / Math.max(...box.getSize(new THREE.Vector3()).toArray());
        ship.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-k);
        ship.scale.multiplyScalar(k);
        m = new THREE.Group();
        m.add(ship);
      } else if (this.diverMode) {
        m = new THREE.Group();
        m.add(this.hooks.diver.model()); // already centred, standing
      } else m = buildUpgradeModel(this.def!.id, level as UpgradeLevel, { preserveTierScale: true, lampPath: this.selectedLampPath() });
      m.scale.setScalar(1.15); // preserve the tier silhouette inside the inspector frame
      this.models.set(level, m);
    }
    return m;
  }

  private clearModels() {
    this.models.forEach(model => {
      this.turntable.remove(model);
      if (model.userData.upgradeId === 'lamp') disposeMeshes(model);
    });
    this.models.clear();
    this.swap = null;
  }

  private selectedLampPath(): LampPath {
    return this.previewLampPath ?? lampPath(this.def ? this.hooks.owned(this.def) : 1, this.def ? this.hooks.activePath(this.def) : null);
  }

  private syncLampModel() {
    if (this.def?.id !== 'lamp') return;
    const path = this.selectedLampPath();
    if (path === this.lampModelPath) return;
    this.clearModels();
    this.lampModelPath = path;
    this.turntable.add(this.model(this.level));
  }

  private renderLampPreview() {
    const host = $('wb-inspect-lamp-preview');
    host.classList.toggle('hidden', this.def?.id !== 'lamp');
    if (this.def?.id !== 'lamp') return;
    const label = document.createElement('small');
    label.textContent = t('Preview optics', '预览专精');
    host.replaceChildren(label, ...(['focus', 'wideLamp'] as const).map(path => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = path === 'focus' ? t('Focus', '聚光') : t('Wide', '广角');
      button.dataset.lampPreview = path;
      button.setAttribute('aria-pressed', String(this.selectedLampPath() === path));
      button.disabled = this.level < 2;
      button.addEventListener('click', () => {
        this.previewLampPath = path;
        this.syncLampModel();
        this.renderInfo();
      });
      return button;
    }));
  }

  /** A low, dark plinth separates the model from the backdrop and catches its silhouette. */
  private buildPlinth() {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.08, 1.16, 0.12, 12),
      new THREE.MeshStandardMaterial({ color: '#162b31', metalness: 0.38, roughness: 0.56 }),
    );
    base.position.y = -1.08;
    base.castShadow = true;
    base.receiveShadow = true;
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.94, 0.025, 5, 32),
      new THREE.MeshStandardMaterial({ color: '#55d5c7', emissive: '#123f42', emissiveIntensity: 0.55, metalness: 0.5, roughness: 0.38 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -1.01;
    this.plinth.add(base, rim);
  }

  private renderInfo() {
    this.renderLampPreview();
    if (this.shipMode) return this.renderShip();
    if (this.diverMode) return this.renderDiver();
    const def = this.def;
    if (!def) return;
    const owned = this.hooks.owned(def);
    const lv = this.level;
    const unlocked = lv <= owned;
    $('wb-inspect-name').textContent = lang() === 'zh' ? def.nameZh : def.name;
    $('wb-inspect-zh').textContent = '';
    $('wb-inspect-up-kind').textContent = t('UPGRADE', '升级');
    this.root.classList.remove('ships', 'diver');
    $('wb-inspect-kind').textContent = def.group === 'dive' ? t('Dive gear', '潜水装备') : t('Boat gear', '船上装备');
    $('wb-inspect-level').textContent = t(`Level ${lv} / 3${unlocked ? '' : ' · locked'}`, `${lv} / 3 级${unlocked ? '' : ' · 未解锁'}`);
    $('wb-inspect-level').classList.toggle('locked', !unlocked);
    const effect = (level: number, preview = true) => def.id === 'lamp'
      ? lampEffect(level, preview ? this.selectedLampPath() : lampPath(owned, this.hooks.activePath(def)), lang() === 'zh')
      : upgradeEffect(def, level);
    $('wb-inspect-effect').textContent = effect(lv);
    const sonarColor = $<HTMLLabelElement>('wb-inspect-sonar-color');
    const sonarInput = $<HTMLInputElement>('wb-inspect-sonar-input');
    const isSonar = def.id === 'sonar';
    sonarColor.classList.toggle('hidden', !isSonar);
    if (isSonar) sonarInput.value = loadSonarConfig().color;
    // Every level's line, so you can compare them; the one you're looking at is marked.
    $('wb-inspect-levels').replaceChildren(
      ...LEVELS.map((l) => {
        const li = document.createElement('li');
        li.textContent = `Lv ${l} · ${effect(l)}`;
        li.classList.toggle('on', l === lv);
        li.classList.toggle('locked', l > owned);
        return li;
      }),
    );
    const ready = this.hooks.isReady(def);
    const readyBtn = $<HTMLButtonElement>('wb-inspect-ready');
    readyBtn.textContent = ready ? t('Put it back', '放回桌上') : t('Get it ready', '放入准备区');
    readyBtn.classList.toggle('primary', !ready);
    readyBtn.classList.toggle('hidden', def.group !== 'dive'); // the boat isn't packed for a dive

    // The upgrade panel: what the next level gives, what it costs, and the button to buy it.
    const nextLv = Math.min(3, owned + 1);
    const maxed = owned >= 3;
    const price = def.prices[nextLv - 1];
    const pearls = this.hooks.pearls();
    const short = !maxed && pearls < price;
    $('wb-inspect-up-title').textContent = maxed ? t('Fully upgraded', '已满级') : t(`Upgrade to level ${nextLv}`, `升级到 ${nextLv} 级`);
    $('wb-inspect-up-effect').textContent = effect(maxed ? 3 : nextLv, false);
    $('wb-inspect-up-price').textContent = maxed ? '' : t(`${price} Pearls`, `${price} 珍珠`);
    const buy = $<HTMLButtonElement>('wb-inspect-buy');
    buy.disabled = maxed || short || this.buying || this.changingPath;
    buy.classList.toggle('primary', !buy.disabled);
    buy.textContent = this.buying ? t('Upgrading…', '升级中…') : short ? t(`Need ${price - pearls} more`, `还差 ${price - pearls} 珍珠`) : t(`Upgrade (${price})`, `升级 (${price})`);
    buy.classList.toggle('hidden', maxed);
    $('wb-inspect-pearls').textContent = this.noticeText() || t(`You have ${Math.floor(pearls)} Pearls`, `你有 ${Math.floor(pearls)} 珍珠`);
    this.renderPaths(def, owned);
    if (def.group === 'boat') this.renderParts(def);
    else $('wb-inspect-parts').classList.add('hidden');

    $('wb-inspect-dots').replaceChildren(
      ...LEVELS.map((l) => {
        const dot = document.createElement('span');
        dot.classList.toggle('on', l === lv);
        dot.classList.toggle('locked', l > owned);
        return dot;
      }),
    );
    $<HTMLButtonElement>('wb-inspect-prev').disabled = lv === 1;
    $<HTMLButtonElement>('wb-inspect-next').disabled = lv === 3;
    this.stage.classList.toggle('locked', !unlocked);
    $('wb-inspect-lock').textContent = unlocked ? '' : `🔒 ${def.prices[lv - 1]} ${t('Pearls', '珍珠')}`;
  }

  /** Ship mode: the ship being looked at, its bonuses, and whether it can be sailed. */
  private renderShip() {
    const ships = this.hooks.ships;
    const list = ships.list();
    const i = this.level - 1;
    const ship = list[i];
    const current = ships.current();
    const progress = ships.progress();
    const unlocked = progress >= ship.threshold;
    $('wb-inspect-kind').textContent = t('Ship', '船只');
    $('wb-inspect-up-kind').textContent = t('SHIP', '船只');
    this.root.classList.add('ships');
    this.root.classList.remove('diver');
    $('wb-inspect-sonar-color').classList.add('hidden');
    $('wb-inspect-name').textContent = lang() === 'zh' ? ship.nameZh : ship.name;
    $('wb-inspect-zh').textContent = '';
    $('wb-inspect-level').textContent = `${t('Level', '等级')} ${String(i).padStart(2, '0')} · ${i === current ? t('sailing', '当前使用') : unlocked ? t('unlocked', '已解锁') : t('locked', '未解锁')}`;
    $('wb-inspect-level').classList.toggle('locked', !unlocked);
    $('wb-inspect-effect').textContent = lang() === 'zh' ? ship.introZh : ship.intro;
    // Every ship's bonuses, so they can be compared; the one shown is marked.
    $('wb-inspect-levels').replaceChildren(
      ...list.map((s, j) => {
        const li = document.createElement('li');
        li.textContent = `${String(j).padStart(2, '0')} ${lang() === 'zh' ? s.nameZh : s.name} · ${s.bonuses.join(' · ') || t('no bonus', '无加成')}`;
        li.classList.toggle('on', j === i);
        li.classList.toggle('locked', progress < s.threshold);
        return li;
      }),
    );
    $('wb-inspect-ready').classList.add('hidden');
    $('wb-inspect-paths').classList.add('hidden');
    this.renderParts(null);

    // The right panel: its bonuses, how far the banked value has come, and Equip.
    $('wb-inspect-up-title').textContent = i === current ? t('Sailing', '当前船只') : unlocked ? t('Equip this ship', '装备船只') : t('Locked', '未解锁');
    $('wb-inspect-up-effect').textContent = ship.bonuses.join(' · ') || t('The starter boat: no bonus', '初始小船：没有加成');
    $('wb-inspect-up-price').textContent = ship.threshold ? t(`Unlocks at ${ship.threshold} banked value`, `累计入库价值达到 ${ship.threshold} 解锁`) : t('Starter ship', '初始船只');
    const buy = $<HTMLButtonElement>('wb-inspect-buy');
    buy.classList.remove('hidden');
    buy.disabled = i === current || !unlocked || this.buying;
    buy.classList.toggle('primary', !buy.disabled);
    buy.textContent = this.buying ? t('Switching…', '切换中…') : i === current ? t('Equipped', '已装备') : unlocked ? t('Equip', '装备') : t(`Bank ${Math.ceil(ship.threshold - progress)} more`, `还差 ${Math.ceil(ship.threshold - progress)} 入库价值`);
    $('wb-inspect-pearls').textContent = this.noticeText() || t(`Total banked value ${Math.floor(progress)} (no fish are spent)`, `累计入库价值 ${Math.floor(progress)}（不会消耗鱼）`);

    $('wb-inspect-dots').replaceChildren(
      ...list.map((s, j) => {
        const dot = document.createElement('span');
        dot.classList.toggle('on', j === i);
        dot.classList.toggle('locked', progress < s.threshold);
        return dot;
      }),
    );
    $<HTMLButtonElement>('wb-inspect-prev').disabled = i === 0;
    $<HTMLButtonElement>('wb-inspect-next').disabled = i === list.length - 1;
    this.stage.classList.toggle('locked', !unlocked);
    $('wb-inspect-lock').textContent = unlocked ? '' : `🔒 ${ship.threshold} ${t('banked value', '入库价值')}`;
  }

  /**
   * Diver mode: the figure wearing what's packed. Every piece of dive gear is in
   * the list; click one to put it on or take it off. What it wears is the ready
   * tray, saved for next time.
   */
  private renderDiver() {
    const d = this.hooks.diver;
    const gear = d.gear();
    const worn = gear.filter((g) => this.hooks.isReady(g));
    const full = worn.length >= d.slots;
    $('wb-inspect-kind').textContent = t('Diver', '潜水员');
    $('wb-inspect-up-kind').textContent = t('LOADOUT', '配装');
    this.root.classList.remove('ships');
    this.root.classList.add('diver');
    $('wb-inspect-sonar-color').classList.add('hidden');
    $('wb-inspect-paths').classList.add('hidden');
    $('wb-inspect-parts').classList.add('hidden');
    $('wb-inspect-name').textContent = t('Your diver', '你的潜水员');
    $('wb-inspect-zh').textContent = '';
    $('wb-inspect-level').textContent = t(`Wearing ${worn.length} / ${d.slots}`, `已穿戴 ${worn.length} / ${d.slots}`);
    $('wb-inspect-level').classList.remove('locked');
    $('wb-inspect-effect').textContent =
      t('Click a piece to put it on or take it off. What the diver wears goes down with you, at the level you own.', '点击装备穿上或卸下，穿着的装备会带下水，等级与你拥有的一致。');
    $('wb-inspect-levels').replaceChildren(
      ...gear.map((g) => {
        const on = this.hooks.isReady(g);
        const lv = Math.min(3, Math.max(1, this.hooks.owned(g)));
        const li = document.createElement('li');
        li.textContent = `${on ? '✓' : '+'} ${lang() === 'zh' ? g.nameZh : g.name} · Lv ${lv}`;
        li.classList.toggle('on', on);
        li.classList.toggle('locked', !on && full); // no room for it
        li.title = on ? t('Take it off', '卸下') : full ? t('Every slot is taken: take something off first', '位置已满：先卸下一件') : t('Put it on', '穿上');
        li.addEventListener('click', () => {
          if (!on && full) {
            this.notice = ['Every slot is taken: take something off first.', '位置已满：先卸下一件。'];
            return this.renderInfo();
          }
          this.notice = null;
          this.hooks.setReady(g, !on);
          this.redress();
        });
        return li;
      }),
    );
    const off = $<HTMLButtonElement>('wb-inspect-ready');
    off.classList.remove('hidden', 'primary');
    off.textContent = t('Take all off', '全部卸下');
    off.disabled = worn.length === 0;

    $('wb-inspect-up-title').textContent = t('Packed for the dive', '本次携带');
    $('wb-inspect-up-effect').textContent = worn.length ? worn.map((g) => (lang() === 'zh' ? g.nameZh : g.name)).join(' · ') : t('Nothing: you dive with the basics', '什么都没带：只带基础装备下水');
    $('wb-inspect-up-price').textContent = t('Saved automatically: it is packed the same next time', '自动保存：下次下水携带相同');
    const all = $<HTMLButtonElement>('wb-inspect-buy');
    all.classList.remove('hidden');
    all.disabled = full || worn.length === gear.length;
    all.classList.toggle('primary', !all.disabled);
    all.textContent = t('Wear all', '全部穿上');
    $('wb-inspect-pearls').textContent = this.noticeText() || t(`${d.slots - worn.length} slot${d.slots - worn.length === 1 ? '' : 's'} free`, `空位 ${d.slots - worn.length}`);

    $('wb-inspect-dots').replaceChildren();
    $<HTMLButtonElement>('wb-inspect-prev').disabled = true;
    $<HTMLButtonElement>('wb-inspect-next').disabled = true;
    this.stage.classList.remove('locked');
    $('wb-inspect-lock').textContent = '';
  }

  /** The tray changed: a freshly dressed figure takes the old one's place on the turntable. */
  private redress() {
    const old = this.models.get(1);
    if (old) this.turntable.remove(old);
    this.models.delete(1);
    this.turntable.add(this.model(1));
    this.renderInfo();
  }

  /** Sail the ship looked at: set_ship on chain (one wallet prompt); the boat follows once it landed. */
  private async equipShip() {
    if (this.buying) return;
    const i = this.level - 1;
    this.buying = true;
    this.notice = null;
    this.renderInfo();
    const failed = await this.hooks.ships.equip(i);
    this.buying = false;
    if (!this.shipMode) return;
    this.notice = failed ? [failed, failed] : null;
    this.renderInfo();
  }

  /** Buys the next level; the piece on the table and the dots follow (the workbench rebuilds its model). */
  private async buy() {
    if (this.shipMode) return this.equipShip();
    if (this.diverMode) {
      this.hooks.diver.wearAll();
      return this.redress();
    }
    const def = this.def;
    if (!def || this.buying) return;
    this.buying = true;
    this.notice = null;
    this.renderInfo();
    const failed = await this.hooks.buy(def);
    this.buying = false;
    if (this.def !== def) return;
    this.notice = failed ? [failed, failed] : null;
    // Show the level just bought: its model slides in.
    const owned = this.hooks.owned(def);
    if (!failed && owned > this.level) this.step(owned - this.level);
    this.renderInfo();
  }

  /** From Lv2, the two branches: what each does at the level you're looking at; click to switch (free). */
  private renderPaths(def: UpgradeDef, owned: number) {
    const paths = this.hooks.paths(def);
    const box = $('wb-inspect-paths');
    box.classList.toggle('hidden', !paths);
    if (!paths) return;
    const active = this.hooks.activePath(def);
    $('wb-inspect-path-list').replaceChildren(
      ...paths.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `wb-path${p.id === active && owned >= 2 ? ' on' : ''}`;
        b.disabled = owned < 2 || this.buying || this.changingPath;
        const name = document.createElement('b');
        name.textContent = lang() === 'zh' ? p.nameZh : p.name;
        const effect = document.createElement('small');
        effect.textContent = owned < 2 ? `${t('Unlocks at Lv2', '2 级解锁')} · ${p.summary}` : p.effects[this.level - 1] ?? p.summary;
        b.append(name, effect);
        b.addEventListener('click', async () => {
          this.changingPath = true;
          this.previewLampPath = null;
          this.syncLampModel();
          this.renderInfo();
          try {
            await this.hooks.selectPath(def, p.id);
          } finally {
            this.changingPath = false;
            this.syncLampModel();
            this.renderInfo();
          }
        });
        return b;
      }),
    );
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  private frame(dt: number) {
    if (this.def?.id === 'lamp') {
      const state = [this.hooks.owned(this.def), this.hooks.activePath(this.def), this.hooks.pearls(), ...this.def.prices].join(':');
      if (state !== this.lampState) {
        this.lampState = state;
        this.syncLampModel();
        this.renderInfo();
      }
    }
    this.spin += dt * SPIN;
    const w = this.canvas.clientWidth || 1;
    // A swipe in progress pulls the model along a little (in world units at its depth).
    const pull = (this.drag / w) * 2.4;
    if (this.swap) {
      const s = this.swap;
      s.t = Math.min(1, s.t + dt / SWAP_S);
      const e = easeOut(s.t);
      s.from.position.x = -s.dir * 3.2 * e + pull;
      s.to.position.x = s.dir * 3.2 * (1 - e) + pull;
      s.from.scale.setScalar(1.15 * (1 - e * 0.4));
      s.to.scale.setScalar(1.15 * (0.6 + e * 0.4));
      if (s.t >= 1) {
        this.turntable.remove(s.from);
        s.from.position.x = 0;
        s.from.scale.setScalar(1.15);
        this.swap = null;
      }
    } else {
      this.model(this.level).position.x = pull;
    }
    // Each model turns on its own axis, so one sliding past doesn't swing round the middle.
    for (const m of this.turntable.children) m.rotation.y = this.spin + this.orbitYaw;
    this.turntable.rotation.x = 0.18 + this.orbitTilt;
    this.renderer.render(this.scene, this.camera);
  }
}

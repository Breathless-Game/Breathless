import * as THREE from 'three';
import { buildUpgradeModel, type UpgradeDef, type UpgradeLevel } from './upgrades';
import { loadSonarConfig, saveSonarConfig } from './sonar-config';

// A closer look at one piece of gear from the workbench: it grows from where it
// lies on the table to the middle of the screen over the blurred table, turning
// slowly. What it does is on the left; the upgrade (equipment.ts, through main's
// buyNextUpgrade) and, from Lv2, its branch are on the right. ← / → or a sideways
// swipe flips through its three levels; levels not owned yet show as a dark
// silhouette with their price. The boat opens the same view on the ships
// (ships.ts): ‹ › flips through all six, each with its bonuses, its banked-value
// threshold, and Equip.

const LEVELS: UpgradeLevel[] = [1, 2, 3];
const GROW_S = 0.35;
const SWAP_S = 0.28;
const SWIPE_PX = 70; // a sideways drag this long flips to the next level
const SPIN = 0.5; // radians per second on the turntable

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
  /** Pearls to spend (on-chain PEARL plus any legacy local ones). */
  pearls(): number;
  /** The two branches this gear can run from Lv2 (null: it has none), and which one it runs. */
  paths(def: UpgradeDef): { id: string; name: string; nameZh: string; summary: string; effects: readonly string[] }[] | null;
  activePath(def: UpgradeDef): string | null;
  selectPath(def: UpgradeDef, id: string): void;
  /** The ships, for the boat (showShips). */
  ships: ShipHooks;
  closed(): void;
}

/** One ship as the inspector shows it. */
export interface ShipEntry {
  name: string;
  nameZh: string;
  intro: string;
  introZh: string;
  /** Total banked value that unlocks it. */
  threshold: number;
  /** Its bonuses, one short line each. */
  bonuses: string[];
}

export interface ShipHooks {
  list(): readonly ShipEntry[];
  /** The ship sailed now (index). */
  current(): number;
  /** Total banked value so far. */
  progress(): number;
  /** A fresh copy of ship i's model, null while the models load. */
  model(i: number): THREE.Object3D | null;
  /** Sail ship i; false if it's still locked. */
  equip(i: number): boolean;
}

export class GearInspector {
  private root = $('wb-inspect');
  private stage = $('wb-inspect-stage');
  private canvas = $<HTMLCanvasElement>('wb-inspect-gl');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private turntable = new THREE.Group();
  private models = new Map<number, THREE.Group>();

  private def: UpgradeDef | null = null;
  /** Looking at the ships (the boat) rather than one piece of gear's levels. */
  private shipMode = false;
  private level = 1;
  private spin = 0;
  private swap: { t: number; dir: number; from: THREE.Group; to: THREE.Group } | null = null;
  private swipe: { x: number; id: number } | null = null;
  private drag = 0; // follows a swipe in progress, in screen px
  private raf = 0;
  private last = 0;
  private buying = false;
  private notice = '';

  constructor(private hooks: InspectHooks) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(new THREE.HemisphereLight('#e6f6ff', '#4a3420', 1.4));
    const key = new THREE.DirectionalLight('#fff1dc', 2.6);
    key.position.set(-3, 5, 4);
    const rim = new THREE.DirectionalLight('#9fe8ff', 1.2);
    rim.position.set(3, 1, -3);
    this.scene.add(key, rim, this.turntable);
    this.camera.position.set(0, 0.9, 5.2);
    this.camera.lookAt(0, 0, 0);

    $('wb-inspect-prev').addEventListener('click', () => this.step(-1));
    $('wb-inspect-next').addEventListener('click', () => this.step(1));
    $('wb-inspect-close').addEventListener('click', () => this.close());
    $('wb-inspect-buy').addEventListener('click', () => void this.buy());
    $('wb-inspect-ready').addEventListener('click', () => {
      if (!this.def) return;
      this.hooks.setReady(this.def, !this.hooks.isReady(this.def));
      this.renderInfo();
    });
    $('wb-inspect-sonar-input').addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      const saved = saveSonarConfig({ ...loadSonarConfig(), color });
      (e.target as HTMLInputElement).value = saved.color;
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
      this.swipe = { x: e.clientX, id: e.pointerId };
      this.stage.setPointerCapture(e.pointerId);
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (this.swipe?.id === e.pointerId) this.drag = e.clientX - this.swipe.x;
    });
    const endSwipe = (e: PointerEvent) => {
      if (this.swipe?.id !== e.pointerId) return;
      const dx = e.clientX - this.swipe.x;
      this.swipe = null;
      this.drag = 0;
      // Drag left for the next level, right for the one before: the model goes the way you push it.
      if (Math.abs(dx) > SWIPE_PX) this.step(dx < 0 ? 1 : -1);
    };
    this.stage.addEventListener('pointerup', endSwipe);
    this.stage.addEventListener('pointercancel', endSwipe);
    window.addEventListener('resize', () => this.open && this.resize());
  }

  get open() {
    return this.def !== null || this.shipMode;
  }

  /** How many models ‹ › flips through: three levels, or every ship. */
  private get count() {
    return this.shipMode ? this.hooks.ships.list().length : 3;
  }

  /** Look at `def`, growing it out of the screen point `from` (where it lies on the table). */
  show(def: UpgradeDef, from: { x: number; y: number }) {
    this.def = def;
    this.shipMode = false;
    this.level = Math.min(3, Math.max(1, this.hooks.owned(def)));
    this.open3d(from);
  }

  /** The ships, from the boat on the table: opens on the one sailed now. */
  showShips(from: { x: number; y: number }) {
    this.def = null;
    this.shipMode = true;
    this.level = this.hooks.ships.current() + 1;
    this.open3d(from);
  }

  private open3d(from: { x: number; y: number }) {
    this.notice = '';
    this.models.forEach((m) => this.turntable.remove(m));
    this.models.clear();
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
    this.shipMode = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.root.classList.remove('open');
    this.root.classList.add('hidden');
    this.hooks.closed();
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
      } else m = buildUpgradeModel(this.def!.id, level as UpgradeLevel);
      m.scale.setScalar(1.15); // 2 units across
      this.models.set(level, m);
    }
    return m;
  }

  private renderInfo() {
    if (this.shipMode) return this.renderShip();
    const def = this.def;
    if (!def) return;
    const owned = this.hooks.owned(def);
    const lv = this.level;
    const unlocked = lv <= owned;
    $('wb-inspect-name').textContent = def.name;
    $('wb-inspect-zh').textContent = def.nameZh;
    $('wb-inspect-up-kind').textContent = 'UPGRADE · 升级';
    this.root.classList.remove('ships');
    $('wb-inspect-kind').textContent = def.group === 'dive' ? 'Dive gear · 潜水装备' : 'Boat gear · 船上装备';
    $('wb-inspect-level').textContent = `Level ${lv} / 3${unlocked ? '' : ' · locked'}`;
    $('wb-inspect-level').classList.toggle('locked', !unlocked);
    $('wb-inspect-effect').textContent = def.effects[lv - 1];
    const sonarColor = $<HTMLLabelElement>('wb-inspect-sonar-color');
    const sonarInput = $<HTMLInputElement>('wb-inspect-sonar-input');
    const isSonar = def.id === 'sonar';
    sonarColor.classList.toggle('hidden', !isSonar);
    if (isSonar) sonarInput.value = loadSonarConfig().color;
    // Every level's line, so you can compare them; the one you're looking at is marked.
    $('wb-inspect-levels').replaceChildren(
      ...LEVELS.map((l) => {
        const li = document.createElement('li');
        li.textContent = `Lv ${l} · ${def.effects[l - 1]}`;
        li.classList.toggle('on', l === lv);
        li.classList.toggle('locked', l > owned);
        return li;
      }),
    );
    const ready = this.hooks.isReady(def);
    const readyBtn = $<HTMLButtonElement>('wb-inspect-ready');
    readyBtn.textContent = ready ? 'Put it back · 放回桌上' : 'Get it ready · 放入准备区';
    readyBtn.classList.toggle('primary', !ready);
    readyBtn.classList.toggle('hidden', def.group !== 'dive'); // the boat isn't packed for a dive

    // The upgrade panel: what the next level gives, what it costs, and the button to buy it.
    const nextLv = Math.min(3, owned + 1);
    const maxed = owned >= 3;
    const price = def.prices[nextLv - 1];
    const pearls = this.hooks.pearls();
    const short = !maxed && pearls < price;
    $('wb-inspect-up-title').textContent = maxed ? 'Fully upgraded · 已满级' : `Upgrade to level ${nextLv} · 升级`;
    $('wb-inspect-up-effect').textContent = maxed ? def.effects[2] : def.effects[nextLv - 1];
    $('wb-inspect-up-price').textContent = maxed ? '' : `${price} Pearls`;
    const buy = $<HTMLButtonElement>('wb-inspect-buy');
    buy.disabled = maxed || short || this.buying;
    buy.classList.toggle('primary', !buy.disabled);
    buy.textContent = this.buying ? 'Upgrading… · 升级中' : short ? `Need ${price - pearls} more · 珍珠不足` : `Upgrade · 升级 (${price})`;
    buy.classList.toggle('hidden', maxed);
    $('wb-inspect-pearls').textContent = this.notice || `You have ${Math.floor(pearls)} Pearls · 珍珠`;
    this.renderPaths(def, owned);

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
    $('wb-inspect-lock').textContent = unlocked ? '' : `🔒 ${def.prices[lv - 1]} Pearls`;
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
    $('wb-inspect-kind').textContent = 'Ship · 船只';
    $('wb-inspect-up-kind').textContent = 'SHIP · 船只';
    this.root.classList.add('ships');
    $('wb-inspect-name').textContent = ship.name;
    $('wb-inspect-zh').textContent = ship.nameZh;
    $('wb-inspect-level').textContent = `Level ${String(i).padStart(2, '0')} · ${i === current ? 'sailing · 当前使用' : unlocked ? 'unlocked · 已解锁' : 'locked · 未解锁'}`;
    $('wb-inspect-level').classList.toggle('locked', !unlocked);
    $('wb-inspect-effect').textContent = `${ship.introZh} ${ship.intro}`;
    // Every ship's bonuses, so they can be compared; the one shown is marked.
    $('wb-inspect-levels').replaceChildren(
      ...list.map((s, j) => {
        const li = document.createElement('li');
        li.textContent = `${String(j).padStart(2, '0')} ${s.name} · ${s.bonuses.join(' · ') || 'no bonus'}`;
        li.classList.toggle('on', j === i);
        li.classList.toggle('locked', progress < s.threshold);
        return li;
      }),
    );
    $('wb-inspect-ready').classList.add('hidden');
    $('wb-inspect-paths').classList.add('hidden');

    // The right panel: its bonuses, how far the banked value has come, and Equip.
    $('wb-inspect-up-title').textContent = i === current ? 'Sailing · 当前船只' : unlocked ? 'Equip this ship · 装备船只' : 'Locked · 未解锁';
    $('wb-inspect-up-effect').textContent = ship.bonuses.join(' · ') || 'The starter boat: no bonus';
    $('wb-inspect-up-price').textContent = ship.threshold ? `Unlocks at ${ship.threshold} banked value` : 'Starter ship';
    const buy = $<HTMLButtonElement>('wb-inspect-buy');
    buy.classList.remove('hidden');
    buy.disabled = i === current || !unlocked;
    buy.classList.toggle('primary', !buy.disabled);
    buy.textContent = i === current ? 'Equipped · 已装备' : unlocked ? 'Equip · 装备' : `Bank ${Math.ceil(ship.threshold - progress)} more · 未解锁`;
    $('wb-inspect-pearls').textContent = this.notice || `Total banked value ${Math.floor(progress)} · 累计入库价值 (no fish are spent)`;

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
    $('wb-inspect-lock').textContent = unlocked ? '' : `🔒 ${ship.threshold} banked value`;
  }

  private equipShip() {
    this.notice = this.hooks.ships.equip(this.level - 1) ? '' : 'Still locked: bank more fish first.';
    this.renderInfo();
  }

  /** Buys the next level; the piece on the table and the dots follow (the workbench rebuilds its model). */
  private async buy() {
    if (this.shipMode) return this.equipShip();
    const def = this.def;
    if (!def || this.buying) return;
    this.buying = true;
    this.notice = '';
    this.renderInfo();
    const failed = await this.hooks.buy(def);
    this.buying = false;
    if (this.def !== def) return;
    this.notice = failed ?? '';
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
        b.disabled = owned < 2;
        const name = document.createElement('b');
        name.textContent = `${p.name} · ${p.nameZh}`;
        const effect = document.createElement('small');
        effect.textContent = owned < 2 ? `Unlocks at Lv2 · ${p.summary}` : p.effects[this.level - 1] ?? p.summary;
        b.append(name, effect);
        b.addEventListener('click', () => {
          this.hooks.selectPath(def, p.id);
          this.renderInfo();
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
    for (const m of this.turntable.children) m.rotation.y = this.spin;
    this.turntable.rotation.x = 0.18;
    this.renderer.render(this.scene, this.camera);
  }
}

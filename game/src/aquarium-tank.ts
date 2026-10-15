import * as THREE from 'three';
import { buildFishMesh, disposeFishMesh, RARITY, type FishMesh } from './fish';
import type { BankedFish } from './market';
import { Rng } from './rng';
import { TableScene, type TableHooks } from './table-scene';

// The aquarium's table (aquarium.ts runs the tanks, favourites and the card): a
// real glass tank in the table's own 3D scene. It drops from above onto the table
// and lands with a thud (the table jolts, the tank squashes and bounces, the water
// sloshes); the banked fish are their 3D models, swimming in it at every depth.

// Table units (the table top is y = 0). The tank stands on a low wooden base.
const TANK = { w: 6.0, h: 2.45, d: 2.25, z: 0.3 };
const BASE_H = 0.32;
const SAND_H = 0.24;
const WATER = 0.86; // the water line, as a fraction of the tank's height
// Where fish swim, inside the glass (tank-local: x across, y up from the base, z toward you).
const SWIM = {
  x0: -TANK.w / 2 + 0.55,
  x1: TANK.w / 2 - 0.55,
  y0: BASE_H + SAND_H + 0.35,
  y1: BASE_H + TANK.h * WATER - 0.3,
  z0: -TANK.d / 2 + 0.35,
  z1: TANK.d / 2 - 0.35,
};
const FISH_LEN = [0.6, 1.3]; // a 15 cm fish, a 150 cm one (log scale between)
const DROP_S = 0.6;
const LIFT_S = 0.45;
const DROP_FROM = 11; // how high above the table the tank starts its fall
const THUD = 0.35;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

interface Swimmer {
  fish: BankedFish;
  mesh: FishMesh;
  /** The model at its length (the body's own scale stays for the tail wag). */
  holder: THREE.Group;
  len: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  heading: number;
  speed: number;
  phase: number;
  grow: number; // 0..1: fading in (scaling up) or out
  pulse: number; // 1 → 0 after it's fed: a quick swell
  leaving: boolean;
  emissive: THREE.Color; // its own glow, to go back to after a highlight
  emissiveIntensity: number;
}

interface Bubble {
  mesh: THREE.Mesh;
  v: number;
}

/** How feeding has changed a fish in the aquarium (aquarium-state.ts): only how it looks and swims here. */
export interface FishLook {
  /** Length multiplier from growth (1 = as caught). */
  scale: number;
  /** 0.. how strongly it glows (some foods). */
  glow: number;
  /** Swim speed multiplier. */
  speed: number;
}

/** Food poured in: flakes sink from the surface, and the school crowds round them. */
interface Food {
  flakes: { mesh: THREE.Mesh; v: number; wobble: number }[];
  at: THREE.Vector3; // where the school gathers (follows the sinking flakes)
  life: number;
}

const FOOD_S = 4.2;
const VIEW_RATE = 4.5;
// The top view: the camera above the tank looking down through the water (a hair off
// vertical, so "up" on screen stays the back of the tank).
const TOP_CAM = new THREE.Vector3(0, 10.5, TANK.z + 0.9);
const TOP_LOOK = new THREE.Vector3(0, 0.6, TANK.z);

export class TankTable extends TableScene {
  private tank = new THREE.Group();
  private water: THREE.Mesh;
  private surface: THREE.Mesh;
  private plants = new THREE.Group();
  private swimmers = new Map<BankedFish, Swimmer>();
  private bubbles: Bubble[] = [];
  private bubbleGeo = new THREE.SphereGeometry(0.035, 6, 4);
  private bubbleMat = new THREE.MeshStandardMaterial({ color: '#eafaff', transparent: true, opacity: 0.6, roughness: 0.1 });
  private drop: { t: number; dur: number; from: number; to: number; done: () => void } | null = null;
  private squash = 0; // the landing's squash-and-bounce, a decaying wobble
  private slosh = 0;
  private hovered: Swimmer | null = null;
  private picked: Swimmer | null = null;
  private lamp = new THREE.PointLight('#9fe8ff', 2.2, 6, 1.6);
  private food: Food | null = null;
  private foodGeo = new THREE.DodecahedronGeometry(0.035, 0);
  private foodMat = new THREE.MeshStandardMaterial({ color: '#e0b25a', roughness: 0.8, flatShading: true });
  private view = 0; // 0 front, 1 top
  private viewTarget = 0;
  private frontCam = new THREE.Vector3(0, 3.7, 9.8);
  private frontLook = new THREE.Vector3(0, 1.35, 0);
  /** How feeding has changed a fish (set by aquarium.ts); defaults to as caught. */
  look: (f: BankedFish) => FishLook = () => ({ scale: 1, glow: 0, speed: 1 });

  constructor(hooks: TableHooks) {
    super('aquarium-table', hooks);
    // Lower than the workbench's view and more head-on: you look into the tank through its front glass.
    this.camAt.copy(this.frontCam);
    this.lookAt.copy(this.frontLook);
    this.water = new THREE.Mesh();
    this.surface = new THREE.Mesh();
    this.buildTank();
    this.tank.visible = false;
    this.scene.add(this.tank);
  }

  // ---- The tank's fall and lift ---------------------------------------------

  /** Up above the view, out of sight, until dropTank(). */
  hold() {
    this.tank.visible = true;
    this.tank.position.y = DROP_FROM;
    this.drop = null;
  }

  /** It falls onto the table and lands with a thud. */
  dropTank(done: () => void) {
    this.drop = { t: 0, dur: DROP_S, from: DROP_FROM, to: 0, done };
  }

  /** Lifted off the table, up out of sight. */
  liftTank(done: () => void) {
    this.drop = { t: 0, dur: LIFT_S, from: this.tank.position.y, to: DROP_FROM, done };
  }

  // ---- Fish -------------------------------------------------------------------

  /** Swims these fish: new ones grow in where they spawn, ones no longer here shrink away. */
  setFish(list: readonly BankedFish[]) {
    const keep = new Set(list);
    for (const s of this.swimmers.values()) s.leaving = !keep.has(s.fish);
    for (const f of list) {
      const s = this.swimmers.get(f);
      if (s) s.leaving = false;
      else this.swimmers.set(f, this.spawn(f));
    }
    if (this.picked?.leaving) this.picked = null;
  }

  /** Clears every fish at once (a fresh visit). */
  clearFish() {
    for (const s of this.swimmers.values()) this.dispose(s);
    this.swimmers.clear();
    this.picked = this.hovered = null;
  }

  /** The ambience light (the bar's colour picker): the lamp inside, and a tint in the water. */
  setLight(hex: string) {
    const c = new THREE.Color(hex);
    this.lamp.color.copy(c);
    (this.water.material as THREE.MeshStandardMaterial).color.copy(new THREE.Color('#2a8fb8').lerp(c, 0.45));
  }

  /** Looking down into the tank from above (a double-click), or back at its front. */
  setTopView(on: boolean) {
    this.viewTarget = on ? 1 : 0;
  }

  get topView() {
    return this.viewTarget > 0.5;
  }

  /** Food poured in: it sinks from the surface, and every fish rushes over to it, bubbling. */
  pourFood() {
    this.clearFood();
    const top = BASE_H + TANK.h * WATER;
    const at = new THREE.Vector3((Math.random() - 0.5) * TANK.w * 0.3, top - 0.1, TANK.d * 0.05);
    const flakes = Array.from({ length: 14 }, () => {
      const mesh = new THREE.Mesh(this.foodGeo, this.foodMat);
      mesh.position.set(at.x + (Math.random() - 0.5) * 0.7, top - 0.02, at.z + (Math.random() - 0.5) * 0.5);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, 0);
      this.tank.add(mesh);
      return { mesh, v: 0.18 + Math.random() * 0.14, wobble: Math.random() * 6 };
    });
    this.food = { flakes, at, life: FOOD_S };
    for (const s of this.swimmers.values()) {
      if (s.leaving) continue;
      s.target.set(at.x + (Math.random() - 0.5) * 0.6, at.y - 0.25 - Math.random() * 0.3, at.z + (Math.random() - 0.5) * 0.5);
      for (let i = 0; i < 3; i++) this.addBubble(s.pos.x + (Math.random() - 0.5) * 0.2, s.pos.y, s.pos.z, 0.7 + Math.random() * 0.4);
    }
  }

  /** It just grew (fed): a quick swell. */
  pulse(f: BankedFish) {
    const s = this.swimmers.get(f);
    if (s) s.pulse = 1;
  }

  private clearFood() {
    for (const f of this.food?.flakes ?? []) this.tank.remove(f.mesh);
    this.food = null;
  }

  private addBubble(x: number, y: number, z: number, v: number) {
    const mesh = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.6 + Math.random());
    this.tank.add(mesh);
    this.bubbles.push({ mesh, v });
  }

  /** The fish under the pointer, or null. */
  fishAt(e: PointerEvent): BankedFish | null {
    if (!this.ours(e)) return null;
    this.setRay(e);
    const live = [...this.swimmers.values()].filter((s) => !s.leaving && s.grow > 0.5);
    const hit = this.ray.intersectObjects(
      live.map((s) => s.holder),
      true,
    )[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.fish) o = o.parent;
    return (o?.userData.fish as BankedFish) ?? null;
  }

  setHover(f: BankedFish | null) {
    this.hovered = f ? (this.swimmers.get(f) ?? null) : null;
  }

  /** The fish being looked at (its card is open): it glows and idles. */
  setPicked(f: BankedFish | null) {
    this.picked = f ? (this.swimmers.get(f) ?? null) : null;
  }

  /** Plants and stones for a tank, seeded so each tank keeps its look (favourites: pink). */
  setScenery(seed: number, favourites: boolean) {
    this.tank.remove(this.plants);
    this.plants.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.plants = new THREE.Group();
    const rng = new Rng(seed);
    const floor = BASE_H + SAND_H;
    for (let i = rng.int(6, 10); i > 0; i--) {
      const clump = new THREE.Group();
      const hue = favourites ? rng.range(320, 350) : rng.range(95, 160);
      const h = rng.range(0.6, 1.5);
      for (let b = rng.int(2, 4); b > 0; b--) {
        // Built standing on its base (y = 0), so the sway can bend it without moving the root.
        const bh = h * rng.range(0.7, 1);
        const geo = new THREE.ConeGeometry(0.07, bh, 4, 6);
        geo.translate(0, bh / 2, 0);
        const blade = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue / 360, 0.45, rng.range(0.25, 0.38)), flatShading: true }),
        );
        blade.position.set(rng.range(-0.1, 0.1), 0, rng.range(-0.08, 0.08));
        blade.userData.phase = rng.range(0, Math.PI * 2);
        blade.userData.rest = Float32Array.from(geo.getAttribute('position').array as ArrayLike<number>);
        blade.userData.h = bh;
        clump.add(blade);
      }
      clump.position.set(rng.range(SWIM.x0 - 0.3, SWIM.x1 + 0.3), floor, rng.range(-TANK.d / 2 + 0.25, TANK.d / 2 - 0.5));
      this.plants.add(clump);
    }
    const stone = new THREE.MeshStandardMaterial({ color: '#6c7378', roughness: 0.9, flatShading: true });
    for (let i = rng.int(3, 5); i > 0; i--) {
      const r = rng.range(0.15, 0.35);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), stone);
      rock.scale.y = 0.6;
      rock.position.set(rng.range(SWIM.x0, SWIM.x1), floor + r * 0.25, rng.range(-TANK.d / 2 + 0.3, TANK.d / 2 - 0.3));
      rock.rotation.y = rng.range(0, Math.PI);
      this.plants.add(rock);
    }
    this.tank.add(this.plants);
    for (const b of this.bubbles) this.tank.remove(b.mesh);
    this.bubbles = [];
  }

  protected onHide() {
    this.clearFish();
    this.clearFood();
    this.tank.visible = false;
    this.view = this.viewTarget = 0;
  }

  protected onFrame(dt: number) {
    this.updateDrop(dt);
    // Front view ↔ top view, eased.
    this.view += (this.viewTarget - this.view) * Math.min(1, dt * VIEW_RATE);
    const v = this.view * this.view * (3 - 2 * this.view);
    this.camAt.lerpVectors(this.frontCam, TOP_CAM, v);
    this.lookAt.lerpVectors(this.frontLook, TOP_LOOK, v);
    // Food sinks, rocking, and is eaten away.
    const food = this.food;
    if (food) {
      food.life -= dt;
      const floor = BASE_H + SAND_H + 0.05;
      for (const f of food.flakes) {
        f.mesh.position.y = Math.max(floor, f.mesh.position.y - f.v * dt);
        f.mesh.position.x += Math.sin(this.time * 2 + f.wobble) * dt * 0.08;
        f.mesh.rotation.x += dt * 1.5;
        f.mesh.scale.setScalar(Math.max(0.01, Math.min(1, food.life / 1.2)));
      }
      food.at.y = Math.max(SWIM.y0 + 0.3, food.at.y - dt * 0.25);
      if (food.life <= 0) this.clearFood();
    }
    for (const s of [...this.swimmers.values()]) {
      this.swim(s, dt);
      if (s.leaving && s.grow === 0) {
        this.dispose(s);
        this.swimmers.delete(s.fish);
      }
    }
    // Plants sway; the water surface ripples (more while it sloshes after the landing).
    // A blade bends rather than swings: its root stays put in the sand, and each point
    // leans with the current by the square of its height up the blade.
    for (const clump of this.plants.children) {
      for (const blade of clump.children) {
        const rest = blade.userData.rest as Float32Array | undefined;
        if (!rest || !(blade instanceof THREE.Mesh)) continue;
        const ph = blade.userData.phase as number;
        const h = blade.userData.h as number;
        const sway = Math.sin(this.time * 1.1 + ph) * 0.12 * h;
        const drift = Math.sin(this.time * 0.7 + ph * 1.7) * 0.05 * h;
        const pos = blade.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const y = rest[i * 3 + 1];
          const k = (y / h) ** 2;
          pos.setX(i, rest[i * 3] + sway * k);
          pos.setZ(i, rest[i * 3 + 2] + drift * k);
        }
        pos.needsUpdate = true;
      }
    }
    this.slosh = Math.max(0, this.slosh - dt * 0.5);
    const pos = this.surface.geometry.getAttribute('position') as THREE.BufferAttribute;
    const amp = 0.025 + this.slosh * 0.12;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // the plane lies flat: its y is the tank's z
      pos.setZ(i, Math.sin(x * 2.2 + this.time * 2.2 + y * 1.5) * amp + Math.sin(x * 0.8 - this.time * 1.4) * this.slosh * 0.1);
    }
    pos.needsUpdate = true;
    // Bubbles from two airstones at the back.
    if (this.tank.visible && Math.random() < dt * 8) {
      for (const x of [-TANK.w * 0.33, TANK.w * 0.36]) {
        const mesh = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
        mesh.position.set(x + (Math.random() - 0.5) * 0.08, BASE_H + SAND_H, -TANK.d / 2 + 0.3);
        mesh.scale.setScalar(0.6 + Math.random());
        this.tank.add(mesh);
        this.bubbles.push({ mesh, v: 0.6 + Math.random() * 0.5 });
      }
    }
    const top = BASE_H + TANK.h * WATER;
    this.bubbles = this.bubbles.filter((b) => {
      b.mesh.position.y += b.v * dt;
      b.mesh.position.x += Math.sin(this.time * 4 + b.v * 9) * dt * 0.05;
      if (b.mesh.position.y < top) return true;
      this.tank.remove(b.mesh);
      return false;
    });
  }

  // ---- Building ---------------------------------------------------------------

  private buildTank() {
    const t = this.tank;
    // The base: dark wood, a little wider than the glass.
    const wood = new THREE.MeshStandardMaterial({ color: '#2e1d10', roughness: 0.8 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(TANK.w + 0.3, BASE_H, TANK.d + 0.3), wood);
    base.position.y = BASE_H / 2;
    base.castShadow = base.receiveShadow = true;
    t.add(base);
    // Sand, lighter on top.
    const sand = new THREE.Mesh(new THREE.BoxGeometry(TANK.w - 0.06, SAND_H, TANK.d - 0.06), new THREE.MeshStandardMaterial({ color: '#cbb58a', roughness: 1 }));
    sand.position.y = BASE_H + SAND_H / 2;
    sand.receiveShadow = true;
    t.add(sand);
    // The water: a tinted volume, and its surface rippling on top.
    const waterH = TANK.h * WATER - SAND_H;
    this.water = new THREE.Mesh(
      new THREE.BoxGeometry(TANK.w - 0.06, waterH, TANK.d - 0.06),
      new THREE.MeshStandardMaterial({ color: '#2a8fb8', transparent: true, opacity: 0.22, roughness: 0.2, depthWrite: false }),
    );
    this.water.position.y = BASE_H + SAND_H + waterH / 2;
    this.water.renderOrder = 1;
    t.add(this.water);
    this.surface = new THREE.Mesh(
      new THREE.PlaneGeometry(TANK.w - 0.06, TANK.d - 0.06, 28, 10),
      new THREE.MeshStandardMaterial({ color: '#bfefff', transparent: true, opacity: 0.35, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false, flatShading: true }),
    );
    this.surface.rotation.x = -Math.PI / 2;
    this.surface.position.y = BASE_H + TANK.h * WATER;
    this.surface.renderOrder = 2;
    t.add(this.surface);
    // The glass: five panes (no lid), faintly blue, and a dark frame on every edge.
    const glass = new THREE.MeshPhysicalMaterial({ color: '#cdeeff', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, side: THREE.DoubleSide, depthWrite: false });
    const pane = (w: number, h: number, x: number, y: number, z: number, ry = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.renderOrder = 3;
      t.add(m);
    };
    const cy = BASE_H + TANK.h / 2;
    pane(TANK.w, TANK.h, 0, cy, TANK.d / 2);
    pane(TANK.w, TANK.h, 0, cy, -TANK.d / 2);
    pane(TANK.d, TANK.h, -TANK.w / 2, cy, 0, Math.PI / 2);
    pane(TANK.d, TANK.h, TANK.w / 2, cy, 0, Math.PI / 2);
    const frame = new THREE.MeshStandardMaterial({ color: '#141c24', roughness: 0.5, metalness: 0.4 });
    const bar = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), frame);
      m.position.set(x, y, z);
      m.castShadow = true;
      t.add(m);
    };
    const e = 0.07;
    for (const y of [BASE_H + e / 2, BASE_H + TANK.h]) {
      bar(TANK.w + e, e, e, 0, y, TANK.d / 2);
      bar(TANK.w + e, e, e, 0, y, -TANK.d / 2);
      bar(e, e, TANK.d + e, -TANK.w / 2, y, 0);
      bar(e, e, TANK.d + e, TANK.w / 2, y, 0);
    }
    for (const x of [-TANK.w / 2, TANK.w / 2]) for (const z of [-TANK.d / 2, TANK.d / 2]) bar(e, TANK.h, e, x, cy, z);
    // A glow inside, so the water reads as lit.
    this.lamp.position.set(0, BASE_H + TANK.h * 0.95, 0);
    t.add(this.lamp);
    t.position.z = TANK.z;
  }

  private spawn(fish: BankedFish): Swimmer {
    const mesh = buildFishMesh(fish);
    // 15 cm reads as small, 150 cm as large.
    const size = clamp(Math.log(Math.max(fish.lengthCm, 1) / 15) / Math.log(10), 0, 1);
    const len = lerp(FISH_LEN[0], FISH_LEN[1], size);
    const holder = new THREE.Group();
    mesh.group.scale.setScalar(len / mesh.size.len);
    holder.add(mesh.group);
    mesh.group.rotation.y = mesh.swimYaw ?? 0;
    holder.userData.fish = fish;
    mesh.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const pos = new THREE.Vector3(lerp(SWIM.x0, SWIM.x1, Math.random()), lerp(SWIM.y0, SWIM.y1, Math.random()), lerp(SWIM.z0, SWIM.z1, Math.random()));
    holder.position.copy(pos);
    holder.scale.setScalar(0);
    this.tank.add(holder);
    const dir = Math.random() < 0.5 ? -1 : 1;
    return {
      fish,
      mesh,
      holder,
      len,
      pos,
      vel: new THREE.Vector3(dir * 0.2, 0, 0),
      target: pos.clone(),
      heading: dir > 0 ? 0 : Math.PI,
      speed: 0.35 + RARITY[fish.rarity].speed * 0.08,
      phase: Math.random() * Math.PI * 2,
      grow: 0,
      pulse: 0,
      leaving: false,
      emissive: mesh.material.emissive.clone(),
      emissiveIntensity: mesh.material.emissiveIntensity,
    };
  }

  private swim(s: Swimmer, dt: number) {
    const look = this.look(s.fish);
    if (s.pos.distanceTo(s.target) < 0.25) {
      const f = this.food;
      if (f && !s.leaving) {
        // Food in the water: keep circling it, so the whole school visibly competes.
        s.target.set(
          clamp(f.at.x + (Math.random() - 0.5) * 0.7, SWIM.x0, SWIM.x1),
          clamp(f.at.y - 0.15 - Math.random() * 0.35, SWIM.y0, SWIM.y1),
          clamp(f.at.z + (Math.random() - 0.5) * 0.6, SWIM.z0, SWIM.z1),
        );
      } else {
        // Mostly along the tank, drifting up and down and toward and away from the glass.
        s.target.set(
          clamp(s.pos.x + (Math.random() - 0.5) * 4, SWIM.x0, SWIM.x1),
          clamp(s.pos.y + (Math.random() - 0.5) * 0.8, SWIM.y0, SWIM.y1),
          clamp(s.pos.z + (Math.random() - 0.5) * 1.2, SWIM.z0, SWIM.z1),
        );
      }
    }
    const to = s.target.clone().sub(s.pos);
    const d = to.length() || 1;
    // The fish you're looking at idles where it is; food makes the rest hurry.
    const speed = (s === this.picked ? s.speed * 0.12 : s.speed * (this.food ? 1.8 : 1)) * look.speed;
    const k = Math.min(1, dt * 1.4);
    s.vel.x += ((to.x / d) * speed - s.vel.x) * k;
    s.vel.y += ((to.y / d) * speed * 0.5 - s.vel.y) * k;
    s.vel.z += ((to.z / d) * speed * 0.6 - s.vel.z) * k;
    s.pos.addScaledVector(s.vel, dt);
    s.pos.set(clamp(s.pos.x, SWIM.x0, SWIM.x1), clamp(s.pos.y, SWIM.y0, SWIM.y1), clamp(s.pos.z, SWIM.z0, SWIM.z1));
    // Turn toward where it's going (the model's nose is +x), nose up or down with the climb.
    const flat = Math.hypot(s.vel.x, s.vel.z);
    if (flat > 0.03) {
      const want = Math.atan2(-s.vel.z, s.vel.x);
      let diff = want - s.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      s.heading += diff * Math.min(1, dt * 3);
    }
    s.holder.position.copy(s.pos);
    s.holder.position.y += Math.sin(this.time * 1.6 + s.phase) * 0.03;
    s.holder.rotation.set(0, s.heading, clamp(Math.atan2(s.vel.y, Math.max(0.03, flat)), -0.35, 0.35), 'YXZ');
    if (s.mesh.animate) s.mesh.animate(this.time + s.phase, s.vel.length());
    else s.mesh.tail.rotation.y = Math.sin(this.time * (6 + flat * 8) + s.phase) * 0.35;
    s.grow = clamp(s.grow + (s.leaving ? -dt * 2.5 : dt * 1.8), 0, 1);
    s.pulse = Math.max(0, s.pulse - dt * 1.8);
    // Grown by feeding (its length, on the same log scale as at spawn), and swelling just after.
    const size = clamp(Math.log(Math.max(s.fish.lengthCm * look.scale, 1) / 15) / Math.log(10), 0, 1);
    const len = lerp(FISH_LEN[0], FISH_LEN[1], size);
    s.holder.scale.setScalar(s.grow * (len / s.len) * (1 + Math.sin((1 - s.pulse) * Math.PI) * s.pulse * 0.25));
    // Hovered or picked: it glows in its rarity's colour; some foods leave a glow of their own.
    const lit = s === this.picked ? 0.55 : s === this.hovered ? 0.3 : Math.min(0.6, look.glow * 0.5);
    const m = s.mesh.material;
    if (lit) {
      m.emissive.set(RARITY[s.fish.rarity].color);
      m.emissiveIntensity = lit;
    } else {
      m.emissive.copy(s.emissive);
      m.emissiveIntensity = s.emissiveIntensity;
    }
  }

  private dispose(s: Swimmer) {
    this.tank.remove(s.holder);
    disposeFishMesh(s.mesh);
  }

  private updateDrop(dt: number) {
    const d = this.drop;
    if (d) {
      d.t = Math.min(d.dur, d.t + dt);
      const u = d.t / d.dur;
      // Falling: gravity (ease in). Lifted: eased off the table.
      const e = d.to < d.from ? u * u : 1 - (1 - u) * (1 - u);
      this.tank.position.y = lerp(d.from, d.to, e);
      if (d.t >= d.dur) {
        this.drop = null;
        if (d.to === 0) {
          // Landed: the table jolts, the tank squashes and bounces, the water sloshes.
          this.jolt(THUD);
          this.squash = 1;
          this.slosh = 1;
        }
        d.done();
      }
    }
    // The landing's wobble: squashed flat, then up, settling.
    this.squash = Math.max(0, this.squash - dt * 2.4);
    const w = Math.sin((1 - this.squash) * Math.PI * 3) * this.squash;
    this.tank.scale.set(1 + w * 0.025, 1 - w * 0.05, 1 + w * 0.025);
  }
}

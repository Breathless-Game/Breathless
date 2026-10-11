import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EventSchedule, type EventDef } from './event-schedule';
import { AuroraCurtain, auroraGlow } from './aurora';
import { Particles, Rings, bubbleTexture, clamp01, disposeAll, fogAmount, pulse, smoothstep, softTexture } from './fx';
import { flatMat, jitter } from './lowpoly';
import { mapDepth, type MapDef, type MapId } from './maps';
import { Rng } from './rng';

// Random world events: an avalanche in the fjord, a whale breaching off the
// ocean, a leviathan passing in the deep... One plays at a time, picked by
// event-schedule.ts for what the diver can see from their depth.
//
// Each event builds its meshes once per map and detail level, keeps them
// hidden while idle (zero draw calls) and reuses them on every trigger.
// Particles come from shared pools in fx.ts. No lights, no shadows, and no
// allocations in the per-frame path.
//
// Call `update` after World.update each frame: the lightning flash tints the
// fog and background that World writes, and restores them when it ends.

export type Detail = 1 | 2 | 3; // low / medium / high

export interface WorldEventInfo {
  id: string;
  label: string;
  map: MapId | 'any';
  underwater: boolean;
}

export interface EventContext {
  cameraY: number;
  depth: number;
  night: boolean;
  shelfDepth: number;
  /** Optional camera x, so events play where the player is looking. Defaults to 0. */
  cameraX?: number;
  /** Optional viewport width / height, so events stay in frame on narrow screens. Defaults to 1.6. */
  aspect?: number;
  /** The "Lighting effects" setting: off rules out (and stops) the aurora and lightning. Defaults to on. */
  lightingEffects?: boolean;
  /** Current weather, 0-1 (WeatherState.storm / .cloud). Lightning needs a storm; cloud hides the aurora. */
  storm?: number;
  cloud?: number;
  /** World y of the floor under the camera: the map's shelf by default, -Infinity down the bottomless trench. */
  floorY?: number;
}

export interface WorldEventsOptions {
  /** Random source for scheduling and event variety (tests inject their own). */
  rng?: () => number;
}

// The game camera: 48° vertical FOV from z = +22, looking slightly down. Used to
// keep events in frame (the half-width also needs the aspect, see Kit.halfWidth).
const CAM_Z = 22;
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(24));
const LOOK_SLOPE = 1.6 / 22;
const viewTop = (camY: number, z: number) => camY + (CAM_Z - z) * (TAN_HALF_FOV - LOOK_SLOPE);

// Scratch objects for the per-frame path.
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _box = new THREE.Box3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

// ---- Geometry helpers (build time only) ---------------------------------

/** Non-indexed, no uv, with normals: the shape every merged piece must share. */
function prep(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  g.clearGroups();
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function place(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  geo.applyMatrix4(_m);
  return geo;
}

/** Colour each triangle from its centre (and how upward it faces). */
function paint(geo: THREE.BufferGeometry, pick: (x: number, y: number, z: number, up: number) => THREE.ColorRepresentation) {
  const g = prep(geo);
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const up = b.clone().sub(a).cross(c.clone().sub(a)).normalize().y;
    color.set(pick((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, up));
    for (let k = 0; k < 3; k++) color.toArray(colors, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const solid = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation) => paint(geo, () => color);

function merge(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** A flat triangle list in the y = 0 plane, coloured per triangle. */
function flatTris(tris: [number[], number[], number[], THREE.ColorRepresentation][]) {
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const c = new THREE.Color();
  for (const [a, b, d, color] of tris) {
    c.set(color);
    for (const p of [a, b, d]) {
      pos.push(p[0], p[1], p[2]);
      col.push(c.r, c.g, c.b);
      nor.push(0, 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** A body of revolution along +x from (radius, x) pairs, tail first. */
function lathe(profile: [number, number][], segments: number) {
  const geo = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segments);
  geo.rotateZ(-Math.PI / 2);
  return geo;
}

function hideInstances(mesh: THREE.InstancedMesh) {
  for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, HIDDEN);
  mesh.instanceMatrix.needsUpdate = true;
}

function dynamicInstances(geo: THREE.BufferGeometry, mat: THREE.Material, count: number) {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  hideInstances(mesh);
  return mesh;
}

// ---- Shared state -------------------------------------------------------

/** Finds the shoreline's surfaces (peaks, pillars) so events land on them, whatever scenery.ts builds. */
class Probe {
  private ray = new THREE.Raycaster();
  private hits: THREE.Intersection[] = [];
  private targets: THREE.Object3D[] = [];
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();

  /** Gather the solid meshes above the water, skipping our own. Called when an event starts. */
  collect(scene: THREE.Scene, exclude: THREE.Object3D) {
    this.targets.length = 0;
    scene.updateMatrixWorld();
    const walk = (o: THREE.Object3D) => {
      if (o === exclude) return;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!mat.transparent) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          _box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
          if (_box.max.y > 2) this.targets.push(mesh);
        }
      }
      for (const child of o.children) walk(child);
    };
    walk(scene);
  }

  /** z of the first surface met travelling toward -z from (x, y, zFrom), or NaN. */
  hitZ(x: number, y: number, zFrom: number, zTo: number): number {
    return this.cast(this.origin.set(x, y, zFrom), this.dir.set(0, 0, -1), zFrom - zTo, 2);
  }

  /** y of the first surface met dropping from (x, yFrom, z), or NaN. */
  hitY(x: number, z: number, yFrom: number, yTo: number): number {
    return this.cast(this.origin.set(x, yFrom, z), this.dir.set(0, -1, 0), yFrom - yTo, 1);
  }

  private cast(origin: THREE.Vector3, dir: THREE.Vector3, far: number, axis: 1 | 2) {
    this.ray.set(origin, dir);
    this.ray.far = far;
    this.hits.length = 0;
    this.ray.intersectObjects(this.targets, false, this.hits);
    return this.hits.length ? this.hits[0].point.getComponent(axis) : NaN;
  }
}

class Kit {
  readonly root = new THREE.Group();
  /** Estimated camera position (x from the context, z fixed by the game's framing). */
  readonly cam = new THREE.Vector3(0, 2.2, CAM_Z);
  readonly probe = new Probe();
  light = 1;
  night = false;
  depth = 0;
  shelfDepth = 30;
  seabedY: number;
  /** The floor under the camera (see EventContext.floorY): what deep events keep above. */
  floorY: number;
  /** True when the context passed a camera x, so events may stay close to it. */
  aimed = false;
  aspect = 1.6;
  cloud = 0;
  private textures: { soft?: THREE.Texture; bubble?: THREE.Texture } = {};
  private pools: { puff?: Particles; bubbles?: Particles; rings?: Rings } = {};

  constructor(readonly scene: THREE.Scene, public map: MapDef, public detail: Detail, readonly rng: () => number) {
    this.root.name = 'world-events';
    this.seabedY = -mapDepth(map);
    this.floorY = this.seabedY;
    scene.add(this.root);
  }

  n(low: number, medium: number, high: number) {
    return this.detail === 1 ? low : this.detail === 2 ? medium : high;
  }

  range(min: number, max: number) {
    return min + (max - min) * this.rng();
  }

  /** Half the visible width at depth z. */
  halfWidth(z: number) {
    return (CAM_Z - z) * TAN_HALF_FOV * this.aspect;
  }

  /**
   * Move x out from behind the moored boat (x = 0, z = 0) as seen against depth z,
   * toward `side` or the nearer side, so an event there is not hidden by it. Never
   * further than `within` from the camera: on a narrow screen there is no room
   * beside the boat, and half hidden beats out of frame.
   */
  clearOfBoat(x: number, z: number, gap: number, within: number, side = 0) {
    const boat = this.cam.x * (1 - (CAM_Z - z) / CAM_Z);
    if (Math.abs(x - boat) < gap) x = boat + (side || (x >= boat ? 1 : -1)) * gap;
    return THREE.MathUtils.clamp(x, this.cam.x - within, this.cam.x + within);
  }

  sign() {
    return this.rng() < 0.5 ? -1 : 1;
  }

  /** Puffs are bigger at low detail so fewer of them still read as a cloud. */
  get puffScale() {
    return this.n(1.55, 1.15, 1);
  }

  /** Foam rings sit just above the wave crests. */
  get ringY() {
    return 0.25 + 0.62 * this.map.waves;
  }

  add<T extends THREE.Object3D>(o: T): T {
    o.visible = false;
    this.root.add(o);
    return o;
  }

  /** Soft puffs: powder snow, spray, dust, smoke, silt. Normal blending, fogged. */
  get puff(): Particles {
    if (!this.pools.puff) {
      this.textures.soft ??= softTexture();
      this.pools.puff = new Particles({ capacity: this.n(100, 280, 560), texture: this.textures.soft });
      this.root.add(this.pools.puff.points);
    }
    return this.pools.puff;
  }

  get bubbles(): Particles {
    if (!this.pools.bubbles) {
      this.textures.bubble ??= bubbleTexture();
      this.pools.bubbles = new Particles({ capacity: this.n(60, 180, 380), texture: this.textures.bubble, wobble: 0.9 });
      this.root.add(this.pools.bubbles.points);
    }
    return this.pools.bubbles;
  }

  get rings(): Rings {
    if (!this.pools.rings) {
      this.pools.rings = new Rings(this.n(4, 6, 8), this.n(20, 28, 40), this.scene, this.cam);
      this.root.add(this.pools.rings.mesh);
    }
    return this.pools.rings;
  }

  get softTex(): THREE.Texture {
    return (this.textures.soft ??= softTexture());
  }

  setContext(ctx: EventContext) {
    this.aimed = ctx.cameraX !== undefined;
    this.cam.set(ctx.cameraX ?? 0, ctx.cameraY, CAM_Z);
    this.aspect = THREE.MathUtils.clamp(ctx.aspect ?? 1.6, 0.45, 2.4);
    this.night = ctx.night;
    this.depth = ctx.depth;
    this.shelfDepth = ctx.shelfDepth;
    this.cloud = THREE.MathUtils.clamp(ctx.cloud ?? 0, 0, 1);
    this.floorY = ctx.floorY ?? this.seabedY;
    // Same falloff World uses for its own lights.
    this.light = THREE.MathUtils.clamp(1 + ctx.cameraY / 75, 0.12, 1) * (ctx.night ? 0.35 : 1);
  }

  updatePools(dt: number) {
    const { puff, bubbles, rings } = this.pools;
    if (puff) {
      puff.light = this.light;
      puff.update(dt);
    }
    if (bubbles) {
      bubbles.light = Math.max(0.35, this.light);
      bubbles.update(dt);
    }
    if (rings) {
      rings.light = this.light;
      rings.update(dt);
    }
  }

  clearPools() {
    this.pools.puff?.clear();
    this.pools.bubbles?.clear();
    this.pools.rings?.clear();
  }

  /** Free every event mesh and pool (textures survive for the next build). */
  disposeContent() {
    this.pools.puff?.dispose();
    this.pools.bubbles?.dispose();
    this.pools = {};
    disposeAll(this.root);
    this.root.clear();
  }

  dispose() {
    this.disposeContent();
    this.textures.soft?.dispose();
    this.textures.bubble?.dispose();
    this.textures = {};
    this.scene.remove(this.root);
  }
}

abstract class Effect {
  /** Seconds since the event started. */
  t = 0;
  duration = 10;
  /** Camera shake this event asks for right now (world units). */
  shake = 0;
  constructor(protected k: Kit) {}
  /** Allocate meshes (hidden) and touch the shared pools it uses. Called once per map and detail level. */
  abstract build(): void;
  abstract start(): void;
  abstract step(dt: number): void;
  /** Hide everything and undo any scene changes. */
  abstract stop(): void;
}

// Colours shared by several events.
const WHITE = new THREE.Color('#ffffff');
const SPRAY = new THREE.Color('#f4fbff');
const MIST = new THREE.Color('#e9f2f5');

/** A burst of white water where something hit the sea. */
function splash(k: Kit, x: number, z: number, count: number, up: number, spread: number, mist: number) {
  const sz = k.puffScale;
  for (let i = 0; i < count; i++) {
    const a = k.rng() * Math.PI * 2;
    const r = k.range(0.25, 1) * spread;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    k.puff.spawn(
      x + cx * spread * 0.3, 0.3, z + cz * spread * 0.3,
      cx * r, k.range(0.45, 1) * up, cz * r,
      k.range(1.1, 2.1), k.range(0.45, 0.9) * sz * Math.sqrt(spread), k.range(1.4, 2.8) * sz * Math.sqrt(spread), k.range(0.7, 0.95), SPRAY,
      -15, 0.3, 0,
    );
  }
  for (let i = 0; i < mist; i++) {
    k.puff.spawn(
      x + k.range(-1, 1) * spread, 0.6, z + k.range(-1, 1) * spread * 0.5,
      k.range(-1, 1), k.range(1, 2.5), k.range(-0.5, 1),
      k.range(2.4, 4), k.range(2, 3.5) * sz * spread * 0.4, k.range(6, 9) * sz * spread * 0.4, k.range(0.3, 0.45), MIST,
      0.3, 1,
    );
  }
}

// ---- Fjord: avalanche ---------------------------------------------------

const PATH_POINTS = 16;

class Avalanche extends Effect {
  private sheet!: THREE.Mesh;
  private rows = 0;
  private pos!: Float32Array;
  private wobble!: Float32Array;
  private path = new Float32Array(PATH_POINTS * 3);
  private arc = new Float32Array(PATH_POINTS);
  private head = new THREE.Vector3();
  private prevHead = new THREE.Vector3();
  private slide = 6;
  private powder = 0;
  private rate = 0;
  private due = 0;
  private arrived = -1;
  private shades = [new THREE.Color('#ffffff'), new THREE.Color('#eef6fb'), new THREE.Color('#dce8f0')];

  build() {
    const rows = (this.rows = this.k.n(8, 14, 22));
    const verts = rows * 3;
    const rng = new Rng(0xa7a1);
    this.pos = new Float32Array(verts * 3);
    const normals = new Float32Array(verts * 3);
    const colors = new Float32Array(verts * 3);
    this.wobble = new Float32Array(verts * 2);
    for (let i = 0; i < verts; i++) {
      normals[i * 3 + 2] = 1;
      rng.pick(this.shades).toArray(colors, i * 3);
      this.wobble[i * 2] = rng.range(-0.7, 0.7);
      this.wobble[i * 2 + 1] = rng.range(-0.5, 0.5);
    }
    const index: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < 2; c++) {
        const a = r * 3 + c;
        index.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(index);
    this.sheet = this.k.add(new THREE.Mesh(geo, flatMat('#ffffff', { vertexColors: true, side: THREE.DoubleSide })));
    this.sheet.frustumCulled = false;
    void this.k.puff;
    this.duration = 14.5;
  }

  start() {
    this.findPath();
    this.powder = this.k.n(30, 120, 300);
    this.rate = (this.powder * 0.75) / this.slide;
    this.due = 0;
    this.arrived = -1;
    this.pointAt(0, this.prevHead);
  }

  /** Trace the front face of the tallest peak near the camera, top to shore. */
  private findPath() {
    const k = this.k;
    k.probe.collect(k.scene, k.root);
    const shift = k.range(-8, 8);
    let bestX = NaN;
    let bestZ = NaN;
    let bestScore = -Infinity;
    let summit = 0;
    // Candidate peaks across the view (narrower on a narrow screen).
    const spread = Math.min(1, k.aspect / 1.6);
    for (const offset of [0, -26, 26, -48, 48]) {
      const off = offset * spread;
      const x = k.cam.x + off + shift;
      const z = k.probe.hitZ(x, 16, -40, -230);
      if (!(z < -70)) continue;
      let top = 16;
      for (let d = 4; d <= 28; d += 8) {
        const y = k.probe.hitY(x, z - d, 160, 0);
        if (y > top) top = y;
      }
      const score = top - Math.abs(off) * 0.35 + k.range(0, 6);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestZ = z;
        summit = top;
      }
    }
    if (Number.isNaN(bestX)) {
      // No peak found (scenery changed?): a plausible slope in the far range.
      bestX = k.cam.x + shift;
      bestZ = -100;
      summit = 44;
    } else {
      // Slide down the middle of the face, under the summit, not along its outline.
      let ridge = -Infinity;
      const x0 = bestX;
      for (let dx = -20; dx <= 20; dx += 4) {
        const y = k.probe.hitY(x0 + dx, bestZ - 10, 160, 0);
        if (y > ridge) {
          ridge = y;
          bestX = x0 + dx;
        }
      }
      const z = k.probe.hitZ(bestX, 16, -40, -230);
      if (z < -70) bestZ = z;
      summit = Math.max(summit, ridge);
    }
    // Start low enough that the billowing powder stays in frame.
    const yStart = Math.max(14, Math.min(summit - 2.5, viewTop(k.cam.y, bestZ) - 14));
    let prevZ = NaN;
    let prevY = yStart;
    for (let j = 0; j < PATH_POINTS; j++) {
      const y = yStart + (0.8 - yStart) * (j / (PATH_POINTS - 1));
      let z = k.probe.hitZ(bestX, y, -40, -240);
      if (j === 0) {
        if (Number.isNaN(z)) z = bestZ - (yStart - 16) * 0.6;
      } else {
        // Slopes only come toward the camera going down; a jump means a nearer ridge.
        const dy = prevY - y;
        if (Number.isNaN(z) || z < prevZ - 0.2 || z > prevZ + dy * 1.4) z = prevZ + dy * 0.6;
      }
      const i = j * 3;
      this.path[i] = bestX + Math.sin(j * 0.9) * 1.1;
      this.path[i + 1] = y;
      this.path[i + 2] = z + 1.1;
      this.arc[j] = j === 0 ? 0 : this.arc[j - 1] + Math.hypot(this.path[i] - this.path[i - 3], y - prevY, z + 1.1 - this.path[i - 1]);
      prevZ = z;
      prevY = y;
    }
  }

  private pointAt(s: number, out: THREE.Vector3) {
    const total = this.arc[PATH_POINTS - 1];
    const d = clamp01(s) * total;
    let j = 0;
    while (j < PATH_POINTS - 2 && this.arc[j + 1] < d) j++;
    const span = this.arc[j + 1] - this.arc[j];
    const f = span > 0 ? clamp01((d - this.arc[j]) / span) : 0;
    const i = j * 3;
    return out.set(
      this.path[i] + (this.path[i + 3] - this.path[i]) * f,
      this.path[i + 1] + (this.path[i + 4] - this.path[i + 1]) * f,
      this.path[i + 2] + (this.path[i + 5] - this.path[i + 2]) * f,
    );
  }

  private widthAt(s: number) {
    return 7 + 15 * s;
  }

  step(dt: number) {
    const t = this.t;
    const u = clamp01((t - 0.4) / this.slide);
    const sHead = Math.pow(u, 1.5);
    const sTail = Math.pow(clamp01((t - 2.6) / this.slide), 1.5);
    this.sheet.visible = sHead - sTail > 0.004;
    if (this.sheet.visible) this.writeSheet(sTail, sHead);

    this.pointAt(sHead, this.head);
    const inv = dt > 0 ? 1 / dt : 0;
    const hvx = (this.head.x - this.prevHead.x) * inv;
    const hvy = (this.head.y - this.prevHead.y) * inv;
    const hvz = (this.head.z - this.prevHead.z) * inv;
    this.prevHead.copy(this.head);
    if (u > 0 && u < 1) {
      this.due += this.rate * dt;
      while (this.due >= 1 && this.powder > 0) {
        this.puff(hvx, hvy, hvz, 1, this.widthAt(sHead));
        this.due--;
        this.powder--;
      }
    } else if (u >= 1 && this.arrived < 0) {
      // The slide hits the bottom: everything left billows up at once.
      this.arrived = t;
      while (this.powder > 0) {
        this.puff(0, 0, 0, 1.5, this.widthAt(1) * 1.3);
        this.powder--;
      }
    }
    const rumble = u > 0 && u < 1 ? 0.014 * smoothstep(0, 0.3, u) : 0;
    const after = this.arrived >= 0 ? 0.07 * smoothstep(0, 0.25, t - this.arrived) * Math.exp(-(t - this.arrived) * 1.1) : 0;
    this.shake = Math.max(rumble, after);
  }

  private puff(vx: number, vy: number, vz: number, big: number, width: number) {
    const k = this.k;
    const sz = k.puffScale * big;
    k.puff.spawn(
      this.head.x + k.range(-0.5, 0.5) * width, this.head.y + k.range(-1, 2), this.head.z + k.range(0.5, 2.5),
      vx * 0.35 + k.range(-3, 3), vy * 0.3 + k.range(1.5, 4) * big, vz * 0.3 + k.range(1, 4),
      k.range(3.5, 6), k.range(3.5, 6) * sz, k.range(13, 20) * sz * big, k.range(0.75, 0.95), this.shades[k.rng() < 0.5 ? 0 : 1],
      0.45, 0.85,
    );
  }

  private writeSheet(s0: number, s1: number) {
    const rows = this.rows;
    for (let r = 0; r < rows; r++) {
      const f = r / (rows - 1);
      const s = s0 + (s1 - s0) * f;
      this.pointAt(s, _v);
      // Rounded at both ends, widening as it fans out downhill.
      const w = this.widthAt(s) * 0.5 * Math.sqrt(Math.sin(Math.PI * (0.08 + 0.84 * f)));
      for (let c = 0; c < 3; c++) {
        const v = r * 3 + c;
        const off = (c - 1) * w;
        this.pos[v * 3] = _v.x + off + this.wobble[v * 2];
        this.pos[v * 3 + 1] = _v.y + (c === 1 ? 0.35 : 0);
        // The slope curves away to the sides.
        this.pos[v * 3 + 2] = _v.z - 0.02 * off * off + this.wobble[v * 2 + 1];
      }
    }
    this.sheet.geometry.attributes.position.needsUpdate = true;
  }

  stop() {
    this.sheet.visible = false;
    this.shake = 0;
  }
}

// ---- Fjord: iceberg calving ---------------------------------------------

class Calving extends Effect {
  private berg!: THREE.Mesh;
  private bergMat!: THREE.MeshStandardMaterial;
  private chunk!: THREE.Mesh;
  private side = 1;
  private vel = new THREE.Vector3();
  private splashAt = new THREE.Vector3();
  private endAt = new THREE.Vector3();
  private anchor = new THREE.Vector3();
  private tilt = 0;
  private tiltVel = 0;
  private bob = 0;
  private bobVel = 0;
  private falling = false;
  private splashed = -1;
  private sloshed = false;
  private cracked = false;

  build() {
    const rng = new Rng(0x1ceb);
    const snow = ['#f5fcff', '#e6f4f9', '#d6eef6'];
    const ice = ['#8fd4e2', '#71c3d6', '#9fdcea'];
    const iceColor = (y: number, up: number) =>
      y > 0.4 ? (up < 0.5 && rng.next() < 0.3 ? '#bfe5f0' : rng.pick(snow)) : rng.pick(ice);

    const slab = jitter(new THREE.BoxGeometry(24, 16, 11, 6, 4, 3), rng, 0.8);
    slab.translate(0, 1, 0);
    const parts = [slab];
    for (let i = 0; i < 3; i++) {
      const r = rng.range(2.5, 4);
      parts.push(place(jitter(new THREE.IcosahedronGeometry(r, 0), rng, r * 0.2), rng.range(-8, 8), 9, rng.range(-3, 2), 0, rng.range(0, 6), 0, 1, 0.55, 1));
    }
    const bergGeo = paint(merge(parts.map(prep)), (_x, y, _z, up) => iceColor(y, up));
    this.bergMat = flatMat('#ffffff', { vertexColors: true, roughness: 0.55, transparent: true, opacity: 0 });
    this.berg = this.k.add(new THREE.Mesh(bergGeo, this.bergMat));

    const chunk = jitter(new THREE.DodecahedronGeometry(1, 0), rng, 0.12);
    chunk.scale(3.1, 3.7, 2.5);
    // Blue only on the bottom third, the part that ends up under water.
    this.chunk = this.k.add(new THREE.Mesh(paint(chunk, (_x, y, _z, up) => iceColor(y + 1.6, up)), flatMat('#ffffff', { vertexColors: true, roughness: 0.55 })));
    void this.k.puff;
    void this.k.rings;
    this.duration = 26;
  }

  /** Something solid at the waterline here (an islet, cabins)? */
  private blocked(x: number) {
    const p = this.k.probe;
    return !Number.isNaN(p.hitZ(x, 2.5, -20, -62)) || !Number.isNaN(p.hitZ(x - 11, 2.5, -20, -62)) || !Number.isNaN(p.hitZ(x + 11, 2.5, -20, -62));
  }

  start() {
    const k = this.k;
    k.probe.collect(k.scene, k.root);
    const cx = k.cam.x;
    const off = Math.min(30, k.halfWidth(-46) * 0.62);
    this.side = k.sign();
    if (this.blocked(cx + this.side * off)) this.side = -this.side;
    this.berg.position.set(cx + this.side * off, 0, -46);
    this.berg.rotation.set(0, k.range(-0.2, 0.2), 0);
    this.berg.updateMatrixWorld();
    // The chunk leans off the inner front corner, toward the middle of the frame.
    this.anchor.set(-this.side * 7, 4.8, 6.2).applyMatrix4(this.berg.matrixWorld);
    this.chunk.position.copy(this.anchor);
    this.chunk.rotation.set(0, k.range(0, 6), 0);
    this.endAt.set(cx - this.side * 36, 0, -7);
    this.vel.set(0, 0, 0);
    this.tilt = this.tiltVel = 0;
    this.falling = this.sloshed = this.cracked = false;
    this.splashed = -1;
    this.bergMat.opacity = 0;
    this.berg.visible = this.chunk.visible = true;
  }

  step(dt: number) {
    const k = this.k;
    const t = this.t;
    this.bergMat.opacity = smoothstep(0, 2.4, t) * (1 - smoothstep(this.duration - 4, this.duration - 0.6, t));
    this.berg.position.y = Math.sin(t * 0.7) * 0.12;
    const crackAt = 2.8;
    const fallAt = 3.6;
    const c = this.chunk;

    if (t < fallAt) {
      const tremble = t > crackAt ? 0.03 : 0;
      c.position.set(this.anchor.x, this.anchor.y + this.berg.position.y, this.anchor.z);
      c.rotation.x = Math.sin(t * 61) * tremble;
      c.rotation.z = Math.cos(t * 53) * tremble;
      if (t > crackAt && !this.cracked) {
        this.cracked = true;
        for (let i = 0; i < k.n(4, 10, 18); i++) {
          k.puff.spawn(c.position.x + k.range(-2, 2), c.position.y + k.range(-1, 3), c.position.z + 1.5, k.range(-1, 1), k.range(-0.5, 1), k.range(0.5, 1.5), k.range(1.2, 2), 0.6 * k.puffScale, 2.2 * k.puffScale, 0.6, WHITE, -1, 1);
        }
      }
    } else if (this.splashed < 0) {
      if (!this.falling) {
        this.falling = true;
        this.vel.set(-this.side * 1.3, 0.6, 2.4);
        this.tiltVel = 0.5;
      }
      this.vel.y -= 15 * dt;
      c.position.addScaledVector(this.vel, dt);
      this.tiltVel += 3.2 * dt;
      this.tilt += this.tiltVel * dt;
      c.rotation.x = this.tilt;
      if (c.position.y < 0.6 && this.vel.y < 0) {
        this.splashed = t;
        this.splashAt.copy(c.position);
        this.bob = c.position.y;
        this.bobVel = this.vel.y * 0.45;
        splash(k, c.position.x, c.position.z, k.n(36, 120, 260), 13, 4.5, k.n(4, 14, 30));
        k.rings.spawn(c.position.x, k.ringY, c.position.z, 13, 3.6);
        k.rings.spawn(c.position.x, k.ringY, c.position.z, 7.5, 2.4);
      }
    } else {
      // Afloat: bob to the waterline, settle the roll, then drift across toward the camera.
      this.bobVel += (-(this.bob + 0.7) * 7 - this.bobVel * 1.8) * dt;
      this.bob += this.bobVel * dt;
      this.tiltVel += (-(this.tilt - 0.45) * 4 - this.tiltVel * 1.5) * dt;
      this.tilt += this.tiltVel * dt;
      const u = clamp01((t - this.splashed) / (this.duration - this.splashed));
      c.position.x = this.splashAt.x + (this.endAt.x - this.splashAt.x) * u;
      c.position.z = this.splashAt.z + (this.endAt.z - this.splashAt.z) * u;
      c.position.y = this.bob + Math.sin(t * 1.1) * 0.12 * k.map.waves;
      c.rotation.x = this.tilt + Math.sin(t * 0.9) * 0.04;
      c.rotation.z = Math.sin(t * 0.7) * 0.05;
      c.rotation.y += dt * 0.05;
      if (!this.sloshed && t - this.splashed > 0.55) {
        this.sloshed = true;
        splash(k, c.position.x, c.position.z, k.n(10, 36, 80), 6, 3, 0);
        k.rings.spawn(c.position.x, k.ringY, c.position.z, 6, 2);
      }
    }
    this.shake = this.splashed >= 0 ? 0.05 * smoothstep(0, 0.1, t - this.splashed) * Math.exp(-(t - this.splashed) * 1.6) : 0;
  }

  stop() {
    this.berg.visible = this.chunk.visible = false;
    this.shake = 0;
  }
}

// ---- Fjord: aurora surge (night) ----------------------------------------

/** The same ray curtains as the scenery's aurora, flaring taller, brighter and quicker for a few seconds. */
class AuroraSurge extends Effect {
  private curtains: AuroraCurtain[] = [];

  build() {
    const columns = this.k.n(28, 48, 72);
    const looks = [{}, { low: '#59f0c8', mid: '#3fd6b0' }, { low: '#d6a8ff', mid: '#c77dff', high: '#ff7de0' }];
    for (let i = 0; i < this.k.n(1, 2, 3); i++) {
      const curtain = new AuroraCurtain({ width: 260, height: 44, columns, ...looks[i] });
      this.k.add(curtain.mesh);
      this.curtains.push(curtain);
    }
    this.duration = 18;
  }

  start() {
    const k = this.k;
    for (let i = 0; i < this.curtains.length; i++) {
      const c = this.curtains[i];
      // Behind the far range, so the rays rise out of the mountains.
      c.mesh.position.set(k.cam.x + k.range(-25, 25), 22 + i * 7, -176 - i * 10);
      c.mesh.rotation.y = k.range(-0.12, 0.12);
      c.phase = k.range(0, 6);
    }
  }

  step() {
    const t = this.t;
    // Cloud dims it like the scenery's own aurora.
    const env = smoothstep(0, 3, t) * (1 - smoothstep(this.duration - 5, this.duration, t)) * (1 - this.k.cloud);
    auroraGlow.surge = env;
    for (let i = 0; i < this.curtains.length; i++) this.curtains[i].update(t, env * (1 - 0.15 * i), 1);
  }

  stop() {
    auroraGlow.surge = 0;
    for (let i = 0; i < this.curtains.length; i++) this.curtains[i].mesh.visible = false;
  }
}

// ---- Heaven Lake: rockfall ----------------------------------------------

const FACE_SAMPLES = 6;

class Rockfall extends Effect {
  private rocks!: THREE.InstancedMesh;
  private count = 0;
  private st!: Float32Array; // per rock: state, delay, x, y, z, vx, vy, vz, rx, ry, rz, spin, size
  private face = new Float32Array(FACE_SAMPLES);
  private top = 30;
  private firstSplash = -1;
  private dust = new THREE.Color('#b9af95');

  build() {
    const n = (this.count = this.k.n(4, 7, 12));
    const geo = prep(jitter(new THREE.IcosahedronGeometry(1, 0), new Rng(0x70c), 0.22));
    this.rocks = this.k.add(dynamicInstances(geo, flatMat('#ffffff'), n));
    const palette = ['#8a8672', '#77735f', '#9a957f', '#6c6855'];
    for (let i = 0; i < n; i++) this.rocks.setColorAt(i, _c.set(palette[i % palette.length]));
    this.st = new Float32Array(n * 13);
    void this.k.puff;
    void this.k.rings;
    this.duration = 11;
  }

  start() {
    const k = this.k;
    k.probe.collect(k.scene, k.root);
    // The nearest pillar face in view, with some variety.
    let px = NaN;
    let pz = NaN;
    let best = Infinity;
    for (let i = 0; i < 15; i++) {
      const x = k.cam.x + (i - 7) * 7 + k.range(-2, 2);
      const z = k.probe.hitZ(x, 16, -30, -140);
      if (!(z < -36) || Math.abs(x - k.cam.x) > k.halfWidth(z) * 0.8) continue;
      const score = -z + Math.abs(x - k.cam.x) * 0.5 + k.range(0, 25);
      if (score < best) {
        best = score;
        px = x;
        pz = z;
      }
    }
    if (Number.isNaN(px)) {
      px = k.cam.x + k.range(-30, 30);
      pz = -70;
      this.top = 30;
    } else {
      const crown = k.probe.hitY(px, pz - 3.5, 160, 0);
      this.top = Number.isNaN(crown) ? 30 : crown;
    }
    const startY = Math.max(10, Math.min(this.top - 3, viewTop(k.cam.y, pz) - 3));
    this.top = startY;
    let prev = pz;
    for (let j = 0; j < FACE_SAMPLES; j++) {
      const y = startY * (1 - j / (FACE_SAMPLES - 1));
      const z = k.probe.hitZ(px, y, -30, -150);
      this.face[j] = Number.isNaN(z) || z < prev - 0.5 || z > prev + 10 ? prev + 0.8 : z;
      prev = this.face[j];
    }
    let delay = 0;
    for (let i = 0; i < this.count; i++) {
      const s = this.st;
      const o = i * 13;
      const size = i === 0 ? k.range(1.6, 2.2) : k.range(0.6, 1.6);
      s[o] = 0;
      s[o + 1] = delay;
      delay += k.range(0.1, 0.35);
      s[o + 2] = px + k.range(-2, 2);
      s[o + 3] = startY - k.range(0, 3);
      s[o + 4] = this.faceZ(s[o + 3]) + size;
      s[o + 5] = k.range(-0.8, 0.8);
      s[o + 6] = k.range(0, 1.5);
      s[o + 7] = k.range(0.8, 2.5);
      s[o + 8] = k.range(0, 6);
      s[o + 9] = k.range(0, 6);
      s[o + 10] = k.range(0, 6);
      s[o + 11] = k.range(2, 5);
      s[o + 12] = size;
    }
    this.firstSplash = -1;
    hideInstances(this.rocks);
    this.rocks.visible = true;
  }

  private faceZ(y: number) {
    const f = clamp01(1 - y / this.top) * (FACE_SAMPLES - 1);
    const j = Math.min(FACE_SAMPLES - 2, Math.floor(f));
    return this.face[j] + (this.face[j + 1] - this.face[j]) * (f - j);
  }

  private dustPuff(x: number, y: number, z: number, n: number) {
    const k = this.k;
    for (let i = 0; i < n; i++) {
      k.puff.spawn(x + k.range(-0.6, 0.6), y + k.range(-0.6, 0.6), z + 0.5, k.range(-1.5, 1.5), k.range(-0.5, 1.2), k.range(0.3, 1.8), k.range(1.6, 2.8), 1.2 * k.puffScale, k.range(3.5, 5.5) * k.puffScale, 0.5, this.dust, 0.35, 1.4);
    }
  }

  step(dt: number) {
    const k = this.k;
    const s = this.st;
    for (let i = 0; i < this.count; i++) {
      const o = i * 13;
      if (s[o] === 0) {
        s[o + 1] -= dt;
        if (s[o + 1] > 0) continue;
        s[o] = 1;
        this.dustPuff(s[o + 2], s[o + 3], s[o + 4], k.n(1, 3, 5));
      }
      if (s[o] === 3) continue;
      const size = s[o + 12];
      if (s[o] === 1) {
        s[o + 6] -= 17 * dt;
        s[o + 2] += s[o + 5] * dt;
        s[o + 3] += s[o + 6] * dt;
        s[o + 4] += s[o + 7] * dt;
        const fz = this.faceZ(s[o + 3]) + size * 0.8;
        if (s[o + 4] < fz) {
          // Bounce off the pillar.
          s[o + 4] = fz;
          s[o + 7] = Math.abs(s[o + 7]) * 0.35 + k.range(0.8, 2);
          s[o + 6] *= 0.6;
          s[o + 5] += k.range(-1, 1);
          s[o + 11] += 2;
          this.dustPuff(s[o + 2], s[o + 3], s[o + 4], k.n(1, 3, 4));
        } else if (k.detail > 1 && k.rng() < dt * 5) {
          this.dustPuff(s[o + 2], s[o + 3], s[o + 4], 1);
        }
        if (s[o + 3] < 0.3 && s[o + 6] < 0) {
          s[o] = 2;
          s[o + 6] = -2.5;
          s[o + 5] *= 0.2;
          s[o + 7] *= 0.2;
          if (this.firstSplash < 0) this.firstSplash = this.t;
          splash(k, s[o + 2], s[o + 4], Math.round(k.n(6, 18, 34) * size), 3 + size * 3, 1 + size, k.n(0, 2, 3));
          k.rings.spawn(s[o + 2], k.ringY, s[o + 4], 2.5 + size * 2.2, 2.2);
        }
      } else {
        s[o + 3] += s[o + 6] * dt;
        if (s[o + 3] < -3.5) s[o] = 3;
      }
      s[o + 8] += s[o + 11] * dt;
      s[o + 9] += s[o + 11] * 0.6 * dt;
      _q.setFromEuler(_e.set(s[o + 8], s[o + 9], s[o + 10]));
      const scale = s[o] === 3 ? 0 : size;
      _m.compose(_v.set(s[o + 2], s[o + 3], s[o + 4]), _q, _s.set(scale, scale * 0.8, scale));
      this.rocks.setMatrixAt(i, _m);
    }
    this.rocks.instanceMatrix.needsUpdate = true;
    const since = this.t - this.firstSplash;
    this.shake = this.firstSplash >= 0 ? 0.04 * smoothstep(0, 0.08, since) * Math.exp(-since * 2) : 0;
  }

  stop() {
    this.rocks.visible = false;
    this.shake = 0;
  }
}

// ---- Heaven Lake: crane flock -------------------------------------------

class Cranes extends Effect {
  private bodies!: THREE.InstancedMesh;
  private wings!: THREE.InstancedMesh;
  private count = 0;
  private offs!: Float32Array;
  private phase!: Float32Array;
  private dir = 1;
  private x0 = 0;
  private y0 = 28;
  private z0 = -72;
  private speed = 8;

  build() {
    const n = (this.count = this.k.n(5, 9, 15));
    const rng = new Rng(0xc4a);
    const white = '#f4f4ef';
    const black = '#1d1d1f';
    const body = merge([
      solid(place(jitter(new THREE.IcosahedronGeometry(0.5, 0), rng, 0.05), 0, 0, 0, 0, 0, 0, 1.6, 0.7, 0.7), white),
      solid(place(new THREE.CylinderGeometry(0.06, 0.1, 1.3, 5), 1.25, 0.18, 0, 0, 0, -Math.PI / 2 + 0.15), black),
      solid(place(new THREE.IcosahedronGeometry(0.15, 0), 1.95, 0.3, 0), white),
      solid(place(new THREE.BoxGeometry(0.16, 0.06, 0.12), 1.95, 0.42, 0), '#d22b2b'),
      solid(place(new THREE.ConeGeometry(0.045, 0.45, 4), 2.25, 0.27, 0, 0, 0, -Math.PI / 2), '#8f8a6a'),
      solid(place(new THREE.ConeGeometry(0.22, 0.55, 5), -0.95, 0.02, 0, 0, 0, Math.PI / 2), black),
      solid(place(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 4), -1.55, -0.12, 0.06, 0, 0, Math.PI / 2), '#2a2a2a'),
      solid(place(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 4), -1.55, -0.12, -0.06, 0, 0, Math.PI / 2), '#2a2a2a'),
    ]);
    body.scale(1.5, 1.5, 1.5);
    // One wing reaching +z; the left one is the same instance mirrored.
    const r0 = [0.45, 0, 0];
    const r1 = [-0.4, 0, 0];
    const m0 = [0.35, 0, 1.5];
    const m1 = [-0.6, 0, 1.4];
    const t0 = [-0.1, 0, 2.6];
    const t1 = [-0.85, 0, 2.3];
    const wing = flatTris([
      [r0, r1, m0, white],
      [r1, m1, m0, white],
      [m0, m1, t0, black],
      [m1, t1, t0, black],
    ]);
    wing.scale(1.5, 1.5, 1.5);
    this.bodies = this.k.add(dynamicInstances(body, flatMat('#ffffff', { vertexColors: true }), n));
    this.wings = this.k.add(dynamicInstances(wing, flatMat('#ffffff', { vertexColors: true, side: THREE.DoubleSide }), n * 2));
    this.offs = new Float32Array(n * 3);
    this.phase = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const rank = Math.ceil(i / 2);
      this.offs[i * 3] = -rank * 2.8 + rng.range(-0.4, 0.4);
      this.offs[i * 3 + 1] = rank * 0.3 + rng.range(-0.3, 0.3);
      this.offs[i * 3 + 2] = (i % 2 ? 1 : -1) * rank * 2.3;
    }
    this.duration = 22;
  }

  start() {
    const k = this.k;
    this.dir = k.sign();
    this.z0 = -72;
    const half = k.halfWidth(this.z0) + 14;
    this.x0 = k.cam.x - this.dir * half;
    this.speed = (2 * half + 2.8 * Math.ceil(this.count / 2)) / (this.duration - 0.5);
    this.y0 = Math.min(28, viewTop(k.cam.y, this.z0) - 6);
    for (let i = 0; i < this.count; i++) this.phase[i] = k.range(0, Math.PI * 2);
    this.bodies.visible = this.wings.visible = true;
  }

  step() {
    const t = this.t;
    const dir = this.dir;
    const lead = this.x0 + dir * this.speed * t;
    _q.setFromAxisAngle(Y_AXIS, dir > 0 ? 0 : Math.PI);
    for (let i = 0; i < this.count; i++) {
      const ph = this.phase[i];
      const flapT = t * 1.7 * Math.PI * 2 + ph;
      const flap = -0.2 + 0.7 * Math.sin(flapT);
      _v.set(
        lead + dir * this.offs[i * 3] + Math.sin(t * 0.7 + ph) * 0.3,
        this.y0 + this.offs[i * 3 + 1] + Math.sin(t * 1.1 + ph * 2) * 0.35 - Math.sin(flapT) * 0.08,
        this.z0 + this.offs[i * 3 + 2],
      );
      _m.compose(_v, _q, _s.set(1, 1, 1));
      this.bodies.setMatrixAt(i, _m);
      _m2.makeRotationX(flap).setPosition(0.2, 0.3, 0.25);
      this.wings.setMatrixAt(i * 2, _m3.multiplyMatrices(_m, _m2));
      _m2.makeRotationX(-flap).scale(_s.set(1, 1, -1)).setPosition(0.2, 0.3, -0.25);
      this.wings.setMatrixAt(i * 2 + 1, _m3.multiplyMatrices(_m, _m2));
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.wings.instanceMatrix.needsUpdate = true;
  }

  stop() {
    this.bodies.visible = this.wings.visible = false;
  }
}

// ---- Heaven Lake: mist surge --------------------------------------------

class MistSurge extends Effect {
  private blobs!: THREE.InstancedMesh;
  private mat!: THREE.MeshBasicMaterial;
  private veil: THREE.Mesh | null = null;
  private veilMat: THREE.MeshBasicMaterial | null = null;
  private count = 0;
  private st!: Float32Array; // x, y, z, r, speed, phase
  private dir = 1;
  private base = new THREE.Color('#eef3f0');

  build() {
    const n = (this.count = this.k.n(6, 10, 16));
    // Soft-edged banks: flat sprites facing the camera (it looks down -z), so no hard silhouettes.
    this.mat = new THREE.MeshBasicMaterial({ color: this.base, map: this.k.softTex, transparent: true, opacity: 0, depthWrite: false });
    this.blobs = this.k.add(dynamicInstances(new THREE.PlaneGeometry(1, 1), this.mat, n));
    this.blobs.renderOrder = 1;
    this.st = new Float32Array(n * 6);
    if (this.k.detail > 1) {
      // A veil just in front of the camera: the mist reaching the boat. Rows top to bottom:
      // thin high up, thickest just over the water, gone at the water (no hard edge).
      // Placed at y = 1 and 13 tall, the rows sit at y = 7.5, 1.4 and 0.
      const geo = new THREE.PlaneGeometry(1, 1, 1, 2);
      const pos = geo.attributes.position;
      const rowY = [0.5, 0.03, -1 / 13];
      const rowA = [0.08, 1, 0];
      const colors: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        const row = Math.floor(i / 2);
        pos.setY(i, rowY[row]);
        colors.push(1, 1, 1, rowA[row]);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
      this.veilMat = new THREE.MeshBasicMaterial({ color: this.base, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
      this.veil = this.k.add(new THREE.Mesh(geo, this.veilMat));
      this.veil.renderOrder = 3;
    }
    this.duration = 22;
  }

  start() {
    const k = this.k;
    this.dir = k.sign();
    for (let i = 0; i < this.count; i++) {
      const o = i * 6;
      const z = k.range(-85, 4);
      const r = k.range(14, 28) * (z > -30 ? 0.6 : 1);
      const half = k.halfWidth(z) + r;
      const lag = k.range(0, 45);
      this.st[o] = k.cam.x - this.dir * (half + lag);
      this.st[o + 1] = k.range(1, 5);
      this.st[o + 2] = z;
      this.st[o + 3] = r;
      this.st[o + 4] = (2 * half + lag) / (this.duration - 3);
      this.st[o + 5] = k.range(0, 6);
    }
    this.blobs.visible = true;
  }

  step(dt: number) {
    const k = this.k;
    const t = this.t;
    const env = smoothstep(0, 3, t) * (1 - smoothstep(this.duration - 5, this.duration, t));
    this.mat.opacity = 0.42 * env;
    this.mat.color.copy(this.base).multiplyScalar(Math.max(0.3, k.light));
    for (let i = 0; i < this.count; i++) {
      const o = i * 6;
      this.st[o] += this.dir * this.st[o + 4] * dt;
      const r = this.st[o + 3];
      const h = r * 0.55 * (1 + 0.25 * Math.sin(t * 0.6 + this.st[o + 5]));
      // Raised so the faint lower edge, not the body, meets the water.
      _m.compose(_v.set(this.st[o], this.st[o + 1] + h * 0.2, this.st[o + 2]), _q.identity(), _s.set(r * 2.4, h, 1));
      this.blobs.setMatrixAt(i, _m);
    }
    this.blobs.instanceMatrix.needsUpdate = true;
    if (this.veil && this.veilMat) {
      const o = 0.3 * smoothstep(5, 9, t) * (1 - smoothstep(14, 19, t));
      this.veil.visible = o > 0.002 && k.cam.y > 0;
      this.veilMat.opacity = o;
      this.veilMat.color.copy(this.base).multiplyScalar(Math.max(0.3, k.light));
      const z = CAM_Z - 13;
      this.veil.position.set(k.cam.x, 1, z);
      this.veil.scale.set(k.halfWidth(z) * 2.6, 13, 1);
    }
  }

  stop() {
    this.blobs.visible = false;
    if (this.veil) this.veil.visible = false;
  }
}

// ---- Ocean: whale breach ------------------------------------------------

function whaleGeometry() {
  const back = '#2d3e50';
  const side = '#465d72';
  const belly = '#dde3e6';
  const body = paint(
    lathe([[0.05, -7.6], [0.45, -6.6], [0.9, -5.2], [1.5, -3], [1.95, -0.5], [2.05, 1.8], [1.85, 4], [1.45, 5.6], [0.85, 6.8], [0.15, 7.4]], 9),
    (_x, y) => (y < -0.7 ? belly : y < 0.4 ? side : back),
  );
  body.scale(1, 0.92, 1.05);
  const fin = (s: number) => solid(place(new THREE.BoxGeometry(4.4, 0.16, 1.0), 2.4, -1.0, s * 2.3, s * 0.5, s * 0.9, -0.2), '#d9e0e3');
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(-1.4, 3.0);
  shape.lineTo(-2.3, 2.7);
  shape.lineTo(-1.3, 0);
  shape.lineTo(-2.3, -2.7);
  shape.lineTo(-1.4, -3.0);
  shape.closePath();
  const fluke = solid(place(new THREE.ShapeGeometry(shape), -7.2, 0, 0, Math.PI / 2), back);
  const hump = solid(place(new THREE.ConeGeometry(0.5, 0.9, 4), -3.2, 1.9, 0), back);
  return merge([body, fin(1), fin(-1), fluke, hump]);
}

class Whale extends Effect {
  private whale!: THREE.Mesh;
  private dir = 1;
  private x0 = 0;
  private z0 = -64;
  private vel = new THREE.Vector3();
  private launched = false;
  private emerged = false;
  private splashed = -1;
  private spouts = 0;

  build() {
    this.whale = this.k.add(new THREE.Mesh(whaleGeometry(), flatMat('#ffffff', { vertexColors: true, side: THREE.DoubleSide })));
    void this.k.puff;
    void this.k.rings;
    this.duration = 13.5;
  }

  start() {
    const k = this.k;
    this.dir = k.sign();
    this.z0 = -64;
    // The action spans x0 - 12 .. x0 + 18 along dir, centred near x0 + 3·dir.
    // Keep that centre in frame and out from behind the boat.
    const half = k.halfWidth(this.z0);
    const centre = k.clearOfBoat(k.cam.x + k.range(-0.5, 0.5) * half, this.z0, 24, half * 0.6);
    this.x0 = centre - this.dir * 3;
    this.launched = this.emerged = false;
    this.splashed = -1;
    this.spouts = 0;
  }

  private spout(x: number, strength: number) {
    const k = this.k;
    const sz = k.puffScale;
    for (let i = 0; i < Math.round(k.n(12, 30, 60) * strength); i++) {
      k.puff.spawn(x + k.range(-0.4, 0.4), 0.8, this.z0 + k.range(-0.4, 0.4), k.range(-1, 1), k.range(9, 13) * strength, k.range(-1, 1), k.range(1.6, 2.6), 0.6 * sz, k.range(3, 5) * sz, k.range(0.5, 0.75), MIST, -4, 0.9);
    }
  }

  step(dt: number) {
    const k = this.k;
    const t = this.t;
    const w = this.whale;
    if (this.spouts === 0 && t >= 0.3) {
      this.spouts = 1;
      this.spout(this.x0 - this.dir * 12, 1);
    }
    const launchAt = 2.8;
    if (t >= launchAt) {
      if (!this.launched) {
        this.launched = true;
        w.visible = true;
        w.position.set(this.x0 - this.dir * 3, -10, this.z0);
        this.vel.set(this.dir * 4.5, 18, 0);
      }
      const tau = t - launchAt;
      if (this.splashed < 0) this.vel.y -= 12 * dt;
      else {
        // Under again: water slows it as it sinks away.
        this.vel.multiplyScalar(Math.exp(-1.2 * dt));
        this.vel.y = Math.max(this.vel.y - 5 * dt, -7);
      }
      w.position.addScaledVector(this.vel, dt);
      const air = 3;
      const pitch = 1.25 - 2.3 * Math.pow(clamp01(tau / air), 1.4);
      const roll = 2.6 * smoothstep(0, air, tau);
      _q.setFromAxisAngle(Y_AXIS, this.dir > 0 ? 0 : Math.PI);
      _q2.setFromAxisAngle(Z_AXIS, pitch);
      _q.multiply(_q2);
      _q2.setFromAxisAngle(X_AXIS, roll);
      w.quaternion.copy(_q.multiply(_q2));
      const noseY = w.position.y + 7.4 * Math.sin(pitch);
      if (!this.emerged && noseY > 0) {
        this.emerged = true;
        splash(k, w.position.x + this.dir * 7.4 * Math.cos(pitch), this.z0, k.n(14, 40, 90), 8, 3, k.n(2, 6, 12));
      }
      if (this.splashed < 0 && this.vel.y < 0 && w.position.y < 0.6) {
        this.splashed = t;
        splash(k, w.position.x, this.z0, k.n(50, 160, 360), 17, 7, k.n(6, 20, 45));
        k.rings.spawn(w.position.x, k.ringY, this.z0, 18, 4);
        k.rings.spawn(w.position.x, k.ringY, this.z0, 11, 2.8);
      }
      if (w.position.y < -15) w.visible = false;
    }
    if (this.spouts === 1 && t >= 10.6) {
      this.spouts = 2;
      this.spout(this.x0 + this.dir * 18, 0.75);
    }
    this.shake = this.splashed >= 0 ? 0.03 * smoothstep(0, 0.1, t - this.splashed) * Math.exp(-(t - this.splashed) * 1.5) : 0;
  }

  stop() {
    this.whale.visible = false;
    this.shake = 0;
  }
}

// ---- Ocean: forked lightning --------------------------------------------

const MAIN_MAX = 33;
const FORK_POINTS = 9;
const MAX_FORKS = 4;
const STROKES = [0, 0.19, 0.37, 0.62];

class Lightning extends Effect {
  private bolt!: THREE.Mesh;
  private boltMat!: THREE.MeshBasicMaterial;
  private disc!: THREE.Mesh;
  private discMat!: THREE.MeshBasicMaterial;
  private pts = new Float32Array((MAIN_MAX + MAX_FORKS * FORK_POINTS) * 3);
  private positions!: Float32Array;
  private colors!: Float32Array;
  private index!: Uint16Array;
  private mainN = 17;
  private forks = 1;
  private strokes = 2;
  private stroke = -1;
  private x0 = 0;
  private z0 = -84;
  private yTop = 32;
  private glow = new THREE.Color('#9fbfff');
  // Fog and background are lerped toward the flash colour and restored exactly.
  private flashColor = new THREE.Color('#e6eeff');
  private flashing = false;
  // Fog colour, background colour and the sky dome's two colours (see flash()).
  private targets: (THREE.Color | null)[] = [null, null, null, null];
  private saved = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
  private wrote = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
  private steamed = false;

  build() {
    const k = this.k;
    this.mainN = k.n(17, 33, 33);
    this.forks = k.n(1, 2, 4);
    this.strokes = k.n(2, 3, 4);
    const points = this.mainN + this.forks * FORK_POINTS;
    // Two ribbons per polyline (wide glow, thin core), two vertices per point.
    const verts = points * 4;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 3);
    this.index = new Uint16Array((points - 1 - this.forks) * 2 * 6 + 12);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    this.boltMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true });
    this.bolt = k.add(new THREE.Mesh(geo, this.boltMat));
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 4;

    const disc = new THREE.CircleGeometry(1, 20);
    disc.rotateX(-Math.PI / 2);
    const dc = new Float32Array(disc.attributes.position.count * 3);
    dc[0] = dc[1] = dc[2] = 1; // centre vertex bright, rim dark
    disc.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    this.discMat = new THREE.MeshBasicMaterial({ color: '#cfe0ff', vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.disc = k.add(new THREE.Mesh(disc, this.discMat));
    this.disc.renderOrder = 4;
    if (k.detail > 1) void k.puff;
    this.duration = 3.4;
  }

  start() {
    const k = this.k;
    // The storm front hangs over the left of the sky; strike clear of the boat.
    this.z0 = -84;
    const half = k.halfWidth(this.z0);
    this.x0 = k.clearOfBoat(k.cam.x + k.range(-0.65, 0.3) * half, this.z0, 22, half * 0.75, -1);
    // Start where the cloud base appears to sit from the camera, so the bolt leaves the cloud.
    this.yTop = 2.2 + (40 - 2.2) * ((CAM_Z - this.z0) / (CAM_Z + 170)) + 4;
    const p = this.pts;
    p[0] = this.x0 + k.range(-7, 7);
    p[1] = this.yTop;
    p[2] = this.z0;
    const last = (this.mainN - 1) * 3;
    p[last] = this.x0;
    p[last + 1] = 0;
    p[last + 2] = this.z0;
    this.displace(0, this.mainN, 7);
    this.stroke = -1;
    this.steamed = false;
    this.disc.position.set(this.x0, k.ringY + 0.05, this.z0);
  }

  /** Midpoint displacement between the endpoints already set at [off] and [off + n - 1]. */
  private displace(off: number, n: number, amount: number) {
    const p = this.pts;
    let step = n - 1;
    let d = amount;
    while (step > 1) {
      const half = step >> 1;
      for (let i = half; i < n; i += step) {
        const a = (off + i - half) * 3;
        const b = (off + i + half) * 3;
        const m = (off + i) * 3;
        p[m] = (p[a] + p[b]) / 2 + (this.k.rng() * 2 - 1) * d;
        p[m + 1] = (p[a + 1] + p[b + 1]) / 2 + (this.k.rng() * 2 - 1) * d * 0.25;
        p[m + 2] = (p[a + 2] + p[b + 2]) / 2;
      }
      step = half;
      d *= 0.55;
    }
  }

  /** New side branches for each re-strike; the main channel stays. */
  private regrowForks() {
    const k = this.k;
    const p = this.pts;
    for (let f = 0; f < this.forks; f++) {
      const from = Math.floor(this.mainN * k.range(0.15, 0.65)) * 3;
      const off = this.mainN + f * FORK_POINTS;
      const o = off * 3;
      const e = (off + FORK_POINTS - 1) * 3;
      const len = k.range(8, 17);
      const side = k.sign();
      p[o] = p[from];
      p[o + 1] = p[from + 1];
      p[o + 2] = p[from + 2];
      p[e] = p[from] + side * len * k.range(0.5, 0.9);
      p[e + 1] = Math.max(1, p[from + 1] - len * k.range(0.6, 1));
      p[e + 2] = p[from + 2];
      this.displace(off, FORK_POINTS, 2.4);
    }
    this.writeRibbons();
  }

  private writeRibbons() {
    let v = 0;
    let idx = 0;
    const line = (off: number, n: number, width: number, bright: number, color: THREE.Color, taper: number) => {
      const p = this.pts;
      const v0 = v;
      for (let j = 0; j < n; j++) {
        const a = (off + Math.max(0, j - 1)) * 3;
        const b = (off + Math.min(n - 1, j + 1)) * 3;
        const dx = p[b] - p[a];
        const dy = p[b + 1] - p[a + 1];
        const len = Math.hypot(dx, dy) || 1;
        const w = (width * (1 - taper * (j / (n - 1)))) / 2;
        const px = (-dy / len) * w;
        const py = (dx / len) * w;
        const i = (off + j) * 3;
        // Fade into the cloud at the top.
        const fade = bright * smoothstep(this.yTop, this.yTop - 6, p[i + 1]);
        for (let s = -1; s <= 1; s += 2) {
          this.positions[v * 3] = p[i] + px * s;
          this.positions[v * 3 + 1] = p[i + 1] + py * s;
          this.positions[v * 3 + 2] = p[i + 2];
          this.colors[v * 3] = color.r * fade;
          this.colors[v * 3 + 1] = color.g * fade;
          this.colors[v * 3 + 2] = color.b * fade;
          v++;
        }
      }
      for (let j = 0; j < n - 1; j++) {
        const a = v0 + j * 2;
        this.index[idx++] = a;
        this.index[idx++] = a + 1;
        this.index[idx++] = a + 2;
        this.index[idx++] = a + 1;
        this.index[idx++] = a + 3;
        this.index[idx++] = a + 2;
      }
    };
    line(0, this.mainN, 2.6, 0.35, this.glow, 0.3);
    line(0, this.mainN, 0.4, 1, WHITE, 0.3);
    for (let f = 0; f < this.forks; f++) {
      const off = this.mainN + f * FORK_POINTS;
      line(off, FORK_POINTS, 1.4, 0.25, this.glow, 0.7);
      line(off, FORK_POINTS, 0.24, 0.7, WHITE, 0.7);
    }
    const g = this.bolt.geometry;
    g.setDrawRange(0, idx);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.index!.needsUpdate = true;
  }

  step() {
    const k = this.k;
    const t = this.t;
    let o = 0;
    for (let s = 0; s < this.strokes; s++) {
      if (t < STROKES[s]) break;
      if (s > this.stroke) {
        this.stroke = s;
        this.regrowForks();
      }
      o += Math.exp(-(t - STROKES[s]) * 13);
    }
    this.boltMat.opacity = Math.min(1, o);
    this.bolt.visible = o > 0.01;
    const glow = Math.min(1, o * 0.9) + 0.4 * Math.exp(-t * 2.5);
    this.discMat.opacity = glow;
    this.disc.visible = glow > 0.01;
    this.disc.scale.setScalar(9 + 3 * Math.min(1, o));
    if (!this.steamed && k.detail > 1) {
      this.steamed = true;
      for (let i = 0; i < k.n(0, 14, 30); i++) {
        k.puff.spawn(this.x0 + k.range(-2, 2), 0.6, this.z0 + k.range(-1, 1), k.range(-1.5, 1.5), k.range(1.5, 4), k.range(-0.5, 1), k.range(1.8, 3), 1.5, k.range(5, 8), 0.45, MIST, 0.4, 1.2);
      }
    }
    this.flash(Math.min(0.65, o * 0.55));
    // Thunder arrives after the light.
    this.shake = t > 0.9 ? 0.1 * pulse(clamp01((t - 0.9) / 2.3), 0.08) : 0;
  }

  /**
   * The colours a flash lights up: the fog, the background, and the sky dome's
   * sky and horizon (any visible scene child with uSky / uHorizon uniforms, as
   * World's Atmosphere has). World writes them all every frame.
   */
  private gatherTargets() {
    const scene = this.k.scene;
    const fog = scene.fog as THREE.Fog | null;
    const bg = scene.background as THREE.Color | null;
    const t = this.targets;
    t[0] = fog && fog.color ? fog.color : null;
    t[1] = bg && bg.isColor ? bg : null;
    t[2] = t[3] = null;
    const children = scene.children;
    for (let i = 0; i < children.length; i++) {
      const u = ((children[i] as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms;
      if (children[i].visible && u && u.uSky && u.uHorizon) {
        t[2] = u.uSky.value as THREE.Color;
        t[3] = u.uHorizon.value as THREE.Color;
        break;
      }
    }
  }

  private flash(amount: number) {
    this.gatherTargets();
    for (let i = 0; i < this.targets.length; i++) {
      const c = this.targets[i];
      if (!c) continue;
      // Whatever we did not write ourselves is World's fresh value: the new base.
      if (!this.flashing || !c.equals(this.wrote[i])) this.saved[i].copy(c);
      this.wrote[i].copy(c.copy(this.saved[i]).lerp(this.flashColor, i >= 2 ? amount * 0.7 : amount));
    }
    this.flashing = true;
  }

  stop() {
    if (this.flashing) {
      this.gatherTargets();
      // Only restore what is still ours: if World already rewrote it, it is right.
      for (let i = 0; i < this.targets.length; i++) {
        const c = this.targets[i];
        if (c && c.equals(this.wrote[i])) c.copy(this.saved[i]);
      }
      this.flashing = false;
    }
    this.bolt.visible = this.disc.visible = false;
    this.shake = 0;
  }
}

// ---- Ocean: passing ship ------------------------------------------------

class Ship extends Effect {
  private root!: THREE.Group;
  private body!: THREE.Group;
  private hull!: THREE.Mesh;
  private lights!: THREE.Mesh;
  private lightsMat!: THREE.MeshBasicMaterial;
  private wake!: THREE.Mesh;
  private wakeMat!: THREE.MeshBasicMaterial;
  private dir = 1;
  private x0 = 0;
  private z0 = -78;
  private speed = 6;
  private smokeDue = 0;
  private smoke = new THREE.Color('#5d6166');
  private foam = new THREE.Color('#f2f8fa');

  build() {
    const k = this.k;
    const rng = new Rng(0x5419);
    const hullShape = new THREE.Shape();
    hullShape.moveTo(-8.5, 1.6);
    hullShape.lineTo(8.0, 1.6);
    hullShape.lineTo(9.4, 2.3);
    hullShape.lineTo(8.6, -0.4);
    hullShape.lineTo(7.2, -1.3);
    hullShape.lineTo(-8.0, -1.3);
    hullShape.lineTo(-8.8, 0.2);
    hullShape.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.2, bevelEnabled: false });
    hullGeo.translate(0, 0, -1.6);
    const parts = [paint(hullGeo, (_x, y) => (y < 0.15 ? '#9b2f26' : y > 1.45 ? '#e8e2d6' : '#22303b'))];
    const boxes = ['#c0392b', '#2e86c1', '#e67e22', '#27ae60', '#8e44ad', '#d4ac0d'];
    for (let x = -3; x <= 6.5; x += 2.05) {
      for (let tier = 0; tier < 2; tier++) {
        for (const z of [-0.72, 0.72]) {
          if (tier === 1 && rng.next() < 0.3) continue;
          parts.push(solid(place(new THREE.BoxGeometry(1.95, 1.1, 1.35), x, 2.2 + tier * 1.12, z), rng.pick(boxes)));
        }
      }
    }
    const white = '#eceae4';
    parts.push(
      solid(place(new THREE.BoxGeometry(3.2, 3.2, 2.9), -6.4, 3.2, 0), white),
      solid(place(new THREE.BoxGeometry(3.6, 0.9, 3.4), -6.2, 5.2, 0), white),
      solid(place(new THREE.BoxGeometry(1.0, 2.0, 1.0), -7.6, 6.2, 0), '#d0d4d8'),
      solid(place(new THREE.BoxGeometry(1.05, 0.45, 1.05), -7.6, 6.6, 0), '#b03a2e'),
      solid(place(new THREE.BoxGeometry(1.05, 0.25, 1.05), -7.6, 7.25, 0), '#1d1d1f'),
      solid(place(new THREE.CylinderGeometry(0.07, 0.09, 3.2, 5), 8.0, 3.6, 0), '#d8d8d8'),
      solid(place(new THREE.CylinderGeometry(0.05, 0.05, 2.0, 5), -5.6, 6.6, 0), '#d8d8d8'),
    );
    this.hull = new THREE.Mesh(merge(parts), flatMat('#ffffff', { vertexColors: true }));

    // Windows and navigation lights: unlit, so they glow at night.
    const lights: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) lights.push(solid(place(new THREE.BoxGeometry(0.42, 0.28, 0.06), -7.6 + i * 0.75, 5.3, 1.72), '#ffd890'));
    for (let i = 0; i < 5; i++) lights.push(solid(place(new THREE.BoxGeometry(0.42, 0.28, 0.06), -7.6 + i * 0.75, 5.3, -1.72), '#ffd890'));
    for (let i = 0; i < 3; i++) lights.push(solid(place(new THREE.BoxGeometry(0.06, 0.28, 0.42), -4.38, 5.3, -1 + i), '#ffd890'));
    lights.push(
      solid(place(new THREE.BoxGeometry(0.22, 0.22, 0.22), 8.0, 5.3, 0), '#ffffff'),
      solid(place(new THREE.BoxGeometry(0.2, 0.2, 0.2), -4.3, 5.0, 1.85), '#38ff6a'),
      solid(place(new THREE.BoxGeometry(0.2, 0.2, 0.2), -4.3, 5.0, -1.85), '#ff3b30'),
      solid(place(new THREE.BoxGeometry(0.2, 0.2, 0.2), -8.7, 2.0, 0), '#ffffff'),
    );
    this.lightsMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.lights = new THREE.Mesh(merge(lights), this.lightsMat);

    // Foam: a V off the bow and a churned stripe astern, fading behind.
    const wake: number[] = [];
    const wakeCol: number[] = [];
    const quad = (x0: number, z0a: number, z0b: number, x1: number, z1a: number, z1b: number, a0: number, a1: number) => {
      wake.push(x0, 0, z0a, x1, 0, z1a, x0, 0, z0b, x0, 0, z0b, x1, 0, z1a, x1, 0, z1b);
      for (const a of [a0, a1, a0, a0, a1, a1]) wakeCol.push(1, 1, 1, a);
    };
    const segs = k.n(4, 6, 8);
    for (let i = 0; i < segs; i++) {
      const xa = 9 - (i / segs) * 40;
      const xb = 9 - ((i + 1) / segs) * 40;
      const spread = (x: number) => 1.6 + (9 - x) * 0.32;
      const wid = (x: number) => 0.5 + (9 - x) * 0.05;
      const aa = 0.75 * (1 - i / segs);
      const ab = 0.75 * (1 - (i + 1) / segs);
      for (const s of [1, -1]) quad(xa, s * spread(xa), s * (spread(xa) + wid(xa)), xb, s * spread(xb), s * (spread(xb) + wid(xb)), aa, ab);
      const sa = -8 - (i / segs) * 28;
      const sb = -8 - ((i + 1) / segs) * 28;
      const half = (x: number) => 1.1 + (-8 - x) * 0.07;
      quad(sa, -half(sa), half(sa), sb, -half(sb), half(sb), 0.85 * (1 - i / segs), 0.85 * (1 - (i + 1) / segs));
    }
    const wakeGeo = new THREE.BufferGeometry();
    wakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(wake, 3));
    wakeGeo.setAttribute('color', new THREE.Float32BufferAttribute(wakeCol, 4));
    this.wakeMat = new THREE.MeshBasicMaterial({ color: this.foam, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
    this.wake = new THREE.Mesh(wakeGeo, this.wakeMat);
    this.wake.renderOrder = 1;

    this.root = k.add(new THREE.Group());
    this.body = new THREE.Group();
    this.body.add(this.hull, this.lights);
    this.root.add(this.body, this.wake);
    if (k.detail > 1) void k.puff;
    this.duration = 32;
  }

  start() {
    const k = this.k;
    this.dir = k.sign();
    this.z0 = -78;
    const half = k.halfWidth(this.z0) + 22;
    this.x0 = k.cam.x - this.dir * half;
    this.speed = (2 * half) / this.duration;
    this.root.rotation.y = this.dir > 0 ? 0 : Math.PI;
    this.wake.position.y = 0.45 * k.map.waves + 0.1;
    this.smokeDue = 0;
    this.root.visible = true;
  }

  step(dt: number) {
    const k = this.k;
    const t = this.t;
    this.root.position.set(this.x0 + this.dir * this.speed * t, 0, this.z0);
    this.body.position.y = Math.sin(t * 0.8) * 0.18 * k.map.waves;
    this.body.rotation.z = Math.sin(t * 0.7) * 0.025;
    this.body.rotation.x = Math.sin(t * 0.9 + 1) * 0.035;
    this.lightsMat.color.setScalar(k.night ? 1 : 0.42);
    this.wakeMat.color.copy(this.foam).multiplyScalar(Math.max(0.3, k.light));
    const rate = k.n(0, 3, 6);
    if (rate > 0) {
      this.smokeDue += rate * dt;
      while (this.smokeDue >= 1) {
        this.smokeDue--;
        const fx = this.root.position.x - this.dir * 7.6;
        k.puff.spawn(fx, 7.6, this.z0, k.range(-0.4, 0.4), k.range(0.8, 1.6), k.range(-0.3, 0.3), k.range(4, 6), 1, k.range(5, 7), 0.4, this.smoke, 0.15, 0.4);
      }
    }
  }

  stop() {
    this.root.visible = false;
  }
}

// ---- Underwater: leviathan ----------------------------------------------

class Leviathan extends Effect {
  private body!: THREE.Mesh;
  private base!: Float32Array;
  private spots: THREE.Mesh | null = null;
  private spotsMat: THREE.MeshBasicMaterial | null = null;
  private spotBase: Float32Array | null = null;
  private group!: THREE.Group;
  private dir = 1;
  private x0 = 0;
  private speed = 6;
  private dist = 40;

  build() {
    const k = this.k;
    const segs = k.n(7, 9, 12);
    const dark = '#0d2433';
    const belly = '#1d3d4c';
    const body = paint(
      lathe([[0.1, -17], [0.8, -14], [1.6, -10], [2.6, -5], [3.2, 0], [3.3, 4], [2.8, 9], [2.0, 13], [1.0, 16], [0.2, 17.2]], segs),
      (_x, y) => (y < -1 ? belly : dark),
    );
    body.scale(1, 0.9, 1.1);
    const fin = (s: number) => solid(place(new THREE.BoxGeometry(7, 0.3, 1.8), 6, -2, s * 3.5, s * 0.4, s * 0.8, -0.25), dark);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(-2.6, 5.2);
    shape.lineTo(-4.2, 4.6);
    shape.lineTo(-2.4, 0);
    shape.lineTo(-4.2, -4.6);
    shape.lineTo(-2.6, -5.2);
    shape.closePath();
    const fluke = solid(place(new THREE.ShapeGeometry(shape), -16.6, 0, 0, Math.PI / 2), dark);
    const geo = merge([body, fin(1), fin(-1), fluke]);
    (geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.base = (geo.attributes.position.array as Float32Array).slice();
    this.body = new THREE.Mesh(geo, flatMat('#ffffff', { vertexColors: true, side: THREE.DoubleSide, roughness: 1 }));
    this.body.frustumCulled = false;
    this.group = k.add(new THREE.Group());
    this.group.add(this.body);

    if (k.detail > 1) {
      // A line of faint photophores along both flanks.
      const n = k.n(0, 10, 18);
      const quads: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const x = -11 + (i / (n - 1)) * 24;
        const r = 2.9 * Math.sin(Math.PI * clamp01((x + 17) / 34.2)) + 0.3;
        for (const s of [1, -1]) {
          const q = new THREE.PlaneGeometry(0.5, 0.5);
          if (s < 0) q.rotateY(Math.PI);
          quads.push(solid(place(q, x, -0.6 + Math.sin(i) * 0.3, s * r * 1.1), '#5ff2ff'));
        }
      }
      const sg = merge(quads);
      (sg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
      this.spotBase = (sg.attributes.position.array as Float32Array).slice();
      this.spotsMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      this.spots = new THREE.Mesh(sg, this.spotsMat);
      this.spots.frustumCulled = false;
      this.group.add(this.spots);
    }
    this.duration = 20;
  }

  start() {
    const k = this.k;
    this.dir = k.sign();
    const fog = k.scene.fog as THREE.Fog | null;
    const near = fog && fog.isFog ? fog.near : 6;
    const far = fog && fog.isFog ? fog.far : 60;
    // Deep in the fog: a silhouette, not a clear view.
    this.dist = THREE.MathUtils.clamp(near + (far - near) * 0.55, 26, 50);
    const z = CAM_Z - this.dist;
    const half = (k.aimed ? k.halfWidth(z) : 70) + 24;
    this.x0 = k.cam.x - this.dir * half;
    this.speed = (2 * half) / this.duration;
    const y = THREE.MathUtils.clamp(k.cam.y - 2.5 + k.range(-2, 2), k.floorY + 6, -4);
    this.group.position.set(this.x0, y, z);
    this.group.rotation.set(0, this.dir > 0 ? 0 : Math.PI, k.range(-0.05, 0.05));
    this.group.visible = true;
  }

  private bend(src: Float32Array, attr: THREE.BufferAttribute, phase: number) {
    const arr = attr.array as Float32Array;
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i];
      const w = smoothstep(4, -17, x);
      arr[i] = x;
      arr[i + 1] = src[i + 1] + w * w * 2.4 * Math.sin(phase - x * 0.18);
      arr[i + 2] = src[i + 2];
    }
    attr.needsUpdate = true;
  }

  step() {
    const k = this.k;
    const t = this.t;
    const g = this.group;
    g.position.x = this.x0 + this.dir * this.speed * t;
    g.position.y += Math.sin(t * 0.4) * 0.004;
    const phase = t * 1.5;
    this.bend(this.base, this.body.geometry.attributes.position as THREE.BufferAttribute, phase);
    if (this.spots && this.spotBase && this.spotsMat) {
      this.bend(this.spotBase, this.spots.geometry.attributes.position as THREE.BufferAttribute, phase);
      const env = smoothstep(0, 2, t) * (1 - smoothstep(this.duration - 2, this.duration, t));
      this.spotsMat.opacity = env * (1 - fogAmount(k.scene, this.dist)) * (0.6 + 0.4 * Math.sin(t * 2.3));
    }
    // A pressure wave as it passes closest.
    const dx = (g.position.x - k.cam.x) / 18;
    this.shake = 0.025 * Math.exp(-dx * dx);
  }

  stop() {
    this.group.visible = false;
    this.shake = 0;
  }
}

// ---- Underwater: bubble vent --------------------------------------------

class Vent extends Effect {
  private x = 0;
  private y = 0;
  private z = 0;
  private left = 0;
  private burst = 0;
  private due = 0;
  private seabed = false;
  private silt = new THREE.Color();

  build() {
    this.silt.set(this.k.map.sand);
    void this.k.puff;
    void this.k.bubbles;
    this.duration = 13;
  }

  start() {
    const k = this.k;
    this.x = k.cam.x + k.range(-12, 12);
    this.z = k.range(-6, -1);
    this.seabed = k.floorY + 0.4 >= k.cam.y - 15;
    this.y = Math.max(k.floorY + 0.4, k.cam.y - 15);
    this.left = k.n(40, 140, 320);
    this.burst = Math.round(this.left * 0.4);
    this.due = 0;
    if (this.seabed) {
      for (let i = 0; i < k.n(16, 50, 110); i++) {
        const a = k.rng() * Math.PI * 2;
        const s = k.range(0.5, 2.5);
        k.puff.spawn(this.x + Math.cos(a) * 0.8, this.y + 0.3, this.z + Math.sin(a) * 0.8, Math.cos(a) * s, k.range(0.3, 2), Math.sin(a) * s, k.range(3, 5), 1 * k.puffScale, k.range(4, 6) * k.puffScale, 0.55, this.silt, 0.1, 1.1);
      }
    }
  }

  private bubble(power: number) {
    const k = this.k;
    const size = k.range(0.15, 0.55) * (k.detail === 1 ? 1.5 : 1);
    k.bubbles.spawn(
      this.x + k.range(-0.6, 0.6), this.y + k.range(0, 0.5), this.z + k.range(-0.6, 0.6),
      k.range(-0.8, 0.8) * power, k.range(2, 5) * power, k.range(-0.8, 0.8) * power,
      k.range(7, 12), size, size * 1.6, k.range(0.7, 1), WHITE,
      2.2, 0.35, -Infinity, -0.15,
    );
  }

  step(dt: number) {
    const t = this.t;
    while (this.burst > 0) {
      this.bubble(1.6);
      this.burst--;
      this.left--;
    }
    if (t < 6 && this.left > 0) {
      this.due += (this.left / Math.max(0.5, 6 - t)) * dt;
      while (this.due >= 1 && this.left > 0) {
        this.bubble(1);
        this.due--;
        this.left--;
      }
    }
    this.shake = 0.05 * Math.exp(-t * 2.2) * smoothstep(0, 0.05, t);
  }

  stop() {
    this.shake = 0;
  }
}

// ---- Underwater: jellyfish bloom ----------------------------------------

class Jellies extends Effect {
  private bells!: THREE.InstancedMesh;
  private halos: THREE.InstancedMesh | null = null;
  private count = 0;
  private st!: Float32Array; // x, y, z, size, phase, freq, tint
  private tints = ['#59ffe0', '#b77bff', '#ff7ad9', '#6fb6ff'].map((c) => new THREE.Color(c));

  build() {
    const k = this.k;
    const n = (this.count = k.n(12, 28, 56));
    const segs = k.n(6, 8, 10);
    const bell = new THREE.SphereGeometry(1, segs, 3, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const parts = [paint(bell, (_x, y) => (y > 0.75 ? '#8c8c8c' : '#ffffff'))];
    const tentacles = k.n(4, 5, 6);
    for (let i = 0; i < tentacles; i++) {
      const a = (i / tentacles) * Math.PI * 2;
      const strip = new THREE.PlaneGeometry(0.07, 2.4, 1, 3);
      strip.translate(0, -1.2, 0);
      parts.push(paint(place(strip, Math.cos(a) * 0.7, 0.35, Math.sin(a) * 0.7, 0, -a, 0), (_x, y) => (y > -0.5 ? '#9a9a9a' : '#4a4a4a')));
    }
    parts.push(paint(place(new THREE.PlaneGeometry(0.22, 1.5, 1, 2), 0, -0.4, 0), () => '#b0b0b0'));
    parts.push(paint(place(new THREE.PlaneGeometry(0.22, 1.5, 1, 2), 0, -0.4, 0, 0, Math.PI / 2, 0), () => '#b0b0b0'));
    const geo = merge(parts);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true });
    this.bells = k.add(dynamicInstances(geo, mat, n));
    this.bells.setColorAt(0, _c.setRGB(0, 0, 0));
    this.bells.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    if (k.detail > 1) {
      const halo = new THREE.PlaneGeometry(1, 1);
      const haloMat = new THREE.MeshBasicMaterial({ map: k.softTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      this.halos = k.add(dynamicInstances(halo, haloMat, n));
      this.halos.setColorAt(0, _c.setRGB(0, 0, 0));
      this.halos.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    }
    this.st = new Float32Array(n * 7);
    this.duration = 24;
  }

  start() {
    const k = this.k;
    const spread = k.aimed ? 28 : 70;
    const top = Math.min(-2, k.cam.y + 6);
    const bottom = Math.max(k.floorY + 2, k.cam.y - 14);
    for (let i = 0; i < this.count; i++) {
      const o = i * 7;
      this.st[o] = k.cam.x + k.range(-spread, spread);
      this.st[o + 1] = k.range(bottom, Math.max(bottom + 1, top)) - 4;
      this.st[o + 2] = k.range(-16, 10);
      this.st[o + 3] = k.range(0.5, 1.4);
      this.st[o + 4] = k.range(0, Math.PI * 2);
      this.st[o + 5] = k.range(0.55, 0.9) * Math.PI * 2;
      this.st[o + 6] = Math.floor(k.rng() * this.tints.length);
    }
    this.bells.visible = true;
    if (this.halos) this.halos.visible = true;
  }

  step(dt: number) {
    const k = this.k;
    const t = this.t;
    const env = smoothstep(0, 2.5, t) * (1 - smoothstep(this.duration - 4, this.duration, t));
    for (let i = 0; i < this.count; i++) {
      const o = i * 7;
      const beat = Math.sin(t * this.st[o + 5] + this.st[o + 4]);
      const squeeze = beat > 0 ? beat * beat : 0;
      // Each contraction pushes it up; between beats it drifts.
      this.st[o + 1] += (0.25 + 0.9 * squeeze) * dt;
      this.st[o] += Math.sin(t * 0.3 + this.st[o + 4]) * 0.15 * dt;
      const size = this.st[o + 3];
      const x = this.st[o];
      const y = this.st[o + 1];
      const z = this.st[o + 2];
      _q.setFromAxisAngle(Z_AXIS, Math.sin(t * 0.5 + this.st[o + 4]) * 0.25);
      _m.compose(_v.set(x, y, z), _q, _s.set(size * (1 - 0.22 * squeeze), size * (1 + 0.15 * squeeze), size * (1 - 0.22 * squeeze)));
      this.bells.setMatrixAt(i, _m);
      const dx = x - k.cam.x;
      const dy = y - k.cam.y;
      const dz = z - CAM_Z;
      const fade = env * (1 - fogAmount(k.scene, Math.sqrt(dx * dx + dy * dy + dz * dz))) * (0.75 + 0.25 * squeeze);
      const tint = this.tints[this.st[o + 6]];
      this.bells.setColorAt(i, _c.copy(tint).multiplyScalar(fade));
      if (this.halos) {
        _m.compose(_v2.set(x, y + 0.2 * size, z - 0.05), _q.identity(), _s.set(size * 4, size * 4, 1));
        this.halos.setMatrixAt(i, _m);
        this.halos.setColorAt(i, _c.copy(tint).multiplyScalar(fade * 0.3));
      }
    }
    this.bells.instanceMatrix.needsUpdate = true;
    this.bells.instanceColor!.needsUpdate = true;
    if (this.halos) {
      this.halos.instanceMatrix.needsUpdate = true;
      this.halos.instanceColor!.needsUpdate = true;
    }
  }

  stop() {
    this.bells.visible = false;
    if (this.halos) this.halos.visible = false;
  }
}

// ---- The manager --------------------------------------------------------

const FACTORY: Record<string, (k: Kit) => Effect> = {
  avalanche: (k) => new Avalanche(k),
  calving: (k) => new Calving(k),
  aurora: (k) => new AuroraSurge(k),
  rockfall: (k) => new Rockfall(k),
  cranes: (k) => new Cranes(k),
  mist: (k) => new MistSurge(k),
  whale: (k) => new Whale(k),
  lightning: (k) => new Lightning(k),
  ship: (k) => new Ship(k),
  leviathan: (k) => new Leviathan(k),
  vent: (k) => new Vent(k),
  jellies: (k) => new Jellies(k),
};

export class WorldEvents {
  /** Fired when an event starts (the game toasts the label). */
  onEvent: ((e: WorldEventInfo) => void) | null = null;
  /** When false, only trigger() starts events (the lab page turns the schedule off). */
  auto = true;
  private kit: Kit;
  private schedule: EventSchedule;
  private effects = new Map<string, Effect>();
  private infos: WorldEventInfo[] = [];
  private active: Effect | null = null;
  private activeInfo: WorldEventInfo | null = null;
  private activeDef: EventDef | null = null;
  private now = 0;
  private ctx: EventContext = { cameraY: 2.2, depth: 0, night: false, shelfDepth: 30 };

  constructor(scene: THREE.Scene, map: MapDef, detail: Detail, opts: WorldEventsOptions = {}) {
    const rng = opts.rng ?? Math.random;
    this.kit = new Kit(scene, map, detail, rng);
    this.schedule = new EventSchedule(map.id, { rng });
    this.rebuild();
  }

  /** The events possible on the current map. */
  get events(): readonly WorldEventInfo[] {
    return this.infos;
  }

  /** The running event's id, or null. */
  get activeId(): string | null {
    return this.activeInfo ? this.activeInfo.id : null;
  }

  /** Camera shake amplitude in world units right now (0 when calm). */
  get shake(): number {
    return this.active ? this.active.shake : 0;
  }

  /** Debug: the running event and how far in, and seconds until the next one is due. */
  get status(): { running: WorldEventInfo | null; elapsed: number; duration: number; nextIn: number | null } {
    const due = this.schedule.dueAt;
    return {
      running: this.activeInfo,
      elapsed: this.active ? this.active.t : 0,
      duration: this.active ? this.active.duration : 0,
      nextIn: due === null ? null : Math.max(0, due - this.now),
    };
  }

  /** Clear running events, rebuild for the new map and restart the schedule. */
  setMap(map: MapDef) {
    this.halt();
    this.kit.map = map;
    this.kit.seabedY = -mapDepth(map);
    this.kit.floorY = this.kit.seabedY;
    this.schedule.setMap(map.id);
    this.rebuild();
  }

  setDetail(detail: Detail) {
    if (detail === this.kit.detail) return;
    if (this.active) {
      this.halt();
      this.schedule.end(this.now);
    }
    this.kit.detail = detail;
    this.rebuild();
  }

  update(time: number, dt: number, ctx: EventContext) {
    this.now = time;
    const c = this.ctx;
    c.cameraY = ctx.cameraY;
    c.depth = ctx.depth;
    c.night = ctx.night;
    c.shelfDepth = ctx.shelfDepth;
    c.cameraX = ctx.cameraX;
    c.aspect = ctx.aspect;
    c.lightingEffects = ctx.lightingEffects;
    c.storm = ctx.storm;
    c.cloud = ctx.cloud;
    c.floorY = ctx.floorY;
    this.kit.setContext(ctx);
    // Lighting effects switched off mid-show: the aurora or lightning goes at once.
    if (this.activeDef?.lightingEffect && ctx.lightingEffects === false) {
      this.halt();
      this.schedule.end(time);
    }
    if (!this.active && this.auto) {
      const def = this.schedule.tick(time, ctx);
      if (def) this.begin(def);
    }
    const effect = this.active;
    if (!effect) return;
    const step = Math.min(Math.max(dt, 0), 0.1);
    effect.t += step;
    effect.step(step);
    this.kit.updatePools(step);
    if (effect.t >= effect.duration) {
      this.halt();
      this.schedule.end(time);
    }
  }

  /** Start an event now, replacing any running one. False if it isn't on this map. */
  trigger(id: string): boolean {
    if (!this.effects.has(id)) return false;
    // A light show stays off while the "Lighting effects" setting is.
    if (this.ctx.lightingEffects === false && this.schedule.events.some((d) => d.id === id && d.lightingEffect)) return false;
    this.halt();
    const def = this.schedule.force(id);
    if (!def) return false;
    this.kit.setContext(this.ctx);
    this.begin(def);
    return true;
  }

  /**
   * End whatever is playing and start over: the next event comes the first-event
   * delay after the next update(). For leaving a dive (menus show no events).
   */
  stop() {
    this.halt();
    this.schedule.reset();
  }

  dispose() {
    this.halt();
    this.effects.clear();
    this.kit.dispose();
    this.onEvent = null;
  }

  private begin(def: EventDef) {
    const effect = this.effects.get(def.id);
    if (!effect) {
      this.schedule.end(this.now);
      return;
    }
    effect.t = 0;
    effect.shake = 0;
    effect.start();
    this.active = effect;
    this.activeDef = def;
    this.activeInfo = this.infos.find((i) => i.id === def.id) ?? null;
    if (this.activeInfo) this.onEvent?.(this.activeInfo);
  }

  /** Stop the running event's visuals (the schedule is the caller's business). */
  private halt() {
    if (!this.active) return;
    this.active.stop();
    this.kit.clearPools();
    this.active = null;
    this.activeDef = null;
    this.activeInfo = null;
  }

  private rebuild() {
    this.kit.disposeContent();
    this.effects.clear();
    this.infos = [];
    for (const def of this.schedule.events) {
      const make = FACTORY[def.id];
      if (!make) continue;
      const effect = make(this.kit);
      effect.build();
      this.effects.set(def.id, effect);
      this.infos.push({ id: def.id, label: def.label, map: def.map, underwater: def.underwater });
    }
  }
}

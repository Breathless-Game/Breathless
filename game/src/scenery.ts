import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Batch, flatMat, jitter, paintFaces, pyramid, type Placement } from './lowpoly';
import type { MapDef, MapId } from './maps';
import type { SceneryDetail } from './render-quality';
import type { WeatherState } from './weather';
import { Rng } from './rng';
import { waterHeight, waterSlope, type WaterDetail } from './water-waves';

// What you see above the water on each map: the fjord's snow peaks and cabins,
// Heaven Lake's stone pillars and mist, the ocean's lighthouse and freighter.
// The camera sits at z = +22 looking toward -z, so everything lives behind the
// boat. Static pieces are painted with vertex colours and batched into as few
// meshes as possible; each kind of moving piece (buoys, lamps, smoke, birds) is
// one InstancedMesh. No piece adds a real light: lamps glow by colour alone, and
// only at night with the "Lighting effects" setting on.
// Lower detail only drops pieces. Every layout comes from a fixed seed, and each
// feature draws from its own stream, so what remains sits where it does on high.

export interface Scenery {
  group: THREE.Group;
  /**
   * Animate the living parts. Runs at the world's decoration rate; `dt` is seconds
   * since the last call, and 0 re-poses everything without moving it on.
   */
  update(time: number, night: boolean, dt: number, env?: SceneryEnv): void;
}

/** What the world around the shore is doing. */
export interface SceneryEnv {
  weather?: WeatherState;
  /** The "Lighting effects" setting: off leaves lamps, windows, beams, aurora and lightning dark. Default on. */
  lightingEffects?: boolean;
  /** World's wave clock and swell height, so floating things ride the surface. Default `time` and 1. */
  waveTime?: number;
  swell?: number;
  waterDetail?: WaterDetail;
}

type Builder = (map: MapDef, detail: SceneryDetail) => Scenery;
const BUILDERS: Record<MapId, Builder> = { fjord: buildFjord, tianchi: buildTianchi, ocean: buildOcean };

export function buildScenery(map: MapDef, detail: SceneryDetail): Scenery {
  const scenery = BUILDERS[map.id](map, detail);
  // Pose the moving pieces now so none sits at the origin before the first tick.
  scenery.update(0, false, 0);
  return scenery;
}

// ---- Shared pieces -------------------------------------------------------

const shades = (hexes: string[]) => hexes.map((h) => new THREE.Color(h));

/** One value per detail level: [low, medium, high]. */
const perDetail = <T>(detail: SceneryDetail, values: readonly [T, T, T]) => values[detail - 1];

/** A seeded stream for one feature, so adding or dropping a feature never moves another. */
const stream = (seed: number, feature: number) => new Rng(Math.imul(seed, 31) + feature * 7919);

const fract = (x: number) => x - Math.floor(x);

// Scratch objects for the per-tick updates, so animating allocates nothing.
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const UNIT = [1, 1, 1] as const;

/** A warm light source that only shines at night. */
function lampMat(color = '#ffd58a') {
  return new THREE.MeshStandardMaterial({ color: '#5b4a33', emissive: color, emissiveIntensity: 0, flatShading: true });
}

/** Paint a whole piece one colour so it can join a vertex-coloured batch. */
function solid(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  if (flat !== geo) geo.dispose();
  const c = new THREE.Color(color);
  return paintFaces(flat, () => c);
}

/** Merge painted pieces, each moved into place, into one geometry (e.g. a buoy for an InstancedMesh). */
function compound(pieces: [THREE.BufferGeometry, THREE.ColorRepresentation, number, number, number][]) {
  const geos = pieces.map(([geo, color, x, y, z]) => {
    const g = solid(geo, color).translate(x, y, z);
    g.deleteAttribute('uv');
    return g;
  });
  const merged = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  return merged;
}

/** A geometry from raw triangles: each run is nine numbers per triangle, all in one colour. */
function triangles(runs: [number[], THREE.ColorRepresentation][]) {
  const pos: number[] = [];
  const col: number[] = [];
  for (const [verts, color] of runs) {
    const c = new THREE.Color(color);
    for (let i = 0; i < verts.length; i += 3) {
      pos.push(verts[i], verts[i + 1], verts[i + 2]);
      col.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Brighter toward the bottom, like a lantern lit from its base. */
function shadeByHeight(geo: THREE.BufferGeometry, bottom: number, top: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) col.fill(bottom + (top - bottom) * ((pos.getY(i) - min.y) / (max.y - min.y)), i * 3, i * 3 + 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number) {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Instances roam far from the base geometry's bounds, which culling would trust.
  mesh.frustumCulled = false;
  return mesh;
}

/** A disc that is bright in the middle and black at the rim; drawn additively it reads as a glow. */
function glowDisc(segments = 12) {
  const pos: number[] = [];
  const col: number[] = [];
  const at = (r: number, k: number, v: number) => {
    const a = (k / segments) * Math.PI * 2;
    pos.push(r * Math.cos(a), r * Math.sin(a), 0);
    col.push(v, v, v);
  };
  for (let k = 0; k < segments; k++) {
    pos.push(0, 0, 0);
    col.push(1, 1, 1);
    at(0.3, k, 0.45);
    at(0.3, k + 1, 0.45);
    at(0.3, k, 0.45);
    at(1, k, 0);
    at(1, k + 1, 0);
    at(0.3, k, 0.45);
    at(1, k + 1, 0);
    at(0.3, k + 1, 0.45);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

const additive = () =>
  new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });

// ---- Lamps ---------------------------------------------------------------

interface LightSpec {
  /** Colour when lit. */
  color: THREE.ColorRepresentation;
  /** The unlit lamp: by day, and dimmed between flashes at night. */
  glass: THREE.ColorRepresentation;
  /** Seconds between flashes and how long each flash lasts. Omit for a steady light. */
  period?: number;
  flash?: number;
  phase?: number;
  /** Candle-like flicker, 0..1. */
  flicker?: number;
  /** Radius of the glow around it at night, from medium detail up. */
  halo?: number;
  /** Brightness over time (0..1) for a light that follows something else, like the lighthouse lamp. */
  level?: (time: number) => number;
}

function brightness(s: LightSpec, time: number) {
  const phase = s.phase ?? 0;
  if (s.level) return s.level(time);
  if (s.period) return (((time + phase) % s.period) + s.period) % s.period < (s.flash ?? 0.5) ? 1 : 0;
  if (s.flicker) return 1 - s.flicker * (0.5 + 0.5 * Math.sin(time * 9.7 + phase * 5.1) * Math.sin(time * 4.3 + phase));
  return 1;
}

/**
 * Small unlit lamp heads (buoy lanterns, portholes, paper lanterns) in one draw
 * call, plus one additive draw call for their glow at night on medium and high.
 * Whoever owns a lamp places it (a bobbing buoy moves its own); colours follow
 * day and night and each lamp's flash pattern.
 */
class Lights {
  readonly heads: THREE.InstancedMesh;
  private glows: THREE.InstancedMesh | null = null;
  private at: Float32Array;
  private lit: THREE.Color[];
  private glass: THREE.Color[];
  private shining: boolean | null = null;

  constructor(group: THREE.Group, geo: THREE.BufferGeometry, private specs: LightSpec[], detail: SceneryDetail) {
    this.heads = instanced(geo, new THREE.MeshBasicMaterial({ vertexColors: geo.hasAttribute('color') }), specs.length);
    this.lit = specs.map((s) => new THREE.Color(s.color));
    this.glass = specs.map((s) => new THREE.Color(s.glass));
    this.at = new Float32Array(specs.length * 3);
    for (let i = 0; i < specs.length; i++) {
      this.heads.setMatrixAt(i, HIDDEN);
      this.heads.setColorAt(i, this.glass[i]);
    }
    group.add(this.heads);
    if (detail >= 2 && specs.some((s) => s.halo)) {
      const glows = (this.glows = instanced(glowDisc(), additive(), specs.length));
      for (let i = 0; i < specs.length; i++) {
        glows.setMatrixAt(i, HIDDEN);
        glows.setColorAt(i, _c.setRGB(0, 0, 0));
      }
      group.add(glows);
    }
  }

  /** Put lamp `i` where `matrix` says. A zero scale hides the head but keeps the glow (a lit window). */
  place(i: number, matrix: THREE.Matrix4) {
    this.heads.setMatrixAt(i, matrix);
    this.heads.instanceMatrix.needsUpdate = true;
    _p.setFromMatrixPosition(matrix).toArray(this.at, i * 3);
  }

  placeAt(i: number, x: number, y: number, z: number, sx = 1, sy = sx) {
    this.place(i, _m2.compose(_p.set(x, y, z), _q.identity(), _s.set(sx, sy, sx)));
  }

  /** Lamps shine only when `shine` is set: at night, with the "Lighting effects" setting on. */
  update(time: number, night: boolean, shine: boolean) {
    if (shine !== this.shining) {
      // Lit lamps shine through the haze; dark ones sit in it like everything else.
      const mat = this.heads.material as THREE.MeshBasicMaterial;
      mat.fog = !shine;
      mat.needsUpdate = true;
      if (this.glows) this.glows.visible = shine;
      this.shining = shine;
    }
    const glows = this.glows;
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i];
      const f = shine ? brightness(s, time) : 0;
      this.heads.setColorAt(i, _c.copy(this.glass[i]).multiplyScalar(night ? 0.3 : 1).lerp(this.lit[i], f));
      if (!glows || !shine) continue;
      if (!s.halo || f < 0.02) {
        glows.setMatrixAt(i, HIDDEN);
        continue;
      }
      const r = s.halo * (0.75 + 0.25 * f);
      // Nudged toward the camera so the lamp head doesn't cut its own glow in half.
      _p.fromArray(this.at, i * 3).z += 0.4;
      glows.setMatrixAt(i, _m.compose(_p, _q.identity(), _s.set(r, r, r)));
      glows.setColorAt(i, _c.copy(this.lit[i]).multiplyScalar(0.45 * f));
    }
    this.heads.instanceColor!.needsUpdate = true;
    if (glows && shine) {
      glows.instanceMatrix.needsUpdate = true;
      glows.instanceColor!.needsUpdate = true;
    }
  }
}

// ---- Things that float ---------------------------------------------------

interface FloatSpec {
  x: number;
  z: number;
  size: number;
  /** Non-uniform shape on top of `size`, e.g. a flat ice floe. */
  stretch?: readonly [number, number, number];
  /** Multiplies the body's white parts (a red or a green buoy from one mesh). */
  tint: THREE.ColorRepresentation;
  /** Slow drift back and forth along x: how far (m) and how fast (rad/s). */
  wander?: number;
  pace?: number;
  /** How much it leans with the waves; a tall spar buoy leans more than a float. */
  lean?: number;
  /** How far (m) the body sits below the waterline. */
  sink?: number;
  /** A lamp on top: its index in the map's Lights, and height and size in body units. */
  lamp?: { index: number; y: number; size: number; tall?: number };
}

/** Buoys, floats and floes in one draw call, riding the same waves as the surface. */
class Floats {
  readonly mesh: THREE.InstancedMesh;
  private yaw: number[];
  private phase: number[];

  constructor(
    group: THREE.Group,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    private specs: FloatSpec[],
    private waves: number,
    rng: Rng,
    private lights: Lights | null = null,
  ) {
    this.mesh = instanced(geo, mat, specs.length);
    this.yaw = specs.map(() => rng.range(0, Math.PI * 2));
    this.phase = specs.map(() => rng.range(0, Math.PI * 2));
    specs.forEach((s, i) => this.mesh.setColorAt(i, _c.set(s.tint)));
    group.add(this.mesh);
  }

  update(time: number, env?: SceneryEnv) {
    // Ride the world's wave clock and the weather's swell, so bodies stay on the surface.
    const waveTime = env?.waveTime ?? time;
    const waves = this.waves * (env?.swell ?? 1);
    const detail = env?.waterDetail ?? 1;
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i];
      const x = s.x + (s.wander ?? 0) * Math.sin(time * (s.pace ?? 0) + this.phase[i]);
      // Lean with the local wave slope (exaggerated: a real buoy also rolls), plus a little wobble.
      const lean = (s.lean ?? 1) * waves * 4;
      const wob = Math.sin(time * 1.7 + this.phase[i]) * 0.02 * lean;
      const slopeX = waterSlope(x, s.z + 30, waveTime, detail, 'x');
      const slopeZ = waterSlope(x, s.z + 30, waveTime, detail, 'z');
      _q.setFromEuler(_e.set(-Math.atan(slopeZ * lean) + wob, this.yaw[i] + time * 0.03, Math.atan(slopeX * lean) + wob * 0.7, 'ZXY'));
      const st = s.stretch ?? UNIT;
      _m.compose(_p.set(x, waterHeight(x, s.z + 30, waveTime, detail) * waves - (s.sink ?? 0), s.z), _q, _s.set(s.size * st[0], s.size * st[1], s.size * st[2]));
      this.mesh.setMatrixAt(i, _m);
      if (s.lamp && this.lights) {
        const l = s.lamp;
        this.lights.place(l.index, _m2.makeScale(l.size, l.size * (l.tall ?? 1), l.size).setPosition(0, l.y, 0).premultiply(_m));
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- Smoke and spray -----------------------------------------------------

interface PuffSource {
  x: number;
  y: number;
  z: number;
  /** Puffs alive at once on [low, medium, high]. */
  counts: readonly [number, number, number];
  /** Seconds from leaving the chimney to gone. */
  life: number;
  /** Metres risen, and blown along x and z, over one life. */
  rise: number;
  drift: readonly [number, number];
  /** Radius when born and when it thins out. */
  size: readonly [number, number];
  /** How far apart puffs are born. */
  spread: number;
}

/** Low-poly smoke puffs that rise, drift, swell and shrink away: one draw call for every source on a map. */
class Puffs {
  readonly mesh: THREE.InstancedMesh | null = null;
  private items: { s: PuffSource; phase: number; a: number; b: number; bulk: number }[] = [];
  /** Scales every puff; night smoke is thicker. */
  swell = 1;

  constructor(group: THREE.Group, mat: THREE.Material, sources: PuffSource[], detail: SceneryDetail, rng: Rng) {
    for (const s of sources) {
      const n = perDetail(detail, s.counts);
      // Seeds are drawn for the high-detail count, so puff j looks the same at every level.
      for (let j = 0; j < s.counts[2]; j++) {
        const [a, b, c] = [rng.next(), rng.next(), rng.next()];
        // Fewer puffs are drawn bigger, so a sparse plume still reads as one.
        if (j < n) this.items.push({ s, phase: (j + a * 0.6) / n, a: b, b: c, bulk: Math.pow(s.counts[2] / n, 0.35) });
      }
    }
    if (!this.items.length) return;
    this.mesh = instanced(new THREE.IcosahedronGeometry(1, 0), mat, this.items.length);
    this.items.forEach((it, i) => this.mesh!.setColorAt(i, _c.setScalar(0.86 + it.a * 0.14)));
    group.add(this.mesh);
  }

  update(time: number) {
    if (!this.mesh) return;
    for (let i = 0; i < this.items.length; i++) {
      const { s, phase, a, b, bulk } = this.items[i];
      const age = fract(time / s.life + phase);
      // Rises fast out of the chimney, then slows while the wind takes it.
      const x = s.x + s.drift[0] * Math.pow(age, 1.4) + (a - 0.5) * s.spread + Math.sin(time * 0.8 + b * 6.3) * 0.4 * age;
      const y = s.y + s.rise * (1 - Math.pow(1 - age, 1.7));
      const z = s.z + s.drift[1] * age + (b - 0.5) * s.spread;
      const r = (s.size[0] + (s.size[1] - s.size[0]) * age) * Math.min(1, age * 8) * Math.min(1, (1 - age) * 3.5) * bulk * this.swell;
      _q.setFromEuler(_e.set(a * 6, b * 6 + age * 1.5, 0, 'XYZ'));
      this.mesh.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(r, r * 0.8, r)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

interface SplashSource {
  x: number;
  z: number;
  /** Radius of the rock the waves break on. */
  r: number;
  counts: readonly [number, number, number];
}

/** White water thrown up where waves break on rocks: bursts of droplets on a ballistic arc. */
class Spray {
  readonly mesh: THREE.InstancedMesh | null = null;
  private items: { x: number; z: number; ox: number; oz: number; up: number; out: number; delay: number; size: number; period: number; phase: number }[] = [];

  constructor(group: THREE.Group, mat: THREE.Material, sources: SplashSource[], detail: SceneryDetail, rng: Rng) {
    for (const s of sources) {
      const period = rng.range(3.4, 5.4);
      const phase = rng.range(0, period);
      const n = perDetail(detail, s.counts);
      for (let j = 0; j < s.counts[2]; j++) {
        // Only the face toward the camera (+z) is worth splashing.
        const a = rng.range(0.12, 0.88) * Math.PI;
        const item = {
          x: s.x + Math.cos(a) * s.r,
          z: s.z + Math.sin(a) * s.r,
          ox: Math.cos(a),
          oz: Math.sin(a),
          up: rng.range(5, 9),
          out: rng.range(0.8, 2.4),
          delay: rng.range(0, 0.35),
          size: rng.range(0.45, 0.85),
          period,
          phase,
        };
        if (j < n) this.items.push(item);
      }
    }
    if (!this.items.length) return;
    this.mesh = instanced(new THREE.IcosahedronGeometry(1, 0), mat, this.items.length);
    group.add(this.mesh);
  }

  update(time: number) {
    if (!this.mesh) return;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const u = ((time + it.phase) % it.period) - it.delay;
      const life = it.up / 4.9;
      if (u < 0 || u > life) {
        this.mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      const r = it.size * (1 - (0.6 * u) / life);
      _p.set(it.x + it.ox * it.out * u, 0.3 + it.up * u - 4.9 * u * u, it.z + it.oz * it.out * u);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q.setFromEuler(_e.set(u * 3, i, 0, 'XYZ')), _s.set(r, r, r)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- Birds ---------------------------------------------------------------

interface Orbit {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Depth of the loop relative to its width. */
  squash: number;
  /** Radians per second; the sign sets the direction. */
  speed: number;
  phase: number;
  size: number;
}

/** A gull's or a crane's silhouette, heading +x with wings along z; scaling y flaps them. */
function birdGeometry(kind: 'gull' | 'crane') {
  const wing = (side: number, body: string, tip: string) => {
    // Root, raised elbow, swept-back tip: the gull's shallow "M".
    const z = (v: number) => v * side;
    const root = [0.18, 0, z(0.08), -0.2, 0, z(0.08)];
    const elbow = [0.08, 0.22, z(0.55), -0.22, 0.2, z(0.55)];
    const tipAt = [-0.3, 0.05, z(1.05)];
    const inner = [...root.slice(0, 3), ...root.slice(3), ...elbow.slice(3), ...root.slice(0, 3), ...elbow.slice(3), ...elbow.slice(0, 3)];
    const outer = [...elbow.slice(0, 3), ...elbow.slice(3), ...tipAt];
    return [
      [inner, body],
      [outer, tip],
    ] as [number[], string][];
  };
  const white = '#f4f5f2';
  const runs: [number[], THREE.ColorRepresentation][] = [...wing(1, white, kind === 'gull' ? '#3b3f45' : '#202326'), ...wing(-1, white, kind === 'gull' ? '#3b3f45' : '#202326')];
  // Body: a thin diamond from beak to tail.
  const nose = kind === 'gull' ? 0.55 : 0.4;
  const tail = -0.5;
  const body = [nose, 0, 0, 0, 0.07, 0.09, 0, 0.07, -0.09, nose, 0, 0, 0, -0.09, -0.09, 0, -0.09, 0.09, tail, 0, 0, 0, 0.07, -0.09, 0, 0.07, 0.09, tail, 0, 0, 0, -0.09, 0.09, 0, -0.09, -0.09];
  runs.push([body, white]);
  if (kind === 'crane') {
    // A long black neck ahead with a red cap, and legs trailing behind.
    runs.push([[0.4, 0.03, 0.04, 1.25, 0.06, 0, 0.4, 0.03, -0.04, 0.4, -0.03, 0, 1.25, 0.06, 0, 0.4, 0.03, 0.04], '#1d1f22']);
    runs.push([[1.25, 0.06, 0, 1.45, 0.04, 0, 1.3, 0.12, 0], '#c8382c']);
    runs.push([[-0.45, 0, 0.03, -1.35, -0.06, 0, -0.45, 0, -0.03], '#3a3530']);
  }
  return triangles(runs);
}

/** Birds wheeling on fixed loops, one draw call per flock. */
class Flock {
  readonly mesh: THREE.InstancedMesh | null = null;

  constructor(group: THREE.Group, kind: 'gull' | 'crane', private orbits: Orbit[]) {
    if (!orbits.length) return;
    // Unlit: seen from below a lit bird is only its dark underside. Birds roost at night.
    this.mesh = instanced(birdGeometry(kind), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }), orbits.length);
    group.add(this.mesh);
  }

  update(time: number, night: boolean) {
    if (!this.mesh) return;
    this.mesh.visible = !night;
    if (night) return;
    for (let i = 0; i < this.orbits.length; i++) {
      const o = this.orbits[i];
      const th = o.phase + o.speed * time;
      const vx = -Math.sin(th) * o.speed;
      const vz = Math.cos(th) * o.squash * o.speed;
      // Glide for a while, then flap.
      const glide = 0.5 + 0.5 * Math.sin(time * 0.45 + o.phase * 3);
      const flap = Math.sin(time * 7 + o.phase * 11) * (1 - THREE.MathUtils.smoothstep(glide, 0.45, 0.75));
      // Bank into the turn: local +z points inward when circling with positive speed.
      _q.setFromEuler(_e.set(0.28 * Math.sign(o.speed), Math.atan2(-vz, vx), 0, 'YXZ'));
      _p.set(o.x + o.r * Math.cos(th), o.y + Math.sin(th * 2 + o.phase) * 0.8, o.z + o.r * o.squash * Math.sin(th));
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s.set(o.size, o.size * (0.35 + 0.9 * flap), o.size)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Smoke is seen from below, where only dim ground light reaches, so it glows a
 * little to stay pale. At night it turns whiter and thicker, as if lit from below.
 */
function smokeMaterial(day: string) {
  const mat = new THREE.MeshStandardMaterial({ color: day, flatShading: true, roughness: 1, transparent: true, depthWrite: false });
  let was: boolean | null = null;
  return {
    mat,
    setNight(night: boolean) {
      if (night === was) return;
      was = night;
      mat.color.set(night ? '#eef3f8' : day);
      mat.emissive.set(night ? '#b4c2d6' : day);
      mat.emissiveIntensity = night ? 0.5 : 0.45;
      mat.opacity = night ? 0.8 : 0.55;
    },
  };
}

// ---- Fjord (Norway / Iceland) -------------------------------------------

function buildFjord(map: MapDef, detail: SceneryDetail): Scenery {
  const rng = new Rng(0xf10d);
  const batch = new Batch();
  const group = new THREE.Group();

  const painted = flatMat('#ffffff', { vertexColors: true });
  const put = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, o?: Placement) =>
    batch.add(solid(geo, color), painted, x, y, z, o);
  const rock = shades(['#4d5d6b', '#3f4d59', '#5a6a77']);
  const snow = shades(['#f4fbff', '#dcecf5']);
  const peak = (x: number, z: number, r: number, h: number) => {
    const snowline = rng.range(0.42, 0.58);
    const geo = jitter(new THREE.ConeGeometry(r, h, 7, 4), rng, r * 0.09);
    paintFaces(geo, (t) => (t > snowline + rng.range(-0.1, 0.1) ? rng.pick(snow) : rng.pick(rock)));
    batch.add(geo, painted, x, h / 2 - 2, z, { ry: rng.range(0, 6) });
  };
  // Far range, then a nearer range that leaves the middle open like a channel.
  for (let x = -220; x <= 220; x += 55) peak(x + rng.range(-12, 12), rng.range(-130, -108), rng.range(30, 44), rng.range(48, 74));
  for (const x of [-168, -112, -60, 60, 112, 168]) {
    peak(x + rng.range(-8, 8), rng.range(-96, -82), rng.range(18, 28), rng.range(26, 42));
  }

  // Wooded shore at the foot of the near range.
  const pine = ['#1f4d3a', '#2a6048'];
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? 1 : -1;
    const mx = side * rng.range(34, 180);
    const mz = rng.range(-76, -62);
    const mr = rng.range(7, 13);
    put(jitter(new THREE.IcosahedronGeometry(mr, 0), rng, mr * 0.15), '#565c58', mx, -0.8, mz, { sy: 0.3 });
    for (let t = 0; t < 4; t++) {
      const h = rng.range(3.2, 5.6);
      const x = mx + rng.range(-0.6, 0.6) * mr;
      const z = mz + rng.range(-0.4, 0.4) * mr;
      const y = -0.8 + mr * 0.2;
      const color = rng.pick(pine);
      put(new THREE.ConeGeometry(h * 0.34, h * 0.7, 6), color, x, y + h * 0.35, z);
      put(new THREE.ConeGeometry(h * 0.24, h * 0.55, 6), color, x, y + h * 0.72, z);
    }
  }

  // Two fishing cabins and a pier on an islet off to the left.
  put(jitter(new THREE.IcosahedronGeometry(8, 0), rng, 1), '#4f5a60', -34, -0.4, -47, { sy: 0.2 });
  const [roof, trim, wood] = ['#2b3138', '#f1eee6', '#7a5a3c'];
  const cabin = (x: number, z: number, w: number, h: number, d: number, color: string) => {
    put(new THREE.BoxGeometry(w, h, d), color, x, 1.2 + h / 2, z);
    put(pyramid(w + 1, h * 0.7, d + 1), roof, x, 1.2 + h, z);
    put(new THREE.BoxGeometry(0.9, 1.7, 0.1), trim, x - w * 0.25, 1.2 + 0.85, z + d / 2 + 0.05);
  };
  cabin(-37, -46, 5, 3, 4, '#b5392f');
  cabin(-28.5, -49, 3.6, 2.4, 3, '#d9a441');
  put(new THREE.BoxGeometry(8, 0.25, 1.3), wood, -31, 0.75, -42.6);
  for (const px of [-34.5, -31, -27.5]) put(new THREE.CylinderGeometry(0.14, 0.14, 1.6, 5), wood, px, 0, -42.1);

  const ice = flatMat('#e9f7fb', { roughness: 0.5 });
  for (let i = 0; i < 9; i++) {
    const r = rng.range(1.6, 3.6);
    const x = (i % 2 ? 1 : -1) * rng.range(12, 90);
    batch.add(jitter(new THREE.IcosahedronGeometry(r, 0), rng, r * 0.18), ice, x, 0.1, rng.range(-55, -10), { sy: 0.12 });
  }

  const windows = lampMat();
  const panes = [
    [-35.8, 3.1, -43.95],
    [-28, 2.7, -47.45],
  ] as const;
  for (const [x, y, z] of panes) batch.add(new THREE.BoxGeometry(1, 0.9, 0.1), windows, x, y, z);

  // Chimneys on the front slope of each roof, where the camera can see them: [x, z, bottom, top, width].
  const chimneys = [
    [-35.6, -45.7, 4.6, 6.7, 0.7],
    [-29.4, -48.8, 4.1, 5.75, 0.55],
  ] as const;
  for (const [x, z, y0, y1, w] of chimneys) {
    put(new THREE.BoxGeometry(w, y1 - y0, w), '#6b625a', x, (y0 + y1) / 2, z);
    put(new THREE.BoxGeometry(w + 0.2, 0.16, w + 0.2), '#3f3a36', x, y1, z);
  }

  // A rowboat tied up at the pier: half a cylinder, pinched into a bow and a stern.
  const hull = new THREE.CylinderGeometry(0.62, 0.62, 3.4, 8, 1, false, 0, Math.PI);
  hull.rotateZ(-Math.PI / 2);
  const hp = hull.attributes.position;
  for (let i = 0; i < hp.count; i++) {
    const t = Math.abs(hp.getX(i)) / 1.7;
    hp.setZ(i, hp.getZ(i) * (1 - 0.7 * t * t));
  }
  const [bx, by, bz] = [-29.6, 0.32, -40.5];
  put(hull, '#3f6a85', bx, by, bz, { sy: 0.75, ry: 0.1 });
  put(new THREE.BoxGeometry(2.7, 0.06, 0.62), '#8a6a48', bx, by - 0.12, bz, { ry: 0.1 });
  for (const dx of [-0.6, 0.55]) put(new THREE.BoxGeometry(0.24, 0.07, 0.95), '#8a6a48', bx + dx, by - 0.02, bz - dx * 0.1);
  put(new THREE.BoxGeometry(2.6, 0.05, 0.08), wood, bx + 0.1, by + 0.04, bz, { ry: 0.45 });
  // A lamp post at the end of the pier.
  put(new THREE.CylinderGeometry(0.07, 0.09, 2.4, 5), wood, -27.2, 2.07, -42.6);
  put(new THREE.BoxGeometry(0.42, 0.06, 0.42), roof, -27.2, 3.62, -42.6);

  // A waterfall down a bluff on the right shore, with a foam pool at its foot.
  const fall = stream(0xf10d, 1);
  // A tapered six-sided butte, turned so one face looks at the camera; the water runs down that face.
  const bluff = jitter(new THREE.CylinderGeometry(5.5, 8, 22, 6, 3).rotateY(Math.PI / 6), fall, 0.5);
  paintFaces(bluff, (t) => (t > 0.88 ? snow[0] : fall.pick(rock)));
  batch.add(bluff, painted, 47, 9, -79);
  const sheet = new THREE.PlaneGeometry(1.7, 19.6, 1, 6);
  const sp = sheet.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const v = (sp.getY(i) + 9.8) / 19.6; // 0 at the foot, 1 at the lip
    sp.setX(i, sp.getX(i) * (1.5 - 0.5 * v) + Math.sin(v * 9) * 0.15);
    sp.setZ(i, -2.2 * v); // follows the face as it leans back
  }
  const water = shades(['#ffffff', '#e6f5fa', '#cbe7f1']);
  batch.add(paintFaces(sheet.toNonIndexed(), (t) => water[Math.min(2, Math.floor(t * 3))]), painted, 47, 9.6, -71.5);
  sheet.dispose();
  put(jitter(new THREE.IcosahedronGeometry(2.6, 0), fall, 0.3), '#f4fbff', 47, 0, -71.2, { sy: 0.14 });
  group.add(batch.build());

  // Lamps: the mooring buoy's and the pier's, plus a glow for each cabin window.
  const lampGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  const lights = new Lights(
    group,
    lampGeo,
    [
      { color: '#ffd25a', glass: '#8a7a4a', period: 4, flash: 0.7, halo: 1.7 },
      { color: '#ffc46b', glass: '#6b5a3a', flicker: 0.15, halo: 1.3 },
      { color: '#ffd58a', glass: '#000000', halo: 1.7 },
      { color: '#ffd58a', glass: '#000000', halo: 1.4 },
    ],
    detail,
  );
  lights.placeAt(1, -27.2, 3.4, -42.6, 0.34, 0.42);
  panes.forEach(([x, y, z], i) => lights.placeAt(2 + i, x, y, z, 0));

  // One mooring buoy and a few small net floats; keep open water around the boat.
  const buoyGeo = compound([
    [new THREE.IcosahedronGeometry(0.75, 1), '#ffffff', 0, 0.15, 0],
    [new THREE.CylinderGeometry(0.79, 0.79, 0.16, 10), '#2b3138', 0, 0.12, 0],
    [new THREE.CylinderGeometry(0.1, 0.16, 0.6, 6), '#3a3f45', 0, 1.0, 0],
  ]);
  const floats: FloatSpec[] = [{ x: -16, z: -22, size: 0.8, tint: '#e8582f', sink: 0.2, lamp: { index: 0, y: 1.42, size: 0.3, tall: 1.3 } }];
  for (let i = 0; i < perDetail(detail, [0, 1, 2] as const); i++) {
    floats.push({ x: 7 + i * 2.3, z: -11 - i * 1.5 - Math.sin(i * 0.9) * 0.6, size: 0.38, tint: i % 2 ? '#f4f1e8' : '#f39a2b', sink: 0.04, lean: 1.5 });
  }
  const buoys = new Floats(group, buoyGeo, painted, floats, map.waves, stream(0xf10d, 2), lights);

  // Small ice floes adrift near the boat (medium and up).
  const floeRng = stream(0xf10d, 3);
  const floeSpecs: FloatSpec[] = [-7.5, -21, -25.5, -31, -36, -41, -47, -53, -59].map((z) => ({
    x: floeRng.range(-45, 45),
    z,
    size: floeRng.range(1.1, 2.2),
    stretch: [1, 0.22, floeRng.range(0.6, 0.95)] as const,
    tint: '#ffffff',
    wander: floeRng.range(4, 9),
    pace: floeRng.range(0.02, 0.05),
    lean: 0.6,
    sink: 0.08,
  }));
  const floeCount = perDetail(detail, [0, 5, 9] as const);
  const floes = floeCount
    ? new Floats(group, jitter(new THREE.IcosahedronGeometry(1, 0), floeRng, 0.18), ice, floeSpecs.slice(0, floeCount), map.waves, floeRng)
    : null;

  // Chimney smoke drifting downwind; on high, spray rising off the waterfall too.
  const smokeLook = smokeMaterial('#cfd5da');
  const smoke = new Puffs(
    group,
    smokeLook.mat,
    [
      { x: -35.6, y: 6.9, z: -45.7, counts: [6, 9, 16], life: 7, rise: 8.5, drift: [10, 1.5], size: [0.5, 1.8], spread: 0.2 },
      { x: -29.4, y: 5.9, z: -48.8, counts: [0, 7, 12], life: 6.5, rise: 7, drift: [8.5, 1.2], size: [0.42, 1.5], spread: 0.2 },
      { x: 47, y: 0.8, z: -70.5, counts: [0, 0, 10], life: 4.5, rise: 5.5, drift: [3, 1.5], size: [0.5, 1.5], spread: 3.2 },
    ],
    detail,
    stream(0xf10d, 4),
  );

  // Aurora: ribbons that are bright along the bottom edge and fade upward.
  const ribbons: { mesh: THREE.Mesh; base: Float32Array; phase: number }[] = [];
  const tints = ['#4dffb0', '#58e6ff', '#9dff7a'];
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.PlaneGeometry(300, 22, 48, 1);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const tint = new THREE.Color(tints[i]);
    for (let v = 0; v < pos.count; v++) if (pos.getY(v) < 0) tint.toArray(colors, v * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(rng.range(-30, 30), 44 + i * 9, -150 - i * 6);
    mesh.visible = false;
    ribbons.push({ mesh, base: (pos.array as Float32Array).slice(), phase: rng.range(0, 6) });
    group.add(mesh);
  }

  return {
    group,
    update(time, night, _dt, env) {
      const shine = night && (env?.lightingEffects ?? true);
      windows.emissiveIntensity = shine ? 1.8 : 0;
      buoys.update(time, env);
      floes?.update(time, env);
      lights.update(time, night, shine);
      smokeLook.setNight(night);
      smoke.swell = night ? 1.2 : 1;
      smoke.update(time);
      const auroraVisibility = shine ? 1 - (env?.weather?.cloud ?? 0) : 0;
      for (const r of ribbons) {
        r.mesh.visible = auroraVisibility > 0.01;
        if (!r.mesh.visible) continue;
        (r.mesh.material as THREE.MeshBasicMaterial).opacity = (0.42 + Math.sin(time * 0.35 + r.phase) * 0.14) * auroraVisibility;
        const pos = r.mesh.geometry.attributes.position;
        for (let v = 0; v < pos.count; v++) {
          const x = r.base[v * 3];
          pos.setY(v, r.base[v * 3 + 1] + Math.sin(x * 0.03 + time * 0.22 + r.phase) * 5);
          pos.setZ(v, Math.sin(x * 0.018 + time * 0.3 + r.phase) * 12);
        }
        pos.needsUpdate = true;
      }
    },
  };
}

// ---- Heaven Lake (Zhangjiajie / Changbai) -------------------------------

function buildTianchi(map: MapDef, detail: SceneryDetail): Scenery {
  const rng = new Rng(0x71a2c1);
  const batch = new Batch();
  const group = new THREE.Group();

  const painted = flatMat('#ffffff', { vertexColors: true });
  const put = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, o?: Placement) =>
    batch.add(solid(geo, color), painted, x, y, z, o);
  const stone = shades(['#8a8672', '#77735f', '#9a957f', '#6c6855']);
  const moss = shades(['#3f6b3a', '#2f5a35']);
  const bush = ['#3f6b3a', '#2f5a35'];

  // Sandstone pillars: tall, slightly tapered, green on top.
  const pillars: { x: number; z: number; top: number; bottom: number; crown: number }[] = [];
  const pillar = (x: number, z: number, top: number, h: number) => {
    const bottom = top * rng.range(1.5, 1.9);
    const geo = jitter(new THREE.CylinderGeometry(top, bottom, h, 7, 5), rng, top * 0.22);
    paintFaces(geo, (t) => (t > 0.9 || (t > 0.3 && rng.next() < 0.07) ? rng.pick(moss) : rng.pick(stone)));
    batch.add(geo, painted, x, h / 2 - 3, z, { ry: rng.range(0, 6) });
    const crown = h - 3;
    put(jitter(new THREE.IcosahedronGeometry(top * 1.2, 0), rng, top * 0.2), rng.pick(bush), x, crown, z, { sy: 0.5 });
    for (let t = 0; t < rng.int(1, 3); t++) {
      const th = rng.range(3, 5.5);
      put(new THREE.ConeGeometry(th * 0.3, th, 6), rng.pick(bush), x + rng.range(-0.5, 0.5) * top, crown + th / 2, z + rng.range(-0.5, 0.5) * top);
    }
    pillars.push({ x, z, top, bottom, crown });
  };
  for (let i = 0; i < 16; i++) {
    pillar(-200 + i * 26.5 + rng.range(-9, 9), rng.range(-125, -75), rng.range(3, 6.5), rng.range(34, 78));
  }
  // A few close ones on each side frame the lake.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) pillar(side * rng.range(78, 125), rng.range(-62, -42), rng.range(3.5, 5.5), rng.range(42, 64));
  }

  // The crater rim behind everything, with a dusting of snow.
  const rim = shades(['#55655e', '#4a5952', '#60706a']);
  const frost = new THREE.Color('#e4efec');
  for (let x = -240; x <= 240; x += 60) {
    const r = rng.range(46, 64);
    const h = rng.range(20, 30);
    const geo = jitter(new THREE.ConeGeometry(r, h, 6, 2), rng, r * 0.06);
    paintFaces(geo, (t) => (t > 0.72 && rng.next() < 0.6 ? frost : rng.pick(rim)));
    batch.add(geo, painted, x + rng.range(-10, 10), h / 2 - 2, -140);
  }

  // A lakeside pavilion on a rock.
  put(jitter(new THREE.IcosahedronGeometry(7, 0), rng, 0.9), '#5b5a4c', 34, -0.3, -50, { sy: 0.24 });
  put(new THREE.CylinderGeometry(3.5, 3.9, 0.6, 6), '#b9b3a1', 34, 1.7, -50);
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    put(new THREE.CylinderGeometry(0.17, 0.17, 2.6, 5), '#a8352a', 34 + dx, 3.3, -50 + dz);
  }
  put(pyramid(6.6, 1.5, 6.6), '#2f4f48', 34, 4.6, -50);
  put(pyramid(2.2, 1.3, 2.2), '#c9a14a', 34, 5.9, -50);

  // A bronze censer on the terrace in front of the pavilion.
  put(new THREE.BoxGeometry(0.9, 0.3, 0.9), '#8f8a7a', 34, 2.15, -47.2);
  put(new THREE.CylinderGeometry(0.5, 0.36, 0.55, 8), '#7a5a2a', 34, 2.58, -47.2);
  put(new THREE.CylinderGeometry(0.56, 0.56, 0.08, 8), '#a07a38', 34, 2.86, -47.2);

  // Pines growing out of the pillar walls and leaning out over the drop. They sit on the
  // side facing the boat, low enough to be seen from the surface.
  const pines = stream(0x71a2c1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  for (const p of pillars) {
    const grow = pines.next() < 0.55;
    const k = THREE.MathUtils.clamp(p.top / 4.5, 0.8, 1.3);
    const y = pines.range(9, Math.max(10, Math.min(p.crown - 8, 28)));
    const around = pines.range(-0.7, 0.7);
    const lean = pines.range(0.55, 0.95);
    const pads = [0, 1, 2].map(() => [pines.range(1.1, 1.6) * k, pines.range(-0.5, 0.5) * k, pines.next()] as const);
    if (!grow) continue;
    // The wall's radius at this height: the pillar tapers from `bottom` at y = -3 to `top` at the crown.
    const r = p.bottom + (p.top - p.bottom) * ((y + 3) / (p.crown + 3)) - 0.4;
    const [ox, oz] = [Math.sin(around), Math.cos(around)];
    const dir = new THREE.Vector3(ox * Math.sin(lean), Math.cos(lean), oz * Math.sin(lean));
    const tilt = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    const len = 2.6 * k;
    const [bx, bz] = [p.x + ox * r, p.z + oz * r];
    put(new THREE.CylinderGeometry(0.14 * k, 0.26 * k, len, 5), '#5a4632', bx + (dir.x * len) / 2, y + (dir.y * len) / 2, bz + (dir.z * len) / 2, { rx: tilt.x, ry: tilt.y, rz: tilt.z });
    // Flat layered canopy pads, stepping down and out from the tip.
    pads.forEach(([pr, side, shade], j) => {
      const out = len * (0.75 + j * 0.25);
      put(
        jitter(new THREE.CylinderGeometry(pr, pr * 1.15, 0.45 * k, 7), pines, 0.1 * k),
        shade < 0.5 ? bush[0] : bush[1],
        bx + ox * out - oz * side,
        y + dir.y * len - j * 0.6 * k,
        bz + oz * out + ox * side,
      );
    });
  }

  // A patch of lotus near the boat: leaves held above the water on stalks, a few pink flowers.
  const lotus = stream(0x71a2c1, 2);
  const leafGreens = ['#6aa84f', '#5b9a45', '#78b35a'];
  for (let i = 0; i < 12; i++) {
    const x = lotus.range(-31, -17);
    const z = lotus.range(-27, -20);
    const h = lotus.range(0.3, 1.2);
    const r = lotus.range(0.65, 1.1);
    put(new THREE.CylinderGeometry(0.04, 0.05, h + 0.6, 4), '#557a3a', x, (h - 0.6) / 2, z);
    const leaf = new THREE.ConeGeometry(r, r * 0.3, 8);
    leaf.rotateX(Math.PI);
    put(leaf, lotus.pick(leafGreens), x, h + r * 0.15, z, { rx: lotus.range(-0.35, 0.35), rz: lotus.range(-0.35, 0.35) });
    if (i % 3 === 0) {
      const fx = x + lotus.range(-0.8, 0.8);
      const fh = h + lotus.range(0.4, 0.8);
      put(new THREE.CylinderGeometry(0.03, 0.04, fh + 0.6, 4), '#557a3a', fx, (fh - 0.6) / 2, z + 0.3);
      put(new THREE.ConeGeometry(0.34, 0.3, 6), '#f7c6d6', fx, fh + 0.1, z + 0.3);
      put(new THREE.ConeGeometry(0.22, 0.42, 5), '#ef8fb1', fx, fh + 0.3, z + 0.3);
    }
  }
  group.add(batch.build());

  const lantern = lampMat('#ffb86b');
  const lamp = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), lantern);
  lamp.position.set(34, 3.9, -50);
  group.add(lamp);

  // Mist banks drifting over the water. Thicker at night. One draw call for all of them.
  const mistMat = new THREE.MeshBasicMaterial({ color: '#f2f7f4', transparent: true, opacity: 0.18, depthWrite: false });
  const mist: { x: number; y: number; z: number; r: number; speed: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const r = rng.range(16, 30);
    mist.push({ r, x: rng.range(-180, 180), y: rng.range(1.5, 7), z: rng.range(-95, -38), speed: rng.range(0.6, 1.6) * (i % 2 ? 1 : -1) });
  }
  const mistMesh = instanced(new THREE.IcosahedronGeometry(1, 1), mistMat, mist.length);
  group.add(mistMesh);

  // Lamps: paper lanterns floating on the lake, sky lanterns rising at night, the pavilion's glow.
  const lanternGeo = shadeByHeight(new THREE.CylinderGeometry(0.55, 0.42, 1, 4).rotateY(Math.PI / 4), 1, 0.62);
  const sky = stream(0x71a2c1, 3);
  const skyAll = Array.from({ length: 20 }, () => ({
    x: sky.range(-120, 120),
    z: sky.range(-115, -65),
    life: sky.range(80, 120),
    phase: sky.next(),
    sway: sky.range(1, 3),
  }));
  const skyLanterns = skyAll.slice(0, perDetail(detail, [0, 8, 20] as const));
  const floatRng = stream(0x71a2c1, 4);
  const lanes = [-9, -12.5, -16, -31, -35, -39, -43];
  const rafts: FloatSpec[] = lanes.map((z, i) => ({
    x: floatRng.range(-24, 24),
    z,
    size: 1.3,
    tint: '#ffffff',
    wander: floatRng.range(3, 7),
    pace: floatRng.range(0.03, 0.06),
    lean: 1.5,
    sink: 0.02,
    lamp: { index: i, y: 0.48, size: 0.62, tall: 0.75 },
  }));
  const raftCount = perDetail(detail, [3, 5, 7] as const);
  const specs: LightSpec[] = [];
  for (let i = 0; i < raftCount; i++) specs.push({ color: '#ffbf6e', glass: i % 2 ? '#c95a45' : '#efe2c4', flicker: 0.25, phase: i * 1.7, halo: 1.5 });
  const skyBase = specs.length;
  for (const s of skyLanterns) specs.push({ color: '#ffa04a', glass: '#000000', flicker: 0.3, phase: s.phase * 9, halo: 1.9 });
  const pavilionGlow = specs.length;
  specs.push({ color: '#ffb86b', glass: '#000000', halo: 3.2 });
  const lights = new Lights(group, lanternGeo, specs, detail);
  lights.placeAt(pavilionGlow, 34, 3.9, -50, 0);
  const raftGeo = compound([
    [new THREE.BoxGeometry(1, 0.16, 1), '#5a4030', 0, 0, 0],
    [new THREE.BoxGeometry(0.8, 0.06, 0.8), '#7a5a3c', 0, 0.1, 0],
  ]);
  const floats = new Floats(group, raftGeo, painted, rafts.slice(0, raftCount), map.waves, floatRng, lights);

  // Incense smoke curling up from the censer.
  const smokeLook = smokeMaterial('#c9d2d8');
  const smoke = new Puffs(
    group,
    smokeLook.mat,
    [{ x: 34, y: 3, z: -47.2, counts: [6, 14, 30], life: 8, rise: 6.5, drift: [-2.2, 0.6], size: [0.12, 0.75], spread: 0.1 }],
    detail,
    stream(0x71a2c1, 5),
  );

  // Red-crowned cranes wheeling around a pillar in view (medium and up).
  const craneRng = stream(0x71a2c1, 6);
  const home = pillars.slice(0, 16).reduce((a, b) => (Math.abs(b.x + 28) < Math.abs(a.x + 28) ? b : a));
  const craneOrbits: Orbit[] = Array.from({ length: 5 }, () => ({
    x: home.x,
    y: Math.min(home.crown - 4, 26) + craneRng.range(-3, 3),
    z: home.z + 5,
    r: craneRng.range(8, 13),
    squash: 0.55,
    speed: craneRng.range(0.22, 0.3),
    phase: craneRng.range(0, Math.PI * 2),
    size: craneRng.range(1.5, 1.8),
  }));
  const cranes = new Flock(group, 'crane', craneOrbits.slice(0, perDetail(detail, [0, 3, 5] as const)));

  return {
    group,
    update(time, night, dt, env) {
      const shine = night && (env?.lightingEffects ?? true);
      lantern.emissiveIntensity = shine ? 2 : 0;
      mistMat.opacity = night ? 0.3 : 0.18;
      for (let i = 0; i < mist.length; i++) {
        const m = mist[i];
        m.x += m.speed * dt;
        if (m.x > 210) m.x = -210;
        if (m.x < -210) m.x = 210;
        mistMesh.setMatrixAt(i, _m.compose(_p.set(m.x, m.y, m.z), _q.identity(), _s.set(m.r, m.r * 0.1, m.r * 0.45)));
      }
      mistMesh.instanceMatrix.needsUpdate = true;
      floats.update(time, env);
      for (let k = 0; k < skyLanterns.length; k++) {
        // Released from the far shore, they rise and drift until they wink out above the view.
        const s = skyLanterns[k];
        const age = fract(time / s.life + s.phase);
        const size = shine ? 1.5 * Math.min(1, age * 30) * Math.min(1, (1 - age) * 12) : 0;
        lights.placeAt(skyBase + k, s.x + Math.sin(time * 0.15 + s.phase * 6) * s.sway + age * 14, 1 + age * 70, s.z - age * 10, size, size * 1.2);
      }
      lights.update(time, night, shine);
      smokeLook.setNight(night);
      smoke.update(time);
      cranes.update(time, night);
    },
  };
}

// ---- Open Ocean ---------------------------------------------------------

function buildOcean(map: MapDef, detail: SceneryDetail): Scenery {
  const rng = new Rng(0x0cea17);
  const batch = new Batch();
  const group = new THREE.Group();

  const painted = flatMat('#ffffff', { vertexColors: true });
  const put = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, o?: Placement) =>
    batch.add(solid(geo, color), painted, x, y, z, o);

  // The sky's clouds are shared by every map (see sky.ts); this map adds only sheet lightning.
  const stack = '#3f4a55';
  const stacks: [number, number, number][] = [];
  for (const [x, z] of [[-118, -92], [-64, -98], [38, -106], [128, -88]]) {
    const r = rng.range(4, 7);
    const h = rng.range(9, 20);
    put(jitter(new THREE.ConeGeometry(r, h, 6, 3), rng, r * 0.2), stack, x, h / 2 - 2, z);
    stacks.push([x, z, r]);
  }

  // Lighthouse on a rock to the right.
  const [lx, lz] = [64, -88];
  put(jitter(new THREE.IcosahedronGeometry(9, 0), rng, 1.2), stack, lx, 0.5, lz, { sy: 0.5 });
  const [red, white] = ['#c0392b', '#f1eee6'];
  put(new THREE.CylinderGeometry(1.5, 2.3, 13, 8), white, lx, 10.5, lz);
  put(new THREE.CylinderGeometry(1.95, 2.08, 2.4, 8), red, lx, 9, lz);
  put(new THREE.CylinderGeometry(2.4, 2.4, 0.3, 8), '#2b3138', lx, 17.15, lz);
  put(new THREE.ConeGeometry(1.7, 1.4, 6), red, lx, 19.75, lz);

  // Surf: a ragged ring of foam where the swell meets each rock. The waves bury and uncover it.
  const foam = stream(0x0cea17, 1);
  for (const [x, z, r] of [...stacks, [lx, lz, 9.6] as [number, number, number]]) {
    const ring = new THREE.RingGeometry(r * 0.95, r * 0.95 + foam.range(1.1, 1.8), 12, 1);
    ring.rotateX(-Math.PI / 2);
    put(jitter(ring, foam, 0.3), '#eef6f8', x, 0.22, z);
  }

  // A freighter far out on the horizon.
  const [sx, sz] = [-24, -140];
  const hullShape = new THREE.Shape([new THREE.Vector2(-12, -1.2), new THREE.Vector2(11, -1.2), new THREE.Vector2(14, 2.2), new THREE.Vector2(-12.4, 2)]);
  const shipHull = new THREE.ExtrudeGeometry(hullShape, { depth: 4, bevelEnabled: false });
  shipHull.translate(0, 0, -2);
  put(shipHull, '#2f3944', sx, 0, sz);
  put(new THREE.BoxGeometry(24, 0.3, 4.1), red, sx - 0.3, -0.3, sz);
  put(new THREE.BoxGeometry(5, 3.6, 3.4), white, sx - 8, 3.8, sz);
  put(new THREE.BoxGeometry(6, 0.3, 4.2), white, sx - 7.8, 5.75, sz);
  put(new THREE.CylinderGeometry(0.75, 0.85, 2.4, 6), red, sx - 10, 7.1, sz);
  put(new THREE.CylinderGeometry(0.12, 0.15, 6.2, 5), stack, sx + 9, 5, sz);
  for (const hx of [-2, 2.5, 7]) put(new THREE.BoxGeometry(3.2, 0.8, 3.2), '#4c5a66', sx + hx, 2.4, sz);
  group.add(batch.build());

  const beacon = lampMat('#ffe9a8');
  const lampRoom = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1.75, 6), beacon);
  lampRoom.position.set(lx, 18.2, lz);
  group.add(lampRoom);

  // The lamp turns at 0.8 rad/s with two opposite beams, so it flashes at the viewer every ~4 s.
  const sweep = (t: number) => Math.pow(Math.abs(Math.sin(t * 0.8)), 6);

  // Lamps: the channel markers', the freighter's, and the lighthouse's glow.
  const markerCount = perDetail(detail, [1, 2, 2] as const);
  const specs: LightSpec[] = [
    { color: '#ff4433', glass: '#7a2a22', period: 4, flash: 0.6, halo: 1.2 },
    { color: '#44ff77', glass: '#285f3c', period: 3, flash: 0.6, phase: 1.3, halo: 1.2 },
  ].slice(0, markerCount);
  const shipLights: [number, number, number, number, number, string][] = [
    // dx, y, dz, width, height, colour
    [-9.5, 4.6, 1.75, 0.6, 0.4, '#ffe2a0'],
    [-8, 4.6, 1.75, 0.6, 0.4, '#ffe2a0'],
    [-6.5, 4.6, 1.75, 0.6, 0.4, '#ffe2a0'],
    [9, 8.3, 0, 0.35, 0.35, '#ffffff'],
    [-5.3, 5.1, 2.05, 0.35, 0.35, '#45ff7a'],
  ];
  for (const [, , , , , color] of shipLights) specs.push({ color, glass: '#1d2730', halo: 2.4 });
  const lighthouseGlow = specs.length;
  specs.push({ color: '#ffe9a8', glass: '#000000', halo: 7, level: sweep });
  const lights = new Lights(group, new THREE.CylinderGeometry(0.5, 0.5, 1, 6), specs, detail);
  shipLights.forEach(([dx, y, dz, w, h], i) => lights.placeAt(markerCount + i, sx + dx, y, sz + dz, w, h));
  lights.placeAt(lighthouseGlow, lx, 18.2, lz + 1.2, 0);

  // Sparse distant channel markers leave the foreground and reflection path open.
  const markerGeo = compound([
    [new THREE.CylinderGeometry(0.8, 0.62, 0.9, 8), '#ffffff', 0, 0, 0],
    [new THREE.CylinderGeometry(0.3, 0.42, 1.7, 6), '#ffffff', 0, 1.25, 0],
    [new THREE.CylinderGeometry(0.5, 0.5, 0.08, 6), '#2b3138', 0, 2.12, 0],
  ]);
  const marker = (x: number, z: number, tint: string, index: number): FloatSpec => ({ x, z, size: 0.72, tint, lean: 0.9, sink: 0.22, lamp: { index, y: 2.36, size: 0.34 } });
  const markers = new Floats(
    group,
    markerGeo,
    painted,
    [marker(-23, -33, red, 0), marker(27, -38, '#2e8b57', 1)].slice(0, markerCount),
    map.waves,
    stream(0x0cea17, 2),
    lights,
  );

  // Gulls wheeling around the lighthouse and over the water near the boat (medium and up).
  const gullRng = stream(0x0cea17, 3);
  const gullOrbits: Orbit[] = Array.from({ length: 8 }, (_, i) => {
    const near = i % 2 === 1;
    return {
      x: near ? -8 : lx,
      y: near ? gullRng.range(10, 14) : gullRng.range(23, 29),
      z: near ? -32 : lz,
      r: near ? gullRng.range(7, 11) : gullRng.range(9, 14),
      squash: near ? 0.5 : 0.7,
      speed: (gullRng.next() < 0.5 ? -1 : 1) * gullRng.range(0.35, 0.5),
      phase: gullRng.range(0, Math.PI * 2),
      size: gullRng.range(1.2, 1.5),
    };
  });
  const gulls = new Flock(group, 'gull', gullOrbits.slice(0, perDetail(detail, [0, 4, 8] as const)));

  // Spray thrown up where the swell breaks on the rocks (medium and up).
  const [farLeft, nearStack, midStack, farRight] = stacks;
  const spray = new Spray(
    group,
    flatMat('#ffffff', { emissive: '#ffffff', emissiveIntensity: 0.3 }),
    [
      { x: lx, z: lz, r: 9.2, counts: [0, 6, 10] },
      { x: nearStack[0], z: nearStack[1], r: nearStack[2], counts: [0, 4, 7] },
      { x: midStack[0], z: midStack[1], r: midStack[2], counts: [0, 4, 7] },
      { x: farLeft[0], z: farLeft[1], r: farLeft[2], counts: [0, 0, 6] },
      { x: farRight[0], z: farRight[1], r: farRight[2], counts: [0, 0, 6] },
    ],
    detail,
    stream(0x0cea17, 4),
  );

  // On high, the lamp's two beams sweep the night: additive cones, brightest at the lamp.
  let beam: THREE.Object3D | null = null;
  // Rotation at which a beam points from the lighthouse at the camera (x = 0, z = 22).
  const facing = Math.atan2(-(22 - lz), 0 - lx);
  if (detail >= 3) {
    // Apex at the lamp, opening along +x (side 1) or -x (side -1), dipping slightly toward the sea.
    const cone = (side: number) => {
      const g = new THREE.ConeGeometry(7, 70, 12, 4, true);
      g.translate(0, -35, 0);
      g.rotateZ(side > 0 ? Math.PI / 2 : -Math.PI / 2);
      return g.rotateZ(-0.05 * side);
    };
    const geo = mergeGeometries([cone(1), cone(-1)])!;
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const warm = new THREE.Color('#fff1c4');
    for (let i = 0; i < pos.count; i++) {
      const fade = Math.pow(1 - Math.min(1, Math.abs(pos.getX(i)) / 70), 1.6);
      _c.copy(warm).multiplyScalar(fade).toArray(col, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = additive();
    mat.opacity = 0.3;
    beam = new THREE.Mesh(geo, mat);
    beam.position.set(lx, 18.2, lz);
    beam.visible = false;
    group.add(beam);
  }

  // Atmospheric clouds are shared by every map. Keep occasional ocean sheet
  // lightning as a soft localized glow, without another polygon cloud layer.
  const flashCanvas = document.createElement('canvas');
  flashCanvas.width = flashCanvas.height = 64;
  const ctx = flashCanvas.getContext('2d')!;
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, 'rgba(215,230,255,1)');
  glow.addColorStop(0.35, 'rgba(190,215,255,0.45)');
  glow.addColorStop(1, 'rgba(170,205,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  const flashTexture = new THREE.CanvasTexture(flashCanvas);
  flashTexture.colorSpace = THREE.SRGBColorSpace;
  const flashMaterial = new THREE.MeshBasicMaterial({
    map: flashTexture, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false,
  });
  const flashSheet = new THREE.Mesh(new THREE.PlaneGeometry(170, 75), flashMaterial);
  flashSheet.position.set(-55, 38, -140);
  flashSheet.visible = false;
  group.add(flashSheet);

  let flash = 0;
  let lastSlot = -1;
  return {
    group,
    update(time, night, dt, env) {
      const lightingEffects = env?.lightingEffects ?? true;
      const shine = night && lightingEffects;
      // Sheet lightning: a rare deterministic strike that decays over a fraction of a second.
      const slot = Math.floor(time * 4);
      const roll = Math.abs(Math.sin(slot * 12.9898) * 43758.5453) % 1;
      if (dt > 0) flash = Math.max(flash * Math.exp(-8 * dt), slot !== lastSlot && roll > 0.965 ? 1 : 0);
      lastSlot = slot;
      const stormStrength = lightingEffects ? env?.weather?.storm ?? 1 : 0;
      flashMaterial.opacity = flash * stormStrength * 0.22;
      flashSheet.visible = flashMaterial.opacity > 0.005;
      // The lamp turns: bright when a beam sweeps past the viewer.
      beacon.emissiveIntensity = shine ? 0.6 + sweep(time) * 2.4 : 0;
      if (beam) {
        beam.visible = shine;
        // A beam faces the camera whenever |sin(0.8 t)| peaks, matching the lamp.
        beam.rotation.y = time * 0.8 - Math.PI / 2 + facing;
      }
      markers.update(time, env);
      lights.update(time, night, shine);
      gulls.update(time, night);
      spray.update(time);
    },
  };
}

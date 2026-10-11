import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Batch, flatMat, jitter, paintFaces, pyramid, type Placement } from './lowpoly';
import type { MapDef, MapId } from './maps';
import type { SceneryDetail } from './render-quality';
import type { WeatherState } from './weather';
import { Rng } from './rng';
import { AuroraCurtain, auroraActivity, auroraGlow } from './aurora';

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

/** 0 in clear air to 1 in steady rain: how far the mountains have flattened into silhouettes. */
const rainMist = { value: 0 };

function setRainMist(env?: SceneryEnv) {
  rainMist.value = THREE.MathUtils.smoothstep(env?.weather?.rain ?? 0, 0.12, 0.6);
}

/**
 * Vertex-coloured rock for peaks, pillars and sea stacks. In rain it loses its
 * facets and snow and becomes one flat tone of the haze, darker the nearer the
 * ridge stands: layered silhouettes instead of grey shapes dissolving in fog.
 *
 * `lowMist` is for a lake whose mist lies on the water: [from, to, share] thins
 * the haze with height, down to `share` of it at `to` metres and above, so
 * summits stand clear over feet that fade.
 */
function mountainMat(lowMist?: readonly [number, number, number]) {
  const mat = flatMat('#ffffff', { vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMist = rainMist;
    if (lowMist) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying float vRise;
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vRise = (modelMatrix * vec4(transformed, 1.0)).y;
        `);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uMist;
        ${lowMist ? 'varying float vRise;' : ''}
      `)
      .replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          ${lowMist ? `fogFactor *= mix(1.0, ${lowMist[2].toFixed(3)}, smoothstep(${lowMist[0].toFixed(1)}, ${lowMist[1].toFixed(1)}, vRise));` : ''}
          vec3 hazed = mix(gl_FragColor.rgb, fogColor, fogFactor);
          vec3 silhouette = fogColor * mix(0.66, 0.9, smoothstep(70.0, 190.0, vFogDepth));
          gl_FragColor.rgb = mix(hazed, silhouette, uMist);
        #endif
      `);
  };
  mat.customProgramCacheKey = () => `scenery-mountain-mist-v2:${lowMist?.join(',') ?? ''}`;
  return mat;
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

let glowMap: THREE.DataTexture | null = null;

/**
 * The glow around a lamp: a tight bright core inside a wide, faint skirt that
 * reaches nothing well before the rim, so it has no outline. The falloff is
 * stored as it should look on screen and drawn additively on a plain quad.
 */
function glowMat() {
  if (!glowMap) {
    const size = 128;
    const data = new Uint8Array(size * size * 4).fill(255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
        const v = (0.62 * Math.exp(-((r / 0.1) ** 2)) + 0.38 * Math.exp(-((r / 0.4) ** 2))) * (1 - THREE.MathUtils.smoothstep(r, 0.6, 1));
        data.fill(Math.round(255 * v), (y * size + x) * 4, (y * size + x) * 4 + 3);
      }
    }
    glowMap = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    glowMap.colorSpace = THREE.SRGBColorSpace;
    glowMap.magFilter = THREE.LinearFilter;
    glowMap.minFilter = THREE.LinearMipmapLinearFilter;
    glowMap.generateMipmaps = true;
    glowMap.needsUpdate = true;
  }
  return new THREE.MeshBasicMaterial({ map: glowMap, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
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

/**
 * Height of the water at (x, z). Mirrors the wave field in World.updateDecorations
 * (surface centred at z = -30): `t` is the world's wave clock, `waves` the map's swell times the weather's.
 */
function waterY(x: number, z: number, t: number, waves: number) {
  return (Math.sin(x * 0.15 + t * 1.3) * 0.35 + Math.cos((z + 30) * 0.2 + t * 0.9) * 0.25) * waves;
}

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
      const glows = (this.glows = instanced(new THREE.PlaneGeometry(2, 2), glowMat(), specs.length));
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
      glows.setColorAt(i, _c.copy(this.lit[i]).multiplyScalar(0.8 * f));
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
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i];
      const x = s.x + (s.wander ?? 0) * Math.sin(time * (s.pace ?? 0) + this.phase[i]);
      // Lean with the local wave slope (exaggerated: a real buoy also rolls), plus a little wobble.
      const lean = (s.lean ?? 1) * waves * 4;
      const wob = Math.sin(time * 1.7 + this.phase[i]) * 0.02 * lean;
      const slopeX = 0.0525 * Math.cos(x * 0.15 + waveTime * 1.3);
      const slopeZ = -0.05 * Math.sin((s.z + 30) * 0.2 + waveTime * 0.9);
      _q.setFromEuler(_e.set(-Math.atan(slopeZ * lean) + wob, this.yaw[i] + time * 0.03, Math.atan(slopeX * lean) + wob * 0.7, 'ZXY'));
      const st = s.stretch ?? UNIT;
      _m.compose(_p.set(x, waterY(x, s.z, waveTime, waves) - (s.sink ?? 0), s.z), _q, _s.set(s.size * st[0], s.size * st[1], s.size * st[2]));
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
  /** Scales every puff. */
  swell = 1;

  constructor(group: THREE.Group, mat: THREE.Material, sources: PuffSource[], detail: SceneryDetail, rng: Rng) {
    for (const s of sources) {
      const n = perDetail(detail, s.counts);
      // Seeds are drawn for the high-detail count, so puff j looks the same at every level.
      for (let j = 0; j < s.counts[2]; j++) {
        const [a, b, c] = [rng.next(), rng.next(), rng.next()];
        // Fewer puffs are drawn bigger, so a sparse plume still reads as one. They leave the
        // chimney almost evenly spaced: a column, not a scatter of balls.
        if (j < n) this.items.push({ s, phase: (j + a * 0.25) / n, a: b, b: c, bulk: Math.pow(s.counts[2] / n, 0.35) });
      }
    }
    if (!this.items.length) return;
    this.mesh = instanced(new THREE.IcosahedronGeometry(1, 0), mat, this.items.length);
    this.items.forEach((it, i) => this.mesh!.setColorAt(i, _c.setScalar(0.93 + it.a * 0.07)));
    group.add(this.mesh);
  }

  /** `wind` (0 calm to 1 storm) lays every plume over and keeps it lower. */
  update(time: number, wind = 0) {
    if (!this.mesh) return;
    const lean = 0.6 + 1.1 * wind;
    const lift = 1 - 0.35 * wind;
    for (let i = 0; i < this.items.length; i++) {
      const { s, phase, a, b, bulk } = this.items[i];
      const age = fract(time / s.life + phase);
      // Every puff of a source follows one path: fast out of the chimney, then slower while the
      // wind takes it. The whole column sways as a wave travelling up it, so it never breaks apart.
      const sway = Math.sin(time * 0.55 - age * 3.4 + s.x) * 0.38 * age;
      const loose = s.spread * (0.4 + age);
      const x = s.x + s.drift[0] * lean * Math.pow(age, 1.4) + (a - 0.5) * loose + sway;
      const y = s.y + s.rise * lift * (1 - Math.pow(1 - age, 1.7));
      const z = s.z + s.drift[1] * lean * age + (b - 0.5) * loose;
      const r = (s.size[0] + (s.size[1] - s.size[0]) * age) * Math.min(1, age * 8) * Math.min(1, (1 - age) * 3.5) * bulk * this.swell;
      _q.setFromEuler(_e.set(a * 6 + age * 0.6, b * 6 + age * 1.5, 0, 'XYZ'));
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
      // By day the smoke is lit by the sun like everything else, with a little glow of its
      // own so its shaded side is not black. At night it is a dim blue-grey in the moonlight,
      // never brighter than the windows below it.
      mat.color.set(night ? '#8794a8' : day);
      mat.emissive.set(night ? '#3b475c' : day);
      mat.emissiveIntensity = night ? 0.35 : 0.3;
      mat.opacity = night ? 0.5 : 0.6;
    },
  };
}

// ---- Fjord (Norway / Iceland) -------------------------------------------

/** One mountain of a fjord range. Everything is measured from the middle of its foot. */
interface Massif {
  geo: THREE.BufferGeometry;
  /** How far its foot reaches to the left (a negative number) and to the right. */
  left: number;
  right: number;
  /** The point on its face at compass angle `a` (0 is +x, π/2 faces the camera), `u` of the way up. */
  at(a: number, u: number, out: THREE.Vector3): THREE.Vector3;
  /** Height of its surface above (x, z), or -Infinity outside its foot. */
  heightAt(x: number, z: number): number;
}

/** How far up each ring of a massif's skin sits; the summit closes it. */
const MASSIF_RINGS = [0, 0.2, 0.42, 0.63, 0.82] as const;
const MASSIF_ROCK = ['#4d5d6b', '#3f4d59', '#5a6a77'];
const MASSIF_SNOW = ['#f4fbff', '#dcecf5'];

/**
 * A mountain as one skin drawn up from an uneven foot to a summit that stands off
 * centre, so no two have the same outline. The foot is a lopsided polygon with a
 * buttress or two, the flanks are fuller or steeper from one mountain to the
 * next, and most carry a shoulder on one side. The skin never folds over itself,
 * and it is pressed thin along the line of sight (`depth`) so a range keeps to
 * its own slab. Snow lies above a line that wanders round the mountain, and
 * mostly not on its cliffs.
 */
function massif(rng: Rng, r: number, h: number, depth: number): Massif {
  const sides = rng.int(8, 10);
  const step = (Math.PI * 2) / sides;
  const turn = rng.range(0, step);
  const angle = Array.from({ length: sides }, (_, j) => turn + (j + rng.range(-0.3, 0.3)) * step);
  const plan = angle.map(() => rng.range(0.72, 1.08));
  for (let k = 0; k < 2; k++) plan[rng.int(0, sides - 1)] = rng.range(1.12, 1.28);
  const steep = rng.range(0.8, 1.4);
  const lean = [rng.range(-0.3, 0.3) * r, rng.range(-0.1, 0.1) * r];
  const ring = MASSIF_RINGS.map((u, k) =>
    angle.map((a, j) => {
      const out = r * plan[j] * Math.pow(1 - u, steep) * (k ? rng.range(0.9, 1.1) : 1);
      const off = Math.pow(u, 1.3);
      return new THREE.Vector3(lean[0] * off + Math.cos(a) * out, h * u + (k ? rng.range(-0.035, 0.035) * h : 0), (lean[1] * off + Math.sin(a) * out) * depth);
    }),
  );
  const top = new THREE.Vector3(lean[0], h, lean[1] * depth);
  // A shoulder: one corner, on a side that shows in the outline, is lifted and pushed out
  // over the ring below. That leaves a cliff under it and a shelf behind it.
  if (rng.next() < 0.7) {
    const k = rng.int(2, 3);
    const toward = rng.next() < 0.5 ? 0 : Math.PI;
    let j = 0;
    for (let i = 1; i < sides; i++) if (Math.cos(angle[i] - toward) > Math.cos(angle[j] - toward)) j = i;
    const [corner, below, above] = [ring[k][j], ring[k - 1][j], k + 1 < ring.length ? ring[k + 1][j] : top];
    corner.x += (below.x - corner.x) * 0.75;
    corner.z += (below.z - corner.z) * 0.75;
    corner.y = Math.min(corner.y + rng.range(0.1, 0.17) * h, above.y - 0.02 * h);
  }

  const faces = new Map<string, number[]>();
  const snowline = rng.range(0.36, 0.58);
  const [lobes, phase] = [rng.int(1, 3), rng.range(0, 6)];
  const [ab, ac] = [new THREE.Vector3(), new THREE.Vector3()];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    const up = (a.y + b.y + c.y) / 3 / h;
    const around = Math.atan2((a.z + b.z + c.z) / depth, a.x + b.x + c.x);
    // How level the face would lie on the mountain before it was pressed thin: 1 flat, 0 a wall.
    ab.subVectors(b, a).setZ((b.z - a.z) / depth);
    ac.subVectors(c, a).setZ((c.z - a.z) / depth);
    const level = ab.cross(ac).normalize().y;
    const line = snowline + 0.1 * Math.sin(around * lobes + phase) + rng.range(-0.06, 0.06);
    const color = up > line && (level > 0.3 || rng.next() < 0.3) ? rng.pick(MASSIF_SNOW) : rng.pick(MASSIF_ROCK);
    if (!faces.has(color)) faces.set(color, []);
    faces.get(color)!.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for (let k = 0; k + 1 < ring.length; k++) {
    for (let j = 0; j < sides; j++) {
      const [a, b, c, d] = [ring[k][j], ring[k][(j + 1) % sides], ring[k + 1][j], ring[k + 1][(j + 1) % sides]];
      // Either diagonal: the facets do not all run the same way.
      if (rng.next() < 0.5) {
        tri(a, c, b);
        tri(b, c, d);
      } else {
        tri(a, c, d);
        tri(a, d, b);
      }
    }
  }
  const last = ring[ring.length - 1];
  for (let j = 0; j < sides; j++) tri(last[j], top, last[(j + 1) % sides]);

  const [lower, upper] = [new THREE.Vector3(), new THREE.Vector3()];
  const at = (a: number, u: number, out: THREE.Vector3) => {
    const full = Math.PI * 2;
    const turned = angle[0] + ((((a - angle[0]) % full) + full) % full);
    let j = sides - 1;
    for (let i = 0; i + 1 < sides; i++) {
      if (turned < angle[i + 1]) {
        j = i;
        break;
      }
    }
    const s = (turned - angle[j]) / ((j + 1 < sides ? angle[j + 1] : angle[0] + full) - angle[j]);
    const level = Math.min(Math.max(u, 0), MASSIF_RINGS[MASSIF_RINGS.length - 1]);
    let k = 0;
    while (k + 2 < MASSIF_RINGS.length && level >= MASSIF_RINGS[k + 1]) k++;
    const v = (level - MASSIF_RINGS[k]) / (MASSIF_RINGS[k + 1] - MASSIF_RINGS[k]);
    lower.lerpVectors(ring[k][j], ring[k][(j + 1) % sides], s);
    upper.lerpVectors(ring[k + 1][j], ring[k + 1][(j + 1) % sides], s);
    return out.lerpVectors(lower, upper, v);
  };
  const probe = new THREE.Vector3();
  const heightAt = (x: number, z: number) => {
    const a = Math.atan2(z / depth, x);
    const reach = Math.hypot(x, z / depth);
    at(a, 0, probe);
    let [far, y] = [Math.hypot(probe.x, probe.z / depth), probe.y];
    if (reach > far) return -Infinity;
    // Walk up the face until it has drawn in past the point.
    for (let u = 0.04; u < 0.83; u += 0.04) {
      at(a, u, probe);
      const here = Math.hypot(probe.x, probe.z / depth);
      if (here <= reach) return y + (probe.y - y) * ((far - reach) / Math.max(1e-6, far - here));
      [far, y] = [here, probe.y];
    }
    return y;
  };

  return {
    geo: triangles([...faces].map(([color, verts]) => [verts, color])),
    left: Math.min(...ring[0].map((v) => v.x)),
    right: Math.max(...ring[0].map((v) => v.x)),
    at,
    heightAt,
  };
}

function buildFjord(map: MapDef, detail: SceneryDetail): Scenery {
  const rng = new Rng(0xf10d);
  const batch = new Batch();
  const group = new THREE.Group();

  const painted = flatMat('#ffffff', { vertexColors: true });
  const put = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, o?: Placement) =>
    batch.add(solid(geo, color), painted, x, y, z, o);
  const rock = shades(['#4d5d6b', '#3f4d59', '#5a6a77']);
  const snow = shades(['#f4fbff', '#dcecf5']);
  const mountain = mountainMat();
  // Ranges like sheets of cut paper, one behind the other, each a row of mountains of
  // uneven size: mostly middling, with the odd giant and the odd foothill, and often a pass
  // between two of them. Every mountain keeps to its own ground: within a range none touches
  // the next, and a range is no deeper than its slab, so no face can poke through another.
  // The nearer ranges stand back from the middle, so the fjord runs on between them to the
  // far range and the sky: the view has somewhere to go.
  const range = stream(0xf10d, 7);
  interface Peak extends Massif {
    x: number;
    z: number;
  }
  const stand = (m: Massif, x: number, z: number): Peak => {
    batch.add(m.geo, mountain, x, -2, z);
    return { ...m, x, z };
  };
  /** The foot reaches up to 1.28 radii: pressed this thin, it stays within 12.5 m of its range's line. */
  const thin = (r: number, depth: number) => Math.min(depth, 12.5 / (r * 1.3));
  const rangeAcross = (
    z: number,
    from: number,
    to: number,
    r: readonly [number, number],
    h: readonly [number, number],
    depth: number,
    /** A stretch this range leaves empty. */
    open?: readonly [number, number],
  ) => {
    for (let x = from; x < to; ) {
      const roll = range.next();
      const [wide, tall] = roll < 0.22 ? [1.25, 1.25] : roll < 0.5 ? [0.7, 0.55] : [1, 1];
      const pr = range.range(r[0], r[1]) * wide;
      const m = massif(range, pr, range.range(h[0], h[1]) * tall, thin(pr, depth));
      // Its foot starts where the last one ended, or past the open stretch if it would stand in it.
      if (open && x < open[1] && x + m.right - m.left > open[0]) x = open[1];
      const peak = stand(m, x - m.left, z + range.range(-1, 1));
      x = peak.x + m.right + (range.next() < 0.3 ? range.range(16, 38) : range.range(2, 12));
    }
  };
  rangeAcross(-196, -330, 330, [34, 44], [60, 86], 0.24);
  rangeAcross(-156, -300, 300, [28, 36], [46, 68], 0.27, [-30, 26]);
  rangeAcross(-118, -260, 260, [22, 29], [30, 50], 0.3, [-64, 58]);
  // The near range leaves the middle open like a channel, and stands clear of the waterfall's bluff (x = 47).
  const near = [-185, -105, 105, 185].map((x0) => {
    const pr = range.range(19, 23);
    return stand(massif(range, pr, range.range(26, 46), thin(pr, 0.33)), x0 + range.range(-4, 4), -82 + range.range(-1, 1));
  });
  /** Height of a near peak's slope above (x, z), or -Infinity where no peak stands. */
  const slopeY = (x: number, z: number) => {
    let y = -Infinity;
    for (const p of near) y = Math.max(y, -2 + p.heightAt(x - p.x, z - p.z));
    return y;
  };

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
      // Where the shore runs under a mountain's foot, the tree stands on the slope, not inside it.
      const y = Math.max(-0.8 + mr * 0.2, slopeY(x, z) - 0.6);
      const color = rng.pick(pine);
      put(new THREE.ConeGeometry(h * 0.34, h * 0.7, 6), color, x, y + h * 0.35, z);
      put(new THREE.ConeGeometry(h * 0.24, h * 0.55, 6), color, x, y + h * 0.72, z);
    }
  }

  // Pines climb the lower slopes of the near range in groves, and stop well short of the snow.
  // They are painted with the mountain's material, so in rain they sink into its silhouette.
  const forest = stream(0xf10d, 6);
  const kept = perDetail(detail, [0.4, 0.7, 1] as const);
  for (const p of near) {
    for (let grove = 0; grove < 8; grove++) {
      // Only the side of the peak that faces the camera.
      const around = forest.range(0.1, 0.9) * Math.PI;
      const up = forest.range(0.02, 0.28);
      const trees = forest.int(3, 6);
      for (let t = 0; t < trees; t++) {
        const a = around + forest.range(-0.1, 0.1);
        const u = Math.min(0.36, Math.max(0.01, up + forest.range(-0.03, 0.05)));
        const h = forest.range(3.4, 6.2) * (1 - u * 0.9);
        const color = forest.pick(pine);
        // Every tree is rolled at every detail level, so the ones that stay never move.
        if (forest.next() >= kept) continue;
        // Rooted a little way into the face, so no trunk shows daylight under it.
        p.at(a, u, _p);
        const [x, y, z] = [p.x + _p.x, -2.8 + _p.y, p.z + _p.z];
        batch.add(solid(new THREE.ConeGeometry(h * 0.34, h * 0.7, 6), color), mountain, x, y + h * 0.35, z);
        batch.add(solid(new THREE.ConeGeometry(h * 0.24, h * 0.55, 6), color), mountain, x, y + h * 0.72, z);
      }
    }
  }

  // Two fishing cabins and a pier on an islet off to the left.
  put(jitter(new THREE.IcosahedronGeometry(8, 0), rng, 1), '#4f5a60', -34, -0.4, -47, { sy: 0.2 });
  const [roof, trim, wood] = ['#2b3138', '#f1eee6', '#7a5a3c'];
  const windows = lampMat();
  // Where each cabin's window and chimney top ended up, for the night lights and the smoke.
  const panes: [number, number, number][] = [];
  const flues: [number, number, number][] = [];
  const pools: number[] = [];
  /** A fishing cabin with its gable to the camera: stone footing, plank walls with white corner boards, snow on the roof. */
  const cabin = (x: number, z: number, w: number, h: number, d: number, color: string) => {
    const floor = 1.5;
    const front = z + d / 2;
    const eaves = floor + h;
    const rise = h * 0.62;
    put(new THREE.BoxGeometry(w + 0.3, 0.45, d + 0.3), '#5d646a', x, floor - 0.2, z);
    put(new THREE.BoxGeometry(w, h, d), color, x, floor + h / 2, z);
    for (const side of [-1, 1]) put(new THREE.BoxGeometry(0.16, h, 0.16), trim, x + side * (w / 2), floor + h / 2, front);

    // The roof: the gable faces the camera, eaves overhang, and snow lies on the upper part of each slope.
    const hw = w / 2 + 0.45, hd = d / 2 + 0.5, drip = -0.12, line = 0.4;
    const xs = hw * (1 - line), ys = drip + (rise - drip) * line;
    // One slope from eave to snow line to ridge; `s` is +1 for the right-hand slope.
    const slope = (s: number, x0: number, y0: number, x1: number, y1: number) => {
      const q = [s * x0, y0, hd, s * x0, y0, -hd, s * x1, y1, -hd, s * x1, y1, hd];
      const [a, b, c, e] = [q.slice(0, 3), q.slice(3, 6), q.slice(6, 9), q.slice(9, 12)];
      return s > 0 ? [...a, ...b, ...c, ...a, ...c, ...e] : [...a, ...c, ...b, ...a, ...e, ...c];
    };
    // The wall under the roof, front and back.
    const gable = (s: number) => {
      const end = [-w / 2, 0, s * (d / 2), w / 2, 0, s * (d / 2), 0, rise - 0.04, s * (d / 2)];
      return s > 0 ? end : [...end.slice(0, 3), ...end.slice(6, 9), ...end.slice(3, 6)];
    };
    // White barge boards along the front edge of the roof.
    const board = (s: number) => {
      const q = [s * hw, drip, hd, 0, rise, hd, 0, rise - 0.22, hd, s * hw, drip - 0.22, hd];
      const [a, b, c, e] = [q.slice(0, 3), q.slice(3, 6), q.slice(6, 9), q.slice(9, 12)];
      return s > 0 ? [...a, ...b, ...c, ...a, ...c, ...e] : [...a, ...c, ...b, ...a, ...e, ...c];
    };
    batch.add(
      triangles([
        [[...slope(1, hw, drip, xs, ys), ...slope(-1, hw, drip, xs, ys)], roof],
        [slope(1, xs, ys, 0, rise), '#f4fbff'],
        [slope(-1, xs, ys, 0, rise), '#dcecf5'],
        [[...gable(1), ...gable(-1)], color],
        [[...board(1), ...board(-1)], trim],
      ]),
      painted, x, eaves, z,
    );

    // Door with a frame and a stone step.
    const dx = x - w * 0.25;
    put(new THREE.BoxGeometry(1.1, 1.85, 0.08), trim, dx, floor + 0.92, front + 0.04);
    put(new THREE.BoxGeometry(0.8, 1.62, 0.1), '#4a3626', dx, floor + 0.83, front + 0.07);
    put(new THREE.BoxGeometry(1.3, 0.2, 0.55), '#5d646a', dx, floor - 0.1, front + 0.3);

    // A framed window with a cross of glazing bars; the pane is the part that lights up.
    const [wx, wy] = [x + w * 0.24, floor + h * 0.56];
    put(new THREE.BoxGeometry(1.26, 1.16, 0.06), trim, wx, wy, front + 0.03);
    batch.add(new THREE.BoxGeometry(1, 0.9, 0.1), windows, wx, wy, front + 0.05);
    put(new THREE.BoxGeometry(0.07, 0.9, 0.06), trim, wx, wy, front + 0.11);
    put(new THREE.BoxGeometry(1, 0.07, 0.06), trim, wx, wy, front + 0.11);
    panes.push([wx, wy, front + 0.05]);
    // Light from the window falls on the ground in front of it: a wedge, widest and faintest at its far edge.
    const [near, far, reach] = [0.55, 1.5, 2.9];
    pools.push(
      wx - near, floor + 0.06, front + 0.12, wx + near, floor + 0.06, front + 0.12, wx + far, floor - 0.3, front + reach,
      wx - near, floor + 0.06, front + 0.12, wx + far, floor - 0.3, front + reach, wx - far, floor - 0.3, front + reach,
    );

    // The chimney stands through the right-hand slope, toward the back.
    const [cx, cz, cw] = [x + w * 0.2, z - d * 0.18, w * 0.14];
    const top = eaves + rise + 0.75;
    put(new THREE.BoxGeometry(cw, rise + 1.1, cw), '#6b625a', cx, top - (rise + 1.1) / 2, cz);
    put(new THREE.BoxGeometry(cw + 0.2, 0.16, cw + 0.2), '#3f3a36', cx, top, cz);
    flues.push([cx, top + 0.2, cz]);
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
  batch.add(bluff, mountain, 47, 9, -79);
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
      // The windows' own glow stays close to the pane; the light they throw is the wedge on the ground.
      { color: '#ffd58a', glass: '#000000', flicker: 0.06, halo: 1.05 },
      { color: '#ffd58a', glass: '#000000', flicker: 0.06, phase: 2, halo: 0.9 },
    ],
    detail,
  );
  lights.placeAt(1, -27.2, 3.4, -42.6, 0.34, 0.42);
  panes.forEach(([x, y, z], i) => lights.placeAt(2 + i, x, y, z, 0));

  // Window light on the ground, bright at the wall and fading out: flat wedges, drawn additively.
  const poolGeo = new THREE.BufferGeometry();
  poolGeo.setAttribute('position', new THREE.Float32BufferAttribute(pools, 3));
  const poolShade = new Float32Array(pools.length);
  for (let i = 0; i < pools.length / 3; i++) poolShade.fill([1, 1, 0.12, 1, 0.12, 0.12][i % 6], i * 3, i * 3 + 3);
  poolGeo.setAttribute('color', new THREE.BufferAttribute(poolShade, 3));
  const pool = new THREE.Mesh(poolGeo, additive());
  (pool.material as THREE.MeshBasicMaterial).color.set('#ffb85c');
  pool.visible = false;
  group.add(pool);

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
      { x: flues[0][0], y: flues[0][1], z: flues[0][2], counts: [6, 9, 16], life: 7, rise: 8.5, drift: [10, 1.5], size: [0.45, 1.7], spread: 0.2 },
      { x: flues[1][0], y: flues[1][1], z: flues[1][2], counts: [0, 7, 12], life: 6.5, rise: 7, drift: [8.5, 1.2], size: [0.38, 1.4], spread: 0.2 },
      { x: 47, y: 0.8, z: -70.5, counts: [0, 0, 10], life: 4.5, rise: 5.5, drift: [3, 1.5], size: [0.5, 1.5], spread: 3.2 },
    ],
    detail,
    stream(0xf10d, 4),
  );

  // Aurora: curtains of rays that rise from behind the peaks on some nights (see aurora.ts).
  // They hang behind the far range even at the nearest point of their folds, so the rays fill
  // the valleys and the sky above the ridges without ever crossing in front of a summit.
  const columns = perDetail(detail, [36, 60, 96] as const);
  const curtains = [
    { y: 24, z: -174, height: 46, share: 0.9, look: {} },
    { y: 36, z: -188, height: 42, share: 0.6, look: { low: '#59f0c8', mid: '#3fd6b0' } },
    { y: 16, z: -202, height: 34, share: 0.45, look: { low: '#9dff9a' } },
  ].slice(0, perDetail(detail, [2, 3, 3] as const)).map((c) => {
    const curtain = new AuroraCurtain({ width: 340, height: c.height, columns, phase: rng.range(0, 6), ...c.look });
    curtain.mesh.position.set(rng.range(-30, 30), c.y, c.z);
    group.add(curtain.mesh);
    return { curtain, share: c.share };
  });

  return {
    group,
    update(time, night, _dt, env) {
      const shine = night && (env?.lightingEffects ?? true);
      setRainMist(env);
      windows.emissiveIntensity = shine ? 1.8 : 0;
      pool.visible = shine;
      // The fire inside wavers a little, and the light on the ground with it.
      if (shine) (pool.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.06 * Math.sin(time * 5.3) * Math.sin(time * 2.1);
      buoys.update(time, env);
      floes?.update(time, env);
      lights.update(time, night, shine);
      smokeLook.setNight(night);
      smoke.update(time, env?.weather?.wind ?? 0);
      // Not every night, and not all night: it comes in displays, and cloud hides it.
      const display = shine ? auroraActivity(time) * (1 - (env?.weather?.cloud ?? 0)) : 0;
      auroraGlow.ambient = display;
      for (const { curtain, share } of curtains) curtain.update(time, display * share);
    },
  };
}

// ---- Mist ----------------------------------------------------------------

interface MistSheet {
  /** Depth the sheet stands at, and how tall its top billows (m). */
  z: number;
  height: number;
  /** Opacity where it is thickest, just over the water. */
  density: number;
  /** How fast its lumps travel along it (m/s); the sign is the direction. */
  drift: number;
}

/** Something a sheet of mist must pass in front of or behind, never through. */
interface MistObstacle {
  x: number;
  z: number;
  foot: number;
}

/**
 * Mist lying on a lake: sheets of it standing on the water one behind another, each
 * thickest just over the surface and thinning to nothing at a billowing top. Lumps of
 * thicker, taller mist travel along every sheet at its own pace. Looking through them, the
 * nearest shore is barely veiled and the furthest feet are buried. Each sheet weaves
 * between the obstacles, so none is cut by one: the mist has no edge anywhere.
 * One draw call; the motion is all in the shader.
 */
class MistVeils {
  readonly mesh: THREE.Mesh;
  private uniforms = { uMistTime: { value: 0 }, uMistStrength: { value: 1 } };
  private clock = 0;
  private strength = 1;

  /** `sheets` are drawn in the order given: the furthest first. */
  constructor(sheets: readonly MistSheet[], obstacles: readonly MistObstacle[], halfWidth: number, rng: Rng) {
    const step = 6;
    const pos: number[] = [];
    const mist: number[] = [];
    const rise: number[] = [];
    // Rows from the water up: tucked under the surface, the thick belly, the top. Each has
    // its opacity and how much of a passing lump's height it takes on.
    const rows = [
      { alpha: 0.5, rise: 0 },
      { alpha: 1, rise: 0.3 },
      { alpha: 0, rise: 1 },
    ];
    for (const sheet of sheets) {
      const phase = rng.range(0, 40);
      const columns: [number, number][] = [];
      for (let x = -halfWidth; x <= halfWidth; x += step) {
        // Hold the sheet in front of whatever stands behind it here and behind whatever stands
        // in front; in a gap too narrow for both, down its middle.
        let [back, front] = [-Infinity, Infinity];
        for (const o of obstacles) {
          if (Math.abs(x - o.x) > o.foot + step) continue;
          if (o.z <= sheet.z) back = Math.max(back, o.z + o.foot + 0.5);
          else front = Math.min(front, o.z - o.foot - 0.5);
        }
        columns.push([x + rng.range(-1.5, 1.5), back > front ? (back + front) / 2 : THREE.MathUtils.clamp(sheet.z, back, front)]);
      }
      const heights = [-0.5, 1.7, sheet.height];
      const corner = (column: number, row: number) => {
        const [x, z] = columns[column];
        pos.push(x, heights[row], z);
        mist.push(rows[row].alpha, sheet.density, sheet.drift, phase);
        rise.push(rows[row].rise);
      };
      for (let i = 0; i < columns.length - 1; i++) {
        for (let row = 0; row < 2; row++) {
          for (const [c, r] of [[i, row], [i + 1, row], [i + 1, row + 1], [i, row], [i + 1, row + 1], [i, row + 1]]) corner(c, r);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aMist', new THREE.Float32BufferAttribute(mist, 4));
    geo.setAttribute('aMistRise', new THREE.Float32BufferAttribute(rise, 1));

    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aMist;
          attribute float aMistRise;
          uniform float uMistTime;
          varying float vMist;
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // Two slow waves of different length: lumps that never quite repeat.
          float mistAlong = (position.x + uMistTime * aMist.z) * 0.012 + aMist.w;
          float mistLump = 0.5 + 0.3 * sin(mistAlong * 2.1) + 0.2 * sin(mistAlong * 5.3 + aMist.w * 4.0);
          // Banks the sheets share: stretches of the lake lie thick while others clear, and
          // the pattern leans across the depths so it reads as one body of mist.
          float mistBank = 0.5 + 0.5 * sin((position.x + uMistTime * 0.45) * 0.021 + position.z * 0.017);
          float mistBody = mistLump * mix(0.4, 1.1, mistBank);
          // Where it is thicker it also stands taller.
          transformed.y *= mix(1.0, 0.5 + 0.75 * mistBody, aMistRise);
          vMist = aMist.x * aMist.y * (0.25 + 0.95 * mistBody);
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uMistStrength;
          varying float vMist;
        `)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Mist is the haze itself, lit a little brighter by day: it takes the air's colour.
          #ifdef USE_FOG
            float mistLight = dot(fogColor, vec3(0.2126, 0.7152, 0.0722));
            diffuseColor.rgb = fogColor + (vec3(1.0) - fogColor) * (0.04 + 0.26 * mistLight);
          #endif
          diffuseColor.a *= vMist * uMistStrength;
        `)
        .replace('#include <fog_fragment>', '');
    };
    mat.customProgramCacheKey = () => 'scenery-mist-veils-v1';
    this.mesh = new THREE.Mesh(geo, mat);
    // The sheets reach far outside the geometry's own idea of where it is.
    this.mesh.frustumCulled = false;
  }

  /** Move the mist on by `dt` seconds. `wind` hurries it; it lies thicker at night. */
  update(dt: number, night: boolean, wind = 0) {
    this.clock += dt * (1 + wind * 1.5);
    this.strength += ((night ? 1.3 : 1) - this.strength) * Math.min(1, dt * 0.4);
    this.uniforms.uMistTime.value = this.clock;
    this.uniforms.uMistStrength.value = this.strength;
  }
}

// ---- Heaven Lake (Zhangjiajie / Changbai) -------------------------------

function buildTianchi(map: MapDef, detail: SceneryDetail): Scenery {
  const rng = new Rng(0x71a2c1);
  const batch = new Batch();
  const group = new THREE.Group();

  const painted = flatMat('#ffffff', { vertexColors: true });
  const put = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, o?: Placement) =>
    batch.add(solid(geo, color), painted, x, y, z, o);
  // The lake's mist lies low: rock is hazed in full at the water and less with height.
  const mountain = mountainMat([3, 46, 0.55]);
  // Warm sandstone, so the pillars stand out from the cool rim and the mist; the last tone is
  // the foot, stained by the lake.
  const stone = ['#a48e70', '#8c765a', '#b8a180', '#6a5b47'];
  const bush = ['#4f8a3e', '#3a7236', '#63a049'];
  // Everything that grows on the rock is painted with the mountain's material, so in rain it
  // sinks into the same silhouette.
  const plant = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, o?: Placement) =>
    batch.add(solid(geo, color), mountain, x, y, z, o);
  /** How much grows on the rock, by detail. */
  const lush = perDetail(detail, [0.5, 0.8, 1] as const);

  // Pillars and rim are loose triangles gathered by colour and baked into one mesh.
  const faces = new Map<string, number[]>();
  const face = (color: string, ...corners: number[][]) => {
    if (!faces.has(color)) faces.set(color, []);
    faces.get(color)!.push(...corners.flat());
  };

  // The stone forest: sandstone pillars in the manner of Zhangjiajie. Each is one skin from
  // foot to summit, a column of rings on the same uneven plan, so its corners run up it as
  // clean edges and its ledges are steps in that skin: nothing pokes through anything.
  const forest = stream(0x71a2c1, 8);
  interface Spire {
    x: number;
    z: number;
    /** Height of the summit's rim, and the radius of the ground the pillar stands on. */
    crown: number;
    foot: number;
    /** The point on the rock face at height `y`, looking out from the axis along (ox, oz), and how far out it is. */
    face(y: number, ox: number, oz: number): { x: number; z: number; r: number };
  }
  const spires: Spire[] = [];
  /** A mountain pine: a bare trunk under flat layered pads, as they grow on these summits. */
  const pine = (x: number, y: number, z: number, h: number) => {
    const lean = forest.range(-0.2, 0.2);
    plant(new THREE.CylinderGeometry(0.035 * h, 0.07 * h, h, 4), '#5a4632', x + (lean * h) / 2, y + h / 2, z, { rz: -lean });
    for (let tier = 0; tier < 3; tier++) {
      const r = h * (0.44 - tier * 0.11);
      const at = 0.6 + tier * 0.2;
      plant(
        jitter(new THREE.CylinderGeometry(r * 0.72, r, h * 0.09, 6), forest, h * 0.03),
        forest.pick(bush),
        x + lean * h * at + forest.range(-0.12, 0.12) * h,
        y + h * at,
        z + forest.range(-0.12, 0.12) * h,
      );
    }
  };
  const spire = (x: number, z: number, h: number, r: number, flare: number): Spire => {
    // The plan: an uneven polygon, thinner front to back than across, as the camera sees it.
    const sides = forest.int(6, 7);
    const turn = forest.range(0, Math.PI * 2);
    const thin = forest.range(0.7, 0.95);
    const plan = Array.from({ length: sides }, (_, k) => {
      const a = turn + ((k + forest.range(-0.25, 0.25)) / sides) * Math.PI * 2;
      const reach = forest.range(0.84, 1.1);
      return [Math.cos(a) * reach, Math.sin(a) * reach * thin] as const;
    });
    /** Distance from the axis to the plan's edge along the unit direction (ox, oz). */
    const reach = (ox: number, oz: number) => {
      for (let k = 0; k < sides; k++) {
        const [px, pz] = plan[k];
        const [qx, qz] = plan[(k + 1) % sides];
        const [ex, ez] = [qx - px, qz - pz];
        const det = ox * ez - oz * ex;
        if (Math.abs(det) < 1e-9) continue;
        const along = (px * oz - pz * ox) / det;
        const out = (px * ez - pz * ex) / det;
        if (along >= 0 && along <= 1 && out > 0) return out;
      }
      return 1;
    };

    // The profile: a flared foot in the water, then beds of rock one on another. Where a
    // softer layer has worn back the bed above stands in from the one below, keeping one
    // face flush with it; on a taller pillar one such step is a broad shoulder.
    interface Level { y: number; f: number; cx: number; cz: number; ledge: boolean }
    const levels: Level[] = [{ y: -3, f: flare, cx: 0, cz: 0, ledge: false }];
    let f = forest.range(1.12, 1.22);
    let [cx, cz] = [0, 0];
    const waist = forest.range(2.5, 4.5);
    levels.push({ y: waist, f, cx, cz, ledge: false });
    const beds = Math.max(2, Math.round(h / forest.range(8, 13)));
    const shoulder = h > 20 && forest.next() < 0.65 ? forest.int(Math.ceil(beds / 2), beds - 1) : -1;
    let terrace: { x: number; y: number; z: number } | null = null;
    for (let bed = 1; bed < beds; bed++) {
      // Lower beds are the thicker ones.
      const y = waist + (h - waist) * Math.pow((bed + forest.range(-0.25, 0.25)) / beds, 0.85);
      f *= forest.range(0.94, 0.99);
      levels.push({ y, f, cx, cz, ledge: false });
      const broad = bed === shoulder;
      const step = broad ? forest.range(0.6, 0.72) : forest.range(0.86, 0.94);
      // A shoulder shows best to one side of the pillar, so it leans along x.
      const toward = broad ? (forest.next() < 0.5 ? 0 : Math.PI) + forest.range(-0.5, 0.5) : forest.range(0, Math.PI * 2);
      const shift = f * (1 - step) * r * (broad ? 0.85 : forest.range(0, 0.6));
      if (broad) terrace = { x: x + cx - Math.cos(toward) * f * r * 0.62, y, z: z + cz - Math.sin(toward) * f * r * 0.62 * thin };
      cx += Math.cos(toward) * shift;
      cz += Math.sin(toward) * shift * thin;
      f *= step;
      levels.push({ y: y + forest.range(0.35, 0.8), f, cx, cz, ledge: true });
    }
    // The cap rock is harder than the bed under it: most heads stand out over their necks.
    f *= forest.range(0.98, 1.2);
    levels.push({ y: h, f, cx, cz, ledge: false });

    const rings = levels.map((level, i) =>
      plan.map(([px, pz]) => {
        const wobble = i === 0 ? 1 : 1 + forest.range(-0.035, 0.035);
        const lift = i === 0 || level.ledge ? 0 : forest.range(-0.3, 0.3);
        return [x + level.cx + px * r * level.f * wobble, level.y + lift, z + level.cz + pz * r * level.f * wobble];
      }),
    );
    for (let i = 0; i < rings.length - 1; i++) {
      const ledge = levels[i + 1].ledge;
      // Each bed keeps to two neighbouring tones; the foot is the darkest, stained by the lake.
      const tone = i === 0 ? 3 : forest.int(0, 2);
      for (let k = 0; k < sides; k++) {
        const [a, b, c, d] = [rings[i][k], rings[i][(k + 1) % sides], rings[i + 1][(k + 1) % sides], rings[i + 1][k]];
        const color = ledge
          ? forest.next() < 0.75 ? forest.pick(bush) : stone[2]
          : i > 1 && forest.next() < 0.05 ? forest.pick(bush) : stone[forest.next() < 0.7 ? tone : (tone + 1) % 3];
        face(color, a, c, b);
        face(color, a, d, c);
      }
    }
    // The summit: a wooded dome, its top a little off centre.
    const rim = rings[rings.length - 1];
    const top = r * f;
    const dome = rim.map(([px, , pz]) => [
      x + cx + (px - x - cx) * forest.range(0.5, 0.66),
      h + top * forest.range(0.38, 0.6),
      z + cz + (pz - z - cz) * forest.range(0.5, 0.66),
    ]);
    const tip = [x + cx + forest.range(-0.25, 0.25) * top, h + top * forest.range(0.8, 1.1), z + cz + forest.range(-0.25, 0.25) * top];
    for (let k = 0; k < sides; k++) {
      const next = (k + 1) % sides;
      const color = forest.pick(bush);
      face(color, rim[k], dome[next], rim[next]);
      face(color, rim[k], dome[k], dome[next]);
      face(forest.pick(bush), dome[k], tip, dome[next]);
    }

    const made: Spire = {
      x, z, crown: h, foot: r * flare * 1.1,
      face(y, ox, oz) {
        let i = 1;
        while (i < levels.length - 1 && y > levels[i].y) i++;
        const [lo, hi] = [levels[i - 1], levels[i]];
        const u = THREE.MathUtils.clamp((y - lo.y) / Math.max(1e-6, hi.y - lo.y), 0, 1);
        const out = r * (lo.f + (hi.f - lo.f) * u) * reach(ox, oz);
        return { x: x + lo.cx + (hi.cx - lo.cx) * u + ox * out, z: z + lo.cz + (hi.cz - lo.cz) * u + oz * out, r: out };
      },
    };

    // Shrubs root on the ledges, mostly on the side the camera sees.
    for (let i = 1; i < levels.length; i++) {
      if (!levels[i].ledge || forest.next() > 0.9 * lush) continue;
      const a = forest.range(-1.3, 1.3);
      const at = made.face(levels[i].y, Math.sin(a), Math.cos(a));
      const size = forest.range(0.4, 0.62) * Math.sqrt(r) + 0.25;
      plant(jitter(new THREE.IcosahedronGeometry(size, 0), forest, size * 0.2), forest.pick(bush), at.x, levels[i].y + size * 0.2, at.z, { sy: 0.65 });
    }
    // A pine on the shoulder, and pines on the summit: the tallest in the middle.
    if (terrace && forest.next() < 0.5 + 0.4 * lush) pine(terrace.x, terrace.y + 0.3, terrace.z, forest.range(2.6, 3.8));
    const trees = Math.max(1, Math.round(forest.range(1, 2.4) * Math.sqrt(top) * lush));
    for (let t = 0; t < trees; t++) {
      const a = forest.range(0, Math.PI * 2);
      const out = t === 0 ? 0 : forest.range(0.3, 0.7) * top;
      const height = forest.range(2.8, 4.6) * (t === 0 ? 1.15 : 0.85);
      pine(x + cx + Math.cos(a) * out, h + top * (t === 0 ? 0.75 : 0.3), z + cz + Math.sin(a) * out * thin, height);
    }
    return made;
  };

  /** How high the surface camera sees at depth z: a summit below this stays in the picture. */
  const ceiling = (z: number) => 2.2 + (22 - z) * 0.36;
  // No pillar stands inside another: one that would is moved back or forward until its foot is
  // clear, or left out where the forest is already full.
  const place = (x: number, z: number, h: number, r: number, flare: number, zMin: number, zMax: number) => {
    const foot = r * flare * 1.1;
    const clear = (at: number) => spires.every((p) => Math.hypot(p.x - x, p.z - at) > p.foot + foot + 0.6);
    z = THREE.MathUtils.clamp(z, zMin, zMax);
    for (let tries = 0; tries < 6 && !clear(z); tries++) z = z - 9 < zMin ? z - 9 + (zMax - zMin) : z - 9;
    if (!clear(z)) return null;
    const made = spire(x, z, h, r, flare);
    spires.push(made);
    return made;
  };
  // They stand in groups, as the real ones do: a host with lower, thinner guests beside it or
  // half hidden behind it, stepping down away from it, and open water between the groups.
  // Now and then the host is a massif, broad and not so tall.
  const stand = (x: number, z: number, zMin: number, zMax: number, tall: number, guests: number) => {
    const massif = forest.next() < 0.28;
    const r = massif ? forest.range(7, 9.5) : forest.range(3.6, 5.6);
    const height = ceiling(z) * (massif ? tall * 0.72 : tall);
    const host = place(x, z, height, r, forest.range(1.3, 1.5), zMin, zMax);
    if (!host) return;
    for (let g = 0; g < guests; g++) {
      const gr = (massif ? 4.4 : r) * forest.range(0.42, 0.72);
      const flare = forest.range(1.2, 1.35);
      const gap = host.foot + gr * flare * 1.1 + forest.range(0.8, 3) + (g > 1 ? gr * 2.6 : 0);
      const beside = forest.next() < 0.65;
      const side = g % 2 ? -1 : 1;
      const gx = host.x + (beside ? side * gap : forest.range(-1.4, 1.4) * r);
      const gz = host.z + (beside ? forest.range(-5, 5) : side * gap);
      place(gx, gz, height * forest.range(0.5, 0.85) * (g > 1 ? 0.75 : 1), gr, flare, zMin - 4, zMax + 6);
    }
  };
  // Three depths. The far forest fades into the haze; the middle one carries the picture; a
  // few near pillars on each side frame the lake and leave its middle open.
  for (let x = -330; x <= 330; x += 60) {
    stand(x + forest.range(-20, 20), forest.range(-126, -110), -128, -106, forest.range(0.55, 0.97), forest.int(1, 3));
  }
  for (let x = -300; x <= 300; x += 75) {
    stand(x + forest.range(-22, 22), forest.range(-96, -76), -98, -72, forest.range(0.6, 1), forest.int(2, 4));
  }
  for (const side of [-1, 1]) {
    for (let x = 84; x <= 250; x += 72) {
      stand(side * (x + forest.range(0, 22)), forest.range(-60, -48), -62, -46, forest.range(0.6, 1.1), forest.int(0, 2));
    }
  }

  // The crater rim behind everything, in two ranges like sheets of cut paper: each is one
  // continuous skin from a straight foot up to a jagged crest, the further one taller and
  // paler. They stand behind the last pillar and clear of each other, so no peak can run
  // into another or into a pillar. Snow lies on the high faces.
  const rimRock = ['#4f6068', '#445560', '#5a6b73'];
  const frost = '#e4efec';
  const ridge = stream(0x71a2c1, 7);
  const span = 13;
  /** `height(x)` gives the crest; the rows between it and the foot lean back by `lean` m in all. */
  const range = (zFoot: number, lean: number, snowline: number, height: (x: number) => number) => {
    const rows: number[][][] = [[], [], [], []];
    for (let x = -440; x <= 440; x += span) {
      const top = height(x) + ridge.range(-2.5, 2.5);
      // Each row stands a little further back and half a step along from the one below.
      rows[0].push([x, -2, zFoot]);
      rows[1].push([x + span / 2 + ridge.range(-3, 3), top * ridge.range(0.24, 0.36), zFoot - lean * 0.3 + ridge.range(-1, 1)]);
      rows[2].push([x + ridge.range(-3, 3), top * ridge.range(0.56, 0.72), zFoot - lean * 0.65 + ridge.range(-1, 1)]);
      rows[3].push([x + span / 2 + ridge.range(-4, 4), top, zFoot - lean + ridge.range(-1, 1)]);
    }
    for (let row = 0; row < 3; row++) {
      const [low, high] = [rows[row], rows[row + 1]];
      for (let i = 0; i < low.length - 1; i++) {
        // The upper row is half a step along from the lower on even rows, half a step back on odd ones.
        const pair = row % 2
          ? [[low[i], low[i + 1], high[i + 1]], [high[i], low[i], high[i + 1]]]
          : [[low[i], low[i + 1], high[i]], [high[i], low[i + 1], high[i + 1]]];
        for (const corners of pair) {
          const top = Math.max(corners[0][1], corners[1][1], corners[2][1]);
          const snowy = row > 0 && top > snowline + (row === 2 ? 0 : 6) && ridge.next() < (row === 2 ? 0.92 : 0.45);
          face(snowy ? frost : row === 0 ? rimRock[1] : ridge.pick(rimRock), ...corners);
        }
      }
    }
  };
  // Pointed peaks with broad saddles between them.
  const peaks = (x: number, a: number, b: number, c: number) =>
    Math.pow(THREE.MathUtils.clamp(0.5 + 0.26 * Math.sin(x * 0.019 + a) + 0.17 * Math.sin(x * 0.043 + b) + 0.1 * Math.sin(x * 0.097 + c), 0, 1), 1.6);
  range(-141, 9, 24, (x) => 12 + 34 * peaks(x, 0.6, 2.1, 4));
  range(-156, 10, 34, (x) => 20 + 40 * peaks(x, 3.4, 0.4, 1.3));
  batch.add(triangles([...faces].map(([color, verts]) => [verts, color])), mountain, 0, 0, 0);

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
  for (const p of spires) {
    const grow = pines.next() < 0.55;
    const y = pines.range(9, Math.max(10, Math.min(p.crown - 8, 28)));
    const around = pines.range(-0.7, 0.7);
    const [ox, oz] = [Math.sin(around), Math.cos(around)];
    // Where the rock face is at this height, on the side the pine grows from.
    const root = p.face(y, ox, oz);
    const k = THREE.MathUtils.clamp(root.r / 3.2, 0.75, 1.2);
    const lean = pines.range(0.55, 0.95);
    const pads = [0, 1, 2].map(() => [pines.range(1.1, 1.6) * k, pines.range(-0.5, 0.5) * k, pines.next()] as const);
    // Only a pillar tall enough to carry one below its summit.
    if (!grow || p.crown < 17) continue;
    const dir = new THREE.Vector3(ox * Math.sin(lean), Math.cos(lean), oz * Math.sin(lean));
    const tilt = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    const len = 2.6 * k;
    const [bx, bz] = [root.x - ox * 0.3, root.z - oz * 0.3];
    plant(new THREE.CylinderGeometry(0.14 * k, 0.26 * k, len, 5), '#5a4632', bx + (dir.x * len) / 2, y + (dir.y * len) / 2, bz + (dir.z * len) / 2, { rx: tilt.x, ry: tilt.y, rz: tilt.z });
    // Flat layered canopy pads, stepping down and out from the tip.
    pads.forEach(([pr, side, shade], j) => {
      const out = len * (0.75 + j * 0.25);
      plant(
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

  // Mist on the lake: sheets of it between and among the pillars, from behind the rim to just
  // beyond the lanterns. The far ones stand taller; the pavilion's rock is in their way too.
  const mistRng = stream(0x71a2c1, 9);
  const sheetDepths = [-153, -137, -124, -112, -98, -85, -72, -60, -48];
  const sheets = sheetDepths
    .filter((_, i) => detail > 1 || i % 2 === 0)
    .map((z, i) => ({
      z,
      height: 5.5 + (22 - z) * 0.06 + mistRng.range(-1, 1),
      density: 0.24 * (detail > 1 ? 1 : 1.5),
      drift: mistRng.range(0.5, 1.4) * (i % 2 ? 1 : -1),
    }));
  const mist = new MistVeils(sheets, [...spires, { x: 34, z: -50, foot: 8 }], 440, mistRng);
  group.add(mist.mesh);

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
  const tall = spires.filter((p) => p.z < -70 && p.z > -100 && p.crown > 26);
  const home = (tall.length ? tall : spires).reduce((a, b) => (Math.abs(b.x + 28) < Math.abs(a.x + 28) ? b : a));
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
      setRainMist(env);
      lantern.emissiveIntensity = shine ? 2 : 0;
      mist.update(dt, night, env?.weather?.wind ?? 0);
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
      // Incense in the pavilion's lee: the wind barely reaches it.
      smoke.update(time, (env?.weather?.wind ?? 0) * 0.3);
      cranes.update(time, night);
    },
  };
}

// ---- Open Ocean: the freighter and the lighthouse beam -------------------

/** Metres of air a lighthouse beam lights up before it has faded out. */
const BEAM_REACH = 92;

/**
 * A lighthouse beam as light hanging in the air: a cone that is brightest along
 * its axis and fades to nothing at its outline, at its far end and right at the
 * lamp, so the cone itself is never seen. Pointing at the viewer it all but
 * vanishes, and the lamp's own flash takes over.
 */
function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uBeamColor: { value: new THREE.Color('#fff1c4') }, uBeamStrength: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying float vBeamAlong;
      varying vec3 vBeamNormal;
      varying vec3 vBeamView;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vBeamAlong = length(position) / ${BEAM_REACH.toFixed(1)};
        vBeamNormal = normalMatrix * normal;
        vBeamView = -viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uBeamColor;
      uniform float uBeamStrength;
      varying float vBeamAlong;
      varying vec3 vBeamNormal;
      varying vec3 vBeamView;
      void main() {
        // The cone wall faces the viewer along the beam's axis and turns edge-on at its outline.
        float facing = abs(dot(normalize(vBeamNormal), normalize(vBeamView)));
        float across = pow(facing, 2.4);
        float along = pow(1.0 - clamp(vBeamAlong, 0.0, 1.0), 1.7) * smoothstep(0.0, 0.05, vBeamAlong);
        gl_FragColor = vec4(uBeamColor, uBeamStrength * across * along);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// The freighter's lane along the horizon. It sails the lane end to end and turns
// round out of sight, so it crosses the view about every two and a half minutes.
const LANE_Z = -132;
const LANE_HALF = 240;
const SHIP_SPEED = 3.2;
const SHIP_BEAM = 5;
/** Top of the funnel in the ship's own space: bow at +x, y up from the waterline, +z to starboard. */
const FUNNEL_TOP = [-14.6, 10.9, 0] as const;

/**
 * The freighter's lamps: [x, y, z, head size] in the ship's own space, with `side`
 * marking the ones that keep to whichever side faces the viewer. The masthead
 * lights (the aft one higher), red to port, green to starboard and the white
 * stern light are what a real ship shows, so its heading can be read at night.
 */
const SHIP_LAMPS: { spec: LightSpec; at: readonly [number, number, number, number]; side?: boolean }[] = [
  { spec: { color: '#fff6e0', glass: '#2a3138', halo: 1.5 }, at: [13.4, 7.95, 0, 0.34] },
  { spec: { color: '#fff6e0', glass: '#2a3138', halo: 1.7 }, at: [-11.2, 11.9, 0, 0.36] },
  { spec: { color: '#3dff7a', glass: '#1f3b2a', halo: 1.2 }, at: [-10.6, 8.2, 3, 0.3] },
  { spec: { color: '#ff4636', glass: '#3b2220', halo: 1.2 }, at: [-10.6, 8.2, -3, 0.3] },
  { spec: { color: '#fff6e0', glass: '#2a3138', halo: 1 }, at: [-17.5, 3.4, 0, 0.28] },
  // Deck floodlights on the foremast and under the bridge, and the light the accommodation spills.
  { spec: { color: '#dfe9ff', glass: '#2a3138', halo: 2.4, level: () => 0.55 }, at: [13.1, 6.3, 0.6, 0.22], side: true },
  { spec: { color: '#dfe9ff', glass: '#2a3138', halo: 2.4, level: () => 0.55 }, at: [-9.4, 8.95, 1.2, 0.22], side: true },
  { spec: { color: '#ffc98a', glass: '#000000', halo: 6, level: () => 0.3 }, at: [-12.3, 6, 3.3, 0], side: true },
];

/**
 * A container ship working along the horizon: it rides the swell, trails smoke
 * from its funnel, pushes a bow wave and leaves a wake. At night its windows and
 * navigation lights come on, and the lighthouse beam washes over it as it passes.
 */
class Freighter {
  /** Its lamps, to append to the map's Lights; `attach` says where they landed. */
  readonly lampSpecs = SHIP_LAMPS.map((l) => l.spec);
  /** Position along the lane and heading. */
  private root = new THREE.Group();
  /** Everything that pitches and rolls. */
  private body = new THREE.Group();
  private hull: THREE.MeshStandardMaterial;
  private windows: THREE.MeshStandardMaterial;
  private radar: THREE.Mesh;
  private bowWave: THREE.Mesh;
  private foam: THREE.MeshBasicMaterial;
  private smoke: Puffs;
  private smokeLook = smokeMaterial('#7d838a');
  private funnel: PuffSource;
  private trail: [number, number] = [0, 0.5];
  private lights: Lights | null = null;
  private firstLamp = 0;

  constructor(group: THREE.Group, private waves: number, detail: SceneryDetail, rng: Rng) {
    const [navy, white, red, steel] = ['#27384a', '#e9e6de', '#b8382c', '#d8d8d8'];
    const profile = new THREE.Shape(
      [[-16.2, -1.2], [13.6, -1.2], [17.6, 3.5], [11.4, 3.3], [11.4, 2.2], [-8.6, 2.2], [-8.6, 2.9], [-17.4, 2.9], [-17, 0.6]].map(([x, y]) => new THREE.Vector2(x, y)),
    );
    const hull = new THREE.ExtrudeGeometry(profile, { depth: SHIP_BEAM, bevelEnabled: false });
    hull.translate(0, 0, -SHIP_BEAM / 2);
    // Draw the bow in to a stem.
    const hp = hull.attributes.position;
    for (let i = 0; i < hp.count; i++) if (hp.getX(i) > 10) hp.setZ(i, hp.getZ(i) * Math.max(0.12, 1 - (hp.getX(i) - 10) / 8.5));
    hull.computeVertexNormals();

    const parts: [THREE.BufferGeometry, THREE.ColorRepresentation, number, number, number][] = [
      [hull, navy, 0, 0, 0],
      // Red boot topping at the waterline, then the accommodation block aft.
      [new THREE.BoxGeometry(27.6, 1.5, SHIP_BEAM + 0.12), '#8f2d25', -2.6, -0.5, 0],
      [new THREE.BoxGeometry(6.4, 2.1, 4.6), white, -12.4, 3.95, 0],
      [new THREE.BoxGeometry(5.4, 1.9, 4.2), white, -12.6, 5.95, 0],
      [new THREE.BoxGeometry(4.2, 1.7, 5.8), white, -11.8, 7.75, 0],
      [new THREE.BoxGeometry(4.6, 0.22, 4.4), '#cfd3d6', -11.8, 8.71, 0],
      [new THREE.CylinderGeometry(0.8, 0.95, 3.4, 6), red, FUNNEL_TOP[0], 8.6, 0],
      [new THREE.CylinderGeometry(0.82, 0.82, 0.5, 6), '#1d2126', FUNNEL_TOP[0], 10.5, 0],
      [new THREE.CylinderGeometry(0.09, 0.13, 2.9, 5), steel, -11.2, 10.25, 0],
      [new THREE.BoxGeometry(0.12, 0.12, 2.2), steel, -11.2, 10.9, 0],
      [new THREE.CylinderGeometry(0.08, 0.13, 4.4, 5), steel, 13.4, 5.55, 0],
      [new THREE.BoxGeometry(1.7, 0.6, 0.75), '#e2702a', -13.6, 5.35, 2.55],
      [new THREE.BoxGeometry(1.7, 0.6, 0.75), '#e2702a', -13.6, 5.35, -2.55],
    ];
    // Deck cargo: seven bays of containers, two abreast, stacked one to three high.
    const boxes = ['#b5483a', '#2f6f9f', '#d08a2e', '#3f8f5f', '#7b5aa6', '#c9b23a', '#8a8f96'];
    for (let bay = 0; bay < 7; bay++) {
      const tiers = rng.int(1, 3);
      for (let tier = 0; tier < tiers; tier++) {
        for (const z of [-1.2, 1.2]) {
          if (tier === tiers - 1 && tier > 0 && rng.next() < 0.25) continue;
          parts.push([new THREE.BoxGeometry(2.5, 1.1, 2.25), rng.pick(boxes), -6.6 + bay * 2.75, 2.75 + tier * 1.13, z]);
        }
      }
    }
    // Windows down both sides and across the front of the bridge. Most are lit at night; a few stay dark.
    const panes: [THREE.BufferGeometry, THREE.ColorRepresentation, number, number, number][] = [];
    const pane = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
      if (rng.next() < 0.2) parts.push([geo, '#1c2630', x, y, z]);
      else panes.push([geo, '#ffffff', x, y, z]);
    };
    for (const side of [1, -1]) {
      for (let i = 0; i < 5; i++) pane(new THREE.BoxGeometry(0.55, 0.5, 0.06), -14.8 + i * 1.25, 4.2, side * 2.33);
      for (let i = 0; i < 4; i++) pane(new THREE.BoxGeometry(0.55, 0.5, 0.06), -14.6 + i * 1.25, 6.1, side * 2.13);
      for (let i = 0; i < 5; i++) pane(new THREE.BoxGeometry(0.62, 0.62, 0.06), -13.5 + i * 0.85, 7.95, side * 2.93);
    }
    for (let i = 0; i < 5; i++) pane(new THREE.BoxGeometry(0.06, 0.62, 0.7), -9.67, 7.95, -2.1 + i * 1.05);

    // Its own material: the lighthouse beam lights the whole ship as it sweeps across.
    this.hull = flatMat('#ffffff', { vertexColors: true, emissive: '#fff1c4', emissiveIntensity: 0 });
    this.windows = new THREE.MeshStandardMaterial({ color: '#1c2630', emissive: '#ffd08a', emissiveIntensity: 0, flatShading: true });
    this.radar = new THREE.Mesh(compound([[new THREE.BoxGeometry(2, 0.16, 0.28), steel, 0, 0, 0]]), this.hull);
    this.radar.position.set(-12.6, 9.1, 0);
    this.body.add(new THREE.Mesh(compound(parts), this.hull), new THREE.Mesh(compound(panes), this.windows), this.radar);

    // Foam stays on the water while the hull moves above it: the wave curling off
    // the bow, and a wake that widens and fades astern.
    const crest: number[] = [];
    for (const s of [1, -1]) crest.push(16.9, 0.05, s * 0.25, 13.2, 1, s * 2.2, 12.4, 0.05, s * 2.9, 13.2, 1, s * 2.2, 9.6, 0.25, s * 3, 12.4, 0.05, s * 2.9);
    this.bowWave = new THREE.Mesh(triangles([[crest, '#f3f8fa']]), flatMat('#ffffff', { vertexColors: true, side: THREE.DoubleSide, emissive: '#ffffff', emissiveIntensity: 0.25 }));
    const wake: number[] = [];
    const fade: number[] = [];
    const strip = (x0: number, w0: number, a0: number, x1: number, w1: number, a1: number, off = 0) => {
      wake.push(x0, 0, off - w0, x1, 0, off - w1, x0, 0, off + w0, x0, 0, off + w0, x1, 0, off - w1, x1, 0, off + w1);
      for (const a of [a0, a1, a0, a0, a1, a1]) fade.push(1, 1, 1, a);
    };
    for (let i = 0; i < 6; i++) {
      const [u0, u1] = [i / 6, (i + 1) / 6];
      strip(-17 - u0 * 34, 1.5 + u0 * 2.6, 0.8 * (1 - u0), -17 - u1 * 34, 1.5 + u1 * 2.6, 0.8 * (1 - u1));
    }
    for (const s of [1, -1]) strip(11, 0.2, 0.6, -17, 0.35, 0.3, s * 2.75);
    const wakeGeo = new THREE.BufferGeometry();
    wakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(wake, 3));
    wakeGeo.setAttribute('color', new THREE.Float32BufferAttribute(fade, 4));
    this.foam = new THREE.MeshBasicMaterial({ color: '#f3f8fa', vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const wakeMesh = new THREE.Mesh(wakeGeo, this.foam);
    wakeMesh.position.y = 0.12;

    this.root.add(this.body, this.bowWave, wakeMesh);
    this.root.position.z = LANE_Z;
    group.add(this.root);

    this.funnel = { x: 0, y: 0, z: LANE_Z, counts: [0, 6, 10], life: 9, rise: 6.5, drift: this.trail, size: [0.9, 3], spread: 0.5 };
    this.smoke = new Puffs(group, this.smokeLook.mat, [this.funnel], detail, rng);
  }

  /** Its lamps are `lights` entries `first`, `first + 1`, ... in the order of `lampSpecs`. */
  attach(lights: Lights, first: number) {
    this.lights = lights;
    this.firstLamp = first;
  }

  /** `beam` is the lighthouse lamp's rotation and where it stands, for the wash of light as it sweeps past. */
  update(time: number, night: boolean, shine: boolean, env: SceneryEnv | undefined, beam: { angle: number; x: number; z: number }) {
    const period = (4 * LANE_HALF) / SHIP_SPEED;
    const leg = fract(time / period + 0.19);
    const dir = leg < 0.5 ? 1 : -1;
    const x = LANE_HALF * (leg < 0.5 ? 4 * leg - 1 : 3 - 4 * leg);
    const waveTime = env?.waveTime ?? time;
    const waves = this.waves * (env?.swell ?? 1);

    // A ship this long spans several waves: it heaves and pitches with a fraction of each.
    this.root.position.x = x;
    this.root.rotation.y = dir > 0 ? 0 : Math.PI;
    this.body.position.y = waterY(x, LANE_Z, waveTime, waves) * 0.35;
    this.body.rotation.z = Math.atan(0.0525 * Math.cos(x * 0.15 + waveTime * 1.3) * waves) * 0.35 * dir;
    this.body.rotation.x = Math.sin(waveTime * 0.55 + 1.3) * 0.022 * waves;
    this.radar.rotation.y = time * 2.2;
    this.bowWave.position.y = waterY(x + dir * 14, LANE_Z, waveTime, waves) * 0.5;
    this.bowWave.scale.y = 0.85 + 0.3 * Math.sin(time * 2.1) + 0.15 * waves;
    this.foam.color.setScalar(night ? 0.34 : 0.95);

    this.windows.emissiveIntensity = shine ? 1.7 : 0;
    // The beam only reaches the ship while it passes behind the lighthouse.
    const [dx, dz] = [x - beam.x, LANE_Z - beam.z];
    const distance = Math.hypot(dx, dz);
    const aim = Math.abs(dx * Math.cos(beam.angle) - dz * Math.sin(beam.angle)) / distance;
    this.hull.emissiveIntensity = shine ? 0.3 * THREE.MathUtils.smoothstep(aim, 0.96, 0.998) * (1 - THREE.MathUtils.smoothstep(distance, 50, 105)) : 0;

    this.root.updateMatrix();
    this.body.updateMatrix();
    const pose = _m.multiplyMatrices(this.root.matrix, this.body.matrix);
    if (this.lights) {
      SHIP_LAMPS.forEach((lamp, i) => {
        const [lx, ly, lz, size] = lamp.at;
        // Turned round, the ship's own z points away: keep the deck lights on the near side.
        this.lights!.place(this.firstLamp + i, _m2.makeScale(size, size, size).setPosition(lx, ly, lamp.side ? lz * dir : lz).premultiply(pose));
      });
    }

    // Smoke leaves the funnel and is left behind as the ship moves on; wind lays it flatter.
    // It trails less far than the ship really travels, so the puffs still overlap into one plume.
    _p.set(...FUNNEL_TOP).applyMatrix4(pose);
    this.funnel.x = _p.x;
    this.funnel.y = _p.y;
    this.funnel.z = _p.z;
    this.trail[0] = -dir * SHIP_SPEED * this.funnel.life * 0.5;
    this.smokeLook.setNight(night);
    this.smoke.update(time, env?.weather?.wind ?? 0);
  }
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
  const mountain = mountainMat();
  const stack = '#3f4a55';
  const stacks: [number, number, number][] = [];
  for (const [x, z] of [[-118, -92], [-64, -98], [38, -106], [128, -88]]) {
    const r = rng.range(4, 7);
    const h = rng.range(9, 20);
    batch.add(solid(jitter(new THREE.ConeGeometry(r, h, 6, 3), rng, r * 0.2), stack), mountain, x, h / 2 - 2, z);
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
  // A freighter working along the horizon (its own seeded stream, like every feature).
  const freighter = new Freighter(group, map.waves, detail, stream(0x0cea17, 5));
  specs.push(...freighter.lampSpecs);
  // The lamp never goes fully dark between flashes: a wide, soft glow that swells as a beam comes round.
  const lighthouseGlow = specs.length;
  specs.push({ color: '#ffe9a8', glass: '#000000', halo: 11, level: (t) => 0.22 + 0.78 * sweep(t) });
  const lights = new Lights(group, new THREE.CylinderGeometry(0.5, 0.5, 1, 6), specs, detail);
  freighter.attach(lights, markerCount);
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

  // On high, the lamp's two beams sweep the night as light in the air (see beamMaterial).
  let beam: THREE.Mesh | null = null;
  const beamLook = beamMaterial();
  // Rotation at which a beam points from the lighthouse at the camera (x = 0, z = 22).
  const facing = Math.atan2(-(22 - lz), 0 - lx);
  if (detail >= 3) {
    // Apex at the lamp, opening along +x (side 1) or -x (side -1), dipping slightly toward the sea.
    const cone = (side: number) => {
      const g = new THREE.ConeGeometry(6.5, BEAM_REACH, 28, 1, true);
      g.translate(0, -BEAM_REACH / 2, 0);
      g.rotateZ(side > 0 ? Math.PI / 2 : -Math.PI / 2);
      return g.rotateZ(-0.05 * side);
    };
    beam = new THREE.Mesh(mergeGeometries([cone(1), cone(-1)])!, beamLook);
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
      setRainMist(env);
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
      // A beam faces the camera whenever |sin(0.8 t)| peaks, matching the lamp.
      const turn = time * 0.8 - Math.PI / 2 + facing;
      if (beam) {
        beam.visible = shine;
        beam.rotation.y = turn;
        // Rain and spray in the air are what make a beam visible: faint on a clear night.
        beamLook.uniforms.uBeamStrength.value = 0.26 + 0.34 * rainMist.value;
      }
      freighter.update(time, night, shine, env, { angle: turn, x: lx, z: lz });
      markers.update(time, env);
      lights.update(time, night, shine);
      gulls.update(time, night);
      spray.update(time);
    },
  };
}

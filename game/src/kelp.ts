import * as THREE from 'three';
import { Rng } from './rng';
import { KELP_MOTION_GLSL } from './kelp-motion';
import { depthTint, type Flora, type Species } from './flora';

// Everything that grows on the shelf, as one flat-shaded mesh. Each plant is a
// handful of flat quads and triangles with one colour per face, like the sand
// and rocks around it. The vertex shader bends them in the current, so the
// whole bed is one draw call and nothing is uploaded per frame.

export interface KelpPlant {
  x: number;
  y: number;
  z: number;
  height: number;
  seed: number;
  species: Species;
}

/** How limp each species is in the current: 1 follows it fully. */
const FLEX: Record<Species, number> = { giant: 1, ribbon: 0.85, broadleaf: 0.6, feather: 0.75 };
const DEEP = new THREE.Color('#1f5d6e');

type V3 = readonly [number, number, number];

/** Collects non-indexed triangles for one plant at a time. */
class Faces {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly roots: number[] = [];
  readonly shapes: number[] = [];
  private root: V3 = [0, 0, 0];
  private height = 1;
  private phase = 0;
  private flex = 1;
  private pigment = new THREE.Color();
  private tip = new THREE.Color();
  private readonly face = new THREE.Color();

  begin(plant: KelpPlant, pigment: THREE.Color, tip: THREE.Color, phase: number) {
    this.root = [plant.x, plant.y, plant.z];
    this.height = plant.height;
    this.phase = phase;
    this.flex = FLEX[plant.species];
    this.pigment = pigment;
    this.tip = tip;
  }

  /**
   * One triangle, corners relative to the root. `shade` scales the pigment, `young` (0..1)
   * leans it toward the tip colour, and each corner carries its distance from the stem.
   */
  tri(a: V3, b: V3, c: V3, shade: number, young: number, fa = 0, fb = 0, fc = 0) {
    const [rx, ry, rz] = this.root;
    const depth = -(ry + (a[1] + b[1] + c[1]) / 3);
    const [bright, blue] = depthTint(depth);
    this.face.copy(this.pigment).lerp(this.tip, young).multiplyScalar(shade * bright).lerp(DEEP, blue);
    const corners = [a, b, c];
    const flutter = [fa, fb, fc];
    for (let i = 0; i < 3; i++) {
      this.positions.push(rx + corners[i][0], ry + corners[i][1], rz + corners[i][2]);
      this.colors.push(this.face.r, this.face.g, this.face.b);
      this.roots.push(rx, ry, rz);
      this.shapes.push(this.height, flutter[i], this.phase, this.flex);
    }
  }

  /** A flat quad a-b-c-d (in order around it) as two triangles a shade apart, so it reads as two facets. */
  quad(a: V3, b: V3, c: V3, d: V3, shade: number, young: number, fa = 0, fb = 0, fc = 0, fd = 0) {
    this.tri(a, b, c, shade, young, fa, fb, fc);
    this.tri(a, c, d, shade * 0.93, young, fa, fc, fd);
  }
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const along = (a: V3, dir: V3, k: number): V3 => [a[0] + dir[0] * k, a[1] + dir[1] * k, a[2] + dir[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
/**
 * Dice for one blade or frond. How many rolls it takes depends on the detail
 * tier, so each gets its own: the rest of the plant comes out the same at every tier.
 */
const part = (plant: Rng) => new Rng(plant.int(1, 0x7fffffff));
/** A horizontal unit vector `yaw` radians off the x axis: blades this wide face the side-on camera. */
const flat = (yaw: number): V3 => [Math.cos(yaw), 0, Math.sin(yaw)];

/**
 * Giant kelp: a tall strap of kinked flat segments, narrowing upward, with a
 * triangular leaf at every third joint. The forest canopy on every map.
 */
function giant(faces: Faces, rng: Rng, h: number, detail: number) {
  const count = Math.max(3, Math.round(h / rng.range(1.4, 2.0)));
  const step = h / count;
  const width = rng.range(0.9, 1.25);
  const bend = rng.range(0.012, 0.03) * h * (rng.next() < 0.5 ? -1 : 1);
  const bendPhase = rng.range(0, Math.PI * 2);
  const turns = rng.range(0.8, 1.7);
  // The stalk wanders a little off the vertical, and every joint is a small kink.
  const node = (i: number): V3 => {
    const u = i / count;
    const kink = i === 0 || i === count ? 0 : (i % 2 ? 1 : -1) * step * 0.05;
    return [Math.sin(u * Math.PI * turns + bendPhase) * bend * u + kink, u * h, Math.cos(u * Math.PI * turns + bendPhase) * bend * u * 0.5];
  };
  let side = rng.next() < 0.5 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const u = i / count;
    const lo = node(i), hi = node(i + 1);
    const w = (0.5 * (1 - u) + 0.15) * width;
    // Each segment faces a slightly different way, so the strap catches the light joint by joint
    // without ever turning edge-on to the camera.
    const face = flat(rng.range(-0.55, 0.55));
    const shade = (0.74 + 0.36 * u) * rng.range(0.9, 1.1);
    const young = u * u * 0.3;
    if (i === count - 1) {
      // The last segment closes to a point.
      faces.tri(along(lo, face, -w / 2), along(lo, face, w / 2), add(hi, [0, step * 0.25, 0]), shade, young, -w * 0.3, w * 0.3, 0);
    } else {
      const top = w * 0.86;
      faces.quad(along(lo, face, -w / 2), along(lo, face, w / 2), along(hi, face, top / 2), along(hi, face, -top / 2),
        shade, young, -w * 0.3, w * 0.3, top * 0.3, -top * 0.3);
    }
    // Leaves grow on alternate sides.
    if (i % 3 !== 1 || i >= count - 1) continue;
    side = -side;
    const size = rng.range(0.45, 0.75) * (1 - 0.35 * u) * width;
    const at = rng.range(0.35, 0.7);
    const stem: V3 = [lo[0] + (hi[0] - lo[0]) * at, lo[1] + step * at, lo[2] + (hi[2] - lo[2]) * at];
    const yaw = rng.range(-0.5, 0.5);
    const tilt = rng.range(0.15, 0.6);
    const glow = rng.range(1.02, 1.2);
    const reach = size * 1.35;
    // The lowest tier keeps every other leaf. Its dice are rolled above either way.
    if (detail === 1 && i % 6 !== 1) continue;
    const tipAt: V3 = [
      stem[0] + side * Math.cos(tilt) * Math.cos(yaw) * reach,
      stem[1] + Math.sin(tilt) * reach,
      stem[2] + side * Math.cos(tilt) * Math.sin(yaw) * reach,
    ];
    faces.tri(add(stem, [0, -size * 0.45, 0]), tipAt, add(stem, [0, size * 0.45, 0]),
      shade * glow, young + 0.12, 0, side * reach, 0);
  }
}

/** Seagrass: a tuft of narrow blades that droop outward and end in a point. */
function ribbon(faces: Faces, plantRng: Rng, h: number, detail: number) {
  const rng = plantRng;
  const blades = rng.int(4, 7);
  const segments = detail === 1 ? 2 : 3;
  for (let b = 0; b < blades; b++) {
    const rng = part(plantRng);
    // The lowest tier keeps every other blade.
    if (detail === 1 && b % 2) continue;
    const length = h * rng.range(0.55, 1);
    const base: V3 = [rng.range(-0.22, 0.22), 0, rng.range(-0.22, 0.22)];
    const lean = rng.range(0, Math.PI * 2);
    const droop = length * rng.range(0.12, 0.38);
    const w0 = rng.range(0.2, 0.32) * (0.6 + 0.1 * h);
    const face = rng.range(-0.9, 0.9);
    const shade = rng.range(0.82, 1.12);
    const at = (t: number): V3 => {
      const out = droop * Math.pow(t, 1.8);
      return [base[0] + Math.cos(lean) * out, length * t * (1 - 0.1 * t), base[2] + Math.sin(lean) * out * 0.5];
    };
    for (let s = 0; s < segments; s++) {
      const t0 = s / segments, t1 = (s + 1) / segments;
      const lo = at(t0), hi = at(t1);
      const wLo = w0 * (1 - 0.7 * t0), wHi = w0 * (1 - 0.7 * t1);
      const dir = flat(face + rng.range(-0.25, 0.25));
      const tone = shade * (0.78 + 0.34 * t0);
      const young = 0.1 + t1 * 0.3;
      if (s === segments - 1) {
        faces.tri(along(lo, dir, -wLo / 2), along(lo, dir, wLo / 2), hi, tone, young, -wLo * 0.5, wLo * 0.5, 0.35 * t1);
      } else {
        faces.quad(along(lo, dir, -wLo / 2), along(lo, dir, wLo / 2), along(hi, dir, wHi / 2), along(hi, dir, -wHi / 2),
          tone, young, -wLo * 0.5 * t0, wLo * 0.5 * t0, wHi * 0.5 * t1, -wHi * 0.5 * t1);
      }
    }
  }
}

/** A broad-leaved kelp: a short stipe carrying a fan of wide blades, each folded along its midrib. */
function broadleaf(faces: Faces, rng: Rng, h: number, detail: number) {
  const stipe = h * rng.range(0.22, 0.35);
  const top: V3 = [rng.range(-0.1, 0.1), stipe, rng.range(-0.1, 0.1)];
  const sw = 0.09;
  faces.quad([-sw, 0, 0], [sw, 0, 0], add(top, [sw * 0.7, 0, 0]), add(top, [-sw * 0.7, 0, 0]), 0.62, 0);
  const blades = rng.int(4, 6);
  const fan = rng.range(0.95, 1.25);
  const start = rng.range(-0.15, 0.15);
  for (let b = 0; b < blades; b++) {
    // Spread the blades left to right across the camera plane, with a little depth.
    const angle = start + (blades === 1 ? 0 : (b / (blades - 1) - 0.5) * 2 * fan) + rng.range(-0.12, 0.12);
    const depth = rng.range(-0.45, 0.45);
    const dir = unit([Math.sin(angle) * Math.cos(depth), Math.cos(angle), Math.sin(depth) * 0.6]);
    const length = (h - stipe) * rng.range(0.8, 1.15);
    const width = length * rng.range(0.26, 0.36);
    const normal = flat(Math.PI / 2 + rng.range(-0.6, 0.6));
    const sideways = unit(cross(dir, normal));
    const up = unit(cross(sideways, dir));
    const fold = width * 0.14 * (rng.next() < 0.5 ? -1 : 1);
    const droop = length * rng.range(0.12, 0.28);
    const shade = rng.range(0.86, 1.1);
    // The lowest tier drops the blade's shoulder: a kite instead of a lance.
    const stations = detail === 1 ? [[0, 0.07], [0.42, 0.5], [1, 0]] : [[0, 0.07], [0.38, 0.5], [0.75, 0.36], [1, 0]];
    const rows = stations.map(([t, half]) => {
      const centre = add(along(top, dir, length * t), [0, -droop * t * t, 0]);
      return {
        t,
        left: along(centre, sideways, -width * half),
        mid: along(centre, up, fold * Math.sin(Math.PI * t)),
        right: along(centre, sideways, width * half),
        half: width * half,
      };
    });
    for (let r = 0; r < rows.length - 1; r++) {
      const lo = rows[r], hi = rows[r + 1];
      const tone = shade * (0.8 + 0.3 * lo.t);
      const young = 0.08 + hi.t * 0.32;
      if (r === rows.length - 2) {
        faces.tri(lo.left, lo.mid, hi.mid, tone * 0.86, young, -lo.half, 0, 0.3);
        faces.tri(lo.mid, lo.right, hi.mid, tone * 1.08, young, 0, lo.half, 0.3);
      } else {
        // The two halves of the fold catch the light differently.
        faces.quad(lo.left, lo.mid, hi.mid, hi.left, tone * 0.86, young, -lo.half, 0, 0, -hi.half);
        faces.quad(lo.mid, lo.right, hi.right, hi.mid, tone * 1.08, young, 0, lo.half, hi.half, 0);
      }
    }
  }
}

/** A sea fern: two or three arching stems with a pair of triangular leaflets at every joint. */
function feather(faces: Faces, plantRng: Rng, h: number, detail: number) {
  const rng = plantRng;
  const fronds = rng.int(2, 3);
  const joints = [4, 5, 6][detail - 1];
  const spread = rng.range(0, Math.PI * 2);
  for (let k = 0; k < fronds; k++) {
    const rng = part(plantRng);
    if (detail === 1 && k === 2) continue;
    const length = h * rng.range(0.7, 1);
    const lean = spread + (k / fronds) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const out = length * rng.range(0.1, 0.3);
    const curl = length * rng.range(0.1, 0.22);
    const normal = flat(Math.PI / 2 + rng.range(-0.5, 0.5));
    const shade = rng.range(0.85, 1.1);
    const at = (t: number): V3 => [
      Math.cos(lean) * (out * t + curl * t * t), length * t * (1 - 0.14 * t), Math.sin(lean) * (out * t + curl * t * t) * 0.5,
    ];
    for (let j = 0; j < joints; j++) {
      const t0 = j / joints, t1 = (j + 1) / joints;
      const lo = at(t0), hi = at(t1);
      const dir = unit([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]);
      const sideways = unit(cross(dir, normal));
      const w = 0.06 * (1 - 0.6 * t0) + 0.02;
      const tone = shade * (0.7 + 0.25 * t0);
      if (j === joints - 1) {
        // The stem ends in one last leaflet.
        const size = length * 0.11;
        faces.tri(along(lo, sideways, -size * 0.45), along(lo, sideways, size * 0.45), along(hi, dir, size * 0.3),
          tone * 1.25, 0.45, -size * 0.4, size * 0.4, size);
        continue;
      }
      faces.quad(along(lo, sideways, -w), along(lo, sideways, w), along(hi, sideways, w * 0.8), along(hi, sideways, -w * 0.8), tone, t0 * 0.2);
      // Leaflets are longest a third of the way up and shrink toward the tip.
      const reach = length * 0.24 * Math.pow(Math.sin(Math.PI * (0.12 + 0.8 * t1)), 0.7) * rng.range(0.85, 1.15);
      const base = (length / joints) * 0.3;
      for (const side of [-1, 1]) {
        const tipAt = add(hi, add(scale(sideways, side * reach * 0.82), scale(dir, reach * 0.57)));
        faces.tri(along(hi, dir, -base), tipAt, along(hi, dir, base),
          tone * (side < 0 ? 1.05 : 1.25), 0.15 + t1 * 0.35, 0, side * reach, 0);
      }
    }
  }
}

const BUILD: Record<Species, (faces: Faces, rng: Rng, h: number, detail: number) => void> = { giant, ribbon, broadleaf, feather };

/**
 * The rest pose of every plant. A plant's shape and colour come from its seed
 * alone, so a quality change keeps the same plants; `detail` only thins leaves
 * and blade segments.
 */
export function buildKelpGeometry(plants: readonly KelpPlant[], flora: Flora, detail: 1 | 2 | 3): THREE.BufferGeometry {
  const faces = new Faces();
  const tip = new THREE.Color(flora.tip);
  const pigment = new THREE.Color();
  for (const plant of plants) {
    if (!(plant.height > 0)) continue;
    const rng = new Rng(plant.seed);
    pigment.set(rng.pick(flora.pigments[plant.species])).offsetHSL(rng.range(-0.012, 0.012), 0, rng.range(-0.03, 0.03));
    faces.begin(plant, pigment, tip, rng.range(0, Math.PI * 2));
    BUILD[plant.species](faces, rng, plant.height, detail);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(faces.colors, 3));
  geometry.setAttribute('aKelpRoot', new THREE.Float32BufferAttribute(faces.roots, 3));
  geometry.setAttribute('aKelpShape', new THREE.Float32BufferAttribute(faces.shapes, 4));
  geometry.computeVertexNormals();
  return geometry;
}

export interface KelpCurrent {
  /** 0 calm to 1 storm. */
  wind: number;
  /** The surface's wave clock and how far (m) the swell moves water at the surface. */
  waveTime: number;
  surge: number;
}

/** The planted bed: one mesh, swayed on the GPU. */
export class KelpBed {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly uniforms = {
    uKelpTime: { value: 0 },
    uKelpFlow: { value: new THREE.Vector4(1, 0, 0, 0) },
    uKelpSurge: { value: 0 },
    uKelpDiver: { value: new THREE.Vector3(0, 100, 0) },
    uKelpWake: { value: new THREE.Vector3() },
  };

  constructor(plants: readonly KelpPlant[], flora: Flora, detail: 1 | 2 | 3) {
    const material = new THREE.MeshStandardMaterial({
      color: '#ffffff', vertexColors: true, flatShading: true, roughness: 0.9, side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aKelpRoot;
          attribute vec4 aKelpShape;
          ${KELP_MOTION_GLSL}
        `)
        // Flat shading takes its normals from the moved triangles, so a blade
        // changes shade as it turns in the current.
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed += kelpOffset(position, aKelpRoot, aKelpShape);
        `);
    };
    material.customProgramCacheKey = () => 'deepbreath-kelp-bed-v1';
    this.mesh = new THREE.Mesh(buildKelpGeometry(plants, flora, detail), material);
    this.mesh.name = 'kelp-bed';
    // The bed spans the whole shelf and its tips travel; one draw call is cheaper than tracking its bounds.
    this.mesh.frustumCulled = false;
  }

  /** Move the current on to `time`. The direction drifts slowly and the strength comes in gusts. */
  update(time: number, current: KelpCurrent) {
    const heading = 0.3 * Math.sin(time * 0.05) + 0.14 * Math.sin(time * 0.13 + 1);
    const gust = 0.5 + 0.5 * Math.sin(time * 0.21 + 0.8 * Math.sin(time * 0.057));
    const strength = THREE.MathUtils.clamp(current.wind * (0.7 + 0.3 * gust) + 0.1 * gust, 0, 1);
    this.uniforms.uKelpTime.value = time;
    this.uniforms.uKelpFlow.value.set(Math.cos(heading), Math.sin(heading), strength, current.waveTime);
    this.uniforms.uKelpSurge.value = current.surge;
  }

  /** Where the diver is and how fast they swim, so nearby plants part around them. `stir` is 0..1. */
  setDiver(position: THREE.Vector3, velocity: THREE.Vector3, stir: number) {
    this.uniforms.uKelpDiver.value.copy(position);
    this.uniforms.uKelpWake.value.set(velocity.x, velocity.y, stir);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

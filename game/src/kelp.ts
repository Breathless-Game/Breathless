import * as THREE from 'three';
import { Rng } from './rng';
import { KELP_MOTION_GLSL } from './kelp-motion';

export type KelpType = 'ribbon' | 'legacy' | 'frond';

export interface KelpPlant {
  x: number;
  y: number;
  z: number;
  height: number;
  seed: number;
  /** Optional explicit form for a specimen display; habitat plants use their seed. */
  type?: KelpType;
}

interface KelpOptions {
  plants: readonly KelpPlant[];
  hue: readonly [number, number];
  detail: 1 | 2 | 3;
  palette?: readonly string[];
}

interface Frond {
  base: THREE.Vector3;
  height: number;
  width: number;
  reach: number;
  angle: number;
  curl: number;
  arc: number;
  twist: number;
  shade: number;
  strap?: boolean;
}

/** Most growth stays long and narrow; broad fronds are accents within a bed. */
export function kelpTypeForSeed(seed: number): KelpType {
  const sample = new Rng(seed ^ 0x6b656c70).next();
  return sample < 0.55 ? 'ribbon' : sample < 0.85 ? 'legacy' : 'frond';
}

/** All three forms share a single GPU-deformed mesh, including the older
 * segmented straps. Root and branch motion cannot separate at a hinge. */
export class KelpField {
  readonly group = new THREE.Group();
  private readonly uniforms = {
    uKelpTime: { value: 0 },
    uKelpWind: { value: 0 },
  };
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;

  constructor({ plants, hue, detail, palette }: KelpOptions) {
    this.group.name = 'kelp-field';
    this.geometry = buildKelpGeometry(plants, hue, detail, palette);
    this.material = new THREE.MeshStandardMaterial({
      color: '#ffffff', vertexColors: true, side: THREE.DoubleSide,
      flatShading: true, roughness: 0.83, metalness: 0,
    });
    this.material.name = 'sculpted-kelp';
    // SceneColorGrade wraps this hook and keeps the shader uniforms shared.
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        uniform float uKelpTime;
        uniform float uKelpWind;
        attribute vec4 aKelpMotion;
        ${KELP_MOTION_GLSL}
      `).replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += kelpDisplacement(aKelpMotion.x, aKelpMotion.y, aKelpMotion.z,
          uKelpTime, uKelpWind, aKelpMotion.w);
      `);
      // FLAT_SHADED uses displaced view-space positions, so the colored
      // planes change their lighting continuously as the ribbons bend.
    };
    this.material.customProgramCacheKey = () => 'deepbreath-kelp-three-forms-v2';
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.name = 'kelp-ribbons';
    this.group.add(mesh);
  }

  update(time: number, wind: number): void {
    if (Number.isFinite(time)) this.uniforms.uKelpTime.value = time;
    if (Number.isFinite(wind)) this.uniforms.uKelpWind.value = THREE.MathUtils.clamp(wind, 0, 1);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}

/** Seeded traits and attachment heights do not depend on tessellation or
 * palette, so changing quality or biome does not regrow a different plant. */
export function buildKelpGeometry(
  plants: readonly KelpPlant[], hue: readonly [number, number], detail: 1 | 2 | 3,
  palette?: readonly string[],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const motion: number[] = [];
  const indices: number[] = [];
  const segments = [5, 8, 11][detail - 1];
  const color = new THREE.Color();
  const youngTip = new THREE.Color('#bdd875');
  let tallest = 0;

  for (const plant of plants) {
    if (!Number.isFinite(plant.height) || plant.height <= 0) continue;
    const type = plant.type ?? kelpTypeForSeed(plant.seed);
    const rng = new Rng(plant.seed);
    const pigmentRng = new Rng(plant.seed ^ 0x7069676d);
    const h = plant.height;
    tallest = Math.max(tallest, h);
    const pigment = palette?.length
      ? new THREE.Color(pigmentRng.pick(palette))
      : new THREE.Color().setHSL(pigmentRng.range(hue[0], hue[1]), 0.70, pigmentRng.range(0.34, 0.43));
    const tint = { h: 0, s: 0, l: 0 };
    pigment.getHSL(tint);
    pigment.setHSL(tint.h + pigmentRng.range(-0.014, 0.014), Math.min(0.86, tint.s + 0.035),
      tint.l * pigmentRng.range(0.92, 1.12));
    const phase = plant.x * 0.057 + plant.z * 0.083 + rng.range(-0.8, 0.8);
    const facing = rng.range(-0.75, 0.75);
    const primary: Frond = {
      base: new THREE.Vector3(), height: h,
      width: h * rng.range(type === 'frond' ? 0.065 : 0.024, type === 'frond' ? 0.09 : 0.037),
      reach: h * rng.range(-0.075, 0.075), angle: facing,
      curl: rng.range(0.035, 0.065) * h * (rng.next() < 0.5 ? -1 : 1), arc: 0,
      twist: rng.range(-0.5, 0.5), shade: 1, strap: type !== 'frond',
    };
    const center = (frond: Frond, t: number) => {
      const reach = frond.reach * (frond.arc > 1 ? t * (0.72 + 0.28 * t) : t * t);
      const ribbonCurve = Math.sin(t * Math.PI * 1.65) * t * frond.curl;
      const lift = frond.arc > 0 ? Math.sin(t * frond.arc) / Math.sin(frond.arc) : t;
      return new THREE.Vector3(
        frond.base.x + Math.cos(frond.angle) * (reach + ribbonCurve),
        frond.base.y + frond.height * lift,
        frond.base.z + Math.sin(frond.angle) * reach + Math.sin(t * Math.PI) * frond.curl * 0.28,
      );
    };
    const spreadAt = (frond: Frond, t: number) => frond.width * (frond.strap
      ? Math.pow(Math.sin(Math.PI * t), 0.23) * (1 - 0.48 * t)
      : Math.pow(Math.sin(Math.PI * t), 0.52) * (1 - 0.12 * t));
    const midrib = (frond: Frond, t: number) => {
      const c = center(frond, t);
      const ridge = spreadAt(frond, t) * 0.18;
      const angle = frond.angle + frond.twist * t;
      c.x += Math.sin(angle) * ridge;
      c.z -= Math.cos(angle) * ridge;
      return c;
    };
    const addVertex = (c: THREE.Vector3, fraction: number, edge: number, shade: number, side: number) => {
      const id = positions.length / 3;
      positions.push(plant.x + c.x, plant.y + c.y, plant.z + c.z);
      // Strong pigment differences across the midrib preserve the original
      // colorful polygon look. There is no time-dependent color noise.
      const plane = side < 0 ? 0.74 : side > 0 ? 1.20 : 1.01;
      const band = 0.92 + 0.12 * Math.sin(fraction * Math.PI * 5 + phase);
      color.copy(pigment).multiplyScalar(shade * plane * band * (0.72 + fraction * 0.42));
      color.lerp(youngTip, fraction * (side > 0 ? 0.12 : 0.035));
      colors.push(color.r, color.g, color.b);
      motion.push(h, fraction, phase, edge);
      return id;
    };
    const addFrond = (frond: Frond, count: number, joints: readonly number[] = []) => {
      const rows: number[][] = [];
      const times = [...new Set([...Array.from({ length: count + 1 }, (_, row) => row / count), ...joints])].sort((a, b) => a - b);
      for (let row = 0; row < times.length; row++) {
        const t = times[row];
        const c = center(frond, t);
        const endpoint = row === 0 || row === times.length - 1;
        const spread = spreadAt(frond, t);
        const angle = frond.angle + frond.twist * t;
        const offsets = endpoint ? [0] : [-1, 0, 1];
        const ids: number[] = [];
        for (const side of offsets) {
          const ridge = endpoint ? 0 : (side === 0 ? spread * 0.18 : 0);
          const width = side * spread * 0.5;
          const position = new THREE.Vector3(c.x + Math.cos(angle) * width + Math.sin(angle) * ridge,
            c.y, c.z + Math.sin(angle) * width - Math.cos(angle) * ridge);
          const fraction = THREE.MathUtils.clamp(c.y / h, 0, 1);
          ids.push(addVertex(position, fraction, width * t, frond.shade, side));
        }
        rows.push(ids);
      }
      for (let row = 0; row < rows.length - 1; row++) {
        const a = rows[row], b = rows[row + 1];
        if (a.length === 1) indices.push(a[0], b[0], b[1], a[0], b[1], b[2]);
        else if (b.length === 1) indices.push(a[0], b[0], a[1], a[1], b[0], a[2]);
        else {
          for (let wing = 0; wing < 2; wing++) {
            if ((row + wing) % 2) indices.push(a[wing], b[wing], a[wing + 1], a[wing + 1], b[wing], b[wing + 1]);
            else indices.push(a[wing], b[wing], b[wing + 1], a[wing], b[wing + 1], a[wing + 1]);
          }
        }
      }
    };

    if (type === 'ribbon') {
      // Eelgrass-like narrow blades: a loose tuft of three flowing straps.
      // All three silhouettes remain present even on the lowest tier.
      addFrond(primary, segments + 2);
      for (let f = 0; f < 2; f++) {
        const side = f === 0 ? -1 : 1;
        const sub: Frond = {
          base: new THREE.Vector3(), height: h * rng.range(0.62, 0.89),
          width: primary.width * rng.range(0.65, 0.95), reach: h * side * rng.range(0.065, 0.13),
          angle: facing + rng.range(-0.5, 0.5), curl: h * rng.range(0.03, 0.06) * -side,
          arc: 0, twist: side * rng.range(0.35, 0.75), shade: rng.range(0.85, 1.15), strap: true,
        };
        addFrond(sub, segments + 1);
      }
    } else if (type === 'legacy') {
      // The original tall strap and small triangular side leaves, with shared
      // joints instead of individually rotating planes and detached hinges.
      const attachments = Array.from({ length: 6 }, (_, f) => 0.18 + f * 0.115 + rng.range(-0.018, 0.018));
      const leaves = attachments.map((t, f) => ({
        t, side: f % 2 ? 1 : -1, length: h * rng.range(0.036, 0.057),
        angle: facing + rng.range(-0.25, 0.25), lift: rng.range(0.15, 0.5),
      }));
      const joints = leaves.flatMap(leaf => [leaf.t, leaf.t + leaf.length * 0.60 / h]);
      addFrond(primary, [8, 12, 16][detail - 1], joints);
      for (const { t, side, length, angle, lift } of leaves) {
        const base = midrib(primary, t);
        const tip = base.clone().add(new THREE.Vector3(Math.cos(angle) * side * length,
          length * lift, Math.sin(angle) * side * length));
        const upper = midrib(primary, t + length * 0.60 / h);
        // Both leaf roots use the parent's midrib and exact height field.
        const a = addVertex(base, t, 0, 1.05, 0);
        const b = addVertex(tip, tip.y / h, side * length * 0.3, 1.15, side);
        const c = addVertex(upper, upper.y / h, 0, 0.86, -side);
        indices.push(a, b, c);
      }
    } else {
      const attachments = Array.from({ length: 6 }, (_, f) => 0.19 + f * 0.105 + rng.range(-0.023, 0.023));
      addFrond(primary, segments, attachments);
      for (let f = 0; f < 2; f++) {
        const side = f === 0 ? -1 : 1;
        addFrond({
          base: new THREE.Vector3(), height: h * rng.range(0.52, 0.79),
          width: primary.width * rng.range(0.78, 1.05), reach: h * side * rng.range(0.14, 0.23),
          angle: facing + rng.range(-0.3, 0.3), curl: h * rng.range(0.045, 0.085) * -side,
          arc: rng.range(0.65, 1.0), twist: side * rng.range(0.25, 0.65), shade: rng.range(0.91, 1.1),
        }, Math.max(4, segments - 2));
      }
      for (let f = 0; f < 6; f++) {
        const t = attachments[f];
        const side = f % 2 ? 1 : -1;
        addFrond({
          base: midrib(primary, t), height: h * rng.range(0.095, 0.17) * (1 - t * 0.28),
          width: primary.width * rng.range(0.62, 0.85), reach: side * h * rng.range(0.13, 0.21),
          angle: facing + rng.range(-0.4, 0.4), curl: h * rng.range(-0.015, 0.015),
          arc: rng.range(1.65, 2.2), twist: side * rng.range(0.4, 0.9), shade: rng.range(0.96, 1.14),
        }, Math.max(3, segments - 5));
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aKelpMotion', new THREE.Float32BufferAttribute(motion, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  if (geometry.boundingBox && positions.length) {
    geometry.boundingBox.expandByVector(new THREE.Vector3(tallest * 0.22, tallest * 0.03, tallest * 0.055));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  }
  return geometry;
}

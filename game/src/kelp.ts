import * as THREE from 'three';
import { Rng } from './rng';
import { KELP_MOTION_GLSL } from './kelp-motion';

export interface KelpPlant {
  x: number;
  y: number;
  z: number;
  height: number;
  seed: number;
}

interface KelpOptions {
  plants: readonly KelpPlant[];
  hue: readonly [number, number];
  detail: 1 | 2 | 3;
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
}

/** Sculpted ribbons with a raised midrib. One mesh and one material for the
 * whole bed; no hierarchy of hinges, per-frame vertex uploads, or alpha cards. */
export class KelpField {
  readonly group = new THREE.Group();
  private readonly uniforms = {
    uKelpTime: { value: 0 },
    uKelpWind: { value: 0 },
  };
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;

  constructor({ plants, hue, detail }: KelpOptions) {
    this.group.name = 'kelp-field';
    this.geometry = buildKelpGeometry(plants, hue, detail);
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
      // Three's FLAT_SHADED path derives face normals from the displaced
      // view-space positions. The ridge therefore changes light as it bends.
    };
    this.material.customProgramCacheKey = () => 'deepbreath-kelp-ribbons-v1';
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

/** Exported for topology and device-budget checks. Positions are baked in
 * world space so nearby plants can share one spatially coherent current. */
export function buildKelpGeometry(plants: readonly KelpPlant[], hue: readonly [number, number], detail: 1 | 2 | 3): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const motion: number[] = [];
  const indices: number[] = [];
  const segments = [6, 9, 12][detail - 1];
  const color = new THREE.Color();
  let tallest = 0;

  for (const plant of plants) {
    if (!Number.isFinite(plant.height) || plant.height <= 0) continue;
    const rng = new Rng(plant.seed);
    const h = plant.height;
    tallest = Math.max(tallest, h);
    const plantHue = rng.range(hue[0], hue[1]);
    const lightness = rng.range(0.30, 0.40);
    const phase = plant.x * 0.057 + plant.z * 0.083 + rng.range(-0.24, 0.24);
    const facing = rng.range(-0.65, 0.65);
    const primary: Frond = {
      base: new THREE.Vector3(), height: h, width: Math.max(0.22, h * rng.range(0.075, 0.105)),
      reach: h * rng.range(-0.12, 0.12), angle: facing,
      curl: rng.range(0.075, 0.12) * h * (rng.next() < 0.5 ? -1 : 1), arc: 0,
      twist: rng.range(-0.45, 0.45), shade: 1,
    };
    const center = (frond: Frond, t: number) => {
      const reach = frond.reach * (frond.arc > 1 ? t * (0.72 + 0.28 * t) : t * t);
      const ribbonCurve = Math.sin(t * Math.PI * 1.4) * t * frond.curl;
      const lift = frond.arc > 0 ? Math.sin(t * frond.arc) / Math.sin(frond.arc) : t;
      return new THREE.Vector3(
        frond.base.x + Math.cos(frond.angle) * (reach + ribbonCurve),
        frond.base.y + frond.height * lift,
        frond.base.z + Math.sin(frond.angle) * reach + Math.sin(t * Math.PI) * frond.curl * 0.28,
      );
    };
    const attachments = Array.from({ length: 6 }, (_, f) => 0.19 + f * 0.105 + rng.range(-0.023, 0.023));
    const addFrond = (frond: Frond, count: number, joints: readonly number[] = []) => {
      const rows: number[][] = [];
      const times = [...new Set([...Array.from({ length: count + 1 }, (_, row) => row / count), ...joints])].sort((a, b) => a - b);
      for (let row = 0; row < times.length; row++) {
        const t = times[row];
        const c = center(frond, t);
        const endpoint = row === 0 || row === times.length - 1;
        const spread = frond.width * Math.pow(Math.sin(Math.PI * t), 0.52) * (1 - 0.12 * t);
        const angle = frond.angle + frond.twist * t;
        const offsets = endpoint ? [0] : [-1, 0, 1];
        const ids: number[] = [];
        for (const side of offsets) {
          ids.push(positions.length / 3);
          const ridge = endpoint ? 0 : (side === 0 ? spread * 0.18 : 0);
          const width = side * spread * 0.5;
          positions.push(plant.x + c.x + Math.cos(angle) * width + Math.sin(angle) * ridge,
            plant.y + c.y, plant.z + c.z + Math.sin(angle) * width - Math.cos(angle) * ridge);
          const fraction = THREE.MathUtils.clamp(c.y / h, 0, 1);
          // Directional pigment follows the leaf, with greener young tips and
          // two quietly distinct planes either side of the central ridge.
          color.setHSL(plantHue - 0.022 * fraction, 0.51,
            lightness * frond.shade * (0.67 + 0.33 * fraction) * (side < 0 ? 0.92 : 1.035));
          colors.push(color.r, color.g, color.b);
          motion.push(h, fraction, phase, width * t);
        }
        rows.push(ids);
      }
      for (let row = 0; row < rows.length - 1; row++) {
        const a = rows[row], b = rows[row + 1];
        if (a.length === 1) indices.push(a[0], b[0], b[1], a[0], b[1], b[2]);
        else if (b.length === 1) indices.push(a[0], b[0], a[1], a[1], b[0], a[2]);
        else {
          // Alternate triangle diagonals rather than repeating a zipper edge.
          for (let wing = 0; wing < 2; wing++) {
            if ((row + wing) % 2) indices.push(a[wing], b[wing], a[wing + 1], a[wing + 1], b[wing], b[wing + 1]);
            else indices.push(a[wing], b[wing], b[wing + 1], a[wing], b[wing + 1], a[wing + 1]);
          }
        }
      }
    };

    addFrond(primary, segments, attachments);
    // The same two outer fronds survive every quality tier; higher tiers add
    // supporting growth without changing the silhouette's dominant stems.
    for (let f = 0; f < 2; f++) {
      const side = f === 0 ? -1 : 1;
      const sub: Frond = {
        base: new THREE.Vector3(), height: h * rng.range(0.52, 0.79),
        width: primary.width * rng.range(0.78, 1.05), reach: h * side * rng.range(0.14, 0.23),
        angle: facing + rng.range(-0.3, 0.3), curl: h * rng.range(0.045, 0.085) * -side,
        arc: rng.range(0.65, 1.0),
        twist: side * rng.range(0.25, 0.65), shade: rng.range(0.91, 1.1),
      };
      addFrond(sub, Math.max(4, segments - 2));
    }
    // Smaller lance-shaped side fronds grow from the main ribbon's midrib.
    // Attachment heights and random numbers are independent of quality.
    for (let f = 0; f < 6; f++) {
      const t = attachments[f];
      const side = f % 2 ? 1 : -1;
      const base = center(primary, t);
      // Match the actual raised centre line of the parent ribbon.
      const ridge = primary.width * Math.pow(Math.sin(Math.PI * t), 0.52) * (1 - 0.12 * t) * 0.18;
      base.x += Math.sin(primary.angle + primary.twist * t) * ridge;
      base.z -= Math.cos(primary.angle + primary.twist * t) * ridge;
      const sub: Frond = {
        base, height: h * rng.range(0.095, 0.17) * (1 - t * 0.28),
        width: primary.width * rng.range(0.62, 0.85), reach: side * h * rng.range(0.13, 0.21),
        angle: facing + rng.range(-0.4, 0.4), curl: h * rng.range(-0.015, 0.015),
        arc: rng.range(1.65, 2.2),
        twist: side * rng.range(0.4, 0.9), shade: rng.range(0.96, 1.14),
      };
      if (detail === 3 || f % (detail === 1 ? 3 : 2) === 0) addFrond(sub, Math.max(3, segments - 5));
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
    // Account for the maximum shader bend, including storm strength; do not
    // let frustum culling remove a tip that sways beyond the undeformed mesh.
    geometry.boundingBox.expandByVector(new THREE.Vector3(tallest * 0.17, tallest * 0.02, tallest * 0.04));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  }
  return geometry;
}

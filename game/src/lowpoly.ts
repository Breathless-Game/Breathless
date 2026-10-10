import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Rng } from './rng';

// Shared building blocks for the low-poly look: flat-shaded materials, rocky
// vertex jitter, per-face colouring, and a batcher that keeps scenery cheap.

export function flatMat(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, ...extra });
}

/** Jitter vertices of a non-indexed geometry so primitives read as rocks. */
export function jitter(geo: THREE.BufferGeometry, rng: Rng, amount: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let off = seen.get(key);
    if (!off) {
      off = new THREE.Vector3(rng.range(-amount, amount), rng.range(-amount, amount), rng.range(-amount, amount));
      seen.set(key, off);
    }
    pos.setXYZ(i, pos.getX(i) + off.x, pos.getY(i) + off.y, pos.getZ(i) + off.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Colour each triangle by how high its centre sits (0 = bottom, 1 = top), e.g.
 * rock below and snow above. Expects non-indexed geometry, as `jitter` returns.
 */
export function paintFaces(geo: THREE.BufferGeometry, pick: (height: number) => THREE.Color) {
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox!;
  const span = Math.max(1e-6, max.y - min.y);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const c = pick((y - min.y) / span);
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** A pyramid with a `w` × `d` rectangular base and height `h`, base centred on the origin. */
export function pyramid(w: number, h: number, d: number) {
  const geo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
  geo.rotateY(Math.PI / 4);
  geo.translate(0, 0.5, 0);
  geo.scale(w, h, d);
  return geo;
}

export interface Placement {
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

/**
 * Bakes many static pieces into one mesh per material. A backdrop of a few
 * hundred trees and rocks then costs a handful of draw calls instead of one each.
 */
export class Batch {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private euler = new THREE.Euler();

  /** Takes ownership of `geo`. Every piece sharing a material must carry the same attributes. */
  add(geo: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, o: Placement = {}) {
    let g = geo;
    if (geo.index) {
      g = geo.toNonIndexed();
      geo.dispose();
    }
    g.deleteAttribute('uv');
    this.quat.setFromEuler(this.euler.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0));
    this.matrix.compose(new THREE.Vector3(x, y, z), this.quat, new THREE.Vector3(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    g.applyMatrix4(this.matrix);
    const list = this.parts.get(material);
    if (list) list.push(g);
    else this.parts.set(material, [g]);
  }

  build(): THREE.Group {
    const group = new THREE.Group();
    for (const [material, geos] of this.parts) {
      const merged = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      if (merged) group.add(new THREE.Mesh(merged, material));
    }
    this.parts.clear();
    return group;
  }
}

/** Free the GPU buffers of everything under `root`. */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.geometry) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
  });
}

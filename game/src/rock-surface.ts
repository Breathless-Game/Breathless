import * as THREE from 'three';
import { jitter } from './lowpoly';
import type { Rng } from './rng';

/** Keep the rendered bounds equal to the dimensions used to settle and stack rocks. */
export function rockGeometry(rng: Rng, radius: number, detail: number, squash: number) {
  const geo = jitter(new THREE.DodecahedronGeometry(1, detail), rng, 0.12);
  // Broad bedding faces, with varied bearings, rather than arbitrarily upright boulders.
  geo.rotateX(rng.range(-0.4, 0.4)).rotateY(rng.range(0, Math.PI * 2)).rotateZ(rng.range(-0.3, 0.3));
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  geo.translate(-centre.x, -centre.y, -centre.z);
  geo.scale(2 * radius / size.x, 2 * radius * squash / size.y, 2 * radius / size.z);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

/** Algae grows in coherent patches on lit, upward-facing rock, fading into deep water. */
export function mossCoverage(depth: number, normalY: number, height: number, x: number, z: number, seed: number) {
  const light = 1 - THREE.MathUtils.smoothstep(depth, 12, 85);
  const facing = THREE.MathUtils.smoothstep(normalY, 0.15, 0.8);
  const upper = THREE.MathUtils.smoothstep(height, 0.35, 0.75);
  const phase = (seed % 997) * 0.013;
  const patch = 0.5 + 0.28 * Math.sin(x * 0.65 + phase) * Math.cos(z * 0.7 - phase)
    + 0.18 * Math.sin(x * 1.9 + z * 1.4 + phase);
  return light * facing * upper * THREE.MathUtils.smoothstep(patch, 0.38, 0.7);
}

/** Vertex colours coat the actual facets, with no floating moss mesh or extra draw call. */
export function paintRock(geo: THREE.BufferGeometry, base: THREE.Color, moss: THREE.Color,
  origin: { x: number; y: number; z: number }, seed: number) {
  const pos = geo.attributes.position;
  const box = geo.boundingBox!;
  const span = box.max.y - box.min.y;
  const colours = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const normal = new THREE.Vector3(), edge = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize();
    const x = origin.x + (a.x + b.x + c.x) / 3;
    const y = origin.y + (a.y + b.y + c.y) / 3;
    const z = origin.z + (a.z + b.z + c.z) / 3;
    const h = ((a.y + b.y + c.y) / 3 - box.min.y) / span;
    const variation = 0.94 + 0.06 * Math.sin(x * 2.7 + y * 1.3 + z * 3.1);
    tint.copy(base).multiplyScalar((0.72 + 0.28 * h) * variation);
    tint.lerp(moss, mossCoverage(-y, normal.y, h, x, z, seed) * 0.8);
    for (let v = 0; v < 3; v++) tint.toArray(colours, (i + v) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geo;
}

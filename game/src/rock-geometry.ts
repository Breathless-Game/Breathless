import * as THREE from 'three';
import type { Rng } from './rng';

type Face = THREE.Vector3[];
const EPSILON = 1e-7;

/** Clip a closed convex stone against one fracture plane, including its new cap. */
function fracture(faces: Face[], normal: THREE.Vector3, distance: number): Face[] {
  const kept: Face[] = [];
  const rim = new Map<string, THREE.Vector3>();
  // Reuse every edge intersection in both adjacent polygons. Besides avoiding
  // cracks, this leaves exactly the same corner for the final flat-shaded copies.
  const intersections = new Map<string, THREE.Vector3>();
  const key = (p: THREE.Vector3) => `${p.x.toFixed(7)},${p.y.toFixed(7)},${p.z.toFixed(7)}`;
  for (const face of faces) {
    const polygon: Face = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      const da = normal.dot(a) - distance, db = normal.dot(b) - distance;
      if (da <= EPSILON) polygon.push(a);
      if ((da < -EPSILON && db > EPSILON) || (da > EPSILON && db < -EPSILON)) {
        const edge = [key(a), key(b)].sort().join(':');
        let cut = intersections.get(edge);
        if (!cut) {
          cut = a.clone().lerp(b, da / (da - db));
          intersections.set(edge, cut);
        }
        polygon.push(cut);
        rim.set(key(cut), cut);
      } else if (Math.abs(da) <= EPSILON) rim.set(key(a), a);
    }
    if (polygon.length >= 3) kept.push(polygon);
  }
  if (rim.size >= 3) {
    const cap = [...rim.values()];
    const centre = cap.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(cap.length);
    const u = new THREE.Vector3().crossVectors(normal,
      Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u);
    cap.sort((a, b) => {
      const ax = a.x - centre.x, ay = a.y - centre.y, az = a.z - centre.z;
      const bx = b.x - centre.x, by = b.y - centre.y, bz = b.z - centre.z;
      return Math.atan2(ax * v.x + ay * v.y + az * v.z, ax * u.x + ay * u.y + az * u.z)
        - Math.atan2(bx * v.x + by * v.y + bz * v.z, bx * u.x + by * u.y + bz * u.z);
    });
    kept.push(cap);
  }
  return kept;
}

/**
 * A bedded, fractured boulder. Large planes establish the silhouette; optional
 * small corner chips add detail without turning it into a noisy icosphere.
 * The mesh is closed, with flat face normals and an exact, transformed bound.
 */
export function rockGeometry(rng: Rng, r: number, detail: number, squash: number): THREE.BufferGeometry {
  const corners = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ].map(([x, y, z]) => new THREE.Vector3(x * 2, y * 2, z * 2));
  let faces: Face[] = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5],
  ].map(indices => indices.map(i => corners[i]));

  // Bedding planes are broad and nearly parallel. Individual rock proportions
  // and fracture offsets vary coherently, instead of moving triangle vertices.
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const normal = new THREE.Vector3(rng.range(-0.13, 0.13), rng.range(-0.1, 0.1), rng.range(-0.13, 0.13));
      normal.setComponent(axis, sign).normalize();
      const offset = axis === 1 ? rng.range(0.66, 0.83) : rng.range(0.78, 1.02);
      faces = fracture(faces, normal, offset);
    }
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const normal = new THREE.Vector3(x * rng.range(0.65, 0.95), y * rng.range(0.65, 0.95), z * rng.range(0.65, 0.95)).normalize();
    faces = fracture(faces, normal, rng.range(0.93, 1.12));
  }

  // Capture the same family transform before optional detail consumes RNG, so
  // switching detail preserves the boulder's main shape, pose and proportions.
  const scale = new THREE.Vector3(rng.range(0.9, 1.16), squash * rng.range(0.9, 1.05), rng.range(0.72, 1.04)).multiplyScalar(r);
  const rotation = new THREE.Euler(rng.range(-0.17, 0.17), rng.range(0, Math.PI * 2), rng.range(-0.14, 0.14));
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(rotation), scale);

  if (detail > 0) {
    // Chip the exposed corners only. The support-plane construction remains
    // convex, watertight and inexpensive; all large faces retain their identity.
    const unique = [...new Set(faces.flat())];
    const candidates = unique.sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x) || a.y - b.y);
    const count = Math.min(12, candidates.length);
    for (let i = 0; i < count; i++) {
      const corner = candidates[Math.floor(i * candidates.length / count)];
      const normal = corner.clone().normalize();
      const support = Math.max(...faces.flat().map(p => normal.dot(p)));
      faces = fracture(faces, normal, support - rng.range(0.025, 0.065));
    }
  }

  // Transform unique corners once. Non-indexed triangles intentionally share
  // positions but keep independent normals for crisp, broad planar lighting.
  for (const corner of new Set(faces.flat())) corner.applyMatrix4(transform);
  const positions: number[] = [];
  for (const face of faces) {
    for (let i = 1; i < face.length - 1; i++) {
      for (const corner of [face[0], face[i], face[i + 1]]) positions.push(corner.x, corner.y, corner.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

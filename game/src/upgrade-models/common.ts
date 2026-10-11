import * as THREE from 'three';
import type { UpgradeLevel } from '../upgrades';

export type Point = [number, number, number];

export function material(color: THREE.ColorRepresentation, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.86, ...options });
}

/** Each model owns its materials, so disposing a preview cannot affect others. */
export function palette(level: UpgradeLevel) {
  return {
    body: material(['#78604a', '#626a6d', '#343a3c'][level - 1]),
    metal: material('#8a9193', { metalness: 0.45, roughness: 0.72 }),
    accent: material(['#938169', '#697770', '#79745c'][level - 1]),
    rubber: material('#2b2e2c', { roughness: 0.96 }),
    wood: material('#846141', { roughness: 0.92 }),
    glass: material('#586364', { metalness: 0.12, roughness: 0.48 }),
    line: material('#515951', { roughness: 0.96 }),
  };
}

export function mesh(group: THREE.Group, geometry: THREE.BufferGeometry, surface: THREE.Material, at: Point = [0, 0, 0], name?: string) {
  const object = new THREE.Mesh(geometry, surface);
  object.castShadow = true;
  object.receiveShadow = true;
  object.position.set(...at);
  if (name) object.name = name;
  group.add(object);
  return object;
}

export function beam(group: THREE.Group, a: Point, b: Point, radius: number, surface: THREE.Material, sides = 8) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const delta = end.clone().sub(start);
  const object = mesh(group, new THREE.CylinderGeometry(radius, radius, delta.length(), sides), surface);
  object.position.copy(start).add(end).multiplyScalar(0.5);
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return object;
}

export function tube(group: THREE.Group, points: Point[], radius: number, surface: THREE.Material, sides = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), closed, 'centripetal');
  return mesh(group, new THREE.TubeGeometry(curve, Math.max(points.length * 3, 12), radius, sides, closed), surface);
}

/** Torus starts in XY: axis Z. Cylinder starts along Y. */
export function ring(group: THREE.Group, radius: number, thickness: number, surface: THREE.Material, at: Point, axis: 'x' | 'y' | 'z' = 'z', sides = 8) {
  const object = mesh(group, new THREE.TorusGeometry(radius, thickness, 4, sides), surface, at);
  if (axis === 'x') object.rotation.y = Math.PI / 2;
  if (axis === 'y') object.rotation.x = Math.PI / 2;
  return object;
}

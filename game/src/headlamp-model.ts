import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildLamp } from './upgrade-models/diving';
import type { UpgradeLevel } from './upgrades';
import type { LampPath } from './lamp-lighting';

/** Reuse the catalogue's hardware, batching rigid parts by material for gameplay. */
export function buildHeadlamp(level: UpgradeLevel, path: LampPath = 'focus') {
  const group = buildLamp(level, path);
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const sources = new Set<THREE.BufferGeometry>();
  const emitters: THREE.MeshStandardMaterial[] = [];
  const origin = new THREE.Vector3();
  let lenses = 0;
  group.updateMatrixWorld(true);
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.name === 'flat-protective-lens') {
      origin.add(object.getWorldPosition(new THREE.Vector3()));
      lenses++;
    }
    if (object.name === 'unlit-led-chip') {
      const emitter = object.material as THREE.MeshStandardMaterial;
      emitter.emissive.set('#fff1c4');
      emitters.push(emitter);
    }
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    // These untextured parts only need positions and normals; strips have no UVs.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    }
    geometry.clearGroups();
    const material = object.material as THREE.Material;
    const batch = parts.get(material) ?? [];
    batch.push(geometry);
    parts.set(material, batch);
    sources.add(object.geometry);
  });
  origin.divideScalar(lenses);
  origin.z += 0.008;
  group.clear();
  for (const [material, geometries] of parts) {
    const geometry = mergeGeometries(geometries);
    if (!geometry) throw new Error('Headlamp parts have incompatible geometry');
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'batched-headlamp-hardware';
    group.add(mesh);
    for (const source of geometries) source.dispose();
  }
  for (const source of sources) source.dispose();
  return { group, origin, emitters };
}

/** Shared materials and geometries are released once, after attachments are moved. */
export function disposeMeshes(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

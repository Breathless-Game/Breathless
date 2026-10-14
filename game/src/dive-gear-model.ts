import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildFins, buildTank } from './upgrade-models/diving';
import { disposeMeshes } from './headlamp-model';
import type { UpgradeLevel } from './upgrades';

/** Catalogue width / length / depth becomes the swimmer's lateral / forward / up axes. */
const swimmerAxes = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
);

/** Batch one rigid assembly in its own frame, retaining movable joints above it. */
function batchAssembly(root: THREE.Group) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const sources = new Set<THREE.BufferGeometry>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    geometry.applyMatrix4(inverse.clone().multiply(object.matrixWorld));
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    geometry.clearGroups();
    const material = object.material as THREE.Material;
    const batch = batches.get(material) ?? [];
    batch.push(geometry); batches.set(material, batch); sources.add(object.geometry);
  });
  root.clear();
  for (const [material, parts] of batches) {
    const geometry = mergeGeometries(parts);
    if (!geometry) throw new Error('Dive gear parts have incompatible geometry');
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'batched-dive-gear';
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    parts.forEach(part => part.dispose());
  }
  sources.forEach(source => source.dispose());
}

export interface WornFins {
  feet: readonly [THREE.Group, THREE.Group];
  blades: readonly [THREE.Group, THREE.Group];
  level: UpgradeLevel;
}

export function buildWornFins(level: UpgradeLevel): WornFins {
  const pair = buildFins(level);
  const feet: THREE.Group[] = [];
  const blades: THREE.Group[] = [];
  for (const name of ['left-fin', 'right-fin']) {
    const fin = pair.getObjectByName(name) as THREE.Group;
    fin.position.set(0, 0, 0);
    const pocket = fin.getObjectByName('fin-foot-pocket') as THREE.Group;
    const blade = fin.getObjectByName('fin-blade-assembly') as THREE.Group;
    batchAssembly(pocket); batchAssembly(blade);
    const foot = new THREE.Group();
    foot.name = `diver-${name}`;
    foot.userData.level = level;
    foot.setRotationFromMatrix(swimmerAxes);
    foot.scale.setScalar(0.68);
    foot.position.set(-0.3, -0.08, 0);
    foot.add(fin);
    feet.push(foot); blades.push(blade);
  }
  return { feet: feet as [THREE.Group, THREE.Group], blades: blades as [THREE.Group, THREE.Group], level };
}

/** The pair owns shared materials; move both feet before disposing a suit or tier. */
export function disposeWornFins(fins: WornFins) {
  const owner = new THREE.Group();
  owner.add(...fins.feet);
  disposeMeshes(owner);
  owner.clear();
}

export function buildWornTank(level: UpgradeLevel): THREE.Group {
  const group = new THREE.Group();
  group.name = 'diver-tank-hardware';
  group.userData = { level, cylinders: level === 1 ? 0 : level === 2 ? 1 : 2 };
  if (level === 1) return group;
  const tank = buildTank(level);
  batchAssembly(tank);
  group.setRotationFromMatrix(swimmerAxes);
  group.scale.setScalar(0.72);
  group.add(tank);
  return group;
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildNetHead } from './upgrade-models/net';
import type { UpgradeLevel } from './upgrades';

type Material = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

function standard(
  color: THREE.ColorRepresentation,
  extra: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    // Faceted normals preserve the game's deliberate polyhedron look while
    // the higher radial segment counts keep the silhouette believable.
    flatShading: true,
    roughness: 0.55,
    ...extra,
  });
}

function physical(
  color: THREE.ColorRepresentation,
  extra: THREE.MeshPhysicalMaterialParameters = {},
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    flatShading: true,
    roughness: 0.5,
    ...extra,
  });
}

function taperedTube(
  radiusTop: number,
  radiusBottom: number,
  length: number,
  material: Material,
  segments = 12,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments, 1, false), material);
  // CylinderGeometry is along Y; the tool is modelled along +X.
  mesh.rotation.z = -Math.PI / 2;
  return mesh;
}

function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: Material, segments = 8) {
  const direction = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), segments), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function buildSpinningReel(reelMaterial: Material, metalMaterial: Material): THREE.Group {
  const reel = new THREE.Group();
  reel.name = 'Fishing_Reel';
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 10), reelMaterial);
  body.scale.set(0.82, 1.18, 0.78);
  body.position.set(1.25, -0.16, 0);

  const sidePlate = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.035, 16), metalMaterial);
  sidePlate.rotation.x = Math.PI / 2;
  sidePlate.position.set(1.25, -0.11, 0.08);

  const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.13, 16), standard('#a9b6b8', { metalness: 0.72, roughness: 0.34 }));
  spool.rotation.x = Math.PI / 2;
  spool.position.set(1.3, -0.08, 0.04);

  const spoolLip = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.018, 6, 16), metalMaterial);
  spoolLip.position.set(1.3, -0.08, 0.11);

  const bail = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.011, 6, 24, Math.PI * 1.7), metalMaterial);
  bail.rotation.z = -0.2;
  bail.position.set(1.3, -0.08, 0.12);

  const axle = taperedTube(0.025, 0.025, 0.28, metalMaterial, 8);
  // Spool axis is Z; rings lie in XY around that same axle.
  axle.rotation.set(Math.PI / 2, 0, 0);
  axle.position.set(1.3, -0.08, 0.04);

  const handle = cylinderBetween(new THREE.Vector3(1.34, -0.27, 0.02), new THREE.Vector3(1.53, -0.35, 0.02), 0.014, metalMaterial, 8);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), reelMaterial);
  knob.position.set(1.55, -0.36, 0.02);
  reel.add(body, sidePlate, spool, spoolLip, bail, axle, handle, knob);
  return reel;
}

export interface FishingNetMesh {
  /** Group attached to the diver's shoulder and rotated during a swing. */
  group: THREE.Group;
  /** Stable pole mounting pivot; upgrades replace its scoop head. */
  mouth: THREE.Group;
  /** World-space catch marker, aligned with the hoop centre. */
  tip: THREE.Object3D;
}

/**
 * Build the reusable fishing tool asset. The fused game design represents the
 * old fishing-rod item as an underwater scoop net, with a carbon blank,
 * EVA-grip, spinning reel, guide rings, faceted hoop and nylon pocket.
 */
export function buildFishingNetMesh(level: UpgradeLevel = 1): FishingNetMesh {
  const group = new THREE.Group();
  group.name = 'HackRU_Faceted_Fishing_Net';
  group.userData.level = level;
  const carbon = physical('#17242d', { metalness: 0.28, roughness: 0.3, clearcoat: 0.35, clearcoatRoughness: 0.2 });
  const carbonAccent = standard('#46616a', { metalness: 0.55, roughness: 0.3 });
  const grip = physical('#9b5d3c', { roughness: 0.88, clearcoat: 0.05 });
  const reelBody = physical('#263b46', { metalness: 0.68, roughness: 0.3, clearcoat: 0.2 });
  const metal = standard('#9eafb2', { metalness: 0.86, roughness: 0.26 });
  const dark = standard('#142027', { metalness: 0.5, roughness: 0.36 });
  const suit = standard('#1d2b3a', { roughness: 0.76 });

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.14), suit);
  arm.position.x = 0.35;

  const buttCap = taperedTube(0.105, 0.12, 0.1, dark, 12);
  buttCap.position.x = 0.66;
  const rearGrip = taperedTube(0.105, 0.135, 0.46, grip, 12);
  rearGrip.position.x = 0.91;
  const gripBandA = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.014, 6, 12), dark);
  gripBandA.rotation.y = Math.PI / 2;
  gripBandA.position.x = 0.72;
  const gripBandB = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 6, 12), dark);
  gripBandB.rotation.y = Math.PI / 2;
  gripBandB.position.x = 1.1;

  const reelSeat = taperedTube(0.073, 0.082, 0.28, carbonAccent, 12);
  reelSeat.position.x = 1.26;
  const reelSeatRing = new THREE.Mesh(new THREE.TorusGeometry(0.084, 0.014, 6, 12), metal);
  reelSeatRing.rotation.y = Math.PI / 2;
  reelSeatRing.position.x = 1.4;

  const rodBlank = taperedTube(0.022, 0.068, 1.34, carbon, 12);
  rodBlank.position.x = 1.98;
  const rodHighlight = taperedTube(0.008, 0.011, 1.15, carbonAccent, 8);
  rodHighlight.position.set(2.08, 0.045, 0.045);

  const reel = buildSpinningReel(reelBody, metal);
  const guides = new THREE.Group();
  for (const [x, radius] of [
    [1.67, 0.065],
    [1.93, 0.052],
    [2.18, 0.042],
    [2.4, 0.033],
  ] as const) {
    const guide = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.009, 6, 12), metal);
    guide.rotation.y = Math.PI / 2;
    guide.position.x = x;
    guides.add(guide);
  }

  // The hoop centre is a separate pivot, so upgrades enlarge the working end
  // without stretching the hand grip, reel or shaft.
  const mouth = new THREE.Group();
  mouth.name = 'Net_Mouth';
  const hoopX = 2.7;
  mouth.position.x = hoopX;
  const head = buildMountedNetHead(level);
  mouth.add(head);
  const tip = head.getObjectByName('Catch_Centre')!;

  group.add(arm, buttCap, rearGrip, gripBandA, gripBandB, reelSeat, reelSeatRing, rodBlank, rodHighlight, reel, guides, mouth);
  return { group, mouth, tip };
}

/** Preserve the nylon pocket as a flexible part, batching rigid frame hardware. */
export function buildMountedNetHead(level: UpgradeLevel): THREE.Group {
  const head = buildNetHead(level);
  head.rotation.z = -Math.PI / 2;
  // Keep the pocket below the pole, mounted at its throat instead of piercing the bag.
  head.position.y = head.userData.socketOffset * head.scale.x;
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const sources = new Set<THREE.BufferGeometry>();
  head.updateMatrixWorld(true);
  const inverse = head.matrixWorld.clone().invert();
  const web = head.getObjectByName('Nylon_Diamond_Web')!;
  const tip = head.getObjectByName('Catch_Centre')!;
  head.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object === web) return;
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    geometry.applyMatrix4(inverse.clone().multiply(object.matrixWorld));
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    geometry.clearGroups();
    const material = object.material as THREE.Material;
    const batch = parts.get(material) ?? [];
    batch.push(geometry); parts.set(material, batch); sources.add(object.geometry);
  });
  head.clear();
  head.add(web, tip);
  for (const [material, geometries] of parts) {
    const geometry = mergeGeometries(geometries);
    if (!geometry) throw new Error('Net frame parts have incompatible geometry');
    const part = new THREE.Mesh(geometry, material);
    part.name = 'Batched_Net_Frame';
    part.castShadow = part.receiveShadow = true;
    head.add(part);
    geometries.forEach(source => source.dispose());
  }
  sources.forEach(source => source.dispose());
  return head;
}

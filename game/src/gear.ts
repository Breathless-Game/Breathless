import * as THREE from 'three';

function material(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7, ...extra });
}

function addLineSegment(positions: number[], a: THREE.Vector3, b: THREE.Vector3) {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

/**
 * Build the low-poly web as one line draw call. A wireframe ConeGeometry looks
 * like a solid pyramid from the side and produces diagonal triangles that do
 * not read as netting. Concentric rings plus longitudinal lines preserve the
 * same cheap geometry while making the scoop shape legible from every angle.
 */
function buildNetWeb(backX: number, length: number, hoopRadius: number): THREE.LineSegments {
  const rings = 4;
  const sides = 12;
  const positions: number[] = [];
  const points: THREE.Vector3[][] = [];

  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings;
    const x = backX + length * t;
    const radius = THREE.MathUtils.lerp(0.1, hoopRadius, t);
    const row: THREE.Vector3[] = [];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      row.push(new THREE.Vector3(x, Math.sin(angle) * radius, Math.cos(angle) * radius));
    }
    points.push(row);
  }

  for (const row of points) {
    for (let side = 0; side < sides; side++) {
      addLineSegment(positions, row[side], row[(side + 1) % sides]);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let side = 0; side < sides; side++) {
      addLineSegment(positions, points[ring][side], points[ring + 1][side]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const net = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: '#dffaf7',
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    }),
  );
  net.renderOrder = 2;
  return net;
}

export interface FishingNetMesh {
  /** Group attached to the diver's shoulder and rotated during a swing. */
  group: THREE.Group;
  /** World-space catch marker, aligned with the visible hoop opening. */
  tip: THREE.Object3D;
}

/**
 * Build the in-game fishing tool. The fused game design represents the old
 * fishing-rod item as an underwater net, so the interaction remains a scoop
 * while the model keeps recognisable rod hardware: grip, ferrule, reel, shaft,
 * hoop, and a real conical web.
 */
export function buildFishingNetMesh(): FishingNetMesh {
  const group = new THREE.Group();
  const shaft = material('#c9d2d7', { metalness: 0.55, roughness: 0.35 });
  const grip = material('#7e4c32', { roughness: 0.95 });
  const reel = material('#344956', { metalness: 0.8, roughness: 0.28 });
  const hoopMaterial = material('#ffd166', { metalness: 0.15, roughness: 0.45 });
  const suit = material('#1d2b3a');

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.14), suit);
  arm.position.x = 0.35;

  const gripMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.38, 6), grip);
  gripMesh.rotation.z = Math.PI / 2;
  gripMesh.position.x = 0.78;

  const reelMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 8), reel);
  reelMesh.rotation.x = Math.PI / 2;
  reelMesh.position.set(0.98, -0.16, 0.08);
  const reelHandle = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.035, 0.035), reel);
  reelHandle.position.set(1.1, -0.16, 0.08);
  reelHandle.rotation.z = -0.35;

  const shaftMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 1.35, 6), shaft);
  shaftMesh.rotation.z = Math.PI / 2;
  shaftMesh.position.x = 1.26;
  const ferrule = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 4, 8), hoopMaterial);
  ferrule.rotation.y = Math.PI / 2;
  ferrule.position.x = 1.55;

  const hoopX = 2.0;
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 5, 12), hoopMaterial);
  hoop.rotation.y = Math.PI / 2;
  hoop.position.x = hoopX;

  const web = buildNetWeb(1.45, hoopX - 1.45, 0.42);
  const tip = new THREE.Object3D();
  tip.position.x = hoopX;
  group.add(arm, gripMesh, reelMesh, reelHandle, shaftMesh, ferrule, hoop, web, tip);
  return { group, tip };
}

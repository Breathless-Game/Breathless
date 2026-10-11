import * as THREE from 'three';
import { ROD_TIERS } from './equipment';

export type UpgradeId = 'rod' | 'reel' | 'bait' | 'boatSpeed' | 'boatHull' | 'boatDeck' | 'net' | 'fins' | 'tank' | 'lamp';
export type UpgradeLevel = 1 | 2 | 3;
export {
  ACCESSORIES,
  buildAccessoryModel,
  type AccessoryId,
  type AccessorySlot,
  type AccessoryDef,
} from './accessories';

export interface UpgradeDef {
  id: UpgradeId;
  /** 'boat' upgrades are used on the boat, 'dive' upgrades underwater. */
  group: 'boat' | 'dive';
  name: string;
  nameZh: string;
  /** One short effect line per level. */
  effects: [string, string, string];
  /** Price in Pearl per level. Level 1 is the starting gear and costs 0. */
  prices: [number, number, number];
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'rod', group: 'dive', name: 'Net shaft', nameZh: '鱼竿杆身', effects: ['Tool reach 1.2 m', 'Tool reach 1.55 m', 'Tool reach 1.9 m'], prices: [0, 100, 500] },
  { id: 'reel', group: 'dive', name: 'Recovery reel', nameZh: '高速回收线轮', effects: ['Base swing recovery', '20% faster recovery', '40% faster recovery'], prices: [0, 120, 600] },
  { id: 'bait', group: 'boat', name: 'Bait', nameZh: '鱼饵', effects: ['Bite wait ×1.0', 'Bite wait ×0.8', 'Bite wait ×0.6'], prices: [0, 40, 300] },
  { id: 'boatSpeed', group: 'boat', name: 'Boat engine', nameZh: '船 · 速度', effects: ['Trip takes 2 h', 'Trip takes 1 h', 'Trip takes 30 min'], prices: [0, 80, 500] },
  { id: 'boatHull', group: 'boat', name: 'Boat hull', nameZh: '船 · 耐久', effects: ['Durability 3', 'Durability 5', 'Durability 8'], prices: [0, 80, 500] },
  { id: 'boatDeck', group: 'boat', name: 'Fishing deck', nameZh: '船 · 鱼台', effects: ['1 rod', '2 rods', '3 rods'], prices: [0, 80, 500] },
  // The net's real stats and prices live in equipment.ts.
  {
    id: 'net',
    group: 'dive',
    name: 'Net',
    nameZh: '渔网',
    effects: [`Holds ${ROD_TIERS[0].capacity} fish`, `Holds ${ROD_TIERS[1].capacity} fish`, `Holds ${ROD_TIERS[2].capacity} fish`],
    prices: [ROD_TIERS[0].cost, ROD_TIERS[1].cost, ROD_TIERS[2].cost],
  },
  { id: 'fins', group: 'dive', name: 'Fins', nameZh: '脚蹼', effects: ['Swim speed 7.5', 'Swim speed 8.5', 'Swim speed 9.5'], prices: [0, 60, 400] },
  { id: 'tank', group: 'dive', name: 'Emergency tank', nameZh: '应急气瓶', effects: ['No reserve air', '+1 s emergency air', '+2 s emergency air'], prices: [0, 80, 500] },
  { id: 'lamp', group: 'dive', name: 'Headlamp', nameZh: '头灯', effects: ['Short beam', 'Wide beam', 'Wide, long beam'], prices: [0, 40, 300] },
];

function mat(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7, ...extra });
}

const wood = mat('#8f5d3e', { roughness: 0.95 });
const wornMetal = mat('#68777d', { metalness: 0.55, roughness: 0.65 });
const steel = mat('#9aaeb5', { metalness: 0.8, roughness: 0.3 });
const carbon = mat('#182b35', { metalness: 0.75, roughness: 0.3 });
const blue = mat('#287ea6', { metalness: 0.25, roughness: 0.45 });
const orange = mat('#e27a35', { roughness: 0.5 });
const teal = mat('#27c4b8', { metalness: 0.35, roughness: 0.3 });
const gold = mat('#e5b642', { metalness: 0.8, roughness: 0.24 });
const rope = mat('#a47a50', { roughness: 1 });
const rubber = mat('#253139', { roughness: 0.95 });
const dark = mat('#102027', { metalness: 0.4, roughness: 0.4 });
const lens = mat('#7ff7ff', { emissive: '#43e9e1', emissiveIntensity: 2.4, metalness: 0.1, roughness: 0.25 });

function addMesh(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, position?: THREE.Vector3) {
  const mesh = new THREE.Mesh(geometry, material);
  if (position) mesh.position.copy(position);
  group.add(mesh);
  return mesh;
}

function cylinderBetween(group: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material, segments = 6) {
  const direction = new THREE.Vector3().subVectors(b, a);
  const mesh = addMesh(group, new THREE.CylinderGeometry(radius, radius, direction.length(), segments), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function segments(points: THREE.Vector3[], material: THREE.Material, closed = false) {
  const positions: number[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let index = 0; index < count; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geometry, material);
}

function addHook(group: THREE.Group, position: THREE.Vector3, scale: number, material: THREE.Material) {
  const points = [
    new THREE.Vector3(0, 0.2, 0),
    new THREE.Vector3(0, -0.02, 0),
    new THREE.Vector3(0.08, -0.17, 0),
    new THREE.Vector3(0.2, -0.18, 0),
    new THREE.Vector3(0.26, -0.1, 0),
  ].map((point) => point.multiplyScalar(scale).add(position));
  const hook = segments(points, material);
  group.add(hook);
  return hook;
}

function addStrap(group: THREE.Group, y: number, material: THREE.Material, width = 0.08) {
  const strap = addMesh(group, new THREE.TorusGeometry(0.32, width, 5, 8), material);
  strap.rotation.x = Math.PI / 2;
  strap.position.y = y;
  return strap;
}

function palette(level: UpgradeLevel) {
  return level === 1 ? { body: wood, metal: wornMetal, accent: rope } : level === 2 ? { body: blue, metal: steel, accent: orange } : { body: carbon, metal: teal, accent: gold };
}

function buildRod(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  const length = [1.35, 1.6, 1.95][level - 1];
  const radius = [0.055, 0.045, 0.035][level - 1];
  addMesh(group, new THREE.BoxGeometry(0.35, 0.12, 0.28), colors.body, new THREE.Vector3(-0.45, 0.05, 0));
  addMesh(group, new THREE.CylinderGeometry(0.08, 0.1, 0.45, 6), colors.body, new THREE.Vector3(-0.25, 0.2, 0)).rotation.z = Math.PI / 2;
  const rod = addMesh(group, new THREE.CylinderGeometry(radius, radius * 1.6, length, 6), colors.body, new THREE.Vector3(0.42, 0.75, 0));
  rod.rotation.z = -0.22;
  const reel = addMesh(group, new THREE.CylinderGeometry(0.15 + level * 0.025, 0.15 + level * 0.025, 0.1, 8), colors.metal, new THREE.Vector3(-0.05, 0.05, 0.12));
  reel.rotation.x = Math.PI / 2;
  addMesh(group, new THREE.BoxGeometry(0.2, 0.035, 0.035), colors.accent, new THREE.Vector3(0.08, -0.04, 0.16)).rotation.z = -0.35;
  const guideCount = level + 2;
  for (let index = 0; index < guideCount; index++) {
    const x = 0.1 + index * (length / guideCount);
    const guide = addMesh(group, new THREE.TorusGeometry(0.065, 0.014, 4, 8), colors.accent);
    guide.rotation.y = Math.PI / 2;
    guide.position.set(x, 0.75 - (x - 0.42) * 0.22, 0);
  }
  const tip = new THREE.Vector3(0.42 + length * 0.48, 0.75 - length * 0.48 * 0.22, 0);
  cylinderBetween(group, new THREE.Vector3(-0.05, 0.03, 0.12), tip, 0.012, colors.accent, 5);
  addHook(group, tip, 0.42, colors.metal);
  return group;
}

function buildBait(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  const hook = new THREE.Vector3(0, -0.1, 0);
  cylinderBetween(group, new THREE.Vector3(0, 0.45, 0), hook, 0.012, colors.metal, 5);
  if (level === 1) {
    const worm = addMesh(group, new THREE.SphereGeometry(0.13, 6, 4), orange, new THREE.Vector3(0, 0.18, 0));
    worm.scale.set(0.55, 1.45, 0.55);
  } else if (level === 2) {
    addMesh(group, new THREE.IcosahedronGeometry(0.2, 1), orange, new THREE.Vector3(0, 0.2, 0)).scale.set(0.75, 1.2, 0.55);
    addMesh(group, new THREE.ConeGeometry(0.1, 0.35, 6), colors.accent, new THREE.Vector3(0.02, 0.43, 0)).rotation.z = Math.PI / 2;
  } else {
    addMesh(group, new THREE.ConeGeometry(0.16, 0.5, 6), lens, new THREE.Vector3(0, 0.2, 0)).rotation.z = Math.PI / 2;
    const treble = new THREE.Group();
    addHook(treble, new THREE.Vector3(0, -0.05, 0), 0.45, gold);
    addHook(treble, new THREE.Vector3(0, -0.05, 0), 0.45, gold).rotation.y = (Math.PI * 2) / 3;
    treble.rotation.z = (Math.PI * 2) / 3;
    group.add(treble);
  }
  addHook(group, hook, 0.5, colors.metal);
  return group;
}

/** Compact spool and clutch model for the diver's high-speed recovery reel. */
function buildReel(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  const radius = 0.16 + level * 0.025;
  const spool = addMesh(group, new THREE.CylinderGeometry(radius, radius, 0.12, 8), colors.metal, new THREE.Vector3(0, 0.08, 0));
  spool.rotation.x = Math.PI / 2;
  addMesh(group, new THREE.TorusGeometry(radius * 0.82, 0.025, 5, 10), colors.accent, new THREE.Vector3(0, 0.08, 0)).rotation.x = Math.PI / 2;
  addMesh(group, new THREE.BoxGeometry(0.12 + level * 0.03, 0.08, 0.28), colors.body, new THREE.Vector3(0, -0.1, 0));
  const handle = addMesh(group, new THREE.BoxGeometry(0.22, 0.035, 0.035), colors.accent, new THREE.Vector3(radius + 0.1, 0.08, 0));
  handle.rotation.z = -0.4;
  cylinderBetween(group, new THREE.Vector3(-0.25, -0.1, 0), new THREE.Vector3(0.25, -0.1, 0), 0.025, colors.metal, 5);
  return group;
}

function buildBoatSpeed(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  if (level === 1) {
    for (const rotation of [-0.55, 0.55]) {
      const oar = addMesh(group, new THREE.BoxGeometry(0.1, 1.6, 0.08), wood);
      oar.rotation.z = rotation;
      oar.position.y = 0.35;
      addMesh(group, new THREE.BoxGeometry(0.35, 0.25, 0.12), wood, new THREE.Vector3(oar.position.x, 1.08, 0));
    }
  } else {
    const size = level === 2 ? 0.68 : 0.9;
    addMesh(group, new THREE.BoxGeometry(size, 0.72, 0.45), colors.body, new THREE.Vector3(0, 0.3, 0));
    addMesh(group, new THREE.BoxGeometry(size * 1.05, 0.1, 0.5), colors.accent, new THREE.Vector3(0, 0.56, 0));
    const propellerCount = level === 2 ? 1 : 2;
    for (let index = 0; index < propellerCount; index++) {
      const x = (index - (propellerCount - 1) / 2) * 0.38;
      const shaft = addMesh(group, new THREE.CylinderGeometry(0.045, 0.045, 0.36, 6), colors.metal, new THREE.Vector3(x, -0.2, 0));
      shaft.rotation.x = Math.PI / 2;
      const prop = addMesh(group, new THREE.TorusGeometry(0.13, 0.025, 4, 6), colors.metal, new THREE.Vector3(x, -0.4, 0));
      prop.rotation.x = Math.PI / 2;
    }
    const tiller = addMesh(group, new THREE.BoxGeometry(0.65, 0.06, 0.06), colors.metal, new THREE.Vector3(0, 0.72, 0));
    tiller.rotation.z = -0.28;
  }
  return group;
}

function buildBoatHull(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  const hullGeo = new THREE.CylinderGeometry(0.82, 0.55, 1.5, 6, 1);
  hullGeo.rotateZ(Math.PI / 2);
  hullGeo.scale(1.55, 1, 0.7);
  addMesh(group, hullGeo, colors.body);
  if (level >= 2) {
    for (const x of [-0.5, 0, 0.5]) {
      const band = addMesh(group, new THREE.TorusGeometry(0.52, 0.035, 5, 6), colors.metal, new THREE.Vector3(x, 0, 0));
      band.rotation.y = Math.PI / 2;
    }
    addMesh(group, new THREE.TorusGeometry(0.62, 0.05, 5, 8), colors.accent, new THREE.Vector3(0, 0.45, 0)).rotation.y = Math.PI / 2;
  }
  if (level === 3) {
    for (const x of [-0.6, -0.2, 0.2, 0.6]) addMesh(group, new THREE.SphereGeometry(0.06, 5, 4), gold, new THREE.Vector3(x, 0.32, 0.48));
    addMesh(group, new THREE.BoxGeometry(1.7, 0.12, 0.18), carbon, new THREE.Vector3(0, -0.48, 0));
    addMesh(group, new THREE.BoxGeometry(1.35, 0.11, 0.08), colors.accent, new THREE.Vector3(0, -0.55, 0));
  }
  return group;
}

function buildBoatDeck(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  addMesh(group, new THREE.BoxGeometry(1.7, 0.14, 1.05), wood, new THREE.Vector3(0, 0, 0));
  const rail = addMesh(group, new THREE.TorusGeometry(0.62, 0.035, 5, 8), colors.metal, new THREE.Vector3(0, 0.42, 0));
  rail.rotation.x = Math.PI / 2;
  const rods = level;
  for (let index = 0; index < rods; index++) {
    const x = (index - (rods - 1) / 2) * 0.5;
    addMesh(group, new THREE.CylinderGeometry(0.025, 0.035, 0.72, 5), colors.body, new THREE.Vector3(x, 0.5, 0));
    addMesh(group, new THREE.TorusGeometry(0.07, 0.018, 4, 6), colors.accent, new THREE.Vector3(x, 0.86, 0));
  }
  if (level === 3) addMesh(group, new THREE.BoxGeometry(0.42, 0.28, 0.4), wood, new THREE.Vector3(0, 0.24, -0.3));
  return group;
}

function buildNet(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  const radius = 0.38 + level * 0.07;
  const handleLength = 0.75 + level * 0.18;
  const hoop = addMesh(group, new THREE.TorusGeometry(radius, 0.045, 5, 10), level === 3 ? gold : colors.metal);
  hoop.rotation.y = Math.PI / 2;
  hoop.position.x = handleLength;
  cylinderBetween(group, new THREE.Vector3(-0.55, 0, 0), new THREE.Vector3(handleLength, 0, 0), 0.055, colors.body, 6);
  const positions: number[] = [];
  const rings = 3;
  const sides = 8;
  for (let ring = 0; ring <= rings; ring++) {
    const x = handleLength * (ring / rings);
    const ringRadius = radius * (ring / rings);
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const a = new THREE.Vector3(x, Math.sin(angle) * ringRadius, Math.cos(angle) * ringRadius);
      const nextAngle = ((side + 1) / sides) * Math.PI * 2;
      const b = new THREE.Vector3(x, Math.sin(nextAngle) * ringRadius, Math.cos(nextAngle) * ringRadius);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (ring < rings) positions.push(a.x, a.y, a.z, x + handleLength / rings, Math.sin(angle) * radius * ((ring + 1) / rings), Math.cos(angle) * radius * ((ring + 1) / rings));
    }
  }
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  group.add(new THREE.LineSegments(mesh, new THREE.LineBasicMaterial({ color: '#dffaf7', transparent: true, opacity: 0.6 })));
  return group;
}

function buildFins(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  const length = 0.72 + level * 0.18;
  for (const side of [-1, 1]) {
    const fin = addMesh(group, new THREE.BoxGeometry(0.28, 0.12, length), level === 1 ? rubber : colors.body, new THREE.Vector3(side * 0.25, 0, 0));
    fin.rotation.y = side * 0.15;
    addMesh(group, new THREE.BoxGeometry(0.08, 0.035, length * 0.75), colors.accent, new THREE.Vector3(side * 0.25, 0.08, 0));
    if (level >= 2) for (const rib of [-0.22, 0, 0.22]) addMesh(group, new THREE.BoxGeometry(0.3, 0.04, 0.035), colors.metal, new THREE.Vector3(side * 0.25, 0.08, rib));
    if (level === 3) {
      addMesh(group, new THREE.BoxGeometry(0.08, 0.08, length * 0.88), colors.metal, new THREE.Vector3(side * 0.13, 0.02, 0));
      addMesh(group, new THREE.ConeGeometry(0.08, 0.2, 5), gold, new THREE.Vector3(side * 0.25, 0, length * 0.48)).rotation.x = Math.PI / 2;
    }
  }
  return group;
}

function buildTank(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  addStrap(group, 0, level === 1 ? rope : colors.accent, 0.06);
  addMesh(group, new THREE.BoxGeometry(0.14, 0.12, 0.08), level === 1 ? wornMetal : gold, new THREE.Vector3(0, 0, 0.32));
  if (level >= 2) {
    const height = level === 2 ? 0.75 : 1.05;
    addMesh(group, new THREE.CylinderGeometry(0.16, 0.19, height, 8), colors.body, new THREE.Vector3(0, 0.15, 0));
    addMesh(group, new THREE.CylinderGeometry(0.13, 0.13, 0.12, 8), colors.metal, new THREE.Vector3(0, 0.58 + (level - 2) * 0.15, 0));
    const hoseStart = new THREE.Vector3(0.12, 0.52 + (level - 2) * 0.15, 0);
    cylinderBetween(group, hoseStart, new THREE.Vector3(0.42, 0.3, 0.12), 0.025, colors.accent, 5);
    if (level === 3) {
      const gauge = addMesh(group, new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8), gold, new THREE.Vector3(0.28, 0.43, 0.16));
      gauge.rotation.x = Math.PI / 2;
      addMesh(group, new THREE.SphereGeometry(0.1, 6, 4), dark, new THREE.Vector3(0.5, 0.25, 0.12));
      cylinderBetween(group, new THREE.Vector3(0.12, 0.45, 0), new THREE.Vector3(0.5, 0.25, 0.12), 0.022, teal, 5);
    }
  }
  return group;
}

function buildLamp(level: UpgradeLevel) {
  const group = new THREE.Group();
  const colors = palette(level);
  addStrap(group, 0, level === 1 ? rope : colors.body, 0.07);
  const count = level === 3 ? 2 : 1;
  for (let index = 0; index < count; index++) {
    const x = (index - (count - 1) / 2) * 0.24;
    addMesh(group, new THREE.CylinderGeometry(level === 1 ? 0.12 : 0.16, level === 1 ? 0.12 : 0.2, 0.22, 6), colors.body, new THREE.Vector3(x, 0.16, 0.18)).rotation.x = Math.PI / 2;
    if (level >= 2) {
      const reflector = addMesh(group, new THREE.TorusGeometry(0.16, 0.035, 5, 8), colors.accent, new THREE.Vector3(x, 0.16, 0.3));
      reflector.rotation.x = Math.PI / 2;
    }
    addMesh(group, new THREE.SphereGeometry(0.09, 6, 4), lens, new THREE.Vector3(x, 0.16, 0.31));
  }
  if (level === 3) addMesh(group, new THREE.BoxGeometry(0.34, 0.2, 0.16), carbon, new THREE.Vector3(0, -0.12, -0.1));
  return group;
}

function normalize(group: THREE.Group) {
  const bounds = new THREE.Box3().setFromObject(group);
  const center = bounds.getCenter(new THREE.Vector3());
  group.position.sub(center);
  const size = bounds.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  if (largest > 0) group.scale.setScalar(2 / largest);
}

/** Build a centred, icon-sized display model for one upgrade level. */
export function buildUpgradeModel(id: UpgradeId, level: UpgradeLevel): THREE.Group {
  const inner = id === 'rod' ? buildRod(level)
    : id === 'reel' ? buildReel(level)
      : id === 'bait' ? buildBait(level)
      : id === 'boatSpeed' ? buildBoatSpeed(level)
        : id === 'boatHull' ? buildBoatHull(level)
          : id === 'boatDeck' ? buildBoatDeck(level)
            : id === 'net' ? buildNet(level)
              : id === 'fins' ? buildFins(level)
                : id === 'tank' ? buildTank(level)
                  : buildLamp(level);
  const outer = new THREE.Group();
  outer.add(inner);
  normalize(inner);
  return outer;
}

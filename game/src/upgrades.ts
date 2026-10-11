import * as THREE from 'three';
import { EQUIPMENT_TIERS, ROD_TIERS, type UpgradeSlot } from './equipment';
import { buildDeepSonar } from './deep-sonar';
import { buildNetAssembly, buildNetRecoveryReel, buildNetShaft, buildNetTorch } from './fishing-net';
import { buildBait } from './upgrade-models/fishing';
import { buildBoatSpeed, buildBoatHull, buildBoatDeck } from './upgrade-models/marine';
import { buildFins, buildTank } from './upgrade-models/diving';
import { beam, material, mesh } from './upgrade-models/common';
import { buildFishingBoat } from './boat';

export type UpgradeId = 'rod' | 'reel' | 'bait' | 'boat' | 'boatSpeed' | 'boatHull' | 'boatDeck' | 'net' | 'fins' | 'tank' | 'lamp' | 'sonar';
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

/** Effects and prices straight from equipment.ts, the progression the game actually uses. */
function fromTiers(slot: UpgradeSlot): Pick<UpgradeDef, 'effects' | 'prices'> {
  const t = EQUIPMENT_TIERS[slot];
  return { effects: [t[0].effect, t[1].effect, t[2].effect], prices: [t[0].cost, t[1].cost, t[2].cost] };
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'rod', group: 'dive', name: 'Net shaft', nameZh: '捕鱼网杆', ...fromTiers('rod') },
  { id: 'reel', group: 'dive', name: 'Recovery reel', nameZh: '渔网回收线轮', ...fromTiers('reel') },
  { id: 'bait', group: 'boat', name: 'Bait', nameZh: '鱼饵', effects: ['Bite wait ×1.0', 'Bite wait ×0.8', 'Bite wait ×0.6'], prices: [0, 40, 300] },
  // The whole boat as one piece on the workbench: its engine and hull upgrade together.
  { id: 'boat', group: 'boat', name: 'Boat', nameZh: '船', effects: ['Trip 2 h · hull 3', 'Trip 1 h · hull 5', 'Trip 30 min · hull 8'], prices: [0, 120, 700] },
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
  { id: 'fins', group: 'dive', name: 'Fins', nameZh: '脚蹼', ...fromTiers('fins') },
  { id: 'tank', group: 'dive', name: 'Emergency tank', nameZh: '应急气瓶', ...fromTiers('tank') },
  { id: 'lamp', group: 'dive', name: 'Net torch', nameZh: '网架手电', ...fromTiers('lamp') },
  // Like the net, the sonar's real tiers and prices live in equipment.ts.
  {
    id: 'sonar',
    group: 'dive',
    name: 'Deep sonar',
    nameZh: '深潜声纳',
    effects: [EQUIPMENT_TIERS.sonar[0].effect, EQUIPMENT_TIERS.sonar[1].effect, EQUIPMENT_TIERS.sonar[2].effect],
    prices: [EQUIPMENT_TIERS.sonar[0].cost, EQUIPMENT_TIERS.sonar[1].cost, EQUIPMENT_TIERS.sonar[2].cost],
  },
];


const builders: Record<UpgradeId, (level: UpgradeLevel) => THREE.Group> = {
  rod: buildNetShaft,
  reel: buildNetRecoveryReel,
  bait: buildBait,
  boat: buildBoat,
  boatSpeed: buildBoatSpeed,
  boatHull: buildBoatHull,
  boatDeck: buildBoatDeck,
  net: (level) => buildNetAssembly({ netLevel: level }).group,
  fins: buildFins,
  tank: buildTank,
  lamp: buildNetTorch,
  sonar: buildSonarDisplay,
};

export interface NetAssemblyDisplayOptions {
  /** The shaft level that determines the net's handle length. */
  shaftLevel?: number;
  /** The net basket level. Defaults to the level argument. */
  netLevel?: number;
  /** The attached recovery reel level; zero leaves the reel off the net. */
  reelLevel?: number;
  /** The attached torch level; zero leaves the torch off the net. */
  lampLevel?: number;
}

/** The model's physical longest side before the workbench chooses its display size. */
export const WORKBENCH_GEAR_SIZE: Readonly<Record<UpgradeId, number>> = Object.freeze({
  net: 1.8,
  rod: 1.28,
  reel: 0.48,
  bait: 0.52,
  boat: 1.5,
  boatSpeed: 0.62,
  boatHull: 1.3,
  boatDeck: 1.2,
  fins: 1.15,
  tank: 1.15,
  lamp: 0.48,
  sonar: 0.7,
});

/**
 * The boat on the workbench is the boat from the map (boat.ts), as it is. Each
 * level adds a little on top: a radar on the wheelhouse roof, then spotlights
 * and gold trim along the gunwales.
 */
function buildBoat(level: UpgradeLevel): THREE.Group {
  const group = buildFishingBoat();
  const steel = material('#9aaeb5', { metalness: 0.8, roughness: 0.3 });
  if (level >= 2) {
    beam(group, [-1.6, 2.16, 0], [-1.6, 2.5, 0], 0.04, steel, 6);
    mesh(group, new THREE.BoxGeometry(0.9, 0.07, 0.14), steel, [-1.6, 2.55, 0]).rotation.y = 0.5;
  }
  if (level === 3) {
    const dark = material('#102027', { metalness: 0.4, roughness: 0.4 });
    const lens = material('#7ff7ff', { emissive: '#43e9e1', emissiveIntensity: 2.4, metalness: 0.1, roughness: 0.25 });
    const gold = material('#e5b642', { metalness: 0.8, roughness: 0.24 });
    for (const z of [-0.55, 0.55]) {
      mesh(group, new THREE.CylinderGeometry(0.1, 0.13, 0.18, 8), dark, [0.2, 2.25, z]).rotation.z = Math.PI / 2;
      mesh(group, new THREE.SphereGeometry(0.09, 6, 4), lens, [0.31, 2.25, z]);
    }
    for (const z of [-0.84, 0.84]) mesh(group, new THREE.BoxGeometry(5.3, 0.06, 0.04), gold, [-0.5, 0.56, z]);
  }
  return group;
}

/** The workbench piece: the sonar's solid faceted parts, without the additive glow halos it shows underwater. */
function disposeDisplayChildren(root: THREE.Group, keep: THREE.Object3D[]) {
  for (const child of [...root.children]) {
    if (keep.includes(child)) continue;
    root.remove(child);
    child.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      for (const surface of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) surface?.dispose();
    });
  }
}

/** A packed sonar shows the buoy and a short stored lead, never its deployed cable. */
function buildSonarDisplay(level: UpgradeLevel): THREE.Group {
  const group = buildDeepSonar({ lengthLevel: level, detail: 2, startsCarried: true }).group;
  const buoy = group.children[0];
  disposeDisplayChildren(group, [buoy]);
  const coil = new THREE.Mesh(
    new THREE.TorusGeometry(0.18 + level * 0.015, 0.022, 6, 16),
    new THREE.MeshStandardMaterial({ color: '#586e72', flatShading: true, roughness: 0.88 }),
  );
  coil.rotation.x = Math.PI / 2;
  coil.position.y = -0.26;
  group.add(coil);
  const lead = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.25 + level * 0.04, 6),
    new THREE.MeshStandardMaterial({ color: '#34484d', flatShading: true, roughness: 0.92 }),
  );
  lead.position.set(0, -0.42, 0);
  lead.rotation.z = 0.2;
  group.add(lead);
  const halos: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) halos.push(object);
  });
  for (const halo of halos) halo.removeFromParent();
  return group;
}

/** Build a centred, two-unit display model shared by the workbench and catalog. */
export function buildUpgradeModel(id: UpgradeId, level: UpgradeLevel, options: NetAssemblyDisplayOptions = {}): THREE.Group {
  let inner: THREE.Group;
  if (id === 'net') {
    const assembly = buildNetAssembly({
      netLevel: options.netLevel ?? level,
      shaftLevel: options.shaftLevel ?? 1,
      reelLevel: options.reelLevel ?? 0,
      lampLevel: options.lampLevel ?? 0,
    });
    // The unmounted torch remains available to the shared assembly API, but a
    // dark workbench preview must not glow through its hidden materials.
    if (!(options.lampLevel ?? 0)) {
      assembly.lamp.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const surface of Array.isArray(object.material) ? object.material : [object.material]) {
          if ('emissive' in surface) {
            surface.emissive.set('#000000');
            surface.emissiveIntensity = 0;
          }
        }
      });
    }
    inner = assembly.group;
  } else inner = builders[id](level);
  const bounds = new THREE.Box3().setFromObject(inner);
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const scale = 2 / Math.max(size.x, size.y, size.z);
  inner.scale.multiplyScalar(scale);
  // Scale the translation too; otherwise an off-centre raw model stays offset.
  inner.position.sub(centre).multiplyScalar(scale);
  const outer = new THREE.Group();
  outer.name = `HackRU_${id}_Lv${level}`;
  outer.userData = { upgradeId: id, level, source: 'buildUpgradeModel', visualOnly: true };
  outer.add(inner);
  return outer;
}

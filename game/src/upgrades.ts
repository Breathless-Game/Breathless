import * as THREE from 'three';
import { ROD_TIERS } from './equipment';
import { buildRod, buildBait, buildNet } from './upgrade-models/fishing';
import { buildBoatSpeed, buildBoatHull, buildBoatDeck } from './upgrade-models/marine';
import { buildFins, buildTank, buildLamp } from './upgrade-models/diving';

export type UpgradeId = 'rod' | 'bait' | 'boatSpeed' | 'boatHull' | 'boatDeck' | 'net' | 'fins' | 'tank' | 'lamp';
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
  { id: 'rod', group: 'boat', name: 'Fishing rod', nameZh: '鱼竿', effects: ['1 roll per bite', 'Best of 2 rolls', 'Best of 3 rolls'], prices: [0, 60, 400] },
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


const builders: Record<UpgradeId, (level: UpgradeLevel) => THREE.Group> = {
  rod: buildRod,
  bait: buildBait,
  boatSpeed: buildBoatSpeed,
  boatHull: buildBoatHull,
  boatDeck: buildBoatDeck,
  net: buildNet,
  fins: buildFins,
  tank: buildTank,
  lamp: buildLamp,
};

/** Build a centred, two-unit display model shared by the workbench and catalog. */
export function buildUpgradeModel(id: UpgradeId, level: UpgradeLevel): THREE.Group {
  const inner = builders[id](level);
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

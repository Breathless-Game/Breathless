import * as THREE from 'three';
import { EQUIPMENT_TIERS, ROD_TIERS, type UpgradeSlot } from './equipment';
import { tierEffect } from './equipment-i18n';
import { lang, pickName } from './i18n';
import { buildDeepSonar } from './deep-sonar';
import { loadSonarConfig } from './sonar-config';
import { buildRod, buildReel, buildBait, buildNet } from './upgrade-models/fishing';
import { buildBoatSpeed, buildBoatHull, buildBoatDeck } from './upgrade-models/marine';
import { buildFins, buildTank, buildLamp } from './upgrade-models/diving';
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

/** Chinese effect lines for upgrades whose text is not read from equipment.ts. */
const EFFECTS_ZH: Partial<Record<UpgradeId, readonly [string, string, string]>> = {
  bait: ['咬钩等待 ×1.0', '咬钩等待 ×0.8', '咬钩等待 ×0.6'],
  boat: ['航程 2 小时 · 船体 3', '航程 1 小时 · 船体 5', '航程 30 分钟 · 船体 8'],
  boatSpeed: ['航程 2 小时', '航程 1 小时', '航程 30 分钟'],
  boatHull: ['耐久 3', '耐久 5', '耐久 8'],
  boatDeck: ['1 根鱼竿', '2 根鱼竿', '3 根鱼竿'],
};

/** Display name of an upgrade in the current UI language. */
export function upgradeName(def: UpgradeDef): string {
  return pickName(def);
}

/** Display effect line (level 1-3) of an upgrade in the current UI language. */
export function upgradeEffect(def: UpgradeDef, level: number): string {
  const i = Math.max(0, Math.min(2, level - 1));
  if (lang() !== 'zh') return def.effects[i];
  if (def.id === 'net') return `容纳 ${ROD_TIERS[i].capacity} 条鱼`;
  const fixed = EFFECTS_ZH[def.id];
  if (fixed) return fixed[i];
  return tierEffect(def.id as Exclude<UpgradeSlot, 'net'>, i + 1);
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'rod', group: 'dive', name: 'Net shaft', nameZh: '鱼竿杆身', ...fromTiers('rod') },
  { id: 'reel', group: 'dive', name: 'Recovery reel', nameZh: '高速回收线轮', ...fromTiers('reel') },
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
  { id: 'lamp', group: 'dive', name: 'Headlamp', nameZh: '头灯', ...fromTiers('lamp') },
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


/** Re-read the dive gear's prices from equipment.ts after setUpgradeCosts() (the on-chain Config's). */
export function syncUpgradePrices(): void {
  for (const def of UPGRADES) {
    const tiers = (EQUIPMENT_TIERS as Partial<Record<UpgradeId, readonly { cost: number }[]>>)[def.id];
    if (tiers) def.prices = [tiers[0].cost, tiers[1].cost, tiers[2].cost];
  }
}

/**
 * The boat group's prices from the chain (player_state ProgressConfig.boat_prices, what buy_boat
 * burns): the defaults above are the deployed values until the first read.
 */
export function syncBoatPrices(prices: Partial<Record<UpgradeId, readonly [number, number, number]>>): void {
  for (const def of UPGRADES) {
    const p = def.group === 'boat' ? prices[def.id] : undefined;
    if (p) def.prices = [p[0], p[1], p[2]];
  }
}

const builders: Record<UpgradeId, (level: UpgradeLevel) => THREE.Group> = {
  rod: buildRod,
  reel: buildReel,
  bait: buildBait,
  boat: buildBoat,
  boatSpeed: buildBoatSpeed,
  boatHull: buildBoatHull,
  boatDeck: buildBoatDeck,
  net: buildNet,
  fins: buildFins,
  tank: buildTank,
  lamp: buildLamp,
  sonar: buildSonarDisplay,
};

export interface UpgradeModelOptions {
  /** Keep the physical growth between levels in a shared display frame. */
  preserveTierScale?: boolean;
}

type TierBounds = readonly [number, number, number];
const tierBoundsCache = new Map<UpgradeId, TierBounds>();

function disposeBoundsProbe(model: THREE.Group) {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
  });
}

/**
 * Find a stable reference frame for one upgrade family. Fitting each level
 * independently makes a longer rod, fin, or sonar cable look the same size
 * as its starter version. The probe keeps the largest raw tier as the common
 * frame, so lower tiers retain their real silhouette and growth.
 */
function tierBounds(id: UpgradeId): TierBounds {
  const cached = tierBoundsCache.get(id);
  if (cached) return cached;
  const values = ([1, 2, 3] as const).map((level) => {
    const probe = builders[id](level);
    probe.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(probe).getSize(new THREE.Vector3());
    disposeBoundsProbe(probe);
    return Math.max(size.x, size.y, size.z);
  }) as [number, number, number];
  const result = Object.freeze(values) as TierBounds;
  tierBoundsCache.set(id, result);
  return result;
}

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
function buildSonarDisplay(level: UpgradeLevel): THREE.Group {
  const group = buildDeepSonar({ color: loadSonarConfig().color, lengthLevel: level, detail: 2, startsCarried: false }).group;
  const halos: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) halos.push(object);
  });
  for (const halo of halos) halo.removeFromParent();
  return group;
}

/** Build a centred, two-unit display model shared by the workbench and catalog. */
export function buildUpgradeModel(id: UpgradeId, level: UpgradeLevel, options: UpgradeModelOptions = {}): THREE.Group {
  const inner = builders[id](level);
  const bounds = new THREE.Box3().setFromObject(inner);
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const rawMax = Math.max(size.x, size.y, size.z);
  let tierScale = 1;
  let scale = 2 / rawMax;
  if (options.preserveTierScale) {
    const familyBounds = tierBounds(id);
    const familyMax = Math.max(...familyBounds);
    // Do not let an upgraded assembly that is naturally more compact (for
    // example an outboard motor replacing long oars) appear smaller. A tier's
    // display scale is at least the largest previous tier, while genuinely
    // longer equipment keeps its authored growth.
    tierScale = rawMax / familyMax;
    for (let index = 0; index < level; index++) tierScale = Math.max(tierScale, familyBounds[index] / familyMax);
    scale = (2 * tierScale) / rawMax;
  }
  inner.scale.multiplyScalar(scale);
  // Scale the translation too; otherwise an off-centre raw model stays offset.
  inner.position.sub(centre).multiplyScalar(scale);
  const outer = new THREE.Group();
  outer.name = `HackRU_${id}_Lv${level}`;
  outer.userData = {
    upgradeId: id,
    level,
    source: 'buildUpgradeModel',
    visualOnly: true,
    // Consumers that put different gear families on one table can preserve
    // the tier growth after applying their own family-level display size.
    tierScale: options.preserveTierScale ? tierScale : 1,
    preserveTierScale: options.preserveTierScale === true,
  };
  outer.add(inner);
  return outer;
}

import { ZONES, fishValue, type FishSpec, type Band } from './fish';
import { storageKey } from './wallet';
import type { Climate } from './weather';
import { t } from './i18n';

// The three waters from the design doc (design/game-design-document.md, section 6).
// A map is pure data: how deep its shelf goes (which shallow zones it has),
// when it unlocks, and its palette and scenery. The first two maps have a
// continuous floor; only the open ocean has a bottomless trench.
// world.ts builds the underwater terrain from it, scenery.ts the shoreline.

export type MapId = 'fjord' | 'tianchi' | 'ocean';

export interface MapDef {
  id: MapId;
  name: string;
  nameZh: string;
  place: string;
  /** Typical surface temperature in °C at midday; the workbench briefing adds weather variation. */
  surfaceTempC: number;
  difficulty: 'Casual' | 'Normal' | 'Hard';
  /** How many depth zones the shelf spans, counted down from the surface. */
  zoneCount: 1 | 2 | 3;
  /** Nominal floor depth, independent of the number of named zones. */
  seabedDepth: number;
  /** Whether the seabed opens into a bottomless trench under the boat. */
  hasTrench: boolean;
  /** Names shown on the depth gauge for the shelf zones. */
  zoneLabels: readonly string[];
  /**
   * Lifetime banked value (player_state Progress.lifetime_value) needed before this map opens.
   * The chain's ProgressConfig decides: setMapThresholds overwrites these defaults (the deployed
   * values) on every read.
   */
  unlockValue: number;
  blurb: string;
  sky: string;
  nightSky: string;
  /** Fog range above the water: [near, far]. A short range reads as mist. */
  haze: readonly [number, number];
  surface: string;
  /** Wave height relative to the open ocean. */
  waves: number;
  /** How the natural weather runs here. */
  climate: Climate;
  /**
   * How much higher a full storm piles the swell, as a share of its height (0: storms
   * only bring wind and rain). Above 0, rogue waves can capsize the boat (see storm.ts).
   */
  stormSwell: number;
  /**
   * Sharks always hunt here: one to two by day, two to four at night (see shark.ts). A bite
   * costs this dive's unsettled catch and resets the dive gear upgrades (main.ts sharkBite).
   */
  sharks: boolean;
  /** Water colour by depth in metres. */
  water: readonly (readonly [number, string])[];
  sand: string;
  rocks: readonly string[];
  /** What covers the bottom besides rock and kelp. */
  life: 'none' | 'logs' | 'coral';
  /** How many tall kelp stand on the shelf; flora.ts says what else grows and in which colours. */
  kelp: { count: number };
}

export const MAPS: Record<MapId, MapDef> = {
  fjord: {
    id: 'fjord',
    name: 'Fjord',
    nameZh: '峡湾',
    place: 'Norway / Iceland',
    surfaceTempC: 7,
    difficulty: 'Casual',
    zoneCount: 2,
    seabedDepth: 60,
    hasTrench: false,
    zoneLabels: ['Shallows', 'Kelp Forest'],
    unlockValue: 0,
    blurb: 'Calm glacial water between snow peaks. Kelp forests reach a rocky floor at 60 m.',
    sky: '#bfe6f2',
    nightSky: '#07122b',
    haze: [50, 240],
    surface: '#a5e6ea',
    waves: 0.5,
    climate: 'temperate',
    stormSwell: 0,
    sharks: false,
    water: [
      [0, '#5fc9c4'],
      [8, '#2c8f9c'],
      [20, '#135a72'],
      [40, '#0a3350'],
      [60, '#04162b'],
      [100, '#020d1d'],
    ],
    sand: '#9aa7ad',
    rocks: ['#5b6b78', '#46535f', '#6f7f8a', '#39444f'],
    life: 'none',
    kelp: { count: 55 },
  },
  tianchi: {
    id: 'tianchi',
    name: 'Heaven Lake',
    nameZh: '天池',
    place: 'Zhangjiajie / Changbai',
    surfaceTempC: 14,
    difficulty: 'Normal',
    zoneCount: 3,
    seabedDepth: 100,
    hasTrench: false,
    zoneLabels: ['Shallows', 'Sunken Forest', 'Deep Basin'],
    unlockValue: 150,
    blurb: 'A misty mountain lake ringed by stone pillars. Drowned trees and a deep basin at 100 m.',
    sky: '#d6e6dc',
    nightSky: '#0a1620',
    haze: [30, 190],
    surface: '#93dfc6',
    waves: 0.3,
    climate: 'temperate',
    stormSwell: 0,
    sharks: false,
    water: [
      [0, '#4fbf9f'],
      [10, '#23876f'],
      [25, '#0f5a55'],
      [45, '#06302f'],
      [60, '#021514'],
      [100, '#010b0e'],
    ],
    sand: '#7d7a63',
    rocks: ['#6a6657', '#55513f', '#7b7765', '#403d31'],
    life: 'logs',
    kelp: { count: 26 },
  },
  ocean: {
    id: 'ocean',
    name: 'Open Ocean',
    nameZh: '汪洋',
    place: 'The deep sea',
    surfaceTempC: 22,
    difficulty: 'Hard',
    zoneCount: 3,
    seabedDepth: 62,
    hasTrench: true,
    zoneLabels: ['Shallows', 'Reef', 'Abyss'],
    unlockValue: 1000,
    blurb: 'Open water under a storm front. Reef and abyss on the widest shelf.',
    sky: '#a8e3f5',
    nightSky: '#0b1430',
    haze: [40, 200],
    surface: '#8fe3f2',
    waves: 1,
    climate: 'stormy',
    stormSwell: 1,
    sharks: true,
    water: [
      [0, '#46c1d6'],
      [12, '#1f86a8'],
      [30, '#0d4d73'],
      [45, '#06213f'],
      [60, '#020a1a'],
      [140, '#010510'],
    ],
    sand: '#c2a874',
    rocks: ['#5d6f7a', '#4a5b68', '#6b7d85', '#3e4c59'],
    life: 'coral',
    kelp: { count: 55 },
  },
};

export const MAP_ORDER: readonly MapId[] = ['fjord', 'tianchi', 'ocean'];

export function mapZones(map: MapDef): readonly (Band & { name: string; rewardMultiplier: number })[] {
  return ZONES.slice(0, map.zoneCount).map((zone, i) => i === map.zoneCount - 1
    ? { ...zone, bottom: map.seabedDepth - 2 }
    : zone);
}

/** Nominal seabed depth; local terrain has a few metres of height variation. */
export function mapDepth(map: MapDef): number {
  return map.seabedDepth;
}

// Display text in the player's language. The data above stays English (chain.ts reads
// zoneLabels); screens call these at render time.
const PLACE_ZH: Record<string, string> = {
  'Norway / Iceland': '挪威 / 冰岛',
  'Zhangjiajie / Changbai': '张家界 / 长白山',
  'The deep sea': '深海',
};
const BLURB_ZH: Record<string, string> = {
  'Calm glacial water between snow peaks. Kelp forests reach a rocky floor at 60 m.': '雪峰间平静的冰川水域。海带森林一直延伸到 60 米深的岩石海底。',
  'A misty mountain lake ringed by stone pillars. Drowned trees and a deep basin at 100 m.': '石柱环绕的雾锁山湖。沉没的树林下方，是 100 米深的湖底盆地。',
  'Open water under a storm front. Reef and abyss on the widest shelf.': '暴风前线下的开阔海面，最宽的大陆架上有礁区和深渊。',
};
const ZONE_ZH: Record<string, string> = { Shallows: '浅滩', 'Kelp Forest': '海带林', 'Sunken Forest': '沉林', 'Deep Basin': '深水盆地', Reef: '礁区', Abyss: '深渊' };
const DIFFICULTY_ZH = { Casual: '休闲', Normal: '普通', Hard: '困难' } as const;

export function mapPlace(map: MapDef): string {
  return t(map.place, PLACE_ZH[map.place] ?? map.place);
}
export function mapBlurb(map: MapDef): string {
  return t(map.blurb, BLURB_ZH[map.blurb] ?? map.blurb);
}
export function mapDifficulty(map: MapDef): string {
  return t(map.difficulty, DIFFICULTY_ZH[map.difficulty]);
}
export function mapZoneLabel(label: string): string {
  return t(label, ZONE_ZH[label] ?? label);
}

// ---- Progress -----------------------------------------------------------

export interface MapProgress {
  selected: MapId;
  /**
   * The lifetime banked value: the on-chain Progress.lifetime_value (record_catch adds each
   * co-signed fish once). Saved only as a display cache; maps open on it only once `verified`.
   */
  bestValue: number;
  /** bestValue came from this session's chain read for the connected wallet (never saved). */
  verified: boolean;
}

const KEY = 'deepbreath.maps';

export function loadMapProgress(): MapProgress {
  const progress: MapProgress = { selected: 'fjord', bestValue: 0, verified: false };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(KEY)) ?? '{}');
    if (saved.selected in MAPS) progress.selected = saved.selected;
    if (Number.isFinite(saved.bestValue)) progress.bestValue = saved.bestValue;
  } catch {}
  return progress;
}

export function saveMapProgress(progress: MapProgress) {
  try {
    localStorage.setItem(storageKey(KEY), JSON.stringify({ selected: progress.selected, bestValue: progress.bestValue }));
  } catch {}
}

/** The chain's map thresholds (ProgressConfig.map_thresholds), applied to MAPS. */
export function setMapThresholds(thresholds: Record<MapId, number>) {
  for (const id of MAP_ORDER) if (Number.isFinite(thresholds[id])) MAPS[id].unlockValue = thresholds[id];
}

/** What shark waters say before you dive there (the chart's place card and the one-time warning). */
export const SHARK_WARNING = {
  en: "Sharks hunt here. A bite costs this dive's catch and resets your dive gear upgrades.",
  zh: '鲨鱼在此出没。被咬一口，本次下潜的渔获全部损失，潜水装备升级重置为 1 级。',
} as const;

const SHARK_WARNED_KEY = 'sharkWarned';

/** Has this wallet acknowledged the shark warning once? Then later dives on shark waters don't ask again. */
export function sharkWarningSeen(): boolean {
  try {
    return localStorage.getItem(storageKey(SHARK_WARNED_KEY)) === '1';
  } catch {
    return false;
  }
}

export function markSharkWarningSeen() {
  try {
    localStorage.setItem(storageKey(SHARK_WARNED_KEY), '1');
  } catch {}
}

export function bankValue(bank: readonly FishSpec[]): number {
  return bank.reduce((sum, fish) => sum + fishValue(fish), 0);
}

/** "you have N" under a locked map; "checking…" until the chain read for this wallet came back. */
export function lockProgress(progress: MapProgress): string {
  const have = Math.floor(progress.bestValue);
  return progress.verified ? t(`you have ${have}`, `当前 ${have}`) : t(`checking the chain… (last seen ${have})`, `正在读取链上进度…（上次 ${have}）`);
}

/** Open: free from the start, or the chain-read lifetime value reached its threshold (a cached value never opens a map). */
export function isUnlocked(map: MapDef, progress: MapProgress): boolean {
  return map.unlockValue <= 0 || (progress.verified && progress.bestValue >= map.unlockValue);
}

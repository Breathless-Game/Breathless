import { ZONES, fishValue, type FishSpec, type Zone } from './fish';
import { storageKey } from './wallet';

// The three waters from the design doc (design/game-design-document.md, section 6).
// A map is pure data: how deep its shelf goes (which shallow zones it has),
// when it unlocks, and its palette and scenery. Every map has a
// bottomless trench under the boat, so a map never limits how deep you dive.
// world.ts builds the underwater terrain from it, scenery.ts the shoreline.

export type MapId = 'fjord' | 'tianchi' | 'ocean';

export interface MapDef {
  id: MapId;
  name: string;
  nameZh: string;
  place: string;
  difficulty: 'Casual' | 'Normal' | 'Hard';
  /** How many depth zones the shelf spans, counted down from the surface. */
  zoneCount: 1 | 2 | 3;
  /** Names shown on the depth gauge for the shelf zones; the gauge adds the Trench below them. */
  zoneLabels: readonly string[];
  /** Total value of banked fish needed before this map opens. */
  unlockValue: number;
  blurb: string;
  sky: string;
  nightSky: string;
  /** Fog range above the water: [near, far]. A short range reads as mist. */
  haze: readonly [number, number];
  surface: string;
  /** Wave height relative to the open ocean. */
  waves: number;
  /** Water colour by depth in metres. */
  water: readonly (readonly [number, string])[];
  sand: string;
  /** Fixed facet pigments for each underwater biome. */
  sediment: readonly string[];
  rocks: readonly string[];
  /** What covers the bottom besides rock and kelp. */
  life: 'none' | 'logs' | 'coral';
  kelp: { count: number; hue: readonly [number, number]; palette: readonly string[] };
}

export const MAPS: Record<MapId, MapDef> = {
  fjord: {
    id: 'fjord',
    name: 'Fjord',
    nameZh: '峡湾',
    place: 'Norway / Iceland',
    difficulty: 'Casual',
    zoneCount: 1,
    zoneLabels: ['Shallows'],
    unlockValue: 0,
    blurb: 'Calm glacial water between snow peaks. A shallow shelf, then a sheer drop.',
    sky: '#bfe6f2',
    nightSky: '#07122b',
    haze: [50, 240],
    surface: '#a5e6ea',
    waves: 0.5,
    water: [
      [0, '#5fc9c4'],
      [8, '#2c8f9c'],
      [20, '#135a72'],
      [40, '#0a3350'],
      [60, '#04162b'],
    ],
    sand: '#9aa7ad',
    sediment: ['#9eafb0', '#7e979d', '#b4c3ba', '#869ca7', '#a5b6a4'],
    rocks: ['#728d9a', '#516a80', '#8eaba9', '#617d86', '#a2b8b2'],
    life: 'none',
    kelp: { count: 72, hue: [0.27, 0.40], palette: ['#73b68c', '#91bb69', '#57a69b', '#acd08b'] },
  },
  tianchi: {
    id: 'tianchi',
    name: 'Heaven Lake',
    nameZh: '天池',
    place: 'Zhangjiajie / Changbai',
    difficulty: 'Normal',
    zoneCount: 2,
    zoneLabels: ['Shallows', 'Sunken Forest'],
    unlockValue: 150,
    blurb: 'A misty mountain lake ringed by stone pillars. Drowned trees below.',
    sky: '#d6e6dc',
    nightSky: '#0a1620',
    haze: [30, 190],
    surface: '#93dfc6',
    waves: 0.3,
    water: [
      [0, '#4fbf9f'],
      [10, '#23876f'],
      [25, '#0f5a55'],
      [45, '#06302f'],
      [60, '#021514'],
    ],
    sand: '#7d7a63',
    sediment: ['#b5ac77', '#969960', '#cfbe8e', '#a6b17d', '#b7a487'],
    rocks: ['#9c986a', '#777e62', '#c0b187', '#819682', '#a69778'],
    life: 'logs',
    kelp: { count: 38, hue: [0.18, 0.29], palette: ['#a8c15c', '#7fa964', '#c6ca77', '#72b493'] },
  },
  ocean: {
    id: 'ocean',
    name: 'Open Ocean',
    nameZh: '汪洋',
    place: 'The deep sea',
    difficulty: 'Hard',
    zoneCount: 3,
    zoneLabels: ['Shallows', 'Reef', 'Abyss'],
    unlockValue: 1000,
    blurb: 'Open water under a storm front. Reef and abyss on the widest shelf.',
    sky: '#a8e3f5',
    nightSky: '#0b1430',
    haze: [40, 200],
    surface: '#8fe3f2',
    waves: 1,
    water: [
      [0, '#46c1d6'],
      [12, '#1f86a8'],
      [30, '#0d4d73'],
      [45, '#06213f'],
      [60, '#020a1a'],
    ],
    sand: '#c2a874',
    sediment: ['#d2b98a', '#b0bda0', '#dcca9d', '#90b4b4', '#b6ada5'],
    rocks: ['#749da9', '#638395', '#a8bdb5', '#9c9fae', '#a1aba0'],
    life: 'coral',
    kelp: { count: 72, hue: [0.30, 0.45], palette: ['#55bea7', '#83c98a', '#62b8bc', '#afd697'] },
  },
};

export const MAP_ORDER: readonly MapId[] = ['fjord', 'tianchi', 'ocean'];

export function mapZones(map: MapDef): readonly Zone[] {
  return ZONES.slice(0, map.zoneCount);
}

/** Shelf depth in metres: the bottom of the deepest shelf zone plus a little floor clearance. The trench under the boat drops away from here with no bottom. */
export function mapDepth(map: MapDef): number {
  return ZONES[map.zoneCount - 1].bottom + 2;
}

// ---- Progress -----------------------------------------------------------

export interface MapProgress {
  selected: MapId;
  /** Highest total banked value ever reached, so selling fish later cannot re-lock a map. */
  bestValue: number;
  /** Demo switch: every map is open regardless of value. */
  unlockAll: boolean;
}

const KEY = 'deepbreath.maps';

export function loadMapProgress(): MapProgress {
  const progress: MapProgress = { selected: 'fjord', bestValue: 0, unlockAll: false };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(KEY)) ?? '{}');
    if (saved.selected in MAPS) progress.selected = saved.selected;
    if (Number.isFinite(saved.bestValue)) progress.bestValue = saved.bestValue;
    progress.unlockAll = saved.unlockAll === true;
  } catch {}
  return progress;
}

export function saveMapProgress(progress: MapProgress) {
  try {
    localStorage.setItem(storageKey(KEY), JSON.stringify(progress));
  } catch {}
}

export function bankValue(bank: readonly FishSpec[]): number {
  return bank.reduce((sum, fish) => sum + fishValue(fish), 0);
}

export function isUnlocked(map: MapDef, progress: MapProgress): boolean {
  return progress.unlockAll || progress.bestValue >= map.unlockValue;
}

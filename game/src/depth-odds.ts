// Rarity as a smooth function of depth. The sea has no bottom, so deeper
// should always be (a little) better, and the best fish should cost a real
// breath-hold to reach.
//
// Pure module with no runtime imports: tests transpile it on its own.

import type { Rarity } from './fish';

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const satisfies readonly Rarity[];

type Weights = [common: number, uncommon: number, rare: number, epic: number, legendary: number, mythic: number];

// Percent weights per rarity at anchor depths (metres, positive down). Each
// row sums to 100. Between anchors the weights are linearly interpolated;
// below the last anchor they stay constant.
//
// Gates: rare below 18 m, epic below 40 m, legendary below 80 m,
// mythic below 80 m. Higher tiers require progressively deeper dives.
export const RARITY_BY_DEPTH: [depthM: number, weights: Weights][] = [
  [0, [92, 8, 0, 0, 0, 0]],
  [18, [75, 25, 0, 0, 0, 0]],
  [40, [55, 32, 13, 0, 0, 0]],
  [50, [48, 33, 16, 3, 0, 0]],
  [80, [35, 34, 24, 7, 0, 0]],
  [120, [9, 27, 30, 17, 12, 5]],
  [150, [3, 24, 33, 20.6, 14, 5.4]],
  [200, [0, 17, 34, 26, 17, 6]],
  [350, [0, 6, 30, 31, 23, 10]],
];

function weightsAt(depthM: number): readonly number[] {
  const d = depthM > 0 ? depthM : 0; // also maps NaN to the surface
  const last = RARITY_BY_DEPTH[RARITY_BY_DEPTH.length - 1];
  if (d >= last[0]) return last[1];
  let i = 0;
  while (RARITY_BY_DEPTH[i + 1][0] <= d) i++;
  const [d0, a] = RARITY_BY_DEPTH[i];
  const [d1, b] = RARITY_BY_DEPTH[i + 1];
  const t = (d - d0) / (d1 - d0);
  return a.map((w, k) => w + (b[k] - w) * t);
}

/** `[rarity, weight]` pairs (common..mythic) for `Rng.weighted`; zero weights are left out. */
export function rarityOdds(depthM: number): [Rarity, number][] {
  const w = weightsAt(depthM);
  const odds: [Rarity, number][] = [];
  RARITIES.forEach((rarity, k) => {
    if (w[k] > 0) odds.push([rarity, w[k]]);
  });
  return odds;
}

export function zoneName(depthM: number): string {
  return depthM < 18 ? 'Shallows' : depthM < 38 ? 'Coral Reef' : depthM < 60 ? 'The Abyss' : 'The Trench';
}

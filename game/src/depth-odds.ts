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
// Gates: epic only below 15 m, legendary only below 30 m, mythic only below
// 50 m. The anchors are spaced for the measured ~7.75 m/s swim speed: a 30 s
// hold reaches ~115 m and back with no fishing, 60 s ~230 m. Casual players
// fish ~40–80 m (legendary+ 0.5–1.5%), strong ones 120–200 m (3–6%).
export const RARITY_BY_DEPTH: [depthM: number, weights: Weights][] = [
  [0, [90, 9.5, 0.5, 0, 0, 0]],
  [15, [80, 17, 3, 0, 0, 0]],
  [30, [68, 24, 7, 1, 0, 0]],
  [50, [58, 28, 10.5, 3, 0.5, 0]],
  [80, [48, 31, 14, 5.5, 1.3, 0.2]],
  [120, [39, 32, 18, 8, 2.4, 0.6]],
  [200, [30, 30, 22, 12, 4.5, 1.5]],
  [350, [22, 26, 25, 16.5, 7.5, 3]],
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

import { Rng } from './rng';
import type { SceneryDetail } from './render-quality';

const smooth = (x: number, a: number, b: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A fixed village plan: lower quality drops homes without moving the survivors. */
export function villageHomes(detail: SceneryDetail) {
  const rng = new Rng(0x51a9e);
  const sites = [[-27, -100], [29, -105], [-52, -67], [59, -68], [-64, -70], [72, -72],
    [-79, -72], [87, -74], [-61, -86], [73, -89], [-78, -89], [88, -91]];
  return sites.map(([x, z]) => ({ x, z, w: rng.range(3.6, 5), h: rng.range(2.3, 3.1), d: rng.range(3, 4),
    color: rng.pick(['#9b493c', '#b59b6a', '#ddd6bc', '#566e78']) })).slice(0, [4, 8, 12][detail - 1]);
}

/** Hearths are quiet by day, most active at sunset and much fainter after midnight. */
export function hearthActivity(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  return smooth(h, 16, 18) * (1 - 0.88 * smooth(h, 21, 24)) + 0.12 * (1 - smooth(h, 0, 5));
}

function occupancy(seed: number, slot: number): number {
  let n = Math.imul(seed + 1, 0x45d9f3b) ^ Math.imul(slot, 0x27d4eb2d);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Independent, slow household schedules with soft transitions; no per-tick randomness. */
export function windowActivity(time: number, seed: number): number {
  const t = time / 54 + occupancy(seed, -1) * 4;
  const slot = Math.floor(t);
  const level = (s: number) => occupancy(seed, s) > 0.38 ? 0.48 + occupancy(seed, s + 719) * 0.3 : 0;
  const a = level(slot), b = level(slot + 1);
  return a + (b - a) * smooth(t - slot, 0.72, 1);
}

/** Windows ease in through dusk rather than snapping at the world's night threshold. */
export function villageNight(nightMix: number): number {
  return smooth(nightMix, 0.35, 0.95);
}

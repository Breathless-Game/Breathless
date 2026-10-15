import type { Band } from './fish';

/** Fixed depth slices preserve encounter density without stocking an entire deep map. */
export interface ShelfFishBand {
  key: string;
  band: Band;
  count: number;
}

const SLICE_M = 20;
// Match the original 32 / 32 / 24 fish in the 18 / 20 / 22 metre reference zones.
const FISH_PER_METRE = [32 / 18, 32 / 20, 24 / 22];
const LOAD_M = 36;
const KEEP_M = 56;

export function buildShelfFishBands(zones: readonly Band[]): ShelfFishBand[] {
  const result: ShelfFishBand[] = [];
  zones.forEach((zone, index) => {
    for (let top = zone.top; top < zone.bottom;) {
      let bottom = Math.min(zone.bottom, top + SLICE_M);
      // Do not leave a slice too short for fish to choose a roaming target.
      if (zone.bottom - bottom < 4) bottom = zone.bottom;
      result.push({
        key: `${index}:${top}`,
        band: { top, bottom },
        count: Math.ceil((bottom - top) * FISH_PER_METRE[Math.min(index, FISH_PER_METRE.length - 1)]),
      });
      top = bottom;
    }
  });
  return result;
}

/** Load well beyond the camera; a wider keep range prevents churn at slice edges. */
export function shelfFishWindow(stock: readonly ShelfFishBand[], depthM: number) {
  const depth = Number.isFinite(depthM) ? Math.max(0, depthM) : 0;
  const distance = ({ band }: ShelfFishBand) => Math.max(band.top - depth, depth - band.bottom, 0);
  return {
    load: stock.filter(slice => distance(slice) <= LOAD_M),
    keep: new Set(stock.filter(slice => distance(slice) <= KEEP_M).map(slice => slice.key)),
  };
}

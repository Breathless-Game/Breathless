import type { MapId } from './maps';

// What grows on each map's shelf. world.ts plants it, kelp.ts models it.

/** `giant` is the tall canopy kelp; the other three stay near the bottom. */
export type Species = 'giant' | 'ribbon' | 'broadleaf' | 'feather';
export type Understory = Exclude<Species, 'giant'>;

export interface Flora {
  /** Share of the understory each species takes; the three sum to 1. */
  understory: Readonly<Record<Understory, number>>;
  /** Understory plants per canopy plant. */
  undergrowth: number;
  /** Leaf pigments (sRGB) a plant picks from by its seed. */
  pigments: Readonly<Record<Species, readonly string[]>>;
  /** Young growth: blade tips lean toward this colour. */
  tip: string;
}

export const FLORA: Record<MapId, Flora> = {
  // Cold glacial shelf: dark olive kelp, brown sugar kelp and red algae on gray gravel.
  fjord: {
    understory: { ribbon: 0.4, broadleaf: 0.25, feather: 0.35 },
    undergrowth: 1.5,
    pigments: {
      giant: ['#44793f', '#52843f', '#356c4e', '#648a3a'],
      ribbon: ['#4f9a6c', '#5fae7a', '#3f8f7a'],
      broadleaf: ['#7a6f38', '#8a7a3c', '#6f7440'],
      feather: ['#8c4458', '#a0506a', '#7a3f5c'],
    },
    tip: '#b9d07a',
  },
  // Jade mountain lake: yellow-green freshwater weeds between the drowned trunks.
  tianchi: {
    understory: { ribbon: 0.5, broadleaf: 0.15, feather: 0.35 },
    undergrowth: 2,
    pigments: {
      giant: ['#7c8a34', '#8f963a', '#6a8440', '#9aa044'],
      ribbon: ['#93b04a', '#a7bd55', '#7fa64f'],
      broadleaf: ['#4f9c7a', '#5fb089', '#3f8a6f'],
      feather: ['#b7b24a', '#c9bd58', '#a3a843'],
    },
    tip: '#e3dc86',
  },
  // Warm reef: emerald kelp, bright seagrass, teal fans and purple sea ferns beside the coral.
  ocean: {
    understory: { ribbon: 0.35, broadleaf: 0.35, feather: 0.3 },
    undergrowth: 1.5,
    pigments: {
      giant: ['#2e7d54', '#37905f', '#2a6f62', '#4a9a55'],
      ribbon: ['#59b56b', '#6cc47a', '#48a57f'],
      broadleaf: ['#2f9c8f', '#38ad9c', '#278a8c'],
      feather: ['#8a5fb5', '#a06cc4', '#c05f9a'],
    },
    tip: '#bfe88a',
  },
};

/** The species of understory plant `index` out of `total`, spread evenly so any prefix keeps the mix. */
export function understorySpecies(flora: Flora, index: number): Understory {
  // Golden-ratio stepping visits the shares in a well-mixed order without an RNG.
  const u = (index * 0.6180339887 + 0.37) % 1;
  const { ribbon, broadleaf } = flora.understory;
  return u < ribbon ? 'ribbon' : u < ribbon + broadleaf ? 'broadleaf' : 'feather';
}

/**
 * How leaf colour changes with the depth (m) a face sits at, as [brightness, blueShift].
 * Red and yellow light is absorbed first, so growth in the Shallows is bright and warm,
 * on the Reef saturated green, and in the Abyss dim and blue-green.
 */
export function depthTint(depth: number): [number, number] {
  const t = Math.min(1, Math.max(0, (depth - 6) / 50));
  const eased = t * t * (3 - 2 * t);
  return [1.14 - 0.42 * eased, 0.3 * eased];
}

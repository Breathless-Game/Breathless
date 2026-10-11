import { Rng } from './rng';
import type { Species, Understory } from './flora';

// Where the sand, rocks and plants of a shelf go. Pure data, no rendering:
// world.ts turns it into meshes. Everything here rests on the sand it is drawn
// on: rocks are part-buried, stacks pile up from the bottom, plants root on
// the actual triangles of the seabed.

export interface ShelfBounds {
  /** Half-width of the trench under the boat; the sand starts here. */
  trench: number;
  /** Outer edge of the sand in x, and its extent in z. */
  outer: number;
  zMin: number;
  zMax: number;
}

/** Height of the sand above the shelf level at (x, z), before per-vertex noise. It rolls off at the trench edge. */
export function shelfHeight(x: number, z: number, trench: number): number {
  const edge = Math.max(0, 1 - (Math.abs(x) - trench) / 4);
  return Math.sin(x * 0.08) * 2.2 + Math.cos(z * 0.15 + 3.75 + x * 0.03) * 1.5 - edge * 1.5;
}

/**
 * The sand as a grid of heights, one half each side of the trench. The mesh is
 * built from `triangles`, and `heightAt` reads the same triangles back, so
 * whatever is placed with it sits exactly on the drawn surface.
 */
export class Shelf {
  readonly columns: number;
  readonly rows: number;
  private readonly dx: number;
  private readonly dz: number;
  /** Heights above the shelf level: [left half, right half], row-major from zMin. */
  private readonly heights: [Float32Array, Float32Array];

  constructor(seed: number, readonly bounds: ShelfBounds, cell = 3.1) {
    const { trench, outer, zMin, zMax } = bounds;
    this.columns = Math.round((outer - trench) / cell);
    this.rows = Math.round((zMax - zMin) / cell);
    this.dx = (outer - trench) / this.columns;
    this.dz = (zMax - zMin) / this.rows;
    const rng = new Rng(seed);
    this.heights = [0, 1].map((side) => {
      const grid = new Float32Array((this.columns + 1) * (this.rows + 1));
      for (let r = 0; r <= this.rows; r++) {
        for (let c = 0; c <= this.columns; c++) {
          grid[r * (this.columns + 1) + c] = shelfHeight(this.x(side, c), zMin + r * this.dz, trench) + rng.range(-0.6, 0.6);
        }
      }
      return grid;
    }) as [Float32Array, Float32Array];
  }

  private x(side: number, column: number) {
    return side === 0 ? -this.bounds.outer + column * this.dx : this.bounds.trench + column * this.dx;
  }

  /** Cells are cut along alternating diagonals so the facets do not all lean one way. */
  private static slash(row: number, column: number) {
    return (row + column) % 2 === 0;
  }

  /** Height of the drawn sand above the shelf level. Over the trench it returns the nearer edge. */
  heightAt(x: number, z: number): number {
    const { trench, outer, zMin, zMax } = this.bounds;
    const side = x < 0 ? 0 : 1;
    const ax = Math.min(outer, Math.max(trench, Math.abs(x)));
    const fx = Math.min(this.columns - 1e-6, (side === 0 ? outer - ax : ax - trench) / this.dx);
    const fz = Math.min(this.rows - 1e-6, (Math.min(zMax, Math.max(zMin, z)) - zMin) / this.dz);
    const c = Math.floor(fx), r = Math.floor(fz);
    const u = fx - c, v = fz - r;
    const grid = this.heights[side];
    const i = r * (this.columns + 1) + c;
    const a = grid[i], b = grid[i + 1], cc = grid[i + this.columns + 1], d = grid[i + this.columns + 2];
    if (Shelf.slash(r, c)) return u + v <= 1 ? a + u * (b - a) + v * (cc - a) : d + (1 - u) * (cc - d) + (1 - v) * (b - d);
    return v >= u ? a + v * (cc - a) + u * (d - cc) : a + u * (b - a) + v * (d - b);
  }

  /** Non-indexed triangles of one half (0 left, 1 right) as x, height, z, facing up. */
  triangles(side: 0 | 1): Float32Array {
    const out = new Float32Array(this.columns * this.rows * 18);
    const grid = this.heights[side];
    let o = 0;
    const put = (r: number, c: number) => {
      out[o++] = this.x(side, c);
      out[o++] = grid[r * (this.columns + 1) + c];
      out[o++] = this.bounds.zMin + r * this.dz;
    };
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        if (Shelf.slash(r, c)) {
          put(r, c); put(r + 1, c); put(r, c + 1);
          put(r, c + 1); put(r + 1, c); put(r + 1, c + 1);
        } else {
          put(r, c); put(r + 1, c); put(r + 1, c + 1);
          put(r, c); put(r + 1, c + 1); put(r, c + 1);
        }
      }
    }
    return out;
  }
}

export interface RockSlot {
  x: number;
  /** Height of the rock's centre above the shelf level. */
  y: number;
  z: number;
  r: number;
  /** Vertical squash: the rock is r * squash tall from its centre. */
  squash: number;
  seed: number;
  /** Lowest scenery detail (1..3) that still builds this rock; the big ones are always there. */
  tier: 1 | 2 | 3;
}

export interface PlantSlot {
  x: number;
  /** Height of the root above the shelf level. */
  y: number;
  z: number;
  seed: number;
  /** 0..1: how tall this plant grows within its species' range. */
  vigor: number;
}

export interface SeabedLayout {
  /** Boulder groups on the near shelf, biggest rock first, then the rocks leaning on it and its scree. */
  outcrops: RockSlot[];
  /** Rock piled on rock along the back of the shelf, bottom first within each stack. */
  stacks: RockSlot[];
  /** Tall kelp, ordered so that any prefix is spread over the whole shelf. */
  canopy: PlantSlot[];
  /** Low plants in the order asked for: seagrass in meadows on open sand, the rest against the rocks. */
  understory: (PlantSlot & { species: Understory })[];
}

export interface LayoutOptions {
  seed: number;
  /** Depth of the shelf in metres. */
  depth: number;
  /** The diver swims |x| up to this far out. */
  reach: number;
  /** How many tall kelp to root. */
  canopy: number;
  /** The low plants to root, one per entry. */
  understory: readonly Understory[];
}

// The diver and the fish swim at z in [-5, 3]. Big rocks keep out of that lane;
// kelp mostly stands behind it, with a little in front of and inside it.
const LANE: readonly [number, number] = [-5, 3];
const BACK_BED: readonly [number, number] = [-16, -5.5];
const FRONT_BED: readonly [number, number] = [4.5, 9];
const INNER_BED: readonly [number, number] = [-3.5, 2];

const seedOf = (rng: Rng) => rng.int(1, 0x7fffffff);

/** Lay out one map's shelf. The same seed, depth and counts always give the same shelf. */
export function layoutSeabed(shelf: Shelf, options: LayoutOptions): SeabedLayout {
  const { trench } = shelf.bounds;
  const rng = new Rng(options.seed);
  // Nothing stands past the edge of the sand, however far the diver may swim.
  const edge = shelf.bounds.outer - 3;
  const within = (reach: number) => Math.min(reach, edge);
  // Outcrops, rubble, groves and meadows are counted per metre of shelf, so a wider map is as busy as a narrow one.
  const span = within(options.reach + 4) - (trench + 5);
  const perSide = (metresEach: number) => Math.max(1, Math.round(span / metresEach));
  const ground = (x: number, z: number) => shelf.heightAt(x, z);
  /** A rock resting on the sand with its lower part buried. */
  const settle = (x: number, z: number, r: number, squash: number, tier: 1 | 2 | 3, sink: number): RockSlot =>
    ({ x, y: ground(x, z) + r * squash * (1 - 2 * sink), z, r, squash, seed: seedOf(rng), tier });

  // ---- Outcrops: an anchor boulder, rocks leaning on it, scree around it ----
  const outcrops: RockSlot[] = [];
  const anchors: RockSlot[] = [];
  for (const side of [-1, 1]) {
    const wanted = perSide(11);
    for (let tries = 0, placed = 0; placed < wanted && tries < wanted * 16; tries++) {
      const front = rng.next() < 0.35;
      const r = front ? rng.range(1.7, 2.8) : rng.range(2.4, 4.4);
      const x = side * rng.range(trench + 5 + r, within(options.reach + 4) - r);
      const z = front ? rng.range(5.5, 8.5) : rng.range(LANE[0] - 8, LANE[0] - 1.5 - r * 0.6);
      if (anchors.some((a) => Math.hypot(a.x - x, (a.z - z) * 0.6) < 12)) continue;
      const anchor = settle(x, z, r, rng.range(0.6, 0.9), 1, 0.33);
      anchors.push(anchor);
      outcrops.push(anchor);
      placed++;
      const bearing = rng.range(0, Math.PI * 2);
      const leaning = rng.int(2, 3);
      for (let i = 0; i < leaning; i++) {
        const cr = r * rng.range(0.38, 0.62);
        const angle = bearing + (i * Math.PI * 2) / leaning + rng.range(-0.5, 0.5);
        const cx = x + Math.cos(angle) * (r + cr) * 0.72;
        const cz = z + Math.sin(angle) * (r + cr) * 0.55;
        if (Math.abs(cx) < trench + 2 + cr) continue;
        outcrops.push(settle(cx, cz, cr, rng.range(0.55, 0.85), i === 0 ? 1 : 2, 0.3));
      }
      const scree = rng.int(5, 8);
      for (let i = 0; i < scree; i++) {
        const sr = rng.range(0.2, 0.55);
        const angle = rng.range(0, Math.PI * 2);
        const reach = r * rng.range(1.05, 2.4);
        const sx = x + Math.cos(angle) * reach;
        const sz = z + Math.sin(angle) * reach * 0.75;
        if (Math.abs(sx) < trench + 1.5) continue;
        outcrops.push(settle(sx, sz, sr, rng.range(0.5, 0.8), i < 2 ? 2 : 3, 0.25));
      }
    }
  }

  // ---- Back wall: stacks piled from the bottom, never a rock hanging in open water ----
  const stacks: RockSlot[] = [];
  const bases: RockSlot[] = [];
  const headroom = Math.max(4, options.depth - 10);
  for (const side of [-1, 1]) {
    for (let x = trench + 6 + rng.range(0, 5); x < within(options.reach + 24) - 9; x += rng.range(8, 13)) {
      const z = rng.range(-35, -17);
      let r = rng.range(4.5, 8.5);
      let rock = settle(side * x, z, r, rng.range(0.7, 1.05), 1, 0.3);
      bases.push(rock);
      stacks.push(rock);
      // Most stacks stay low; a few climb most of the way to the surface.
      const summit = headroom * Math.pow(rng.next(), 1.6);
      for (let n = 0; n < 9 && rock.y + rock.r * rock.squash < summit; n++) {
        r *= rng.range(0.84, 0.94);
        if (r < 1.8) break;
        const squash = rng.range(0.7, 1.05);
        const next: RockSlot = {
          x: rock.x + rng.range(-0.3, 0.3) * rock.r,
          // Sunk into the rock below, so the pile reads as one mass.
          y: rock.y + rock.r * rock.squash * 0.6 + r * squash * 0.4,
          z: rock.z + rng.range(-0.3, 0.3) * rock.r,
          r, squash, seed: seedOf(rng), tier: 1,
        };
        stacks.push(next);
        rock = next;
      }
    }
    // Lower boulders between the stacks close the wall's foot.
    const rubble = perSide(6);
    for (let i = 0; i < rubble; i++) {
      const r = rng.range(2, 4.5);
      const x = side * rng.range(trench + 3 + r, within(options.reach + 22) - r);
      stacks.push(settle(x, rng.range(-30, -14 - r * 0.5), r, rng.range(0.6, 0.95), i % 9 < 5 ? 1 : 2, 0.3));
    }
  }

  // ---- Plants ----
  const big = [...outcrops, ...bases].filter((rock) => rock.r >= 1);
  const inRock = (x: number, z: number, margin: number) =>
    big.some((rock) => Math.hypot(rock.x - x, rock.z - z) < rock.r * 0.8 + margin);
  const onShelf = (x: number) => Math.abs(x) >= trench + 3 && Math.abs(x) <= within(options.reach + 14);
  const rooted = (x: number, z: number, vigor: number): PlantSlot =>
    ({ x, y: ground(x, z) - 0.15, z, seed: seedOf(rng), vigor });

  // Kelp holds on to rock: groves stand around the outcrops, plus a few on open ground between them.
  const groves = anchors.map((a) => ({ x: a.x, z: a.z, r: a.r }));
  for (const side of [-1, 1]) {
    const open = perSide(27);
    for (let i = 0; i < open; i++) {
      for (let tries = 0; tries < 30; tries++) {
        const x = side * rng.range(trench + 6, within(options.reach + 10));
        if (groves.some((g) => Math.abs(g.x - x) < 9)) continue;
        groves.push({ x, z: rng.range(BACK_BED[0] + 2, BACK_BED[1] - 2), r: 1.2 });
        break;
      }
    }
  }
  const canopy: PlantSlot[] = [];
  for (let round = 0; canopy.length < options.canopy && round < 60; round++) {
    // Visiting every grove once per round makes any prefix a thinner forest, not a missing corner.
    for (const grove of groves) {
      if (canopy.length >= options.canopy) break;
      // One plant in ten stands in the diver's lane to be swum through, one in six in front of it.
      const pick = (round * 7 + canopy.length) % 20;
      const bed = pick === 3 || pick === 13 ? INNER_BED : pick % 6 === 5 ? FRONT_BED : BACK_BED;
      for (let tries = 0; tries < 16; tries++) {
        const angle = rng.range(0, Math.PI * 2);
        const reach = grove.r * 0.9 + rng.range(0.6, 3.2 + round * 0.35);
        const x = grove.x + Math.cos(angle) * reach;
        const near = grove.z + Math.sin(angle) * reach;
        // Stay in the chosen bed, as close to the grove as that bed allows.
        const z = Math.min(bed[1], Math.max(bed[0], near)) + rng.range(-0.4, 0.4);
        if (!onShelf(x) || inRock(x, z, 0.2)) continue;
        if (canopy.some((p) => Math.hypot(p.x - x, p.z - z) < 1.15)) continue;
        canopy.push(rooted(x, z, rng.next()));
        break;
      }
    }
  }

  // Seagrass grows in meadows on open sand; the other low plants keep to the rocks.
  const meadows: { x: number; z: number; r: number }[] = [];
  const patches = perSide(11) * 2;
  for (let tries = 0; meadows.length < patches && tries < patches * 20; tries++) {
    const x = (rng.next() < 0.5 ? -1 : 1) * rng.range(trench + 5, within(options.reach + 8));
    const z = rng.range(-12, 6.5);
    if (inRock(x, z, 2.5) || meadows.some((m) => Math.hypot(m.x - x, m.z - z) < 9)) continue;
    meadows.push({ x, z, r: rng.range(2.4, 4.2) });
  }
  const hosts = outcrops.filter((rock) => rock.r >= 0.9);
  const understory: SeabedLayout['understory'] = [];
  const spaced = (x: number, z: number) => understory.every((p) => Math.hypot(p.x - x, p.z - z) >= 0.75);
  let nextMeadow = 0, nextHost = 0;
  for (const species of options.understory) {
    // Each plant goes to the next patch in turn, so any prefix is spread over the shelf too.
    const sites = species === 'ribbon' ? meadows.length : hosts.length;
    for (let tries = 0; tries < Math.min(sites, 6) * 4; tries++) {
      let x: number, z: number;
      if (species === 'ribbon') {
        const meadow = meadows[nextMeadow++ % meadows.length];
        const angle = rng.range(0, Math.PI * 2);
        // Denser toward the middle of the patch.
        const reach = meadow.r * Math.pow(rng.next(), 0.7);
        x = meadow.x + Math.cos(angle) * reach;
        z = meadow.z + Math.sin(angle) * reach * 0.7;
        if (inRock(x, z, 0.1)) continue;
      } else {
        const host = hosts[nextHost++ % hosts.length];
        // Mostly on the camera's side of the rock, where it can be seen.
        const angle = rng.range(-0.3, Math.PI + 0.3);
        const reach = host.r * rng.range(0.85, 1.25) + 0.25;
        x = host.x + Math.cos(angle) * reach;
        z = host.z + Math.sin(angle) * reach * 0.8;
      }
      if (!onShelf(x) || !spaced(x, z)) continue;
      understory.push({ ...rooted(x, z, rng.next()), species });
      break;
    }
  }
  return { outcrops, stacks, canopy, understory };
}

/** Height (m) a plant with this `vigor` reaches in water `depth` m deep. */
export function plantHeight(species: Species, vigor: number, depth: number): number {
  if (species === 'giant') {
    // The canopy reaches for the light but stops 5 m short of the surface.
    return Math.min(48, (depth - 5) * (0.42 + 0.58 * Math.pow(vigor, 0.8)));
  }
  const [lo, hi] = species === 'ribbon' ? [2.6, 6.5] : species === 'broadleaf' ? [2.2, 4.6] : [2.6, 6];
  return Math.min(depth - 6, lo + (hi - lo) * vigor);
}

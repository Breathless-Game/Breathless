import { Rng } from './rng';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const SHELF_EDGE = 14;

/** Shared by terrain vertices and rooted props: the rear reef rises out of the shelf. */
export function habitatHeight(x: number, z: number, seabedY: number): number {
  const edge = Math.max(0, 1 - (Math.abs(x) - SHELF_EDGE) / 4);
  const floor = Math.sin(x * 0.08) * 2.2 + Math.cos((z + 25) * 0.15 + x * 0.03) * 1.5 - edge * 1.5;
  const back = clamp((-z - 10) / 26, 0, 1);
  const ramp = back * back * (3 - 2 * back);
  const ridge = 0.74 + Math.sin(x * 0.065 + 0.7) * 0.16 + Math.sin(x * 0.17 - 0.5) * 0.07;
  return seabedY + floor + Math.max(0, -seabedY - 9) * ramp * ridge;
}

/** Interpolate the actual rendered triangles, including the coarser rear ramp.
 * Analytic heights alone leave roots hovering above curved low-poly slopes. */
export function habitatGroundHeight(x: number, z: number, seabedY: number): number {
  const middle = Math.abs(x) < SHELF_EDGE;
  const width = middle ? 28 : 116;
  const depth = middle ? 54 : 90;
  const minX = middle ? -14 : x < 0 ? -130 : 14;
  const minZ = -70;
  const dx = width / Math.ceil(width / 3);
  const dz = depth / Math.ceil(depth / 3);
  const cx = clamp((x - minX) / dx, 0, Math.ceil(width / 3) - 1e-8);
  const cz = clamp((z - minZ) / dz, 0, Math.ceil(depth / 3) - 1e-8);
  const ix = Math.floor(cx), iz = Math.floor(cz);
  const u = cx - ix, v = cz - iz;
  const x0 = minX + ix * dx, z0 = minZ + iz * dz;
  const h00 = habitatHeight(x0, z0, seabedY);
  const h10 = habitatHeight(x0 + dx, z0, seabedY);
  const h01 = habitatHeight(x0, z0 + dz, seabedY);
  const h11 = habitatHeight(x0 + dx, z0 + dz, seabedY);
  return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00)
    : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

export interface HabitatRock {
  x: number; z: number; radius: number; squash: number; seed: number;
  /** Large anchors survive every quality tier; smaller talus is added around them. */
  detail: 1 | 2 | 3;
  patch: number;
}

export interface HabitatPlant {
  x: number; y: number; z: number; height: number; seed: number; patch: number;
}

export interface HabitatPatch { x: number; z: number; radius: number; }
export interface HabitatLayout { patches: HabitatPatch[]; rocks: HabitatRock[]; plants: HabitatPlant[]; }

const supported = (x: number, z: number, margin: number) =>
  Math.abs(x) < 82 && z > -52 && z < 10 && (Math.abs(x) >= SHELF_EDGE + margin || z < -26 - margin);

/** Seeded, spaced outcrops with smaller talus and sheltered growth, not uniform volume scatter. */
export function createHabitat(seed: number, seabedY: number, plantCount: number): HabitatLayout {
  const rng = new Rng(seed);
  // Two asymmetric near ledges frame the open diving lane. Other patches use
  // exclusion distances, leaving sand channels between independently sized groups.
  const patches: HabitatPatch[] = [
    { x: -24, z: -8, radius: 3.5 }, { x: 26, z: -4, radius: 4.2 },
    { x: -8, z: -39, radius: 4.8 }, { x: 13, z: -43, radius: 3.8 },
  ];
  for (let attempt = 0; patches.length < 14 && attempt < 700; attempt++) {
    const patch = { x: rng.range(-73, 73), z: rng.range(-45, 6), radius: rng.range(2.4, 5.5) };
    if (!supported(patch.x, patch.z, patch.radius * 1.5)) continue;
    if (patches.some(p => Math.hypot(p.x - patch.x, p.z - patch.z) < 8 + p.radius + patch.radius)) continue;
    patches.push(patch);
  }
  const rocks: HabitatRock[] = [];
  for (const [patch, p] of patches.entries()) {
    rocks.push({ ...p, squash: rng.range(0.52, 0.86), seed: rng.int(1, 0x7fffffff), detail: 1, patch });
    const bearing = rng.range(0, Math.PI * 2);
    for (let i = 0; i < 9; i++) {
      const angle = bearing + rng.range(-1.6, 1.6) + (i > 4 ? Math.PI : 0);
      const distance = p.radius * rng.range(0.85, 2.5);
      const radius = p.radius * (i < 3 ? rng.range(0.34, 0.6) : rng.range(0.10, 0.26));
      const x = p.x + Math.cos(angle) * distance;
      const z = p.z + Math.sin(angle) * distance * 0.7;
      if (!supported(x, z, radius * 1.6)) continue;
      rocks.push({ x, z, radius, squash: rng.range(0.45, 0.8), seed: rng.int(1, 0x7fffffff), detail: i < 3 ? 2 : 3, patch });
    }
  }
  const plants: HabitatPlant[] = [];
  // Reserve the same complete root pool at every quality. New stones must not
  // occupy a root that will become visible when the vegetation budget increases.
  const rootBudget = Math.max(72, plantCount);
  // Round-robin patches makes each prefix a distributed LOD, not one dense
  // corner of the map. Exclusion spacing keeps fronds from sharing one root.
  for (let round = 0; plants.length < rootBudget && round < 35; round++) {
    for (const [patch, p] of patches.entries()) {
      if (plants.length >= rootBudget) break;
      for (let attempt = 0; attempt < 18; attempt++) {
        const angle = rng.range(-1.6, 1.6) + 0.45;
        const distance = p.radius + rng.range(0.8, 4.8);
        const x = p.x + Math.cos(angle) * distance;
        const z = p.z + Math.sin(angle) * distance * 0.8;
        if (!supported(x, z, 3)) continue;
        const y = habitatGroundHeight(x, z, seabedY) - 0.22;
        // The deep shelf has bare sand and rock; vegetation follows the lit
        // rear slope. Preserve a few short, sparse plants at its transition.
        if (y < -48) continue;
        if (plants.some(q => Math.hypot(q.x - x, q.z - z) < 1.3)) continue;
        if (rocks.some(r => Math.hypot(r.x - x, r.z - z) < r.radius * 0.85 + 0.4)) continue;
        const shade = clamp((-y - 18) / 30, 0, 1);
        const height = Math.min(-y - 3.5, rng.range(5.5, 13.5) * (1 - shade * 0.40));
        plants.push({ x, y, z, height, seed: rng.int(1, 0x7fffffff), patch });
        break;
      }
    }
  }
  // Add a little weathered scree after the accepted outcrops and root layout.
  // Its independent stream preserves every original stone and plant identity.
  const talusRng = new Rng(seed ^ 0x4f1bbcdc);
  for (let slot = 0; slot < 3; slot++) {
    for (const [patch, p] of patches.entries()) {
      if (slot === 2 && patch % 2 !== 0) continue;
      const detail: 1 | 2 | 3 = slot === 0 ? (patch < 4 ? 1 : 2) : 3;
      for (let attempt = 0; attempt < 60; attempt++) {
        const radius = p.radius * talusRng.range(0.09, 0.19);
        const angle = talusRng.range(0, Math.PI * 2);
        const distance = p.radius * talusRng.range(1.15, 2.5);
        const x = p.x + Math.cos(angle) * distance;
        const z = p.z + Math.sin(angle) * distance * 0.7;
        if (!supported(x, z, radius * 1.6)) continue;
        if (plants.some(plant => Math.hypot(plant.x - x, plant.z - z) < radius * 0.85 + 0.4)) continue;
        if (rocks.some(rock => Math.hypot(rock.x - x, rock.z - z) < (radius + rock.radius) * 0.65)) continue;
        rocks.push({ x, z, radius, squash: talusRng.range(0.42, 0.68),
          seed: talusRng.int(1, 0x7fffffff), detail, patch });
        break;
      }
    }
  }
  return { patches, rocks, plants: plants.slice(0, plantCount) };
}

import * as THREE from 'three';
import { Rng } from './rng';

/** Shared wave vertices; the material derives a flat normal for each triangle. */
export function waterGeometry(width: number, depth: number, segments: readonly [number, number]): THREE.BufferGeometry {
  const [columns, rows] = segments;
  const grid = new THREE.PlaneGeometry(width, depth, columns, rows);
  grid.rotateX(-Math.PI / 2);
  const positions = grid.attributes.position;
  const rng = new Rng(0x5ea2026);
  // Broad changes in spacing give neighboring wave patches different-sized
  // facets. The warp fades at the perimeter, retaining the exact plane bounds.
  const rowZ = (row: number) => {
    const t = row / rows;
    const z = (t + 0.2 * t * (1 - t) - 0.5) * depth;
    return z + Math.sin(z * 0.24 + 0.7) * 1.05 * Math.sin(Math.PI * t);
  };
  for (let row = 0; row <= rows; row++) {
    const z = rowZ(row);
    const rowSpacing = row > 0 && row < rows
      ? Math.min(z - rowZ(row - 1), rowZ(row + 1) - z)
      : 0;
    for (let column = 0; column <= columns; column++) {
      const i = row * (columns + 1) + column;
      const x = positions.getX(i);
      const interior = Math.sin(Math.PI * column / columns) * Math.sin(Math.PI * row / rows);
      const xWarp = (Math.sin(x * 0.22) * 1.35 + Math.sin(z * 0.28 + 0.5) * 0.45) * interior;
      const zWarp = Math.sin(x * 0.17 + 1.1) * 0.4 * interior;
      const stagger = Math.sin(row * 2.39996) * 0.22 * width / columns
        * Math.sin(Math.PI * column / columns);
      const xOffset = rng.range(-0.1, 0.1) * width / columns;
      const zOffset = rng.range(-0.1, 0.1) * rowSpacing;
      positions.setXYZ(i,
        x + xWarp + stagger + (column > 0 && column < columns ? xOffset : 0),
        0,
        z + zWarp + zOffset,
      );
    }
  }
  const indices: number[] = [];
  const distanceSquared = (left: number, right: number) =>
    (positions.getX(left) - positions.getX(right)) ** 2
    + (positions.getZ(left) - positions.getZ(right)) ** 2;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column;
      const b = a + 1, c = a + columns + 1, d = c + 1;
      // The shorter diagonal keeps staggered patches broad instead of making
      // long needles, and avoids a repeating checkerboard crease direction.
      if (distanceSquared(a, d) < distanceSquared(b, c)) indices.push(a, c, d, a, d, b);
      else indices.push(a, c, b, b, c, d);
    }
  }
  grid.setIndex(indices);
  return grid;
}

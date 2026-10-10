import * as THREE from 'three';
import { Rng } from './rng';

/** Shared wave vertices; the material derives a flat normal for each triangle. */
export function waterGeometry(width: number, depth: number, segments: readonly [number, number]): THREE.BufferGeometry {
  const [columns, rows] = segments;
  const grid = new THREE.PlaneGeometry(width, depth, columns, rows);
  grid.rotateX(-Math.PI / 2);
  const positions = grid.attributes.position;
  const rng = new Rng(0x5ea2026);
  // Spend a little more of the same triangle budget near the visible foreground.
  // The smooth bias preserves useful coverage toward the horizon as well.
  const rowZ = (row: number) => {
    const t = row / rows;
    return (t + 0.3 * t * (1 - t) - 0.5) * depth;
  };
  for (let row = 0; row <= rows; row++) {
    const z = rowZ(row);
    const rowSpacing = row > 0 && row < rows
      ? Math.min(z - rowZ(row - 1), rowZ(row + 1) - z)
      : 0;
    for (let column = 0; column <= columns; column++) {
      const i = row * (columns + 1) + column;
      const xOffset = rng.range(-0.12, 0.12) * width / columns;
      const zOffset = rng.range(-0.12, 0.12) * rowSpacing;
      positions.setXYZ(i,
        positions.getX(i) + (column > 0 && column < columns ? xOffset : 0),
        0,
        z + zOffset,
      );
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column;
      const b = a + 1, c = a + columns + 1, d = c + 1;
      if ((row + column) % 2) indices.push(a, c, d, a, d, b);
      else indices.push(a, c, b, b, c, d);
    }
  }
  grid.setIndex(indices);
  return grid;
}

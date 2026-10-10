import * as THREE from 'three';
import { Rng } from './rng';

/** Shared corners move together; each triangle keeps its own tint and glint. */
export function waterGeometry(width: number, depth: number, segments: readonly [number, number]): THREE.BufferGeometry {
  const [columns, rows] = segments;
  const grid = new THREE.PlaneGeometry(width, depth, columns, rows);
  grid.rotateX(-Math.PI / 2);
  const positions = grid.attributes.position;
  const rng = new Rng(0x5ea2026);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const i = row * (columns + 1) + column;
      const xOffset = rng.range(-0.24, 0.24) * width / columns;
      const zOffset = rng.range(-0.24, 0.24) * depth / rows;
      positions.setXYZ(i,
        positions.getX(i) + (column > 0 && column < columns ? xOffset : 0),
        0,
        positions.getZ(i) + (row > 0 && row < rows ? zOffset : 0),
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
  const geometry = grid.toNonIndexed();
  grid.dispose();
  const vertices = geometry.attributes.position;
  const facets = new Float32Array(vertices.count * 4);
  const patches = new Float32Array(vertices.count * 4);
  for (let i = 0; i < vertices.count; i += 3) {
    const x = (vertices.getX(i) + vertices.getX(i + 1) + vertices.getX(i + 2)) / 3;
    const z = (vertices.getZ(i) + vertices.getZ(i + 1) + vertices.getZ(i + 2)) / 3;
    const tint = rng.next(), glint = rng.next();
    const zMin = Math.min(vertices.getZ(i), vertices.getZ(i + 1), vertices.getZ(i + 2));
    const zMax = Math.max(vertices.getZ(i), vertices.getZ(i + 1), vertices.getZ(i + 2));
    for (let vertex = 0; vertex < 3; vertex++) {
      facets.set([x, z, tint, glint], (i + vertex) * 4);
      patches.set([
        vertex === 0 ? 1 : 0, vertex === 1 ? 1 : 0, vertex === 2 ? 1 : 0,
        (vertices.getZ(i + vertex) - zMin) / (zMax - zMin),
      ], (i + vertex) * 4);
    }
  }
  geometry.setAttribute('aWaterFacet', new THREE.BufferAttribute(facets, 4));
  geometry.setAttribute('aWaterPatch', new THREE.BufferAttribute(patches, 4));
  return geometry;
}

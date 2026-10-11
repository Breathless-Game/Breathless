import * as THREE from 'three';

const ABYSS_TINT = new THREE.Color('#1a2c44');

/** Stable face noise: changing decoration counts cannot reshuffle existing colours. */
function faceNoise(x: number, y: number, z: number, seed: number) {
  let h = Math.imul(seed ^ Math.round(x * 4096), 16777619);
  h = Math.imul(h ^ Math.round(y * 4096), 16777619);
  h = Math.imul(h ^ Math.round(z * 4096), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Give each triangle a fixed mineral colour, including triangles on a broad,
 * coplanar rock face. Runs only when scenery is built; lighting still supplies
 * the moving shading. The geometry must be non-indexed so faces have hard edges.
 * `depth` is the depth of the geometry's origin; world-space walls use zero.
 */
export function paintBiomeFaces(
  geometry: THREE.BufferGeometry,
  palette: readonly string[],
  { seed = 1, contrast = 1, depth = 0 }: { seed?: number; contrast?: number; depth?: number } = {},
) {
  const position = geometry.getAttribute('position');
  if (geometry.index || !position || position.count % 3 !== 0) {
    throw new Error('Biome face colours require non-indexed triangles');
  }
  if (palette.length === 0) throw new Error('Biome face colours require a palette');
  const swatches = palette.map(colour => new THREE.Color(colour));
  const amount = THREE.MathUtils.clamp(contrast, 0, 1);
  const colours = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  for (let i = 0; i < position.count; i += 3) {
    const x = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
    const y = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3;
    const z = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3;
    const patch = faceNoise(x, y, z, seed);
    const lightness = faceNoise(x, y, z, seed ^ 0x5bd1e995);
    colour.copy(swatches[0]).lerp(swatches[Math.floor(patch * swatches.length)], amount);
    // Independent light/dark facets retain the old illustrated polygon look;
    // a small, map-specific palette keeps the colour variation coherent.
    // Keep deterministic facet separation visible, but close enough in value
    // that a bed reads as one mineral surface instead of a checkerboard.
    colour.multiplyScalar(1 + (lightness - 0.5) * 0.16 * amount);
    const deep = 1 - Math.exp(-Math.max(0, depth - y - 20) / 140);
    colour.lerp(ABYSS_TINT, 0.5 * deep).multiplyScalar(1 - 0.55 * deep);
    for (let vertex = 0; vertex < 3; vertex++) colour.toArray(colours, (i + vertex) * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { UpgradeLevel } from '../upgrades';
import { beam, material, mesh, palette, type Point } from './common';

/** Eight straight rim sections retain deliberate corners instead of a smooth torus. */
function polygonTube(points: Point[], radius: number, sides = 6) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vectors = points.map((point) => new THREE.Vector3(...point));
  for (let index = 0; index < vectors.length; index++) {
    const tangent = vectors[(index + 1) % vectors.length].clone().sub(vectors[(index - 1 + vectors.length) % vectors.length]).normalize();
    const lateral = tangent.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
    const normal = lateral.clone().cross(tangent).normalize();
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const vertex = vectors[index].clone().addScaledVector(normal, Math.cos(angle) * radius).addScaledVector(lateral, Math.sin(angle) * radius);
      positions.push(vertex.x, vertex.y, vertex.z);
      uvs.push(index / vectors.length, side / sides);
      const a = index * sides + side;
      const b = index * sides + (side + 1) % sides;
      const c = ((index + 1) % vectors.length) * sides + side;
      const d = ((index + 1) % vectors.length) * sides + (side + 1) % sides;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Shared scoop head; callers choose its orientation and pole mounting point. */
export function buildNetHead(level: UpgradeLevel): THREE.Group {
  const colors = palette(level);
  const grip = material('#30332f', { roughness: 0.97 });
  const rim = material('#303732', { metalness: 0.24, roughness: 0.96 });
  const nylon = material('#69796e', { roughness: 1, metalness: 0, emissiveIntensity: 0 });
  const mouth = new THREE.Group();
  mouth.name = 'Net_Mouth';
  mouth.scale.setScalar([1, 1.15, 1.30][level - 1]);
  // A narrow throat and broad forward lip follow a real scooped landing net.
  // The hoop itself gets wider as the tier rises; the fixed pole remains the
  // same length, so the upgrade reads as a larger working head rather than a
  // stretched handle.  The deeper bag below makes capacity visible in profile.
  const openingScale = [1, 1.10, 1.22][level - 1];
  const baseHoop: Point[] = [
    [-0.57, 0, -0.10], [-0.30, 0, -0.33], [0.25, 0.015, -0.43], [0.58, 0.045, -0.25],
    [0.58, 0.045, 0.25], [0.25, 0.015, 0.43], [-0.30, 0, 0.33], [-0.57, 0, 0.10],
  ];
  const hoopPoints: Point[] = baseHoop.map(([x, y, z]) => [x * openingScale, y * openingScale, z * openingScale]);
  const rimRadius = [0.016, 0.024, 0.034][level - 1];
  mesh(mouth, polygonTube(hoopPoints, rimRadius), rim, [0, 0, 0], 'Faceted_Scooped_Opening_Rim');
  for (const side of [-1, 1]) beam(mouth, [-0.73 * openingScale, 0, 0], [-0.57 * openingScale, 0, side * 0.10 * openingScale], [0.014, 0.020, 0.027][level - 1], rim, 6).name = 'Throat_Brace';
  const sides = 16;
  const bagDepth = [1, 1.35, 1.72][level - 1];
  const depths = [0, 0.13, 0.30, 0.48, 0.60].map((depth) => depth * bagDepth);
  const profile = level === 3 ? [1, 1.03, 1.01, 0.90, 0.72] : level === 2 ? [1, 1.02, 0.99, 0.89, 0.76] : [1, 1.015, 0.98, 0.87, 0.78];
  const webGeometries: THREE.BufferGeometry[] = [];
  const perimeterPoint = (phase: number, row: number) => {
    const perimeter = ((phase % sides + sides) % sides) / sides * hoopPoints.length;
    const index = Math.floor(perimeter);
    const a = new THREE.Vector3(...hoopPoints[index]);
    const b = new THREE.Vector3(...hoopPoints[(index + 1) % hoopPoints.length]);
    const point = a.lerp(b, perimeter - index);
    return new THREE.Vector3(point.x * profile[row], (row === 4 ? 0 : point.y) - depths[row], point.z * profile[row]);
  };
  // The pocket hangs down, bulges slightly, and ends in a broad woven floor.
  for (const direction of [-1, 1]) {
    for (let side = 0; side < sides; side++) {
      const points = depths.map((_, row) => perimeterPoint(side + direction * row * 0.5, row));
      const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
      webGeometries.push(new THREE.TubeGeometry(curve, points.length * 2, 0.0028, 6));
    }
  }
  const bottom = hoopPoints.map(([x, , z]) => [x * profile[4], -depths[4], z * profile[4]] as Point);
  webGeometries.push(polygonTube(bottom, 0.0035));
  for (const direction of [-1, 1]) {
    const values = bottom.map(([x, , z]) => x + direction * z);
    const min = Math.min(...values);
    const max = Math.max(...values);
    for (let line = 1; line < 14; line++) {
      const offset = THREE.MathUtils.lerp(min, max, line / 14);
      const intersections: THREE.Vector3[] = [];
      for (let edge = 0; edge < bottom.length; edge++) {
        const a = bottom[edge];
        const b = bottom[(edge + 1) % bottom.length];
        const av = a[0] + direction * a[2];
        const bv = b[0] + direction * b[2];
        if (Math.abs(bv - av) < 1e-8 || offset < Math.min(av, bv) || offset >= Math.max(av, bv)) continue;
        intersections.push(new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), (offset - av) / (bv - av)));
      }
      if (intersections.length === 2) webGeometries.push(new THREE.TubeGeometry(new THREE.LineCurve3(intersections[0], intersections[1]), 1, 0.0028, 6));
    }
  }
  const webGeometry = mergeGeometries(webGeometries, false)!;
  for (const geometry of webGeometries) geometry.dispose();
  const web = mesh(mouth, webGeometry, nylon, [0, 0, 0], 'Nylon_Diamond_Web');
  web.userData = { strandCount: 32, bagFloor: level === 3 ? 'deep-reinforced-floor' : level === 2 ? 'deep-flat-woven' : 'broad-flat-woven', hangsAlong: '-Y', depth: depths[4] };
  if (level >= 2) {
    // A second outer rail and floor rim turn the thin Lv1 lip into a load-
    // bearing frame.  They follow the widened opening and the deeper bag.
    mesh(mouth, polygonTube(hoopPoints, 0.011), colors.metal, [0, 0, 0], 'Reinforced_Outer_Rim');
    mesh(mouth, polygonTube(bottom, 0.008), rim, [0, 0, 0], 'Deep_Bag_Floor_Rim');
    for (const side of [-1, 1]) {
      beam(mouth, [-0.67 * openingScale, -0.025, 0], [-0.30 * openingScale, -depths[4] * 0.82, side * 0.33 * openingScale], 0.009, rim, 6).name = 'Reinforced_Throat_Rail';
      beam(mouth, [-0.30 * openingScale, -depths[4] * 0.82, side * 0.33 * openingScale], [0.20 * openingScale, -depths[4], side * 0.31 * openingScale], 0.007, colors.metal, 6).name = 'Deep_Bag_Side_Rail';
    }
  }
  if (level === 3) {
    // Replaceable corner guards protect the reinforced mouth at full scoop
    // width, while a second floor hoop keeps the deep bag open under load.
    mesh(mouth, polygonTube(bottom, 0.014), colors.metal, [0, 0, 0], 'Replaceable_Floor_Rail');
    for (const side of [-1, 1]) {
      const guard = mesh(mouth, new THREE.BoxGeometry(0.13, 0.045, 0.060), grip, [0.39 * openingScale, 0.035, side * 0.36 * openingScale], 'Replaceable_Rim_Bumper');
      guard.rotation.y = side * 0.52;
    }
  }
  const tip = new THREE.Object3D();
  tip.name = 'Catch_Centre';
  mouth.add(tip);
  mouth.userData = { level, socketOffset: -0.73 * openingScale };
  return mouth;
}

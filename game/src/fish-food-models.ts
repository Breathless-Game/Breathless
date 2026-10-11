import * as THREE from 'three';
import { beam, material, mesh, ring, tube, type Point } from './upgrade-models/common';
import { FISH_FOOD_KINDS, fishFood, type FishFoodId } from './fish-food';

/** The visual catalogue for the fish-growth consumables. */
export type FishFoodKind = FishFoodId;

export { FISH_FOOD_KINDS } from './fish-food';

/** Keep saves and UI input tolerant of a future food item while retaining a useful model. */
export function normalizeFishFoodKind(kind: string): FishFoodKind {
  return FISH_FOOD_KINDS.includes(kind as FishFoodKind) ? kind as FishFoodKind : 'pellet';
}

function tierValue(tier: number): number {
  // fish-food.ts stores the five catalogue tiers as 0..4; keep that value in
  // userData so a saved feed can be mapped back to its definition exactly.
  return THREE.MathUtils.clamp(Math.round(Number.isFinite(tier) ? tier : 1), 0, 4);
}

function foodAsset(kind: FishFoodKind, tier: number) {
  const group = new THREE.Group();
  group.name = `FishFood_${kind}_T${tier}`;
  const info = fishFood(kind);
  group.userData = {
    id: kind,
    fishFoodKind: kind,
    tier,
    name: info.name,
    nameZh: info.nameZh,
    effect: info.description,
    effectZh: info.descriptionZh,
    price: info.price,
    style: 'faceted-pbr',
    source: 'buildFishFoodModel',
  };
  return group;
}

function foodPalette(tier: number) {
  const t = tier / 4;
  return {
    body: material(new THREE.Color().setHSL(0.08 + t * 0.52, 0.22 + t * 0.58, 0.32 + t * 0.18), { roughness: 0.82 }),
    accent: material(new THREE.Color().setHSL(0.03 + t * 0.48, 0.45 + t * 0.45, 0.42 + t * 0.18), { roughness: 0.66 }),
    dark: material('#2d3b3b', { roughness: 0.93 }),
    shell: material('#839b8f', { roughness: 0.88 }),
    glow: material('#b4ffe0', { color: '#b4ffe0', emissive: '#34dca9', emissiveIntensity: 0.8 + t * 1.2, roughness: 0.38 }),
  };
}

function buildPlankton(tier: number) {
  const group = foodAsset('plankton', tier);
  const colors = foodPalette(tier);
  const size = 0.55 + tier * 0.035;
  const positions: Point[] = [
    [0, 0, 0], [0.13, 0.09, 0.08], [-0.14, 0.08, 0.04], [0.05, -0.13, 0.10],
    [-0.09, -0.10, -0.10], [0.16, -0.03, -0.12], [-0.18, -0.02, -0.08],
  ];
  positions.forEach((at, index) => {
    const particle = mesh(group, new THREE.IcosahedronGeometry(size * (index === 0 ? 0.15 : 0.09), 0), index % 3 === 0 ? colors.accent : colors.body, at, `Plankton_${index + 1}`);
    particle.scale.y = index % 2 === 0 ? 0.72 : 1.18;
  });
  // A small ring makes the low-value food readable even in a dark aquarium.
  ring(group, size * 0.30, 0.012, colors.shell, [0, 0, 0], 'y', 7).name = 'Plankton_Cluster_Ring';
  return group;
}

function buildPellet(tier: number) {
  const group = foodAsset('pellet', tier);
  const colors = foodPalette(tier);
  const scale = 0.72 + tier * 0.045;
  const pellet = mesh(group, new THREE.CylinderGeometry(0.13 * scale, 0.15 * scale, 0.43 * scale, 8), colors.body, [0, 0, 0], 'Pressed_Pellet');
  pellet.rotation.z = Math.PI / 2;
  ring(group, 0.13 * scale, 0.015, colors.accent, [-0.11 * scale, 0, 0], 'x', 8).name = 'Pellet_Ridge_A';
  ring(group, 0.13 * scale, 0.015, colors.accent, [0.11 * scale, 0, 0], 'x', 8).name = 'Pellet_Ridge_B';
  mesh(group, new THREE.IcosahedronGeometry(0.08 * scale, 0), colors.accent, [0, 0.05 * scale, 0.11 * scale], 'Pellet_Crumb');
  return group;
}

function buildKrill(tier: number) {
  const group = foodAsset('krill', tier);
  const colors = foodPalette(tier);
  const scale = 0.76 + tier * 0.05;
  const shell = colors.body;
  const bodyPoints: Point[] = [[-0.37, 0.02, 0], [-0.22, 0.08, 0.01], [-0.02, 0.10, 0], [0.18, 0.03, 0], [0.34, -0.04, 0]];
  const body = tube(group, bodyPoints.map(([x, y, z]) => [x * scale, y * scale, z * scale]), 0.095 * scale, shell, 6);
  body.name = 'Krill_Segmented_Body';
  bodyPoints.slice(1, -1).forEach(([x, y, z], index) => {
    ring(group, 0.096 * scale, 0.009, colors.accent, [x * scale, y * scale, z * scale], 'x', 7).name = `Krill_Segment_${index + 1}`;
  });
  mesh(group, new THREE.SphereGeometry(0.105 * scale, 8, 6), colors.accent, [-0.37 * scale, 0.02 * scale, 0], 'Krill_Head');
  mesh(group, new THREE.SphereGeometry(0.023 * scale, 6, 4), colors.glow, [-0.44 * scale, 0.07 * scale, 0.07 * scale], 'Krill_Eye');
  for (const side of [-1, 1]) {
    beam(group, [-0.43 * scale, 0.06 * scale, side * 0.04 * scale], [-0.70 * scale, 0.16 * scale, side * 0.14 * scale], 0.007 * scale, colors.shell, 5).name = `Krill_Antenna_${side < 0 ? 'L' : 'R'}`;
    beam(group, [0.22 * scale, -0.02 * scale, side * 0.03 * scale], [0.41 * scale, -0.17 * scale, side * 0.14 * scale], 0.009 * scale, colors.shell, 5).name = `Krill_Leg_${side < 0 ? 'L' : 'R'}`;
  }
  return group;
}

function buildShrimp(tier: number) {
  const group = foodAsset('shrimp', tier);
  const colors = foodPalette(tier);
  const scale = 0.82 + tier * 0.05;
  const bodyPoints: Point[] = [[-0.38, 0.12, 0], [-0.23, 0.16, 0], [-0.04, 0.11, 0], [0.13, 0.00, 0], [0.23, -0.15, 0]];
  const body = tube(group, bodyPoints.map(([x, y, z]) => [x * scale, y * scale, z * scale]), 0.12 * scale, colors.body, 7);
  body.name = 'Shrimp_Curved_Body';
  bodyPoints.slice(0, -1).forEach(([x, y, z], index) => {
    ring(group, 0.117 * scale, 0.011, colors.accent, [x * scale, y * scale, z * scale], 'x', 8).name = `Shrimp_Shell_${index + 1}`;
  });
  mesh(group, new THREE.SphereGeometry(0.13 * scale, 8, 6), colors.accent, [-0.4 * scale, 0.13 * scale, 0], 'Shrimp_Head');
  for (const side of [-1, 1]) {
    beam(group, [-0.47 * scale, 0.16 * scale, side * 0.05 * scale], [-0.74 * scale, 0.27 * scale, side * 0.19 * scale], 0.008 * scale, colors.shell, 5).name = `Shrimp_Antenna_${side < 0 ? 'L' : 'R'}`;
    beam(group, [-0.28 * scale, 0.07 * scale, side * 0.06 * scale], [-0.34 * scale, -0.11 * scale, side * 0.18 * scale], 0.010 * scale, colors.shell, 5).name = `Shrimp_Walking_Leg_${side < 0 ? 'L' : 'R'}`;
  }
  const tail = new THREE.Group();
  tail.name = 'Shrimp_Tail_Fan';
  tail.position.set(0.23 * scale, -0.17 * scale, 0);
  group.add(tail);
  for (const side of [-1, 0, 1]) {
    const fin = mesh(tail, new THREE.ConeGeometry(0.11 * scale, 0.32 * scale, 4), colors.accent, [0.09 * scale, 0.02 * scale, side * 0.10 * scale], `Tail_Fan_${side}`);
    fin.rotation.z = Math.PI / 2;
    fin.rotation.y = side * 0.5;
  }
  return group;
}

function buildGlowCoral(tier: number) {
  const group = foodAsset('glowCoral', tier);
  const colors = foodPalette(tier);
  const scale = 0.72 + tier * 0.065;
  const base = mesh(group, new THREE.DodecahedronGeometry(0.18 * scale, 0), colors.dark, [0, -0.20 * scale, 0], 'Coral_Base');
  base.scale.set(1.4, 0.45, 1.1);
  const branches: Point[][] = [
    [[0, -0.12, 0], [-0.05, 0.10, 0], [-0.17, 0.33, 0.02]],
    [[0.02, -0.14, 0.02], [0.12, 0.08, -0.02], [0.24, 0.30, 0.04]],
    [[0, -0.13, -0.03], [0.02, 0.08, -0.18], [-0.03, 0.27, -0.24]],
  ];
  branches.forEach((points, index) => {
    tube(group, points.map(([x, y, z]) => [x * scale, y * scale, z * scale]), 0.035 * scale, colors.body, 5).name = `Coral_Branch_${index + 1}`;
    const tip = points[points.length - 1];
    mesh(group, new THREE.IcosahedronGeometry(0.07 * scale, 0), colors.glow, [tip[0] * scale, tip[1] * scale, tip[2] * scale], `Coral_Glow_Tip_${index + 1}`);
  });
  ring(group, 0.32 * scale, 0.018, colors.glow, [0, 0.03 * scale, 0], 'y', 8).name = 'Coral_Halo';
  return group;
}

/** Build the low-poly edible item shown in the fish-feeding UI and previews.
 * `tier` follows FishFoodDef and is zero-based (0..4). */
export function buildFishFoodModel(kind: FishFoodKind | string, tier = 1): THREE.Group {
  const normalized = normalizeFishFoodKind(kind);
  const level = tierValue(tier);
  switch (normalized) {
    case 'plankton': return buildPlankton(level);
    case 'krill': return buildKrill(level);
    case 'shrimp': return buildShrimp(level);
    case 'glowCoral': return buildGlowCoral(level);
    case 'pellet': return buildPellet(level);
  }
}

import * as THREE from 'three';
import type { UpgradeLevel } from '../upgrades';
import { beam, mesh, palette, type Point } from './common';

/** Boat equipment uses metre-like units; the preview wrapper handles centring. */
function assembly(name: string) {
  const group = new THREE.Group();
  group.name = name;
  return group;
}

function chamferedBox(width: number, height: number, depth: number, corner = 0.05) {
  const x = width / 2;
  const y = height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-x + corner, -y);
  shape.lineTo(x - corner, -y);
  shape.lineTo(x, -y + corner);
  shape.lineTo(x, y - corner);
  shape.lineTo(x - corner, y);
  shape.lineTo(-x + corner, y);
  shape.lineTo(-x, y - corner);
  shape.lineTo(-x, -y + corner);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: false });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

/** A pitched blade, rather than the decorative ring used by the old icon. */
function propellerBlade() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.035, 0.04);
  shape.lineTo(0.032, 0.04);
  shape.lineTo(0.095, 0.11);
  shape.lineTo(0.077, 0.205);
  shape.lineTo(0.025, 0.235);
  shape.lineTo(-0.055, 0.17);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.018, steps: 1, bevelEnabled: false });
  const positions = geometry.getAttribute('position');
  for (let index = 0; index < positions.count; index++) {
    positions.setZ(index, positions.getZ(index) - 0.009 + positions.getX(index) * 0.45);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Wide flat panels follow the compact, fore-aft elongated outboard cover. */
function cowlingGeometry() {
  const outline = (width: number, front: number, back: number, y: number): Point[] => [
    [-width + 0.055, y, back], [width - 0.055, y, back],
    [width, y, back + 0.065], [width, y, front - 0.065],
    [width - 0.055, y, front], [-width + 0.055, y, front],
    [-width, y, front - 0.065], [-width, y, back + 0.065],
  ];
  const lower = outline(0.245, 0.30, -0.35, 0.19);
  const shoulder = outline(0.245, 0.30, -0.35, 0.54);
  const top = outline(0.185, 0.24, -0.29, 0.64);
  const positions: number[] = [];
  for (let face = 0; face < 8; face++) {
    const next = (face + 1) % 8;
    quad(positions, lower[next], lower[face], shoulder[face], shoulder[next]);
    quad(positions, shoulder[next], shoulder[face], top[face], top[next]);
    triangle(positions, [0, 0.64, -0.025], top[next], top[face]);
    triangle(positions, [0, 0.19, -0.025], lower[face], lower[next]);
  }
  return surfaceGeometry(positions);
}

export function buildBoatSpeed(level: UpgradeLevel) {
  const group = assembly(`boat-speed-lv${level}`);
  const colors = palette(level);
  if (level === 1) {
    for (const side of [-1, 1]) {
      const oar = assembly(side < 0 ? 'port-wooden-oar' : 'starboard-wooden-oar');
      oar.position.set(side * 0.36, 0, side * 0.035);
      oar.rotation.z = side * -0.14;
      mesh(oar, new THREE.CylinderGeometry(0.026, 0.035, 1.64, 8), colors.wood, [0, 0.3, 0], 'continuous-oar-shaft');
      mesh(oar, new THREE.CylinderGeometry(0.034, 0.026, 0.19, 8), colors.wood, [0, 1.08, 0], 'hand-grip');
      const blade = new THREE.Shape();
      blade.moveTo(-0.034, -0.49);
      blade.lineTo(-0.12, -0.66);
      blade.lineTo(-0.15, -1.17);
      blade.lineTo(-0.105, -1.3);
      blade.lineTo(0.105, -1.3);
      blade.lineTo(0.15, -1.17);
      blade.lineTo(0.12, -0.66);
      blade.lineTo(0.034, -0.49);
      blade.closePath();
      const geometry = new THREE.ExtrudeGeometry(blade, { depth: 0.045, steps: 1, bevelEnabled: false });
      geometry.translate(0, 0, -0.0225);
      mesh(oar, geometry, colors.wood, [0, 0, 0], 'broad-tapered-paddle-blade');
      mesh(oar, new THREE.CylinderGeometry(0.04, 0.04, 0.10, 8), colors.rubber, [0, 0.10, 0], 'oarlock-wear-collar');
      group.add(oar);
    }
    return group;
  }

  const count = level === 3 ? 2 : 1;
  for (let index = 0; index < count; index++) {
    const motor = assembly(count === 1 ? 'single-outboard-motor' : `${index === 0 ? 'port' : 'starboard'}-outboard-motor`);
    motor.position.x = (index - (count - 1) / 2) * 0.67;
    mesh(motor, cowlingGeometry(), colors.body, [0, 0, 0], 'eight-panel-engine-cowling');
    for (const side of [-1, 1]) {
      mesh(motor, new THREE.BoxGeometry(0.009, 0.065, 0.23), colors.rubber, [side * 0.247, 0.46, -0.09], 'recessed-cowling-air-intake');
      mesh(motor, new THREE.BoxGeometry(0.085, 0.14, 0.045), colors.metal, [side * 0.17, 0.15, 0.28], 'transom-mount-ear');
      beam(motor, [side * 0.17, 0.16, 0.28], [side * 0.17, -0.20, 0.28], 0.033, colors.metal, 10).name = 'vertical-transom-clamp';
      beam(motor, [side * 0.17, -0.15, 0.28], [side * 0.17, -0.15, 0.40], 0.019, colors.metal, 8).name = 'clamp-screw';
      mesh(motor, new THREE.BoxGeometry(0.09, 0.075, 0.035), colors.rubber, [side * 0.17, -0.15, 0.425], 'transom-pressure-pad');
    }
    beam(motor, [-0.22, 0.02, 0.13], [0.22, 0.02, 0.13], 0.055, colors.metal, 12).name = 'tilt-pivot';
    mesh(motor, new THREE.CylinderGeometry(0.087, 0.059, 0.86, 6), colors.body, [0, -0.24, 0.02], 'slender-drive-shaft-leg');
    mesh(motor, chamferedBox(0.30, 0.025, 0.56, 0.045), colors.body, [0, -0.635, -0.045], 'anti-ventilation-plate');
    const gearcase = mesh(motor, new THREE.SphereGeometry(0.13, 8, 4), colors.body, [0, -0.755, -0.065], 'faceted-lower-unit-gearcase');
    gearcase.scale.set(0.85, 0.85, 2.3);
    const propeller = assembly('three-blade-pitched-propeller');
    propeller.position.set(0, -0.755, -0.38);
    const hub = mesh(propeller, new THREE.CylinderGeometry(0.064, 0.057, 0.16, 8), colors.metal, [0, 0, 0], 'propeller-hub');
    hub.rotation.x = Math.PI / 2;
    for (let blade = 0; blade < 3; blade++) {
      mesh(propeller, propellerBlade(), colors.metal, [0, 0, 0], `pitched-blade-${blade + 1}`).rotation.z = blade * Math.PI * 2 / 3;
    }
    motor.add(propeller);
    const skeg = new THREE.Shape();
    skeg.moveTo(-0.14, 0);
    skeg.lineTo(0.16, 0);
    skeg.lineTo(0.04, -0.25);
    skeg.lineTo(-0.08, -0.25);
    skeg.closePath();
    const skegGeometry = new THREE.ExtrudeGeometry(skeg, { depth: 0.028, steps: 1, bevelEnabled: false });
    skegGeometry.rotateY(Math.PI / 2);
    skegGeometry.translate(-0.014, 0, 0);
    mesh(motor, skegGeometry, colors.body, [0, -0.82, 0.02], 'protective-skeg');
    if (level === 2) {
      beam(motor, [0.18, 0.31, 0.22], [0.18, 0.33, 0.76], 0.029, colors.metal, 10).name = 'tiller-arm';
      beam(motor, [0.18, 0.33, 0.66], [0.18, 0.33, 0.86], 0.043, colors.rubber, 10).name = 'tiller-throttle-grip';
    }
    group.add(motor);
  }
  if (level === 3) {
    mesh(group, new THREE.BoxGeometry(1.08, 0.17, 0.09), colors.metal, [0, -0.025, 0.345], 'shared-transom-mount');
    beam(group, [-0.335, 0.07, 0.31], [0.335, 0.07, 0.31], 0.025, colors.metal, 8).name = 'twin-engine-steering-link';
  }
  return group;
}

const HULL_STATIONS = [
  [-2.10, 0.025], [-1.22, 0.56], [-0.22, 0.74], [0.88, 0.66], [1.75, 0.53],
] as const;

function section(x: number, width: number, inner = false): Point[] {
  const inset = inner ? Math.min(0.035, width * 0.2) : 0;
  const w = width - inset;
  const bottom = inner ? 0.035 : 0;
  const bowLift = Math.max(0, (-x - 1.22) / 0.88) * 0.52;
  return [
    [x, 0.45 + bowLift * 0.10, -w], [x, 0.035 + bottom + bowLift * 0.25, -w * 0.91],
    [x, -0.30 + bottom + bowLift * 0.75, -w * 0.58], [x, -0.43 + bottom + bowLift, 0],
    [x, -0.30 + bottom + bowLift * 0.75, w * 0.58], [x, 0.035 + bottom + bowLift * 0.25, w * 0.91],
    [x, 0.45 + bowLift * 0.10, w],
  ];
}

function triangle(positions: number[], a: Point, b: Point, c: Point) {
  positions.push(...a, ...b, ...c);
}

function quad(positions: number[], a: Point, b: Point, c: Point, d: Point) {
  triangle(positions, a, b, c);
  triangle(positions, a, c, d);
}

function surfaceGeometry(positions: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildBoatHull(level: UpgradeLevel) {
  const group = assembly(`boat-hull-lv${level}`);
  const colors = palette(level);
  const shellMaterial = level === 1 ? colors.wood : level === 2 ? colors.metal : colors.body;
  shellMaterial.side = THREE.DoubleSide;
  const outer = HULL_STATIONS.map(([x, width]) => section(x, width));
  const inner = HULL_STATIONS.map(([x, width]) => section(x, width, true));
  // Separate longitudinal strakes preserve the open U-shaped shell and its facets.
  for (let strake = 0; strake < 6; strake++) {
    const outerPositions: number[] = [];
    const innerPositions: number[] = [];
    for (let station = 0; station < outer.length - 1; station++) {
      quad(outerPositions, outer[station][strake], outer[station + 1][strake], outer[station + 1][strake + 1], outer[station][strake + 1]);
      quad(innerPositions, inner[station][strake + 1], inner[station + 1][strake + 1], inner[station + 1][strake], inner[station][strake]);
    }
    mesh(group, surfaceGeometry(outerPositions), shellMaterial, [0, 0, 0], `outer-hull-strake-${strake + 1}`);
    mesh(group, surfaceGeometry(innerPositions), shellMaterial, [0, 0, 0], `inner-hull-strake-${strake + 1}`);
  }
  const rims: number[] = [];
  for (let station = 0; station < outer.length - 1; station++) {
    for (const side of [0, 6]) {
      quad(rims, outer[station][side], inner[station][side], inner[station + 1][side], outer[station + 1][side]);
      beam(group, outer[station][side], outer[station + 1][side], level === 1 ? 0.028 : 0.035, level === 1 ? colors.wood : colors.metal, 8).name = `continuous-${side === 0 ? 'port' : 'starboard'}-gunwale`;
    }
    beam(group, [outer[station][3][0], outer[station][3][1] - 0.02, 0], [outer[station + 1][3][0], outer[station + 1][3][1] - 0.02, 0], level === 3 ? 0.035 : 0.022, level === 1 ? colors.wood : colors.metal, 6).name = 'rising-bow-keel';
  }
  mesh(group, surfaceGeometry(rims), shellMaterial, [0, 0, 0], 'closed-thickness-at-open-rim');
  // End bulkheads follow the cross section, never a cap across the open top.
  for (const end of [0, outer.length - 1]) {
    const shape = new THREE.Shape();
    const crossSection = outer[end];
    shape.moveTo(crossSection[0][2], crossSection[0][1]);
    for (let index = 1; index < crossSection.length; index++) shape.lineTo(crossSection[index][2], crossSection[index][1]);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.045, steps: 1, bevelEnabled: false });
    geometry.rotateY(Math.PI / 2);
    mesh(group, geometry, shellMaterial, [crossSection[0][0] - (end === 0 ? 0 : 0.045), 0, 0], end === 0 ? 'bow-stem-bulkhead' : 'flat-transom');
    beam(group, crossSection[0], crossSection[6], 0.034, colors.metal, 10).name = end === 0 ? 'bow-rim' : 'transom-rim';
  }
  for (const station of [1, 2, 3, 4]) {
    const rib = assembly(`interior-frame-${station}`);
    const points = inner[station].map(([x, y, z]): Point => [x, y + 0.012, z]);
    for (let edge = 0; edge < points.length - 1; edge++) beam(rib, points[edge], points[edge + 1], level === 1 ? 0.023 : 0.025, level === 1 ? colors.wood : colors.metal, 6);
    group.add(rib);
  }
  for (let board = 0; board < 5; board++) {
    const z = (board - 2) * 0.135;
    mesh(group, new THREE.BoxGeometry(2.62, 0.045, 0.125), level === 1 ? colors.wood : colors.rubber, [0.20, -0.22, z], `interior-floor-board-${board + 1}`);
  }
  for (const x of [-0.68, 0.82]) {
    mesh(group, new THREE.BoxGeometry(0.25, 0.055, 1.12), colors.wood, [x, 0.205, 0], 'transverse-timber-bench');
    for (const z of [-0.27, 0.27]) beam(group, [x, -0.20, z], [x, 0.18, z], 0.025, level === 1 ? colors.wood : colors.metal, 8).name = 'bench-support';
  }
  if (level >= 2) {
    for (const side of [-1, 1]) {
      for (let station = 1; station < outer.length - 1; station++) {
        const a = outer[station][side < 0 ? 1 : 5];
        const b = outer[station + 1][side < 0 ? 1 : 5];
        beam(group, [a[0], a[1] + 0.13, a[2] + side * 0.018], [b[0], b[1] + 0.13, b[2] + side * 0.018], 0.021, colors.metal, 6).name = 'longitudinal-side-reinforcement';
      }
    }
    mesh(group, new THREE.BoxGeometry(0.052, 0.35, 0.66), colors.metal, [1.725, 0.26, 0], 'reinforced-engine-transom-plate');
  }
  if (level === 3) {
    for (const side of [-1, 1]) {
      for (let station = 1; station < outer.length - 1; station++) {
        const a = outer[station][side < 0 ? 0 : 6];
        const b = outer[station + 1][side < 0 ? 0 : 6];
        beam(group, [a[0], a[1] - 0.10, a[2] + side * 0.016], [b[0], b[1] - 0.10, b[2] + side * 0.016], 0.057, colors.rubber, 10).name = 'continuous-collision-rubrail';
      }
    }
    mesh(group, new THREE.BoxGeometry(0.06, 0.08, 1.04), colors.metal, [1.74, 0.41, 0], 'reinforced-transom-top-cap');
  }
  return group;
}

/** Rail-mounted polymer holders use a socket, adjustable pivot and open sleeve. */
function rodHolder(group: THREE.Group, base: Point, colors: ReturnType<typeof palette>, index: number) {
  const holder = assembly(`rod-holder-${index}`);
  holder.position.set(...base);
  mesh(holder, new THREE.BoxGeometry(0.12, 0.16, 0.075), colors.metal, [0, -0.03, 0], 'rail-clamp-base');
  const pivot = mesh(holder, new THREE.CylinderGeometry(0.065, 0.065, 0.12, 8), colors.rubber, [0, 0.07, 0], 'adjustable-holder-pivot');
  pivot.rotation.z = Math.PI / 2;
  const sleeve = assembly('angled-rod-cradle');
  sleeve.position.set(0, 0.13, -0.015);
  sleeve.rotation.x = -0.4;
  const profile = [
    new THREE.Vector2(0.049, -0.17), new THREE.Vector2(0.065, -0.17),
    new THREE.Vector2(0.065, 0.17), new THREE.Vector2(0.049, 0.17),
    new THREE.Vector2(0.049, -0.17),
  ];
  mesh(sleeve, new THREE.LatheGeometry(profile, 8), colors.rubber, [0, 0, 0], 'open-octagonal-rod-sleeve');
  holder.add(sleeve);
  group.add(holder);
}

export function buildBoatDeck(level: UpgradeLevel) {
  const group = assembly(`fishing-deck-lv${level}`);
  const colors = palette(level);
  const length = [1.60, 1.90, 2.20][level - 1];
  const width = 0.94;
  const rear = -width / 2 + 0.025;
  mesh(group, new THREE.BoxGeometry(length, 0.075, width), colors.body, [0, -0.005, 0], 'boat-mounted-working-platform');
  for (let board = 0; board < 5; board++) {
    const z = (board - 2) * width / 5;
    mesh(group, new THREE.BoxGeometry(length - 0.07, 0.025, width / 5 - 0.012), colors.wood, [0, 0.042, z], `wide-working-deck-plank-${board + 1}`);
  }
  for (const z of [-width / 2, width / 2]) beam(group, [-length / 2, -0.047, z], [length / 2, -0.047, z], 0.028, colors.metal, 6).name = 'deck-perimeter-frame';
  for (const x of [-length / 2, length / 2]) beam(group, [x, -0.047, -width / 2], [x, -0.047, width / 2], 0.028, colors.metal, 6).name = 'deck-end-frame';
  // Two triangular brackets make this an actual boat attachment, not a floating slab.
  for (const x of [-length * 0.31, length * 0.31]) {
    beam(group, [x, -0.055, rear], [x, -0.055, width / 2], 0.031, colors.metal, 6).name = 'under-deck-mounting-arm';
    mesh(group, new THREE.BoxGeometry(0.105, 0.39, 0.035), colors.metal, [x, -0.20, rear], 'vertical-transom-mounting-plate');
    beam(group, [x, -0.36, rear], [x, -0.065, width / 2 - 0.09], 0.029, colors.metal, 6).name = 'diagonal-deck-support-bracket';
  }
  const railEnd = length / 2 - 0.065;
  for (const x of [-railEnd, railEnd]) {
    mesh(group, new THREE.BoxGeometry(0.10, 0.020, 0.10), colors.metal, [x, 0.063, rear], 'rail-support-foot');
    beam(group, [x, 0.073, rear], [x, 0.43, rear], 0.025, colors.metal, 8).name = 'short-holder-rail-stanchion';
  }
  beam(group, [-railEnd, 0.43, rear], [railEnd, 0.43, rear], 0.028, colors.metal, 8).name = 'horizontal-rod-mounting-rail';
  for (let index = 0; index < level; index++) {
    rodHolder(group, [(index - (level - 1) / 2) * 0.53, 0.43, rear], colors, index + 1);
  }
  if (level >= 2) {
    const tableX = -length / 2 + 0.30;
    mesh(group, new THREE.BoxGeometry(0.36, 0.20, 0.30), colors.rubber, [tableX, 0.165, 0.16], 'compact-tackle-storage');
    mesh(group, new THREE.BoxGeometry(0.40, 0.024, 0.34), colors.wood, [tableX, 0.277, 0.16], 'bait-preparation-board');
  }
  if (level === 3) {
    const x = length / 2 - 0.32;
    mesh(group, new THREE.BoxGeometry(0.40, 0.22, 0.33), colors.body, [x, 0.18, 0.13], 'compact-fish-locker');
    mesh(group, new THREE.BoxGeometry(0.42, 0.026, 0.35), colors.rubber, [x, 0.303, 0.13], 'sealed-locker-lid');
  }
  return group;
}

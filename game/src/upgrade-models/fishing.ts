import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { UpgradeLevel } from '../upgrades';
import { beam, material, mesh, palette, ring, tube } from './common';
import type { Point } from './common';

function asset(id: string, level: UpgradeLevel) {
  const group = new THREE.Group();
  group.name = `${id}_Lv${level}`;
  group.userData = { upgradeId: id, level, style: 'faceted-pbr' };
  return group;
}

function cylinderX(group: THREE.Group, start: number, end: number, radiusStart: number, radiusEnd: number, surface: THREE.Material, name: string, y = 0, z = 0) {
  const object = mesh(group, new THREE.CylinderGeometry(radiusEnd, radiusStart, end - start, 8), surface, [(start + end) / 2, y, z], name);
  object.rotation.z = -Math.PI / 2;
  return object;
}

/** A real spinning reel has its spool along the rod and its crank across it. */
function spinningReel(parent: THREE.Group, level: UpgradeLevel, colors: ReturnType<typeof palette>) {
  const group = new THREE.Group();
  group.name = 'Spinning_Reel';
  parent.add(group);
  const radius = [0.125, 0.15, 0.17][level - 1];
  const y = -0.225;
  const front = 1.02;
  const housing = mesh(group, new THREE.IcosahedronGeometry(0.16, 0), colors.body, [0.74, y - 0.025, 0], 'Gear_Housing');
  housing.scale.set(1.1, 0.92, 0.72);
  beam(group, [0.73, -0.045, 0], [0.73, y + 0.10, 0], 0.025, colors.metal, 8).name = 'Reel_Stem';
  mesh(group, new THREE.BoxGeometry(0.24, 0.024, 0.055), colors.metal, [0.76, -0.041, 0], 'Reel_Foot');
  cylinderX(group, 0.82, 0.97, radius * 0.85, radius * 0.9, colors.body, 'Rotor', y);
  cylinderX(group, 0.91, 1.06, radius * 0.72, radius * 0.72, colors.line, 'Wound_Spool', y);
  cylinderX(group, 0.93, 0.951, radius, radius, colors.metal, 'Spool_Rear_Flange', y);
  cylinderX(group, 1.04, 1.059, radius, radius, colors.metal, 'Spool_Front_Lip', y);
  cylinderX(group, 0.86, 1.075, 0.019, 0.019, colors.metal, 'Spool_Axle_X', y);
  cylinderX(group, 1.06, 1.09, 0.049, 0.035, colors.rubber, 'Drag_Knob', y);
  const bail: Point[] = [];
  for (let index = 0; index <= 6; index++) {
    const angle = (index / 6) * Math.PI;
    bail.push([front + 0.08 * Math.sin(angle), y + Math.cos(angle) * (radius + 0.042), Math.sin(angle) * (radius + 0.042)]);
  }
  tube(group, bail, 0.010, colors.metal, 8).name = 'Bail_Wire';
  beam(group, [0.92, y + radius, 0], bail[0], 0.019, colors.body, 8).name = 'Bail_Arm_Top';
  beam(group, [0.92, y - radius, 0], bail[bail.length - 1], 0.019, colors.body, 8).name = 'Bail_Arm_Lower';
  beam(group, [0.74, y - 0.025, 0.065], [0.74, y - 0.025, 0.19], 0.024, colors.metal, 8).name = 'Crank_Axle_Z';
  ring(group, 0.048, 0.010, colors.metal, [0.74, y - 0.025, 0.125], 'z', 12).name = 'Crank_Bearing';
  tube(group, [[0.74, y - 0.025, 0.19], [0.65, y - 0.13, 0.19], [0.57, y - 0.17, 0.225]], 0.019, colors.metal, 8).name = 'Crank_Arm';
  beam(group, [0.57, y - 0.17, 0.20], [0.57, y - 0.17, 0.29], 0.018, colors.metal, 8).name = 'Handle_Axle_Z';
  const knob = mesh(group, new THREE.IcosahedronGeometry(0.057, 0), level === 1 ? colors.wood : colors.rubber, [0.57, y - 0.17, 0.28], 'Crank_Grip');
  knob.scale.set(level === 3 ? 1.12 : 0.78, 1.0, 0.86);
  if (level === 3) {
    cylinderX(group, 0.63, 0.83, 0.10, 0.13, colors.metal, 'Sealed_Gear_Cover', y - 0.025);
    ring(group, 0.041, 0.009, colors.accent, [1.085, y, 0], 'x', 12).name = 'Adjustable_Drag_Collar';
  }
  return [1.059, y + radius * 0.65, radius * 0.55] as Point;
}

/** Stand-alone recovery reel: a side-mounted spool, a gear body and a crank handle. */
export function buildReel(level: UpgradeLevel): THREE.Group {
  const group = asset('reel', level);
  const colors = palette(level);
  const radius = [0.185, 0.23, 0.28][level - 1];
  const width = [0.13, 0.22, 0.30][level - 1];
  const y = 0.10;
  const disk = (name: string, diskRadius: number, depth: number, surface: THREE.Material, z: number) => {
    const object = mesh(group, new THREE.CylinderGeometry(diskRadius, diskRadius, depth, 8), surface, [0, y, z], name);
    object.rotation.x = Math.PI / 2;
    return object;
  };
  // An open drum exposes the wound line between its two flanges.
  disk('Wound_Line', radius * 0.68, width, colors.line, 0);
  for (const side of [-1, 1]) {
    disk('Reel_Spool', radius, 0.023, colors.metal, side * width / 2);
    ring(group, radius * 0.82, 0.017, level === 1 ? colors.metal : colors.accent, [0, y, side * (width / 2 + 0.014)], 'z', 10).name = 'Spool_Rim';
  }
  const baseY = y - radius - 0.11;
  mesh(group, new THREE.BoxGeometry(radius * 1.7, 0.065, width + 0.11), colors.body, [0, baseY, 0], 'Reel_Mounting_Foot');
  beam(group, [0, baseY + 0.03, 0], [0, y - radius * 0.48, 0], level === 1 ? 0.036 : 0.048, colors.metal, 8).name = 'Reel_Pedestal';
  const crankZ = width / 2 + (level === 1 ? 0.042 : 0.11);
  disk('Crank_Bearing', level === 1 ? 0.05 : 0.075, 0.055, colors.body, crankZ - 0.03);
  const reach = [radius + 0.08, radius + 0.12, radius + 0.17][level - 1];
  beam(group, [0, y, crankZ], [reach, y - 0.10, crankZ], level === 1 ? 0.019 : 0.028, colors.metal, 8).name = 'Crank_Handle';
  if (level === 1) {
    const grip = mesh(group, new THREE.IcosahedronGeometry(0.047, 0), colors.wood, [reach, y - 0.10, crankZ + 0.04], 'Crank_Grip');
    grip.scale.set(0.8, 0.8, 1.35);
  } else {
    // Bearing covers and a rigid frame keep the spool aligned under load.
    for (const side of [-1, 1]) {
      disk('Bearing_Side_Plate', radius * 0.45, 0.04, colors.body, side * (width / 2 + 0.035));
      beam(group, [side * radius * 0.84, baseY + 0.03, -width / 2 - 0.035], [side * radius * 0.84, y + radius * 0.74, -width / 2 - 0.035], 0.027, colors.metal, 8).name = 'Rigid_Spool_Support';
    }
    beam(group, [-radius * 0.84, y + radius * 0.74, -width / 2 - 0.035], [radius * 0.84, y + radius * 0.74, -width / 2 - 0.035], 0.028, colors.metal, 8).name = 'Upper_Frame_Cross_Brace';
    beam(group, [-radius * 0.78, y + radius + 0.075, width / 2 + 0.07], [radius * 0.78, y + radius + 0.075, width / 2 + 0.07], 0.020, colors.metal, 8).name = 'Line_Guide_Rail';
    for (const side of [-1, 1]) beam(group, [side * radius * 0.84, y + radius * 0.74, -width / 2 - 0.035], [side * radius * 0.78, y + radius + 0.075, width / 2 + 0.07], 0.020, colors.metal, 8).name = 'Line_Guide_Support';
    ring(group, 0.043, 0.012, colors.rubber, [0, y + radius + 0.075, width / 2 + 0.07], 'z', 8).name = 'Levelwind_Line_Eye';
    const grip = mesh(group, new THREE.CylinderGeometry(0.045, 0.052, level === 3 ? 0.20 : 0.12, 8), colors.rubber, [reach, y - 0.10, crankZ + 0.055], level === 3 ? 'Power_T_Grip' : 'Rubber_Barrel_Grip');
    if (level === 2) grip.rotation.x = Math.PI / 2;
    else grip.rotation.z = Math.PI / 2;
  }
  if (level === 3) {
    // A distinct sealed gearbox sits behind the drum; the line stays exposed.
    const gearbox = mesh(group, new THREE.IcosahedronGeometry(radius * 0.78, 0), colors.body, [0, y, -width / 2 - 0.10], 'Sealed_Gear_Housing');
    gearbox.scale.set(1.1, 1.0, 0.54);
    ring(group, radius * 0.61, 0.023, colors.metal, [0, y, -width / 2 - 0.20], 'z', 8).name = 'Gearbox_Seal';
    for (const side of [-1, 1]) {
      beam(group, [side * radius * 0.84, baseY + 0.03, width / 2 + 0.035], [side * radius * 0.84, y + radius * 0.74, width / 2 + 0.035], 0.028, colors.metal, 8).name = 'Front_Load_Brace';
      beam(group, [side * radius * 0.84, y + radius * 0.74, -width / 2 - 0.035], [side * radius * 0.84, y + radius * 0.74, width / 2 + 0.035], 0.028, colors.metal, 8).name = 'Through_Frame_Tie_Bar';
    }
    disk('Adjustable_Drag_Dial', 0.098, 0.035, colors.accent, width / 2 + 0.12);
    beam(group, [-radius * 0.50, y - radius - 0.015, width / 2 + 0.055], [radius * 0.50, y - radius - 0.015, width / 2 + 0.055], 0.027, colors.rubber, 8).name = 'Thumb_Clutch_Lever';
  }
  group.userData.structure = ['open-hand-drum', 'bearing-frame-levelwind', 'sealed-gearbox-power-grip'][level - 1];
  return group;
}

/** Continuous tapered blanks, correctly seated guides, and an unbroken line. */
export function buildRod(level: UpgradeLevel): THREE.Group {
  const group = asset('rod', level);
  const colors = palette(level);
  const blankMaterial = material(level === 1 ? '#85745a' : level === 2 ? '#515957' : '#2d3231', { metalness: level === 1 ? 0.04 : 0.15, roughness: 0.89 });
  const grip = level === 1 ? colors.wood : colors.rubber;
  const tipX = [3.12, 3.66, 4.28][level - 1];
  cylinderX(group, 0, 0.055, 0.076, 0.076, colors.metal, 'Butt_Cap');
  if (level === 1) cylinderX(group, 0.055, 0.50, 0.076, 0.066, grip, 'Rear_Grip');
  if (level >= 2) {
    // Higher grades use split EVA grips around an exposed, lighter blank.
    cylinderX(group, 0.055, 0.26, 0.076, 0.067, grip, 'Split_Butt_Grip');
    cylinderX(group, 0.42, 0.52, 0.061, 0.059, grip, 'Split_Rear_Grip');
    cylinderX(group, 0.25, 0.425, 0.034, 0.029, blankMaterial, 'Split_Grip_Bridge');
  }
  cylinderX(group, 0.51, 0.84, 0.052, 0.048, colors.body, 'Reel_Seat');
  cylinderX(group, 0.52, 0.575, 0.059, 0.059, colors.metal, 'Seat_Locking_Nut');
  cylinderX(group, 0.79, 0.845, 0.054, 0.054, colors.metal, 'Seat_Hood');
  cylinderX(group, 0.85, 1.0, 0.056, 0.041, grip, 'Fore_Grip');
  const taper = [[0.044, 0.97], [0.034, 1.65], [0.023, tipX * 0.67], [0.012, tipX * 0.86], [0.006, tipX]];
  const blank = mesh(group, new THREE.LatheGeometry(taper.map(([radius, x]) => new THREE.Vector2(radius, x)), 8), blankMaterial, [0, 0, 0], 'Continuous_Tapered_Blank');
  blank.rotation.z = -Math.PI / 2;
  const spoolExit = spinningReel(group, level, colors);
  const guides = new THREE.Group();
  guides.name = 'Line_Guides';
  group.add(guides);
  const linePoints: Point[] = [spoolExit];
  const count = [5, 6, 8][level - 1];
  for (let index = 0; index < count; index++) {
    const t = index / (count - 1);
    const x = THREE.MathUtils.lerp(1.33, tipX - 0.075, t);
    const radius = THREE.MathUtils.lerp(0.068, 0.023, t);
    const y = -THREE.MathUtils.lerp(0.12, 0.034, t);
    const center: Point = [x, y, 0];
    ring(guides, radius, 0.007, colors.metal, center, 'x', 8).name = `Guide_${index + 1}`;
    ring(guides, radius - 0.010, 0.003, colors.rubber, center, 'x', 8).name = `Ceramic_Insert_${index + 1}`;
    beam(guides, [x - 0.04, -0.022, 0], [x, y + radius, 0], 0.009, colors.metal, 8).name = `Guide_Foot_${index + 1}`;
    if (level >= 2 && index < 2) beam(guides, [x + 0.04, -0.022, 0], [x, y + radius, 0], 0.008, colors.metal, 8).name = `Guide_Brace_${index + 1}`;
    cylinderX(guides, x - 0.045, x - 0.016, 0.036 * (1 - t) + 0.008, 0.035 * (1 - t) + 0.008, blankMaterial, `Thread_Wrap_${index + 1}`);
    linePoints.push(center);
  }
  linePoints.push([tipX, -0.026, 0], [tipX + 0.08, -0.085, 0], [tipX + 0.085, -0.22, 0]);
  tube(group, linePoints, 0.0028, colors.line, 8).name = 'Continuous_Fishing_Line';
  if (level === 3) {
    cylinderX(group, 1.03, 1.065, 0.047, 0.045, colors.metal, 'Carbon_Ferrule');
    cylinderX(group, 2.20, 2.235, 0.027, 0.026, colors.metal, 'Section_Ferrule');
  }
  const tip = new THREE.Object3D();
  tip.name = 'Rod_Tip';
  tip.position.set(tipX, 0, 0);
  group.add(tip);
  group.userData.tipName = tip.name;
  group.userData.structure = ['cork-fiberglass', 'split-eva-graphite', 'long-carbon-sealed-reel'][level - 1];
  group.userData.references = ['https://daiwa.us/collections/spin-reels/products/23-revros-lt'];
  return group;
}

function hook(parent: THREE.Group, at: Point, scale: number, surface: THREE.Material, name: string) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...at);
  group.scale.setScalar(scale);
  parent.add(group);
  ring(group, 0.022, 0.007, surface, [0, 0, 0], 'z', 10).name = 'Hook_Eye';
  tube(group, [[0, -0.018, 0], [0, -0.17, 0], [0.035, -0.245, 0], [0.115, -0.265, 0], [0.175, -0.21, 0], [0.165, -0.12, 0]], 0.009, surface, 8).name = 'Hook_Shank_And_Bend';
  beam(group, [0.165, -0.12, 0], [0.148, -0.153, 0], 0.006, surface, 8).name = 'Barb';
  const point = mesh(group, new THREE.ConeGeometry(0.010, 0.048, 8), surface, [0.165, -0.104, 0], 'Sharp_Point');
  point.rotation.z = -0.08;
  return group;
}

function treble(parent: THREE.Group, at: Point, scale: number, surface: THREE.Material, name: string) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...at);
  group.scale.setScalar(scale);
  parent.add(group);
  ring(group, 0.025, 0.008, surface, [0, 0, 0], 'z', 10).name = 'Treble_Eye';
  beam(group, [0, -0.018, 0], [0, -0.18, 0], 0.014, surface, 8).name = 'Common_Shank';
  for (let index = 0; index < 3; index++) {
    const tine = new THREE.Group();
    tine.name = `Tine_${index + 1}`;
    // Rotation around the common vertical shank distributes all three barbs.
    tine.rotation.y = (index * Math.PI * 2) / 3;
    group.add(tine);
    tube(tine, [[0, -0.13, 0], [0.025, -0.23, 0], [0.11, -0.265, 0], [0.165, -0.21, 0], [0.15, -0.12, 0]], 0.009, surface, 8).name = 'Hook_Bend';
    beam(tine, [0.15, -0.12, 0], [0.135, -0.149, 0], 0.006, surface, 8).name = 'Barb';
    mesh(tine, new THREE.ConeGeometry(0.010, 0.045, 8), surface, [0.15, -0.104, 0], 'Sharp_Point');
  }
  return group;
}

function lureEyes(group: THREE.Group, colors: ReturnType<typeof palette>, x: number, y: number, z: number) {
  for (const side of [-1, 1]) {
    const eye = mesh(group, new THREE.SphereGeometry(0.034, 8, 6), colors.accent, [x, y, side * z], `Eye_${side < 0 ? 'Left' : 'Right'}`);
    eye.scale.z = 0.4;
    mesh(group, new THREE.SphereGeometry(0.017, 8, 6), colors.rubber, [x + 0.006, y, side * (z + 0.01)], 'Eye_Pupil').scale.z = 0.3;
  }
}

function minnowGeometry() {
  const sections = [
    [-0.43, 0.014, 0.01], [-0.30, 0.061, 0.04], [-0.02, 0.087, 0.068],
    [0.25, 0.066, 0.052], [0.39, 0.02, 0.017],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  const geometry = new THREE.BufferGeometry();
  for (const [x, ry, rz] of sections) {
    for (let side = 0; side < 6; side++) {
      const angle = (side / 6) * Math.PI * 2;
      positions.push(x, Math.sin(angle) * ry, Math.cos(angle) * rz);
    }
  }
  for (let section = 0; section < sections.length - 1; section++) {
    for (let side = 0; side < 6; side++) {
      const a = section * 6 + side;
      const b = section * 6 + (side + 1) % 6;
      const c = a + 6;
      const d = b + 6;
      indices.push(a, c, b, b, c, d);
      geometry.addGroup(indices.length - 6, 6, side < 3 ? 1 : 0);
    }
  }
  for (let side = 1; side < 5; side++) {
    indices.push(0, side, side + 1);
    const last = (sections.length - 1) * 6;
    indices.push(last, last + side + 1, last + side);
  }
  geometry.addGroup(indices.length - 24, 24, 0);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildBait(level: UpgradeLevel): THREE.Group {
  const group = asset('bait', level);
  const colors = palette(level);
  if (level === 1) {
    const soft = material('#9c8170', { roughness: 0.96 });
    const worm: Point[] = [[-0.29, 0.12, 0], [-0.23, 0.24, 0.025], [-0.10, 0.29, 0.014], [0.025, 0.24, 0], [0.06, 0.08, 0], [0.15, -0.05, 0], [0.26, -0.03, 0.025], [0.32, 0.07, 0.025]];
    tube(group, worm, 0.037, soft, 6).name = 'Curved_Soft_Worm';
    const wormCurve = new THREE.CatmullRomCurve3(worm.map((point) => new THREE.Vector3(...point)), false, 'centripetal');
    for (let index = 0; index < 8; index++) {
      const t = 0.14 + index * 0.027;
      const point = wormCurve.getPoint(t);
      const band = ring(group, 0.037, 0.0025, soft, [point.x, point.y, point.z], 'z', 8);
      band.name = `Worm_Segment_${index + 1}`;
      band.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), wormCurve.getTangent(t).normalize());
    }
    mesh(group, new THREE.SphereGeometry(0.038, 8, 6), soft, worm[0], 'Worm_Head');
    mesh(group, new THREE.SphereGeometry(0.029, 8, 6), soft, worm[worm.length - 1], 'Worm_Tail');
    hook(group, [0.038, 0.195, -0.025], 0.85, colors.metal, 'Single_Bait_Hook');
    ring(group, 0.024, 0.007, colors.metal, [0.035, 0.31, -0.026], 'z', 10).name = 'Leader_Eye';
    tube(group, [[0.035, 0.31, -0.026], [0.037, 0.26, -0.027], [0.038, 0.195, -0.025]], 0.006, colors.line, 8).name = 'Short_Leader';
  } else if (level === 2) {
    const paint = material('#b4ab91', { metalness: 0.04, roughness: 0.88 });
    const back = material('#555a50', { roughness: 0.92 });
    const body = new THREE.Mesh(minnowGeometry(), [paint, back]);
    body.name = 'Faceted_Minnow_Body';
    body.position.y = 0.06;
    group.add(body);
    const lipMaterial = material('#a6a49b', { roughness: 0.82, transparent: true, opacity: 0.75 });
    const lip = mesh(group, new THREE.BoxGeometry(0.20, 0.013, 0.125), lipMaterial, [0.42, -0.005, 0], 'Diving_Lip');
    lip.rotation.z = -0.30;
    ring(group, 0.031, 0.007, colors.metal, [0.40, 0.045, 0], 'z', 10).name = 'Nose_Line_Eye';
    ring(group, 0.026, 0.006, colors.metal, [0.07, -0.047, 0], 'z', 8).name = 'Belly_Split_Ring';
    hook(group, [0.07, -0.08, 0], 0.58, colors.metal, 'Belly_Hook');
    ring(group, 0.028, 0.007, colors.metal, [-0.40, 0.06, 0], 'z', 10).name = 'Tail_Split_Ring';
    hook(group, [-0.42, 0.04, 0], 0.60, colors.metal, 'Tail_Hook');
    lureEyes(group, colors, 0.255, 0.078, 0.045);
  } else {
    const shape = new THREE.Shape();
    shape.moveTo(-0.43, 0.075);
    shape.lineTo(-0.49, -0.015);
    shape.lineTo(-0.16, -0.095);
    shape.lineTo(0.20, -0.075);
    shape.lineTo(0.36, 0.018);
    shape.lineTo(0.27, 0.13);
    shape.lineTo(0.02, 0.175);
    shape.lineTo(-0.25, 0.11);
    shape.closePath();
    const body = mesh(group, new THREE.ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.018, bevelThickness: 0.018 }), colors.metal, [0, 0.06, -0.035], 'Metal_Vibration_Lure');
    body.userData.construction = 'weighted-metal-blade';
    // The luminous insert is dormant in the studio; it does not emit light.
    const insetMaterial = material('#a3aa94', { roughness: 0.95, emissiveIntensity: 0 });
    for (const side of [-1, 1]) {
      const inset = mesh(group, new THREE.BoxGeometry(0.32, 0.028, 0.006), insetMaterial, [-0.05, 0.102, side * 0.061], 'Dormant_Luminous_Inlay');
      inset.rotation.z = 0.035;
    }
    ring(group, 0.027, 0.007, colors.metal, [0.065, 0.252, 0], 'z', 10).name = 'Dorsal_Line_Eye';
    for (const [x, y, name] of [[-0.34, 0.01, 'Rear_Treble'], [0.16, -0.044, 'Belly_Treble']] as const) {
      ring(group, 0.025, 0.006, colors.metal, [x, y - 0.012, 0], 'z', 10).name = `${name}_Split_Ring`;
      treble(group, [x, y - 0.045, 0], 0.62, colors.metal, name);
    }
    lureEyes(group, colors, 0.242, 0.156, 0.061);
  }
  group.userData.structure = ['curved-soft-worm-single-hook', 'diving-lip-hardbait', 'luminous-metal-blade-two-trebles'][level - 1];
  group.userData.references = ['https://www.rapala.com/us_en/original-floating'];
  return group;
}

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

/** A standalone scoop net display; the approved diver runtime asset is separate. */
export function buildNet(level: UpgradeLevel): THREE.Group {
  const group = asset('net', level);
  const colors = palette(level);
  const grip = material('#30332f', { roughness: 0.97 });
  const shaft = material('#4d514d', { metalness: 0.28, roughness: 0.90 });
  const rim = material('#303732', { metalness: 0.24, roughness: 0.96 });
  const nylon = material('#252e29', { roughness: 1, metalness: 0, emissiveIntensity: 0 });
  cylinderX(group, 0, 0.07, 0.072, 0.072, grip, 'Butt_Cap');
  cylinderX(group, 0.07, 0.53, 0.070, 0.058, grip, 'Fixed_EVA_Grip');
  cylinderX(group, 0.53, 2.06, 0.038, 0.026, shaft, 'Fixed_Length_Pole');
  cylinderX(group, 0.51, 0.575, 0.059, 0.050, shaft, 'Handle_Collar');
  cylinderX(group, 1.94, 2.09, 0.040, 0.033, rim, 'Net_Head_Socket');
  const mouth = new THREE.Group();
  mouth.name = 'Net_Mouth';
  mouth.position.x = 2.62;
  mouth.scale.setScalar([1, 1.15, 1.30][level - 1]);
  group.add(mouth);
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
  group.userData.mouthName = mouth.name;
  group.userData.tipName = tip.name;
  group.userData.mouthScale = mouth.scale.x;
  group.userData.runtimeModel = 'buildFishingNetMesh';
  group.userData.modelRole = 'standalone-upgrade-display';
  group.userData.structure = ['nylon-scoop-net', 'larger-reinforced-scoop-net', 'wide-reinforced-scoop-net'][level - 1];
  group.userData.references = [
    'https://www.frabill.com/collections/landing-nets/products/sportsman-teardrop-fixed-handle-net',
    'https://www.frabill.com/collections/landing-nets/products/scooped-sliding-handle-sportsman-net-1657270',
  ];
  return group;
}

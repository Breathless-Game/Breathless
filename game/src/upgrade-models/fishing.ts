import * as THREE from 'three';
import type { UpgradeLevel } from '../upgrades';
import { buildNetAssembly, buildNetRecoveryReel, buildNetShaft } from '../fishing-net';
import { beam, material, mesh, palette, ring, tube } from './common';
import type { Point } from './common';

function asset(id: string, level: UpgradeLevel) {
  const group = new THREE.Group();
  group.name = `${id}_Lv${level}`;
  group.userData = { upgradeId: id, level, style: 'faceted-pbr' };
  return group;
}

/** Stand-alone recovery reel shared by the assembled net and the workbench. */
export function buildReel(level: UpgradeLevel): THREE.Group {
  return buildNetRecoveryReel(level);
}

/** A rigid replacement shaft; the recovery reel is a separate workbench piece. */
export function buildRod(level: UpgradeLevel): THREE.Group {
  return buildNetShaft(level);
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

/** A complete bare net for the workbench; the reel and torch stay separate loadout pieces. */
export function buildNet(level: UpgradeLevel): THREE.Group {
  const assembly = buildNetAssembly({ netLevel: level, shaftLevel: 1, reelLevel: 0, lampLevel: 0 });
  assembly.group.name = `net_Lv${level}`;
  assembly.group.userData = {
    ...assembly.group.userData,
    upgradeId: 'net',
    level,
    style: 'faceted-pbr',
    modelRole: 'standalone-fishing-net-assembly',
  };
  return assembly.group;
}

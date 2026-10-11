import * as THREE from 'three';
import { beam, material, mesh, ring } from './upgrade-models/common';

/** The local fishing-tool frame runs from the grip toward the mouth on +X. */
export const NET_MOUTH_X = 2.05;

export interface NetAssemblyOptions {
  netLevel?: number;
  shaftLevel?: number;
  /** Zero hides the recovery reel; the dive runtime enables level one by default. */
  reelLevel?: number;
  /** Zero hides the torch while retaining its mounting collar. */
  lampLevel?: number;
}

export interface NetAssembly {
  group: THREE.Group;
  mouth: THREE.Group;
  tip: THREE.Object3D;
  lamp: THREE.Group;
  reel: THREE.Group;
  lampMount: THREE.Group;
}

const levelOf = (level: number | undefined, fallback: number, allowZero = false) => {
  const n = Number.isFinite(level) ? Math.floor(level as number) : fallback;
  return THREE.MathUtils.clamp(n, allowZero ? 0 : 1, 3);
};

function shaftMaterial(level: number) {
  return material(level === 1 ? '#354045' : level === 2 ? '#263338' : '#18262d', {
    metalness: 0.42,
    roughness: 0.42,
  });
}

/** A rigid replacement shaft: grip, socket and telescopic blank, with no reel or guide rings. */
export function buildNetShaft(levelInput = 1): THREE.Group {
  const level = levelOf(levelInput, 1);
  const group = new THREE.Group();
  group.name = 'Net_Shaft';
  group.userData = {
    component: 'net-shaft',
    level,
    role: 'rigid-replacement-shaft',
    length: NET_MOUTH_X,
  };
  const grip = material(level === 1 ? '#835438' : '#2c3839', { roughness: 0.9 });
  const rubber = material('#202a2c', { roughness: 0.96 });
  const metal = material('#8e9a9a', { metalness: 0.72, roughness: 0.34 });
  const blank = shaftMaterial(level);

  // A hand-sized butt and EVA grip; the shaft stays straight through the collar.
  const butt = mesh(group, new THREE.CylinderGeometry(0.08, 0.09, 0.09, 8), rubber, [0.045, 0, 0], 'Shaft_Butt_Cap');
  butt.rotation.z = -Math.PI / 2;
  const handle = mesh(group, new THREE.CylinderGeometry(0.082, 0.072, 0.46, 8), grip, [0.30, 0, 0], 'Shaft_Fixed_Grip');
  handle.rotation.z = -Math.PI / 2;
  const rearCollar = mesh(group, new THREE.CylinderGeometry(0.10, 0.10, 0.065, 8), metal, [0.56, 0, 0], 'Shaft_Rear_Collar');
  rearCollar.rotation.z = -Math.PI / 2;
  const shaftEnd = level === 1 ? 1.98 : level === 2 ? 2.01 : 2.05;
  const shaft = mesh(group, new THREE.CylinderGeometry(0.045, 0.067, shaftEnd - 0.58, 8), blank, [(0.58 + shaftEnd) / 2, 0, 0], 'Rigid_Net_Shaft');
  shaft.rotation.z = -Math.PI / 2;
  const ferrule = mesh(group, new THREE.CylinderGeometry(0.057, 0.057, 0.12, 8), metal, [shaftEnd + 0.045, 0, 0], 'Mouth_Socket_Ferrule');
  ferrule.rotation.z = -Math.PI / 2;
  // A short rigid throat reaches the mouth pivot, so enlarging the bag never opens a gap.
  const throat = mesh(group, new THREE.CylinderGeometry(0.047, 0.056, NET_MOUTH_X - shaftEnd + 0.02, 8), blank, [(shaftEnd + NET_MOUTH_X + 0.01) / 2, 0, 0], 'Mouth_Rigid_Throat');
  throat.rotation.z = -Math.PI / 2;
  if (level >= 2) {
    const band = mesh(group, new THREE.CylinderGeometry(0.054, 0.054, 0.026, 8), metal, [1.17, 0, 0], `Shaft_Ferrule_Lv${level}`);
    band.rotation.z = -Math.PI / 2;
  }
  if (level === 3) {
    const band = mesh(group, new THREE.CylinderGeometry(0.049, 0.049, 0.026, 8), metal, [1.67, 0, 0], 'Shaft_Second_Ferrule');
    band.rotation.z = -Math.PI / 2;
  }
  return group;
}

function ellipseHoop(radiusY: number, radiusZ: number, surface: THREE.Material) {
  const points: THREE.Vector3[] = [];
  const count = 12;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    points.push(new THREE.Vector3(0, Math.sin(angle) * radiusY, Math.cos(angle) * radiusZ));
  }
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  return new THREE.Mesh(new THREE.TubeGeometry(curve, count * 2, 0.022, 6, true), surface);
}

function netPoints(radiusY: number, radiusZ: number) {
  return Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2;
    return [0, Math.sin(angle) * radiusY, Math.cos(angle) * radiusZ] as [number, number, number];
  });
}

/** Build the deep diamond pocket behind the hoop as a single light line mesh. */
function diamondPocket(radiusY: number, radiusZ: number, nylon: THREE.Material) {
  const rows = [0, 0.16, 0.36, 0.58, 0.76];
  const taper = [1, 1.03, 0.98, 0.87, 0.70];
  const sides = 12;
  const ring = netPoints(radiusY, radiusZ);
  const point = (phase: number, row: number) => {
    const perimeter = ((phase % sides) + sides) % sides;
    const i = Math.floor(perimeter);
    const a = new THREE.Vector3(...ring[i]);
    const b = new THREE.Vector3(...ring[(i + 1) % sides]);
    const p = a.lerp(b, perimeter - i);
    return new THREE.Vector3(p.x - rows[row], p.y * taper[row], p.z * taper[row]);
  };
  const positions: number[] = [];
  const add = (a: THREE.Vector3, b: THREE.Vector3) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (let row = 0; row < rows.length - 1; row++) {
    for (let side = 0; side < sides; side++) {
      // The alternating half-cell makes the diagonals read as diamonds rather than a cage.
      add(point(side + (row % 2 ? 0.5 : 0), row), point(side + (row % 2 ? 0 : 0.5), row + 1));
      add(point(side + (row % 2 ? 0 : 0.5), row), point(side + (row % 2 ? 0.5 : 0), row + 1));
    }
  }
  const floor = ring.map(([x, y, z]) => new THREE.Vector3(x - rows[rows.length - 1], y * taper[taper.length - 1], z * taper[taper.length - 1]));
  for (let i = 0; i < sides; i++) add(floor[i], floor[(i + 1) % sides]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const web = new THREE.LineSegments(geometry, nylon);
  web.name = 'Deep_Diamond_Nylon_Bag';
  web.renderOrder = 2;
  web.userData = { strandCount: positions.length / 6, depth: rows[rows.length - 1], weave: 'diamond' };
  return web;
}

function buildMouth(levelInput: number) {
  const level = levelOf(levelInput, 1);
  const mouth = new THREE.Group();
  mouth.name = 'Net_Mouth';
  mouth.position.x = NET_MOUTH_X;
  mouth.userData = { component: 'net-mouth', level, socketX: NET_MOUTH_X, scaleAnchor: 'neck' };
  const frame = material(level === 1 ? '#526c70' : level === 2 ? '#688e8e' : '#92b7ae', { metalness: 0.56, roughness: 0.34 });
  const reinforcement = material('#243438', { metalness: 0.48, roughness: 0.42 });
  const nylon = new THREE.LineBasicMaterial({ color: '#b6d3d0', transparent: true, opacity: 0.62, depthWrite: false });
  const scale = [1, 1.15, 1.3][level - 1];
  // Scale only the opening plane. The throat and socket remain attached at mouth.position.
  mouth.scale.set(1, scale, scale);
  const hoop = ellipseHoop(0.56, 0.48, frame);
  hoop.name = 'Wide_Elliptical_Net_Rim';
  mouth.add(hoop);
  const guard = ellipseHoop(0.50, 0.42, reinforcement);
  guard.name = 'Reinforced_Outer_Rim';
  mouth.add(guard);
  mouth.add(diamondPocket(0.56, 0.48, nylon));
  // Two rigid braces make the hoop read as a working landing net at a glance.
  mouth.add(beam(mouth, [-0.12, 0, 0], [0, 0.56, 0], 0.014, frame, 6));
  mouth.add(beam(mouth, [-0.12, 0, 0], [0, -0.56, 0], 0.014, frame, 6));
  const tip = new THREE.Object3D();
  tip.name = 'Catch_Centre';
  // The catch point sits just inside the bag, below its open rim.
  tip.position.set(0, -0.18, 0);
  mouth.add(tip);
  return { mouth, tip };
}

/** Compact side-mounted recovery reel; its origin is the mounting axle. */
export function buildNetRecoveryReel(levelInput = 1): THREE.Group {
  const level = levelOf(levelInput, 1);
  const group = new THREE.Group();
  group.name = 'Net_Recovery_Reel';
  group.userData = { component: 'recovery-reel', level, role: 'net-recovery-wheel' };
  const body = material(level === 1 ? '#263b42' : level === 2 ? '#364c51' : '#52656a', { metalness: 0.68, roughness: 0.32 });
  const metal = material('#a4b2b3', { metalness: 0.82, roughness: 0.28 });
  const line = material('#1a282b', { roughness: 0.9 });
  const radius = 0.16 + level * 0.02;
  const spool = mesh(group, new THREE.CylinderGeometry(radius, radius, 0.12, 10), metal, [0, 0, 0], 'Recovery_Spool');
  spool.rotation.x = Math.PI / 2;
  const core = mesh(group, new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.125, 10), line, [0, 0, 0.005], 'Wound_Recovery_Line');
  core.rotation.x = Math.PI / 2;
  ring(group, radius * 0.86, 0.022, body, [0, 0, 0.07], 'z', 10).name = 'Recovery_Spool_Rim';
  mesh(group, new THREE.BoxGeometry(0.27 + level * 0.025, 0.20, 0.20), body, [0, -0.16, 0], 'Recovery_Reel_Body');
  beam(group, [-0.18, -0.16, 0], [0.18, -0.16, 0], 0.023, metal, 8).name = 'Recovery_Mount_Bar';
  const handle = beam(group, [radius + 0.03, 0.01, 0], [radius + 0.18, -0.10, 0], 0.015, metal, 8);
  handle.name = 'Recovery_Crank';
  mesh(group, new THREE.IcosahedronGeometry(0.043, 0), body, [radius + 0.20, -0.12, 0], 'Recovery_Crank_Grip');
  return group;
}

/** A small directional torch that can be clipped to the net shaft. */
export function buildNetTorch(levelInput = 1): THREE.Group {
  const level = levelOf(levelInput, 1);
  const group = new THREE.Group();
  group.name = 'Net_Torch';
  group.userData = { component: 'net-torch', level, role: 'equipment-lamp' };
  const dark = material('#1b292d', { metalness: 0.42, roughness: 0.38 });
  const bezel = material('#9eaeb0', { metalness: 0.74, roughness: 0.30 });
  // The workbench model is unlit; the diver's real SpotLight supplies the beam.
  const lens = material(level === 3 ? '#9ff6e6' : '#d8f4dc', { emissiveIntensity: 0, roughness: 0.22 });
  const body = mesh(group, new THREE.CylinderGeometry(0.065, 0.08, 0.26 + level * 0.025, 8), dark, [0, 0, 0], 'Torch_Housing');
  body.rotation.z = -Math.PI / 2;
  const collar = mesh(group, new THREE.CylinderGeometry(0.086, 0.086, 0.035, 8), bezel, [0.13 + level * 0.012, 0, 0], 'Torch_Bezel');
  collar.rotation.z = -Math.PI / 2;
  const front = mesh(group, new THREE.CylinderGeometry(0.059, 0.059, 0.012, 8), lens, [0.155 + level * 0.012, 0, 0], 'Torch_Lens');
  front.rotation.z = -Math.PI / 2;
  return group;
}

function buildLampMount() {
  const group = new THREE.Group();
  group.name = 'Net_Lamp_Mount';
  group.userData = { component: 'lamp-mount', role: 'shaft-clamp' };
  const mount = material('#8e9c9c', { metalness: 0.74, roughness: 0.30 });
  ring(group, 0.085, 0.012, mount, [0, 0, 0], 'x', 10).name = 'Torch_Clamp_Ring';
  beam(group, [0, 0.076, -0.04], [0, 0.13, -0.04], 0.012, mount, 6).name = 'Torch_Clamp_Tab';
  return group;
}

/** Build the complete modular net, optionally with clipped reel and torch. */
export function buildNetAssembly(options: NetAssemblyOptions = {}): NetAssembly {
  const netLevel = levelOf(options.netLevel, 1);
  const shaftLevel = levelOf(options.shaftLevel, 1);
  const reelLevel = levelOf(options.reelLevel, 0, true);
  const lampLevel = levelOf(options.lampLevel, 0, true);
  const group = new THREE.Group();
  group.name = 'Fishing_Net_Assembly';
  group.userData = { component: 'fishing-net-assembly', netLevel, shaftLevel, reelLevel, lampLevel, mouthX: NET_MOUTH_X };
  group.add(buildNetShaft(shaftLevel));
  const builtMouth = buildMouth(netLevel);
  group.add(builtMouth.mouth);
  const lampMount = buildLampMount();
  lampMount.position.set(0.83, 0.06, 0.11);
  group.add(lampMount);
  const lamp = buildNetTorch(Math.max(1, lampLevel));
  lamp.position.set(0, 0, 0);
  lamp.visible = lampLevel > 0;
  lampMount.add(lamp);
  const reel = buildNetRecoveryReel(Math.max(1, reelLevel));
  reel.position.set(0.82, -0.12, 0.03);
  reel.visible = reelLevel > 0;
  group.add(reel);
  return { group, mouth: builtMouth.mouth, tip: builtMouth.tip, lamp, reel, lampMount };
}

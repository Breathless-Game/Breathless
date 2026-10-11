import * as THREE from 'three';
import { flatMat } from './lowpoly';

/**
 * The fishing boat: the one moored over the trench on every map (world.ts), and
 * the model of it on the workbench (upgrades.ts). Bow toward +x, deck at y 0.64.
 * Every call builds it fresh, with its own materials.
 */
export function buildFishingBoat(): THREE.Group {
  const boat = new THREE.Group();

  const hullMat = flatMat('#b8483e');
  const trimMat = flatMat('#f0bf72');
  const deckMat = flatMat('#d7bb88');
  const cabinMat = flatMat('#e9eee7');
  const glassMat = flatMat('#16475d', { metalness: 0.35, roughness: 0.25 });
  const blueMat = flatMat('#2f6f8f');
  const metalMat = flatMat('#4c6570', { metalness: 0.7, roughness: 0.32 });
  const woodMat = flatMat('#624431');
  const ropeMat = flatMat('#8c7353');
  const lampMat = flatMat('#ffcc4d', { emissive: '#ff9e3d', emissiveIntensity: 1.8 });
  const redLampMat = flatMat('#ef5b52', { emissive: '#ef3028', emissiveIntensity: 1.2 });
  // The map's lighting drives these (world.ts): lit at night, dim by day.
  boat.userData.lamps = [lampMat, redLampMat];

  // A side-profile extrusion gives the hull a readable pointed bow and a
  // deep keel, while keeping the same flat-shaded low-poly language.
  const hullShape = new THREE.Shape();
  hullShape.moveTo(-3.35, 0.64);
  hullShape.lineTo(2.05, 0.64);
  hullShape.lineTo(3.45, 0.64);
  hullShape.lineTo(3.45, 0.28);
  hullShape.lineTo(2.62, -0.45);
  hullShape.lineTo(-2.38, -0.62);
  hullShape.lineTo(-3.45, -0.08);
  hullShape.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 1.72, bevelEnabled: false, steps: 1 });
  hullGeo.translate(0, 0, -0.86);
  const hull = new THREE.Mesh(new THREE.BufferGeometry().copy(hullGeo), [hullMat, deckMat]);

  const stripeShape = new THREE.Shape();
  stripeShape.moveTo(-3.2, -0.05);
  stripeShape.lineTo(2.05, 0.0);
  stripeShape.lineTo(2.05, -0.2);
  stripeShape.lineTo(-2.55, -0.28);
  stripeShape.closePath();
  const stripeGeo = new THREE.ExtrudeGeometry(stripeShape, { depth: 0.035, bevelEnabled: false });
  stripeGeo.translate(0, 0, 0.85);
  const stripe = new THREE.Mesh(stripeGeo, trimMat);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(6.25, 0.18, 1.58), deckMat);
  deck.position.y = 0.55;
  // Add a shoulder ring so only the foredeck narrows, leaving the work area wide.
  const foredeckShape = new THREE.Shape();
  foredeckShape.moveTo(-3.125, -0.79);
  foredeckShape.lineTo(2.12, -0.79);
  foredeckShape.lineTo(2.85, -0.44);
  foredeckShape.lineTo(3.38, -0.095);
  foredeckShape.lineTo(3.38, 0.095);
  foredeckShape.lineTo(2.85, 0.44);
  foredeckShape.lineTo(2.12, 0.79);
  foredeckShape.lineTo(-3.125, 0.79);
  foredeckShape.closePath();
  deck.geometry.dispose();
  const foredeckGeo = new THREE.ExtrudeGeometry(foredeckShape, {depth: 0.18, bevelEnabled: false});
  foredeckGeo.rotateX(Math.PI / 2);
  foredeckGeo.translate(0, 0.09, 0);
  deck.geometry.copy(foredeckGeo);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.05, 1.35, 1.28), cabinMat);
  cabin.position.set(-0.82, 1.34, 0);
  const cabinFront = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.46, 0.035), glassMat);
  cabinFront.position.set(0.12, 1.58, 0.66);
  const cabinSide = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.45, 0.035), glassMat);
  cabinSide.position.set(-0.95, 1.58, 0.66);
  const cabinBackWindow = cabinSide.clone();
  cabinBackWindow.position.z = -0.66;
  const cabinFrontFrame = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.58, 0.05), trimMat);
  cabinFrontFrame.position.set(0.12, 1.57, 0.7);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.16, 1.55), blueMat);
  roof.position.set(-0.82, 2.08, 0);
  const roofTrim = new THREE.Mesh(new THREE.BoxGeometry(2.68, 0.08, 1.68), trimMat);
  roofTrim.position.set(-0.82, 1.99, 0);

  // Small structural parts make the boat read as working equipment instead
  // of a single block when it is seen from the surface.
  const rod = (a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) => {
    const direction = new THREE.Vector3().subVectors(b, a);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 6), mat);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
  };

  const railPosts = [-2.65, -2.0, 1.65, 2.32].map((x) => rod(new THREE.Vector3(x, 0.61, 0.64), new THREE.Vector3(x, 1.02, 0.64), 0.035, metalMat));
  const sideRail = rod(new THREE.Vector3(-2.65, 1.02, 0.64), new THREE.Vector3(2.32, 1.02, 0.64), 0.04, metalMat);
  const bowRail = rod(new THREE.Vector3(2.32, 1.02, 0.64), new THREE.Vector3(3.3, 1.02, 0.07), 0.04, metalMat);
  boat.add(rod(new THREE.Vector3(2.32, 1.02, -0.79), new THREE.Vector3(3.3, 1.02, -0.07), 0.04, metalMat));
  boat.add(rod(new THREE.Vector3(3.3, 0.6, 0), new THREE.Vector3(3.3, 1.02, 0), 0.035, metalMat));
  for (const sign of [-1, 1]) {
    boat.add(rod(new THREE.Vector3(2.12, 0.61, sign * 0.79), new THREE.Vector3(2.85, 0.61, sign * 0.44), 0.05, trimMat));
    boat.add(rod(new THREE.Vector3(2.85, 0.61, sign * 0.44), new THREE.Vector3(3.38, 0.61, sign * 0.095), 0.05, trimMat));
  }

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 2.75, 6), woodMat);
  mast.position.set(2.3, 1.95, 0);
  const mastBrace = rod(new THREE.Vector3(1.72, 0.66, 0), new THREE.Vector3(2.3, 3.28, 0), 0.035, metalMat);
  const boom = rod(new THREE.Vector3(1.48, 2.77, 0), new THREE.Vector3(2.68, 2.77, 0), 0.04, woodMat);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.78, 5), metalMat);
  antenna.position.set(-0.84, 2.54, 0);
  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), lampMat);
  antennaTip.position.set(-0.84, 2.96, 0);

  const engineVent = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.72), metalMat);
  engineVent.position.set(-2.18, 0.78, 0);
  const ventSlat = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.78), trimMat);
  ventSlat.position.set(-2.18, 0.78, 0.38);

  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.16, 10), metalMat);
  reel.position.set(1.45, 0.89, 0.28);
  reel.rotation.x = Math.PI / 2;
  const reelDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.24, 8), ropeMat);
  reelDrum.position.set(1.45, 0.89, 0.28);
  reelDrum.rotation.x = Math.PI / 2;
  const reelArm = rod(new THREE.Vector3(1.45, 0.89, 0.28), new THREE.Vector3(1.45, 1.36, 0.28), 0.045, metalMat);

  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.55, 0.7), woodMat);
  crate.position.set(-2.55, 0.82, 0.15);
  const crateBand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.58, 0.73), trimMat);
  crateBand.position.set(-2.55, 0.82, 0.15);
  const lifeRing = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.065, 5, 10), flatMat('#f2714b'));
  lifeRing.position.set(-1.92, 0.98, 0.9);
  lifeRing.rotation.x = 0;

  const sternLamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), redLampMat);
  sternLamp.position.set(-3.05, 0.74, 0.15);
  const propeller = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.045, 4, 8), metalMat);
  propeller.position.set(-2.72, -0.62, 0);
  propeller.rotation.y = Math.PI / 2;

  boat.add(hull, stripe, cabin, cabinFront, cabinSide, cabinBackWindow, cabinFrontFrame, roof, roofTrim);
  boat.add(...railPosts, sideRail, bowRail, mast, mastBrace, boom, antenna, antennaTip);
  boat.add(engineVent, ventSlat, reel, reelDrum, reelArm, crate, crateBand, lifeRing, sternLamp, propeller);
  // Shared cross sections make deck and underwater bow one continuous shell.
  const sections = [
    [-3.35, 0.79, -0.3], [-2.8, 0.79, -0.58],
    [1.8, 0.79, -0.58], [2.35, 0.69, -0.43],
    [2.85, 0.43, -0.18], [3.35, 0.035, 0.12],
  ];
  const rings = sections.map(([x, w, bottom]) => [
    new THREE.Vector3(x, 0.64, -w),
    new THREE.Vector3(x, bottom, -w * 0.57),
    new THREE.Vector3(x, bottom, w * 0.57),
    new THREE.Vector3(x, 0.64, w),
  ]);
  const vertices: number[] = [];
  const refinedHullGeo = new THREE.BufferGeometry();
  const triangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, material: number) => {
    const start = vertices.length / 3;
    vertices.push(...a.toArray(), ...b.toArray(), ...c.toArray());
    refinedHullGeo.addGroup(start, 3, material);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < 4; j++) {
      const k = (j + 1) % 4;
      triangle(rings[i][j], rings[i + 1][j], rings[i][k], j === 3 ? 1 : 0);
      triangle(rings[i][k], rings[i + 1][j], rings[i + 1][k], j === 3 ? 1 : 0);
    }
  }
  triangle(rings[0][0], rings[0][1], rings[0][2], 0);
  triangle(rings[0][0], rings[0][2], rings[0][3], 0);
  const end = rings[rings.length - 1];
  triangle(end[0], end[2], end[1], 0);
  triangle(end[0], end[3], end[2], 0);
  refinedHullGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  refinedHullGeo.computeVertexNormals();
  hull.name = 'integrated-hull-and-deck';
  hull.geometry.dispose();
  hull.geometry = refinedHullGeo;
  const rubberMat = flatMat('#263239');
  const seamMat = flatMat('#9a784f');
  const whiteMat = flatMat('#fff3da');
  const detailBox = (size: number[], pos: number[], mat: THREE.Material, name: string) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.name = name;
    boat.add(mesh);
    return mesh;
  };
  for (let x = -2.9; x < 2.7; x += 0.32) {
    const plankWidth = 1.5 * (1 - 0.75 * THREE.MathUtils.clamp((x - 2.12) / 1.26, 0, 1));
    detailBox([0.018, 0.014, plankWidth], [x, 0.648, 0], seamMat, 'deck-plank-seam');
  }
  for (const z of [-0.79, 0.79]) {
    detailBox([5.25, 0.1, 0.09], [-0.505, 0.48, z], trimMat, 'gunwale-cap');
    const rearStripe = stripe.clone();
    if (z < 0) { rearStripe.position.z = -1.735; boat.add(rearStripe); }
    for (const x of [-2.45, -1.65, 1.9]) {
      const tire = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.08, 8, 16), rubberMat);
      tire.position.set(x, 0.2, z * 1.07);
      boat.add(tire, rod(new THREE.Vector3(x, 0.6, z), new THREE.Vector3(x, 0.31, z * 1.07), 0.014, ropeMat));
    }
    if (z < 0) {
      for (const x of [-2.65, -2.0, 1.65, 2.32]) boat.add(rod(new THREE.Vector3(x, 0.61, z), new THREE.Vector3(x, 1.02, z), 0.035, metalMat));
      boat.add(rod(new THREE.Vector3(-2.65, 1.02, z), new THREE.Vector3(2.32, 1.02, z), 0.04, metalMat));
    }
    detailBox([0.46, 0.84, 0.025], [-1.56, 1.13, z > 0 ? 0.659 : -0.659], blueMat, 'cabin-door');
    detailBox([0.075, 0.035, 0.04], [-1.39, 1.12, z > 0 ? 0.68 : -0.68], trimMat, 'door-handle');
    for (const x of [-1.5, -0.4, 0.45]) {
      detailBox([0.04, 0.53, 0.055], [x, 1.58, z > 0 ? 0.685 : -0.685], cabinMat, 'window-mullion');
    }
    detailBox([1.9, 0.045, 0.06], [-0.78, 1.33, z > 0 ? 0.68 : -0.68], trimMat, 'window-sill');
  }
  // Forward-facing windshield and navigation fittings.
  detailBox([0.025, 0.48, 0.96], [0.219, 1.6, 0], glassMat, 'forward-windshield');
  detailBox([0.055, 0.54, 0.045], [0.24, 1.6, 0], cabinMat, 'windshield-divider');
  for (const x of [-2.9, 2.35]) {
    detailBox([0.32, 0.08, 0.2], [x, 0.7, -0.32], metalMat, 'cleat-base');
    boat.add(rod(new THREE.Vector3(x - 0.2, 0.81, -0.32), new THREE.Vector3(x + 0.2, 0.81, -0.32), 0.035, metalMat));
  }
  for (let i = 0; i < 5; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.13 + i * 0.028, 0.014, 6, 24), ropeMat);
    coil.rotation.x = Math.PI / 2;
    coil.position.set(2.35, 0.68, 0.18);
    boat.add(coil);
  }
  for (let i = 0; i < 4; i++) detailBox([0.52, 0.025, 0.035], [-2.18, 0.71 + i * 0.055, 0.405], rubberMat, 'engine-vent-slat');
  const exhaust = rod(new THREE.Vector3(-1.45, 2.16, -0.36), new THREE.Vector3(-1.45, 2.75, -0.36), 0.065, metalMat);
  boat.add(exhaust);
  detailBox([0.22, 0.05, 0.18], [-1.45, 2.78, -0.36], rubberMat, 'exhaust-cap');
  boat.add(rod(new THREE.Vector3(2.3, 3.12, 0), new THREE.Vector3(0.8, 0.7, -0.6), 0.012, ropeMat));
  boat.add(rod(new THREE.Vector3(2.3, 3.12, 0), new THREE.Vector3(3.0, 0.7, 0.5), 0.012, ropeMat));
  detailBox([0.8, 0.045, 0.65], [0.95, 0.68, -0.24], metalMat, 'deck-hatch');
  detailBox([0.18, 0.06, 0.045], [0.95, 0.73, -0.24], trimMat, 'hatch-handle');
  for (const z of [-0.42, 0.42]) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 16), metalMat);
    flange.rotation.x = Math.PI / 2;
    flange.position.set(1.45, 0.98, z);
    boat.add(flange);
  }
  const ropeDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.76, 16), ropeMat);
  ropeDrum.rotation.x = Math.PI / 2;
  ropeDrum.position.set(1.45, 0.98, 0);
  boat.add(ropeDrum);
  for (let i = 0; i < 3; i++) detailBox([0.76, 0.018, 0.018], [-2.55, 0.67 + i * 0.14, 0.512], seamMat, 'crate-board-seam');
  const ringBands = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.069, 8, 8, Math.PI / 5), whiteMat);
  for (let i = 0; i < 4; i++) {
    const band = ringBands.clone();
    band.position.copy(lifeRing.position);
    band.position.z += 0.006;
    band.rotation.z = i * Math.PI / 2;
    boat.add(band);
  }
  return boat;
}

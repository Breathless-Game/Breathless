import * as THREE from 'three';
import type { UpgradeLevel } from '../upgrades';
import { beam, material, mesh, palette, ring, tube, type Point } from './common';

/** A closed, thin strip; rings are listed around its perimeter. */
function stripGeometry(outer: Point[], inner: Point[]) {
  const positions: number[] = [];
  const add = (a: Point, b: Point, c: Point) => positions.push(...a, ...b, ...c);
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    add(outer[i], inner[i], outer[j]);
    add(inner[i], inner[j], outer[j]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function solidBelt(group: THREE.Group, rx: number, rz: number, y: number, width: number, surface: THREE.Material) {
  const rings: Point[][] = [];
  for (const [offset, inset] of [[-width / 2, 0], [width / 2, 0], [-width / 2, 0.026], [width / 2, 0.026]]) {
    rings.push(Array.from({ length: 8 }, (_, index): Point => {
      const angle = index / 8 * Math.PI * 2;
      return [(rx - inset) * Math.cos(angle), y + offset, (rz - inset) * Math.sin(angle)];
    }));
  }
  mesh(group, stripGeometry(rings[0], rings[1]), surface);
  mesh(group, stripGeometry(rings[2].slice().reverse(), rings[3].slice().reverse()), surface);
  mesh(group, stripGeometry(rings[1], rings[3]), surface);
  mesh(group, stripGeometry(rings[2], rings[0]), surface);
}

function cylinderZ(group: THREE.Group, radius: number, depth: number, surface: THREE.Material, at: Point, sides = 8) {
  const object = mesh(group, new THREE.CylinderGeometry(radius, radius, depth, sides), surface, at);
  object.rotation.x = Math.PI / 2;
  return object;
}

function footPocket(group: THREE.Group, surface: THREE.Material, lip: THREE.Material) {
  // Toe is closed; heel is hollow. The inside and rim are geometry, not a painted oval.
  const sections = [
    { y: -0.21, rx: 0.1, rz: 0.075, z: 0.075 },
    { y: -0.08, rx: 0.19, rz: 0.13, z: 0.125 },
    { y: 0.2, rx: 0.205, rz: 0.16, z: 0.15 },
    { y: 0.53, rx: 0.175, rz: 0.135, z: 0.17 },
  ];
  const rings = sections.map(({ y, rx, rz, z }) => Array.from({ length: 8 }, (_, i): Point => {
    const angle = i * Math.PI / 4;
    return [Math.cos(angle) * rx, y, z + Math.sin(angle) * rz];
  }));
  for (let i = 0; i < rings.length - 1; i++) mesh(group, stripGeometry(rings[i], rings[i + 1]), surface);
  const toeCap = mesh(group, new THREE.CircleGeometry(0.1, 8), surface, [0, -0.211, 0.075]);
  toeCap.rotation.x = Math.PI / 2;
  toeCap.scale.y = 0.75;
  const inner = Array.from({ length: 8 }, (_, i): Point => {
    const angle = i * Math.PI / 4;
    return [Math.cos(angle) * 0.145, 0.53, 0.17 + Math.sin(angle) * 0.105];
  });
  const innerEnd = inner.map(([x, , z]): Point => [x * 0.76, 0.17, 0.17 + (z - 0.17) * 0.8]);
  mesh(group, stripGeometry(rings[3], inner), lip);
  mesh(group, stripGeometry(inner, innerEnd), surface);
  const pocketFloor = mesh(group, new THREE.CircleGeometry(0.145 * 0.76, 8), surface, [0, 0.169, 0.17], 'recessed-pocket-floor');
  pocketFloor.rotation.x = -Math.PI / 2;
  pocketFloor.scale.y = (0.105 * 0.8) / (0.145 * 0.76);
  // An open heel is retained by a flat rubber strap instead of a closed shoe.
  const strap = new THREE.Shape();
  for (const [index, [x, y]] of [[-0.185, 0.4], [-0.24, 0.56], [-0.22, 0.7], [-0.1, 0.8], [0.1, 0.8], [0.22, 0.7], [0.24, 0.56], [0.185, 0.4], [0.155, 0.43], [0.185, 0.57], [0.175, 0.67], [0.085, 0.745], [-0.085, 0.745], [-0.175, 0.67], [-0.185, 0.57], [-0.155, 0.43]].entries()) {
    if (index === 0) strap.moveTo(x, y); else strap.lineTo(x, y);
  }
  strap.closePath();
  mesh(group, new THREE.ExtrudeGeometry(strap, { depth: 0.04, bevelEnabled: false }), lip, [0, 0, 0.155], 'open-heel-retaining-strap');
  mesh(group, new THREE.BoxGeometry(0.16, 0.08, 0.052), lip, [0, 0.77, 0.18], 'heel-contact-pad');
  for (const side of [-1, 1]) {
    mesh(group, new THREE.BoxGeometry(0.08, 0.115, 0.085), lip, [side * 0.182, 0.4, 0.14], 'heel-strap-buckle');
  }
}

function bladeGeometry(length: number, widths: number[], channelDepth: number, vented: boolean) {
  const rows = widths.length;
  const xs = [-1, -0.75, -0.48, -0.16, 0.16, 0.48, 0.75, 1];
  const positions: number[] = [];
  const vertex = (row: number, column: number, bottom = false): Point => {
    const fraction = row / (rows - 1);
    const lateral = xs[column];
    const centerChannel = column === 2 || column === 5 ? -channelDepth : 0;
    const tip = row === rows - 1 ? Math.abs(lateral) * 0.085 : 0;
    return [widths[row] * lateral, -0.14 - length * fraction + tip, -0.008 - fraction * 0.12 + centerChannel - (bottom ? 0.027 : 0)];
  };
  const face = (a: Point, b: Point, c: Point, d: Point) => positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < xs.length - 1; column++) {
      // Three open water vents, with structural rubber between them.
      if (vented && row === 1 && [1, 3, 5].includes(column)) {
        const a = vertex(row, column); const b = vertex(row + 1, column);
        const c = vertex(row + 1, column + 1); const d = vertex(row, column + 1);
        face(a, vertex(row, column, true), vertex(row + 1, column, true), b);
        face(b, vertex(row + 1, column, true), vertex(row + 1, column + 1, true), c);
        face(c, vertex(row + 1, column + 1, true), vertex(row, column + 1, true), d);
        face(d, vertex(row, column + 1, true), vertex(row, column, true), a);
        continue;
      }
      face(vertex(row, column), vertex(row + 1, column), vertex(row + 1, column + 1), vertex(row, column + 1));
      face(vertex(row, column, true), vertex(row, column + 1, true), vertex(row + 1, column + 1, true), vertex(row + 1, column, true));
    }
    for (const column of [0, xs.length - 1]) face(vertex(row, column), vertex(row, column, true), vertex(row + 1, column, true), vertex(row + 1, column));
  }
  for (const row of [0, rows - 1]) for (let column = 0; column < xs.length - 1; column++) face(vertex(row, column), vertex(row, column + 1), vertex(row, column + 1, true), vertex(row, column, true));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildFins(level: UpgradeLevel) {
  const group = new THREE.Group();
  group.name = `fins-level-${level}`;
  const colors = palette(level);
  const flexible = material('#333734', { metalness: 0, roughness: 0.97 });
  const carbon = material('#303638', { metalness: 0.07, roughness: 0.9 });
  const composite = material('#59605b', { metalness: 0, roughness: 0.93 });
  const length = [1.03, 1.4, 1.92][level - 1];
  const widths = level === 1 ? [0.16, 0.22, 0.29, 0.32, 0.3] : level === 2 ? [0.16, 0.24, 0.31, 0.34, 0.32] : [0.16, 0.24, 0.29, 0.31, 0.31, 0.29];
  const blade = level === 1 ? flexible : level === 2 ? composite : carbon;
  for (const side of [-1, 1]) {
    const fin = new THREE.Group();
    fin.name = side < 0 ? 'left-fin' : 'right-fin';
    fin.position.x = side * 0.405;
    fin.rotation.z = side * 0.075;
    group.add(fin);
    footPocket(fin, flexible, colors.rubber);
    mesh(fin, bladeGeometry(length, widths, level === 2 ? 0.025 : 0, level === 1), blade, [0, 0, 0], 'thin-flexible-blade');
    for (const edge of [-1, 1]) {
      tube(fin, widths.map((width, row): Point => [edge * width, -0.14 - length * row / (widths.length - 1) + (row === widths.length - 1 ? 0.085 : 0), -0.008 - row / (widths.length - 1) * 0.12]), level === 3 ? 0.014 : 0.021, colors.rubber, 4);
      tube(fin, [[edge * 0.18, 0.25, 0.09], [edge * 0.18, -0.1, 0.08], [edge * 0.14, -0.34, -0.003]], 0.02, colors.rubber, 4);
    }
    const ribs = level === 1 ? [-0.35, 0.35] : [-0.38, 0.38];
    for (const fraction of ribs) tube(fin, widths.map((width, row): Point => [width * fraction, -0.14 - length * row / (widths.length - 1) + (row === widths.length - 1 ? Math.abs(fraction) * 0.085 : 0), 0.004 - row / (widths.length - 1) * 0.12]), level === 3 ? 0.008 : 0.016, colors.rubber, 4);
    // Functional blade fastenings, without decorative colored strips.
    for (const x of [-0.13, 0.13]) {
      mesh(fin, new THREE.BoxGeometry(0.05, 0.12, 0.022), colors.rubber, [x, -0.23, 0.015]);
    }
  }
  return group;
}

function tankHarness(group: THREE.Group, colors: ReturnType<typeof palette>, twin: boolean) {
  const plate = new THREE.Shape();
  plate.moveTo(-0.2, -0.64); plate.lineTo(-0.29, -0.5); plate.lineTo(-0.29, 0.48);
  plate.lineTo(-0.17, 0.61); plate.lineTo(0.17, 0.61); plate.lineTo(0.29, 0.48);
  plate.lineTo(0.29, -0.5); plate.lineTo(0.2, -0.64); plate.closePath();
  mesh(group, new THREE.ExtrudeGeometry(plate, { depth: 0.05, bevelEnabled: false }), colors.metal, [0, 0, -0.27], 'mounting-backplate');
  for (const side of [-1, 1]) {
    // Shoulder loop uses a flat extruded tape, with a true open middle.
    const strap = new THREE.Shape();
    const hole = new THREE.Path();
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * Math.PI * 2;
      const x = 0.04 + Math.cos(angle) * 0.22;
      const y = 0.08 + Math.sin(angle) * 0.44;
      if (i === 0) strap.moveTo(x, y); else strap.lineTo(x, y);
    }
    strap.closePath();
    for (let i = 0; i < 8; i++) {
      const angle = -i / 8 * Math.PI * 2;
      const x = 0.04 + Math.cos(angle) * 0.16;
      const y = 0.08 + Math.sin(angle) * 0.37;
      if (i === 0) hole.moveTo(x, y); else hole.lineTo(x, y);
    }
    hole.closePath();
    strap.holes.push(hole);
    const tape = mesh(group, new THREE.ExtrudeGeometry(strap, { depth: 0.045, bevelEnabled: false }), colors.rubber, [side * 0.26, 0.1, -0.14]);
    // Shape XY becomes YZ, leaving the band width along X.
    tape.rotation.y = Math.PI / 2;
    mesh(group, new THREE.BoxGeometry(0.09, 0.13, 0.06), colors.metal, [side * 0.29, -0.19, -0.04]);
  }
  solidBelt(group, twin ? 0.67 : 0.48, 0.29, -0.34, 0.09, colors.rubber);
  mesh(group, new THREE.BoxGeometry(0.15, 0.12, 0.07), colors.metal, [0, -0.34, 0.3], 'waist-buckle');
}

function bottle(group: THREE.Group, x: number, height: number, colors: ReturnType<typeof palette>) {
  const radius = 0.205;
  const bottom = -height / 2;
  const profile = [[0, bottom], [0.135, bottom], [radius, bottom + 0.08], [radius, height / 2 - 0.2], [0.13, height / 2 - 0.055], [0.061, height / 2], [0.061, height / 2 + 0.035], [0, height / 2 + 0.035]].map(([r, y]) => new THREE.Vector2(r, y));
  mesh(group, new THREE.LatheGeometry(profile, 8), colors.metal, [x, 0, 0.06], 'faceted-pressure-vessel');
  // A real base boot follows the lower cylinder, leaving a flat supported base.
  const bootProfile = [[0, bottom - 0.01], [radius + 0.01, bottom - 0.01], [radius + 0.018, bottom + 0.025], [radius + 0.018, bottom + 0.15], [radius, bottom + 0.15], [radius, bottom + 0.035], [0, bottom + 0.035]].map(([r, y]) => new THREE.Vector2(r, y));
  mesh(group, new THREE.LatheGeometry(bootProfile, 8), colors.rubber, [x, 0, 0.06], 'protective-flat-base-boot');
  for (const y of [-height * 0.27, height * 0.22]) {
    ring(group, radius + 0.01, 0.024, colors.rubber, [x, y, 0.06], 'y', 8);
    mesh(group, new THREE.BoxGeometry(0.075, 0.075, 0.03), colors.metal, [x, y, radius + 0.083], 'cylinder-band-buckle');
    mesh(group, new THREE.BoxGeometry(0.115, 0.07, 0.12), colors.rubber, [x, y, -0.19], 'cylinder-backplate-spacer');
  }
  mesh(group, new THREE.CylinderGeometry(0.059, 0.067, 0.085, 6), colors.metal, [x, height / 2 + 0.063, 0.06], 'bottle-neck');
  mesh(group, new THREE.BoxGeometry(0.21, 0.09, 0.1), colors.metal, [x, height / 2 + 0.14, 0.06], 'valve-block');
  const valve = mesh(group, new THREE.CylinderGeometry(0.055, 0.055, 0.065, 8), colors.rubber, [x + 0.13, height / 2 + 0.14, 0.06], 'valve-handwheel');
  valve.rotation.z = Math.PI / 2;
  cylinderZ(group, 0.075, 0.14, colors.rubber, [x, height / 2 + 0.14, 0.16], 8).name = 'first-stage-regulator';
  return height / 2 + 0.14;
}

export function buildTank(level: UpgradeLevel) {
  const group = new THREE.Group();
  group.name = `reserve-air-level-${level}`;
  const colors = palette(level);
  tankHarness(group, colors, level === 3);
  if (level === 1) {
    // Starting upgrade explicitly has no reserve air: only an empty carrier.
    for (const y of [-0.25, 0.29]) {
      const holder = ring(group, 0.222, 0.026, colors.rubber, [0, y, 0.06], 'y', 8);
      holder.name = 'empty-cylinder-clamp';
      mesh(group, new THREE.BoxGeometry(0.105, 0.085, 0.045), colors.metal, [0.19, y, 0.225], 'empty-clamp-buckle');
      mesh(group, new THREE.BoxGeometry(0.13, 0.06, 0.12), colors.metal, [0, y, -0.2]);
    }
    return group;
  }
  const height = level === 2 ? 1.3 : 1.56;
  const valveY = level === 2 ? bottle(group, 0, height, colors) : bottle(group, -0.232, height, colors);
  if (level === 3) {
    bottle(group, 0.232, height, colors);
    beam(group, [-0.232, valveY, 0.06], [0.232, valveY, 0.06], 0.033, colors.metal, 6).name = 'twin-valve-manifold';
    for (const y of [-0.38, 0.3]) beam(group, [-0.38, y, -0.14], [0.38, y, -0.14], 0.033, colors.metal, 8);
  }
  const hoseX = level === 2 ? 0 : 0.232;
  tube(group, [[hoseX, valveY, 0.21], [0.44, valveY + 0.025, 0.22], [0.68, valveY - 0.16, 0.21], [0.72, 0.25, 0.27], [0.64, -0.08, 0.37], [0.48, -0.09, 0.39]], 0.025, colors.rubber, 6).name = 'flexible-air-hose';
  cylinderZ(group, 0.105, 0.105, colors.rubber, [0.44, -0.1, 0.37], 8).name = 'second-stage-regulator';
  ring(group, 0.072, 0.01, colors.metal, [0.44, -0.1, 0.43], 'z', 8);
  cylinderZ(group, 0.048, 0.01, colors.rubber, [0.44, -0.1, 0.438], 8).name = 'purge-button';
  tube(group, [[0.42, -0.1, 0.32], [0.3, -0.08, 0.33], [0.28, -0.01, 0.36]], 0.03, colors.rubber, 6);
  const mouthpiece = ring(group, 0.04, 0.016, colors.rubber, [0.28, -0.01, 0.39], 'z', 8);
  mouthpiece.name = 'hollow-mouthpiece'; mouthpiece.scale.x = 1.6;
  for (const x of [0.24, 0.32]) mesh(group, new THREE.BoxGeometry(0.025, 0.022, 0.045), colors.rubber, [x, -0.01, 0.355], 'bite-tab');
  if (level === 3) {
    tube(group, [[-0.232, valveY, 0.2], [-0.48, 0.66, 0.23], [-0.59, 0.18, 0.24], [-0.62, -0.3, 0.29]], 0.022, colors.rubber, 6).name = 'pressure-gauge-hose';
    const dial = material('#e6e2cf', { roughness: 0.62 });
    cylinderZ(group, 0.13, 0.065, colors.rubber, [-0.62, -0.39, 0.29], 8).name = 'pressure-gauge-housing';
    cylinderZ(group, 0.103, 0.012, dial, [-0.62, -0.39, 0.329], 8);
    ring(group, 0.111, 0.012, colors.metal, [-0.62, -0.39, 0.34], 'z', 8);
    for (let i = 0; i < 9; i++) {
      const angle = -Math.PI * 0.75 + i * Math.PI * 1.5 / 8;
      const tick = mesh(group, new THREE.BoxGeometry(0.01, 0.021, 0.006), colors.rubber, [-0.62 + Math.sin(angle) * 0.081, -0.39 + Math.cos(angle) * 0.081, 0.338]);
      tick.rotation.z = -angle;
    }
    beam(group, [-0.62, -0.39, 0.34], [-0.65, -0.33, 0.34], 0.006, colors.accent, 4).name = 'pressure-needle';
    cylinderZ(group, 0.01, 0.01, colors.metal, [-0.62, -0.39, 0.345], 8);
  }
  return group;
}

function topHeadband(group: THREE.Group, surface: THREE.Material) {
  const curve = new THREE.CatmullRomCurve3([[0, 0.015, 0.43], [0, 0.29, 0.28], [0, 0.41, 0], [0, 0.29, -0.29], [0, 0.015, -0.43]].map((p) => new THREE.Vector3(...p)));
  const samples = curve.getPoints(8);
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]; const b = samples[i + 1];
    const tape = mesh(group, new THREE.BoxGeometry(0.065, 0.018, a.distanceTo(b) + 0.005), surface);
    tape.position.copy(a).add(b).multiplyScalar(0.5);
    tape.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
  }
}

function lampHead(group: THREE.Group, x: number, radius: number, depth: number, colors: ReturnType<typeof palette>, guard: boolean) {
  const z = 0.47;
  const front = z + depth;
  const housing = new THREE.Shape();
  const width = radius * 1.3;
  const height = radius * 1.12;
  const cut = radius * 0.3;
  const outline = [[-width + cut, -height], [width - cut, -height], [width, -height + cut], [width, height - cut], [width - cut, height], [-width + cut, height], [-width, height - cut], [-width, -height + cut]];
  outline.forEach(([px, py], i) => { if (i === 0) housing.moveTo(px, py); else housing.lineTo(px, py); });
  housing.closePath();
  const aperture = new THREE.Path();
  for (let i = 0; i < 8; i++) {
    const angle = -i * Math.PI / 4;
    const px = Math.cos(angle) * radius * 0.91;
    const py = Math.sin(angle) * radius * 0.91;
    if (i === 0) aperture.moveTo(px, py); else aperture.lineTo(px, py);
  }
  aperture.closePath();
  housing.holes.push(aperture);
  mesh(group, new THREE.ExtrudeGeometry(housing, { depth, bevelEnabled: false }), colors.rubber, [x, 0.015, z], 'compact-angular-lamp-housing');
  mesh(group, new THREE.BoxGeometry(width * 1.9, height * 1.9, 0.028), colors.rubber, [x, 0.015, z + 0.012], 'sealed-rear-housing');
  // Only three shoulder rings create broad reflector facets; no glowing bulb.
  const reflectorProfile = [[0.025, 0], [radius * 0.43, depth * 0.31], [radius * 0.87, depth * 0.77]].map(([r, y]) => new THREE.Vector2(r, y));
  const reflector = mesh(group, new THREE.LatheGeometry(reflectorProfile, 8), colors.metal, [x, 0.015, z + depth * 0.16], 'recessed-faceted-reflector');
  reflector.rotation.x = Math.PI / 2;
  reflector.material = colors.metal.clone();
  (reflector.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  const diode = material('#aa9d7d', { roughness: 0.83, emissive: '#000000', emissiveIntensity: 0 });
  mesh(group, new THREE.BoxGeometry(0.026, 0.026, 0.009), diode, [x, 0.015, z + depth * 0.18], 'unlit-led-chip');
  ring(group, radius * 0.91, 0.012, colors.rubber, [x, 0.015, front - 0.006], 'z', 8).name = 'flush-lens-seal';
  const glazing = new THREE.MeshPhysicalMaterial({ color: '#d3d8d3', flatShading: true, roughness: 0.29, metalness: 0, transparent: true, opacity: 0.22, transmission: 0.15, thickness: 0.008, emissive: '#000000', emissiveIntensity: 0, depthWrite: false });
  cylinderZ(group, radius * 0.84, 0.008, glazing, [x, 0.015, front - 0.013], 8).name = 'flat-protective-lens';
  if (guard) {
    ring(group, radius + 0.008, 0.014, colors.rubber, [x, 0.015, front + 0.004], 'z', 8).name = 'integrated-impact-guard';
  }
}

export function buildLamp(level: UpgradeLevel) {
  const group = new THREE.Group();
  group.name = `headlamp-level-${level}`;
  const colors = palette(level);
  solidBelt(group, 0.46, 0.43, 0.015, 0.075, colors.rubber);
  topHeadband(group, colors.rubber);
  mesh(group, new THREE.BoxGeometry(level === 3 ? 0.55 : 0.32, 0.135, 0.065), colors.rubber, [0, 0.015, 0.442], 'front-mount');
  if (level === 3) {
    lampHead(group, -0.138, 0.105, 0.16, colors, true);
    lampHead(group, 0.138, 0.1, 0.19, colors, true);
  } else lampHead(group, 0, level === 1 ? 0.115 : 0.14, level === 1 ? 0.14 : 0.17, colors, level === 2);
  mesh(group, new THREE.BoxGeometry(0.07, 0.024, 0.055), colors.rubber, [level === 3 ? -0.138 : 0, level === 3 ? 0.144 : level === 2 ? 0.184 : 0.155, 0.51], 'recessed-power-switch');
  const batteryWidth = [0.24, 0.28, 0.33][level - 1];
  const batteryDepth = [0.09, 0.11, 0.13][level - 1];
  const batteryZ = -0.455 - batteryDepth / 2;
  mesh(group, new THREE.BoxGeometry(batteryWidth + 0.025, 0.18, 0.04), colors.rubber, [0, 0.025, -0.44], 'rear-battery-mount');
  mesh(group, new THREE.BoxGeometry(batteryWidth, 0.165, batteryDepth), colors.rubber, [0, 0.025, batteryZ], 'sealed-rear-battery');
  mesh(group, new THREE.BoxGeometry(batteryWidth + 0.006, 0.026, batteryDepth + 0.004), colors.body, [0, -0.048, batteryZ], 'battery-cover-seam');
  tube(group, [[level === 3 ? 0.26 : 0.14, 0.04, 0.47], [0.39, 0.046, 0.26], [0.46, 0.047, 0], [0.36, 0.047, -0.27], [batteryWidth / 2, 0.04, -0.46]], 0.011, colors.rubber, 4).name = 'battery-power-cable';
  for (const side of [-1, 1]) {
    const buckle = new THREE.Shape();
    buckle.moveTo(-0.065, -0.057); buckle.lineTo(0.065, -0.057); buckle.lineTo(0.065, 0.057); buckle.lineTo(-0.065, 0.057); buckle.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.044, -0.035); hole.lineTo(-0.044, 0.035); hole.lineTo(0.044, 0.035); hole.lineTo(0.044, -0.035); hole.closePath();
    buckle.holes.push(hole);
    const adjuster = mesh(group, new THREE.ExtrudeGeometry(buckle, { depth: 0.028, bevelEnabled: false }), colors.rubber, [side * 0.445, 0.015, -0.06], 'open-strap-adjuster');
    adjuster.rotation.y = side * Math.PI / 2;
    mesh(group, new THREE.BoxGeometry(0.031, 0.092, 0.025), colors.rubber, [side * 0.455, 0.015, -0.06], 'adjuster-crossbar');
  }
  return group;
}

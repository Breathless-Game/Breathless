import * as THREE from 'three';
import { Rng } from './rng';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

export const RARITY: Record<
  Rarity,
  { label: string; color: string; speed: number; flee: number; emissive: number; value: number }
> = {
  common: { label: 'Common', color: '#b8c4cc', speed: 2.2, flee: 3.0, emissive: 0, value: 1 },
  uncommon: { label: 'Uncommon', color: '#5fd38d', speed: 2.8, flee: 3.6, emissive: 0, value: 3 },
  rare: { label: 'Rare', color: '#4aa8ff', speed: 3.4, flee: 4.4, emissive: 0.05, value: 10 },
  epic: { label: 'Epic', color: '#b46cff', speed: 4.2, flee: 5.2, emissive: 0.15, value: 35 },
  legendary: { label: 'Legendary', color: '#ffb340', speed: 5.0, flee: 6.0, emissive: 0.45, value: 150 },
  mythic: { label: 'Mythic', color: '#ff5fd2', speed: 5.8, flee: 7.0, emissive: 0.7, value: 800 },
};

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

// Deeper water = rarer fish, so how long you can really hold your breath is
// what gates the good catches.
export const ZONES = [
  {
    name: 'Shallows',
    top: 0,
    bottom: 18,
    odds: [['common', 70], ['uncommon', 25], ['rare', 5]] as [Rarity, number][],
  },
  {
    name: 'Coral Reef',
    top: 18,
    bottom: 38,
    odds: [['common', 20], ['uncommon', 35], ['rare', 30], ['epic', 13], ['legendary', 2]] as [Rarity, number][],
  },
  {
    name: 'The Abyss',
    top: 38,
    bottom: 58,
    odds: [['uncommon', 10], ['rare', 30], ['epic', 35], ['legendary', 19], ['mythic', 6]] as [Rarity, number][],
  },
] as const;

export type Zone = (typeof ZONES)[number];

type Archetype = 'slim' | 'perch' | 'disc' | 'long' | 'bulky';

const SHAPES: Record<Archetype, { len: number; height: number; width: number; tail: number; dorsal: number }> = {
  slim: { len: 1.5, height: 0.42, width: 0.28, tail: 0.45, dorsal: 0.25 },
  perch: { len: 1.3, height: 0.62, width: 0.34, tail: 0.5, dorsal: 0.35 },
  disc: { len: 1.0, height: 1.05, width: 0.24, tail: 0.45, dorsal: 0.45 },
  long: { len: 2.3, height: 0.4, width: 0.3, tail: 0.6, dorsal: 0.5 },
  bulky: { len: 1.8, height: 1.1, width: 0.6, tail: 0.75, dorsal: 0.4 },
};

const SPECIES: Record<Rarity, [string, Archetype][]> = {
  common: [['Sand Minnow', 'slim'], ['Grey Perch', 'perch'], ['Mud Goby', 'slim']],
  uncommon: [['Striped Wrasse', 'slim'], ['Coral Chromis', 'perch'], ['Silver Snapper', 'perch']],
  rare: [['Azure Tang', 'disc'], ['Neon Cardinal', 'slim'], ['Spotted Grouper', 'bulky']],
  epic: [['Violet Lionfish', 'perch'], ['Ember Triggerfish', 'disc'], ['Ghost Angelfish', 'disc']],
  legendary: [['Golden Koi Dragon', 'long'], ['Abyssal Sunfish', 'bulky'], ['Crowned Sailfish', 'long']],
  mythic: [['Moonfin Leviathan', 'long'], ['Prism Coelacanth', 'bulky']],
};

const EPITHETS: Record<Rarity, string[]> = {
  common: ['Plain', 'Dusty', 'Little', 'Shy'],
  uncommon: ['Banded', 'Lively', 'Bright', 'Speckled'],
  rare: ['Glimmering', 'Deepwater', 'Royal', 'Twilight'],
  epic: ['Phantom', 'Venomous', 'Storm', 'Midnight'],
  legendary: ['Sunforged', 'Ancient', 'Crowned', 'Gilded'],
  mythic: ['Prismatic', 'Eternal', 'Starborn'],
};

// Hue ranges per rarity: dull greys up top, saturated neon down deep.
const PALETTE: Record<Rarity, { hues: [number, number]; sat: [number, number]; light: [number, number] }> = {
  common: { hues: [20, 60], sat: [0.08, 0.25], light: [0.45, 0.6] },
  uncommon: { hues: [90, 170], sat: [0.35, 0.55], light: [0.45, 0.55] },
  rare: { hues: [185, 225], sat: [0.65, 0.85], light: [0.5, 0.6] },
  epic: { hues: [265, 330], sat: [0.6, 0.85], light: [0.5, 0.6] },
  legendary: { hues: [30, 48], sat: [0.85, 1], light: [0.52, 0.6] },
  mythic: { hues: [0, 360], sat: [0.8, 1], light: [0.6, 0.7] },
};

export interface FishSpec {
  id: string;
  seed: number;
  rarity: Rarity;
  species: string;
  name: string;
  archetype: Archetype;
  lengthCm: number;
  weightKg: number;
  depthM: number;
  hue: number;
  sat: number;
  light: number;
  accentHue: number;
  stripes: number;
  scale: number;
  /** Metaplex Core asset address once minted on devnet. */
  assetId?: string;
}

export function rollFish(seed: number, zone: Zone, depthM: number): FishSpec {
  const rng = new Rng(seed);
  const rarity = rng.weighted(zone.odds);
  const [species, archetype] = rng.pick(SPECIES[rarity]);
  const pal = PALETTE[rarity];
  const hue = rng.range(...pal.hues);
  const rarityIdx = RARITY_ORDER.indexOf(rarity);
  const scale = rng.range(0.85, 1.25) * (1 + rarityIdx * 0.12);
  const lengthCm = Math.round(SHAPES[archetype].len * scale * 28);
  const weightKg = +(Math.pow(lengthCm / 30, 3) * SHAPES[archetype].height * rng.range(0.7, 1.1)).toFixed(2);
  return {
    id: seed.toString(16).padStart(8, '0'),
    seed,
    rarity,
    species,
    name: `${rng.pick(EPITHETS[rarity])} ${species}`,
    archetype,
    lengthCm,
    weightKg,
    depthM: Math.round(depthM),
    hue,
    sat: rng.range(...pal.sat),
    light: rng.range(...pal.light),
    accentHue: (hue + rng.range(140, 220)) % 360,
    stripes: rng.next() < 0.55 ? rng.int(2, 5) : 0,
    scale,
  };
}

// ---- Mesh ---------------------------------------------------------------

function hsl(h: number, s: number, l: number): THREE.Color {
  return new THREE.Color().setHSL(((h % 360) + 360) % 360 / 360, s, l);
}

/** Flat-shaded triangle soup with one colour per face: the low-poly look. */
class FaceBuilder {
  pos: number[] = [];
  col: number[] = [];

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

export interface FishMesh {
  group: THREE.Group;
  tail: THREE.Object3D;
  material: THREE.MeshStandardMaterial;
}

export function buildFishMesh(spec: FishSpec): FishMesh {
  const shape = SHAPES[spec.archetype];
  const L = shape.len;
  const body = hsl(spec.hue, spec.sat, spec.light);
  const back = hsl(spec.hue, spec.sat, spec.light * 0.7);
  const belly = hsl(spec.hue, spec.sat * 0.5, Math.min(0.92, spec.light * 1.45));
  const accent = hsl(spec.accentHue, Math.min(1, spec.sat + 0.2), 0.55);
  const fin = hsl(spec.hue + 15, spec.sat, spec.light * 0.85);

  // Body: hexagonal rings from tail root (t=0) to nose (t=1).
  const RINGS = 6;
  const SIDES = 6;
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const x = -L / 2 + t * L;
    const profile = Math.sin(Math.PI * Math.pow(t, 0.75)) * 0.92 + 0.08;
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < SIDES; j++) {
      const a = (j / SIDES) * Math.PI * 2 + Math.PI / 2;
      ring.push(new THREE.Vector3(x, Math.sin(a) * shape.height * 0.5 * profile, Math.cos(a) * shape.width * 0.5 * profile));
    }
    rings.push(ring);
  }
  const fb = new FaceBuilder();
  for (let i = 0; i < RINGS; i++) {
    const striped = spec.stripes > 0 && i > 0 && i < RINGS - 1 && i % 2 === (spec.stripes % 2);
    for (let j = 0; j < SIDES; j++) {
      const a = rings[i][j];
      const b = rings[i][(j + 1) % SIDES];
      const c = rings[i + 1][(j + 1) % SIDES];
      const d = rings[i + 1][j];
      const midY = (a.y + b.y + c.y + d.y) / 4;
      let color = midY > shape.height * 0.12 ? back : midY < -shape.height * 0.12 ? belly : body;
      if (striped && midY > -shape.height * 0.2) color = accent;
      fb.tri(a, c, b, color);
      fb.tri(a, d, c, color);
    }
  }
  // Cap the nose and tail root.
  const nose = new THREE.Vector3(L / 2 + 0.06, 0, 0);
  const root = new THREE.Vector3(-L / 2, 0, 0);
  for (let j = 0; j < SIDES; j++) {
    fb.tri(rings[RINGS][j], rings[RINGS][(j + 1) % SIDES], nose, body);
    fb.tri(rings[0][(j + 1) % SIDES], rings[0][j], root, back);
  }
  // Dorsal fin.
  const dorsalBase = rings[3][0].y;
  const d1 = new THREE.Vector3(-L * 0.15, dorsalBase - 0.02, 0);
  const d2 = new THREE.Vector3(L * 0.2, dorsalBase - 0.02, 0);
  const d3 = new THREE.Vector3(-L * 0.12, dorsalBase + shape.dorsal, 0);
  fb.tri(d1, d2, d3, spec.stripes ? accent : fin);
  fb.tri(d2, d1, d3, spec.stripes ? accent : fin);
  // Pectoral fins.
  for (const side of [1, -1]) {
    const p1 = new THREE.Vector3(L * 0.15, -shape.height * 0.1, side * shape.width * 0.45);
    const p2 = new THREE.Vector3(L * 0.0, -shape.height * 0.25, side * (shape.width * 0.45 + 0.22));
    const p3 = new THREE.Vector3(-L * 0.05, -shape.height * 0.05, side * shape.width * 0.45);
    fb.tri(p1, p2, p3, fin);
    fb.tri(p2, p1, p3, fin);
  }

  const emissive = RARITY[spec.rarity].emissive;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.55,
    metalness: spec.rarity === 'legendary' ? 0.45 : 0.1,
    emissive: hsl(spec.hue, 1, 0.5),
    emissiveIntensity: emissive,
    side: THREE.DoubleSide,
  });
  const bodyMesh = new THREE.Mesh(fb.build(), material);

  // Tail on its own pivot so it can wag.
  const tb = new FaceBuilder();
  const tl = shape.tail;
  const t0 = new THREE.Vector3(0, 0, 0);
  const tUp = new THREE.Vector3(-tl, tl * 0.75, 0);
  const tMid = new THREE.Vector3(-tl * 0.6, 0, 0);
  const tDown = new THREE.Vector3(-tl, -tl * 0.75, 0);
  const tailColor = spec.stripes ? accent : fin;
  tb.tri(t0, tMid, tUp, tailColor);
  tb.tri(t0, tUp, tMid, tailColor);
  tb.tri(t0, tDown, tMid, tailColor);
  tb.tri(t0, tMid, tDown, tailColor);
  const tail = new THREE.Mesh(tb.build(), material);
  tail.position.x = -L / 2 + 0.02;

  // Eyes.
  const eyeGeo = new THREE.IcosahedronGeometry(Math.max(0.05, shape.height * 0.09), 0);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0b0b12, flatShading: true, roughness: 0.2 });
  const group = new THREE.Group();
  for (const side of [1, -1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(L * 0.33, shape.height * 0.1, side * shape.width * 0.33);
    group.add(eye);
  }
  group.add(bodyMesh, tail);
  group.scale.setScalar(spec.scale);
  return { group, tail, material };
}

// ---- Behaviour ----------------------------------------------------------

export class Fish {
  spec: FishSpec;
  mesh: FishMesh;
  pos: THREE.Vector3;
  vel = new THREE.Vector3();
  target = new THREE.Vector3();
  zone: Zone;
  facing = 1;
  phase: number;
  private rng: Rng;

  constructor(spec: FishSpec, zone: Zone, x: number, y: number, worldHalfWidth: number) {
    this.spec = spec;
    this.zone = zone;
    this.mesh = buildFishMesh(spec);
    this.rng = new Rng(spec.seed ^ 0xabcdef);
    this.pos = new THREE.Vector3(x, y, this.rng.range(-4, 2));
    this.phase = this.rng.range(0, Math.PI * 2);
    this.halfWidth = worldHalfWidth;
    this.pickTarget();
    this.mesh.group.position.copy(this.pos);
  }

  private halfWidth: number;

  private pickTarget() {
    const span = 18;
    this.target.set(
      THREE.MathUtils.clamp(this.pos.x + this.rng.range(-span, span), -this.halfWidth, this.halfWidth),
      -this.rng.range(this.zone.top + 1.5, this.zone.bottom - 0.5),
      this.rng.range(-4, 2),
    );
  }

  update(dt: number, time: number, diverPos: THREE.Vector3) {
    const r = RARITY[this.spec.rarity];
    const toDiver = this.pos.clone().sub(diverPos);
    toDiver.z = 0;
    const dist = toDiver.length();
    let speed = r.speed;
    const desired = new THREE.Vector3();
    if (dist < r.flee) {
      // Flee, harder the closer the diver gets.
      desired.copy(toDiver.normalize()).multiplyScalar(speed * (1.6 + (r.flee - dist) / r.flee));
    } else {
      const toTarget = this.target.clone().sub(this.pos);
      if (toTarget.length() < 1.5) this.pickTarget();
      desired.copy(toTarget.normalize()).multiplyScalar(speed * 0.55);
    }
    this.vel.lerp(desired, Math.min(1, dt * 2.5));
    this.pos.addScaledVector(this.vel, dt);
    // Stay inside the zone band (fish can be chased a little out of it).
    const top = -(this.zone.top + 0.5);
    const bottom = -(this.zone.bottom + 3);
    this.pos.y = THREE.MathUtils.clamp(this.pos.y, bottom, top);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -this.halfWidth, this.halfWidth);

    if (Math.abs(this.vel.x) > 0.15) this.facing = this.vel.x > 0 ? 1 : -1;
    const g = this.mesh.group;
    g.position.copy(this.pos);
    const targetYaw = this.facing > 0 ? 0 : Math.PI;
    g.rotation.y += (targetYaw - g.rotation.y) * Math.min(1, dt * 6);
    g.rotation.z = THREE.MathUtils.clamp(this.vel.y * 0.12, -0.5, 0.5) * this.facing;
    const wag = 6 + this.vel.length() * 2.5;
    this.mesh.tail.rotation.y = Math.sin(time * wag + this.phase) * 0.5;
    if (this.spec.rarity === 'mythic') {
      this.mesh.material.emissive.setHSL((time * 0.15 + this.phase) % 1, 1, 0.5);
    }
  }
}

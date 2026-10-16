import * as THREE from 'three';
import { buildFishMesh, disposeFishMesh, isGene, type Archetype, type FishMesh, type FishSpec, type Rarity } from './fish';

// The fish on the NFT card, shared by the game (portrait.ts fishCard, drawn with WebGL) and the
// server (sensor/fish-png.mjs, a software rasteriser in Node). One mesh builder, one pose, one
// camera, one set of lights: the server's copy is this file bundled by
// game/scripts/build-fish-card.mjs into sensor/fish-card.gen.mjs, and game/tests/fish-card.test.mjs
// fails when that bundle is out of date. Nothing here touches the DOM.

/** Bump when the card art changes on purpose: the NFT image URL carries it, so caches let go. */
export const CARD_RENDER_VERSION = 3;

/** Where the fish's square render sits on the 512px card (portrait.ts drawImage). */
export const CARD_FISH = { x: 46, y: 40, size: 420 } as const;

/** The card's lights, as portrait.ts builds them. Directions point from the origin to the light. */
export const CARD_LIGHTS = {
  hemi: { sky: '#ffffff', ground: '#33415c', intensity: 1.6 },
  dirs: [
    { color: '#ffffff', intensity: 2.6, position: [2, 3, 4] as const },
    { color: '#9fe8ff', intensity: 1.4, position: [-3, 1, -2] as const },
  ],
} as const;

export const CARD_FOV = 30;

/** The facts a card is drawn from: exactly what the NFT image URL carries (nft-uri.ts fishImagePath). */
export interface CardFacts {
  id: string;
  rarity: Rarity;
  species: string;
  archetype: Archetype;
  hue: number;
  sat: number;
  light: number;
  accentHue: number;
  stripes: number;
  /** The shape gene, when the look has one (seven fields); otherwise the species' standard shape. */
  gene?: string;
}

// The URL's rounding (nft-uri.ts fishLook), so the game and the server feed identical numbers.
const deg = (x: number) => Math.round(((x % 360) + 360) % 360) % 360;
const pct = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
const nat = (x: number, max: number) => Math.min(max, Math.max(0, Math.round(Number(x) || 0)));

/**
 * The spec the card's fish is built from. Size (scale) does not show: the camera frames the fish's
 * bounds. The seed comes from the id, as the shards and the marine creatures' grain use it. The gene
 * is exact (the URL carries all its digits); no `gene` key without one.
 */
export function cardSpec(f: CardFacts): FishSpec {
  const spec: FishSpec = {
    id: f.id,
    seed: Number.parseInt(f.id.slice(-8), 16) >>> 0,
    rarity: f.rarity,
    species: f.species,
    name: f.species,
    archetype: f.archetype,
    lengthCm: 0,
    weightKg: 0,
    depthM: 0,
    hue: deg(f.hue),
    sat: pct(f.sat),
    light: pct(f.light),
    accentHue: deg(f.accentHue),
    stripes: nat(f.stripes, 9),
    scale: 1,
  };
  if (isGene(f.gene)) spec.gene = f.gene;
  return spec;
}

/** Pose a fish as on the card and aim the camera at it (portrait.ts drawFish). */
export function poseCardFish(fish: FishMesh, camera: THREE.PerspectiveCamera): void {
  fish.group.scale.setScalar(1);
  fish.group.rotation.set(0, -0.55, 0.08);
  fish.tail.rotation.y = 0.25;
  fish.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(fish.group);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 0.95;
  camera.position.set(center.x + dist * 0.25, center.y + dist * 0.18, center.z + dist);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
}

export function disposeFish(fish: FishMesh): void {
  disposeFishMesh(fish);
}

/** One visible triangle: screen points (0..1, y down) with NDC depth, and its lit colour in linear RGB. */
export interface CardFace {
  p: [number, number, number, number, number, number, number, number, number];
  rgb: [number, number, number];
}

const linear = (hex: string) => new THREE.Color(hex);
const RECIPROCAL_PI = 1 / Math.PI;

/**
 * The card's fish as flat-shaded triangles, lit like three.js r170 lights a rough
 * MeshStandardMaterial (diffuse only: albedo/π × irradiance, plus emissive). Face culling follows
 * each material's `side`; a double-sided face is lit from the side the camera sees.
 */
export function cardGeometry(spec: FishSpec): CardFace[] {
  const camera = new THREE.PerspectiveCamera(CARD_FOV, 1, 0.1, 100);
  const fish = buildFishMesh(spec);
  poseCardFish(fish, camera);
  const sky = linear(CARD_LIGHTS.hemi.sky);
  const ground = linear(CARD_LIGHTS.hemi.ground);
  const dirs = CARD_LIGHTS.dirs.map((d) => ({
    color: linear(d.color).multiplyScalar(d.intensity),
    dir: new THREE.Vector3(d.position[0], d.position[1], d.position[2]).normalize(),
  }));
  const faces: CardFace[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  fish.group.traverseVisible((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const material = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.MeshStandardMaterial;
    if (!material || material.visible === false) return;
    const geo = o.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const col = material.vertexColors ? geo.getAttribute('color') : undefined;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const base = material.color ?? new THREE.Color(1, 1, 1);
    const emissive = material.emissive ? material.emissive.clone().multiplyScalar(material.emissiveIntensity ?? 1) : new THREE.Color(0, 0, 0);
    for (let i = 0; i + 2 < count; i += 3) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
      ids.forEach((id, k) => v[k].fromBufferAttribute(pos, id).applyMatrix4(o.matrixWorld));
      n.crossVectors(e1.subVectors(v[1], v[0]), e2.subVectors(v[2], v[0]));
      if (n.lengthSq() < 1e-20) continue;
      n.normalize();
      toCam.copy(camera.position).sub(v[0]);
      const front = n.dot(toCam) > 0;
      if ((material.side === THREE.FrontSide && !front) || (material.side === THREE.BackSide && front)) continue;
      if (!front) n.negate();
      // Albedo: material colour × the face's mean vertex colour.
      let r = base.r;
      let g = base.g;
      let b = base.b;
      if (col) {
        let cr = 0;
        let cg = 0;
        let cb = 0;
        for (const id of ids) {
          cr += col.getX(id);
          cg += col.getY(id);
          cb += col.getZ(id);
        }
        r *= cr / 3;
        g *= cg / 3;
        b *= cb / 3;
      }
      const w = 0.5 * n.y + 0.5;
      let ir = (ground.r + (sky.r - ground.r) * w) * CARD_LIGHTS.hemi.intensity;
      let ig = (ground.g + (sky.g - ground.g) * w) * CARD_LIGHTS.hemi.intensity;
      let ib = (ground.b + (sky.b - ground.b) * w) * CARD_LIGHTS.hemi.intensity;
      for (const d of dirs) {
        const k = Math.max(0, n.dot(d.dir));
        ir += d.color.r * k;
        ig += d.color.g * k;
        ib += d.color.b * k;
      }
      const p = [] as unknown as CardFace['p'];
      for (let k = 0; k < 3; k++) {
        ndc.copy(v[k]).project(camera);
        p[k * 3] = (ndc.x + 1) / 2;
        p[k * 3 + 1] = (1 - ndc.y) / 2;
        p[k * 3 + 2] = ndc.z;
      }
      faces.push({
        p,
        rgb: [r * RECIPROCAL_PI * ir + emissive.r, g * RECIPROCAL_PI * ig + emissive.g, b * RECIPROCAL_PI * ib + emissive.b],
      });
    }
  });
  disposeFish(fish);
  return faces;
}

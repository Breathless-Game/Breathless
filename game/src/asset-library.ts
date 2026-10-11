import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import fishingNetGlbUrl from '../../assets/gear/fishing-net-faceted.glb?url';
import fishingNetPreviewUrl from '../../assets/gear/fishing-net-faceted-preview.png?url';
import { RARITY_BY_DEPTH } from './depth-odds';
import { RARITY, RARITY_ORDER, rollFish, speciesProfile, type FishSpec, type SpeciesProfile } from './fish';
import { buildFishingNetMesh } from './gear';
import { fishCard, fishSprite } from './portrait';

// Dev-only page (http://localhost:5173/asset-library.html). It draws every fish
// species and the fishing rod with the same builders the game uses, so the
// previews in /assets can be regenerated after a model change. See
// assets/README.md.

const SPRITE_PX = 512;
// A portrait render leaves a wide margin around the fish. Keep this much of the
// frame, from the centre, so the fish fills the sprite.
const FRAME = 0.68;
// The species whose NFT card is kept in assets/cards as the example.
const CARD_EXAMPLE = 'moonfin-leviathan';
// Rarity depends only on depth. Past the deepest anchor in depth-odds.ts (350 m)
// the odds stop changing and every rarity can roll, mythic included.
const SAMPLE_DEPTH = RARITY_BY_DEPTH[RARITY_BY_DEPTH.length - 1][0];

interface Specimen {
  slug: string;
  spec: FishSpec;
  profile: SpeciesProfile;
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** The lowest seed that rolls each species at SAMPLE_DEPTH. Striped species wait for a roll that has stripes. */
function findSpecimens(): Specimen[] {
  const found = new Map<string, Specimen>();
  for (let seed = 1; seed <= 4000; seed++) {
    const spec = rollFish(seed, SAMPLE_DEPTH);
    if (found.has(spec.species)) continue;
    const profile = speciesProfile(spec);
    if (profile.pattern === 'stripes' && spec.stripes === 0) continue;
    found.set(spec.species, { slug: slugOf(spec.species), spec, profile });
  }
  return [...found.values()].sort(
    (a, b) =>
      RARITY_ORDER.indexOf(a.spec.rarity) - RARITY_ORDER.indexOf(b.spec.rarity) ||
      a.spec.species.localeCompare(b.spec.species),
  );
}

/** Transparent sprite of one fish, cropped to the fish. */
async function sprite(spec: FishSpec, px = SPRITE_PX): Promise<string> {
  const full = Math.round(px / FRAME);
  const img = new Image();
  img.src = fishSprite(spec, full);
  await img.decode();
  const out = document.createElement('canvas');
  out.width = px;
  out.height = px;
  const offset = (full - px) / 2;
  out.getContext('2d')!.drawImage(img, -offset, -offset);
  return out.toDataURL('image/png');
}

/** The net on its own, three-quarter view. `backdrop` bakes in dark water so the pale web stays readable. */
function netSprite(width: number, height: number, backdrop: boolean): string {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const environment = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(environment);
  scene.environment = envTarget.texture;
  scene.add(new THREE.HemisphereLight('#ffffff', '#33415c', 1.6));
  const key = new THREE.DirectionalLight('#ffffff', 2.6);
  key.position.set(2, 3, 4);
  scene.add(key);

  const net = buildFishingNetMesh().group;
  net.rotation.set(0.32, -0.62, 0);
  scene.add(net);
  const box = new THREE.Box3().setFromObject(net);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const halfH = Math.max(size.y, size.x * (height / width)) * 0.56;
  const halfW = halfH * (width / height);
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 50);
  camera.position.set(center.x, center.y, center.z + 10);
  camera.lookAt(center);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  if (backdrop) {
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#12456a');
    bg.addColorStop(1, '#071a30');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(renderer.domElement, 0, 0);
  envTarget.dispose();
  environment.dispose();
  pmrem.dispose();
  net.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
  renderer.dispose();
  return out.toDataURL('image/png');
}

const specimens = findSpecimens();

function tile(title: string, lines: string[], src: string, file: string): HTMLElement {
  const el = document.createElement('figure');
  const img = document.createElement('img');
  img.src = src;
  img.alt = title;
  const cap = document.createElement('figcaption');
  const name = document.createElement('b');
  name.textContent = title;
  cap.append(name);
  for (const line of lines) {
    const row = document.createElement('span');
    row.textContent = line;
    cap.append(row);
  }
  const link = document.createElement('a');
  link.href = src;
  link.download = file;
  link.textContent = `↓ ${file}`;
  cap.append(link);
  el.append(img, cap);
  return el;
}

async function main() {
  const fishGrid = document.getElementById('fish')!;
  for (const s of specimens) {
    const r = RARITY[s.spec.rarity];
    const el = tile(
      s.spec.species,
      [`${r.label} · ${s.profile.archetype} · ${s.profile.pattern}`, `seed ${s.spec.seed} · ${s.spec.depthM} m`],
      await sprite(s.spec),
      `${s.slug}.png`,
    );
    el.style.setProperty('--rarity', r.color);
    fishGrid.append(el);
  }

  document.getElementById('gear')!.append(
    tile('Fishing rod', ['buildFishingNetMesh()', 'transparent'], netSprite(1024, 512, false), 'fishing-net.png'),
    tile('Fishing rod', ['buildFishingNetMesh()', 'on dark water'], netSprite(1024, 512, true), 'fishing-net-dark.png'),
  );
  const faceted = tile('Faceted 3D fishing net', ['Lv1 · PBR · per-face normals', 'Reusable GLB model and rendered review'], fishingNetPreviewUrl, 'fishing-net-faceted-preview.png');
  const glbLink = document.createElement('a');
  glbLink.href = fishingNetGlbUrl;
  glbLink.download = 'fishing-net-faceted.glb';
  glbLink.textContent = '↓ fishing-net-faceted.glb';
  const previewLink = document.createElement('a');
  previewLink.href = './gear-preview.html';
  previewLink.textContent = 'Rotate model / preview Lv1–Lv3';
  faceted.querySelector('figcaption')!.append(glbLink, previewLink);
  document.getElementById('gear')!.append(faceted);

  const example = specimens.find((s) => s.slug === CARD_EXAMPLE);
  if (example) {
    document.getElementById('cards')!.append(
      tile(example.spec.name, ['fishCard(spec)', `seed ${example.spec.seed} · ${example.spec.depthM} m`], fishCard(example.spec), `${example.slug}.png`),
    );
  }
}

// For scripted export from the console.
Object.assign(window, {
  assetLibrary: {
    specimens,
    sprite: (slug: string, px?: number) => sprite(specimens.find((s) => s.slug === slug)!.spec, px),
    card: (slug: string) => fishCard(specimens.find((s) => s.slug === slug)!.spec),
    net: netSprite,
  },
});

void main();

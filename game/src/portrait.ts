import * as THREE from 'three';
import { buildFishMesh, FishSpec, RARITY } from './fish';
import { formatSerial, isSerial, type Numbered } from './nft-uri';
import { t } from './i18n';
import { CARD_FISH, CARD_FOV, CARD_LIGHTS, cardSpec, disposeFish, poseCardFish } from './fish-card-geometry';

// One small offscreen renderer that draws a fish on demand. The 512px card is
// the NFT image: it is a pure function of the fish seed, so anyone can
// re-render it and check it matches. The card's fish, pose, camera and lights
// come from fish-card-geometry.ts, which the server's NFT image uses too.

let renderer: THREE.WebGLRenderer | null = null;
const iconCache = new Map<string, string>();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CARD_FOV, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(CARD_LIGHTS.hemi.sky, CARD_LIGHTS.hemi.ground, CARD_LIGHTS.hemi.intensity));
for (const d of CARD_LIGHTS.dirs) {
  const light = new THREE.DirectionalLight(d.color, d.intensity);
  light.position.set(d.position[0], d.position[1], d.position[2]);
  scene.add(light);
}

/** True while the shared renderer's context is gone; nothing it draws then may be cached. */
function contextLost(r: THREE.WebGLRenderer | null): boolean {
  return !!r && r.getContext().isContextLost();
}

function dropRenderer() {
  if (!renderer) return;
  renderer.dispose();
  renderer = null;
}

function getRenderer(size: number) {
  // The browser can take the context away (too many live WebGL contexts): build a fresh one.
  if (contextLost(renderer)) dropRenderer();
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    // Icons cached around a loss may be blank: forget them so they re-render.
    renderer.domElement.addEventListener('webglcontextlost', () => iconCache.clear());
  }
  renderer.setSize(size, size, false);
  return renderer;
}

function renderFish(spec: FishSpec, size: number): HTMLCanvasElement {
  let r = getRenderer(size);
  drawFish(r, spec);
  // Lost mid-draw: one retry on a fresh context, so the image is not blank.
  if (contextLost(r)) {
    dropRenderer();
    r = getRenderer(size);
    drawFish(r, spec);
  }
  return r.domElement;
}

function drawFish(r: THREE.WebGLRenderer, spec: FishSpec) {
  const fish = buildFishMesh(spec);
  scene.add(fish.group);
  poseCardFish(fish, camera);
  r.setClearColor(0x000000, 0);
  r.render(scene, camera);
  scene.remove(fish.group);
  disposeFish(fish);
}

/** Transparent render at any size, for UI sprites. Not cached: call once and keep the result. */
export function fishSprite(spec: FishSpec, size: number): string {
  return renderFish(spec, size).toDataURL('image/png');
}

export function fishIcon(spec: FishSpec): string {
  const hit = iconCache.get(spec.id);
  if (hit) return hit;
  const url = renderFish(spec, 192).toDataURL('image/png');
  // Never cache a render from a lost context: it is fully transparent.
  if (!contextLost(renderer)) iconCache.set(spec.id, url);
  return url;
}

/** Full NFT card art: rarity backdrop, low-poly shards, the fish, its stats, and its number once it has one. */
export function fishCard(spec: FishSpec & Numbered): string {
  const S = 512;
  const out = document.createElement('canvas');
  out.width = S;
  out.height = S;
  const ctx = out.getContext('2d')!;
  const rc = RARITY[spec.rarity].color;
  const bg = ctx.createRadialGradient(S / 2, S * 0.42, 20, S / 2, S / 2, S * 0.75);
  bg.addColorStop(0, rc);
  bg.addColorStop(0.55, '#0d2a44');
  bg.addColorStop(1, '#050d1c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);
  // Polygon shards, seeded by the fish so the card is reproducible.
  let s = spec.seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + rand() * 0.05})`;
    ctx.beginPath();
    const cx = rand() * S;
    const cy = rand() * S;
    const rr = 30 + rand() * 90;
    for (let k = 0; k < 3; k++) {
      const a = rand() * Math.PI * 2;
      ctx[k ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.fill();
  }
  // The fish from the same facts, rounded the same way, as the NFT image URL gives the server.
  ctx.drawImage(renderFish(cardSpec(spec), CARD_FISH.size), CARD_FISH.x, CARD_FISH.y, CARD_FISH.size, CARD_FISH.size);
  ctx.fillStyle = 'rgba(5,13,28,0.72)';
  ctx.fillRect(0, S - 92, S, 92);
  ctx.fillStyle = rc;
  ctx.font = '700 15px "Inter", system-ui, sans-serif';
  ctx.fillText(RARITY[spec.rarity].label.toUpperCase(), 24, S - 62);
  if (isSerial(spec.serial)) {
    // The fish's number, small and dimmed, across from the rarity.
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '600 15px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(formatSerial(spec.serial), S - 24, S - 62);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 26px "Inter", system-ui, sans-serif';
  ctx.fillText(spec.name, 24, S - 32);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '500 14px "Inter", system-ui, sans-serif';
  ctx.fillText(`${spec.lengthCm} cm · ${spec.weightKg} kg · ${t('caught at', '捕获深度')} ${spec.depthM} m · ${t('seed', '种子')} ${spec.id}`, 24, S - 12);
  ctx.strokeStyle = rc;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, S - 6, S - 6);
  return out.toDataURL('image/png');
}

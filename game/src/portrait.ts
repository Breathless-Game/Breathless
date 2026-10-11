import * as THREE from 'three';
import { buildFishMesh, FishSpec, RARITY } from './fish';
import { formatSerial, isSerial, type Numbered } from './nft-uri';
import { t } from './i18n';

// One small offscreen renderer that draws a fish on demand. The 512px card is
// the NFT image: it is a pure function of the fish seed, so anyone can
// re-render it and check it matches.

let renderer: THREE.WebGLRenderer | null = null;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight('#ffffff', '#33415c', 1.6));
const key = new THREE.DirectionalLight('#ffffff', 2.6);
key.position.set(2, 3, 4);
const rim = new THREE.DirectionalLight('#9fe8ff', 1.4);
rim.position.set(-3, 1, -2);
scene.add(key, rim);

function getRenderer(size: number) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
  }
  renderer.setSize(size, size, false);
  return renderer;
}

function renderFish(spec: FishSpec, size: number): HTMLCanvasElement {
  const r = getRenderer(size);
  const fish = buildFishMesh(spec);
  fish.group.scale.setScalar(1);
  fish.group.rotation.set(0, -0.55, 0.08);
  fish.tail.rotation.y = 0.25;
  scene.add(fish.group);
  const box = new THREE.Box3().setFromObject(fish.group);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.95;
  camera.position.set(center.x + dist * 0.25, center.y + dist * 0.18, center.z + dist);
  camera.lookAt(center);
  r.setClearColor(0x000000, 0);
  r.render(scene, camera);
  scene.remove(fish.group);
  fish.group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  fish.material.dispose();
  return r.domElement;
}

/** Transparent render at any size, for UI sprites. Not cached: call once and keep the result. */
export function fishSprite(spec: FishSpec, size: number): string {
  return renderFish(spec, size).toDataURL('image/png');
}

const iconCache = new Map<string, string>();

export function fishIcon(spec: FishSpec): string {
  const hit = iconCache.get(spec.id);
  if (hit) return hit;
  const url = renderFish(spec, 192).toDataURL('image/png');
  iconCache.set(spec.id, url);
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
  ctx.drawImage(renderFish(spec, 420), 46, 40, 420, 420);
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

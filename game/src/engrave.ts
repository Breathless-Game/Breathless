import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import type { FishMesh } from './fish';

// A name carved into a fish's flank, for the title's menu fish. A decal is
// projected onto the body's +z side (the one the sprite camera sees) and painted
// as grooves cut into the surface, lit from above: dark inside, the upper inner
// rim in shadow, the lower inner rim catching light, and a thin bright lip just
// above each letter where the cut edge meets the light. A blurred height map
// (bump) lets the scene's lights pick out the groove edges as well.

const FONT_PX = 160;
const TEX_H = 256;
const LETTER_SPACING = 0.06; // em
const CJK_PX = 200;
const CJK_TEX_H = 320;

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
const CJK_FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", "Source Han Sans SC", sans-serif';

function font(px: number, cjk: boolean) {
  return cjk ? `900 ${px}px ${CJK_FONT}` : `900 ${px}px Inter, system-ui, sans-serif`;
}

/** Text drawing setup shared by every layer of the texture. */
function prep(c: CanvasRenderingContext2D, cjk = false) {
  c.font = font(cjk ? CJK_PX : FONT_PX, cjk);
  c.letterSpacing = `${cjk ? 0.04 : LETTER_SPACING}em`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
}

/** The letters minus a copy of them shifted by dy, filled with `color`: a rim along one side. */
function rim(label: string, w: number, dy: number, color: string) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = TEX_H;
  const c = cv.getContext('2d')!;
  prep(c);
  c.fillStyle = '#fff';
  c.fillText(label, w / 2, TEX_H / 2);
  c.globalCompositeOperation = 'destination-out';
  c.fillText(label, w / 2, TEX_H / 2 + dy);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = color;
  c.fillRect(0, 0, w, TEX_H);
  return cv;
}

/**
 * Chinese labels: thin engraved strokes smear into the body colour, so paint them
 * as solid dark ink with a light halo (high contrast, like the English cut) and a
 * gentle bump only. Textures are larger, as the glyphs are drawn bigger.
 */
function cjkCarving(label: string) {
  const H = CJK_TEX_H;
  const probe = document.createElement('canvas').getContext('2d')!;
  prep(probe, true);
  const w = Math.ceil(probe.measureText(label).width + CJK_PX * 0.5);
  const color = document.createElement('canvas');
  color.width = w;
  color.height = H;
  const c = color.getContext('2d')!;
  prep(c, true);
  c.lineJoin = 'round';
  c.lineWidth = CJK_PX * 0.13;
  c.strokeStyle = 'rgba(255, 246, 225, 0.92)';
  c.strokeText(label, w / 2, H / 2);
  c.fillStyle = 'rgba(22, 14, 12, 0.97)';
  c.fillText(label, w / 2, H / 2);
  const height = document.createElement('canvas');
  height.width = w;
  height.height = H;
  const h = height.getContext('2d')!;
  h.fillStyle = '#fff';
  h.fillRect(0, 0, w, H);
  h.filter = `blur(${CJK_PX * 0.03}px)`;
  prep(h, true);
  h.fillStyle = '#888';
  h.fillText(label, w / 2, H / 2);
  return { color, height, aspect: w / H, glyph: CJK_PX / H };
}

/** Colour (with alpha: only the grooves are drawn) and height textures for the carving. */
function carving(label: string, tone: THREE.Color) {
  if (CJK.test(label)) return cjkCarving(label);
  const probe = document.createElement('canvas').getContext('2d')!;
  prep(probe);
  const w = Math.ceil(probe.measureText(label).width + FONT_PX * 0.5);
  const k = FONT_PX * 0.11; // groove wall, as seen from the front (a sprite shrinks it to a pixel or two)

  const color = document.createElement('canvas');
  color.width = w;
  color.height = TEX_H;
  const c = color.getContext('2d')!;
  prep(c);
  // The cut: the body's own colour, deeper, as less light reaches in (not ink-black).
  const deep = tone.clone().multiplyScalar(0.5);
  c.fillStyle = `rgba(${deep.r * 255}, ${deep.g * 255}, ${deep.b * 255}, 0.9)`;
  c.fillText(label, w / 2, TEX_H / 2);
  c.drawImage(rim(label, w, k, 'rgba(0, 0, 0, 0.7)'), 0, 0); // upper inner wall, in shadow
  c.drawImage(rim(label, w, -k, 'rgba(255, 248, 228, 0.85)'), 0, 0); // lower inner wall, lit
  // The lip above each letter: outside the cut, where the edge turns toward the light.
  const lip = document.createElement('canvas');
  lip.width = w;
  lip.height = TEX_H;
  const l = lip.getContext('2d')!;
  prep(l);
  l.fillStyle = '#fff';
  l.fillText(label, w / 2, TEX_H / 2 - k * 0.6);
  l.globalCompositeOperation = 'destination-out';
  l.fillText(label, w / 2, TEX_H / 2);
  l.globalCompositeOperation = 'source-in';
  l.fillStyle = 'rgba(255, 250, 235, 0.5)';
  l.fillRect(0, 0, w, TEX_H);
  c.drawImage(lip, 0, 0);

  // Height: the surface white, the grooves black, softened so their walls slope.
  const height = document.createElement('canvas');
  height.width = w;
  height.height = TEX_H;
  const h = height.getContext('2d')!;
  h.fillStyle = '#fff';
  h.fillRect(0, 0, w, TEX_H);
  h.filter = `blur(${k * 0.5}px)`;
  prep(h);
  h.fillStyle = '#000';
  h.fillText(label, w / 2, TEX_H / 2);
  return { color, height, aspect: w / TEX_H, glyph: FONT_PX / TEX_H };
}

/**
 * Carves `label` into the fish's +z flank, along the middle of the body (the
 * body alone: its fins are a separate mesh). Returns the carving, to dispose of
 * with the fish.
 */
export function engraveName(fish: FishMesh, label: string, tone: THREE.Color, metalness: number): THREE.Mesh {
  const { len, height, width } = fish.size;
  const tex = carving(label, tone);
  // Letters about a third of the body's height, but never longer than ~56% of it
  // (so they stop short of the eye and of the thin tail end).
  const cjk = CJK.test(label);
  let decalH = (height * (cjk ? 0.46 : 0.36)) / tex.glyph;
  let decalW = decalH * tex.aspect;
  const maxW = len * 0.56;
  if (decalW > maxW) {
    decalH *= maxW / decalW;
    decalW = maxW;
  }
  // DecalGeometry works in world space: carve with the fish at unit scale, then restore.
  const scale = fish.group.scale.x;
  fish.group.scale.setScalar(1);
  fish.group.updateMatrixWorld(true);
  const surface = new THREE.Box3().setFromObject(fish.body).max.z;
  const geo = new DecalGeometry(
    fish.body,
    new THREE.Vector3(-len * 0.03, 0, surface),
    new THREE.Euler(0, 0, 0),
    // Deep enough to reach the flank where the body narrows, not through to the far side.
    new THREE.Vector3(decalW, decalH, width * 0.9),
  );
  const map = new THREE.CanvasTexture(tex.color);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const bumpMap = new THREE.CanvasTexture(tex.height);
  const carvingMesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      map,
      bumpMap,
      bumpScale: 3,
      transparent: true,
      // Fins and neighbouring tails sit in front of the flank; the label must stay readable.
      depthTest: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      roughness: 0.8,
      metalness,
    }),
  );
  carvingMesh.renderOrder = 10;
  fish.group.add(carvingMesh);
  fish.group.scale.setScalar(scale);
  return carvingMesh;
}

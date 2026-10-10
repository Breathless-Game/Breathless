import * as THREE from 'three';
import { Batch, disposeTree, flatMat, jitter, paintFaces } from './lowpoly';
import { MAPS, mapDepth, type MapDef, type MapId } from './maps';
import { Rng, hashString } from './rng';
import { RENDER_QUALITY, type RenderQuality } from './render-quality';
import { buildScenery, type Scenery } from './scenery';

export const HALF_WIDTH = 70;
/**
 * Every map is a shelf at `seabedY` except a trench straight under the boat:
 * |x| < TRENCH_HALF_WIDTH is open water all the way down.
 */
export const TRENCH_HALF_WIDTH = 14;

// Inside the trench the diver and fish swim at z in [-5, 3]. No wall rock comes
// nearer the middle than LANE_HALF_WIDTH anywhere in front of LANE_BACK; behind
// the lane the walls may reach in to WALL_REACH so the edge looks ragged.
const LANE_HALF_WIDTH = 13.5;
const LANE_BACK = -5;
const WALL_REACH = 11;
/** Trench walls are built lazily in slices this tall around the camera. */
const CHUNK_HEIGHT = 40;
/** Below this depth (m) the walls carry glowing specks. */
const GLOW_DEPTH = 120;
const SEABED_WIDTH = HALF_WIDTH * 2 + 120;
const SEABED_Z = -25;

// Each map lays out its terrain from its own seed. The ocean keeps the seed the
// single-sea version used, so its reef is where players remember it.
const TERRAIN_SEED: Record<MapId, number> = { fjord: 0xf10d5ea, tianchi: 0x71a2c41, ocean: 20261010 };

type Palette = [number, THREE.Color][];
const toPalette = (map: MapDef): Palette => map.water.map(([d, c]) => [d, new THREE.Color(c)]);

// Water colour by depth for the map currently loaded (see World.setMap).
let waterColors = toPalette(MAPS.ocean);

export function waterColorAt(depth: number, night = false): THREE.Color {
  const d = THREE.MathUtils.clamp(depth, 0, 60);
  let c = waterColors[waterColors.length - 1][1].clone();
  for (let i = 0; i < waterColors.length - 1; i++) {
    const [d0, c0] = waterColors[i];
    const [d1, c1] = waterColors[i + 1];
    if (d >= d0 && d <= d1) {
      c = c0.clone().lerp(c1, (d - d0) / (d1 - d0));
      break;
    }
  }
  if (night) c.multiplyScalar(0.35);
  return c;
}

/** Height of the sand above `seabedY` at world (x, z), before per-vertex noise. It rolls off at the trench edge. */
function shelfHeight(x: number, z: number) {
  const edge = Math.max(0, 1 - (Math.abs(x) - TRENCH_HALF_WIDTH) / 4);
  return Math.sin(x * 0.08) * 2.2 + Math.cos((z - SEABED_Z) * 0.15 + x * 0.03) * 1.5 - edge * 1.5;
}

/** Re-roll x in [lo, hi] until the span [x + minX, x + maxX] sits on the shelf, clear of the trench. */
function shelfX(rng: Rng, lo: number, hi: number, minX: number, maxX: number): number {
  for (let tries = 0; tries < 64; tries++) {
    const x = rng.range(lo, hi);
    if (x + minX >= TRENCH_HALF_WIDTH || x + maxX <= -TRENCH_HALF_WIDTH) return x;
  }
  return TRENCH_HALF_WIDTH - minX;
}

/** A jittered, randomly turned rock with the turn baked in, so its bounding box is exact. */
function rockGeometry(rng: Rng, r: number, detail: number, squash: number) {
  const geo = jitter(new THREE.IcosahedronGeometry(r, detail), rng, r * 0.18);
  geo.rotateX(rng.range(0, Math.PI * 2)).rotateY(rng.range(0, Math.PI * 2)).rotateZ(rng.range(0, Math.PI * 2));
  geo.scale(1, squash, 1);
  geo.computeBoundingBox();
  return geo;
}

/**
 * Slide a rock centred at (x, z) on wall `side` (-1 left, 1 right) out of the diver's lane:
 * anything reaching in front of LANE_BACK stays outside |x| = LANE_HALF_WIDTH, the rest outside `reach`.
 */
function clearLane(x: number, z: number, box: THREE.Box3, side: -1 | 1, reach = WALL_REACH) {
  const limit = z + box.max.z > LANE_BACK ? LANE_HALF_WIDTH : reach;
  return side < 0 ? Math.min(x, -limit - box.max.x) : Math.max(x, limit - box.min.x);
}

const ABYSS_TINT = new THREE.Color('#1a2c44');

/** The map's rock colour, darker and cooler the deeper it sits. */
function wallTint(base: THREE.Color, depth: number, out: THREE.Color) {
  const t = 1 - Math.exp(-Math.max(0, depth - 20) / 140);
  return out.copy(base).lerp(ABYSS_TINT, 0.5 * t).multiplyScalar(1 - 0.55 * t);
}

/** Share of trench-wall rocks to build: all on high, fewer but larger ones on lower settings. */
function wallDensity(quality: RenderQuality) {
  return 0.45 + 0.55 * Math.min(1, quality.kelpCount / RENDER_QUALITY.high.kelpCount);
}

/** Underwater fog reach (m) once the camera is inside the trench: far enough that the side and back walls read as a slot in the rock. */
const TRENCH_FOG_FAR = 50;
/** Metres below the shelf over which the fog eases out to TRENCH_FOG_FAR. */
const TRENCH_FOG_EASE = 10;

/**
 * Fog far distance for a camera `depth` m under water. Open water closes in from 70 m to 34 m
 * by 60 m deep. The camera only drops below the shelf inside the trench (over the shelf it stays
 * 9 m above the sand), and there the fog pulls back so the walls don't vanish into it.
 */
function underwaterFogFar(depth: number, shelfDepth: number) {
  const open = THREE.MathUtils.lerp(70, 34, Math.min(1, depth / 60));
  const inTrench = THREE.MathUtils.smoothstep(depth, shelfDepth, shelfDepth + TRENCH_FOG_EASE);
  return Math.max(open, THREE.MathUtils.lerp(open, TRENCH_FOG_FAR, inTrench));
}

/** Marine snow drifts in a band from 45 m below the camera to 35 m above it, never above the surface. */
function snowBand(cameraY: number): [number, number] {
  const hi = Math.min(-0.5, cameraY + 35);
  return [Math.min(cameraY - 45, hi - 40), hi];
}

interface Kelp {
  root: THREE.Group;
  segments: THREE.Object3D[];
  phase: number;
}

/** One rock slot in a trench-wall chunk. `side` is -1/1 for the side walls, 0 for the back wall. */
interface WallSlot {
  side: -1 | 0 | 1;
  x: number;
  y: number;
  z: number;
  r: number;
}

export class World {
  scene = new THREE.Scene();
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  surface: THREE.Mesh;
  boat: THREE.Group;
  private surfaceBase: Float32Array;
  private kelps: Kelp[] = [];
  private rays: THREE.Mesh[] = [];
  private snow: THREE.Points;
  private quality: RenderQuality;
  private lastDecorationTime = 0;
  private cameraY = 0;
  // Everything on and near the bottom. Rebuilt when the map changes.
  private terrain = new THREE.Group();
  // Trench walls below the shelf, in CHUNK_HEIGHT slices around the camera (see updateTrench).
  // Kept out of `terrain` because every chunk shares the two materials below.
  private trench = new THREE.Group();
  private chunks = new Map<number, THREE.Group>();
  private chunkCenter = NaN;
  private wallDensity: number;
  private wallMat = flatMat('#ffffff', { vertexColors: true });
  private glowMat = new THREE.MeshBasicMaterial({ color: '#4ff5d2', vertexColors: true, fog: false });
  private scenery: Scenery | null = null;
  private sky = new THREE.Color();
  private nightSky = new THREE.Color();
  map: MapDef;
  /** World y of the shelf for the current map (negative). Inside the trench there is no floor. */
  seabedY: number;
  night = false;

  constructor(quality: RenderQuality = RENDER_QUALITY.high, map: MapDef = MAPS.ocean) {
    this.quality = quality;
    this.wallDensity = wallDensity(quality);
    this.map = map;
    this.seabedY = -mapDepth(map);
    const rng = new Rng(20261010);
    this.scene.fog = new THREE.Fog(waterColors[0][1], 8, 70);
    this.scene.background = waterColors[0][1].clone();

    this.hemi = new THREE.HemisphereLight('#d6f4ff', '#0a2a40', 1.4);
    this.sun = new THREE.DirectionalLight('#fff6dd', 2.2);
    this.sun.position.set(20, 60, 30);
    this.scene.add(this.hemi, this.sun);

    this.scene.add(this.terrain, this.trench);
    this.buildRays(rng);
    this.snow = this.buildSnow(rng);
    this.surface = this.buildSurface();
    this.surfaceBase = (this.surface.geometry.attributes.position.array as Float32Array).slice();
    this.boat = this.buildBoat();
    this.setMap(map);
  }

  /** Swap in another map: terrain, shoreline, water palette. Fish are the caller's job. */
  setMap(map: MapDef) {
    this.map = map;
    this.seabedY = -mapDepth(map);
    waterColors = toPalette(map);
    this.sky.set(map.sky);
    this.nightSky.set(map.nightSky);
    (this.surface.material as THREE.MeshStandardMaterial).color.set(map.surface);

    disposeTree(this.terrain);
    this.terrain.clear();
    this.kelps = [];
    // Trench walls of the old map go; update() builds the new ones around the camera.
    this.clearTrench();
    const rng = new Rng(TERRAIN_SEED[map.id]);
    this.buildSeabed(rng);
    this.buildRocks(rng);
    if (map.life === 'coral') this.buildCoral(rng);
    if (map.life === 'logs') this.buildLogs(rng);
    this.buildKelp(rng);

    // Marine snow lives in a band around the camera; respread it there.
    const [lo, hi] = snowBand(this.cameraY);
    const snowPos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < snowPos.count; i++) snowPos.setY(i, rng.range(lo, hi));
    snowPos.needsUpdate = true;

    if (this.scenery) {
      this.scene.remove(this.scenery.group);
      disposeTree(this.scenery.group);
    }
    this.scenery = buildScenery(map);
    this.scene.add(this.scenery.group);
    this.setQuality(this.quality);
  }

  /** The shelf: two halves of sand with the trench open between them, and a broken lip on each edge. */
  private buildSeabed(rng: Rng) {
    const width = SEABED_WIDTH / 2 - TRENCH_HALF_WIDTH;
    const sand = new THREE.Color(this.map.sand);
    for (const side of [-1, 1]) {
      const cx = side * (TRENCH_HALF_WIDTH + width / 2);
      const geo = new THREE.PlaneGeometry(width, 90, Math.round((80 * width) / SEABED_WIDTH), 30);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, shelfHeight(pos.getX(i) + cx, pos.getZ(i) + SEABED_Z) + rng.range(-0.6, 0.6));
      }
      const g = geo.toNonIndexed();
      geo.dispose();
      g.computeVertexNormals();
      const colors: number[] = [];
      for (let i = 0; i < g.attributes.position.count; i += 3) {
        const c = sand.clone().multiplyScalar(rng.range(0.75, 1.05));
        for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(g, flatMat('#ffffff', { vertexColors: true }));
      mesh.position.set(cx, this.seabedY, SEABED_Z);
      this.terrain.add(mesh);
    }
    this.buildLip(rng);
  }

  /** Half-sunk rocks along both edges of the trench mouth so the cut in the sand reads as broken rock. */
  private buildLip(rng: Rng) {
    const mats = this.map.rocks.map((c) => flatMat(c));
    const batch = new Batch();
    const span = 30;
    const perSide = 7;
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < perSide; i++) {
        const r = rng.range(1.2, 2.6);
        const z = -20 + ((i + rng.range(0.1, 0.9)) * span) / perSide;
        const geo = rockGeometry(rng, r, 0, rng.range(0.55, 0.9));
        const x = clearLane(side * (TRENCH_HALF_WIDTH + 0.5 + r * rng.range(0, 0.5)), z, geo.boundingBox!, side, 12.5);
        const y = this.seabedY + shelfHeight(side * TRENCH_HALF_WIDTH, z) - r * rng.range(0.1, 0.4);
        batch.add(geo, rng.pick(mats), x, y, z);
      }
    }
    this.terrain.add(batch.build());
  }

  private buildRocks(rng: Rng) {
    const palette = this.map.rocks;
    // Back cliff walls at different depths give the 2.5D parallax.
    for (let i = 0; i < 70; i++) {
      const r = rng.range(2.5, 9);
      const geo = jitter(new THREE.IcosahedronGeometry(r, rng.next() < 0.5 ? 0 : 1), rng, r * 0.18);
      const mesh = new THREE.Mesh(geo, flatMat(rng.pick(palette)));
      const y = this.seabedY + Math.pow(rng.next(), 1.6) * (-this.seabedY - 10);
      mesh.position.set(rng.range(-HALF_WIDTH - 20, HALF_WIDTH + 20), y, rng.range(-38, -14));
      mesh.rotation.set(rng.range(0, 6), rng.range(0, 6), rng.range(0, 6));
      mesh.scale.y = rng.range(0.6, 1.3);
      this.terrain.add(mesh);
    }
    // A few foreground boulders on the shelf, never hanging over the trench.
    for (let i = 0; i < 16; i++) {
      const r = rng.range(1.5, 4);
      const mesh = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(r, 0), rng, r * 0.2), flatMat(rng.pick(palette)));
      mesh.position.set(shelfX(rng, -HALF_WIDTH, HALF_WIDTH, -r * 1.2, r * 1.2), this.seabedY + r * 0.4, rng.range(-6, 6));
      this.terrain.add(mesh);
    }
  }

  private buildCoral(rng: Rng) {
    const colors = ['#ff6f91', '#ff9671', '#ffc75f', '#c34a82', '#f9f871', '#7ee8fa'];
    for (let i = 0; i < 90; i++) {
      const group = new THREE.Group();
      const color = rng.pick(colors);
      const kind = rng.int(0, 2);
      if (kind === 0) {
        // Branching coral: a few tilted cones.
        for (let b = 0; b < rng.int(3, 6); b++) {
          const h = rng.range(0.8, 2.4);
          const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, h, 5), flatMat(color));
          cone.position.y = h / 2;
          cone.rotation.set(rng.range(-0.6, 0.6), 0, rng.range(-0.6, 0.6));
          group.add(cone);
        }
      } else if (kind === 1) {
        const brain = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(rng.range(0.6, 1.3), 0), rng, 0.12), flatMat(color));
        brain.scale.y = 0.65;
        group.add(brain);
      } else {
        // Fan coral.
        const fan = new THREE.Mesh(new THREE.CircleGeometry(rng.range(0.9, 1.6), 6, 0, Math.PI), flatMat(color, { side: THREE.DoubleSide }));
        group.add(fan);
      }
      // Coral lives mostly in the reef band. On the floor it keeps to the shelf.
      const onFloor = rng.next() < 0.45;
      const y = onFloor ? this.seabedY + 1 : -rng.range(16, 42);
      const x = onFloor ? shelfX(rng, -HALF_WIDTH, HALF_WIDTH, -2, 2) : rng.range(-HALF_WIDTH, HALF_WIDTH);
      group.position.set(x, y, onFloor ? rng.range(-12, 4) : rng.range(-16, -9));
      group.rotation.y = rng.range(0, Math.PI * 2);
      this.terrain.add(group);
    }
  }

  /** Heaven Lake's "sunken forest": drowned trunks on the bottom and rock shelves on the back wall. */
  private buildLogs(rng: Rng) {
    const bark = [flatMat('#4a3b2a'), flatMat('#5c4a36'), flatMat('#3a2e22')];
    const box = new THREE.Box3();
    for (let i = 0; i < 30; i++) {
      const len = rng.range(6, 16);
      const r = rng.range(0.35, 0.9);
      const mat = rng.pick(bark);
      const log = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r, len, 6), mat);
      trunk.position.y = len / 2;
      log.add(trunk);
      for (let b = 0; b < rng.int(1, 3); b++) {
        const bl = rng.range(1.2, 3.2);
        const branch = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.3, bl, 5), mat);
        branch.position.set(0, len * rng.range(0.45, 0.9), 0);
        branch.rotation.set(rng.range(-0.3, 0.3), rng.range(0, 6), rng.range(0.7, 1.2));
        branch.translateY(bl / 2);
        log.add(branch);
      }
      // Most lie fallen on the bottom; some still stand, leaning. All of them on the shelf.
      const standing = rng.next() < 0.3;
      log.rotation.set(rng.range(-0.2, 0.2), rng.range(0, 6), standing ? rng.range(-0.35, 0.35) : Math.PI / 2 + rng.range(-0.15, 0.15));
      box.setFromObject(log);
      const x = shelfX(rng, -HALF_WIDTH, HALF_WIDTH, box.min.x - 0.5, box.max.x + 0.5);
      log.position.set(x, this.seabedY + (standing ? 0 : r), rng.range(-14, 4));
      this.terrain.add(log);
    }
    for (let i = 0; i < 16; i++) {
      const w = rng.range(7, 16);
      const shelf = new THREE.Mesh(jitter(new THREE.BoxGeometry(w, rng.range(0.9, 1.8), rng.range(4, 7)), rng, 0.5), flatMat(rng.pick(this.map.rocks)));
      shelf.position.set(rng.range(-HALF_WIDTH - 10, HALF_WIDTH + 10), -rng.range(12, 36), rng.range(-17, -11));
      shelf.rotation.z = rng.range(-0.08, 0.08);
      this.terrain.add(shelf);
    }
  }

  private buildKelp(rng: Rng) {
    const { count: plants, hue } = this.map.kelp;
    for (let i = 0; i < plants; i++) {
      const root = new THREE.Group();
      const z = rng.next() < 0.25 ? rng.range(4, 8) : rng.range(-14, -4);
      root.position.set(shelfX(rng, -HALF_WIDTH - 10, HALF_WIDTH + 10, -1.5, 1.5), this.seabedY + 0.5, z);
      const color = new THREE.Color().setHSL(rng.range(hue[0], hue[1]), 0.55, rng.range(0.22, 0.35));
      const mat = flatMat(color, { side: THREE.DoubleSide });
      const tall = rng.int(10, 26);
      const segLen = rng.range(1.4, 2.0);
      // Never taller than the water is deep.
      const count = Math.min(tall, Math.floor((-this.seabedY - 6) / segLen));
      const segments: THREE.Object3D[] = [];
      let parent: THREE.Object3D = root;
      for (let s = 0; s < count; s++) {
        const seg = new THREE.Group();
        seg.position.y = s === 0 ? 0 : segLen;
        const w = 0.5 * (1 - s / count) + 0.15;
        const blade = new THREE.Mesh(new THREE.PlaneGeometry(w, segLen, 1, 1), mat);
        blade.position.y = segLen / 2;
        blade.rotation.y = rng.range(-0.8, 0.8);
        seg.add(blade);
        if (s % 3 === 1) {
          const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.5, 3), mat);
          leaf.position.set(0.4, segLen * 0.6, 0);
          leaf.rotation.z = -0.6;
          seg.add(leaf);
        }
        parent.add(seg);
        segments.push(seg);
        parent = seg;
      }
      this.kelps.push({ root, segments, phase: rng.range(0, Math.PI * 2) });
      this.terrain.add(root);
    }
  }

  /** Keep the wall chunk the camera is in plus one above and one below; drop the rest. */
  private updateTrench(cameraY: number) {
    const center = Math.max(0, Math.floor((this.seabedY - cameraY) / CHUNK_HEIGHT));
    if (center === this.chunkCenter) return;
    this.chunkCenter = center;
    for (const [k, chunk] of this.chunks) {
      if (Math.abs(k - center) <= 1) continue;
      this.dropChunk(chunk);
      this.chunks.delete(k);
    }
    for (let k = Math.max(0, center - 1); k <= center + 1; k++) {
      if (this.chunks.has(k)) continue;
      const chunk = this.buildWallChunk(k);
      this.chunks.set(k, chunk);
      this.trench.add(chunk);
    }
  }

  private clearTrench() {
    for (const chunk of this.chunks.values()) this.dropChunk(chunk);
    this.chunks.clear();
    this.chunkCenter = NaN;
  }

  private dropChunk(chunk: THREE.Group) {
    this.trench.remove(chunk);
    // The materials are shared by every chunk; only the merged geometry belongs to this one.
    chunk.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }

  /**
   * Slice k of the trench walls, spanning y in [seabedY - 40(k+1), seabedY - 40k].
   * Same map and k always give the same rocks; lower quality only thins them out
   * (and grows the survivors) without moving any.
   */
  private buildWallChunk(k: number): THREE.Group {
    const rng = new Rng(hashString(`${this.map.id}:trench:${k}`));
    const top = this.seabedY - k * CHUNK_HEIGHT;
    const keep = this.wallDensity;
    const grow = 1 / Math.sqrt(keep);
    const palette = this.map.rocks.map((c) => new THREE.Color(c));

    // Roll every slot so the random sequence is the same at every quality, then keep an even share.
    const slots: (WallSlot & { seed: number })[] = [];
    const layer = (count: number, roll: (i: number) => WallSlot) => {
      for (let i = 0; i < count; i++) {
        const slot = roll(i);
        const seed = (rng.next() * 2 ** 32) >>> 0;
        if (Math.floor((i + 1) * keep + 1e-9) > Math.floor(i * keep + 1e-9)) slots.push({ ...slot, seed });
      }
    };
    const row = (i: number, rows: number) => top - ((i + rng.range(0.15, 0.85)) * CHUNK_HEIGHT) / rows;
    for (const side of [-1, 1] as const) {
      // Inner face: the rock the diver swims past, hugging the trench edge.
      layer(16, (i) => ({ side, y: row(i, 16), x: side * rng.range(16, 21), z: rng.range(-10, 7), r: rng.range(3, 5) }));
      // Bigger rock further out and further back fills the frame behind the inner face.
      layer(8, (i) => ({ side, y: row(i, 8), x: side * rng.range(22, 30), z: rng.range(-30, -10), r: rng.range(5, 8) }));
    }
    // Back wall behind the play plane, three columns by four rows, so the trench reads as a slot in rock.
    const column = (TRENCH_HALF_WIDTH * 2) / 3;
    layer(12, (i) => ({
      side: 0,
      y: row(Math.floor(i / 3), 4),
      x: -TRENCH_HALF_WIDTH + ((i % 3) + rng.range(0.1, 0.9)) * column,
      z: rng.range(-24, -16),
      r: rng.range(4.5, 7.5),
    }));

    const batch = new Batch();
    const tint = new THREE.Color();
    const shade = new THREE.Color();
    for (const s of slots) {
      const sub = new Rng(s.seed);
      const geo = rockGeometry(sub, s.r * grow, sub.next() < 0.5 ? 0 : 1, sub.range(0.7, 1.15));
      const box = geo.boundingBox!;
      let { x, y, z } = s;
      // The top slice stops at the shelf instead of poking up through the sand.
      if (k === 0) y = Math.min(y, this.seabedY + 1 - box.max.y);
      if (s.side === 0) z = Math.min(z, LANE_BACK - box.max.z);
      else x = clearLane(x, z, box, s.side);
      wallTint(sub.pick(palette), -y, tint);
      // Faces darken toward the rock's underside.
      paintFaces(geo, (h) => shade.copy(tint).multiplyScalar((0.78 + 0.22 * h) * sub.range(0.85, 1.05)));

      // Bioluminescence: a few specks on the faces that look into the trench.
      const depth = -y;
      if (depth > GLOW_DEPTH && sub.next() < 0.4 * Math.min(1, (depth - GLOW_DEPTH) / 100)) {
        const pos = geo.attributes.position;
        const nrm = geo.attributes.normal;
        let dots = sub.int(1, 2);
        for (let t = 0; t < 12 && dots > 0; t++) {
          const v = sub.int(0, pos.count - 1);
          const facing = s.side === 0 ? nrm.getZ(v) : -s.side * nrm.getX(v);
          if (facing < 0.35) continue;
          const size = sub.range(0.06, 0.13);
          const dx = x + pos.getX(v) + nrm.getX(v) * 0.04;
          const dy = y + pos.getY(v) + nrm.getY(v) * 0.04;
          const dz = z + pos.getZ(v) + nrm.getZ(v) * 0.04;
          if (Math.abs(dx) - size < LANE_HALF_WIDTH && dz + size > LANE_BACK) continue;
          const dot = new THREE.OctahedronGeometry(size);
          const glow = sub.range(0.45, 1);
          paintFaces(dot, () => shade.setScalar(glow));
          batch.add(dot, this.glowMat, dx, dy, dz);
          dots--;
        }
      }
      batch.add(geo, this.wallMat, x, y, z);
    }
    return batch.build();
  }

  private buildRays(rng: Rng) {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, 'rgba(255,255,240,0.55)');
    grad.addColorStop(1, 'rgba(255,255,240,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 128);
    const tex = new THREE.CanvasTexture(canvas);
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: rng.range(0.25, 0.5),
        side: THREE.DoubleSide,
        fog: false,
      });
      const ray = new THREE.Mesh(new THREE.PlaneGeometry(rng.range(1.5, 4), 34), mat);
      ray.position.set(rng.range(-HALF_WIDTH, HALF_WIDTH), -16, rng.range(-14, -3));
      ray.rotation.z = rng.range(-0.35, -0.15);
      this.rays.push(ray);
      this.scene.add(ray);
    }
  }

  private buildSnow(rng: Rng) {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    const [lo, hi] = snowBand(this.cameraY);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rng.range(-HALF_WIDTH - 20, HALF_WIDTH + 20);
      pos[i * 3 + 1] = rng.range(lo, hi);
      pos[i * 3 + 2] = rng.range(-18, 10);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: '#e8fbff', size: 0.12, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.scene.add(pts);
    return pts;
  }

  private buildSurface() {
    const geo = this.surfaceGeometry();
    const mat = new THREE.MeshStandardMaterial({
      color: '#8fe3f2',
      flatShading: true,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      roughness: 0.25,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, -30);
    this.scene.add(mesh);
    return mesh;
  }

  private surfaceGeometry() {
    const [x, y] = this.quality.surfaceSegments;
    const geo = new THREE.PlaneGeometry(HALF_WIDTH * 2 + 160, 120, x, y);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  setQuality(quality: RenderQuality) {
    const surfaceChanged = this.quality.surfaceSegments !== quality.surfaceSegments;
    this.quality = quality;
    this.kelps.forEach((kelp, i) => {
      kelp.root.visible = i < quality.kelpCount;
      // Hidden objects still receive Three.js matrix updates while in the scene.
      if (kelp.root.visible) this.terrain.add(kelp.root);
      else this.terrain.remove(kelp.root);
    });
    this.rays.forEach((ray, i) => {
      ray.visible = i < quality.rayCount && !this.night && (ray.material as THREE.MeshBasicMaterial).opacity > 0;
    });
    this.snow.geometry.setDrawRange(0, quality.snowCount);
    if (surfaceChanged) {
      const old = this.surface.geometry;
      this.surface.geometry = this.surfaceGeometry();
      this.surfaceBase = (this.surface.geometry.attributes.position.array as Float32Array).slice();
      old.dispose();
    }
    // Trench walls are thinned by quality; rebuild the live chunks only if that changed.
    const density = wallDensity(quality);
    if (density !== this.wallDensity) {
      this.wallDensity = density;
      this.clearTrench();
    }
  }

  private buildBoat() {
    const boat = new THREE.Group();

    const hullMat = flatMat('#b8483e');
    const hullDarkMat = flatMat('#742f37');
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

    // A side-profile extrusion gives the hull a readable pointed bow and a
    // deep keel, while keeping the same flat-shaded low-poly language.
    const hullShape = new THREE.Shape();
    hullShape.moveTo(-3.35, 0.38);
    hullShape.lineTo(2.05, 0.38);
    hullShape.lineTo(3.45, 0.12);
    hullShape.lineTo(2.62, -0.45);
    hullShape.lineTo(-2.38, -0.62);
    hullShape.lineTo(-3.45, -0.08);
    hullShape.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 1.72, bevelEnabled: false, steps: 1 });
    hullGeo.translate(0, 0, -0.86);
    const hull = new THREE.Mesh(hullGeo, hullMat);

    const stripeShape = new THREE.Shape();
    stripeShape.moveTo(-3.2, -0.05);
    stripeShape.lineTo(2.62, 0.0);
    stripeShape.lineTo(2.35, -0.2);
    stripeShape.lineTo(-2.55, -0.28);
    stripeShape.closePath();
    const stripeGeo = new THREE.ExtrudeGeometry(stripeShape, { depth: 0.035, bevelEnabled: false });
    stripeGeo.translate(0, 0, 0.85);
    const stripe = new THREE.Mesh(stripeGeo, trimMat);

    const keel = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.22, 1.05), hullDarkMat);
    keel.position.set(-0.15, -0.53, 0);
    keel.rotation.z = -0.035;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(6.25, 0.18, 1.58), deckMat);
    deck.position.y = 0.55;
    const bowDeck = new THREE.Mesh(new THREE.ConeGeometry(1.05, 1.4, 4), deckMat);
    bowDeck.position.set(2.6, 0.61, 0);
    bowDeck.rotation.z = Math.PI / 2;
    bowDeck.scale.set(0.6, 1, 1);

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
    const bowRail = rod(new THREE.Vector3(2.32, 1.02, 0.64), new THREE.Vector3(3.18, 0.7, 0.48), 0.04, metalMat);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 2.75, 6), woodMat);
    mast.position.set(2.3, 1.95, 0);
    const mastBrace = rod(new THREE.Vector3(1.72, 0.66, 0), new THREE.Vector3(2.3, 3.28, 0), 0.035, metalMat);
    const boom = rod(new THREE.Vector3(1.48, 2.77, 0), new THREE.Vector3(2.68, 2.77, 0), 0.04, woodMat);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.78, 5), metalMat);
    antenna.position.set(-0.84, 2.54, 0);
    const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), lampMat);
    antennaTip.position.set(-0.84, 2.96, 0);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.52), flatMat('#ffcc4d', { side: THREE.DoubleSide }));
    flag.position.set(2.68, 3.04, 0);
    flag.rotation.y = Math.PI / 2;

    const searchLight = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.21, 0.18, 6), lampMat);
    searchLight.position.set(0.13, 2.28, 0.1);
    searchLight.rotation.z = Math.PI / 2;
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
    lifeRing.rotation.x = Math.PI / 2;

    const bowLamp = new THREE.Mesh(new THREE.SphereGeometry(0.095, 6, 4), lampMat);
    bowLamp.position.set(3.18, 0.74, 0.43);
    const sternLamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), redLampMat);
    sternLamp.position.set(-3.05, 0.74, 0.15);
    const propeller = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.045, 4, 8), metalMat);
    propeller.position.set(-2.72, -0.62, 0);
    propeller.rotation.y = Math.PI / 2;

    boat.add(hull, stripe, keel, deck, bowDeck, cabin, cabinFront, cabinSide, cabinBackWindow, cabinFrontFrame, roof, roofTrim);
    boat.add(...railPosts, sideRail, bowRail, mast, mastBrace, boom, antenna, antennaTip, flag);
    boat.add(searchLight, engineVent, ventSlat, reel, reelDrum, reelArm, crate, crateBand, lifeRing, bowLamp, sternLamp, propeller);
    boat.position.set(0, 0.2, 0);
    this.scene.add(boat);
    return boat;
  }

  setNight(night: boolean) {
    this.night = night;
    (this.snow.material as THREE.PointsMaterial).color.set(night ? '#7ff7ff' : '#e8fbff');
  }

  update(time: number, cameraY: number) {
    this.cameraY = cameraY;
    this.updateTrench(cameraY);
    const elapsed = time - this.lastDecorationTime;
    if (elapsed + 1e-6 >= 1 / this.quality.decorationHz) {
      this.updateDecorations(time, Math.min(elapsed, 0.25), cameraY);
      this.lastDecorationTime = time;
    }

    // Water colour, fog and light fall off with depth.
    const depth = -cameraY;
    const fog = this.scene.fog as THREE.Fog;
    if (depth < 0) {
      const sky = this.night ? this.nightSky : this.sky;
      (this.scene.background as THREE.Color).copy(sky);
      fog.color.copy(sky);
      [fog.near, fog.far] = this.map.haze;
    } else {
      const c = waterColorAt(depth, this.night);
      (this.scene.background as THREE.Color).copy(c);
      fog.color.copy(c);
      fog.near = 6;
      fog.far = underwaterFogFar(depth, -this.seabedY);
    }
    const light = THREE.MathUtils.clamp(1 - depth / 75, 0.12, 1) * (this.night ? 0.35 : 1);
    this.hemi.intensity = 1.4 * light;
    this.sun.intensity = 2.2 * light * light;
    if (this.scenery) {
      // Nothing above the water is visible once the camera is under it.
      this.scenery.group.visible = depth < 1;
      if (this.scenery.group.visible) this.scenery.update(time, this.night);
    }
    const rayOpacity = this.night ? 0 : 0.35 * THREE.MathUtils.clamp(1 - depth / 35, 0, 1);
    this.rays.forEach((ray, i) => {
      ray.visible = i < this.quality.rayCount && rayOpacity > 0;
      (ray.material as THREE.MeshBasicMaterial).opacity = rayOpacity;
    });
  }

  private updateDecorations(time: number, dt: number, cameraY: number) {
    // Waves.
    const pos = this.surface.geometry.attributes.position;
    const base = this.surfaceBase;
    const waves = this.map.waves;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const z = base[i * 3 + 2];
      pos.setY(i, (Math.sin(x * 0.15 + time * 1.3) * 0.35 + Math.cos(z * 0.2 + time * 0.9) * 0.25) * waves);
    }
    pos.needsUpdate = true;
    this.surface.geometry.computeVertexNormals();

    this.boat.position.y = 0.25 + Math.sin(time * 1.3) * 0.18 * waves;
    this.boat.rotation.z = Math.sin(time * 1.1) * 0.05 * waves;

    for (const k of this.kelps) {
      if (!k.root.visible) continue;
      k.segments.forEach((seg, i) => {
        seg.rotation.z = Math.sin(time * 0.8 + k.phase + i * 0.35) * 0.06;
        seg.rotation.x = Math.cos(time * 0.6 + k.phase + i * 0.3) * 0.03;
      });
    }

    // Snow that falls out of the bottom of the camera's band re-enters at the top (80 m up
    // when deep, less near the surface). Snow left above the band when the camera sinks
    // fast wraps down the same way, so the band is never empty.
    const [lo, hi] = snowBand(cameraY);
    const span = hi - lo;
    const snowPos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < this.quality.snowCount; i++) {
      let y = snowPos.getY(i) - 0.24 * dt;
      if (y < lo || y > hi) y = lo + ((((y - lo) % span) + span) % span);
      snowPos.setY(i, y);
    }
    snowPos.addUpdateRange(0, this.quality.snowCount * 3);
    snowPos.needsUpdate = true;
  }
}

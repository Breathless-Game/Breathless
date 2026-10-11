import * as THREE from 'three';
import { Batch, disposeTree, flatMat, jitter, paintFaces } from './lowpoly';
import { MAPS, mapDepth, type MapDef, type MapId } from './maps';
import { Rng, hashString } from './rng';
import { RENDER_QUALITY, type RenderQuality } from './render-quality';
import { DayCycle, type LightingState, type TimeOfDay } from './daylight';
import { WaterSurfaceMaterial } from './water';
import { waterGeometry } from './water-geometry';
import { WeatherCycle, type WeatherMode } from './weather';
import { RainEffect } from './rain';
import { Atmosphere } from './sky';
import { SunShafts } from './sunshafts';
import { SceneColorGrade } from './color-grade';
import { buildScenery, type Scenery, type SceneryEnv } from './scenery';
import { FLORA, understorySpecies } from './flora';
import { KelpBed, type KelpPlant } from './kelp';
import { Shelf, layoutSeabed, plantHeight, type RockSlot, type SeabedLayout } from './seabed-layout';

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
  // The sand, and where this map's rocks and plants stand on it (see seabed-layout.ts).
  private shelf!: Shelf;
  private layout!: SeabedLayout;
  private rocks: THREE.Group | null = null;
  private kelp: KelpBed | null = null;
  private diverPos = new THREE.Vector3(0, 100, 0);
  private diverVel = new THREE.Vector3();
  readonly shafts = new SunShafts();
  readonly atmosphere = new Atmosphere();
  readonly colorGrade = new SceneColorGrade();
  private snow: THREE.Points;
  private quality: RenderQuality;
  private lightingEffects = true;
  /**
   * Set while a world event plays its own lightning (see events.ts), so the
   * storm's sheet lightning holds off and the two never flash together.
   */
  quietWeatherLightning = false;
  private lastDecorationTime = 0;
  readonly dayCycle = new DayCycle();
  readonly weather = new WeatherCycle();
  readonly rain = new RainEffect();
  private weatherTime = 0;
  private cloudTime = 0;
  private waveTime = 0;
  private lighting: LightingState = this.dayCycle.state;
  private skyColor = new THREE.Color();
  private horizonColor = new THREE.Color();
  private waterBackground = new THREE.Color();
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
  // Reused on every tick so animating the shore allocates nothing.
  private sceneryEnv: SceneryEnv = {};
  private daySkyTint: [number, number, number] = [1, 1, 1];
  private nightSkyTint: [number, number, number] = [1, 1, 1];
  private surfaceTint = new THREE.Color(1, 1, 1);
  private lastSceneTime = 0;
  private lastCameraY = 1.5;
  private lastCameraX = 0;
  map: MapDef;
  /** World y of the shelf for the current map (negative). Inside the trench there is no floor. */
  seabedY: number;

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
    this.scene.add(this.rain, this.atmosphere, this.shafts.group);

    this.scene.add(this.terrain, this.trench);
    this.snow = this.buildSnow(rng);
    this.surface = this.buildSurface();
    this.boat = this.buildBoat();
    this.setMap(map);
  }

  /** Swap in another map: terrain, shoreline, water palette. Fish are the caller's job. */
  setMap(map: MapDef) {
    this.map = map;
    this.seabedY = -mapDepth(map);
    waterColors = toPalette(map);
    // Apply each map's palette relative to the open-ocean reference while
    // preserving the continuous dawn/dusk colors and the weather transition.
    const skyTint = (color: string, reference: string): [number, number, number] => {
      const tint = new THREE.Color(color).convertLinearToSRGB();
      const base = new THREE.Color(reference).convertLinearToSRGB();
      return [tint.r / base.r, tint.g / base.g, tint.b / base.b];
    };
    this.daySkyTint = skyTint(map.sky, MAPS.ocean.sky);
    this.nightSkyTint = skyTint(map.nightSky, MAPS.ocean.nightSky);
    const surfaceBase = new THREE.Color(MAPS.ocean.surface);
    this.surfaceTint.set(map.surface);
    this.surfaceTint.setRGB(this.surfaceTint.r / surfaceBase.r, this.surfaceTint.g / surfaceBase.g, this.surfaceTint.b / surfaceBase.b);

    disposeTree(this.terrain, this.scene);
    this.terrain.clear();
    this.rocks = null;
    this.kelp = null;
    // Trench walls of the old map go; update() builds the new ones around the camera.
    this.clearTrench();
    const rng = new Rng(TERRAIN_SEED[map.id]);
    this.shelf = new Shelf(TERRAIN_SEED[map.id], {
      trench: TRENCH_HALF_WIDTH, outer: SEABED_WIDTH / 2, zMin: SEABED_Z - 45, zMax: SEABED_Z + 45,
    });
    // Laid out once at full density; quality only shows a prefix, so plants never move.
    const flora = FLORA[map.id];
    this.layout = layoutSeabed(this.shelf, {
      seed: TERRAIN_SEED[map.id] ^ 0x5eabed,
      depth: -this.seabedY,
      reach: HALF_WIDTH,
      canopy: map.kelp.count,
      understory: Array.from({ length: Math.round(map.kelp.count * flora.undergrowth) }, (_, i) => understorySpecies(flora, i)),
    });
    this.buildSeabed(rng);
    this.buildRocks();
    if (map.life === 'coral') this.buildCoral(rng);
    if (map.life === 'logs') this.buildLogs(rng);
    this.buildKelp();

    // Marine snow lives in a band around the camera; respread it there.
    const [lo, hi] = snowBand(this.lastCameraY);
    const snowPos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < snowPos.count; i++) snowPos.setY(i, rng.range(lo, hi));
    snowPos.needsUpdate = true;

    if (this.scenery) {
      this.scene.remove(this.scenery.group);
      disposeTree(this.scenery.group, this.scene);
    }
    this.scenery = buildScenery(map, this.quality.detail);
    this.scene.add(this.scenery.group);
    this.setQuality(this.quality);
    this.colorGrade.apply(this.scene);
    this.updateLighting(this.lastSceneTime, this.lastCameraY, this.lastCameraX);
  }

  /** World y of the sand at (x, z). */
  private groundY(x: number, z: number) {
    return this.seabedY + this.shelf.heightAt(x, z);
  }

  /** The shelf: two halves of sand with the trench open between them, and a broken lip on each edge. */
  private buildSeabed(rng: Rng) {
    const sand = new THREE.Color(this.map.sand);
    const c = new THREE.Color();
    for (const side of [0, 1] as const) {
      const g = new THREE.BufferGeometry();
      const positions = this.shelf.triangles(side);
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.computeVertexNormals();
      const colors = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 9) {
        c.copy(sand).multiplyScalar(rng.range(0.75, 1.05));
        for (let k = 0; k < 3; k++) c.toArray(colors, i + k * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(g, flatMat('#ffffff', { vertexColors: true }));
      mesh.position.y = this.seabedY;
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
        const y = this.groundY(side * TRENCH_HALF_WIDTH, z) - r * rng.range(0.1, 0.4);
        batch.add(geo, rng.pick(mats), x, y, z);
      }
    }
    this.terrain.add(batch.build());
  }

  /** Outcrops on the near shelf and the stacked wall behind it, every rock resting on sand or on rock. */
  private buildRocks() {
    if (this.rocks) {
      this.terrain.remove(this.rocks);
      disposeTree(this.rocks);
    }
    const palette = this.map.rocks.map((c) => new THREE.Color(c));
    const material = flatMat('#ffffff', { vertexColors: true });
    const batch = new Batch();
    const tint = new THREE.Color();
    const shade = new THREE.Color();
    const add = (slot: RockSlot, detail: number) => {
      if (slot.tier > this.quality.detail) return;
      const rng = new Rng(slot.seed);
      const geo = rockGeometry(rng, slot.r, detail, slot.squash);
      const y = this.seabedY + slot.y;
      wallTint(rng.pick(palette), -y, tint);
      // Faces darken toward the buried underside, as on the trench walls.
      paintFaces(geo, (h) => shade.copy(tint).multiplyScalar((0.74 + 0.26 * h) * rng.range(0.86, 1.06)));
      batch.add(geo, material, slot.x, y, slot.z);
    };
    for (const slot of this.layout.outcrops) add(slot, 0);
    // The wall's big rocks take a finer cut so their silhouettes are not all the same solid.
    for (const slot of this.layout.stacks) add(slot, slot.r > 5 && slot.seed % 2 ? 1 : 0);
    this.rocks = batch.build();
    this.terrain.add(this.rocks);
    this.colorGrade.apply(this.rocks);
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
      // Coral lives mostly in the reef band, growing on the wall's rocks. On the floor it keeps to the shelf.
      const reef = this.layout.stacks.filter((rock) => {
        const depth = -(this.seabedY + rock.y);
        return depth > 14 && depth < 46 && Math.abs(rock.x) < HALF_WIDTH + 12;
      });
      if (rng.next() < 0.45 || !reef.length) {
        const x = shelfX(rng, -HALF_WIDTH, HALF_WIDTH, -2, 2);
        const z = rng.range(-12, 4);
        group.position.set(x, this.groundY(x, z) + 0.15, z);
      } else {
        // A point on the rock's upper face that looks toward the camera.
        const rock = rng.pick(reef);
        const around = rng.range(Math.PI * 0.15, Math.PI * 0.85);
        const lift = rng.range(0.25, 1.2);
        const out = Math.cos(lift) * rock.r * 0.9;
        group.position.set(
          rock.x + Math.cos(around) * out,
          this.seabedY + rock.y + Math.sin(lift) * rock.r * rock.squash * 0.9,
          rock.z + Math.sin(around) * out,
        );
      }
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
      const z = rng.range(-14, 4);
      log.position.set(x, this.groundY(x, z) + (standing ? -0.3 : r * 0.6), z);
      this.terrain.add(log);
    }
    // Rock ledges jut out of the wall's stacks, toward the camera.
    const hosts = this.layout.stacks.filter((rock) => rock.r >= 3);
    for (let i = 0; i < 16 && hosts.length; i++) {
      const rock = rng.pick(hosts);
      const w = rng.range(7, 16);
      const d = rng.range(4, 7);
      const ledge = new THREE.Mesh(jitter(new THREE.BoxGeometry(w, rng.range(0.9, 1.8), d), rng, 0.5), flatMat(rng.pick(this.map.rocks)));
      ledge.position.set(
        rock.x + rng.range(-0.3, 0.3) * rock.r,
        this.seabedY + rock.y + rng.range(-0.3, 0.5) * rock.r * rock.squash,
        rock.z + rock.r * 0.6 + d * 0.15,
      );
      ledge.rotation.z = rng.range(-0.08, 0.08);
      this.terrain.add(ledge);
    }
  }

  /** Plant the bed for the current quality: the first so many of the layout's kelp and low plants. */
  private buildKelp() {
    if (this.kelp) {
      this.terrain.remove(this.kelp.mesh);
      this.kelp.dispose();
    }
    const tall = Math.min(this.map.kelp.count, this.quality.kelpCount);
    const low = Math.round(tall * FLORA[this.map.id].undergrowth);
    const plants: KelpPlant[] = [];
    const plant = (slot: SeabedLayout['canopy'][number], species: KelpPlant['species']) => {
      const y = this.seabedY + slot.y;
      plants.push({ x: slot.x, y, z: slot.z, seed: slot.seed, species, height: plantHeight(species, slot.vigor, -y) });
    };
    for (const slot of this.layout.canopy.slice(0, tall)) plant(slot, 'giant');
    for (const slot of this.layout.understory.slice(0, low)) plant(slot, slot.species);
    this.kelp = new KelpBed(plants, FLORA[this.map.id], this.quality.detail);
    this.terrain.add(this.kelp.mesh);
    this.colorGrade.apply(this.kelp.mesh);
  }

  /** Tell the world where the diver is, so the plants around them part and trail in their wake. */
  setDiver(position: THREE.Vector3, velocity: THREE.Vector3) {
    this.diverPos.copy(position);
    this.diverVel.copy(velocity);
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
      // Chunks are built after setMap graded the scene; the shared wall materials only hook in once.
      this.colorGrade.apply(chunk);
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

  private buildSnow(rng: Rng) {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    const [lo, hi] = snowBand(this.lastCameraY);
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
    const mat = new WaterSurfaceMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, -30);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    return mesh;
  }

  private surfaceGeometry() {
    return waterGeometry(HALF_WIDTH * 2 + 160, 120, this.quality.surfaceSegments);
  }

  setQuality(quality: RenderQuality) {
    const surfaceChanged = this.quality.surfaceSegments !== quality.surfaceSegments;
    const detailChanged = this.quality.detail !== quality.detail;
    const plantsChanged = detailChanged || this.quality.kelpCount !== quality.kelpCount;
    this.quality = quality;
    this.rain.setQuality(quality);
    this.shafts.setQuality(quality);
    // setMap builds both for the quality in force and then calls this with it unchanged.
    if (plantsChanged && this.kelp) this.buildKelp();
    if (detailChanged && this.rocks) this.buildRocks();
    this.snow.geometry.setDrawRange(0, quality.snowCount);
    if (surfaceChanged) {
      const old = this.surface.geometry;
      this.surface.geometry = this.surfaceGeometry();
      old.dispose();
    }
    if (detailChanged && this.scenery) {
      const { visible } = this.scenery.group;
      this.scene.remove(this.scenery.group);
      disposeTree(this.scenery.group, this.scene);
      this.scenery = buildScenery(this.map, quality.detail);
      this.colorGrade.apply(this.scenery.group);
      this.scenery.group.visible = visible;
      this.updateScenery(this.lastDecorationTime, 0);
      this.scene.add(this.scenery.group);
      // The new shore's materials missed setMap's grading pass.
      this.colorGrade.apply(this.scenery.group);
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
    boat.position.set(0, 0.2, 0);
    this.scene.add(boat);
    return boat;
  }

  get night(): boolean {
    return this.lighting.nightMix > 0.55;
  }

  setTimeOfDay(mode: TimeOfDay) {
    this.dayCycle.setMode(mode);
  }

  setWeather(mode: WeatherMode) {
    this.weather.setMode(mode);
  }

  get lightingEffectsEnabled(): boolean {
    return this.lightingEffects;
  }

  setLightingEffects(enabled: boolean) {
    this.lightingEffects = enabled;
    this.sun.visible = enabled;
    (this.surface.material as WaterSurfaceMaterial).setEffectsEnabled(enabled);
    if (!enabled) this.shafts.group.visible = false;
  }

  advanceTime(dt: number, running = true) {
    this.lighting = this.dayCycle.advance(dt, running);
    const weather = this.weather.advance(dt, running);
    if (running && Number.isFinite(dt) && dt > 0) {
      this.weatherTime += dt;
      this.cloudTime += dt * (0.15 + weather.wind * 0.5);
      this.waveTime += dt * (1 + weather.wind * 0.35);
    }
  }

  update(time: number, cameraY: number, cameraX = 0) {
    this.updateTrench(cameraY);
    const elapsed = time - this.lastDecorationTime;
    const tick = elapsed + 1e-6 >= 1 / this.quality.decorationHz;
    if (tick) {
      this.updateDecorations(Math.min(elapsed, 0.25), cameraY);
      this.lastDecorationTime = time;
    }
    this.updateLighting(time, cameraY, cameraX, tick ? Math.min(elapsed, 0.25) : null);
  }

  /**
   * Sky, light, fog and water for this frame. `sceneryDt` moves the shoreline on by
   * that many seconds; null (between decoration ticks) leaves it as it is, and 0
   * (paused, or a fresh map) re-poses it so a changed setting still shows.
   */
  updateLighting(time: number, cameraY: number, cameraX = 0, sceneryDt: number | null = 0) {
    // Float on the sea clock even while the shipyard pauses gameplay physics.
    this.boat.position.y = 0.25 + Math.sin(this.waveTime * 1.3) * 0.18 * this.swell() * this.map.waves;
    this.boat.rotation.z = Math.sin(this.waveTime * 1.1) * 0.05 * this.swell() * this.map.waves;
    this.lastSceneTime = time;
    this.lastCameraY = cameraY;
    this.lastCameraX = cameraX;
    const weather = this.weather.state;
    const baseLight = this.lighting;
    const overcast = weather.cloud * 0.85;
    const mixSky = (color: readonly number[], day: readonly number[], night: readonly number[]): [number, number, number] =>
      color.map((c, i) => {
        const tint = THREE.MathUtils.lerp(this.daySkyTint[i], this.nightSkyTint[i], baseLight.nightMix);
        const overcastColor = THREE.MathUtils.lerp(day[i], night[i], baseLight.nightMix);
        return THREE.MathUtils.clamp(THREE.MathUtils.lerp(c, overcastColor, overcast) * tint, 0, 1);
      }) as [number, number, number];
    const lighting: LightingState = {
      ...baseLight,
      skyColor: mixSky(baseLight.skyColor, [0.36, 0.44, 0.51], [0.04, 0.065, 0.12]),
      horizonColor: mixSky(baseLight.horizonColor, [0.57, 0.63, 0.67], [0.08, 0.12, 0.19]),
      sunIntensity: baseLight.sunIntensity * (1 - weather.cloud * 0.88),
      ambientIntensity: baseLight.ambientIntensity * (1 - weather.cloud * 0.28),
    };
    this.skyColor.setRGB(...lighting.skyColor, THREE.SRGBColorSpace);
    this.horizonColor.setRGB(...lighting.horizonColor, THREE.SRGBColorSpace);
    this.atmosphere.update(lighting, weather, cameraY, cameraX, this.cloudTime, this.quality);
    this.colorGrade.update(lighting, weather, cameraY, this.lightingEffects);

    // The same continuous light state drives both sides of the waterline.
    const depth = -cameraY;
    const fog = this.scene.fog as THREE.Fog;
    if (depth < 0) {
      this.scene.background = this.horizonColor;
      fog.color.copy(this.horizonColor);
      fog.near = this.map.haze[0] * THREE.MathUtils.lerp(1, 0.45, weather.rain);
      fog.far = this.map.haze[1] * THREE.MathUtils.lerp(1, 0.475, weather.rain);
    } else {
      this.waterBackground.copy(waterColorAt(depth));
      this.waterBackground.lerp(this.horizonColor, 0.06 * Math.max(0, 1 - depth / 60));
      this.waterBackground.multiplyScalar(THREE.MathUtils.lerp(1, 0.35, lighting.nightMix) * (1 - weather.cloud * 0.12));
      this.scene.background = this.waterBackground;
      fog.color.copy(this.waterBackground);
      fog.near = 6;
      fog.far = underwaterFogFar(depth, -this.seabedY);
    }
    const light = THREE.MathUtils.clamp(1 - depth / 75, 0.12, 1);
    this.sun.color.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    this.hemi.color.copy(this.skyColor).lerp(this.horizonColor, 0.3);
    // Sky pixels are dark at night; use their hue without losing all fill light.
    this.hemi.color.lerp(this.sun.color, 0.2 + 0.6 * lighting.nightMix);
    this.hemi.intensity = lighting.ambientIntensity * light;
    this.sun.position.set(...lighting.direction).multiplyScalar(80);
    this.sun.intensity = lighting.sunIntensity * light * light;
    if (this.scenery) {
      // Nothing above the water is visible once the camera is under it.
      this.scenery.group.visible = depth < 1;
      if (sceneryDt !== null && this.scenery.group.visible) this.updateScenery(time, sceneryDt);
    }
    this.shafts.update(this.waveTime, lighting, weather, cameraY, this.lightingEffects);
    (this.snow.material as THREE.PointsMaterial).color.set('#e8fbff').lerp(this.sun.color, 0.3);
    const waterMaterial = this.surface.material as WaterSurfaceMaterial;
    waterMaterial.update(this.waveTime, lighting, cameraY, this.quality, weather, this.map.waves);
    waterMaterial.color.multiply(this.surfaceTint);
    this.rain.update(this.weatherTime, weather, cameraY, cameraX, lighting.nightMix);
    if (this.kelp) {
      // The swell that rocks the boat also moves the water under it.
      this.kelp.update(time, { wind: weather.wind, waveTime: this.waveTime, surge: 0.5 * this.swell() * this.map.waves });
      this.kelp.setDiver(this.diverPos, this.diverVel, THREE.MathUtils.smoothstep(-this.diverPos.y, 0.3, 1.8));
    }
  }

  /** Animate the shore by `dt` seconds (0 re-poses it) in the current weather, light setting and swell. */
  private updateScenery(time: number, dt: number) {
    if (!this.scenery) return;
    const env = this.sceneryEnv;
    env.weather = this.weather.state;
    // `state` is a fresh copy, so silencing the storm here touches nothing else.
    if (this.quietWeatherLightning) env.weather.storm = 0;
    env.lightingEffects = this.lightingEffects;
    env.waveTime = this.waveTime;
    env.swell = this.swell();
    this.scenery.update(time, this.night, dt, env);
  }

  /** How much the wind lifts the waves; the scenery's floats ride the same swell. */
  private swell() {
    return 1 + this.weather.state.wind * 0.75;
  }

  private updateDecorations(dt: number, cameraY: number) {
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

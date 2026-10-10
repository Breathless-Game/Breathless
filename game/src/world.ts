import * as THREE from 'three';
import { disposeTree, flatMat, jitter } from './lowpoly';
import { MAPS, mapDepth, type MapDef, type MapId } from './maps';
import { Rng } from './rng';
import { RENDER_QUALITY, type RenderQuality } from './render-quality';
import { buildScenery, type Scenery } from './scenery';

export const HALF_WIDTH = 70;

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

interface Kelp {
  root: THREE.Group;
  segments: THREE.Object3D[];
  phase: number;
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
  // Everything on and near the bottom. Rebuilt when the map changes.
  private terrain = new THREE.Group();
  private scenery: Scenery | null = null;
  private sky = new THREE.Color();
  private nightSky = new THREE.Color();
  map: MapDef;
  /** World y of the seabed for the current map (negative). */
  seabedY: number;
  night = false;

  constructor(quality: RenderQuality = RENDER_QUALITY.high, map: MapDef = MAPS.ocean) {
    this.quality = quality;
    this.map = map;
    this.seabedY = -mapDepth(map);
    const rng = new Rng(20261010);
    this.scene.fog = new THREE.Fog(waterColors[0][1], 8, 70);
    this.scene.background = waterColors[0][1].clone();

    this.hemi = new THREE.HemisphereLight('#d6f4ff', '#0a2a40', 1.4);
    this.sun = new THREE.DirectionalLight('#fff6dd', 2.2);
    this.sun.position.set(20, 60, 30);
    this.scene.add(this.hemi, this.sun);

    this.scene.add(this.terrain);
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
    const rng = new Rng(TERRAIN_SEED[map.id]);
    this.buildSeabed(rng);
    this.buildRocks(rng);
    if (map.life === 'coral') this.buildCoral(rng);
    if (map.life === 'logs') this.buildLogs(rng);
    this.buildKelp(rng);

    // Marine snow was spread over the old depth; respread it over the new one.
    const snowPos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < snowPos.count; i++) snowPos.setY(i, rng.range(this.seabedY, -0.5));
    snowPos.needsUpdate = true;

    if (this.scenery) {
      this.scene.remove(this.scenery.group);
      disposeTree(this.scenery.group);
    }
    this.scenery = buildScenery(map);
    this.scene.add(this.scenery.group);
    this.setQuality(this.quality);
  }

  private buildSeabed(rng: Rng) {
    const geo = new THREE.PlaneGeometry(HALF_WIDTH * 2 + 120, 90, 80, 30);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = Math.sin(x * 0.08) * 2.2 + Math.cos(z * 0.15 + x * 0.03) * 1.5 + rng.range(-0.6, 0.6);
      pos.setY(i, h);
    }
    const g = geo.toNonIndexed();
    g.computeVertexNormals();
    const colors: number[] = [];
    const sand = new THREE.Color(this.map.sand);
    for (let i = 0; i < g.attributes.position.count; i += 3) {
      const c = sand.clone().multiplyScalar(rng.range(0.75, 1.05));
      for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(g, flatMat('#ffffff', { vertexColors: true }));
    mesh.position.set(0, this.seabedY, -25);
    this.terrain.add(mesh);
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
    // A few foreground boulders on the seabed.
    for (let i = 0; i < 16; i++) {
      const r = rng.range(1.5, 4);
      const mesh = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(r, 0), rng, r * 0.2), flatMat(rng.pick(palette)));
      mesh.position.set(rng.range(-HALF_WIDTH, HALF_WIDTH), this.seabedY + r * 0.4, rng.range(-6, 6));
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
      // Coral lives mostly in the reef band.
      const onFloor = rng.next() < 0.45;
      const y = onFloor ? this.seabedY + 1 : -rng.range(16, 42);
      group.position.set(rng.range(-HALF_WIDTH, HALF_WIDTH), y, onFloor ? rng.range(-12, 4) : rng.range(-16, -9));
      group.rotation.y = rng.range(0, Math.PI * 2);
      this.terrain.add(group);
    }
  }

  /** Heaven Lake's "sunken forest": drowned trunks on the bottom and rock shelves on the back wall. */
  private buildLogs(rng: Rng) {
    const bark = [flatMat('#4a3b2a'), flatMat('#5c4a36'), flatMat('#3a2e22')];
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
      // Most lie fallen on the bottom; some still stand, leaning.
      const standing = rng.next() < 0.3;
      log.rotation.set(rng.range(-0.2, 0.2), rng.range(0, 6), standing ? rng.range(-0.35, 0.35) : Math.PI / 2 + rng.range(-0.15, 0.15));
      log.position.set(rng.range(-HALF_WIDTH, HALF_WIDTH), this.seabedY + (standing ? 0 : r), rng.range(-14, 4));
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
      root.position.set(rng.range(-HALF_WIDTH - 10, HALF_WIDTH + 10), this.seabedY + 0.5, z);
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
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rng.range(-HALF_WIDTH - 20, HALF_WIDTH + 20);
      pos[i * 3 + 1] = rng.range(this.seabedY, -0.5);
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
    const elapsed = time - this.lastDecorationTime;
    if (elapsed + 1e-6 >= 1 / this.quality.decorationHz) {
      this.updateDecorations(time, Math.min(elapsed, 0.25));
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
      fog.far = THREE.MathUtils.lerp(70, 34, Math.min(1, depth / 60));
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

  private updateDecorations(time: number, dt: number) {
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

    const snowPos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < this.quality.snowCount; i++) {
      let y = snowPos.getY(i) - 0.24 * dt;
      if (y < this.seabedY) y = -0.5;
      snowPos.setY(i, y);
    }
    snowPos.addUpdateRange(0, this.quality.snowCount * 3);
    snowPos.needsUpdate = true;
  }
}

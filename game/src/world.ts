import * as THREE from 'three';
import { Rng } from './rng';
import { RENDER_QUALITY, type RenderQuality } from './render-quality';
import { DayCycle, type LightingState, type TimeOfDay } from './daylight';
import { WaterSurfaceMaterial } from './water';

export const HALF_WIDTH = 70;
export const SEABED_Y = -60;

const WATER_COLORS: [number, THREE.Color][] = [
  [0, new THREE.Color('#46c1d6')],
  [12, new THREE.Color('#1f86a8')],
  [30, new THREE.Color('#0d4d73')],
  [45, new THREE.Color('#06213f')],
  [60, new THREE.Color('#020a1a')],
];

export function waterColorAt(depth: number, night = false): THREE.Color {
  const d = THREE.MathUtils.clamp(depth, 0, 60);
  let c = WATER_COLORS[WATER_COLORS.length - 1][1].clone();
  for (let i = 0; i < WATER_COLORS.length - 1; i++) {
    const [d0, c0] = WATER_COLORS[i];
    const [d1, c1] = WATER_COLORS[i + 1];
    if (d >= d0 && d <= d1) {
      c = c0.clone().lerp(c1, (d - d0) / (d1 - d0));
      break;
    }
  }
  if (night) c.multiplyScalar(0.35);
  return c;
}

function flatMat(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, ...extra });
}

/** Jitter vertices of a non-indexed geometry so primitives read as rocks. */
function jitter(geo: THREE.BufferGeometry, rng: Rng, amount: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let off = seen.get(key);
    if (!off) {
      off = new THREE.Vector3(rng.range(-amount, amount), rng.range(-amount, amount), rng.range(-amount, amount));
      seen.set(key, off);
    }
    pos.setXYZ(i, pos.getX(i) + off.x, pos.getY(i) + off.y, pos.getZ(i) + off.z);
  }
  g.computeVertexNormals();
  return g;
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
  private lightingEffects = true;
  private lastDecorationTime = 0;
  readonly dayCycle = new DayCycle();
  private lighting: LightingState = this.dayCycle.state;
  private skyColor = new THREE.Color();
  private horizonColor = new THREE.Color();
  private waterBackground = new THREE.Color();
  private skyCanvas = document.createElement('canvas');
  private skyTexture: THREE.CanvasTexture;
  private skyRefresh = 0;

  constructor(quality: RenderQuality = RENDER_QUALITY.high) {
    this.quality = quality;
    this.skyCanvas.width = 2;
    this.skyCanvas.height = 128;
    this.skyTexture = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTexture.colorSpace = THREE.SRGBColorSpace;
    this.skyTexture.minFilter = THREE.LinearFilter;
    this.skyTexture.generateMipmaps = false;
    const rng = new Rng(20261010);
    this.scene.fog = new THREE.Fog(WATER_COLORS[0][1], 8, 70);
    this.scene.background = WATER_COLORS[0][1].clone();

    this.hemi = new THREE.HemisphereLight('#d6f4ff', '#0a2a40', 1.4);
    this.sun = new THREE.DirectionalLight('#fff6dd', 2.2);
    this.sun.position.set(20, 60, 30);
    this.scene.add(this.hemi, this.sun);

    this.buildSeabed(rng);
    this.buildRocks(rng);
    this.buildCoral(rng);
    this.buildKelp(rng);
    this.buildRays(rng);
    this.snow = this.buildSnow(rng);
    this.surface = this.buildSurface();
    this.surfaceBase = (this.surface.geometry.attributes.position.array as Float32Array).slice();
    this.boat = this.buildBoat();
    this.setQuality(quality);
    this.updateLighting(0, 1.5);
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
    const sand = new THREE.Color('#c2a874');
    for (let i = 0; i < g.attributes.position.count; i += 3) {
      const c = sand.clone().multiplyScalar(rng.range(0.75, 1.05));
      for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(g, flatMat('#ffffff', { vertexColors: true }));
    mesh.position.set(0, SEABED_Y, -25);
    this.scene.add(mesh);
  }

  private buildRocks(rng: Rng) {
    const palette = ['#5d6f7a', '#4a5b68', '#6b7d85', '#3e4c59'];
    // Back cliff walls at different depths give the 2.5D parallax.
    for (let i = 0; i < 70; i++) {
      const r = rng.range(2.5, 9);
      const geo = jitter(new THREE.IcosahedronGeometry(r, rng.next() < 0.5 ? 0 : 1), rng, r * 0.18);
      const mesh = new THREE.Mesh(geo, flatMat(rng.pick(palette)));
      const y = SEABED_Y + Math.pow(rng.next(), 1.6) * 50;
      mesh.position.set(rng.range(-HALF_WIDTH - 20, HALF_WIDTH + 20), y, rng.range(-38, -14));
      mesh.rotation.set(rng.range(0, 6), rng.range(0, 6), rng.range(0, 6));
      mesh.scale.y = rng.range(0.6, 1.3);
      this.scene.add(mesh);
    }
    // A few foreground boulders on the seabed.
    for (let i = 0; i < 16; i++) {
      const r = rng.range(1.5, 4);
      const mesh = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(r, 0), rng, r * 0.2), flatMat(rng.pick(palette)));
      mesh.position.set(rng.range(-HALF_WIDTH, HALF_WIDTH), SEABED_Y + r * 0.4, rng.range(-6, 6));
      this.scene.add(mesh);
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
      const y = onFloor ? SEABED_Y + 1 : -rng.range(16, 42);
      group.position.set(rng.range(-HALF_WIDTH, HALF_WIDTH), y, onFloor ? rng.range(-12, 4) : rng.range(-16, -9));
      group.rotation.y = rng.range(0, Math.PI * 2);
      this.scene.add(group);
    }
  }

  private buildKelp(rng: Rng) {
    for (let i = 0; i < 55; i++) {
      const root = new THREE.Group();
      const z = rng.next() < 0.25 ? rng.range(4, 8) : rng.range(-14, -4);
      root.position.set(rng.range(-HALF_WIDTH - 10, HALF_WIDTH + 10), SEABED_Y + 0.5, z);
      const color = new THREE.Color().setHSL(rng.range(0.22, 0.32), 0.55, rng.range(0.22, 0.35));
      const mat = flatMat(color, { side: THREE.DoubleSide });
      const count = rng.int(10, 26);
      const segLen = rng.range(1.4, 2.0);
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
      this.scene.add(root);
    }
  }

  private buildRays(rng: Rng) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const index = (y * canvas.width + x) * 4;
        pixels.data[index] = 255;
        pixels.data[index + 1] = 255;
        pixels.data[index + 2] = 240;
        // Fade across the width as well as the depth, avoiding hard light strips.
        pixels.data[index + 3] = 76 * Math.sin(Math.PI * (x + 0.5) / canvas.width) ** 2 * (1 - y / canvas.height) ** 1.5;
      }
    }
    ctx.putImageData(pixels, 0, 0);
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
      ray.position.set(rng.range(-HALF_WIDTH, HALF_WIDTH), -18, rng.range(-14, -3));
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
      pos[i * 3 + 1] = rng.range(SEABED_Y, -0.5);
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
      if (kelp.root.visible) this.scene.add(kelp.root);
      else this.scene.remove(kelp.root);
    });
    this.rays.forEach((ray, i) => {
      ray.visible = this.lightingEffects && i < quality.rayCount && (ray.material as THREE.MeshBasicMaterial).opacity > 0;
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
    const hullGeo = new THREE.CylinderGeometry(1.6, 0.9, 1.2, 6, 1);
    hullGeo.rotateZ(Math.PI / 2);
    hullGeo.scale(2.4, 1, 1);
    const hull = new THREE.Mesh(hullGeo, flatMat('#c0573e'));
    hull.scale.set(1, 0.9, 0.55);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.2, 1.6), flatMat('#e8d5b0'));
    deck.position.y = 0.55;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2, 1.4, 1.3), flatMat('#f3efe6'));
    cabin.position.set(-0.8, 1.35, 0);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.6, 4), flatMat('#2f6f8f'));
    roof.position.set(-0.8, 2.35, 0);
    roof.rotation.y = Math.PI / 4;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), flatMat('#ffcc4d', { side: THREE.DoubleSide }));
    flag.position.set(2.2, 2.2, 0);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 4), flatMat('#6b4f3a'));
    mast.position.set(1.8, 1.6, 0);
    boat.add(hull, deck, cabin, roof, mast, flag);
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

  setLightingEffects(enabled: boolean) {
    this.lightingEffects = enabled;
    this.sun.visible = enabled;
    (this.surface.material as WaterSurfaceMaterial).setEffectsEnabled(enabled);
    if (!enabled) this.rays.forEach((ray) => { ray.visible = false; });
  }

  advanceTime(dt: number, running = true) {
    this.lighting = this.dayCycle.advance(dt, running);
    this.skyRefresh -= dt;
  }

  update(time: number, cameraY: number) {
    const elapsed = time - this.lastDecorationTime;
    if (elapsed + 1e-6 >= 1 / this.quality.decorationHz) {
      this.updateDecorations(time, Math.min(elapsed, 0.25));
      this.lastDecorationTime = time;
    }
    this.updateLighting(time, cameraY);
  }

  updateLighting(time: number, cameraY: number) {
    const lighting = this.lighting;
    this.skyColor.setRGB(...lighting.skyColor, THREE.SRGBColorSpace);
    this.horizonColor.setRGB(...lighting.horizonColor, THREE.SRGBColorSpace);
    if (this.skyRefresh <= 0) {
      const ctx = this.skyCanvas.getContext('2d')!;
      const gradient = ctx.createLinearGradient(0, 0, 0, this.skyCanvas.height);
      gradient.addColorStop(0, this.skyColor.getStyle());
      gradient.addColorStop(1, this.horizonColor.getStyle());
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, this.skyCanvas.width, this.skyCanvas.height);
      this.skyTexture.needsUpdate = true;
      this.skyRefresh = 1 / this.quality.skyRefreshHz;
    }

    // The same continuous light state drives both sides of the waterline.
    const depth = -cameraY;
    const fog = this.scene.fog as THREE.Fog;
    if (depth < 0) {
      this.scene.background = this.skyTexture;
      fog.color.copy(this.horizonColor);
      fog.near = 40;
      fog.far = 200;
    } else {
      this.waterBackground.copy(waterColorAt(depth));
      this.waterBackground.lerp(this.horizonColor, 0.06 * Math.max(0, 1 - depth / 60));
      this.waterBackground.multiplyScalar(THREE.MathUtils.lerp(1, 0.35, lighting.nightMix));
      this.scene.background = this.waterBackground;
      fog.color.copy(this.waterBackground);
      fog.near = 6;
      fog.far = THREE.MathUtils.lerp(70, 34, Math.min(1, depth / 60));
    }
    const light = THREE.MathUtils.clamp(1 - depth / 75, 0.12, 1);
    this.sun.color.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    this.hemi.color.copy(this.skyColor).lerp(this.horizonColor, 0.3);
    // Sky pixels are dark at night; use their hue without losing all fill light.
    this.hemi.color.lerp(this.sun.color, 0.2 + 0.6 * lighting.nightMix);
    this.hemi.intensity = lighting.ambientIntensity * light;
    this.sun.position.set(...lighting.direction).multiplyScalar(80);
    this.sun.intensity = lighting.sunIntensity * light * light;
    const rayOpacity = this.lightingEffects ? 0.35 * lighting.daylight * THREE.MathUtils.clamp(1 - depth / 35, 0, 1) : 0;
    this.rays.forEach((ray, i) => {
      ray.visible = i < this.quality.rayCount && rayOpacity > 0;
      const material = ray.material as THREE.MeshBasicMaterial;
      material.opacity = rayOpacity;
      material.color.copy(this.sun.color);
      ray.rotation.z = -Math.atan2(lighting.direction[0], Math.max(0.1, lighting.direction[1])) * 0.3;
    });
    (this.snow.material as THREE.PointsMaterial).color.set('#e8fbff').lerp(this.sun.color, 0.3);
    (this.surface.material as WaterSurfaceMaterial).update(time, lighting, cameraY, this.quality);
  }

  private updateDecorations(time: number, dt: number) {
    // Waves.
    const pos = this.surface.geometry.attributes.position;
    const base = this.surfaceBase;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const z = base[i * 3 + 2];
      pos.setY(i, Math.sin(x * 0.15 + time * 1.3) * 0.35 + Math.cos(z * 0.2 + time * 0.9) * 0.25);
    }
    pos.needsUpdate = true;
    this.surface.geometry.computeVertexNormals();

    this.boat.position.y = 0.25 + Math.sin(time * 1.3) * 0.18;
    this.boat.rotation.z = Math.sin(time * 1.1) * 0.05;

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
      if (y < SEABED_Y) y = -0.5;
      snowPos.setY(i, y);
    }
    snowPos.addUpdateRange(0, this.quality.snowCount * 3);
    snowPos.needsUpdate = true;
  }
}

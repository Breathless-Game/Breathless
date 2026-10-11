import * as THREE from 'three';

// Pooled effects shared by the world events (events.ts): soft particles and
// foam rings. Each pool is one draw call, allocated once at a fixed capacity
// and hidden whenever nothing in it is alive. Nothing here allocates per frame.

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** 0 → 1 → 0 over [0, 1]: quick rise, long tail. */
export const pulse = (t: number, rise: number) => (t < rise ? smoothstep(0, rise, t) : Math.max(0, 1 - (t - rise) / (1 - rise)));

/** How far the scene fog has swallowed something `dist` away (0 clear, 1 gone). */
export function fogAmount(scene: THREE.Scene, dist: number): number {
  const fog = scene.fog as THREE.Fog | null;
  if (!fog || !(fog as THREE.Fog).isFog) return 0;
  return clamp01((dist - fog.near) / Math.max(1e-3, fog.far - fog.near));
}

/** Free everything under `root`, including instanced buffers. Textures are owned elsewhere. */
export function disposeAll(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
  });
}

// ---- Sprite textures ----------------------------------------------------

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A soft round puff, opaque in the middle. */
export function softTexture() {
  return canvasTexture(64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

/** A bubble: bright rim, clear middle, a highlight up-left. */
export function bubbleTexture() {
  return canvasTexture(64, (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, s * 0.18, c, c, s * 0.46);
    grad.addColorStop(0, 'rgba(255,255,255,0.08)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.35)');
    grad.addColorStop(0.92, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(c, c, s * 0.48, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.arc(c - s * 0.14, c - s * 0.14, s * 0.08, 0, Math.PI * 2);
    g.fill();
  });
}

// ---- Particles ----------------------------------------------------------

const VERTEX = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
uniform float uLight;
varying float vAlpha;
varying vec3 vColor;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(0.05, -mvPosition.z) : 0.0;
  vAlpha = aAlpha;
  vColor = aColor * uLight;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
varying float vAlpha;
varying vec3 vColor;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(uMap, gl_PointCoord);
  float a = tex.a * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * tex.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface ParticleOptions {
  capacity: number;
  texture: THREE.Texture;
  additive?: boolean;
  fog?: boolean;
  /** Side-to-side wander in units per second (bubbles). */
  wobble?: number;
}

/**
 * A fixed-size pool of soft point sprites. Dead points draw at size 0; the
 * Points object hides itself when nothing is alive.
 */
export class Particles {
  readonly points: THREE.Points;
  readonly capacity: number;
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private color: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private alpha0: Float32Array;
  private lift: Float32Array;
  private drag: Float32Array;
  private floor: Float32Array;
  private ceiling: Float32Array;
  private cursor = 0;
  private alive = 0;
  private wobble: number;
  private time = 0;
  private material: THREE.ShaderMaterial;
  private bufferSize = new THREE.Vector2();

  constructor(opts: ParticleOptions) {
    const n = (this.capacity = opts.capacity);
    this.wobble = opts.wobble ?? 0;
    this.pos = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.alpha0 = new Float32Array(n);
    this.lift = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.floor = new Float32Array(n);
    this.ceiling = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    const dyn = (arr: Float32Array, item: number) => new THREE.BufferAttribute(arr, item).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', dyn(this.pos, 3));
    geo.setAttribute('aSize', dyn(this.size, 1));
    geo.setAttribute('aAlpha', dyn(this.alpha, 1));
    geo.setAttribute('aColor', dyn(this.color, 3));

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uScale: { value: 500 }, uLight: { value: 1 }, uOpacity: { value: 1 } },
    ]);
    // Set after merging: merge() would clone the texture into a second upload.
    uniforms.uMap = { value: opts.texture };
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: opts.fog ?? true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 2;
    // Size attenuation needs the drawing-buffer height and the camera's focal length.
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this.bufferSize);
      const focal = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
      this.material.uniforms.uScale.value = this.bufferSize.y * 0.5 * focal;
    };
  }

  /** Lighting multiplier for the colours (dim at night and in the deep). */
  set light(v: number) {
    this.material.uniforms.uLight.value = v;
  }

  get count() {
    return this.alive;
  }

  /**
   * Launch one particle. Sizes are world-unit diameters at birth and death;
   * `lift` is upward acceleration (negative falls), `drag` damps velocity per
   * second. It dies early if it falls below `floor` (spray back into the sea)
   * or rises above `ceiling` (bubbles at the surface).
   */
  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number, alpha: number, color: THREE.Color,
    lift = 0, drag = 0, floor = -Infinity, ceiling = Infinity,
  ) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.life[i] <= 0) this.alive++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, life);
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.alpha0[i] = alpha;
    this.size[i] = size0;
    this.alpha[i] = 0;
    this.lift[i] = lift;
    this.drag[i] = drag;
    this.floor[i] = floor;
    this.ceiling[i] = ceiling;
    color.toArray(this.color, i3);
    (this.points.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = true;
  }

  update(dt: number) {
    if (this.alive === 0) {
      this.points.visible = false;
      return;
    }
    this.time += dt;
    const w = this.wobble;
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      const a = (this.age[i] += dt);
      const i3 = i * 3;
      const u = a / this.life[i];
      if (u >= 1 || (this.vel[i3 + 1] < 0 && this.pos[i3 + 1] < this.floor[i]) || this.pos[i3 + 1] > this.ceiling[i]) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      alive++;
      const damp = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = (this.vel[i3 + 1] + this.lift[i] * dt) * damp;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (w > 0) {
        this.pos[i3] += Math.sin(this.time * 7 + i * 1.7) * w * dt;
        this.pos[i3 + 2] += Math.cos(this.time * 6 + i * 2.3) * w * dt;
      }
      // Ease-out growth reads as billowing; fade in fast, out slowly.
      const grow = 1 - (1 - u) * (1 - u);
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * grow;
      this.alpha[i] = this.alpha0[i] * Math.min(1, u * 10) * (1 - u);
    }
    this.alive = alive;
    const attrs = this.points.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.aSize.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
    this.points.visible = alive > 0;
  }

  /** Kill everything and hide. */
  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.alive = 0;
    const attrs = this.points.geometry.attributes;
    attrs.aSize.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
    this.points.visible = false;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---- Foam rings ---------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Expanding foam rings on the water: one instanced mesh, additive, so each
 * ring fades by darkening its instance colour.
 */
export class Rings {
  readonly mesh: THREE.InstancedMesh;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  private radius: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private alive = 0;
  private cursor = 0;
  light = 1;

  constructor(capacity: number, segments: number, private scene: THREE.Scene, private camera: { x: number; y: number; z: number }) {
    const geo = new THREE.RingGeometry(0.82, 1, segments, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide,
      // Transparent double-sided materials otherwise draw in two passes.
      forceSinglePass: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.setRGB(0, 0, 0));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) this.hide(i);
  }

  spawn(x: number, y: number, z: number, radius: number, life: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.mesh.count;
    if (this.life[i] <= 0) this.alive++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.radius[i] = radius;
    this.age[i] = 0;
    this.life[i] = life;
    this.mesh.visible = true;
  }

  update(dt: number) {
    if (this.alive === 0) {
      this.mesh.visible = false;
      return;
    }
    let alive = 0;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.life[i] <= 0) continue;
      const u = (this.age[i] += dt) / this.life[i];
      if (u >= 1) {
        this.life[i] = 0;
        this.hide(i);
        continue;
      }
      alive++;
      const r = this.radius[i] * (0.15 + 0.85 * (1 - (1 - u) * (1 - u) * (1 - u)));
      _m.compose(_p.set(this.x[i], this.y[i], this.z[i]), _q.identity(), _s.set(r, 1, r));
      this.mesh.setMatrixAt(i, _m);
      const dx = this.x[i] - this.camera.x;
      const dy = this.y[i] - this.camera.y;
      const dz = this.z[i] - this.camera.z;
      const fade = (1 - u) * (1 - u) * (1 - fogAmount(this.scene, Math.sqrt(dx * dx + dy * dy + dz * dz))) * 0.8 * this.light;
      this.mesh.setColorAt(i, _c.setRGB(fade, fade, fade));
    }
    this.alive = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.visible = alive > 0;
  }

  clear() {
    for (let i = 0; i < this.mesh.count; i++) {
      this.life[i] = 0;
      this.hide(i);
    }
    this.alive = 0;
    this.mesh.visible = false;
  }

  private hide(i: number) {
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.setColorAt(i, _c.setRGB(0, 0, 0));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

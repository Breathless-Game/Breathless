import * as THREE from 'three';
import { Particles } from './fx';
import type { SceneryDetail } from './render-quality';

/** The marker and the throw use the same planar reach, including its strict boundary. */
export function catchTarget<T extends { pos: { x: number; y: number } }>(fish: readonly T[], point: { x: number; y: number }, reach: number): T | null {
  let best: T | null = null;
  let distance = reach * reach;
  if (!(reach > 0)) return null;
  for (const candidate of fish) {
    const dx = candidate.pos.x - point.x;
    const dy = candidate.pos.y - point.y;
    const d = dx * dx + dy * dy;
    if (d < distance) {
      best = candidate;
      distance = d;
    }
  }
  return best;
}

type FeedbackKind = 'catch' | 'miss' | 'bank' | 'full';
const KINDS: Record<FeedbackKind, number> = { catch: 1, miss: 2, bank: 3, full: 4 };
const CAPACITY = 9; // One target and eight overlapping action pulses, in one draw.

const VERTEX = /* glsl */ `
attribute vec4 aTiming;
attribute vec3 aTint;
uniform float uTime;
uniform float uAimAlpha;
varying vec2 vUv;
varying vec3 vTint;
varying float vKind;
varying float vAge;
varying float vAlpha;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv * 2.0 - 1.0;
  vTint = aTint;
  vKind = aTiming.z;
  vAge = clamp((uTime - aTiming.x) / max(0.001, aTiming.y), 0.0, 1.0);
  vAlpha = vKind < 0.5 ? uAimAlpha : (aTiming.y > 0.0 ? aTiming.w : 0.0);
  // Camera-facing quads retain their world size; they never reveal a fish through terrain.
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mvPosition.xy += position.xy * vec2(instanceMatrix[0][0], instanceMatrix[1][1]);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uMotion;
varying vec2 vUv;
varying vec3 vTint;
varying float vKind;
varying float vAge;
varying float vAlpha;
#include <common>
#include <fog_pars_fragment>
void main() {
  float radius = length(vUv);
  float angle = atan(vUv.y, vUv.x);
  float alpha;
  if (vKind < 0.5) {
    float brackets = smoothstep(0.24, 0.38, abs(sin(angle * 2.0)));
    float rim = 1.0 - smoothstep(0.016, 0.055, abs(radius - 0.64));
    alpha = rim * brackets * vAlpha * (0.72 + uMotion * 0.08 * sin(uTime * 3.0));
  } else {
    float expansion = 1.0 - pow(1.0 - vAge, 3.0);
    float ringRadius = mix(0.2, 0.78, expansion);
    float ring = 1.0 - smoothstep(0.012, 0.06, abs(radius - ringRadius));
    float glow = exp(-radius * radius * 14.0) * 0.38;
    float rays = smoothstep(0.96, 1.0, abs(sin(angle * 6.0 + vKind)));
    rays *= smoothstep(0.24, 0.38, radius) * (1.0 - smoothstep(0.48, 0.9, radius));
    // An empty throw is a quiet broken ripple; a full net uses an amber dashed ring.
    if (abs(vKind - 2.0) < 0.1) { ring *= smoothstep(0.1, 0.4, sin(angle * 3.0)); glow = 0.0; rays = 0.0; }
    if (vKind > 3.5) { ring *= step(0.0, sin(angle * 8.0)); glow = 0.0; rays = 0.0; }
    alpha = (ring + glow + rays * 0.28) * vAlpha;
    alpha *= smoothstep(0.0, 0.07, vAge) * pow(1.0 - vAge, 2.0);
  }
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      alpha *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      alpha *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vTint, min(alpha, 0.9));
  #include <colorspace_fragment>
}
`;

/** Pooled, local light feedback. No extra lights, render targets or per-frame allocations. */
export class CatchFeedback {
  readonly group = new THREE.Group();
  readonly rings: THREE.InstancedMesh;
  readonly sparks: Particles;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.DataTexture;
  private readonly timing = new Float32Array(CAPACITY * 4);
  private readonly tint = new Float32Array(CAPACITY * 3);
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private time = 0;
  private cursor = 1;
  private target = false;
  private effects = true;
  private reducedMotion = false;
  private detail: SceneryDetail = 2;

  constructor(private readonly scene: THREE.Scene) {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.setAttribute('aTiming', new THREE.InstancedBufferAttribute(this.timing, 4).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 }, uAimAlpha: { value: 0 }, uMotion: { value: 1 },
      }]),
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      transparent: true, depthWrite: false, fog: true, blending: THREE.AdditiveBlending,
    });
    this.rings = new THREE.InstancedMesh(geometry, this.material, CAPACITY);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 3;
    this.rings.visible = false;
    for (let i = 0; i < CAPACITY; i++) this.rings.setMatrixAt(i, this.matrix.makeScale(0, 0, 0));

    // A tiny procedural light mote. Unlike a canvas texture this also works in headless tests.
    const data = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      const r = Math.hypot((x - 7.5) / 7.5, (y - 7.5) / 7.5);
      data.set([255, 255, 255, Math.round(255 * Math.max(0, 1 - r) ** 2)], i);
    }
    this.texture = new THREE.DataTexture(data, 16, 16);
    this.texture.needsUpdate = true;
    this.sparks = new Particles({ capacity: 64, texture: this.texture, additive: true });
    this.group.name = 'catch-feedback';
    this.group.add(this.rings, this.sparks.points);
    scene.add(this.group);
  }

  aim(position: THREE.Vector3 | null, color = '#9ee8ef', radius = 1) {
    this.target = position !== null;
    if (!position) return;
    this.place(0, position, radius);
    this.color.set(color).toArray(this.tint, 0);
    this.rings.geometry.attributes.aTint.needsUpdate = true;
  }

  burst(kind: FeedbackKind, position: THREE.Vector3, color: string, weight = 1) {
    if (!this.effects || this.reducedMotion) return;
    const i = this.cursor;
    this.cursor = 1 + this.cursor % (CAPACITY - 1);
    const strength = THREE.MathUtils.clamp(weight, 1, 3);
    const bank = kind === 'bank';
    const life = bank ? 1.25 : kind === 'catch' ? 0.8 : 0.45;
    this.place(i, position, (bank ? 2.6 : 1.5) + strength * 0.18);
    this.timing.set([this.time, life, KINDS[kind], kind === 'miss' ? 0.35 : 0.85], i * 4);
    this.color.set(color).toArray(this.tint, i * 3);
    this.rings.geometry.attributes.aTiming.needsUpdate = true;
    this.rings.geometry.attributes.aTint.needsUpdate = true;
    this.rings.visible = true;
    if (kind === 'miss' || kind === 'full') return;
    const count = Math.round((bank ? 10 : 6) * this.detail * Math.sqrt(strength));
    for (let j = 0; j < count; j++) {
      const angle = j * Math.PI * 2 / count;
      const speed = 1.2 + (j % 3) * 0.35;
      this.sparks.spawn(position.x, position.y, position.z,
        Math.cos(angle) * speed, Math.sin(angle) * speed + (bank ? 0.8 : 0.35), (j % 3 - 1) * 0.3,
        life * (0.65 + (j % 4) * 0.1), 0.12, 0.025, 0.8, this.color, 0.35, 1.8);
    }
  }

  update(dt: number, effects: boolean, detail: SceneryDetail, reducedMotion = false) {
    this.time += Math.max(0, dt);
    this.effects = effects;
    this.detail = detail;
    this.reducedMotion = reducedMotion;
    const uniforms = this.material.uniforms;
    uniforms.uTime.value = this.time;
    uniforms.uMotion.value = effects && !reducedMotion ? 1 : 0;
    // The reach cue is information, so it remains static when decorative effects are off.
    uniforms.uAimAlpha.value = this.target ? 1 : 0;
    let active = this.target;
    for (let i = 1; i < CAPACITY; i++) {
      if ((!effects || reducedMotion) || this.time - this.timing[i * 4] >= this.timing[i * 4 + 1]) {
        this.timing[i * 4 + 1] = 0;
      } else active = true;
    }
    this.rings.geometry.attributes.aTiming.needsUpdate = true;
    this.rings.visible = active;
    if (!effects || reducedMotion) this.sparks.clear();
    else this.sparks.update(dt);
  }

  clear() {
    this.target = false;
    this.timing.fill(0);
    // Only slot zero is a target. Reused pulse quads must not turn into old target markers.
    for (let i = 1; i < CAPACITY; i++) this.timing[i * 4 + 2] = 1;
    this.material.uniforms.uAimAlpha.value = 0;
    this.rings.geometry.attributes.aTiming.needsUpdate = true;
    this.rings.visible = false;
    this.sparks.clear();
  }

  dispose() {
    this.scene.remove(this.group);
    this.rings.geometry.dispose();
    this.material.dispose();
    this.rings.dispose();
    this.sparks.dispose();
    this.texture.dispose();
  }

  private place(index: number, position: THREE.Vector3, radius: number) {
    this.matrix.makeScale(radius, radius, 1).setPosition(position);
    this.rings.setMatrixAt(index, this.matrix);
    this.rings.instanceMatrix.needsUpdate = true;
  }
}

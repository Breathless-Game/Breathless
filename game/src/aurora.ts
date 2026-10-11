import * as THREE from 'three';

// The northern lights: curtains of vertical rays, green along the lower edge
// and fading through teal to violet at the top. scenery.ts hangs them behind
// the fjord's peaks on some nights; events.ts flares them up.

/**
 * How much aurora is in the sky right now, for the water to reflect.
 * `ambient` is the scenery's own display and `surge` the event's flare, each 0..1.
 */
export const auroraGlow = { color: new THREE.Color('#4dffb0'), ambient: 0, surge: 0 };

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * How strongly the aurora shows at `time` (seconds), 0..1, before cloud. It comes in
 * displays a minute or two long with dark spells between them: three slow waves that
 * drift in and out of step. A slower wave quiets it for minutes at a time, so about
 * one night in seven (a night lasts 270 s) passes with no aurora at all.
 */
export function auroraActivity(time: number): number {
  const drive = 0.5 * Math.sin(time * 0.043 + 1.3) + 0.35 * Math.sin(time * 0.017 + 4.1) + 0.3 * Math.sin(time * 0.0071);
  return smoothstep(0.05, 0.45, drive) * smoothstep(-0.45, -0.05, Math.sin(time * 0.0116 + 0.6));
}

export interface CurtainOptions {
  /** Length along x, and how tall the rays stand. */
  width: number;
  height: number;
  /** Quads along its length; fine rays are shaded independently of this detail. */
  columns: number;
  /** Colours of the lower edge, the body and the fading top. */
  low?: THREE.ColorRepresentation;
  mid?: THREE.ColorRepresentation;
  high?: THREE.ColorRepresentation;
  phase?: number;
}

// More shape detail near the luminous hem; the fading crown needs fewer quads.
const ROWS = [0, 0.035, 0.1, 0.22, 0.42, 0.7, 1] as const;

/** One draw per ribbon: static geometry, with folds and fine light rays animated on the GPU. */
export class AuroraCurtain {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  phase: number;

  constructor(options: CurtainOptions) {
    this.phase = options.phase ?? 0;
    const { width, height, columns } = options;
    const count = (columns + 1) * ROWS.length;
    const positions = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const index: number[] = [];
    for (let c = 0; c <= columns; c++) {
      for (let r = 0; r < ROWS.length; r++) {
        const i = c * ROWS.length + r;
        positions[i * 3] = (c / columns - 0.5) * width;
        positions[i * 3 + 1] = ROWS[r] * height;
        uv[i * 2] = c / columns;
        uv[i * 2 + 1] = ROWS[r];
      }
      if (c === columns) continue;
      for (let r = 0; r < ROWS.length - 1; r++) {
        const a = c * ROWS.length + r, b = a + ROWS.length;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uStrength: { value: 0 }, uFlare: { value: 0 },
          uPhase: { value: this.phase }, uWidth: { value: width },
          uLow: { value: new THREE.Color(options.low ?? '#6dffa8') },
          uMid: { value: new THREE.Color(options.mid ?? '#39e69a') },
          uHigh: { value: new THREE.Color(options.high ?? '#8f5cf0') },
        },
        vertexShader: `
          uniform float uTime, uFlare, uPhase;
          varying vec2 vAuroraUv;
          void main() {
            vAuroraUv = uv;
            float x = position.x;
            float t = uTime * (1.0 + uFlare * 1.6);
            // Broad folds carry the light; fine rays never turn its crown into flames.
            float foot = sin(x * 0.03 + t * 0.12 + uPhase) * 5.0
              + sin(x * 0.065 - t * 0.08 + uPhase) * 1.6;
            float fold = sin(x * 0.018 + t * 0.16 + uPhase) * 12.0
              + sin(x * 0.06 + t * 0.10 + uPhase) * 3.0;
            vec3 p = position;
            p.y = foot + position.y * (0.94 + 0.06 * sin(x * 0.023 + uPhase) + uFlare * 0.35);
            p.z = fold - uv.y * 6.0;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uTime, uStrength, uFlare, uPhase, uWidth;
          uniform vec3 uLow, uMid, uHigh;
          varying vec2 vAuroraUv;
          void main() {
            float x = (vAuroraUv.x - 0.5) * uWidth;
            float h = vAuroraUv.y;
            float t = uTime * (1.0 + uFlare * 1.6);
            float flow = sin(x * 0.095 + t * 0.12 + uPhase)
              + sin(x * 0.027 - t * 0.08 + uPhase * 2.0);
            float rayPhase = x * 1.9 + flow * 2.4 + t * 0.32 + uPhase
              + h * (1.2 + 0.7 * sin(x * 0.04 + t * 0.09));
            float ray = pow(0.5 + 0.5 * sin(rayPhase), 6.0);
            // Subpixel rays dissolve into their average instead of flickering on small screens.
            ray = mix(ray, 0.226, smoothstep(0.7, 2.5, fwidth(rayPhase)));
            float band = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(x * 0.025 - t * 0.08 + uPhase * 2.0), 2.0);
            float ends = 1.0 - smoothstep(0.36, 0.5, abs(vAuroraUv.x - 0.5));
            float hem = smoothstep(0.0, 0.035, h);
            float crown = 1.0 - smoothstep(0.62, 1.0, h);
            float glow = hem * exp(-h * (2.6 + 0.6 * sin(x * 0.07 + t * 0.1))) * crown;
            vec3 tint = mix(uLow, uMid, smoothstep(0.03, 0.28, h));
            tint = mix(tint, uHigh, smoothstep(0.4, 0.95, h));
            // Additive blending uses the source alpha as its RGB factor. Keep the
            // alpha opaque so the carefully shaped light is not multiplied twice.
            float light = (0.32 + 0.68 * ray) * band * ends * glow * uStrength;
            gl_FragColor = vec4(tint * light * (1.0 + uFlare * 0.6), 1.0);
            #include <colorspace_fragment>
          }
        `,
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true,
      }),
    );
    // GPU folds extend beyond the static geometry's bounds.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * Draw the curtain as it stands at `time`. `strength` (0..1) is its brightness and 0 hides it;
   * `flare` (0..1) makes the rays taller, brighter and quicker.
   */
  update(time: number, strength: number, flare = 0) {
    const uniforms = this.mesh.material.uniforms;
    uniforms.uTime.value = time;
    uniforms.uStrength.value = THREE.MathUtils.clamp(strength, 0, 1);
    uniforms.uFlare.value = THREE.MathUtils.clamp(flare, 0, 1);
    uniforms.uPhase.value = this.phase;
    this.mesh.visible = uniforms.uStrength.value > 0.01;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

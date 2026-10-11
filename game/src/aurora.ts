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
  /** Quads along its length. Each ray is about four of them wide. */
  columns: number;
  /** Colours of the lower edge, the body and the fading top. */
  low?: THREE.ColorRepresentation;
  mid?: THREE.ColorRepresentation;
  high?: THREE.ColorRepresentation;
  phase?: number;
}

// Heights of the four rows of vertices, as a share of the curtain's height, and how bright each is.
const ROWS = [0, 0.2, 0.58, 1] as const;
const GLOW = [0.8, 0.6, 0.3, 0] as const;

/** One curtain: a folded ribbon standing on its lower edge, redrawn on the CPU a few dozen vertices at a time. */
export class AuroraCurtain {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  phase: number;
  private readonly columns: number;
  private readonly width: number;
  private readonly height: number;
  private readonly tints: THREE.Color[];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;

  constructor(options: CurtainOptions) {
    this.columns = options.columns;
    this.width = options.width;
    this.height = options.height;
    this.phase = options.phase ?? 0;
    const low = new THREE.Color(options.low ?? '#6dffa8');
    const mid = new THREE.Color(options.mid ?? '#39e69a');
    const high = new THREE.Color(options.high ?? '#8f5cf0');
    this.tints = [low, low.clone().lerp(mid, 0.6), mid.clone().lerp(high, 0.7), high];

    const count = (this.columns + 1) * ROWS.length;
    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    const index: number[] = [];
    for (let c = 0; c < this.columns; c++) {
      for (let r = 0; r < ROWS.length - 1; r++) {
        const a = c * ROWS.length + r, b = a + ROWS.length;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true,
      }),
    );
    // It waves far outside the bounds it was built with.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * Draw the curtain as it stands at `time`. `strength` (0..1) is its brightness and 0 hides it;
   * `flare` (0..1) makes the rays taller, brighter and quicker.
   */
  update(time: number, strength: number, flare = 0) {
    this.mesh.visible = strength > 0.01;
    if (!this.mesh.visible) return;
    const { columns, width, height, phase, positions, colors, tints } = this;
    const spacing = width / columns;
    // A ray every four columns, so it survives however coarse the curtain is.
    const rayPitch = (Math.PI * 2) / (spacing * 4);
    const pace = 1 + flare * 1.6;
    for (let c = 0; c <= columns; c++) {
      const x = (c / columns - 0.5) * width;
      // Rays drift sideways and their spacing breathes, so they never march in step.
      const ray = Math.pow(0.5 + 0.5 * Math.sin(x * rayPitch + Math.sin(x * 0.07 + time * 0.2 * pace) * 3 + time * 0.6 * pace + phase), 2);
      // Long bright stretches and dim ones wander along the curtain.
      const band = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(x * 0.021 - time * 0.11 * pace + phase * 2));
      // Both ends fade out, so the curtain has no edge.
      const ends = 1 - smoothstep(0.36 * width, 0.5 * width, Math.abs(x));
      const light = (0.25 + 0.75 * ray) * band * ends * strength * (1 + flare * 0.6);
      // Brightness carries the rays; their tops stay nearly level, or the curtain looks like flames.
      const tall = height * (0.9 + 0.14 * ray + 0.35 * flare);
      const foot = Math.sin(x * 0.03 + time * 0.22 + phase) * 5 - ray * 2.2;
      const fold = Math.sin(x * 0.018 + time * 0.3 + phase) * 12 + Math.sin(x * 0.06 + time * 0.17 + phase) * 3;
      for (let r = 0; r < ROWS.length; r++) {
        const i = (c * ROWS.length + r) * 3;
        positions[i] = x;
        positions[i + 1] = foot + tall * ROWS[r];
        // The top leans back a little, like a sheet hanging in the wind.
        positions[i + 2] = fold - ROWS[r] * 6;
        const glow = light * GLOW[r];
        colors[i] = tints[r].r * glow;
        colors[i + 1] = tints[r].g * glow;
        colors[i + 2] = tints[r].b * glow;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

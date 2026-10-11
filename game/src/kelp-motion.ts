// How every plant on the seabed moves. The numbers are shared by the vertex
// shader (KELP_MOTION_GLSL) and by kelpOffset below, which the tests use to
// check that roots stay put and nothing stretches.

const M = {
  /** Sway speed (rad/s) of a very short plant; taller plants swing slower. */
  rate: 1.9,
  /** Phase delay from root to tip (rad), plus this much per metre of height: tall kelp bends into an S. */
  lag: 2.2,
  lagPerMeter: 0.05,
  /** Tip travel (m) of a very short plant, plus this much per metre of height. */
  swayBase: 0.25,
  sway: 0.045,
  /** Sideways part of the sway, so tips trace a loop, not a line. */
  cross: 0.45,
  /** Steady lean down-current, as a share of the height. */
  lean: 0.035,
  /** How far apart (rad/m) neighbours are in phase: the sway crosses the bed as a wave. */
  spread: 0.13,
  /** Depth (m) over which the swell's back-and-forth dies out. */
  surgeDepth: 14,
  /** Leaf tips flap this much of their distance from the stem. */
  flap: 0.2,
  wag: 0.12,
  /** The diver pushes plants aside within this radius (m) and drags them along. */
  wakeRadius: 4.5,
  wakePush: 1.2,
  wakeDrag: 0.22,
} as const;

export interface KelpFlow {
  time: number;
  /** Unit direction of the current in the xz plane. */
  dirX: number;
  dirZ: number;
  /** 0 calm to 1 storm. */
  strength: number;
  /** Swell clock and how far (m) the swell moves water at the surface. */
  waveTime: number;
  surge: number;
  /** The diver: position, velocity in x and y, and 0..1 for how much they stir the water. */
  diver: readonly [number, number, number];
  wake: readonly [number, number, number];
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Where the current moves a vertex resting at (px, py, pz), as an offset.
 * `height` is the plant's height, `flutter` the vertex's signed distance from its
 * stem (leaf tips flap, the stem does not), `flex` how limp the species is.
 */
export function kelpOffset(
  px: number, py: number, pz: number,
  rootX: number, rootY: number, rootZ: number,
  height: number, flutter: number, phase: number, flex: number,
  flow: KelpFlow,
): [number, number, number] {
  const s = Math.max(py - rootY, 0);
  const u = Math.min(1, s / Math.max(height, 0.001));
  const reach = Math.pow(u, 1.5);
  const travel = flow.time * (M.rate / Math.sqrt(1 + height * 0.25)) - u * (M.lag + height * M.lagPerMeter)
    + phase * 0.6 - (rootX * flow.dirX + rootZ * flow.dirZ) * M.spread;
  const amp = flex * (M.swayBase + M.sway * height) * (1 + 0.8 * flow.strength);
  const along = (amp * (Math.sin(travel) + 0.35 * Math.sin(travel * 2.1 + 1.3 + phase))
    + flex * height * M.lean * (0.35 + flow.strength)) * reach;
  const across = amp * M.cross * Math.sin(travel * 0.63 + phase * 1.7 + u * 1.9) * reach;
  let ox = flow.dirX * along - flow.dirZ * across;
  let oz = flow.dirZ * along + flow.dirX * across;

  // Under the swell the water moves back and forth with the waves above it.
  ox += flow.surge * Math.exp(Math.min(0, py) / M.surgeDepth) * flex * Math.min(1, s / 3)
    * Math.cos(px * 0.15 + flow.waveTime * 1.3);

  const wag = flutter * M.wag * Math.sin(flow.time * 1.7 + phase * 1.3 + u * 7);
  ox -= flow.dirZ * wag;
  oz += flow.dirX * wag;
  let oy = flutter * M.flap * Math.sin(flow.time * 2.3 + phase * 2 + u * 9) * (0.6 + 0.6 * flow.strength);

  const wx = px + ox - flow.diver[0];
  const wy = py - flow.diver[1];
  const wz = (pz + oz - flow.diver[2]) * 0.45;
  const near = (1 - smoothstep(0.5, M.wakeRadius, Math.sqrt(wx * wx + wy * wy * 0.6 + wz * wz)))
    * flow.wake[2] * Math.min(1, s / 2.5);
  const away = M.wakePush / Math.max(0.35, Math.hypot(wx, wz));
  ox += (wx * away + flow.wake[0] * M.wakeDrag) * near;
  oz += wz * away * 0.6 * near;
  oy += flow.wake[1] * M.wakeDrag * near;

  // A stem that leans over also comes down, or it would grow longer as it bends.
  oy -= Math.min(0.4 * s, (ox * ox + oz * oz) / (2 * Math.max(s, 0.6)));
  return [ox, oy, oz];
}

const f = (value: number) => value.toFixed(4);

/** Same motion as kelpOffset. `root` and `shape` (height, flutter, phase, flex) are per-vertex attributes. */
export const KELP_MOTION_GLSL = /* glsl */ `
  uniform float uKelpTime;
  uniform vec4 uKelpFlow;   // xy: current direction, z: strength, w: swell clock
  uniform float uKelpSurge;
  uniform vec3 uKelpDiver;
  uniform vec3 uKelpWake;   // xy: diver velocity, z: 0..1

  vec3 kelpOffset(vec3 p, vec3 root, vec4 shape) {
    float height = max(shape.x, 0.001);
    float flutter = shape.y;
    float phase = shape.z;
    float flex = shape.w;
    vec2 dir = uKelpFlow.xy;
    float strength = uKelpFlow.z;
    float s = max(p.y - root.y, 0.0);
    float u = min(1.0, s / height);
    float reach = pow(u, 1.5);
    float travel = uKelpTime * (${f(M.rate)} / sqrt(1.0 + height * 0.25)) - u * (${f(M.lag)} + height * ${f(M.lagPerMeter)})
      + phase * 0.6 - dot(root.xz, dir) * ${f(M.spread)};
    float amp = flex * (${f(M.swayBase)} + ${f(M.sway)} * height) * (1.0 + 0.8 * strength);
    float along = (amp * (sin(travel) + 0.35 * sin(travel * 2.1 + 1.3 + phase))
      + flex * height * ${f(M.lean)} * (0.35 + strength)) * reach;
    float across = amp * ${f(M.cross)} * sin(travel * 0.63 + phase * 1.7 + u * 1.9) * reach;
    vec2 o = dir * along + vec2(-dir.y, dir.x) * across;

    o.x += uKelpSurge * exp(min(0.0, p.y) / ${f(M.surgeDepth)}) * flex * min(1.0, s / 3.0)
      * cos(p.x * 0.15 + uKelpFlow.w * 1.3);

    o += vec2(-dir.y, dir.x) * flutter * ${f(M.wag)} * sin(uKelpTime * 1.7 + phase * 1.3 + u * 7.0);
    float oy = flutter * ${f(M.flap)} * sin(uKelpTime * 2.3 + phase * 2.0 + u * 9.0) * (0.6 + 0.6 * strength);

    vec3 w = vec3(p.x + o.x - uKelpDiver.x, p.y - uKelpDiver.y, (p.z + o.y - uKelpDiver.z) * 0.45);
    float near = (1.0 - smoothstep(0.5, ${f(M.wakeRadius)}, sqrt(w.x * w.x + w.y * w.y * 0.6 + w.z * w.z)))
      * uKelpWake.z * min(1.0, s / 2.5);
    float away = ${f(M.wakePush)} / max(0.35, length(w.xz));
    o.x += (w.x * away + uKelpWake.x * ${f(M.wakeDrag)}) * near;
    o.y += w.z * away * 0.6 * near;
    oy += uKelpWake.y * ${f(M.wakeDrag)} * near;

    oy -= min(0.4 * s, dot(o, o) / (2.0 * max(s, 0.6)));
    return vec3(o.x, oy, o.y);
  }
`;

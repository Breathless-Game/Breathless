// The same coefficients drive the GPU deformation and the CPU bounds checks.
// Every branch samples the plant's common height field, so attached fronds
// cannot detach while the current passes through them.
const MOTION = {
  speed: 0.57,
  lag: 2.45,
  strength: 0.12,
  wind: 0.055,
  secondary: 0.026,
  flutter: 0.024,
} as const;

export function kelpDisplacement(height: number, fraction: number, phase: number, time: number, wind: number, edge = 0): [number, number, number] {
  const h = Math.max(0, Math.min(1, fraction));
  const flow = time * MOTION.speed + phase;
  const angle = h * ((MOTION.strength + Math.max(0, Math.min(1, wind)) * MOTION.wind)
    * Math.sin(flow - h * MOTION.lag) + MOTION.secondary * Math.sin(flow * 0.63 + h));
  const y = height * h;
  const crossFlow = Math.sin(flow * 0.73 - h * 1.1) * y * h * 0.045;
  const flutter = Math.sin(time * 1.75 + phase - h * 3.2) * edge * h * MOTION.flutter;
  return [Math.sin(angle) * y, (Math.cos(angle) - 1) * y, crossFlow + flutter];
}

export const KELP_MOTION_GLSL = /* glsl */ `
  vec3 kelpDisplacement(float height, float fraction, float phase, float time, float wind, float edge) {
    float h = clamp(fraction, 0.0, 1.0);
    float flow = time * ${MOTION.speed} + phase;
    float angle = h * ((${MOTION.strength} + clamp(wind, 0.0, 1.0) * ${MOTION.wind})
      * sin(flow - h * ${MOTION.lag}) + ${MOTION.secondary} * sin(flow * 0.63 + h));
    float y = height * h;
    float crossFlow = sin(flow * 0.73 - h * 1.1) * y * h * 0.045;
    float flutter = sin(time * 1.75 + phase - h * 3.2) * edge * h * ${MOTION.flutter};
    return vec3(sin(angle) * y, (cos(angle) - 1.0) * y, crossFlow + flutter);
  }
`;

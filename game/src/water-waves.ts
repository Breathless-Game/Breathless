/** One continuous wave field for the GPU surface and floating scenery. Local z is world z + 30. */
const WAVES = [
  { amplitude: 0.18, x: 0.12, z: 0.20, speed: 0.65, phase: 0 },
  { amplitude: 0.12, x: -0.18, z: 0.10, speed: 0.47, phase: 1.7 },
  { amplitude: 0.05, x: 0.34, z: 0.43, speed: 1.05, phase: 2.3 },
  { amplitude: 0.02, x: -0.58, z: 0.36, speed: 1.30, phase: 0.8 },
] as const;

export type WaterDetail = 0 | 1 | 2;

/** Heights are multiplied by the map/wind swell at the call site. */
export function waterHeight(x: number, z: number, time: number, detail: WaterDetail): number {
  let height = 0;
  for (let i = 0; i < detail + 2; i++) {
    const wave = WAVES[i];
    height += wave.amplitude * Math.sin(x * wave.x + z * wave.z + time * wave.speed + wave.phase);
  }
  return height;
}

/** Analytic slope for buoy/boat tilt; no temporary vectors on the animation path. */
export function waterSlope(x: number, z: number, time: number, detail: WaterDetail, axis: 'x' | 'z'): number {
  let slope = 0;
  for (let i = 0; i < detail + 2; i++) {
    const wave = WAVES[i];
    slope += wave.amplitude * wave[axis] * Math.cos(x * wave.x + z * wave.z + time * wave.speed + wave.phase);
  }
  return slope;
}

// Both paths use the same coefficients, so floats and GPU vertices cannot
// silently drift apart when a wave is tuned. Low/medium/high evaluate 2/3/4
// waves, with no geometry shader, texture fetch or temporary animation buffer.
const glsl = (value: number) => value.toFixed(5);
export const WATER_WAVES_GLSL = `
  float waterWaveHeight(vec2 p, float time, float detail) {
    float height = 0.0;
    ${WAVES.map((wave, i) => `${i > 1 ? `if (detail > ${glsl(i - 1.5)})` : ''}
      height += ${glsl(wave.amplitude)} * sin(dot(p, vec2(${glsl(wave.x)}, ${glsl(wave.z)}))
        + time * ${glsl(wave.speed)} + ${glsl(wave.phase)});`).join('\n')}
    return height;
  }
`;

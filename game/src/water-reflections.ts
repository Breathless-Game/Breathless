/** Direct reflection energy follows the celestial light and cloud transmission. */
export function reflectionStrength(sunIntensity: number, nightMix: number, cloud: number): number {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const direct = clamp(sunIntensity / 2.2);
  const transmission = 1 - clamp(cloud) * 0.96;
  return (0.24 + direct * 0.56) * (1 - clamp(nightMix) * 0.72) * transmission * transmission;
}

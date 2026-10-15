/** Optical settings for the spotlight and nearby reflected illumination. */
export type LampPath = 'focus' | 'wideLamp';
export type HeadlampBrightness = 'normal' | 'bright' | 'extra';

/** A display preference; it never changes purchased optics or beam reach. */
export function lampBrightnessScale(mode: HeadlampBrightness): number {
  return mode === 'extra' ? 1.7 : mode === 'bright' ? 1.35 : 1;
}

export interface LampProfile {
  /** Beam cutoff in metres from the lens. */
  readonly distance: number;
  /** Direct spotlight intensity in candela, before environmental activation. */
  readonly intensity: number;
  /** Spotlight half-angle in radians. */
  readonly angle: number;
  /** Distance attenuation exponent; 2 gives inverse-square falloff. */
  readonly decay: number;
  /** Fraction of the cone devoted to its soft edge, from 0 to 1. */
  readonly penumbra: number;
  /** Relative strength of nearby reflected light, from 0 to 1. */
  readonly scatter: number;
  /** Water extinction coefficient in inverse metres (Beer–Lambert law). */
  readonly extinction: number;
}

const BASE: LampProfile = Object.freeze({
  distance: 24, intensity: 96, angle: 0.72, decay: 2,
  penumbra: 0.65, scatter: 0.18, extinction: 0.03,
});

const FOCUS: readonly LampProfile[] = Object.freeze([
  BASE,
  Object.freeze({ distance: 38, intensity: 160, angle: 0.52, decay: 2, penumbra: 0.3, scatter: 0.13, extinction: 0.018 }),
  Object.freeze({ distance: 54, intensity: 220, angle: 0.43, decay: 2, penumbra: 0.24, scatter: 0.11, extinction: 0.014 }),
]);

const WIDE: readonly LampProfile[] = Object.freeze([
  BASE,
  Object.freeze({ distance: 30, intensity: 130, angle: 1.03, decay: 2, penumbra: 0.8, scatter: 0.25, extinction: 0.045 }),
  Object.freeze({ distance: 40, intensity: 175, angle: 1.25, decay: 2, penumbra: 0.9, scatter: 0.3, extinction: 0.05 }),
]);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Tier one is the safe fallback; both specialisations use its mask lamp. */
export function lampProfile(level: number, path: LampPath = 'focus'): LampProfile {
  const tier = Number.isFinite(level) ? Math.max(1, Math.min(3, Math.floor(level))) : 1;
  return (path === 'wideLamp' ? WIDE : FOCUS)[tier - 1];
}

/**
 * Relative direct-light transmission at `distance` metres. A squared quartic
 * cutoff matches the spotlight's soft range limit; water absorption then
 * removes energy along the beam. The first metre is bounded to avoid a lens
 * singularity, while invalid distances produce no light.
 */
export function lampDistanceAttenuation(distance: number, profile: LampProfile): number {
  if (!Number.isFinite(distance)) return 0;
  const d = Math.max(0, distance);
  const range = Number.isFinite(profile.distance) && profile.distance > 0 ? profile.distance : BASE.distance;
  if (d >= range) return 0;
  const decay = Number.isFinite(profile.decay) ? Math.max(0, profile.decay) : BASE.decay;
  const extinction = Number.isFinite(profile.extinction) ? Math.max(0, profile.extinction) : BASE.extinction;
  const cutoff = clamp01(1 - (d / range) ** 4);
  return cutoff * cutoff / Math.max(d, 1) ** decay * Math.exp(-extinction * d);
}

/**
 * Lamp output from depth in metres and night strength (0 day, 1 night).
 * The lens fades in below the surface and remains useful in shallow water.
 * Output grows smoothly from 28% to full between 5–36 m; nights start at 86%.
 */
export function lampActivation(depth: number, night = 0): number {
  const metres = Number.isFinite(depth) ? Math.max(0, depth) : 0;
  const nightStrength = Number.isFinite(night) ? clamp01(night) : 0;
  const submerged = smoothstep(0.3, 2, metres);
  const darkness = 0.28 + 0.72 * smoothstep(5, 36, metres);
  return submerged * Math.max(darkness, nightStrength * 0.86);
}

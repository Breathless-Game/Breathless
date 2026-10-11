export type TimeOfDay = 'cycle' | 'morning' | 'afternoon' | 'night';

type RGB = readonly [number, number, number];

export interface LightingState {
  hour: number;
  daylight: number;
  nightMix: number;
  skyColor: RGB;
  horizonColor: RGB;
  lightColor: RGB;
  sunIntensity: number;
  ambientIntensity: number;
  /** Camera-friendly celestial orbits, including their passage below the horizon. */
  sunDirection: readonly [number, number, number];
  moonDirection: readonly [number, number, number];
  /** Unit vector from the scene toward the main light, above the horizon. */
  direction: readonly [number, number, number];
}

interface LightingKey {
  hour: number;
  daylight: number;
  sky: RGB;
  horizon: RGB;
  light: RGB;
  sun: number;
  ambient: number;
}

function rgb(hex: number): RGB {
  return [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];
}

// Colors are sRGB. The renderer converts them into its working color space.
// Dawn and dusk each run through four keys of their own: violet first light, a rose
// and orange sunrise, then gold; and in the evening gold, a red-orange sunset, a magenta
// afterglow and a violet blue hour. The hours of full day and full night are unchanged.
const LIGHTING_KEYS: readonly LightingKey[] = [
  { hour: 0, daylight: 0, sky: rgb(0x0b1736), horizon: rgb(0x1a3558), light: rgb(0xa8c8ff), sun: 0.34, ambient: 0.56 },
  { hour: 4.6, daylight: 0, sky: rgb(0x0e1a3c), horizon: rgb(0x263a60), light: rgb(0xaecbff), sun: 0.35, ambient: 0.58 },
  { hour: 5.3, daylight: 0.04, sky: rgb(0x27306a), horizon: rgb(0x8a5a86), light: rgb(0xc3c2ee), sun: 0.40, ambient: 0.62 },
  { hour: 5.9, daylight: 0.2, sky: rgb(0x4a5aa2), horizon: rgb(0xf0806a), light: rgb(0xffb894), sun: 0.62, ambient: 0.74 },
  { hour: 6.4, daylight: 0.5, sky: rgb(0x6f94cf), horizon: rgb(0xffa45e), light: rgb(0xffc08a), sun: 0.95, ambient: 0.90 },
  { hour: 7.2, daylight: 0.82, sky: rgb(0x8fc2e2), horizon: rgb(0xffd79a), light: rgb(0xffd9a6), sun: 1.45, ambient: 1.10 },
  { hour: 9, daylight: 1, sky: rgb(0xa6ddef), horizon: rgb(0xd8f0ed), light: rgb(0xfff0d1), sun: 2.15, ambient: 1.35 },
  { hour: 12, daylight: 1, sky: rgb(0x9fdaf0), horizon: rgb(0xd4eef5), light: rgb(0xfff8e8), sun: 2.30, ambient: 1.40 },
  { hour: 15, daylight: 1, sky: rgb(0xa3d4e7), horizon: rgb(0xf3d7aa), light: rgb(0xffe0b3), sun: 2.05, ambient: 1.30 },
  { hour: 16.6, daylight: 0.92, sky: rgb(0x8fb6dc), horizon: rgb(0xffcb86), light: rgb(0xffd096), sun: 1.70, ambient: 1.18 },
  { hour: 17.5, daylight: 0.68, sky: rgb(0x6c86c6), horizon: rgb(0xffa25a), light: rgb(0xffb878), sun: 1.25, ambient: 1.02 },
  { hour: 18.1, daylight: 0.4, sky: rgb(0x4b569f), horizon: rgb(0xff7a48), light: rgb(0xff9f72), sun: 0.85, ambient: 0.86 },
  { hour: 18.7, daylight: 0.14, sky: rgb(0x2e3272), horizon: rgb(0xd15a76), light: rgb(0xd9a6c4), sun: 0.52, ambient: 0.72 },
  { hour: 19.4, daylight: 0.02, sky: rgb(0x182457), horizon: rgb(0x624a86), light: rgb(0xb6c2f2), sun: 0.38, ambient: 0.62 },
  { hour: 20.2, daylight: 0, sky: rgb(0x0e1c40), horizon: rgb(0x2a3f66), light: rgb(0xa8c8ff), sun: 0.34, ambient: 0.58 },
  { hour: 22, daylight: 0, sky: rgb(0x0b1736), horizon: rgb(0x1a3558), light: rgb(0xa8c8ff), sun: 0.34, ambient: 0.56 },
  { hour: 24, daylight: 0, sky: rgb(0x0b1736), horizon: rgb(0x1a3558), light: rgb(0xa8c8ff), sun: 0.34, ambient: 0.56 },
];

const FIXED_HOURS: Record<Exclude<TimeOfDay, 'cycle'>, number> = {
  morning: 9,
  afternoon: 15,
  night: 22,
};

function wrapHour(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixColor(a: RGB, b: RGB, t: number): RGB {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function unit(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/** A periodic, continuous atmosphere with a bright enough moonlit night to play. */
export function sampleLighting(hour: number): LightingState {
  const normalizedHour = wrapHour(Number.isFinite(hour) ? hour : 9);
  let index = 0;
  while (index < LIGHTING_KEYS.length - 2 && normalizedHour >= LIGHTING_KEYS[index + 1].hour) index++;
  const a = LIGHTING_KEYS[index];
  const b = LIGHTING_KEYS[index + 1];
  const fraction = (normalizedHour - a.hour) / (b.hour - a.hour);
  const t = fraction * fraction * (3 - 2 * fraction);
  const daylight = mix(a.daylight, b.daylight, t);

  // Compress elevation to keep both celestial orbits in this side-on game's
  // view. The same vectors drive the visible discs and water reflections.
  const angle = (normalizedHour - 6) * Math.PI / 12;
  const elevation = Math.sin(angle);
  const sunDirection = unit(Math.cos(angle) * 0.55, elevation * 0.21, -1);
  const moonDirection = unit(-Math.cos(angle) * 0.55, -elevation * 0.21, -1);
  // Blend their contribution around the horizon without a zero vector or an
  // instantaneous direction flip. Keep the scene's fill source above water.
  const blend = Math.max(0, Math.min(1, (elevation + 0.55) / 1.1));
  const sunWeight = blend * blend * (3 - 2 * blend);
  const direction = unit(
    mix(moonDirection[0], sunDirection[0], sunWeight),
    Math.max(0.025, mix(moonDirection[1], sunDirection[1], sunWeight)),
    mix(moonDirection[2], sunDirection[2], sunWeight),
  );

  return {
    hour: normalizedHour,
    daylight,
    nightMix: 1 - daylight,
    skyColor: mixColor(a.sky, b.sky, t),
    horizonColor: mixColor(a.horizon, b.horizon, t),
    lightColor: mixColor(a.light, b.light, t),
    sunIntensity: mix(a.sun, b.sun, t),
    ambientIntensity: mix(a.ambient, b.ambient, t),
    sunDirection,
    moonDirection,
    direction,
  };
}

export class DayCycle {
  private currentMode: TimeOfDay = 'cycle';
  private cycleHour: number;
  private displayedHour: number;
  private transitionOffset = 0;
  private readonly durationSeconds: number;

  constructor(durationSeconds = 720, startHour = 9) {
    this.durationSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 720;
    this.cycleHour = wrapHour(Number.isFinite(startHour) ? startHour : 9);
    this.displayedHour = this.cycleHour;
  }

  get mode(): TimeOfDay {
    return this.currentMode;
  }

  get hour(): number {
    return this.displayedHour;
  }

  get state(): LightingState {
    return sampleLighting(this.displayedHour);
  }

  setMode(mode: TimeOfDay): void {
    if (mode === this.currentMode || !(mode === 'cycle' || mode === 'morning' || mode === 'afternoon' || mode === 'night')) return;
    const targetHour = mode === 'cycle' ? this.cycleHour : FIXED_HOURS[mode];
    // The shortest path also keeps midnight crossings continuous.
    this.transitionOffset = ((this.displayedHour - targetHour + 36) % 24) - 12;
    this.currentMode = mode;
  }

  advance(seconds: number, running = true): LightingState {
    if (!Number.isFinite(seconds) || seconds <= 0) return this.state;
    if (running) this.cycleHour = wrapHour(this.cycleHour + (seconds % this.durationSeconds) * 24 / this.durationSeconds);

    const targetHour = this.currentMode === 'cycle' ? this.cycleHour : FIXED_HOURS[this.currentMode];
    // 98% of a manual change settles within two seconds. A zero offset means
    // automatic time follows the clock exactly, without an exponential lag.
    this.transitionOffset *= Math.exp(-2 * seconds);
    if (Math.abs(this.transitionOffset) < 1e-7) this.transitionOffset = 0;
    this.displayedHour = wrapHour(targetHour + this.transitionOffset);
    return this.state;
  }
}

export type WeatherMode = 'auto' | 'clear' | 'cloudy' | 'rain' | 'storm';
export type WeatherKind = Exclude<WeatherMode, 'auto'>;

export interface WeatherState {
  kind: WeatherKind;
  cloud: number;
  rain: number;
  wind: number;
  storm: number;
}

/**
 * The small, ink-on-paper weather key used by the sea chart. Keeping this
 * projection separate from the renderer makes the visual language deterministic
 * and lets the chart fade between front states without inventing new values.
 */
export interface WeatherArtProfile {
  cloudInk: number;
  rainMarks: number;
  windMarks: number;
  lightning: number;
}

export function weatherArtProfile(weather: WeatherState): WeatherArtProfile {
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const cloud = clamp(weather.cloud);
  const rain = clamp(weather.rain);
  const wind = clamp(weather.wind);
  const storm = clamp(weather.storm);
  return {
    cloudInk: cloud < 0.12 ? 0 : (cloud - 0.12) / 0.88,
    rainMarks: Math.round(rain * 10),
    windMarks: Math.round(Math.max(0, wind - 0.2) * 8),
    lightning: storm < 0.35 ? 0 : (storm - 0.35) / 0.65,
  };
}

type WeatherAmounts = Omit<WeatherState, 'kind'>;

const PRESETS: Record<WeatherKind, WeatherAmounts> = {
  clear: { cloud: 0.04, rain: 0, wind: 0.12, storm: 0 },
  cloudy: { cloud: 0.70, rain: 0, wind: 0.32, storm: 0 },
  rain: { cloud: 0.90, rain: 0.68, wind: 0.56, storm: 0 },
  storm: { cloud: 1, rain: 1, wind: 1, storm: 1 },
};

/** How a map's natural weather runs: `stormy` spends a third of its time in a storm. */
export type Climate = 'temperate' | 'stormy';
type WeatherKeys = readonly { second: number; kind: WeatherKind }[];

// A nine-minute front with a longer calm spell and a shorter storm peak.
// Identical clear keys at both ends make the loop smooth, including its slope.
const WEATHER_KEYS: WeatherKeys = [
  { second: 0, kind: 'clear' },
  { second: 75, kind: 'clear' },
  { second: 135, kind: 'cloudy' },
  { second: 225, kind: 'rain' },
  { second: 285, kind: 'storm' },
  { second: 345, kind: 'rain' },
  { second: 435, kind: 'cloudy' },
  { second: 495, kind: 'clear' },
  { second: 540, kind: 'clear' },
];

// The same nine minutes on the open ocean: the calm is short, the storm holds for over a
// minute, eases to rain and comes back before the front finally clears.
const STORMY_KEYS: WeatherKeys = [
  { second: 0, kind: 'clear' },
  { second: 35, kind: 'clear' },
  { second: 80, kind: 'cloudy' },
  { second: 125, kind: 'rain' },
  { second: 170, kind: 'storm' },
  { second: 250, kind: 'storm' },
  { second: 295, kind: 'rain' },
  { second: 340, kind: 'rain' },
  { second: 385, kind: 'storm' },
  { second: 415, kind: 'storm' },
  { second: 460, kind: 'rain' },
  { second: 500, kind: 'cloudy' },
  { second: 525, kind: 'clear' },
  { second: 540, kind: 'clear' },
];

const CLIMATES: Record<Climate, WeatherKeys> = { temperate: WEATHER_KEYS, stormy: STORMY_KEYS };

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function state(amounts: WeatherAmounts): WeatherState {
  const kind = amounts.storm > 0.5 ? 'storm'
    : amounts.rain > 0.1 ? 'rain'
    : amounts.cloud > 0.22 ? 'cloudy' : 'clear';
  return { kind, ...amounts };
}

function blend(a: WeatherAmounts, b: WeatherAmounts, t: number): WeatherState {
  return state({
    cloud: a.cloud + (b.cloud - a.cloud) * t,
    rain: a.rain + (b.rain - a.rain) * t,
    wind: a.wind + (b.wind - a.wind) * t,
    storm: a.storm + (b.storm - a.storm) * t,
  });
}

function sampleWeather(second: number, keys: WeatherKeys = WEATHER_KEYS): WeatherState {
  let index = 0;
  while (index < keys.length - 2 && second >= keys[index + 1].second) index++;
  const a = keys[index];
  const b = keys[index + 1];
  return blend(PRESETS[a.kind], PRESETS[b.kind], smoothstep((second - a.second) / (b.second - a.second)));
}

/** Elapsed game time drives weather; no wall clock, random source or frame-rate dependency. */
export class WeatherCycle {
  private currentMode: WeatherMode = 'auto';
  private currentClimate: Climate = 'temperate';
  private cycleSecond = 0;
  private currentState = sampleWeather(0);
  private transitionFrom: WeatherState | null = null;
  private transitionSecond = 0;

  constructor(startSecond = 0) {
    this.cycleSecond = Number.isFinite(startSecond) ? ((startSecond % 540) + 540) % 540 : 0;
    this.currentState = sampleWeather(this.cycleSecond, CLIMATES[this.currentClimate]);
  }

  get mode(): WeatherMode {
    return this.currentMode;
  }

  get state(): WeatherState {
    return { ...this.currentState };
  }

  get climate(): Climate {
    return this.currentClimate;
  }

  /** Another map's weather: the natural front follows that climate from where the clock stands, blending over 5 s. */
  setClimate(climate: Climate): void {
    if (climate === this.currentClimate || !(climate in CLIMATES)) return;
    this.transitionFrom = this.state;
    this.transitionSecond = 0;
    this.currentClimate = climate;
  }

  setMode(mode: WeatherMode): void {
    if (mode === this.currentMode || !(mode === 'auto' || mode === 'clear' || mode === 'cloudy' || mode === 'rain' || mode === 'storm')) return;
    this.transitionFrom = this.state;
    this.transitionSecond = 0;
    this.currentMode = mode;
  }

  advance(seconds: number, running = true): WeatherState {
    if (!Number.isFinite(seconds) || seconds <= 0) return this.state;
    if (running) this.cycleSecond = (this.cycleSecond + seconds % 540) % 540;

    const target = this.currentMode === 'auto'
      ? sampleWeather(this.cycleSecond, CLIMATES[this.currentClimate])
      : state(PRESETS[this.currentMode]);
    if (this.transitionFrom) {
      // Manual previews settle while paused. Returning to auto blends into the
      // continuing front, then follows it exactly without a persistent delay.
      this.transitionSecond = Math.min(5, this.transitionSecond + seconds);
      this.currentState = blend(this.transitionFrom, target, smoothstep(this.transitionSecond / 5));
      if (this.transitionSecond === 5) this.transitionFrom = null;
    } else {
      this.currentState = target;
    }
    return this.state;
  }
}

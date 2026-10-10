export type WeatherMode = 'auto' | 'clear' | 'cloudy' | 'rain' | 'storm';
export type WeatherKind = Exclude<WeatherMode, 'auto'>;

export interface WeatherState {
  kind: WeatherKind;
  cloud: number;
  rain: number;
  wind: number;
  storm: number;
}

type WeatherAmounts = Omit<WeatherState, 'kind'>;

const PRESETS: Record<WeatherKind, WeatherAmounts> = {
  clear: { cloud: 0.04, rain: 0, wind: 0.12, storm: 0 },
  cloudy: { cloud: 0.70, rain: 0, wind: 0.32, storm: 0 },
  rain: { cloud: 0.90, rain: 0.68, wind: 0.56, storm: 0 },
  storm: { cloud: 1, rain: 1, wind: 1, storm: 1 },
};

// A nine-minute front with a longer calm spell and a shorter storm peak.
// Identical clear keys at both ends make the loop smooth, including its slope.
const WEATHER_KEYS: readonly { second: number; kind: WeatherKind }[] = [
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

function sampleWeather(second: number): WeatherState {
  let index = 0;
  while (index < WEATHER_KEYS.length - 2 && second >= WEATHER_KEYS[index + 1].second) index++;
  const a = WEATHER_KEYS[index];
  const b = WEATHER_KEYS[index + 1];
  return blend(PRESETS[a.kind], PRESETS[b.kind], smoothstep((second - a.second) / (b.second - a.second)));
}

/** Elapsed game time drives weather; no wall clock, random source or frame-rate dependency. */
export class WeatherCycle {
  private currentMode: WeatherMode = 'auto';
  private cycleSecond = 0;
  private currentState = sampleWeather(0);
  private transitionFrom: WeatherState | null = null;
  private transitionSecond = 0;

  get mode(): WeatherMode {
    return this.currentMode;
  }

  get state(): WeatherState {
    return { ...this.currentState };
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

    const target = this.currentMode === 'auto' ? sampleWeather(this.cycleSecond) : state(PRESETS[this.currentMode]);
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

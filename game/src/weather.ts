export type WeatherMode = 'auto' | 'clear' | 'cloudy' | 'rain' | 'storm';
export type WeatherKind = Exclude<WeatherMode, 'auto'>;

export interface WeatherState {
  kind: WeatherKind;
  cloud: number;
  rain: number;
  wind: number;
  storm: number;
}

/** One cloud on the sea chart. Positions are fractions of the chart's width and height. */
export interface ChartCloud {
  x: number;
  y: number;
  size: number;
  /** How firmly it is inked: 0 just arriving, 1 settled. */
  ink: number;
  /** How hard it rains under it and how much thunder it carries, 0 to 1 each. */
  rain: number;
  bolt: number;
  /** This quarter second its lightning is striking. */
  flash: boolean;
  /** Counts quarter seconds, so the rain under it can be drawn falling. */
  step: number;
}

/** A gust on the sea chart: a few streaks of wind. */
export interface ChartWind {
  x: number;
  y: number;
  size: number;
  ink: number;
  lines: number;
}

export interface ChartWeather {
  clouds: ChartCloud[];
  winds: ChartWind[];
}

const CHART_CLOUDS = 6;
const CHART_WINDS = 5;
/** Below these the chart is bare: clear air draws nothing. */
const CHART_CLOUD_FROM = 0.12;
const CHART_WIND_FROM = 0.24;

const unitClamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
const ramp = (value: number, from: number, width: number) => unitClamp((value - from) / width);
const ease = (t: number) => unitClamp(t) * unitClamp(t) * (3 - 2 * unitClamp(t));

/** A fixed number from 0 to 1 for a set of whole-number keys. */
function scatter(...keys: number[]): number {
  let h = 0x9e3779b9;
  for (const key of keys) {
    h = Math.imul(h ^ (key | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

/** For each slot, its place in the order the seed shuffles them into. */
function ranks(count: number, seed: number, salt: number): number[] {
  const order = Array.from({ length: count }, (_, slot) => slot).sort((a, b) => scatter(seed, a, salt) - scatter(seed, b, salt));
  const rank: number[] = [];
  order.forEach((slot, place) => (rank[slot] = place));
  return rank;
}

/**
 * Where a mark is as it crosses the chart. Each keeps to its own band of the paper and they
 * set out spread along it, so marks of a kind do not pile up; every crossing takes a new
 * height and size. It fades in at one edge and out at the other.
 */
function crossing(slot: number, slots: number, second: number, seed: number, salt: number, pace: number) {
  const start = (ranks(slots, seed, salt)[slot] + 0.2 + 0.6 * scatter(seed, slot, salt)) / slots;
  const travel = start + second * pace * (0.75 + 0.5 * scatter(seed, slot, salt + 1));
  const pass = Math.floor(travel);
  const along = travel - pass;
  return {
    x: -0.06 + along * 1.12,
    y: 0.16 + ((slot + 0.15 + 0.7 * scatter(seed, slot, pass, salt + 2)) / slots) * 0.7,
    size: 0.8 + 0.4 * scatter(seed, slot, pass, salt + 3),
    edge: ease(along / 0.08) * ease((1 - along) / 0.08),
  };
}

/** True when the weather puts any mark on the chart at all. */
export function chartWeatherShows(weather: WeatherState): boolean {
  return unitClamp(weather.cloud) > CHART_CLOUD_FROM || unitClamp(weather.wind) > CHART_WIND_FROM;
}

/**
 * The weather as the sea chart shows it: clouds and gusts scattered over the paper and
 * drifting across it, not one stamp in a fixed place. As a front builds more clouds gather,
 * rain starts under the heaviest and thunder in the worst of those; as the wind rises more
 * gusts cross. `seed` shuffles where they are and which are the heavy ones.
 *
 * It is a plain function of its arguments, so the chart can be redrawn at any moment and
 * fade between front states without inventing anything: clear air returns nothing.
 */
export function chartWeather(weather: WeatherState, second = 0, seed = 0): ChartWeather {
  const cloud = unitClamp(weather.cloud);
  const rain = unitClamp(weather.rain);
  const wind = unitClamp(weather.wind);
  const storm = unitClamp(weather.storm);
  const now = Number.isFinite(second) ? Math.max(0, second) : 0;
  const step = Math.floor(now * 4);

  const clouds: ChartCloud[] = [];
  const cloudRank = ranks(CHART_CLOUDS, seed, 11);
  for (let slot = 0; slot < CHART_CLOUDS; slot++) {
    // The first to gather is the heaviest. One cloud never rains, and only every other one
    // thunders, so even a full storm is a mix of cells.
    const rank = cloudRank[slot];
    const ink = ramp(cloud, CHART_CLOUD_FROM + rank * 0.125, 0.1);
    if (ink <= 0) continue;
    const at = crossing(slot, CHART_CLOUDS, now, seed, 20, 0.007);
    const bolt = rank % 2 === 0 ? ramp(storm, 0.3 + rank * 0.12, 0.15) : 0;
    clouds.push({
      x: at.x,
      y: at.y,
      size: at.size,
      ink: ink * at.edge,
      rain: rank < CHART_CLOUDS - 1 ? ramp(rain, 0.06 + rank * 0.17, 0.12) : 0,
      bolt,
      flash: bolt > 0 && scatter(seed, slot, step, 30) < 0.2,
      step,
    });
  }

  const winds: ChartWind[] = [];
  const windRank = ranks(CHART_WINDS, seed, 12);
  for (let slot = 0; slot < CHART_WINDS; slot++) {
    const ink = ramp(wind, CHART_WIND_FROM + windRank[slot] * 0.15, 0.1);
    if (ink <= 0) continue;
    const at = crossing(slot, CHART_WINDS, now, seed, 40, 0.016);
    winds.push({ x: at.x, y: at.y, size: at.size, ink: ink * at.edge, lines: wind > 0.7 ? 3 : 2 });
  }
  return { clouds, winds };
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

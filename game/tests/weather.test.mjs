import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/weather.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { WeatherCycle, chartWeather, chartWeatherShows } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const amounts = ['cloud', 'rain', 'wind', 'storm'];

function closeState(actual, expected, tolerance = 1e-9) {
  for (const key of amounts) {
    assert.ok(Math.abs(actual[key] - expected[key]) < tolerance, `${key}: ${actual[key]} should be near ${expected[key]}`);
  }
}

function at(second) {
  const cycle = new WeatherCycle();
  return cycle.advance(second);
}

test('automatic weather starts clear and visits the full front every nine minutes', () => {
  const cycle = new WeatherCycle();
  assert.equal(cycle.mode, 'auto');
  assert.equal(cycle.state.kind, 'clear');
  for (const [second, kind] of [[135, 'cloudy'], [225, 'rain'], [285, 'storm'], [345, 'rain'], [435, 'cloudy'], [495, 'clear']]) {
    assert.equal(at(second).kind, kind);
  }
  assert.deepEqual(at(540), cycle.state);
  assert.deepEqual(at(540 * 4 + 285), at(285));
});

test('weather amounts stay bounded and continuous at every front boundary and loop', () => {
  for (let second = 0; second <= 540; second += 0.5) {
    for (const key of amounts) {
      const value = at(second)[key];
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${second}: ${key}=${value}`);
    }
  }
  for (const second of [75, 135, 225, 285, 345, 435, 495, 540]) {
    closeState(at(second - 1e-4), at(second + 1e-4), 1e-7);
  }
});

test('elapsed seconds give the same automatic weather at slow and fast frame rates', () => {
  const slow = new WeatherCycle();
  const fast = new WeatherCycle();
  for (let frame = 0; frame < 2500; frame++) slow.advance(0.1);
  for (let frame = 0; frame < 15000; frame++) fast.advance(1 / 60);
  closeState(slow.state, at(250));
  closeState(fast.state, at(250));
  const unchanged = fast.state;
  assert.deepEqual(fast.state, unchanged, 'reading state never advances the clock');
});

test('pausing freezes the automatic front while manual previews finish smoothly', () => {
  const cycle = new WeatherCycle();
  cycle.advance(150);
  const before = cycle.state;
  assert.deepEqual(cycle.advance(600, false), before);
  cycle.setMode('storm');
  assert.deepEqual(cycle.state, before, 'selection preserves the current frame');
  const first = cycle.advance(1 / 60, false);
  assert.ok(first.rain > before.rain && first.rain - before.rain < 0.001);
  const halfway = cycle.advance(2.5 - 1 / 60, false);
  assert.ok(halfway.rain > before.rain && halfway.rain < 1);
  const storm = cycle.advance(2.5, false);
  assert.equal(storm.kind, 'storm');
  assert.equal(storm.rain, 1);
  assert.equal(storm.wind, 1);
  cycle.setMode('auto');
  assert.deepEqual(cycle.state, storm);
  closeState(cycle.advance(5, false), before, 1e-15);
});

test('manual presets distinguish dry clouds, rain and a windy storm', () => {
  const cycle = new WeatherCycle();
  const presets = {};
  for (const kind of ['clear', 'cloudy', 'rain', 'storm']) {
    cycle.setMode(kind);
    presets[kind] = cycle.advance(5, false);
    assert.equal(presets[kind].kind, kind);
  }
  assert.equal(presets.clear.rain, 0);
  assert.equal(presets.cloudy.rain, 0);
  assert.ok(presets.cloudy.cloud > presets.clear.cloud);
  assert.ok(presets.rain.rain > 0);
  assert.equal(presets.rain.storm, 0);
  assert.ok(presets.storm.rain > presets.rain.rain);
  assert.ok(presets.storm.wind > presets.rain.wind);
});

test('returning to auto blends back to the continuing game-time front', () => {
  const cycle = new WeatherCycle();
  cycle.setMode('clear');
  cycle.advance(225);
  assert.equal(cycle.state.kind, 'clear');
  const before = cycle.state;
  cycle.setMode('auto');
  assert.deepEqual(cycle.state, before);
  const first = cycle.advance(1 / 60);
  assert.ok(first.rain > 0 && first.rain < 0.001);
  closeState(cycle.advance(5 - 1 / 60), at(230));
  closeState(cycle.advance(55), at(285));
});

test('repeated selection preserves the transition and interruptions stay continuous', () => {
  const cycle = new WeatherCycle();
  cycle.setMode('storm');
  cycle.advance(2, false);
  cycle.setMode('storm');
  assert.equal(cycle.advance(3, false).storm, 1);
  cycle.setMode('clear');
  const halfway = cycle.advance(2.5, false);
  cycle.setMode('rain');
  assert.deepEqual(cycle.state, halfway);
  closeState(cycle.advance(1e-6, false), halfway, 1e-9);
  assert.equal(cycle.advance(5, false).kind, 'rain');
});

test('invalid input and external state mutation cannot corrupt the front', () => {
  const cycle = new WeatherCycle();
  cycle.setMode('rain');
  const before = cycle.state;
  for (const seconds of [0, -1, NaN, Infinity, -Infinity]) assert.deepEqual(cycle.advance(seconds), before);
  cycle.setMode('invalid');
  assert.equal(cycle.mode, 'rain');
  const external = cycle.state;
  external.rain = 99;
  assert.deepEqual(cycle.state, before);
  assert.equal(cycle.advance(5, false).kind, 'rain');
});

test('the chart scatters clouds and gusts for the front, and nothing in clear air', () => {
  const states = {
    clear: { kind: 'clear', cloud: 0.04, rain: 0, wind: 0.12, storm: 0 },
    cloudy: { kind: 'cloudy', cloud: 0.70, rain: 0, wind: 0.32, storm: 0 },
    rain: { kind: 'rain', cloud: 0.90, rain: 0.68, wind: 0.56, storm: 0 },
    storm: { kind: 'storm', cloud: 1, rain: 1, wind: 1, storm: 1 },
  };
  // Mid-crossing for most marks, so edge fades do not hide them.
  const at = (name, second = 40, seed = 7) => chartWeather(states[name], second, seed);
  const raining = (marks) => marks.clouds.filter(cloud => cloud.rain > 0).length;
  const thundering = (marks) => marks.clouds.filter(cloud => cloud.bolt > 0).length;

  assert.deepEqual(at('clear'), { clouds: [], winds: [] });
  assert.equal(chartWeatherShows(states.clear), false);
  for (const name of ['cloudy', 'rain', 'storm']) assert.equal(chartWeatherShows(states[name]), true);

  assert.ok(at('cloudy').clouds.length >= 3);
  assert.equal(raining(at('cloudy')), 0);
  assert.ok(at('cloudy').winds.length >= 1);
  assert.ok(raining(at('rain')) >= 3 && thundering(at('rain')) === 0);
  assert.ok(at('rain').clouds.length > at('cloudy').clouds.length);
  assert.ok(at('rain').winds.length > at('cloudy').winds.length);
  // A storm is a mix of cells: thunder in some, rain alone in others, one dry cloud.
  const storm = at('storm');
  assert.ok(thundering(storm) >= 2 && thundering(storm) < raining(storm));
  assert.ok(raining(storm) < storm.clouds.length);
  assert.ok(storm.winds.length > at('rain').winds.length);

  for (const name of Object.keys(states)) {
    for (const second of [0, 3.3, 40, 170.25, 9999]) {
      const marks = at(name, second);
      assert.deepEqual(chartWeather(states[name], second, 7), marks, 'same inputs, same chart');
      for (const mark of [...marks.clouds, ...marks.winds]) {
        assert.ok(mark.x >= -0.06 && mark.x <= 1.06 && mark.y >= 0.16 && mark.y <= 0.86);
        assert.ok(mark.ink >= 0 && mark.ink <= 1 && mark.size >= 0.8 && mark.size <= 1.2);
      }
      for (const cloud of marks.clouds) {
        assert.ok(cloud.rain >= 0 && cloud.rain <= 1 && cloud.bolt >= 0 && cloud.bolt <= 1);
        assert.ok(!cloud.flash || cloud.bolt > 0, 'only a thundercloud strikes');
      }
    }
  }
});

test('chart weather is scattered by the seed and drifts with time, never fixed in place', () => {
  const storm = { kind: 'storm', cloud: 1, rain: 1, wind: 1, storm: 1 };
  const places = (marks) => marks.clouds.map(cloud => [cloud.x, cloud.y]);
  assert.notDeepEqual(places(chartWeather(storm, 40, 1)), places(chartWeather(storm, 40, 2)));
  const earlier = chartWeather(storm, 40, 1);
  const later = chartWeather(storm, 45, 1);
  assert.notDeepEqual(places(earlier), places(later));
  // Drift, not a reshuffle: over five seconds each cloud has moved a little way along,
  // unless it left one edge and came back in at the other.
  earlier.clouds.forEach((cloud, i) => {
    const moved = later.clouds[i].x - cloud.x;
    assert.ok((moved > 0 && moved < 0.08) || moved < -1, `cloud ${i} moved ${moved}`);
  });
  // Which clouds carry the thunder is part of the shuffle.
  const heavy = (seed) => chartWeather(storm, 40, seed).clouds.map(cloud => cloud.bolt > 0).join();
  assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(heavy)).size > 1);
  // Bad input cannot move the chart off the paper.
  for (const second of [NaN, -5, Infinity]) {
    assert.deepEqual(chartWeather(storm, second, 1), chartWeather(storm, 0, 1));
  }
});

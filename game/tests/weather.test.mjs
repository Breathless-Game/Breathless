import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/weather.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { WeatherCycle, weatherArtProfile } = await import(
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

test('the chart weather key follows the front without inventing marks in clear air', () => {
  const clear = weatherArtProfile({ kind: 'clear', cloud: 0.04, rain: 0, wind: 0.12, storm: 0 });
  const cloudy = weatherArtProfile({ kind: 'cloudy', cloud: 0.70, rain: 0, wind: 0.32, storm: 0 });
  const rain = weatherArtProfile({ kind: 'rain', cloud: 0.90, rain: 0.68, wind: 0.56, storm: 0 });
  const storm = weatherArtProfile({ kind: 'storm', cloud: 1, rain: 1, wind: 1, storm: 1 });
  assert.deepEqual(clear, { cloudInk: 0, rainMarks: 0, windMarks: 0, lightning: 0 });
  assert.ok(cloudy.cloudInk > clear.cloudInk);
  assert.ok(cloudy.windMarks > clear.windMarks);
  assert.ok(rain.rainMarks > cloudy.rainMarks);
  assert.ok(storm.windMarks > rain.windMarks);
  assert.ok(storm.lightning > rain.lightning);
  for (const profile of [clear, cloudy, rain, storm]) {
    assert.ok(profile.cloudInk >= 0 && profile.cloudInk <= 1);
    assert.ok(profile.lightning >= 0 && profile.lightning <= 1);
  }
});

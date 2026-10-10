import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/daylight.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { DayCycle, sampleLighting } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`);
}

function hourDistance(a, b) {
  return Math.abs(((a - b + 36) % 24) - 12);
}

function lightingNumbers(state) {
  return [state.daylight, state.nightMix, ...state.skyColor, ...state.horizonColor,
    ...state.lightColor, state.sunIntensity, state.ambientIntensity, ...state.direction,
    ...state.sunDirection, ...state.moonDirection];
}

test('lighting is periodic and continuous across midnight and every color key', () => {
  const midnight = sampleLighting(0);
  for (const hour of [-48, -24, 24, 48]) assert.deepEqual(sampleLighting(hour), midnight);
  assert.deepEqual(sampleLighting(-1), sampleLighting(23));
  const boundaries = [0, 5, 6, 7, 9, 12, 15, 17, 18, 19, 20, 22];
  for (const hour of boundaries) {
    const before = lightingNumbers(sampleLighting(hour - 1e-5));
    const after = lightingNumbers(sampleLighting(hour + 1e-5));
    before.forEach((value, i) => close(value, after[i], 1e-5));
  }
});

test('the full cycle keeps colors bounded, illumination playable, and directions normalized', () => {
  for (let minute = 0; minute < 24 * 60; minute++) {
    const state = sampleLighting(minute / 60);
    for (const value of lightingNumbers(state)) assert.ok(Number.isFinite(value));
    for (const value of [state.daylight, state.nightMix, ...state.skyColor, ...state.horizonColor, ...state.lightColor]) {
      assert.ok(value >= 0 && value <= 1);
    }
    assert.ok(state.sunIntensity >= 0.3 && state.sunIntensity <= 2.4);
    assert.ok(state.ambientIntensity >= 0.5 && state.ambientIntensity <= 1.5);
    close(Math.hypot(...state.direction), 1);
    close(Math.hypot(...state.sunDirection), 1);
    close(Math.hypot(...state.moonDirection), 1);
    assert.ok(state.direction[1] > 0, 'the main light always stays above the horizon');
    close(state.daylight + state.nightMix, 1);
  }
});

test('celestial discs rise and set, follow time presets, and share the reflected light direction', () => {
  const morning = sampleLighting(9);
  const afternoon = sampleLighting(15);
  const night = sampleLighting(22);
  assert.ok(morning.sunDirection[0] > 0 && afternoon.sunDirection[0] < 0);
  for (const state of [morning, afternoon]) {
    assert.ok(state.sunDirection[1] > 0);
    assert.ok(state.moonDirection[1] < 0);
    state.direction.forEach((value, i) => close(value, state.sunDirection[i]));
  }
  assert.ok(night.sunDirection[1] < 0 && night.moonDirection[1] > 0);
  night.direction.forEach((value, i) => close(value, night.moonDirection[i]));
  close(sampleLighting(6).sunDirection[1], 0);
  close(sampleLighting(18).sunDirection[1], 0);
  assert.ok(sampleLighting(5).sunDirection[1] < 0 && sampleLighting(7).sunDirection[1] > 0);
  assert.ok(sampleLighting(17).sunDirection[1] > 0 && sampleLighting(19).sunDirection[1] < 0);
});

test('morning is clear, afternoon is warmer, and night is blue with reduced illumination', () => {
  const morning = sampleLighting(9);
  const afternoon = sampleLighting(15);
  const night = sampleLighting(22);
  assert.equal(morning.daylight, 1);
  assert.equal(afternoon.daylight, 1);
  assert.equal(night.daylight, 0);
  assert.equal(night.nightMix, 1);
  assert.ok(afternoon.lightColor[2] < morning.lightColor[2]);
  assert.ok(afternoon.horizonColor[0] > morning.horizonColor[0]);
  assert.ok(night.lightColor[2] > night.lightColor[0]);
  assert.ok(night.sunIntensity < morning.sunIntensity);
  assert.ok(night.ambientIntensity < morning.ambientIntensity);
  assert.ok(morning.direction[0] > 0 && afternoon.direction[0] < 0);
  assert.notDeepEqual(morning.skyColor, afternoon.skyColor);
});

test('the automatic clock advances accurately, wraps, and stops during pause', () => {
  const cycle = new DayCycle();
  assert.equal(cycle.mode, 'cycle');
  assert.equal(cycle.hour, 9);
  close(cycle.advance(180).hour, 15);
  close(cycle.advance(360).hour, 3);
  close(cycle.advance(180).hour, 9);
  close(cycle.advance(60, false).hour, 9);
  close(cycle.advance(720 * 3 + 30).hour, 10);

  const wrapped = new DayCycle(24, 23.9);
  close(wrapped.advance(0.2).hour, 0.1);
  const frames = new DayCycle(24, 0);
  for (let frame = 0; frame < 600; frame++) frames.advance(1 / 60);
  close(frames.hour, 10);
});

test('manual changes preserve the current frame and settle smoothly even while paused', () => {
  const cycle = new DayCycle();
  const before = cycle.state;
  cycle.setMode('afternoon');
  assert.equal(cycle.mode, 'afternoon');
  assert.deepEqual(cycle.state, before);
  const first = cycle.advance(1 / 60, false);
  assert.ok(first.hour > 9 && first.hour < 9.25);
  cycle.advance(2 - 1 / 60, false);
  assert.ok(hourDistance(cycle.hour, 15) < 0.12);
  cycle.advance(10, false);
  close(cycle.hour, 15);

  cycle.setMode('night');
  close(cycle.hour, 15);
  cycle.advance(12, false);
  close(cycle.hour, 22);
  cycle.setMode('morning');
  close(cycle.hour, 22);
  cycle.advance(12, false);
  close(cycle.hour, 9);
});

test('returning to automatic time blends toward the running clock and then stays accurate', () => {
  const cycle = new DayCycle(24, 9);
  cycle.setMode('night');
  cycle.advance(4);
  const before = cycle.state;
  cycle.setMode('cycle');
  assert.deepEqual(cycle.state, before);
  const first = cycle.advance(1 / 60);
  assert.ok(hourDistance(first.hour, before.hour) < 0.4);
  cycle.advance(12 - 1 / 60);
  close(cycle.hour, 1);
  close(cycle.advance(2).hour, 3);

  const paused = new DayCycle(24, 9);
  paused.setMode('night');
  paused.advance(12, false);
  paused.setMode('cycle');
  paused.advance(12, false);
  close(paused.hour, 9);
});

test('invalid elapsed time does not move either the clock or a manual transition', () => {
  for (const seconds of [0, -1, NaN, Infinity, -Infinity]) {
    const cycle = new DayCycle();
    cycle.setMode('night');
    const before = cycle.state;
    assert.deepEqual(cycle.advance(seconds), before);
    cycle.setMode('cycle');
    close(cycle.advance(30).hour, 10);
  }
  for (const hour of [NaN, Infinity, -Infinity]) assert.deepEqual(sampleLighting(hour), sampleLighting(9));
  for (const duration of [0, -1, NaN, Infinity]) close(new DayCycle(duration).advance(30).hour, 10);
});

test('selecting the same mode preserves an in-progress transition', () => {
  const a = new DayCycle();
  const b = new DayCycle();
  a.setMode('night');
  b.setMode('night');
  a.advance(0.25, false);
  b.advance(0.25, false);
  a.setMode('night');
  assert.deepEqual(a.advance(0.25, false), b.advance(0.25, false));
});

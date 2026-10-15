import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lamp-lighting.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { lampProfile, lampDistanceAttenuation, lampActivation, lampBrightnessScale } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('focus lamps carry a stronger direct beam while diffusers spread more local light', () => {
  assert.equal(lampProfile(1).distance, 24);
  assert.equal(lampProfile(1).intensity, 96);
  assert.deepEqual(lampProfile(1, 'focus'), lampProfile(1, 'wideLamp'));
  for (const level of [2, 3]) {
    const focus = lampProfile(level, 'focus');
    const wide = lampProfile(level, 'wideLamp');
    assert.ok(focus.distance > wide.distance);
    assert.ok(focus.angle < wide.angle);
    assert.ok(focus.penumbra < wide.penumbra);
    assert.ok(focus.scatter < wide.scatter);
    assert.ok(focus.extinction < wide.extinction);
    assert.ok(focus.intensity * lampDistanceAttenuation(12, focus)
      > wide.intensity * lampDistanceAttenuation(12, wide), 'focus illuminates a distant target more strongly');
    assert.ok(lampDistanceAttenuation(wide.distance + 1, focus) > 0);
    assert.equal(lampDistanceAttenuation(wide.distance + 1, wide), 0);
  }
});

test('distance attenuation stays bounded, decreases smoothly and reaches zero at the beam limit', () => {
  for (const path of ['focus', 'wideLamp']) {
    for (const level of [1, 2, 3]) {
      const profile = lampProfile(level, path);
      const distances = [0, 1, 5, 10, profile.distance * 0.75, profile.distance - 0.01, profile.distance];
      const transmission = distances.map(distance => lampDistanceAttenuation(distance, profile));
      for (const value of transmission) {
        assert.ok(Number.isFinite(value));
        assert.ok(value >= 0 && value <= 1);
      }
      for (let i = 1; i < transmission.length; i++) assert.ok(transmission[i] < transmission[i - 1]);
      assert.equal(transmission.at(-1), 0);
      assert.ok(transmission.at(-2) < 1e-6, 'range cutoff fades instead of ending at full brightness');
      assert.equal(lampDistanceAttenuation(profile.distance + 10, profile), 0);
    }
  }
});

test('water extinction removes light without changing the geometric cutoff', () => {
  const profile = lampProfile(3);
  const clear = { ...profile, extinction: 0 };
  const turbid = { ...profile, extinction: 0.12 };
  for (const distance of [1, 5, 15, 30]) {
    assert.ok(lampDistanceAttenuation(distance, profile) < lampDistanceAttenuation(distance, clear));
    assert.ok(lampDistanceAttenuation(distance, turbid) < lampDistanceAttenuation(distance, profile));
  }
  assert.equal(lampDistanceAttenuation(profile.distance, clear), 0);
  assert.equal(lampDistanceAttenuation(profile.distance, turbid), 0);
});

test('invalid optical inputs cannot create non-finite or amplified output', () => {
  const base = lampProfile(1);
  for (const level of [NaN, Infinity, -Infinity, -9, 0]) assert.deepEqual(lampProfile(level), base);
  assert.deepEqual(lampProfile(99), lampProfile(3));
  assert.deepEqual(lampProfile(2, 'unknown'), lampProfile(2, 'focus'));
  for (const distance of [NaN, Infinity, -Infinity]) assert.equal(lampDistanceAttenuation(distance, base), 0);
  assert.equal(lampDistanceAttenuation(-4, base), lampDistanceAttenuation(0, base));
  for (const profile of [
    { ...base, distance: NaN, decay: Infinity, extinction: NaN },
    { ...base, distance: -1, decay: -2, extinction: -3 },
  ]) {
    const value = lampDistanceAttenuation(5, profile);
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0 && value <= 1);
  }
});

test('the lamp fades under the surface and activates sooner at night', () => {
  for (const night of [0, 0.5, 1]) {
    assert.equal(lampActivation(-5, night), 0);
    assert.equal(lampActivation(0, night), 0);
    assert.equal(lampActivation(0.3, night), 0);
    assert.equal(lampActivation(48, night), 1);
    assert.equal(lampActivation(100, night), 1);
    const samples = [0.3, 0.5, 1, 2, 10, 20, 35, 48].map(depth => lampActivation(depth, night));
    for (const value of samples) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1]);
  }
  assert.equal(lampActivation(2, 0), 0.28, 'the starter lights nearby terrain before a deep dive');
  assert.ok(lampActivation(2, 1) > 0.8);
  assert.equal(lampActivation(36, 0), 1);
  assert.ok(lampActivation(1, 1) > 0 && lampActivation(1, 1) < lampActivation(2, 1));
  for (const edge of [0.3, 2, 5, 36]) {
    for (const night of [0, 1]) {
      assert.ok(Math.abs(lampActivation(edge + 1e-5, night) - lampActivation(edge - 1e-5, night)) < 1e-5);
    }
  }
});

test('environmental activation clamps invalid depth and night strengths', () => {
  for (const depth of [NaN, Infinity, -Infinity]) assert.equal(lampActivation(depth, 1), 0);
  for (const night of [NaN, Infinity, -Infinity, -1]) assert.equal(lampActivation(2, night), lampActivation(2, 0));
  assert.equal(lampActivation(2, 5), lampActivation(2, 1));
});

test('brightness preferences are bounded and do not mutate purchased optics', () => {
  const profile = { ...lampProfile(1) };
  assert.equal(lampBrightnessScale('normal'), 1);
  assert.equal(lampBrightnessScale('bright'), 1.35);
  assert.equal(lampBrightnessScale('extra'), 1.7);
  assert.equal(lampBrightnessScale('unknown'), 1);
  assert.deepEqual(lampProfile(1), profile);
});

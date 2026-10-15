import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function load(file) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const { underwaterAmbientLift, needsSurfaceGuide } = await load('dive-visibility');
const { loadSettings, saveSettings } = await load('settings');

test('deep water receives a small smooth fill lift while surface lighting is unchanged', () => {
  for (const depth of [-5, 0, 5, 12, NaN, Infinity]) assert.equal(underwaterAmbientLift(depth), 0);
  assert.equal(underwaterAmbientLift(55), 0.06);
  assert.equal(underwaterAmbientLift(1000), 0.06);
  let before = 0;
  for (let depth = 12; depth <= 60; depth += 0.1) {
    const value = underwaterAmbientLift(depth);
    assert.ok(value >= before && value <= 0.06);
    assert.ok(value - before < 0.001, 'no visible step when entering deep water');
    before = value;
  }
});

test('the ascent cue is reserved for a nearly full net or an air emergency below the surface', () => {
  assert.equal(needsSurfaceGuide(25, 4, 6, false), false);
  assert.equal(needsSurfaceGuide(25, 5, 6, false), true);
  assert.equal(needsSurfaceGuide(25, 0, 6, true), true);
  for (const depth of [0, 2.9, NaN, Infinity]) assert.equal(needsSurfaceGuide(depth, 6, 6, true), false);
  assert.equal(needsSurfaceGuide(25, 5, 0, false), false);
  assert.equal(needsSurfaceGuide(25, NaN, 6, false), false);
});

test('old and invalid settings default safely, while a selected brightness survives reload', () => {
  const previous = globalThis.localStorage;
  let stored = '{}';
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  try {
    assert.equal(loadSettings().headlampBrightness, 'normal');
    for (const value of [null, 2, false, 'unlimited']) {
      stored = JSON.stringify({ headlampBrightness: value });
      assert.equal(loadSettings().headlampBrightness, 'normal');
    }
    for (const mode of ['normal', 'bright', 'extra']) {
      saveSettings({ ...loadSettings(), headlampBrightness: mode });
      assert.equal(loadSettings().headlampBrightness, mode);
    }
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

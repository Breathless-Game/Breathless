import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/synthesis.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const synthesis = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const fish = { id: 'scale', level: 1, effect: 0.5 };
const plate = { id: 'plate', level: 2, effect: 1 };

test('state starts with exactly two empty slots and derives a bounded cost', () => {
  const state = synthesis.createSynthesisState();
  assert.deepEqual(state.slots, [null, null]);
  assert.equal(state.phase, 'empty');
  assert.equal(state.progress, 0);
  assert.ok(state.cost >= 38 && state.cost <= 899);
});

test('slot placement is immutable and makes a two-input state ready', () => {
  const empty = synthesis.createSynthesisState();
  const first = synthesis.setSynthesisSlot(empty, 0, fish);
  const ready = synthesis.setSynthesisSlot(first, 1, plate);
  assert.deepEqual(empty.slots, [null, null]);
  assert.deepEqual(first.slots, [fish, null]);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.slots.length, 2);
  assert.ok(ready.cost > empty.cost);
});

test('synthesis costs are monotonic and clamped to 38..899', () => {
  assert.equal(synthesis.synthesisCost(-10, -4), 38);
  assert.equal(synthesis.synthesisCost(Number.NaN, Number.POSITIVE_INFINITY), 38);
  assert.ok(synthesis.synthesisCost(2, 3) >= synthesis.synthesisCost(1, 3));
  assert.ok(synthesis.synthesisCost(2, 3) >= synthesis.synthesisCost(2, 2));
  assert.equal(synthesis.synthesisCost(999, 999), 899);
});

test('drop hit testing accepts padding and resolves one of two zones', () => {
  assert.equal(synthesis.dropTarget({ x: 0, y: 0 }, 4), true);
  assert.equal(synthesis.dropTarget({ x: 4, y: 4 }, 4), true);
  assert.equal(synthesis.dropTarget({ x: 4.01, y: 0 }, 4), false);
  const zones = [
    { x: 10, y: 20, width: 30, height: 20 },
    { x: 80, y: 20, width: 30, height: 20 },
  ];
  assert.equal(synthesis.releaseSlot({ x: 8, y: 30 }, zones, 2), 0);
  assert.equal(synthesis.releaseSlot({ x: 200, y: 30 }, zones, 2), null);
});

test('craft animation is monotonic and completion fires once', () => {
  let state = synthesis.createSynthesisState(1);
  state = synthesis.setSynthesisSlot(state, 0, fish);
  state = synthesis.setSynthesisSlot(state, 1, plate);
  state = synthesis.beginCraft(state);
  state = synthesis.advanceCraft(state, 0.25);
  assert.equal(state.phase, 'crafting');
  assert.equal(state.progress, 0.25);
  state = synthesis.advanceCraft(state, 0.9);
  assert.equal(state.phase, 'complete');
  assert.equal(state.progress, 1);
  assert.equal(state.completions, 1);
  const complete = synthesis.advanceCraft(state, 100);
  assert.deepEqual(complete, state);
  assert.equal(synthesis.animationProgress(0.5, 1), 0.5);
  assert.equal(synthesis.animationProgress(state), 1);
});


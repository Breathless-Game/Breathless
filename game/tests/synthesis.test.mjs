import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/synthesis.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const walletStub = `data:text/javascript;base64,${Buffer.from("export const storageKey = (name) => 'deepbreath.' + name;").toString('base64')}`;
const synthesis = await import(`data:text/javascript;base64,${Buffer.from(outputText.replace(/from ['"]\.\/wallet['"]/g, `from '${walletStub}'`)).toString('base64')}`);

test('recipes consume materials atomically and produce a persistent output count', () => {
  const start = synthesis.normalizeSynthesis({ materials: { scale: 2, fiber: 1 }, crafted: {} });
  const bait = synthesis.craft(start, 'bait');
  assert.deepEqual(bait.materials, { scale: 0, fiber: 0, scrap: 10, crystal: 3 });
  assert.equal(bait.crafted.bait, 1);
  assert.equal(synthesis.craft(bait, 'bait'), null);
  assert.deepEqual(start.materials, { scale: 2, fiber: 1, scrap: 10, crystal: 3 });
});

test('synthesis upgrade prices stay inside the requested token band', () => {
  for (const costs of Object.values(synthesis.SYNTHESIS_UPGRADE_COSTS)) {
    for (const cost of costs) assert.ok(cost >= 38 && cost <= 899);
  }
  assert.equal(synthesis.SYNTHESIS_RECIPE_COSTS.bait, 38);
  assert.equal(synthesis.SYNTHESIS_UPGRADE_COSTS.sonar[1], 899);
});

test('malformed saves are normalized to bounded integer material counts', () => {
  const state = synthesis.normalizeSynthesis({ materials: { scale: -4, fiber: 2.9, scrap: 'bad' }, crafted: { bait: 3.8 } });
  assert.deepEqual(state.materials, { scale: 0, fiber: 2, scrap: 0, crystal: 3 });
  assert.deepEqual(state.crafted, { bait: 3, composite: 0 });
});

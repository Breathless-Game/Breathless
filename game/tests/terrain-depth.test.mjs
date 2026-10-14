import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/terrain-depth.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { terrainFloorY, insideTrench, TRENCH_SWIM_HALF_WIDTH } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('finite maps have a floor everywhere, including under the boat and below the nominal depth', () => {
  for (const depth of [60, 100]) for (let x = -200; x <= 200; x += 5) {
    const sandY = -depth + Math.sin(x * 0.08) * 2;
    assert.equal(terrainFloorY(false, x, sandY), sandY);
    assert.equal(insideTrench(false, x, -1000, sandY), false);
    const clamped = Math.max(-1000, terrainFloorY(false, x, sandY) + 1.2);
    assert.ok(clamped > -depth - 2 && clamped <= -depth + 3.2);
  }
});

test('the ocean keeps its open lane and only confines a diver already below the shelf', () => {
  for (const x of [-TRENCH_SWIM_HALF_WIDTH, 0, TRENCH_SWIM_HALF_WIDTH]) {
    assert.equal(terrainFloorY(true, x, -62), -Infinity);
    assert.equal(insideTrench(true, x, -1000, -62), true);
    assert.equal(insideTrench(true, x, -30, -62), false);
  }
  for (const x of [-100, -TRENCH_SWIM_HALF_WIDTH - 0.01, TRENCH_SWIM_HALF_WIDTH + 0.01, 100]) {
    assert.equal(terrainFloorY(true, x, -62), -62);
    assert.equal(insideTrench(true, x, -1000, -62), false, 'cannot snap a shelf diver sideways into the trench');
  }
});

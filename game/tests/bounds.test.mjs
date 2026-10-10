import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/bounds.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { cameraTargetX, clampWorldX } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`,
);

test('horizontal diver coordinates remain inside the expanded playable corridor', () => {
  for (const value of [-Infinity, -141, -140, -0.25, 0, 139.9, 140, 141, Infinity]) {
    const clamped = clampWorldX(value, 140);
    assert.ok(Number.isFinite(clamped));
    assert.ok(clamped >= -140 && clamped <= 140);
  }
});

test('camera look-ahead is clamped at both map edges while preserving interior lead', () => {
  assert.equal(cameraTargetX(140, 7.5, 140), 140);
  assert.equal(cameraTargetX(-140, -7.5, 140), -140);
  assert.equal(cameraTargetX(20, 4, 140), 21.4);
  assert.equal(cameraTargetX(-20, -4, 140), -21.4);
  assert.equal(cameraTargetX(Number.NaN, 1, 140), 0);
});

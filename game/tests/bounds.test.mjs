import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/bounds.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const {
  advanceWorldBounds,
  cameraTargetX,
  cameraTargetXToBounds,
  clampWorldX,
  clampWorldXToBounds,
  createWorldBounds,
} = await import(
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

test('dynamic bounds open only toward the diver travel direction and stay terrain-safe', () => {
  const bounds = createWorldBounds(140, 200);
  advanceWorldBounds(bounds, 139, 7.5, 0.1);
  assert.equal(bounds.left, -140);
  assert.ok(bounds.right > 140 && bounds.right <= 200);
  assert.equal(clampWorldXToBounds(999, bounds), bounds.right);
  assert.equal(cameraTargetXToBounds(bounds.right, 7.5, bounds), bounds.right);

  const rightAfterOpening = bounds.right;
  advanceWorldBounds(bounds, 0, -7.5, 0.1);
  assert.equal(bounds.left, -140);
  assert.ok(bounds.right < rightAfterOpening);
});

test('dynamic bounds retract smoothly without crossing a stationary diver', () => {
  const bounds = createWorldBounds(140, 200);
  for (let i = 0; i < 30; i++) advanceWorldBounds(bounds, 139, 7.5, 0.1);
  assert.ok(bounds.right > 140);
  const diverX = 150;
  let previous = bounds.right;
  for (let i = 0; i < 20; i++) {
    advanceWorldBounds(bounds, diverX, 0, 0.1);
    assert.ok(bounds.right >= diverX + 1.5);
    assert.ok(bounds.right <= previous + 1e-9);
    previous = bounds.right;
  }
  for (let i = 0; i < 100; i++) advanceWorldBounds(bounds, 0, 0, 0.1);
  assert.equal(bounds.left, -140);
  assert.equal(bounds.right, 140);
});

test('left and right edges remain independent while the camera follows the open side', () => {
  const bounds = createWorldBounds(140, 200);
  for (let i = 0; i < 8; i++) advanceWorldBounds(bounds, -139, -7.5, 0.1);
  assert.ok(bounds.left < -140);
  assert.equal(bounds.right, 140);
  assert.equal(clampWorldXToBounds(-999, bounds), bounds.left);
  assert.equal(cameraTargetXToBounds(bounds.left, -7.5, bounds), bounds.left);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/launcher-drag.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { exceedsDragThreshold, clampPosition, toFraction, fromFraction, parseSavedPos, placePanel, LAUNCHER_POS_KEY } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`,
);

test('drag only starts beyond 5px of movement', () => {
  assert.equal(exceedsDragThreshold(0, 0), false);
  assert.equal(exceedsDragThreshold(3, 4), false);
  assert.equal(exceedsDragThreshold(4, 4), true);
  assert.equal(exceedsDragThreshold(-6, 0), true);
});

test('clamp keeps the launcher inside the viewport', () => {
  assert.deepEqual(clampPosition(-20, -5, 100, 40, 800, 600), { left: 0, top: 0 });
  assert.deepEqual(clampPosition(900, 700, 100, 40, 800, 600), { left: 700, top: 560 });
  assert.deepEqual(clampPosition(10, 20, 100, 40, 50, 30), { left: 0, top: 0 });
});

test('fractions round-trip and follow resizes', () => {
  const f = toFraction(350, 280, 100, 40, 800, 600);
  assert.deepEqual(fromFraction(f, 100, 40, 800, 600), { left: 350, top: 280 });
  const r = fromFraction({ fx: 1, fy: 1 }, 100, 40, 400, 300);
  assert.deepEqual(r, { left: 300, top: 260 });
});

test('saved position parsing falls back on bad data', () => {
  assert.equal(LAUNCHER_POS_KEY, 'deepbreath.tutorialLauncherPos');
  assert.deepEqual(parseSavedPos('{"fx":0.5,"fy":1}'), { fx: 0.5, fy: 1 });
  for (const bad of [null, '', 'nope', '{"fx":2,"fy":0}', '{"fx":"a","fy":0}', '{"fx":0}', 'null']) {
    assert.equal(parseSavedPos(bad), null);
  }
});

test('panel flips below and left-aligns near the edges', () => {
  const up = placePanel({ left: 600, top: 500, width: 150, height: 40 }, 350, 200, 800, 600, 10);
  assert.deepEqual(up, { left: 400, bottom: 110 });
  const down = placePanel({ left: 20, top: 20, width: 150, height: 40 }, 350, 200, 800, 600, 10);
  assert.deepEqual(down, { left: 20, top: 70 });
});

test('field guide wires pointer events and storage safely', async () => {
  const fg = await readFile(new URL('../src/field-guide.ts', import.meta.url), 'utf8');
  for (const s of ['pointerdown', 'setPointerCapture', 'stopPropagation', 'LAUNCHER_POS_KEY', 'dblclick']) assert.ok(fg.includes(s), s);
});

test('pointer capture starts only after the drag threshold, never on pointerdown', async () => {
  const fg = await readFile(new URL('../src/field-guide.ts', import.meta.url), 'utf8');
  const downStart = fg.indexOf("addEventListener('pointerdown'");
  const moveStart = fg.indexOf("addEventListener('pointermove'");
  assert.ok(downStart >= 0 && moveStart > downStart, 'handlers found in order');
  const downBody = fg.slice(downStart, moveStart);
  assert.ok(!downBody.includes('setPointerCapture('), 'capture in pointerdown would retarget plain clicks');
  const moveEnd = fg.indexOf("const end =", moveStart);
  const moveBody = fg.slice(moveStart, moveEnd);
  assert.ok(moveBody.includes('setPointerCapture('), 'capture must start in pointermove');
  assert.ok(moveBody.indexOf('exceedsDragThreshold') < moveBody.indexOf('setPointerCapture('), 'capture after threshold check');
});

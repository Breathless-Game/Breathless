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
  for (const s of ['pointerdown', 'stopPropagation', 'LAUNCHER_POS_KEY', 'dblclick']) assert.ok(fg.includes(s), s);
});

test('press is tracked on window, added on pointerdown and removed on end', async () => {
  const fg = await readFile(new URL('../src/field-guide.ts', import.meta.url), 'utf8');
  const downStart = fg.indexOf("el.addEventListener('pointerdown'");
  assert.ok(downStart >= 0, 'pointerdown handler found');
  const downBody = fg.slice(downStart, fg.indexOf("window.addEventListener('blur'", downStart));
  for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(downBody.includes(`window.addEventListener('${ev}'`), `${ev} added on window in pointerdown`);
  }
  assert.ok(!downBody.includes('setPointerCapture('), 'capture in pointerdown would retarget plain clicks');
  const stopStart = fg.indexOf('const stopTracking');
  const stopBody = fg.slice(stopStart, fg.indexOf('const onMove', stopStart));
  for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(stopBody.includes(`window.removeEventListener('${ev}'`), `${ev} removed in stopTracking`);
  }
  assert.ok(!/el\.addEventListener\('pointer(move|up|cancel)'/.test(fg), 'no element-level move/up listeners');
  assert.ok(!fg.includes('setPointerCapture('), 'capture is not used at all');
});

test('lost presses are abandoned instead of dragging', async () => {
  const fg = await readFile(new URL('../src/field-guide.ts', import.meta.url), 'utf8');
  const moveStart = fg.indexOf('const onMove');
  const moveBody = fg.slice(moveStart, fg.indexOf('const end =', moveStart));
  const guard = moveBody.indexOf("event.pointerType === 'mouse' && event.buttons === 0");
  assert.ok(guard >= 0, 'buttons === 0 guard exists');
  assert.ok(guard < moveBody.indexOf('exceedsDragThreshold'), 'guard runs before the drag threshold');
  assert.ok(fg.includes("window.addEventListener('blur'"), 'blur clears the press');
  assert.ok(fg.includes("'visibilitychange'"), 'visibilitychange clears the press');
});

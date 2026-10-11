import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The module is browser-independent; transpile it in memory to keep tests usable on Node 20.
const source = await readFile(new URL('../src/render-quality.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { AdaptiveQuality, initialQuality, renderPixelRatio, RENDER_QUALITY } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

// Binary-exact frame durations avoid rounding at sampling-window boundaries.
function runFrames(controller, duration, fps = 32, visible = true) {
  const changes = [];
  for (let frame = 0; frame < duration * fps; frame++) {
    const change = controller.observeFrame(1 / fps, visible);
    if (change !== null) changes.push(change);
  }
  return changes;
}

test('missing hardware hints use medium quality, while weak cores or memory use low', () => {
  assert.equal(initialQuality({}), 'medium');
  assert.equal(initialQuality({ cores: 0, memoryGB: 0 }), 'medium');
  assert.equal(initialQuality({ cores: 4 }), 'low');
  assert.equal(initialQuality({ cores: 2, memoryGB: 16 }), 'low');
  assert.equal(initialQuality({ cores: 16, memoryGB: 4 }), 'low');
  assert.equal(initialQuality({ cores: 6, memoryGB: 8 }), 'medium');
  assert.equal(initialQuality({ cores: 8, memoryGB: 6 }), 'medium');
});

test('high quality requires enough cores and sufficient memory when available', () => {
  assert.equal(initialQuality({ cores: 8, memoryGB: 8 }), 'high');
  assert.equal(initialQuality({ cores: 16, memoryGB: 16 }), 'high');
  assert.equal(initialQuality({ cores: 8 }), 'high');
  assert.equal(initialQuality({ memoryGB: 16 }), 'medium');
});

test('pixel ratio honors device ratio, quality cap, and the total pixel budget', () => {
  for (const quality of Object.values(RENDER_QUALITY)) {
    assert.equal(renderPixelRatio(quality, 640, 360, 0.75), 0.75);
    assert.equal(renderPixelRatio(quality, 640, 360, 4), quality.maxPixelRatio);

    const width = 7680;
    const height = 4320;
    const ratio = renderPixelRatio(quality, width, height, 3);
    assert.ok(ratio > 0 && ratio < 1, 'large screens can render below native resolution');
    assert.ok(width * height * ratio ** 2 <= quality.maxPixels + 1e-6);
  }
  assert.equal(renderPixelRatio(RENDER_QUALITY.low, 0, 0, 0), 1);
});

test('character particle budgets scale with quality', () => {
  const low = RENDER_QUALITY.low;
  const medium = RENDER_QUALITY.medium;
  const high = RENDER_QUALITY.high;
  assert.ok(low.bubbleLimit > 0);
  assert.ok(low.bubbleLimit < medium.bubbleLimit);
  assert.ok(medium.bubbleLimit < high.bubbleLimit);
  assert.ok(low.bubbleEmitScale < medium.bubbleEmitScale);
  assert.ok(medium.bubbleEmitScale < high.bubbleEmitScale);
  assert.ok(low.bubbleHz < medium.bubbleHz);
  assert.ok(medium.bubbleHz < high.bubbleHz);
  assert.equal(low.bubbleSegments, 0);
  assert.equal(medium.bubbleSegments, 0);
  assert.equal(high.bubbleSegments, 1);
});

test('sustained slow rendering drops only one quality level after startup grace', () => {
  const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 8), []);
  assert.equal(controller.level, 'high');
  assert.deepEqual(runFrames(controller, 1), ['medium']);
  assert.equal(controller.settings, RENDER_QUALITY.medium);
});

test('a recovered sampling window clears an isolated period of slow rendering', () => {
  const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 6), []);
  assert.deepEqual(runFrames(controller, 3, 64), []);
  assert.deepEqual(runFrames(controller, 3), []);
  assert.equal(controller.level, 'high');
  assert.deepEqual(runFrames(controller, 3, 64), []);
  assert.equal(controller.level, 'high');
});

test('hidden pages and suspension frames discard earlier slow samples', () => {
  for (const [seconds, visible] of [
    [1 / 32, false],
    [1, true],
    [Number.NaN, true],
    [Number.POSITIVE_INFINITY, true],
    [0, true],
    [-1, true],
  ]) {
    const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
    runFrames(controller, 6);
    assert.equal(controller.observeFrame(seconds, visible), null);
    assert.deepEqual(runFrames(controller, 6), []);
    assert.equal(controller.level, 'high');
  }

  const hiddenController = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(hiddenController, 30, 32, false), []);
  assert.equal(hiddenController.level, 'high');
});

test('one or two isolated long frames do not degrade quality', () => {
  const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  runFrames(controller, 6);
  assert.equal(controller.observeFrame(0.5), null);
  assert.equal(controller.observeFrame(0.5), null);
  assert.deepEqual(runFrames(controller, 6), []);
  assert.equal(controller.level, 'high');
});

test('persistently rendering below 4 FPS still degrades to low quality', () => {
  for (const seconds of [0.3, 0.5]) {
    const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
    const changes = [];
    for (let frame = 0; frame < 100; frame++) {
      const change = controller.observeFrame(seconds);
      if (change !== null) changes.push(change);
    }
    assert.deepEqual(changes, ['medium', 'low']);
    assert.equal(controller.level, 'low');
  }
});

test('cooldown prevents immediate further degradation and low is the minimum', () => {
  const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 9), ['medium']);
  assert.deepEqual(runFrames(controller, 11.5), []);
  assert.equal(controller.level, 'medium');
  assert.deepEqual(runFrames(controller, 0.5), ['low']);
  assert.equal(controller.settings, RENDER_QUALITY.low);
  assert.deepEqual(runFrames(controller, 120), []);
  assert.equal(controller.level, 'low');
});

test('recovery does not automatically upgrade quality and restart a degradation cycle', () => {
  const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  runFrames(controller, 9);
  assert.deepEqual(runFrames(controller, 60, 64), []);
  assert.equal(controller.level, 'medium');
});

test('manual quality overrides hardware hints and never degrades during slow rendering', () => {
  for (const level of ['high', 'medium', 'low']) {
    for (const hints of [{ cores: 2, memoryGB: 2 }, { cores: 16, memoryGB: 16 }]) {
      const controller = new AdaptiveQuality(hints, level);
      assert.equal(controller.mode, level);
      assert.equal(controller.level, level);
      assert.equal(controller.settings, RENDER_QUALITY[level]);
      assert.deepEqual(runFrames(controller, 120), []);
      assert.equal(controller.level, level);
    }
  }
});

test('switching between manual and auto quality restores hardware selection and fresh sampling', () => {
  const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  assert.equal(controller.mode, 'auto');
  runFrames(controller, 6);

  for (const level of ['low', 'medium', 'high']) {
    controller.setMode(level);
    assert.equal(controller.mode, level);
    assert.equal(controller.level, level);
    assert.equal(controller.settings, RENDER_QUALITY[level]);
    assert.deepEqual(runFrames(controller, 30), []);
  }

  controller.setMode('auto');
  assert.equal(controller.mode, 'auto');
  assert.equal(controller.level, 'high');
  assert.deepEqual(runFrames(controller, 8), []);
  assert.deepEqual(runFrames(controller, 1), ['medium']);

  const weakController = new AdaptiveQuality({ cores: 2, memoryGB: 2 }, 'high');
  weakController.setMode('auto');
  assert.equal(weakController.level, 'low');
  assert.equal(weakController.settings, RENDER_QUALITY.low);
});

test('selecting auto again preserves its degraded quality and remaining sampling state', () => {
  const controller = new AdaptiveQuality({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 9), ['medium']);
  controller.setMode('auto');
  assert.equal(controller.mode, 'auto');
  assert.equal(controller.level, 'medium');
  assert.deepEqual(runFrames(controller, 11.5), []);

  controller.setMode('auto');
  assert.equal(controller.level, 'medium');
  assert.deepEqual(runFrames(controller, 0.5), ['low']);
  assert.equal(controller.level, 'low');
});

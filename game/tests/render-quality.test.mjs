import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The module is browser-independent; transpile it in memory to keep tests usable on Node 20.
const source = await readFile(new URL('../src/render-quality.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { AdaptiveQuality, AUTO_QUALITY_KEY, AUTO_QUALITY_TTL_MS, gpuQualityCap, initialQuality, renderPixelRatio, RENDER_QUALITY } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

// No localStorage under Node: each test opts into a store explicitly.
function make(hints, mode = 'auto', options = { store: null }) {
  return new AdaptiveQuality(hints, mode, options);
}

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

test('GPU renderer strings cap the starting tier, and unknown GPUs give no information', () => {
  const cases = [
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)', 'medium'],
    ['ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Unspecified Version)', 'medium'],
    ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'medium'],
    ['Intel(R) HD Graphics 400, or similar', 'medium'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['Mali-G78 MC24', 'medium'],
    ['Adreno (TM) 640', 'medium'],
    ['PowerVR Rogue GE8320', 'medium'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'low'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', null],
    ['ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', null],
    ['ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1)', null],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', null],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', null],
    ['Apple GPU', null],
    ['NVIDIA GeForce GTX 980, or similar', null],
    ['WebKit WebGL', null],
    ['', null],
    [null, null],
    [undefined, null],
  ];
  for (const [renderer, cap] of cases) assert.equal(gpuQualityCap(renderer), cap, renderer);
});

test('the GPU only lowers the hardware tier and never overrides a manual one', () => {
  const strong = { cores: 8, memoryGB: 8 };
  for (const [renderer, level] of [
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['Google SwiftShader', 'low'],
    ['Apple GPU', 'high'],
    ['', 'high'],
  ]) {
    const controller = make(strong);
    controller.applyGpu(renderer);
    assert.equal(controller.gpu, renderer);
    assert.equal(controller.level, level);
  }

  const weak = make({ cores: 4 });
  weak.applyGpu('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)');
  assert.equal(weak.level, 'low');

  const manual = make(strong, 'high');
  manual.applyGpu('Google SwiftShader');
  assert.equal(manual.level, 'high');
  manual.setMode('auto');
  assert.equal(manual.level, 'low');
});

test('sustained slow rendering drops only one quality level about 4 s in', () => {
  const controller = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 3.5), []);
  assert.equal(controller.level, 'high');
  assert.deepEqual(runFrames(controller, 0.5), ['medium']);
  assert.equal(controller.settings, RENDER_QUALITY.medium);
});

test('a fast sampling window keeps quality', () => {
  const controller = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 1.25), []);
  assert.deepEqual(runFrames(controller, 30, 64), []);
  assert.equal(controller.level, 'high');
});

test('isolated long frames are skipped without restarting the measurement', () => {
  const controller = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 3), []);
  assert.equal(controller.observeFrame(0.5), null);
  assert.equal(controller.observeFrame(0.5), null);
  assert.deepEqual(runFrames(controller, 1), ['medium']);

  // Periodic hitches neither block a slow machine nor degrade a fast one.
  for (const [fps, expected] of [[32, ['medium', 'low']], [64, []]]) {
    const hitched = make({ cores: 8, memoryGB: 8 });
    const changes = [];
    for (let second = 0; second < 30; second++) {
      changes.push(...runFrames(hitched, 1, fps));
      if (second % 5 === 4) assert.equal(hitched.observeFrame(0.3), null);
    }
    assert.deepEqual(changes, expected);
  }
});

test('persistently rendering below 4 FPS still degrades to low quality', () => {
  for (const seconds of [0.3, 0.5]) {
    const controller = make({ cores: 8, memoryGB: 8 });
    const changes = [];
    for (let frame = 0; frame < 100; frame++) {
      const change = controller.observeFrame(seconds);
      if (change !== null) changes.push(change);
    }
    assert.deepEqual(changes, ['medium', 'low']);
    assert.equal(controller.level, 'low');
  }
});

test('frames right after a tier switch are skipped, then a fresh window decides', () => {
  const controller = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 4), ['medium']);
  // The switch's own hitch (setQuality + resize) and a slow shader-compile frame.
  assert.equal(controller.observeFrame(0.5), null);
  assert.equal(controller.observeFrame(0.2), null);
  assert.deepEqual(runFrames(controller, 10, 64), []);
  assert.equal(controller.level, 'medium');

  const slow = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(slow, 4), ['medium']);
  // Two skipped frames, then grace and one window: the next step comes 4 s later, not sooner.
  assert.deepEqual(runFrames(slow, 4), []);
  assert.deepEqual(runFrames(slow, 0.0625), ['low']);
  assert.equal(slow.settings, RENDER_QUALITY.low);
  assert.deepEqual(runFrames(slow, 120), []);
  assert.equal(slow.level, 'low');
});

test('pauses hold the sampling window and invalid frames are ignored', () => {
  for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const controller = make({ cores: 8, memoryGB: 8 });
    runFrames(controller, 3.5);
    assert.equal(controller.observeFrame(seconds), null);
    assert.deepEqual(runFrames(controller, 0.5), ['medium']);
  }

  // A short pause keeps the window and only waits 0.5 s on return.
  const short = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(short, 3), []);
  assert.deepEqual(runFrames(short, 1, 32, false), []);
  assert.deepEqual(runFrames(short, 0.5), []);
  assert.deepEqual(runFrames(short, 1), ['medium']);

  // A long pause waits out the full grace again.
  const long = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(long, 3), []);
  assert.deepEqual(runFrames(long, 30, 32, false), []);
  assert.deepEqual(runFrames(long, 1.25), []);
  assert.deepEqual(runFrames(long, 1), ['medium']);

  const hidden = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(hidden, 30, 32, false), []);
  assert.equal(hidden.level, 'high');
});

test('recovery within a session does not upgrade quality and restart a degradation cycle', () => {
  const controller = make({ cores: 8, memoryGB: 8 });
  runFrames(controller, 4);
  assert.deepEqual(runFrames(controller, 120, 64), []);
  assert.equal(controller.level, 'medium');
});

test('manual quality overrides hardware hints and never degrades during slow rendering', () => {
  for (const level of ['high', 'medium', 'low']) {
    for (const hints of [{ cores: 2, memoryGB: 2 }, { cores: 16, memoryGB: 16 }]) {
      const controller = make(hints, level);
      assert.equal(controller.mode, level);
      assert.equal(controller.level, level);
      assert.equal(controller.settings, RENDER_QUALITY[level]);
      assert.deepEqual(runFrames(controller, 120), []);
      assert.equal(controller.level, level);
    }
  }
});

test('switching between manual and auto quality restores hardware selection and fresh sampling', () => {
  const controller = make({ cores: 8, memoryGB: 8 });
  assert.equal(controller.mode, 'auto');
  runFrames(controller, 3);

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
  assert.deepEqual(runFrames(controller, 3.5), []);
  assert.deepEqual(runFrames(controller, 0.5), ['medium']);

  const weakController = make({ cores: 2, memoryGB: 2 }, 'high');
  weakController.setMode('auto');
  assert.equal(weakController.level, 'low');
  assert.equal(weakController.settings, RENDER_QUALITY.low);
});

test('selecting auto again preserves its degraded quality and remaining sampling state', () => {
  const controller = make({ cores: 8, memoryGB: 8 });
  assert.deepEqual(runFrames(controller, 4), ['medium']);
  controller.setMode('auto');
  assert.equal(controller.mode, 'auto');
  assert.equal(controller.level, 'medium');
  assert.deepEqual(runFrames(controller, 4), []);

  controller.setMode('auto');
  assert.equal(controller.level, 'medium');
  assert.deepEqual(runFrames(controller, 0.0625), ['low']);
  assert.equal(controller.level, 'low');
});

const UHD = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)';
const DAY = 24 * 60 * 60 * 1000;

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function saved(store) {
  const raw = store.map.get(AUTO_QUALITY_KEY);
  return raw == null ? null : JSON.parse(raw);
}

test('an automatic drop is remembered per device and the next load starts there', () => {
  let now = 1_000_000;
  const store = memoryStore();
  const first = make({ cores: 8, memoryGB: 8 }, 'auto', { store, now: () => now });
  first.applyGpu(RTX);
  assert.equal(first.level, 'high');
  assert.deepEqual(runFrames(first, 4), ['medium']);
  assert.deepEqual(saved(store), { level: 'medium', gpu: RTX, at: now });

  now += 2 * DAY;
  const second = make({ cores: 8, memoryGB: 8 }, 'auto', { store, now: () => now });
  assert.equal(second.level, 'medium');
  second.applyGpu(RTX);
  assert.equal(second.level, 'medium');
  assert.equal(second.settings, RENDER_QUALITY.medium);

  // The lower of the hardware tier and the remembered one wins.
  const weak = make({ cores: 4 }, 'auto', { store, now: () => now });
  assert.equal(weak.level, 'low');
  assert.equal(AUTO_QUALITY_KEY.startsWith('deepbreath.'), true);
});

test('a remembered drop expires, follows its GPU, and survives broken storage', () => {
  const at = 5_000_000;
  const record = (level, gpu = RTX) => JSON.stringify({ level, gpu, at });

  const expired = memoryStore({ [AUTO_QUALITY_KEY]: record('low') });
  const fresh = make({ cores: 8, memoryGB: 8 }, 'auto', { store: expired, now: () => at + AUTO_QUALITY_TTL_MS });
  assert.equal(fresh.level, 'high');
  assert.equal(saved(expired), null);

  const moved = memoryStore({ [AUTO_QUALITY_KEY]: record('low') });
  const other = make({ cores: 8, memoryGB: 8 }, 'auto', { store: moved, now: () => at + DAY });
  assert.equal(other.level, 'low');
  other.applyGpu('ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)');
  assert.equal(other.level, 'high');
  assert.equal(saved(moved), null);

  for (const raw of ['{', '"medium"', JSON.stringify({ level: 'high', gpu: RTX, at }), JSON.stringify({ level: 'low', gpu: RTX })]) {
    const store = memoryStore({ [AUTO_QUALITY_KEY]: raw });
    assert.equal(make({ cores: 8, memoryGB: 8 }, 'auto', { store, now: () => at }).level, 'high');
  }

  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); } };
  const controller = make({ cores: 8, memoryGB: 8 }, 'auto', { store: throwing });
  assert.equal(controller.level, 'high');
  assert.deepEqual(runFrames(controller, 4), ['medium']);
});

test('a remembered automatic tier never overrides a manual one', () => {
  const store = memoryStore({ [AUTO_QUALITY_KEY]: JSON.stringify({ level: 'low', gpu: RTX, at: 0 }) });
  const controller = make({ cores: 8, memoryGB: 8 }, 'high', { store, now: () => DAY });
  controller.applyGpu(RTX);
  assert.equal(controller.level, 'high');
  assert.deepEqual(runFrames(controller, 120), []);
  controller.setMode('medium');
  assert.equal(controller.level, 'medium');
  controller.setMode('auto');
  assert.equal(controller.level, 'low');
});

test('one cautious upgrade per session undoes a remembered drop on a smooth machine', () => {
  let now = DAY;
  const store = memoryStore({ [AUTO_QUALITY_KEY]: JSON.stringify({ level: 'medium', gpu: RTX, at: 0 }) });
  const controller = make({ cores: 8, memoryGB: 8 }, 'auto', { store, now: () => now });
  controller.applyGpu(RTX);
  assert.equal(controller.level, 'medium');

  // Sub-58 FPS windows never count toward it.
  assert.deepEqual(runFrames(controller, 120, 50), []);
  assert.deepEqual(runFrames(controller, 55, 64), []);
  assert.deepEqual(runFrames(controller, 10, 64), ['high']);
  assert.equal(saved(store), null);

  // If high is too much after all, it drops back, remembers that, and stays.
  now += DAY;
  assert.deepEqual(runFrames(controller, 5), ['medium']);
  assert.deepEqual(saved(store), { level: 'medium', gpu: RTX, at: now });
  assert.deepEqual(runFrames(controller, 300, 64), []);
  assert.equal(controller.level, 'medium');

  // Never above the GPU's cap, and a level still below it stays remembered.
  const capped = memoryStore({ [AUTO_QUALITY_KEY]: JSON.stringify({ level: 'low', gpu: UHD, at: 0 }) });
  const integrated = make({ cores: 8, memoryGB: 8 }, 'auto', { store: capped, now: () => DAY });
  integrated.applyGpu(UHD);
  assert.equal(integrated.level, 'low');
  assert.deepEqual(runFrames(integrated, 300, 64), ['medium']);
  assert.equal(saved(capped), null);

  const deeper = memoryStore({ [AUTO_QUALITY_KEY]: JSON.stringify({ level: 'low', gpu: RTX, at: 0 }) });
  const stepped = make({ cores: 8, memoryGB: 8 }, 'auto', { store: deeper, now: () => DAY });
  stepped.applyGpu(RTX);
  assert.deepEqual(runFrames(stepped, 300, 64), ['medium']);
  assert.equal(saved(deeper).level, 'medium');
});

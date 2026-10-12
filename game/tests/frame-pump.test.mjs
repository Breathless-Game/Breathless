import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const load = async (file) => {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const p = await load('frame-pump.ts');
const breath = await readFile(new URL('../src/breath.ts', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/camera-encoder.worker.ts', import.meta.url), 'utf8');

/** Frames at `fps` for `seconds`, each `jitter` ms early or late at random; returns how many the pacer admits. */
function run(pacer, fps, seconds, jitter = 0, seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let admitted = 0;
  for (let k = 0; k < fps * seconds; k++) if (pacer.admit((k * 1000) / fps + rand() * jitter)) admitted++;
  return admitted;
}

test('pacer: a 30 fps camera passes whole, even with jitter', () => {
  assert.equal(run(new p.FramePacer(), 30, 10), 300);
  assert.equal(run(new p.FramePacer(), 30, 10, 8), 300, '±8 ms of jitter costs no frame');
});

test('pacer: a faster camera is held to SEND_FPS', () => {
  assert.equal(p.SEND_FPS, 30);
  for (const fps of [60, 90, 120]) {
    const n = run(new p.FramePacer(), fps, 10, 2);
    assert.ok(n >= 299 && n <= 302, `${fps} fps camera -> ${n} frames in 10 s`);
  }
});

test('pacer: a slower camera passes whole', () => {
  assert.equal(run(new p.FramePacer(), 15, 10, 5), 150);
});

test('pacer: one frame a second while waiting for a busy slot, and back', () => {
  const pacer = new p.FramePacer();
  assert.ok(pacer.admit(0));
  pacer.setInterval(1000);
  let n = 0;
  for (let t = 33; t < 10_000; t += 33) if (pacer.admit(t)) n++;
  assert.ok(n >= 9 && n <= 10, `${n} frames in ~10 s`);
  pacer.setInterval(1000 / 30);
  assert.equal(pacer.interval, 1000 / 30);
});

test('pacer: never more than the burst at once, even after a long pause', () => {
  const pacer = new p.FramePacer();
  pacer.admit(0);
  let n = 0;
  for (let i = 0; i < 10; i++) if (pacer.admit(60_000 + i * 0.1)) n++;
  assert.equal(n, 2);
});

test('in order: encodes that finish out of order are released in capture order', () => {
  const q = new p.InOrderQueue(2);
  const a = q.begin();
  const b = q.begin();
  assert.deepEqual([a, b], [0, 1]);
  assert.deepEqual(q.complete(b, 'B'), [], 'B waits for A');
  assert.deepEqual(q.complete(a, 'A'), ['A', 'B']);
  assert.equal(q.inFlight, 0);
});

test('in order: at most two in flight', () => {
  assert.equal(p.MAX_ENCODES_IN_FLIGHT, 2);
  const q = new p.InOrderQueue();
  assert.notEqual(q.begin(), null);
  assert.notEqual(q.begin(), null);
  assert.equal(q.begin(), null, 'a third waits');
  assert.equal(q.inFlight, 2);
  assert.deepEqual(q.complete(0, 'A'), ['A']);
  assert.equal(q.begin(), 2);
});

test('in order: a failed encode lets the frames behind it out', () => {
  const q = new p.InOrderQueue(2);
  q.begin();
  q.begin();
  assert.deepEqual(q.complete(1, 'B'), []);
  assert.deepEqual(q.complete(0, null), ['B']);
});

test('in order: results from before a reset, duplicates and unknown seqs are ignored', () => {
  const q = new p.InOrderQueue(2);
  const old = q.begin();
  q.reset();
  assert.equal(q.inFlight, 0);
  assert.deepEqual(q.complete(old, 'stale'), []);
  const s = q.begin();
  assert.deepEqual(q.complete(s + 5, 'x'), []);
  assert.deepEqual(q.complete(s, 'A'), ['A']);
  assert.deepEqual(q.complete(s, 'A again'), []);
});

test('in order: a long run never reorders or loses a frame', () => {
  const q = new p.InOrderQueue(2);
  const out = [];
  const pending = [];
  let s = 7;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1000; i++) {
    const seq = q.begin();
    if (seq !== null) pending.push(seq);
    if (pending.length && (seq === null || rand() < 0.5)) {
      const k = Math.floor(rand() * pending.length);
      const [done] = pending.splice(k, 1);
      out.push(...q.complete(done, done));
    }
  }
  for (const done of pending) out.push(...q.complete(done, done));
  assert.deepEqual(out, [...out].sort((a, b) => a - b));
  assert.equal(new Set(out).size, out.length);
});

test('capture pipe: worker + MediaStreamTrackProcessor, else ImageBitmaps, else the canvas; raw stays raw', () => {
  const all = { format: 'jpeg', worker: true, workerCanEncode: true, trackProcessor: true, imageBitmap: true };
  assert.equal(p.pickCapturePipe(all), 'mstp');
  assert.equal(p.pickCapturePipe({ ...all, trackProcessor: false }), 'bitmap');
  assert.equal(p.pickCapturePipe({ ...all, trackProcessor: false, imageBitmap: false }), 'canvas');
  assert.equal(p.pickCapturePipe({ ...all, workerCanEncode: false }), 'canvas');
  assert.equal(p.pickCapturePipe({ ...all, worker: false }), 'canvas');
  assert.equal(p.pickCapturePipe({ ...all, format: 'raw' }), 'raw');
  for (const pipe of ['mstp', 'bitmap', 'canvas', 'raw']) assert.ok(p.CAPTURE_PIPES.includes(pipe));
});

test('stats: rates over the window, counts, average encode time, then a fresh window', () => {
  const s = new p.FrameStats(1000);
  assert.ok(!s.due(1000 + p.STATS_INTERVAL_MS - 1));
  assert.ok(s.due(1000 + p.STATS_INTERVAL_MS));
  s.captured = 300;
  s.rvfc = 120;
  s.render = 125;
  s.sent = 290;
  s.skippedEncoder = 4;
  s.skippedBackpressure = 6;
  s.encodedIn(4);
  s.encodedIn(6);
  s.encodedIn(NaN);
  const msg = s.snapshot(11_000, { pipe: 'mstp', camFps: 30, quality: 0.7 });
  assert.deepEqual(msg, {
    t: 'stats',
    pipe: 'mstp',
    camFps: 30,
    capFps: 30,
    rvfcFps: 12,
    renderFps: 12.5,
    sentFps: 29,
    skippedEncoder: 4,
    skippedBackpressure: 6,
    encodeMsAvg: 5,
    quality: 0.7,
  });
  const next = s.snapshot(21_000, { pipe: 'mstp', camFps: NaN, quality: 0.7 });
  assert.equal(next.sentFps, 0);
  assert.equal(next.encodeMsAvg, 0);
  assert.equal(next.camFps, 0, 'a camera that reports no frame rate');
});

test('stats carry performance numbers only', () => {
  const msg = new p.FrameStats(0).snapshot(10_000, { pipe: 'canvas', camFps: 30, quality: 0.7 });
  assert.deepEqual(Object.keys(msg).sort(), [
    'camFps', 'capFps', 'encodeMsAvg', 'pipe', 'quality', 'renderFps', 'rvfcFps', 'sentFps',
    'skippedBackpressure', 'skippedEncoder', 't',
  ].sort());
  assert.doesNotMatch(JSON.stringify(msg), /holding|trace|"rate"|pulse|baseline|breath/);
});

// The worker and breath.ts need a browser; these pin the wiring at the source level.
test('the worker is loaded the Vite way, as a module', () => {
  assert.match(breath, /new Worker\(new URL\('\.\/camera-encoder\.worker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/);
});

test('the worker writes the same frame header as the main thread (frame-codec.ts)', () => {
  assert.match(worker, /from '\.\/frame-codec'/);
  assert.match(worker, /writeFrameHeader\(new DataView\(wire\.buffer, 0, HEADER_BYTES\), ts, width, height, 'jpeg'\)/);
  assert.match(worker, /type: 'image\/jpeg'/);
});

test('the worker closes every camera frame it reads', () => {
  const loop = worker.slice(worker.indexOf('async function readStream('), worker.indexOf('scope.onmessage'));
  const reads = loop.match(/continue;/g)?.length ?? 0;
  const closes = loop.match(/frame\.close\(\);\s*continue;/g)?.length ?? 0;
  assert.equal(closes, reads, 'every skipped frame is closed');
  assert.match(worker, /finally \{\s*source\.close\(\);/);
});

test('breath.ts: the processor gets a clone of the track, stopped with the pipeline', () => {
  assert.match(breath, /const clone = track\.clone\(\);/);
  const stop = breath.slice(breath.indexOf('  private stopCapture() {'), breath.indexOf('  private syncGate('));
  assert.match(stop, /this\.processorTrack\?\.stop\(\)/);
  const release = breath.slice(breath.indexOf('  private releaseCamera() {'), breath.indexOf('  private watchTrack('));
  assert.match(release, /this\.stopCapture\(\)/);
});

test('breath.ts: worker frames still go through the busy wait and the backpressure check', () => {
  const send = breath.slice(breath.indexOf('  private sendJpeg('), breath.indexOf('  private startEncoder('));
  assert.match(send, /busyFrameDue\(/);
  assert.match(send, /bufferedAmount >= MAX_BUFFERED\.jpeg/);
  assert.match(send, /this\.jpegQuality\.skipped\(/);
  assert.match(send, /f\.ts <= this\.lastSentTs/, 'timestamps only ever increase');
});

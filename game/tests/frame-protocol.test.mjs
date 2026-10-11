import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
// The sensor's parser has no dependencies, so the browser writer and the server reader
// are tested against each other here.
import { FrameFormat, HEADER_BYTES, MAX_JPEG_PIXELS, parseFrame } from '../../sensor/frames.mjs';

const source = await readFile(new URL('../src/frame-codec.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const codec = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const TS = 1_791_659_643_702.25; // ms, like performance.timeOrigin + performance.now()

function frame(format, width, height, payload, ts = TS) {
  const buf = Buffer.alloc(codec.HEADER_BYTES + payload.length);
  codec.writeFrameHeader(new DataView(buf.buffer, buf.byteOffset, codec.HEADER_BYTES), ts, width, height, format);
  Buffer.from(payload).copy(buf, codec.HEADER_BYTES);
  return buf;
}
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

test('both ends agree on the header size', () => {
  assert.equal(codec.HEADER_BYTES, 12);
  assert.equal(HEADER_BYTES, 12);
});

test('a raw RGBA frame parses as raw with its size and timestamp', () => {
  const rgba = Buffer.alloc(640 * 480 * 4, 7);
  const f = parseFrame(frame('raw', 640, 480, rgba));
  assert.equal(f.format, FrameFormat.RAW);
  assert.equal(f.width, 640);
  assert.equal(f.height, 480);
  assert.equal(f.tsUs, Math.round(TS * 1000));
  assert.equal(f.payload.byteLength, rgba.length);
  assert.equal(f.payload[0], 7);
});

test('raw frames are byte-for-byte the original protocol (old clients still parse)', () => {
  const rgba = Buffer.alloc(4 * 3 * 4, 1);
  const legacy = Buffer.alloc(12 + rgba.length);
  legacy.writeDoubleLE(TS, 0);
  legacy.writeUInt16LE(4, 8);
  legacy.writeUInt16LE(3, 10);
  rgba.copy(legacy, 12);
  assert.deepEqual(frame('raw', 4, 3, rgba), legacy);
  const f = parseFrame(legacy);
  assert.equal(f.format, FrameFormat.RAW);
  assert.equal(f.width, 4);
});

test('a JPEG frame carries the format in the top bits of the width field', () => {
  const buf = frame('jpeg', 640, 480, FAKE_JPEG);
  assert.equal(buf.readUInt16LE(8), 0x1000 | 640);
  const f = parseFrame(buf);
  assert.equal(f.format, FrameFormat.JPEG);
  assert.equal(f.width, 640);
  assert.equal(f.height, 480);
  assert.equal(f.tsUs, Math.round(TS * 1000));
  assert.deepEqual(Buffer.from(f.payload), FAKE_JPEG);
});

test('parseFrame works on a Buffer that is a slice of a bigger one', () => {
  const inner = frame('jpeg', 64, 48, FAKE_JPEG);
  const outer = Buffer.concat([Buffer.alloc(5), inner, Buffer.alloc(3)]);
  const f = parseFrame(outer.subarray(5, 5 + inner.length));
  assert.equal(f.width, 64);
  assert.equal(f.payload[0], 0xff);
});

test('malformed frames are rejected', () => {
  assert.equal(parseFrame(Buffer.alloc(11)), null, 'shorter than the header');
  assert.equal(parseFrame(frame('raw', 4, 3, Buffer.alloc(4 * 3 * 4 - 1))), null, 'raw size mismatch');
  assert.equal(parseFrame(frame('jpeg', 64, 48, Buffer.from('not a jpeg at all'))), null, 'JPEG flag, no JPEG');
  assert.equal(parseFrame(frame('jpeg', 64, 48, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))), null, 'PNG');
  assert.equal(parseFrame(frame('jpeg', 64, 48, Buffer.alloc(0))), null, 'empty JPEG');
  const unknown = frame('jpeg', 64, 48, FAKE_JPEG);
  unknown.writeUInt16LE((2 << 12) | 64, 8);
  assert.equal(parseFrame(unknown), null, 'unknown format');
  const zero = frame('raw', 1, 1, Buffer.alloc(4));
  zero.writeUInt16LE(0, 8);
  assert.equal(parseFrame(zero), null, 'zero width');
  const huge = frame('jpeg', 4095, 4095, FAKE_JPEG);
  assert.ok(4095 * 4095 > MAX_JPEG_PIXELS);
  assert.equal(parseFrame(huge), null, 'JPEG claiming too many pixels');
  const nan = frame('raw', 1, 1, Buffer.alloc(4), NaN);
  assert.equal(parseFrame(nan), null, 'NaN timestamp');
});

test('the header refuses sizes it cannot carry', () => {
  const view = new DataView(new ArrayBuffer(12));
  assert.throws(() => codec.writeFrameHeader(view, TS, 4096, 480, 'jpeg'), RangeError);
  assert.throws(() => codec.writeFrameHeader(view, TS, 0, 480, 'raw'), RangeError);
});

test('frame format: raw only for a dev build next to a local sensor; overrides win', () => {
  const pick = (dev, sensorUrl, override) => codec.pickFrameFormat({ dev, sensorUrl, override });
  assert.equal(pick(true, 'ws://localhost:8787'), 'raw');
  assert.equal(pick(true, 'ws://127.0.0.1:8787'), 'raw');
  assert.equal(pick(true, 'ws://[::1]:8787'), 'raw');
  assert.equal(pick(true, 'ws://192.168.1.20:8787'), 'jpeg', 'dev over Wi-Fi / LAN');
  assert.equal(pick(true, 'wss://breathless.example.com/sensor'), 'jpeg');
  assert.equal(pick(false, 'ws://127.0.0.1:8794/sensor'), 'jpeg', 'production build, even locally');
  assert.equal(pick(false, 'wss://breathless.example.com/sensor'), 'jpeg');
  assert.equal(pick(false, 'wss://breathless.example.com/sensor', 'raw'), 'raw');
  assert.equal(pick(true, 'ws://localhost:8787', 'JPEG'), 'jpeg');
  assert.equal(pick(true, 'ws://localhost:8787', 'webp'), 'raw', 'unknown override is ignored');
  assert.equal(pick(true, 'not a url'), 'jpeg');
});

// Feeds one 1 s window (window k spans k*1000 .. (k+1)*1000 ms) of 30 frames;
// `bytes(i)` is a frame's size, or null for a frame skipped by backpressure.
function second(q, k, bytes) {
  for (let i = 0; i < 30; i++) {
    const t = i === 29 ? (k + 1) * 1000 : k * 1000 + i * 33;
    const b = bytes(i);
    if (b === null) q.skipped(t);
    else q.sent(b, t);
  }
}

test('JPEG quality steps down when frames are over budget or the uplink backs up', () => {
  const q = new codec.JpegQuality({ start: 0.7, min: 0.4, max: 0.8, budgetBytes: 25_000, windowMs: 1000 });
  second(q, 0, () => 40_000);
  assert.equal(q.quality, 0.6, 'over budget');
  second(q, 1, (i) => (i % 3 ? 20_000 : null));
  assert.equal(q.quality, 0.5, 'a third of the frames skipped');
  second(q, 2, (i) => (i === 0 ? null : 20_000));
  assert.equal(q.quality, 0.5, 'one skip in 30 is noise');
  for (let k = 3; k < 8; k++) second(q, k, () => 40_000);
  assert.equal(q.quality, 0.4, 'never below min');
});

test('JPEG quality climbs back when frames are small and nothing is skipped', () => {
  const q = new codec.JpegQuality({ start: 0.5, min: 0.4, max: 0.8, budgetBytes: 25_000, windowMs: 1000 });
  second(q, 0, () => 8_000);
  assert.equal(q.quality, 0.55);
  for (let k = 1; k < 10; k++) second(q, k, () => 8_000);
  assert.equal(q.quality, 0.8, 'capped at max');
  // Between 60% and 100% of the budget it holds still.
  const steady = new codec.JpegQuality();
  for (let k = 0; k < 5; k++) second(steady, k, () => 20_000);
  assert.equal(steady.quality, 0.7);
});

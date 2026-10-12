import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { loadJpegDecoder } from '../decode.mjs';
import { FrameFormat, HEADER_BYTES, LatestFrameDecoder, parseFrame } from '../frames.mjs';

const W = 640;
const H = 480;

// A synthetic 640x480 RGB test card: four flat colour quadrants and a horizontal ramp
// along the bottom, so both flat areas and gradients survive the round trip.
function testCard() {
  const rgb = Buffer.alloc(W * H * 3);
  const quads = [
    [200, 40, 40],
    [40, 180, 60],
    [50, 70, 210],
    [230, 220, 90],
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const c = y >= 400 ? [(x * 255) / (W - 1), (x * 255) / (W - 1), 128] : quads[(y < 200 ? 0 : 2) + (x < 320 ? 0 : 1)];
      rgb[i] = c[0];
      rgb[i + 1] = c[1];
      rgb[i + 2] = c[2];
    }
  }
  return rgb;
}

function jpegFrame(jpeg, width, height, tsMs = 1000) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeDoubleLE(tsMs, 0);
  header.writeUInt16LE((FrameFormat.JPEG << 12) | width, 8);
  header.writeUInt16LE(height, 10);
  return Buffer.concat([header, jpeg]);
}

const { decodeJpeg, error } = await loadJpegDecoder();

test('sharp loads', () => {
  assert.equal(error, undefined);
  assert.equal(typeof decodeJpeg, 'function');
});

test('JPEG round trip: encode in Node, parse the frame, decode to RGB close to the source', async () => {
  const rgb = testCard();
  const jpeg = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 70, chromaSubsampling: '4:2:0' })
    .toBuffer();
  assert.ok(jpeg.length < 60_000, `640x480 JPEG at q70 is ${jpeg.length} bytes`);

  const frame = parseFrame(jpegFrame(jpeg, W, H, 1234.5));
  assert.equal(frame.format, FrameFormat.JPEG);
  assert.equal(frame.tsUs, 1_234_500);

  const out = await decodeJpeg(frame.payload, frame.width, frame.height);
  assert.equal(out.length, W * H * 3, 'RGB, no alpha: the SDK takes PixelFormat.kRGB');

  let sumErr = 0;
  let maxQuadErr = 0;
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) sumErr += Math.abs(out[p * 3 + c] - rgb[p * 3 + c]);
  }
  // Centres of the flat quadrants, away from the 8x8 blocks on the edges.
  for (const [x, y] of [
    [160, 100],
    [480, 100],
    [160, 300],
    [480, 300],
  ]) {
    const p = y * W + x;
    for (let c = 0; c < 3; c++) maxQuadErr = Math.max(maxQuadErr, Math.abs(out[p * 3 + c] - rgb[p * 3 + c]));
  }
  const meanErr = sumErr / (W * H * 3);
  assert.ok(meanErr < 3, `mean abs error ${meanErr.toFixed(2)}`);
  assert.ok(maxQuadErr <= 4, `flat colour error ${maxQuadErr}`);
});

test('the decoder refuses a JPEG whose size differs from the header, and non-JPEG data', async () => {
  const small = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer();
  await assert.rejects(decodeJpeg(small, W, H), /320x240/);
  const big = await sharp({ create: { width: 1280, height: 960, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer();
  await assert.rejects(decodeJpeg(big, W, H), /pixel limit/i);
  const png = await sharp({ create: { width: W, height: H, channels: 3, background: '#808080' } })
    .png()
    .toBuffer();
  await assert.rejects(decodeJpeg(png, W, H), /not a JPEG/);
  await assert.rejects(decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), W, H));
});

test('LatestFrameDecoder decodes one at a time and keeps only the newest waiting frame', async () => {
  const started = [];
  const delivered = [];
  let release;
  const decoder = new LatestFrameDecoder(
    (f) => {
      started.push(f.n);
      return new Promise((resolve) => (release = () => resolve(`px${f.n}`)));
    },
    (f, px) => delivered.push([f.n, px]),
  );
  for (let n = 1; n <= 10; n++) decoder.push({ n });
  assert.deepEqual(started, [1], 'only one decode in flight');
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [1, 10], 'frames 2-9 were replaced by 10');
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(delivered, [
    [1, 'px1'],
    [10, 'px10'],
  ]);
  const s = decoder.summary();
  assert.equal(s.decoded, 2);
  assert.equal(s.dropped, 8);
  assert.equal(s.failed, 0);
  assert.equal(decoder.busy, false);
  assert.equal(decoder.pending, null);
});

test('LatestFrameDecoder survives decode errors and stops delivering once closed', async () => {
  const delivered = [];
  const errors = [];
  const decoder = new LatestFrameDecoder(
    async (f) => {
      if (f.bad) throw new Error('corrupt');
      return f.n;
    },
    (f, px) => delivered.push(px),
    (e) => errors.push(e.message),
  );
  decoder.push({ n: 1, bad: true });
  await new Promise((r) => setImmediate(r));
  decoder.push({ n: 2 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, ['corrupt']);
  assert.deepEqual(delivered, [2]);
  decoder.push({ n: 3 });
  decoder.close();
  await new Promise((r) => setImmediate(r));
  decoder.push({ n: 4 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(delivered, [2], 'nothing delivered after close');
  assert.equal(decoder.summary().failed, 1);
});

// Streams synthetic camera frames to a breath sensor the way the game does, without a
// camera, and reports what got through: upload rate, frames Presage accepted, status.
// Use it to check a deployment's uplink path (tunnel included) from a player's network.
//
//   node stream-test.mjs [url] [--seconds 20] [--fps 30] [--quality 70] [--raw] [--image face.jpg]
//
//   url        default ws://127.0.0.1:8794/sensor (`npm start`); dev sensor: ws://localhost:8787
//   --raw      send raw RGBA instead of JPEG (~37 MB/s at 30 fps)
//   --image    a photo to stream instead of the synthetic test card (resized to 640x480)
//
// Presage needs a real face and chest to measure anything; this only exercises the path.

import sharp from 'sharp';
import WebSocket from 'ws';
import { FrameFormat, HEADER_BYTES } from './frames.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const WITH_VALUE = ['--seconds', '--fps', '--quality', '--image'];
const URL_ = args.find((a, i) => !a.startsWith('--') && !WITH_VALUE.includes(args[i - 1])) ?? 'ws://127.0.0.1:8794/sensor';
const SECONDS = Number(opt('seconds', 20));
const FPS = Number(opt('fps', 30));
const QUALITY = Number(opt('quality', 70));
const RAW = args.includes('--raw');
const IMAGE = opt('image');
const W = 640;
const H = 480;
const MAX_BUFFERED = RAW ? 4 * W * H * 4 : 100_000; // same as game/src/breath.ts

// One 4 s "breath" of frames: the lower half of the picture rises and falls by a few
// pixels, plus fresh sensor noise in every frame (noise is what makes webcam JPEGs big).
async function makeFrames() {
  const base = IMAGE
    ? await sharp(IMAGE).resize(W, H, { fit: 'cover' }).removeAlpha().raw().toBuffer()
    : testCard();
  const n = Math.round(FPS * 4);
  const frames = [];
  for (let k = 0; k < n; k++) {
    const shift = Math.round(3 * Math.sin((2 * Math.PI * k) / n));
    const rgb = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      const sy = y < H / 2 ? y : Math.min(H - 1, Math.max(0, y + shift));
      base.copy(rgb, y * W * 3, sy * W * 3, (sy + 1) * W * 3);
    }
    for (let i = 0; i < rgb.length; i++) rgb[i] = Math.max(0, Math.min(255, rgb[i] + ((Math.random() * 7) | 0) - 3));
    const img = sharp(rgb, { raw: { width: W, height: H, channels: 3 } });
    frames.push(RAW ? await img.ensureAlpha().raw().toBuffer() : await img.jpeg({ quality: QUALITY }).toBuffer());
  }
  return frames;
}

// Wall, a face-coloured ellipse, a textured shirt.
function testCard() {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let c = [170 + (x / W) * 30, 160 + (y / H) * 20, 150];
      const fx = (x - 320) / 90;
      const fy = (y - 190) / 120;
      if (fx * fx + fy * fy < 1) {
        const s = 1 - 0.3 * (fx * fx + fy * fy);
        c = [210 * s, 160 * s, 130 * s];
      }
      if (y > 330 && Math.abs(x - 320) < 230 - (H - y) * 0.3) {
        const t = ((x >> 3) + (y >> 3)) & 1;
        c = [40 + t * 25, 60 + t * 25, 110 + t * 25];
      }
      rgb.set(c, i);
    }
  }
  return rgb;
}

function header(tsMs) {
  const h = Buffer.alloc(HEADER_BYTES);
  h.writeDoubleLE(tsMs, 0);
  h.writeUInt16LE(((RAW ? FrameFormat.RAW : FrameFormat.JPEG) << 12) | W, 8);
  h.writeUInt16LE(H, 10);
  return h;
}

const frames = await makeFrames();
const avgKb = frames.reduce((a, f) => a + f.length, 0) / frames.length / 1000;
console.log(`${frames.length} ${RAW ? 'raw' : `JPEG q${QUALITY}`} frames, avg ${avgKb.toFixed(1)} kB -> ${URL_}`);

const ws = new WebSocket(URL_);
let state = null;
let firstFrames = null;
const errors = [];
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.t === 'state') {
    state = msg;
    firstFrames ??= msg.frames;
  } else if (msg.t === 'error') {
    errors.push(msg.message);
    console.log(`server error: ${msg.message}`);
  }
});
ws.on('error', (e) => {
  console.error(`connection failed: ${e.message}`);
  process.exit(1);
});
await new Promise((r) => ws.once('open', r));
ws.send(JSON.stringify({ t: 'sim', on: false }));

let sent = 0;
let skipped = 0;
let bytes = 0;
let k = 0;
let last = { t: performance.now(), sent: 0, bytes: 0, skipped: 0 };
const t0 = performance.now();
const rows = [];
await new Promise((done) => {
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - t0 >= SECONDS * 1000) {
      clearInterval(timer);
      return done();
    }
    if (ws.bufferedAmount >= MAX_BUFFERED) skipped++;
    else {
      const f = frames[k++ % frames.length];
      ws.send(Buffer.concat([header(performance.timeOrigin + now), f]));
      sent++;
      bytes += f.length + HEADER_BYTES;
    }
    if (now - last.t >= 1000) {
      const s = (now - last.t) / 1000;
      const row = {
        fps: (sent - last.sent) / s,
        mbit: ((bytes - last.bytes) * 8) / s / 1e6,
        skipped: skipped - last.skipped,
        frames: state?.frames ?? 0,
      };
      rows.push(row);
      console.log(
        `${String(rows.length).padStart(3)} s  sent ${row.fps.toFixed(1)} fps  ${row.mbit.toFixed(2)} Mbit/s  skipped ${row.skipped}  ` +
          `server frames ${row.frames}  status ${state?.status ?? '-'}  hint "${state?.hint ?? ''}"`,
      );
      last = { t: now, sent, bytes, skipped };
    }
  }, 1000 / FPS);
});
await new Promise((r) => setTimeout(r, 500)); // let the last state arrive
const secs = (performance.now() - t0 - 500) / 1000;
const accepted = (state?.frames ?? 0) - (firstFrames ?? 0);
console.log(
  `\nsent ${sent} frames in ${secs.toFixed(1)} s (${(sent / secs).toFixed(1)} fps, ${((bytes * 8) / secs / 1e6).toFixed(2)} Mbit/s, ` +
    `${(bytes / sent / 1000).toFixed(1)} kB/frame), skipped ${skipped} for backpressure`,
);
console.log(`server accepted ${accepted} frames (Presage status ${state?.status ?? '-'}, hint "${state?.hint ?? ''}")`);
if (errors.length) console.log(`server errors: ${[...new Set(errors)].join(' | ')}`);
ws.close();

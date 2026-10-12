// Turns camera frames into JPEGs off the main thread (breath.ts starts it).
//
// Chrome / Edge: breath.ts hands over a MediaStreamTrackProcessor's readable, so frames arrive
// here at the camera's own rate however busy the game's render loop keeps the main thread.
// This worker paces them (FramePacer), encodes up to MAX_ENCODES_IN_FLIGHT at once and posts
// the JPEGs back in capture order; breath.ts writes the frame header and sends them.
// Safari / Firefox: breath.ts posts one ImageBitmap per frame instead and orders them itself.
//
// Canvas.toBlob on the main thread, which this replaces, runs as an idle task in Chrome: a
// page that never goes idle (a three.js game) got about one JPEG a second out of it.

import { HEADER_BYTES, writeFrameHeader } from './frame-codec';
import { FramePacer, InOrderQueue, SEND_FPS, type FromEncoder, type ToEncoder } from './frame-pump';

const scope = self as unknown as {
  postMessage(msg: FromEncoder, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToEncoder>) => void) | null;
};
const post = (msg: FromEncoder) => scope.postMessage(msg, msg.t === 'frame' && msg.wire ? [msg.wire] : []);

const canEncode = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function';

// One canvas per encode in flight, so an encode never shares pixels with the next draw.
const idle: OffscreenCanvas[] = [];
let gate = { open: false, intervalMs: 1000 / SEND_FPS, quality: 0.7 };
const pacer = new FramePacer();

type StreamFrame = Extract<FromEncoder, { t: 'frame' }>;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let streamGen = -1;
let order = new InOrderQueue<StreamFrame>();
let captured = 0;
let skippedEncoder = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastTs = 0;

/** Wall-clock ms like the main thread's `performance.timeOrigin + performance.now()`, strictly increasing. */
function captureTs() {
  lastTs = Math.max(performance.timeOrigin + performance.now(), lastTs + 0.001);
  return lastTs;
}

/**
 * Draws `source` at width x height, closes it, encodes a JPEG and resolves to the whole frame
 * message (frame-codec.ts header + JPEG), or null when nothing came out.
 */
async function encode(
  source: VideoFrame | ImageBitmap,
  ts: number,
  width: number,
  height: number,
  quality: number,
): Promise<ArrayBuffer | null> {
  const canvas = idle.pop() ?? new OffscreenCanvas(width, height);
  try {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, width, height);
    source.close(); // gives the camera its buffer back before the slow part
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    // convertToBlob quietly falls back to PNG for a type it can't encode.
    if (blob.type !== 'image/jpeg') throw new Error(`this browser encodes ${blob.type}, not JPEG`);
    const wire = new Uint8Array(HEADER_BYTES + blob.size);
    writeFrameHeader(new DataView(wire.buffer, 0, HEADER_BYTES), ts, width, height, 'jpeg');
    wire.set(new Uint8Array(await blob.arrayBuffer()), HEADER_BYTES);
    return wire.buffer;
  } finally {
    source.close();
    idle.push(canvas);
  }
}

function stopStream() {
  const r = reader;
  reader = null;
  streamGen = -1;
  order.reset();
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  r?.cancel().catch(() => {});
}

async function readStream(gen: number, readable: ReadableStream<VideoFrame>, width: number, height: number) {
  stopStream();
  const r = readable.getReader();
  reader = r;
  streamGen = gen;
  const q = (order = new InOrderQueue<StreamFrame>());
  captured = skippedEncoder = 0;
  tickTimer = setInterval(() => {
    post({ t: 'tick', gen, captured, skippedEncoder });
    captured = skippedEncoder = 0;
  }, 1000);
  try {
    for (;;) {
      const { value: frame, done } = await r.read();
      if (done || reader !== r) {
        frame?.close();
        break;
      }
      captured++;
      const ts = captureTs();
      const t0 = performance.now();
      if (!gate.open) {
        frame.close();
        continue;
      }
      // A full encoder drops the frame (and spends no pacing token on it).
      if (q.inFlight >= q.max) {
        skippedEncoder++;
        frame.close();
        continue;
      }
      if (!pacer.admit(t0)) {
        frame.close();
        continue;
      }
      const seq = q.begin()!;
      encode(frame, ts, width, height, gate.quality).then(
        (wire) => {
          const msg: StreamFrame = { t: 'frame', gen, seq, ts, wire, encodeMs: performance.now() - t0 };
          if (gen === streamGen) for (const m of q.complete(seq, wire ? msg : null)) post(m);
        },
        (err) => {
          q.complete(seq, null);
          if (gen === streamGen) {
            post({ t: 'fail', gen, message: String(err?.message ?? err) });
            stopStream();
          }
        },
      );
    }
  } catch (err) {
    if (reader === r) {
      post({ t: 'fail', gen, message: String((err as Error)?.message ?? err) });
      stopStream();
    }
  }
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.t === 'gate') {
    gate = { open: msg.open, intervalMs: msg.intervalMs, quality: msg.quality };
    pacer.setInterval(msg.intervalMs);
  } else if (msg.t === 'stream') {
    void readStream(msg.gen, msg.readable, msg.width, msg.height);
  } else if (msg.t === 'bitmap') {
    const t0 = performance.now();
    const { gen, seq, ts, width, height } = msg;
    encode(msg.bitmap, ts, width, height, msg.quality).then(
      (wire) => post({ t: 'frame', gen, seq, ts, wire, encodeMs: performance.now() - t0 }),
      (err) => {
        post({ t: 'frame', gen, seq, ts, wire: null, encodeMs: 0 });
        post({ t: 'fail', gen, message: String(err?.message ?? err) });
      },
    );
  } else if (msg.t === 'stop') {
    stopStream();
  }
};

post({ t: 'caps', encode: canEncode });

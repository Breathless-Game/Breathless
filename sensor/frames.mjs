// Camera frames from the browser. game/src/frame-codec.ts writes them; both ends are
// tested together in game/tests/frame-protocol.test.mjs. No dependencies, so that test
// runs without the sensor's node_modules.
//
//   offset  type  meaning (little-endian)
//   0       f64   capture timestamp, ms
//   8       u16   bits 0-11: width; bits 12-15: format (0 = raw RGBA, 1 = JPEG)
//   10      u16   height
//   12      ...   raw: RGBA, width x height x 4 bytes; JPEG: one JPEG file of width x height
//
// Format 0 leaves the width field as it always was, so raw frames are byte-for-byte the
// original protocol and old clients keep working.

export const HEADER_BYTES = 12;
export const FrameFormat = Object.freeze({ RAW: 0, JPEG: 1 });
// Compressed frames decode to width x height x 4 bytes; cap that at 1080p (8 MB) so a
// small JPEG can't claim a huge image.
export const MAX_JPEG_PIXELS = 1920 * 1080;

/**
 * Reads one binary frame message. Returns { tsUs, width, height, format, payload }, or
 * null for anything malformed: too short, an unknown format, a raw frame whose size doesn't
 * match, or a "JPEG" that doesn't start like one.
 */
export function parseFrame(data) {
  if (!data || data.byteLength < HEADER_BYTES) return null;
  const view = new DataView(data.buffer, data.byteOffset, HEADER_BYTES);
  const tsMs = view.getFloat64(0, true);
  const field = view.getUint16(8, true);
  const width = field & 0x0fff;
  const format = field >> 12;
  const height = view.getUint16(10, true);
  if (!Number.isFinite(tsMs) || !width || !height) return null;
  const payload = data.subarray(HEADER_BYTES);
  if (format === FrameFormat.RAW) {
    if (payload.byteLength !== width * height * 4) return null;
  } else if (format === FrameFormat.JPEG) {
    if (width * height > MAX_JPEG_PIXELS || !isJpeg(payload)) return null;
  } else {
    return null;
  }
  return { tsUs: Math.round(tsMs * 1000), width, height, format, payload };
}

/** JPEG SOI marker followed by the start of another marker. */
export function isJpeg(bytes) {
  return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Decodes compressed frames one at a time, newest first. A frame that arrives while one
 * is decoding waits in a single slot, and a newer one replaces it (the older is dropped),
 * so a slow decoder costs frames, never memory: at most one frame decoding and one waiting.
 */
export class LatestFrameDecoder {
  /**
   * @param {(frame: object) => Promise<Uint8Array>} decode
   * @param {(frame: object, pixels: Uint8Array) => void} deliver
   * @param {(err: Error, frame: object) => void} [onError]
   */
  constructor(decode, deliver, onError = () => {}) {
    this.decode = decode;
    this.deliver = deliver;
    this.onError = onError;
    this.busy = false;
    this.pending = null;
    this.closed = false;
    this.#resetStats();
  }

  #resetStats() {
    this.stats = { decoded: 0, dropped: 0, failed: 0, totalMs: 0, maxMs: 0, recentMs: [] };
  }

  push(frame) {
    if (this.closed) return;
    if (!this.busy) return void this.#run(frame);
    if (this.pending) this.stats.dropped++;
    this.pending = frame;
  }

  close() {
    this.closed = true;
    if (this.pending) this.stats.dropped++;
    this.pending = null;
  }

  /**
   * Counts and decode times since the last reset; p95 over the latest 256. A decode time
   * runs from starting the decode to having pixels back on the event loop, so waiting for
   * a worker thread or a busy event loop counts too. `reset` starts a new window.
   */
  summary(reset = false) {
    const s = this.stats;
    if (reset) this.#resetStats();
    const recent = [...s.recentMs].sort((a, b) => a - b);
    return {
      decoded: s.decoded,
      dropped: s.dropped,
      failed: s.failed,
      avgMs: s.decoded ? s.totalMs / s.decoded : 0,
      p95Ms: recent.length ? recent[Math.min(recent.length - 1, Math.floor(recent.length * 0.95))] : 0,
      maxMs: s.maxMs,
    };
  }

  async #run(frame) {
    this.busy = true;
    const t0 = performance.now();
    try {
      const pixels = await this.decode(frame);
      const ms = performance.now() - t0;
      const s = this.stats;
      s.decoded++;
      s.totalMs += ms;
      s.maxMs = Math.max(s.maxMs, ms);
      s.recentMs.push(ms);
      if (s.recentMs.length > 256) s.recentMs.shift();
      if (!this.closed) this.deliver(frame, pixels);
    } catch (e) {
      this.stats.failed++;
      if (!this.closed) this.onError(e, frame);
    }
    this.busy = false;
    const next = this.pending;
    this.pending = null;
    if (next && !this.closed) this.#run(next);
  }
}

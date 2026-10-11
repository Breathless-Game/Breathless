// Wire format of the camera frames the browser streams to the sensor. sensor/frames.mjs
// reads it; both ends are tested together in tests/frame-protocol.test.mjs.
//
//   offset  type  meaning (little-endian)
//   0       f64   capture timestamp, ms
//   8       u16   bits 0-11: width; bits 12-15: format (0 = raw RGBA, 1 = JPEG)
//   10      u16   height
//   12      ...   raw: RGBA, width x height x 4 bytes; JPEG: one JPEG file of width x height
//
// Format 0 leaves the width field as it always was, so raw frames are byte-for-byte the
// original protocol. Kept free of DOM APIs so Node can test it.

export const HEADER_BYTES = 12;
export const FRAME_FORMATS = { raw: 0, jpeg: 1 } as const;
export type FrameFormat = keyof typeof FRAME_FORMATS;
const MAX_WIDTH = 0x0fff;

export function writeFrameHeader(
  view: DataView,
  timestampMs: number,
  width: number,
  height: number,
  format: FrameFormat,
): void {
  if (!(width > 0 && width <= MAX_WIDTH && height > 0 && height <= 0xffff)) {
    throw new RangeError(`frame size ${width}x${height} doesn't fit the header`);
  }
  view.setFloat64(0, timestampMs, true);
  view.setUint16(8, width | (FRAME_FORMATS[format] << 12), true);
  view.setUint16(10, height, true);
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Raw frames are ~295 Mbit/s at 640x480 x 30 fps, so they are only the default where they
 * never cross a network: a dev build talking to a sensor on this machine. Everything else
 * (production, https, a LAN or remote sensor) sends JPEG. `override` ('raw' | 'jpeg', from
 * `?frames=` or VITE_FRAME_FORMAT) wins.
 */
export function pickFrameFormat(o: { override?: string | null; dev: boolean; sensorUrl: string }): FrameFormat {
  const override = o.override?.trim().toLowerCase();
  if (override === 'raw' || override === 'jpeg') return override;
  if (!o.dev) return 'jpeg';
  try {
    const url = new URL(o.sensorUrl);
    return url.protocol === 'ws:' && LOOPBACK.test(url.hostname) ? 'raw' : 'jpeg';
  } catch {
    return 'jpeg';
  }
}

export interface JpegQualityOptions {
  start: number;
  min: number;
  max: number;
  /** Target bytes per frame: 25 kB x 30 fps = 6 Mbit/s. */
  budgetBytes: number;
  windowMs: number;
}

const QUALITY_DEFAULTS: JpegQualityOptions = { start: 0.7, min: 0.4, max: 0.8, budgetBytes: 25_000, windowMs: 1000 };

/**
 * JPEG quality for the camera stream: as high as the frame budget and the uplink allow.
 * Presage wants ~30 fps, so a slow uplink costs quality rather than frames. Once per window:
 * frames over budget, or more than 10% of frames skipped because the socket was backed up,
 * step the quality down; frames well under budget with nothing skipped step it back up.
 */
export class JpegQuality {
  readonly o: JpegQualityOptions;
  quality: number;
  private windowStart = -1;
  private sentFrames = 0;
  private sentBytes = 0;
  private skippedFrames = 0;

  constructor(opts: Partial<JpegQualityOptions> = {}) {
    this.o = { ...QUALITY_DEFAULTS, ...opts };
    this.quality = this.o.start;
  }

  /** A frame of `bytes` went out. */
  sent(bytes: number, nowMs: number) {
    this.sentFrames++;
    this.sentBytes += bytes;
    this.update(nowMs);
  }

  /** A frame was skipped because the socket still held too much unsent data. */
  skipped(nowMs: number) {
    this.skippedFrames++;
    this.update(nowMs);
  }

  private update(nowMs: number) {
    if (this.windowStart < 0) this.windowStart = nowMs;
    if (nowMs - this.windowStart < this.o.windowMs) return;
    const total = this.sentFrames + this.skippedFrames;
    const avg = this.sentFrames ? this.sentBytes / this.sentFrames : 0;
    let q = this.quality;
    if (this.skippedFrames > total * 0.1 || avg > this.o.budgetBytes) q -= 0.1;
    else if (avg < this.o.budgetBytes * 0.6) q += 0.05;
    this.quality = Math.round(Math.min(this.o.max, Math.max(this.o.min, q)) * 100) / 100;
    this.windowStart = nowMs;
    this.sentFrames = this.sentBytes = this.skippedFrames = 0;
  }
}

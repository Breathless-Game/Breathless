// How camera frames are paced, encoded in parallel and sent in order, and the performance
// numbers the game reports to the sensor (breath.ts, camera-encoder.worker.ts). No DOM here,
// so it is tested in Node (tests/frame-pump.test.mjs).

/** Presage wants ~30 fps; the browser never sends faster than this. */
export const SEND_FPS = 30;
/** JPEG encodes allowed in flight at once; their frames still go out in capture order. */
export const MAX_ENCODES_IN_FLIGHT = 2;
/** How often the game sends `{ t: 'stats' }` to the sensor. */
export const STATS_INTERVAL_MS = 10_000;

/**
 * Lets frames through at most once per `intervalMs` on average. A token bucket rather than
 * a minimum gap: a camera running at exactly the send rate jitters around the interval, and
 * a strict gap would drop every frame that arrives a millisecond early. `burst` tokens
 * absorb that jitter (and allow a short catch-up after a pause).
 */
export class FramePacer {
  private tokens: number;
  private last = -Infinity;

  constructor(
    private intervalMs = 1000 / SEND_FPS,
    private readonly burst = 2,
  ) {
    this.tokens = burst;
  }

  get interval() {
    return this.intervalMs;
  }

  /** Change the rate, e.g. one frame a second while waiting for a busy sensor slot. */
  setInterval(ms: number) {
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    this.tokens = Math.min(this.tokens, 1);
  }

  /** Whether a frame captured at `now` (ms) may be sent. */
  admit(now: number): boolean {
    if (this.last > -Infinity) this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.last) / this.intervalMs);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Up to `max` encodes in flight; results come out in the order the encodes began, whatever
 * order they finish in. A failed encode (null) still lets the frames behind it out.
 */
export class InOrderQueue<T> {
  private nextSeq = 0;
  private head = 0;
  private done = new Map<number, T | null>();

  constructor(readonly max = MAX_ENCODES_IN_FLIGHT) {}

  /** Encodes begun and not yet released. */
  get inFlight() {
    return this.nextSeq - this.head;
  }

  /** A sequence number for a new encode, or null when `max` are already in flight. */
  begin(): number | null {
    if (this.inFlight >= this.max) return null;
    return this.nextSeq++;
  }

  /** Records an encode's result (null: it failed) and returns what is now ready, in order. */
  complete(seq: number, value: T | null): T[] {
    if (seq < this.head || seq >= this.nextSeq || this.done.has(seq)) return [];
    this.done.set(seq, value);
    const out: T[] = [];
    while (this.done.has(this.head)) {
      const v = this.done.get(this.head)!;
      this.done.delete(this.head);
      this.head++;
      if (v !== null) out.push(v);
    }
    return out;
  }

  /** Forgets everything in flight; their late results are ignored. */
  reset() {
    this.done.clear();
    this.head = this.nextSeq;
  }
}

/** How the camera frames are captured and encoded (see breath.ts). */
export type CapturePipe = 'mstp' | 'bitmap' | 'canvas' | 'raw';
export const CAPTURE_PIPES: readonly CapturePipe[] = ['mstp', 'bitmap', 'canvas', 'raw'];

/**
 * The best pipeline this browser offers. JPEG: a MediaStreamTrackProcessor (Chrome, Edge)
 * whose frames go straight to a worker, else video frames copied to a worker as ImageBitmaps
 * (Safari, Firefox), else the old main-thread canvas. Raw RGBA (local dev) stays on the main thread.
 */
export function pickCapturePipe(o: {
  format: 'raw' | 'jpeg';
  worker: boolean;
  workerCanEncode: boolean;
  trackProcessor: boolean;
  imageBitmap: boolean;
}): CapturePipe {
  if (o.format === 'raw') return 'raw';
  if (!o.worker || !o.workerCanEncode) return 'canvas';
  if (o.trackProcessor) return 'mstp';
  if (o.imageBitmap) return 'bitmap';
  return 'canvas';
}

/**
 * Performance numbers only, sent every STATS_INTERVAL_MS while live (`{ t: 'stats' }`).
 * Never breath or health data. Rates are per second over the window, counts are totals.
 */
export interface ClientStatsMessage {
  t: 'stats';
  pipe: CapturePipe;
  /** The frame rate the camera says it runs at (track.getSettings().frameRate). */
  camFps: number;
  /** Frames the capture pipeline received. */
  capFps: number;
  /** requestVideoFrameCallback calls: frames the page presented, which a busy page caps. */
  rvfcFps: number;
  /** requestAnimationFrame calls: the game's render rate. */
  renderFps: number;
  /** Frames sent to the sensor. */
  sentFps: number;
  /** Frames dropped because MAX_ENCODES_IN_FLIGHT encodes were already running. */
  skippedEncoder: number;
  /** Frames dropped because the socket still held too much unsent data. */
  skippedBackpressure: number;
  /** Average ms from capture to a finished JPEG. */
  encodeMsAvg: number;
  /** JPEG quality in use (JpegQuality). */
  quality: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Counts for one stats window; `snapshot` turns them into a message and starts a new window. */
export class FrameStats {
  captured = 0;
  rvfc = 0;
  render = 0;
  sent = 0;
  skippedEncoder = 0;
  skippedBackpressure = 0;
  private encodeMsTotal = 0;
  private encoded = 0;

  constructor(private since: number) {}

  encodedIn(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.encodeMsTotal += ms;
    this.encoded++;
  }

  due(now: number, intervalMs = STATS_INTERVAL_MS) {
    return now - this.since >= intervalMs;
  }

  snapshot(now: number, o: { pipe: CapturePipe; camFps: number; quality: number }): ClientStatsMessage {
    const secs = Math.max(0.001, (now - this.since) / 1000);
    const msg: ClientStatsMessage = {
      t: 'stats',
      pipe: o.pipe,
      camFps: round1(Number.isFinite(o.camFps) ? o.camFps : 0),
      capFps: round1(this.captured / secs),
      rvfcFps: round1(this.rvfc / secs),
      renderFps: round1(this.render / secs),
      sentFps: round1(this.sent / secs),
      skippedEncoder: this.skippedEncoder,
      skippedBackpressure: this.skippedBackpressure,
      encodeMsAvg: round1(this.encoded ? this.encodeMsTotal / this.encoded : 0),
      quality: o.quality,
    };
    this.since = now;
    this.captured = this.rvfc = this.render = this.sent = this.skippedEncoder = this.skippedBackpressure = 0;
    this.encodeMsTotal = this.encoded = 0;
    return msg;
  }
}

// ---- Worker messages (camera-encoder.worker.ts) ------------------------------

export type ToEncoder =
  /** Start reading a MediaStreamTrackProcessor's frames (the readable is transferred). */
  | { t: 'stream'; gen: number; readable: ReadableStream<VideoFrame>; width: number; height: number }
  /** Encode one frame (the bitmap is transferred); answered with exactly one `frame` message. */
  | { t: 'bitmap'; gen: number; seq: number; ts: number; bitmap: ImageBitmap; width: number; height: number; quality: number }
  /** Which stream frames to encode: `open` false drops them all; `intervalMs` paces the rest. */
  | { t: 'gate'; open: boolean; intervalMs: number; quality: number }
  | { t: 'stop' };

export type FromEncoder =
  | { t: 'caps'; encode: boolean }
  /**
   * A finished frame message, ready for ws.send: the frame-codec header and the JPEG (an
   * ArrayBuffer: the socket sends it at once, where a Blob is read on the main thread first).
   * null when encoding failed. Stream frames arrive in capture order.
   */
  | { t: 'frame'; gen: number; seq: number; ts: number; wire: ArrayBuffer | null; encodeMs: number }
  /** Once a second while a stream runs: frames read and frames dropped for a full encoder since the last tick. */
  | { t: 'tick'; gen: number; captured: number; skippedEncoder: number }
  /** The encoder can't make JPEGs (or the stream failed): use another pipeline. */
  | { t: 'fail'; gen: number; message: string };

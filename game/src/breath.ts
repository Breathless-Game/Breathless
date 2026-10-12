// Breath input. In live mode the browser owns the webcam, shows it to the
// player, and streams its frames (JPEG, or raw RGBA in local dev; see
// frame-codec.ts) to the sensor bridge, which runs Presage SmartSpectra and
// answers with HOLD / BREATHE.
// Keyboard mode (hold Shift) exists so the game is playable without a camera.

import { HEADER_BYTES, JpegQuality, pickFrameFormat, writeFrameHeader, type FrameFormat } from './frame-codec';
import {
  FramePacer,
  FrameStats,
  InOrderQueue,
  pickCapturePipe,
  SEND_FPS,
  type CapturePipe,
  type FromEncoder,
  type ToEncoder,
} from './frame-pump';
import { isAction, keyLabel } from './controls';
import { t } from './i18n';
import {
  BUSY_FRAME_MS,
  busyFrameDue,
  canReacquire,
  detectorReady,
  frameStalled,
  holdOver,
  MUTE_GRACE_MS,
  onBusy,
  recovering,
  seedMessage,
  sensorSilent,
  usableBaseline,
} from './camera-recovery';

export type BreathMode = 'presage' | 'sim' | 'keyboard';

export interface BreathState {
  mode: BreathMode;
  connected: boolean;
  holding: boolean;
  holdMs: number;
  calibrated: boolean;
  status: string;
  hint: string;
  trace: number[];
  flatness: number;
  rate: number | null;
  pulse: number | null;
  /** Presage mode: player is holding Shift to mark a real breath hold (ground truth for tuning). */
  label: boolean;
  /** Last error from the sensor, e.g. why live mode fell back to keyboard; '' when none. */
  error: string;
  /** Presage mode: the signal is recovering (camera re-opening, sensor reconnecting, detector warming up). */
  recovering: boolean;
}

const FRAME_W = 640;
const FRAME_H = 480;
// Dev: the sensor runs on its own port next to Vite. Production (`npm start`) serves the
// game and the sensor from one origin, so it works behind an HTTPS tunnel (wss://).
const SENSOR_URL =
  (import.meta.env.VITE_SENSOR_URL as string | undefined) ||
  (import.meta.env.PROD
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sensor`
    : `ws://${location.hostname || 'localhost'}:8787`);
// JPEG everywhere except a dev build next to a local sensor; `?frames=raw|jpeg` overrides.
const FRAME_FORMAT = pickFrameFormat({
  override:
    new URLSearchParams(location.search).get('frames') ?? (import.meta.env.VITE_FRAME_FORMAT as string | undefined),
  dev: import.meta.env.DEV,
  sensorUrl: SENSOR_URL,
});
// Skip frames while the socket still holds this much unsent data. Raw: 4 frames, as before.
// JPEG: ~4 frames at the 25 kB budget, about 160 ms on a 5 Mbit/s uplink, so a slow uplink
// skips frames (and JpegQuality lowers the quality) instead of building up lag.
const MAX_BUFFERED: Record<FrameFormat, number> = { raw: 4 * FRAME_W * FRAME_H * 4, jpeg: 100_000 };

// Chrome and Edge only, so not in TypeScript's DOM types.
declare const MediaStreamTrackProcessor:
  | (new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> })
  | undefined;

/** A finished JPEG waiting for its turn on the socket. */
interface EncodedFrame {
  ts: number;
  /** From the main-thread canvas: the JPEG alone (the header is added when sent). */
  jpeg?: Blob;
  /** From the worker: header and JPEG, ready to send. */
  wire?: ArrayBuffer;
  /** Capture to finished JPEG. */
  encodeMs: number;
}

export class BreathSource {
  state: BreathState = {
    mode: 'keyboard',
    connected: false,
    holding: false,
    holdMs: 0,
    calibrated: false,
    status: 'idle',
    hint: '',
    trace: [],
    flatness: 0,
    rate: null,
    pulse: null,
    label: false,
    error: '',
    recovering: false,
  };
  video: HTMLVideoElement;
  private ws: WebSocket | null = null;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private stream: MediaStream | null = null;
  private keyHeld = false;
  private keyHoldStart = 0;
  private listeners: ((s: BreathState) => void)[] = [];
  // Bumped on start/stop so a stale requestVideoFrameCallback loop exits instead of doubling up.
  private pumpGen = 0;
  /** How frames go to the sensor; drops to raw if the sensor can't decode JPEG. */
  frameFormat: FrameFormat = FRAME_FORMAT;
  readonly jpegQuality = new JpegQuality();
  // JPEG encoding (frame-pump.ts): a worker when the browser allows one (camera-encoder.worker.ts),
  // up to MAX_ENCODES_IN_FLIGHT at once, sent in capture order, paced to SEND_FPS.
  private encoder: Worker | null = null;
  /** Whether the worker can make JPEGs; null until it says. */
  private encoderReady: boolean | null = null;
  /** How frames are captured and encoded right now. */
  pipe: CapturePipe = 'canvas';
  /** The camera track's clone feeding the worker ('mstp'); stopped with the pipeline. */
  private processorTrack: MediaStreamTrack | null = null;
  private readonly order = new InOrderQueue<EncodedFrame>();
  private readonly pacer = new FramePacer();
  private gateKey = '';
  private lastSentTs = 0;
  /** Performance numbers for `{ t: 'stats' }`; never breath or health data. */
  private stats = new FrameStats(performance.now());
  private countingRenders = false;
  /** The player chose the camera (startLive) and hasn't left: a lost camera can be reconnected from the K key. */
  liveWanted = false;
  // Bumped by stopLive, so a camera re-acquire still awaiting getUserMedia doesn't turn it back on.
  private liveEpoch = 0;
  // Camera recovery (camera-recovery.ts): whether this game has held a live Presage slot since
  // startLive, when the sensor started saying "busy" (0: it isn't), the last throttled busy frame.
  private hadSlot = false;
  private busySince = 0;
  private lastBusyFrame = -Infinity;
  private lastReacquire = -Infinity;
  private reacquiring = false;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private lastMessageAt = 0;
  // The breathing baseline the sensor last reported, for the page's lifetime only (a refresh
  // relearns it); stopLive keeps it. `seeded`: the current socket's detector was given it.
  private baseline: number | null = null;
  private seeded = false;
  // Hold-over while the signal recovers: only once hold detection has worked since startLive,
  // i.e. mid-dive, not while the calibration screen (with its own words) warms a detector up.
  private wasLive = false;
  private recoverySince = 0;
  private holdStartedAt = 0;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas.width = FRAME_W;
    this.canvas.height = FRAME_H;
    window.addEventListener('keydown', (e) => {
      if (isAction('hold', e) && !this.keyHeld) {
        this.keyHeld = true;
        this.keyHoldStart = performance.now();
        if (this.state.mode === 'sim') this.send({ t: 'simHold', holding: true });
        if (this.state.mode === 'presage') this.sendLabel(true);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (isAction('hold', e)) {
        this.keyHeld = false;
        if (this.state.mode === 'sim') this.send({ t: 'simHold', holding: false });
        if (this.state.mode === 'presage') this.sendLabel(false);
      }
    });
    setInterval(() => this.tickKeyboard(), 50);
    // A paused <video> presents no frames, so requestVideoFrameCallback never fires and the
    // pump stops with it: play it again (the tab coming back, the OS or browser pausing it).
    video.addEventListener('pause', () => this.resumeVideo());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.resumeVideo();
    });
    setInterval(() => this.watchdog(), 1000);
  }

  onChange(fn: (s: BreathState) => void) {
    this.listeners.push(fn);
  }

  private emit() {
    this.syncGate();
    for (const fn of this.listeners) fn(this.state);
  }

  async startLive(): Promise<void> {
    this.state.error = '';
    // Started before the camera, so it has said what it can do by the time frames flow.
    this.startEncoder();
    await this.openCamera();
    this.liveWanted = true;
    this.hadSlot = false;
    this.busySince = 0;
    this.state.holding = false;
    this.state.holdMs = 0;
    this.wasLive = false;
    this.state.mode = 'presage';
    this.connect();
    // An already open socket (from sim mode) never sends its on-open hello again.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ t: 'sim', on: false });
      this.sendSeed();
    }
    this.stats = new FrameStats(performance.now());
    this.pumpFrames();
    this.countRenders();
  }

  /**
   * A detector built after a stopLive or a reconnect starts without a baseline; give it the
   * one this page already learned so the player skips relearning (the sensor ignores a seed
   * once its detector has one). Presage only: the simulator's trace has another scale.
   */
  private sendSeed() {
    const seed = this.state.mode === 'presage' ? seedMessage(this.baseline) : null;
    this.seeded = Boolean(seed);
    if (seed) this.send(seed);
  }

  /** True when this socket's detector was given a remembered baseline: calibration is a warm-up, not relearning. */
  get seededBaseline() {
    return this.seeded;
  }

  // The signal is unreliable while the camera re-opens, the sensor reconnects or a fresh
  // detector warms up: the last HOLD/BREATHE stands for a while (camera-recovery.ts).
  private updateRecovery() {
    const track = this.stream?.getVideoTracks()[0];
    const now = performance.now();
    const isRecovering =
      this.state.mode === 'presage' &&
      recovering({
        connected: this.state.connected,
        ready: this.state.calibrated,
        cameraDown: this.reacquiring || !track || track.readyState !== 'live' || track.muted,
        waitingSlot: this.busySince > 0,
      });
    if (!isRecovering) this.recoverySince = 0;
    else if (!this.recoverySince) this.recoverySince = now;
    this.state.recovering = isRecovering;
    if (this.holdingOver() && this.state.holding) this.state.holdMs = now - this.holdStartedAt;
    if (isRecovering && this.wasLive && !this.holdingOver() && !this.state.connected) {
      // The cap ran out with no sensor at all: no signal is no hold.
      this.state.holding = false;
      this.state.holdMs = 0;
    }
    // Mid-dive only, and a warming detector's own Presage hint ("Center your face") wins.
    if (isRecovering && this.wasLive) {
      const cameraDown = this.reacquiring || !track || track.readyState !== 'live' || track.muted;
      if (cameraDown) this.state.hint = t('Camera reconnecting…', '摄像头重连中…');
      else if (!this.state.connected || this.busySince) this.state.hint = t('Reconnecting to the breath sensor…', '正在重新连接呼吸传感器…');
      else this.state.hint ||= t('Camera reconnecting…', '摄像头重连中…');
    }
  }

  /** The last holding value stands (recovering, for at most RECOVERY_HOLD_MAX_MS). */
  private holdingOver() {
    return this.wasLive && holdOver(this.recoverySince, performance.now());
  }

  /** Releases the camera and the sensor's Presage session; back to keyboard mode. */
  stopLive() {
    this.liveEpoch++;
    this.liveWanted = false;
    this.releaseCamera();
    this.setMode('keyboard');
    this.ws?.close();
  }

  private async openCamera() {
    const epoch = this.liveEpoch;
    // The old track goes first: some cameras open for one stream at a time.
    this.releaseCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: FRAME_W }, height: { ideal: FRAME_H }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: false,
    });
    if (epoch !== this.liveEpoch) {
      stream.getTracks().forEach((tr) => tr.stop());
      throw new Error('camera closed while it was opening');
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.watchTrack(stream);
    await this.video.play();
    this.lastFrameAt = performance.now();
    const s = stream.getVideoTracks()[0]?.getSettings();
    // Presage needs ~30 fps; a dim room can make a camera drop to 12-15.
    console.info(`[breath] camera ${s?.width}x${s?.height} at ${s?.frameRate} fps`);
  }

  private releaseCamera() {
    this.pumpGen++;
    this.stopCapture();
    this.clearMuteTimer();
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  // The track ends when the camera is unplugged, the browser revokes access or the OS takes
  // it; it mutes when the OS pauses it (sleep, another app). A muted track shows black.
  private watchTrack(stream: MediaStream) {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const current = () => this.stream === stream;
    track.addEventListener('ended', () => {
      if (current()) void this.cameraLost();
    });
    track.addEventListener('mute', () => {
      if (current()) this.startMuteTimer(stream);
    });
    track.addEventListener('unmute', () => {
      if (!current()) return;
      this.clearMuteTimer();
      this.resumeVideo();
    });
    if (track.muted) this.startMuteTimer(stream);
  }

  private startMuteTimer(stream: MediaStream) {
    this.clearMuteTimer();
    this.muteTimer = setTimeout(() => {
      this.muteTimer = null;
      if (this.stream === stream && stream.getVideoTracks()[0]?.muted) void this.cameraLost();
    }, MUTE_GRACE_MS);
  }

  private clearMuteTimer() {
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.muteTimer = null;
  }

  /** The camera stopped: open it again once; if that fails (or it dies again soon), play on the keyboard. */
  private async cameraLost() {
    if (this.reacquiring || !this.stream) return;
    const now = performance.now();
    if (!canReacquire(this.lastReacquire, now)) return this.giveUpCamera(cameraLostMessage());
    this.lastReacquire = now;
    this.reacquiring = true;
    this.updateRecovery();
    this.emit();
    console.warn('[breath] camera stopped, opening it again');
    try {
      await this.openCamera();
      this.pumpFrames();
    } catch (err) {
      console.warn('[breath] could not reopen the camera', err);
      // Not once the player has left live mode on purpose.
      if (this.liveWanted) this.giveUpCamera(cameraLostMessage());
    } finally {
      this.reacquiring = false;
      this.updateRecovery();
    }
  }

  /** Lets the camera go (lost, or the sensor stays busy) and plays on the keyboard; K brings it back. */
  private giveUpCamera(message: string) {
    this.releaseCamera();
    this.busySince = 0;
    this.setMode('keyboard');
    this.ws?.close();
    // After setMode, which clears the error.
    this.state.error = message;
    this.emit();
  }

  private resumeVideo() {
    if (!this.stream || !this.video.paused || document.hidden) return;
    this.video.play().catch(() => {});
  }

  // Once a second: replace a sensor socket that went silent (half-open after a network blip
  // or sleep), and restart a video or pump that stopped presenting frames.
  private watchdog() {
    if (this.state.mode !== 'presage') return;
    // No messages come while the socket is down: recovery (and its time cap) moves on here.
    this.updateRecovery();
    if (this.state.recovering) this.emit();
    if (!this.stream) return;
    const now = performance.now();
    this.syncGate();
    this.sendStats(now);
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN && sensorSilent(this.lastMessageAt, now)) {
      console.warn('[breath] the breath sensor went silent, reconnecting');
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
      this.ws = null;
      this.state.connected = false;
      this.emit();
      this.connect();
    }
    if (document.hidden || this.reacquiring) return;
    const track = this.stream.getVideoTracks()[0];
    if (track?.readyState === 'live' && !track.muted && frameStalled(this.lastFrameAt, now)) {
      console.warn('[breath] no camera frames, restarting the video');
      this.lastFrameAt = now;
      this.resumeVideo();
      this.pumpFrames();
    }
  }

  setMode(mode: BreathMode) {
    this.state.mode = mode;
    this.state.error = '';
    this.state.holding = false;
    this.state.calibrated = mode === 'keyboard';
    if (mode !== 'keyboard') this.connect();
    this.send({ t: 'sim', on: mode === 'sim' });
    this.emit();
  }

  private connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(SENSOR_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.state.connected = true;
      this.lastMessageAt = performance.now();
      ws.send(JSON.stringify({ t: 'sim', on: this.state.mode === 'sim' }));
      this.sendSeed();
      this.updateRecovery();
      this.emit();
    };
    ws.onclose = () => {
      this.state.connected = false;
      this.ws = null;
      this.updateRecovery();
      this.emit();
      if (this.state.mode !== 'keyboard') setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = performance.now();
      if (typeof ev.data !== 'string') return;
      const msg = JSON.parse(ev.data);
      if (msg.t === 'error') return this.onSensorError(msg);
      if (msg.t !== 'state' || this.state.mode === 'keyboard') return;
      if (this.state.mode === 'presage' && msg.source === 'presage') {
        if (msg.status === 'busy') {
          if (this.busySince && onBusy(this.hadSlot, this.busySince, performance.now()) === 'fallback') {
            return this.giveUpCamera(busyMessage());
          }
        } else if (msg.status !== 'idle') {
          // Presage is starting or running on our frames: the slot is ours.
          this.hadSlot = true;
          this.busySince = 0;
        }
      }
      // Remembered for the page's lifetime (never stored): the next detector is seeded with it.
      // Never from sim mode (the sensor reports null there anyway).
      if (this.state.mode === 'presage' && msg.source === 'presage' && usableBaseline(msg.baseline)) {
        this.baseline = msg.baseline;
      }
      this.state.calibrated = detectorReady(msg);
      if (this.state.mode === 'presage' && this.state.calibrated) this.wasLive = true;
      this.state.status = msg.status;
      this.state.hint = msg.hint;
      this.updateRecovery();
      if (!this.holdingOver()) {
        this.state.holding = msg.holding;
        this.state.holdMs = msg.holdMs;
        if (msg.holding) this.holdStartedAt = performance.now() - msg.holdMs;
      }
      this.state.trace = msg.trace;
      this.state.flatness = msg.flatness;
      this.state.rate = msg.rate?.value ?? null;
      this.state.pulse = msg.pulse?.value ?? null;
      this.emit();
    };
    this.ws = ws;
  }

  // Presage errors also arrive in the state's hint. "busy" means the server's live
  // Presage slots are all taken. On the first connect: stop streaming frames nobody
  // will process and fall back to the keyboard, which always works. On a reconnect the
  // slot is most likely still held by this game's own dead socket, which the sensor
  // frees once it notices that socket is gone: keep the camera and wait (onBusy).
  private onSensorError(msg: { code?: string; message?: string }) {
    const message = msg.message || 'Breath sensor error';
    console.warn(`[breath] ${message}`);
    // A sensor that can't decode JPEG (sharp not installed): raw frames still work on a LAN.
    if (msg.code === 'frames') {
      this.frameFormat = 'raw';
      if (this.stream) this.pumpFrames();
      return;
    }
    if (msg.code === 'busy' && this.state.mode === 'presage') {
      const now = performance.now();
      if (!this.busySince) this.busySince = now;
      if (onBusy(this.hadSlot, this.busySince, now) === 'wait') return;
      return this.giveUpCamera(busyMessage());
    }
    this.state.error = message;
    this.emit();
  }

  /** Marks a real breath hold (ground truth) in the sensor's recording. */
  sendLabel(holding: boolean) {
    if (this.state.label === holding) return;
    this.state.label = holding;
    this.send({ t: 'label', holding, ts: performance.timeOrigin + performance.now() });
    this.emit();
  }

  /** Marks guided-calibration phases in the sensor's recording. */
  sendCalib(phase: string) {
    this.send({ t: 'calib', phase, ts: performance.timeOrigin + performance.now() });
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /**
   * (Re)starts frame capture for the current camera: the capture pipeline, plus this
   * requestVideoFrameCallback loop. The loop fires once per frame the page presents, which a
   * busy render loop caps at the game's frame rate; it captures raw frames, and JPEG frames
   * on browsers without MediaStreamTrackProcessor ('bitmap', 'canvas'). With one ('mstp')
   * the worker captures at the camera's rate and this loop only counts.
   */
  private pumpFrames() {
    const gen = ++this.pumpGen;
    this.startCapture(gen);
    const push = () => {
      if (gen !== this.pumpGen) return;
      // The worker's ticks keep this up to date while it captures.
      if (this.pipe !== 'mstp') this.lastFrameAt = performance.now();
      // Re-armed first: a throw while sending must not end the loop for good.
      if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(push);
      else setTimeout(push, 33);
      try {
        this.sendFrame(gen);
      } catch (err) {
        console.warn('[breath] frame not sent', err);
      }
    };
    push();
  }

  private sendFrame(gen: number) {
    this.stats.rvfc++;
    const format = this.frameFormat;
    if (this.pipe === 'mstp' && format === 'jpeg') return;
    const ws = this.ws;
    if (this.state.mode !== 'presage' || ws?.readyState !== WebSocket.OPEN || this.video.readyState < 2) return;
    // A muted or ended track shows black (or a frozen frame): a flat trace the detector would
    // read as a HOLD. Send nothing until the camera is back.
    if (!this.cameraLive()) return;
    this.stats.captured++;
    // Waiting for the slot back: a frame a second is enough to keep claiming it.
    if (this.busySince) {
      const now = performance.now();
      if (!busyFrameDue(this.lastBusyFrame, now)) return;
      this.lastBusyFrame = now;
    }
    if (ws.bufferedAmount >= MAX_BUFFERED[format]) {
      if (format === 'jpeg') this.jpegQuality.skipped(performance.now());
      this.stats.skippedBackpressure++;
      return;
    }
    const ts = performance.timeOrigin + performance.now();
    if (format === 'raw') {
      this.ctx.drawImage(this.video, 0, 0, FRAME_W, FRAME_H);
      const img = this.ctx.getImageData(0, 0, FRAME_W, FRAME_H);
      const buf = new ArrayBuffer(HEADER_BYTES + img.data.byteLength);
      writeFrameHeader(new DataView(buf), ts, FRAME_W, FRAME_H, 'raw');
      new Uint8Array(buf, HEADER_BYTES).set(img.data);
      ws.send(buf);
      this.lastSentTs = ts;
      this.stats.sent++;
      return;
    }
    // Up to MAX_ENCODES_IN_FLIGHT JPEGs at once; a slow machine drops frames instead of piling them up.
    if (this.order.inFlight >= this.order.max) {
      this.stats.skippedEncoder++;
      return;
    }
    if (!this.pacer.admit(performance.now())) return;
    const seq = this.order.begin()!;
    if (this.pipe === 'bitmap' && this.encoder) {
      const encoder = this.encoder;
      createImageBitmap(this.video).then(
        (bitmap) => {
          if (gen !== this.pumpGen || encoder !== this.encoder) {
            bitmap.close();
            return this.encoded(gen, seq, null);
          }
          const msg: ToEncoder = { t: 'bitmap', gen, seq, ts, bitmap, width: FRAME_W, height: FRAME_H, quality: this.jpegQuality.quality };
          try {
            encoder.postMessage(msg, [bitmap]);
          } catch {
            // Never posted, so no answer comes: free its slot, or two of these stop the pump.
            bitmap.close();
            this.encoded(gen, seq, null);
          }
        },
        () => this.encoded(gen, seq, null),
      );
      return;
    }
    // The last resort, on the main thread. Chrome runs toBlob as an idle task, so a busy page gets few.
    this.ctx.drawImage(this.video, 0, 0, FRAME_W, FRAME_H);
    this.canvas.toBlob(
      (blob) => {
        // toBlob quietly falls back to PNG for a type it can't encode.
        if (blob && blob.type !== 'image/jpeg') {
          this.frameFormat = 'raw';
          this.pipe = 'raw';
          return this.encoded(gen, seq, null);
        }
        this.encoded(gen, seq, blob && { ts, jpeg: blob, encodeMs: performance.timeOrigin + performance.now() - ts });
      },
      'image/jpeg',
      this.jpegQuality.quality,
    );
  }

  /** The camera track is live and showing a picture, and no re-acquire is under way. */
  private cameraLive() {
    const track = this.stream?.getVideoTracks()[0];
    return Boolean(track && !(track.readyState !== 'live' || track.muted) && !this.reacquiring);
  }

  /** A main-thread-captured encode finished (null: it failed); frames go out in capture order. */
  private encoded(gen: number, seq: number, frame: EncodedFrame | null) {
    if (gen !== this.pumpGen) return;
    for (const f of this.order.complete(seq, frame)) this.sendJpeg(f, false);
  }

  /**
   * Sends one finished JPEG. `gated`: it was captured by the worker, so the checks sendFrame
   * makes before capturing (busy wait, backpressure) are made here instead.
   */
  private sendJpeg(f: EncodedFrame, gated: boolean) {
    this.stats.encodedIn(f.encodeMs);
    const ws = this.ws;
    if (this.state.mode !== 'presage' || ws?.readyState !== WebSocket.OPEN || this.frameFormat !== 'jpeg') return;
    if (!this.cameraLive() || f.ts <= this.lastSentTs) return;
    const now = performance.now();
    if (gated) {
      if (this.busySince) {
        if (!busyFrameDue(this.lastBusyFrame, now)) return;
        this.lastBusyFrame = now;
      }
      if (ws.bufferedAmount >= MAX_BUFFERED.jpeg) {
        this.jpegQuality.skipped(now);
        this.stats.skippedBackpressure++;
        return;
      }
    }
    let bytes: number;
    if (f.wire) {
      ws.send(f.wire);
      bytes = f.wire.byteLength - HEADER_BYTES;
    } else if (f.jpeg) {
      const header = new ArrayBuffer(HEADER_BYTES);
      writeFrameHeader(new DataView(header), f.ts, FRAME_W, FRAME_H, 'jpeg');
      ws.send(new Blob([header, f.jpeg]));
      bytes = f.jpeg.size;
    } else return;
    this.lastSentTs = f.ts;
    this.jpegQuality.sent(bytes, now);
    this.stats.sent++;
    this.syncGate();
  }

  /** Starts the JPEG worker once; breath works without it (main-thread canvas). */
  private startEncoder() {
    if (this.encoder || this.encoderReady === false) return;
    try {
      const worker = new Worker(new URL('./camera-encoder.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<FromEncoder>) => this.onEncoderMessage(worker, e.data);
      worker.onerror = (e) => {
        e.preventDefault();
        this.encoderFailed(worker, e.message || 'the JPEG worker failed to load');
      };
      this.encoder = worker;
    } catch (err) {
      this.encoderReady = false;
      console.warn('[breath] no JPEG worker, encoding on the main thread', err);
    }
  }

  private onEncoderMessage(worker: Worker, msg: FromEncoder) {
    if (worker !== this.encoder) return;
    if (msg.t === 'caps') {
      this.encoderReady = msg.encode;
      if (!msg.encode) return this.encoderFailed(worker, "this browser can't make JPEGs in a worker");
      // Frames may already flow on the main thread: move them to the worker.
      if (this.stream) this.pumpFrames();
    } else if (msg.t === 'fail') {
      if (msg.gen === this.pumpGen) this.encoderFailed(worker, msg.message);
    } else if (msg.gen !== this.pumpGen) {
      // A pipeline that has been replaced.
    } else if (msg.t === 'tick') {
      if (this.pipe !== 'mstp') return;
      this.stats.captured += msg.captured;
      this.stats.skippedEncoder += msg.skippedEncoder;
      if (msg.captured) this.lastFrameAt = performance.now();
      this.syncGate();
    } else if (msg.t === 'frame') {
      const frame = msg.wire && { ts: msg.ts, wire: msg.wire, encodeMs: msg.encodeMs };
      if (this.pipe === 'mstp') {
        if (frame) this.sendJpeg(frame, true);
      } else if (this.pipe === 'bitmap') {
        if (frame) frame.encodeMs = performance.timeOrigin + performance.now() - msg.ts;
        this.encoded(msg.gen, msg.seq, frame);
      }
    }
  }

  /** The worker can't encode: back to the main-thread canvas for the rest of the page's life. */
  private encoderFailed(worker: Worker, message: string) {
    if (worker !== this.encoder) return;
    console.warn(`[breath] JPEG worker off, encoding on the main thread: ${message}`);
    this.stopCapture();
    worker.terminate();
    this.encoder = null;
    this.encoderReady = false;
    if (this.stream) this.pumpFrames();
  }

  /** Picks the capture pipeline for the current camera and starts it (pumpFrames). */
  private startCapture(gen: number) {
    this.stopCapture();
    this.pipe = pickCapturePipe({
      format: this.frameFormat,
      worker: Boolean(this.encoder),
      workerCanEncode: this.encoderReady === true,
      trackProcessor: typeof MediaStreamTrackProcessor === 'function',
      imageBitmap: typeof createImageBitmap === 'function',
    });
    const track = this.stream?.getVideoTracks()[0];
    if (this.pipe === 'mstp' && this.encoder && track && MediaStreamTrackProcessor) {
      // A clone, so ending the processor never ends the camera the player sees.
      const clone = track.clone();
      try {
        const { readable } = new MediaStreamTrackProcessor({ track: clone });
        const msg: ToEncoder = { t: 'stream', gen, readable, width: FRAME_W, height: FRAME_H };
        this.encoder.postMessage(msg, [readable]);
        this.processorTrack = clone;
      } catch (err) {
        clone.stop();
        console.warn('[breath] MediaStreamTrackProcessor unavailable, capturing frames on the page', err);
        this.pipe = 'bitmap';
      }
    }
    this.syncGate();
  }

  private stopCapture() {
    this.processorTrack?.stop();
    this.processorTrack = null;
    this.encoder?.postMessage({ t: 'stop' } satisfies ToEncoder);
    this.order.reset();
    this.gateKey = '';
  }

  /** Tells the worker whether to encode the frames it reads, how often, and at what quality. */
  private syncGate() {
    const encoder = this.encoder;
    if (!encoder || this.pipe !== 'mstp') return;
    const open =
      this.state.mode === 'presage' && this.ws?.readyState === WebSocket.OPEN && this.frameFormat === 'jpeg' && this.cameraLive();
    const intervalMs = this.busySince ? BUSY_FRAME_MS : 1000 / SEND_FPS;
    const quality = this.jpegQuality.quality;
    const key = `${open} ${intervalMs} ${quality}`;
    if (key === this.gateKey) return;
    this.gateKey = key;
    encoder.postMessage({ t: 'gate', open, intervalMs, quality } satisfies ToEncoder);
  }

  /** Counts the game's rendered frames (requestAnimationFrame) while live, for the stats. */
  private countRenders() {
    if (this.countingRenders) return;
    this.countingRenders = true;
    const tick = () => {
      if (this.state.mode !== 'presage') {
        this.countingRenders = false;
        return;
      }
      this.stats.render++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Every STATS_INTERVAL_MS while live: the camera pipeline's numbers to the sensor's log. */
  private sendStats(now: number) {
    if (!this.stats.due(now)) return;
    const camFps = this.stream?.getVideoTracks()[0]?.getSettings().frameRate ?? 0;
    const msg = this.stats.snapshot(now, { pipe: this.pipe, camFps, quality: this.jpegQuality.quality });
    if (this.state.mode === 'presage') this.send(msg);
  }

  private tickKeyboard() {
    if (this.state.mode !== 'keyboard') return;
    const holding = this.keyHeld;
    const changed = holding !== this.state.holding;
    this.state.holding = holding;
    this.state.holdMs = holding ? performance.now() - this.keyHoldStart : 0;
    this.state.status = 'running';
    this.state.calibrated = true;
    // Fake a trace so the HUD sparkline still tells the story.
    const t = performance.now() / 1000;
    const last = this.state.trace.at(-1) ?? 0;
    this.state.trace = [...this.state.trace.slice(-89), holding ? last : Math.sin(t * 1.6)];
    this.state.flatness = holding ? 1 : 0;
    if (changed || holding || Math.random() < 0.3) this.emit();
  }
}

function cameraLostMessage() {
  const key = keyLabel('breathInput');
  return t(`Camera lost: playing with the keyboard. Press ${key} to reconnect`, `摄像头已断开：改用键盘。按 ${key} 重新连接`);
}

function busyMessage() {
  const key = keyLabel('breathInput');
  return t(
    `Server busy: live breath sensing is in use by another player. Playing with the keyboard; press ${key} to try the camera again`,
    `服务器繁忙：其他玩家正在使用摄像头呼吸检测。已改用键盘，按 ${key} 可重试摄像头`,
  );
}

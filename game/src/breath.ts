// Breath input. In live mode the browser owns the webcam, shows it to the
// player, and streams its frames (JPEG, or raw RGBA in local dev; see
// frame-codec.ts) to the sensor bridge, which runs Presage SmartSpectra and
// answers with HOLD / BREATHE.
// Keyboard mode (hold Shift) exists so the game is playable without a camera.

import { HEADER_BYTES, JpegQuality, pickFrameFormat, writeFrameHeader, type FrameFormat } from './frame-codec';
import { isAction } from './controls';

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
  private encoding = false;

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
  }

  onChange(fn: (s: BreathState) => void) {
    this.listeners.push(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  async startLive(): Promise<void> {
    this.state.error = '';
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: FRAME_W }, height: { ideal: FRAME_H }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.state.mode = 'presage';
    this.connect();
    this.pumpFrames();
  }

  /** Releases the camera and the sensor's Presage session; back to keyboard mode. */
  stopLive() {
    this.pumpGen++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.setMode('keyboard');
    this.ws?.close();
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
      ws.send(JSON.stringify({ t: 'sim', on: this.state.mode === 'sim' }));
      this.emit();
    };
    ws.onclose = () => {
      this.state.connected = false;
      this.ws = null;
      this.emit();
      if (this.state.mode !== 'keyboard') setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const msg = JSON.parse(ev.data);
      if (msg.t === 'error') return this.onSensorError(msg);
      if (msg.t !== 'state' || this.state.mode === 'keyboard') return;
      this.state.holding = msg.holding;
      this.state.holdMs = msg.holdMs;
      this.state.calibrated = msg.calibrated;
      this.state.status = msg.status;
      this.state.hint = msg.hint;
      this.state.trace = msg.trace;
      this.state.flatness = msg.flatness;
      this.state.rate = msg.rate?.value ?? null;
      this.state.pulse = msg.pulse?.value ?? null;
      this.emit();
    };
    this.ws = ws;
  }

  // Presage errors also arrive in the state's hint. "busy" means the server's live
  // Presage slots are all taken: stop streaming frames nobody will process and fall
  // back to the keyboard, which always works.
  private onSensorError(msg: { code?: string; message?: string }) {
    const message = msg.message || 'Breath sensor error';
    console.warn(`[breath] ${message}`);
    // A sensor that can't decode JPEG (sharp not installed): raw frames still work on a LAN.
    if (msg.code === 'frames') {
      this.frameFormat = 'raw';
      return;
    }
    if (msg.code === 'busy' && this.state.mode === 'presage') this.stopLive();
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

  private pumpFrames() {
    const gen = ++this.pumpGen;
    const push = () => {
      if (gen !== this.pumpGen) return;
      this.sendFrame(gen);
      if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(push);
      else setTimeout(push, 33);
    };
    push();
  }

  private sendFrame(gen: number) {
    const ws = this.ws;
    if (this.state.mode !== 'presage' || ws?.readyState !== WebSocket.OPEN || this.video.readyState < 2) return;
    const format = this.frameFormat;
    if (ws.bufferedAmount >= MAX_BUFFERED[format]) {
      if (format === 'jpeg') this.jpegQuality.skipped(performance.now());
      return;
    }
    // One JPEG encode at a time keeps frames in order and stops a slow machine piling them up.
    if (format === 'jpeg' && this.encoding) return;
    this.ctx.drawImage(this.video, 0, 0, FRAME_W, FRAME_H);
    const ts = performance.timeOrigin + performance.now();
    if (format === 'raw') {
      const img = this.ctx.getImageData(0, 0, FRAME_W, FRAME_H);
      const buf = new ArrayBuffer(HEADER_BYTES + img.data.byteLength);
      writeFrameHeader(new DataView(buf), ts, FRAME_W, FRAME_H, 'raw');
      new Uint8Array(buf, HEADER_BYTES).set(img.data);
      ws.send(buf);
      return;
    }
    this.encoding = true;
    this.canvas.toBlob(
      (blob) => {
        this.encoding = false;
        if (gen !== this.pumpGen || ws !== this.ws || ws.readyState !== WebSocket.OPEN || this.frameFormat !== 'jpeg') {
          return;
        }
        // toBlob quietly falls back to PNG for a type it can't encode.
        if (!blob || blob.type !== 'image/jpeg') {
          this.frameFormat = 'raw';
          return;
        }
        const header = new ArrayBuffer(HEADER_BYTES);
        writeFrameHeader(new DataView(header), ts, FRAME_W, FRAME_H, 'jpeg');
        ws.send(new Blob([header, blob]));
        this.jpegQuality.sent(blob.size, performance.now());
      },
      'image/jpeg',
      this.jpegQuality.quality,
    );
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

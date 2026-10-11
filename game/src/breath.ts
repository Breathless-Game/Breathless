// Breath input. In live mode the browser owns the webcam, shows it to the
// player, and streams its frames (JPEG, or raw RGBA in local dev; see
// frame-codec.ts) to the sensor bridge, which runs Presage SmartSpectra and
// answers with HOLD / BREATHE.
// Keyboard mode (hold Shift) exists so the game is playable without a camera.

import { HEADER_BYTES, JpegQuality, pickFrameFormat, writeFrameHeader, type FrameFormat } from './frame-codec';
import { isAction, keyLabel } from './controls';
import { t } from './i18n';
import {
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
  private encoding = false;
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
    for (const fn of this.listeners) fn(this.state);
  }

  async startLive(): Promise<void> {
    this.state.error = '';
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
    this.pumpFrames();
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
  }

  private releaseCamera() {
    this.pumpGen++;
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
  // drops within ~20 s (sensor/heartbeat.mjs): keep the camera and wait (onBusy).
  private onSensorError(msg: { code?: string; message?: string }) {
    const message = msg.message || 'Breath sensor error';
    console.warn(`[breath] ${message}`);
    // A sensor that can't decode JPEG (sharp not installed): raw frames still work on a LAN.
    if (msg.code === 'frames') {
      this.frameFormat = 'raw';
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

  private pumpFrames() {
    const gen = ++this.pumpGen;
    const push = () => {
      if (gen !== this.pumpGen) return;
      this.lastFrameAt = performance.now();
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
    const ws = this.ws;
    if (this.state.mode !== 'presage' || ws?.readyState !== WebSocket.OPEN || this.video.readyState < 2) return;
    // A muted or ended track shows black (or a frozen frame): a flat trace the detector would
    // read as a HOLD. Send nothing until the camera is back.
    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live' || track.muted || this.reacquiring) return;
    const format = this.frameFormat;
    // Waiting for the slot back: a frame a second is enough to keep claiming it.
    if (this.busySince) {
      const now = performance.now();
      if (!busyFrameDue(this.lastBusyFrame, now)) return;
      this.lastBusyFrame = now;
    }
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

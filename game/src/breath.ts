// Breath input. In live mode the browser owns the webcam, shows it to the
// player, and streams raw frames to the local sensor bridge, which runs
// Presage SmartSpectra and answers with HOLD / BREATHE.
// Keyboard mode (hold Shift) exists so the game is playable without a camera.

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
}

const FRAME_W = 640;
const FRAME_H = 480;
const SENSOR_URL = `ws://${location.hostname || 'localhost'}:8787`;

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

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas.width = FRAME_W;
    this.canvas.height = FRAME_H;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift' && !this.keyHeld) {
        this.keyHeld = true;
        this.keyHoldStart = performance.now();
        if (this.state.mode === 'sim') this.send({ t: 'simHold', holding: true });
        if (this.state.mode === 'presage') this.sendLabel(true);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
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

  private sendLabel(holding: boolean) {
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
      const ws = this.ws;
      if (
        this.state.mode === 'presage' &&
        ws?.readyState === WebSocket.OPEN &&
        ws.bufferedAmount < 4 * FRAME_W * FRAME_H * 4 &&
        this.video.readyState >= 2
      ) {
        this.ctx.drawImage(this.video, 0, 0, FRAME_W, FRAME_H);
        const img = this.ctx.getImageData(0, 0, FRAME_W, FRAME_H);
        const buf = new ArrayBuffer(12 + img.data.byteLength);
        const view = new DataView(buf);
        view.setFloat64(0, performance.timeOrigin + performance.now(), true);
        view.setUint16(8, FRAME_W, true);
        view.setUint16(10, FRAME_H, true);
        new Uint8Array(buf, 12).set(img.data);
        ws.send(buf);
      }
      if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(push);
      else setTimeout(push, 33);
    };
    push();
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

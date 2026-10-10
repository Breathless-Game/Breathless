// Breath sensor bridge.
//
// The browser game owns the webcam (so macOS camera permission is the
// browser's problem, and the player sees themselves). It streams raw RGBA
// frames here over a WebSocket; we push them into Presage SmartSpectra,
// turn the breathing trace into HOLD / BREATHE, and stream state back.
//
//   node index.mjs          live Presage mode
//   node index.mjs --sim    no camera, synthetic breathing (hold via the game's debug key)

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  SmartSpectraSDK,
  FrameTransform,
  PixelFormat,
  MetricType,
  ProcessingStatus,
  ValidationCode,
  breathingMetrics,
} from '@smartspectra/node-sdk';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { BreathDetector } from './breath-detector.mjs';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const PORT = Number(process.env.SENSOR_PORT ?? 8787);
const API_KEY = process.env.PRESAGE_API_KEY;
const FORCE_SIM = process.argv.includes('--sim');
const HEADER_BYTES = 12; // f64 timestamp ms, u16 width, u16 height

const STATUS_NAMES = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.slice(1).toLowerCase()]));
const HINTS = {
  [ValidationCode.kOk]: '',
  [ValidationCode.kNoFaceFound]: 'No face found',
  [ValidationCode.kMultipleFacesFound]: 'Only one face, please',
  [ValidationCode.kFaceNotCentered]: 'Center your face',
  [ValidationCode.kFaceSizeOutOfRange]: 'Move closer / further',
  [ValidationCode.kTooDark]: 'Too dark',
  [ValidationCode.kTooBright]: 'Too bright',
  [ValidationCode.kChestNotVisible]: 'Show your chest',
  [ValidationCode.kCameraTuning]: 'Camera tuning…',
  [ValidationCode.kFrameRateTooLow]: 'Frame rate too low',
  [ValidationCode.kExcessiveMotion]: 'Hold still',
  [ValidationCode.kFaceTooClose]: 'Too close',
  [ValidationCode.kFaceTooFar]: 'Too far',
  [ValidationCode.kFaceTooHigh]: 'Face too high',
  [ValidationCode.kFaceTooLow]: 'Face too low',
  [ValidationCode.kFaceNotForward]: 'Look at the camera',
};

class Session {
  constructor(ws) {
    this.ws = ws;
    this.detector = new BreathDetector();
    this.sim = FORCE_SIM || !API_KEY;
    this.simHolding = false;
    this.sdk = null;
    this.status = 'idle';
    this.hint = '';
    this.rate = null;
    this.pulse = null;
    this.lastFrameUs = 0;
    this.frames = 0;
    this.metricsEvents = 0;
    this.tick = setInterval(() => this.#broadcast(), 80);
    this.simTimer = null;
    if (this.sim) this.#startSim();
  }

  // ---- Presage ----------------------------------------------------------

  #ensureSdk() {
    if (this.sdk || this.sim) return;
    this.status = 'starting';
    const sdk = new SmartSpectraSDK({
      apiKey: API_KEY,
      requestedMetrics: [...breathingMetrics, MetricType.TALKING, MetricType.PULSE_RATE],
      logLevel: 2,
    });
    sdk.on('processingStatus', (s) => {
      this.status = STATUS_NAMES[s] ?? String(s);
      log(`presage status: ${this.status}`);
    });
    sdk.on('validationStatus', (code) => {
      this.hint = HINTS[code] ?? `validation ${code}`;
    });
    sdk.on('error', (code, message, retryable) => {
      log(`presage error ${code}: ${message} (retryable=${retryable})`);
      this.#send({ t: 'error', message: `Presage: ${message}` });
      if (retryable) this.#restartSdk();
    });
    sdk.on('metrics', (buf) => this.#onMetrics(buf));
    sdk.useCustomInput(FrameTransform.kNone);
    sdk.start();
    this.sdk = sdk;
  }

  async #restartSdk() {
    const old = this.sdk;
    this.sdk = null;
    this.lastFrameUs = 0;
    if (old) {
      try {
        await old.stopAsync();
        await old.destroy();
      } catch {}
    }
  }

  #onMetrics(buf) {
    const m = decodeMetrics(buf);
    if (Buffer.isBuffer(m)) return;
    this.metricsEvents++;
    const b = m.breathing ?? {};
    if (b.upperTrace?.length) this.detector.pushTrace(b.upperTrace);
    const apnea = b.apnea?.at(-1);
    if (apnea) this.detector.setApnea(Boolean(apnea.detected));
    const talking = m.face?.talking?.at(-1);
    if (talking) this.detector.setTalking(Boolean(talking.detected));
    const rate = b.rate?.at(-1);
    if (rate) this.rate = { value: rate.value, confidence: rate.confidence };
    const pulse = m.cardio?.pulseRate?.at(-1);
    if (pulse) this.pulse = { value: pulse.value, confidence: pulse.confidence };
  }

  onFrame(data) {
    if (this.sim) return;
    this.#ensureSdk();
    if (!this.sdk || data.byteLength < HEADER_BYTES) return;
    const view = new DataView(data.buffer, data.byteOffset, HEADER_BYTES);
    const tsUs = Math.round(view.getFloat64(0, true) * 1000);
    const width = view.getUint16(8, true);
    const height = view.getUint16(10, true);
    if (tsUs <= this.lastFrameUs) return;
    // A long stall (tab hidden) makes Presage reject the gap; start a fresh pipeline.
    if (this.lastFrameUs && tsUs - this.lastFrameUs > 2_000_000) {
      this.#restartSdk();
      return;
    }
    const pixels = data.subarray(HEADER_BYTES);
    if (pixels.byteLength !== width * height * 4) return;
    try {
      this.sdk.sendFrame(pixels, width, height, width * 4, PixelFormat.kRGBA, tsUs);
      this.lastFrameUs = tsUs;
      this.frames++;
    } catch (e) {
      log(`sendFrame failed: ${e.message}`);
      this.#restartSdk();
    }
  }

  // ---- Simulator --------------------------------------------------------

  #startSim() {
    this.status = 'running';
    let phase = 0;
    let holdValue = 0;
    // Simulated heart: ~72 bpm at rest, slows during a hold (dive reflex),
    // briefly overshoots after you breathe again, then settles.
    let bpm = 72;
    let releasedAt = -Infinity;
    let wasHolding = false;
    const startUs = Date.now() * 1000;
    let tUs = startUs;
    this.simTimer = setInterval(() => {
      tUs += 33_333;
      phase += (2 * Math.PI * 0.033) / 4; // one breath every 4 s
      let v;
      if (this.simHolding) {
        v = holdValue + (Math.random() - 0.5) * 0.02;
      } else {
        v = Math.sin(phase) + (Math.random() - 0.5) * 0.05;
        holdValue = v;
      }
      this.detector.pushTrace([{ value: v, timestamp: tUs }]);
      this.rate = { value: this.simHolding ? 0 : 15, confidence: 100 };
      if (wasHolding && !this.simHolding) releasedAt = tUs;
      wasHolding = this.simHolding;
      const rebound = !this.simHolding && tUs - releasedAt < 12e6;
      const target = this.simHolding ? 58 : rebound ? 86 : 72;
      // The first gasp kicks the heart up fast; settling back is slow.
      bpm += (target - bpm) * (rebound ? 0.03 : 0.006) + (Math.random() - 0.5) * 0.25;
      this.pulse = { value: bpm, confidence: 90 };
    }, 33);
  }

  #stopSim() {
    clearInterval(this.simTimer);
    this.simTimer = null;
  }

  onCommand(msg) {
    if (msg.t === 'sim') {
      const on = Boolean(msg.on) || !API_KEY;
      if (on === this.sim) return;
      this.sim = on;
      this.detector = new BreathDetector();
      if (on) {
        this.#restartSdk();
        this.#startSim();
      } else {
        this.#stopSim();
        this.status = 'idle';
      }
    } else if (msg.t === 'simHold') {
      this.simHolding = Boolean(msg.holding);
    }
  }

  // ---- Output -----------------------------------------------------------

  #send(obj) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  #broadcast() {
    this.#send({
      t: 'state',
      source: this.sim ? 'sim' : 'presage',
      status: this.status,
      hint: this.hint,
      rate: this.rate,
      pulse: this.pulse,
      frames: this.frames,
      ...this.detector.snapshot(),
    });
  }

  async close() {
    clearInterval(this.tick);
    this.#stopSim();
    await this.#restartSdk();
  }
}

function log(msg) {
  console.log(`[sensor ${new Date().toLocaleTimeString()}] ${msg}`);
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 8 * 1024 * 1024 });
wss.on('connection', (ws) => {
  log('game connected');
  const session = new Session(ws);
  ws.on('message', (data, isBinary) => {
    if (isBinary) session.onFrame(data);
    else {
      try {
        session.onCommand(JSON.parse(data.toString()));
      } catch {}
    }
  });
  ws.on('close', () => {
    log('game disconnected');
    session.close();
  });
});

log(`listening on ws://localhost:${PORT} (${FORCE_SIM || !API_KEY ? 'simulator' : 'Presage live'})`);
if (!API_KEY) log('PRESAGE_API_KEY missing in .env: running simulator only');

setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, 10_000);

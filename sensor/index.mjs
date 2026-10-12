// Breath sensor bridge.
//
// The browser game owns the webcam (so macOS camera permission is the
// browser's problem, and the player sees themselves). It streams frames here
// over a WebSocket (JPEG, or raw RGBA in local dev; see frames.mjs); we decode
// them, push them into Presage SmartSpectra, turn the breathing trace into
// HOLD / BREATHE, and stream state back.
//
//   node index.mjs                 live Presage mode (dev: ws://<host>:8787, next to Vite)
//   node index.mjs --sim           no camera, synthetic breathing (hold via the game's debug key)
//   node index.mjs --serve <dir>   production: serves the built game from <dir>, the sensor
//                                  at /sensor, the PEARL market at /api/market and the fish
//                                  NFT metadata at /api/nft on one port (PORT, default 8794)

import { config } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { createServer, STATUS_CODES } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { sweepDead, watchAlive } from './heartbeat.mjs';
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
import { BreathDetector, parseSeedBaseline } from './breath-detector.mjs';
import { ClientStatsWindow, parseClientStats } from './client-stats.mjs';
import { loadJpegDecoder } from './decode.mjs';
import { FrameFormat, LatestFrameDecoder, parseFrame } from './frames.mjs';
import { createGearHandler } from './nft-gear.mjs';
import { createNftHandler } from './nft-meta.mjs';
import { SERIAL_FILE, createSerialHandler } from './nft-serial.mjs';
import { Recorder, flags, points } from './recorder.mjs';
import { staticHandler } from './static.mjs';
import { guardProcess } from './process-guard.mjs';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
// One stray rejection (e.g. an RPC 429 inside a library) must not drop every player's session.
guardProcess({ log });

const serveAt = process.argv.indexOf('--serve');
const SERVE_DIR = serveAt >= 0 ? process.argv[serveAt + 1] : undefined;
if (serveAt >= 0 && !SERVE_DIR) {
  console.error('usage: node index.mjs --serve <dir>   (e.g. ../game/dist)');
  process.exit(2);
}
const SERVE = SERVE_DIR !== undefined;
// Serve mode sits behind a tunnel / reverse proxy, so it binds loopback by default
// and never opens the dev port 8787.
const PORT = SERVE ? Number(process.env.PORT || 8794) : Number(process.env.SENSOR_PORT ?? 8787);
const HOST = SERVE ? process.env.HOST || '127.0.0.1' : undefined;
const API_KEY = process.env.PRESAGE_API_KEY;
const FORCE_SIM = process.argv.includes('--sim');
// One raw 640x480 RGBA frame is 1,228,812 bytes (a JPEG one ~10-40 kB); serve mode allows
// a raw frame with headroom.
const MAX_PAYLOAD = SERVE ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
// JPEG frames need sharp; without it the server says so once and the game falls back to raw.
const { decodeJpeg, error: jpegError } = await loadJpegDecoder();
const NO_JPEG_MESSAGE = "This breath sensor can't decode JPEG frames; sending raw frames instead.";
const STARTUP_BACKLOG_MS = 250; // see onFrame
// Recordings are physiological data. Dev records live sessions for analyze.mjs;
// the public server never writes strangers' breathing to disk unless SENSOR_RECORD=1.
const RECORD = SERVE ? process.env.SENSOR_RECORD === '1' : process.env.SENSOR_RECORD !== '0';
const NO_RECORDER = { write() {}, close() {} };
// The SmartSpectra SDK's native state is process-global; its own Electron host says
// "two SmartSpectra sessions must never run concurrently" (node-sdk js/main/index.js).
// So one live Presage session at a time; more would need one process per session.
const MAX_LIVE = envInt('MAX_LIVE_SESSIONS', 1);
const MAX_PER_IP = envInt('MAX_CONN_PER_IP', 8); // serve mode only
const BUSY_MESSAGE =
  MAX_LIVE > 0
    ? `Server busy: live breath sensing is in use by another player (${MAX_LIVE} at a time). Try again later.`
    : 'Live breath sensing is turned off on this server.';

// Sessions holding a live Presage slot, and native teardowns still in flight. A new
// native session must not start until every old one has finished tearing down.
const liveSessions = new Set();
let teardowns = 0;

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
    // This connection's live breathing baseline, once learned or seeded by the game. Every
    // later live detector starts with it, so it is never relearned. Memory only.
    this.liveBaseline = null;
    this.seededByClient = false;
    this.sim = FORCE_SIM || !API_KEY;
    this.simHolding = false;
    this.sdk = null;
    this.restarting = null;
    this.status = 'idle';
    this.hint = '';
    this.rate = null;
    this.pulse = null;
    this.lastFrameUs = 0;
    this.frames = 0;
    this.metricsEvents = 0;
    this.tick = setInterval(() => this.#broadcast(), 80);
    this.rec = RECORD ? new Recorder((path) => log(`recording to ${path}`)) : NO_RECORDER;
    this.busyNotified = false;
    this.framesAtLastSecond = 0;
    this.fpsTick = setInterval(() => {
      const n = this.frames - this.framesAtLastSecond;
      this.framesAtLastSecond = this.frames;
      if (n && !this.sim) this.rec.write({ k: 'fps', n });
    }, 1000);
    this.simTimer = null;
    // Compressed frames: decoded one at a time, newest first (frames.mjs).
    this.jpeg = null;
    this.noJpegNotified = false;
    this.sdkStartedAt = -Infinity;
    this.rx = this.#newRx();
    this.clientStats = new ClientStatsWindow();
    this.statsTick = setInterval(() => this.#logFrameStats(), 60_000);
    if (this.sim) this.#startSim();
  }

  // ---- Presage ----------------------------------------------------------

  #ensureSdk() {
    if (this.sdk || this.sim || this.restarting || teardowns > 0) return;
    this.status = 'starting';
    const sdk = new SmartSpectraSDK({
      apiKey: API_KEY,
      requestedMetrics: [...breathingMetrics, MetricType.TALKING, MetricType.PULSE_RATE],
      logLevel: 2,
    });
    sdk.on('processingStatus', (s) => {
      this.status = STATUS_NAMES[s] ?? String(s);
      log(`presage status: ${this.status}`);
      this.rec.write({ k: 'status', s: this.status });
    });
    sdk.on('validationStatus', (code) => {
      const hint = HINTS[code] ?? `validation ${code}`;
      if (hint !== this.hint) this.rec.write({ k: 'hint', code, hint });
      this.hint = hint;
    });
    sdk.on('error', (code, message, retryable) => {
      log(`presage error ${code}: ${message} (retryable=${retryable})`);
      // Also shown as the hint until the next validation status replaces it.
      this.hint = `Presage: ${message}`;
      this.#send({ t: 'error', message: `Presage: ${message}` });
      if (retryable) this.#restartSdk();
    });
    sdk.on('metrics', (buf) => this.#onMetrics(buf));
    sdk.useCustomInput(FrameTransform.kNone);
    // A new Presage pipeline (first frame, camera reopen, stall or error) gets a fresh
    // detector for its own start-up swings and timestamps, but keeps the known baseline.
    // The old SDK is fully torn down by now (teardowns === 0), so nothing stale reaches it.
    this.liveBaseline = this.#knownLiveBaseline();
    this.detector = new BreathDetector({ baseline: this.liveBaseline });
    sdk.start();
    this.sdk = sdk;
    this.sdkStartedAt = performance.now();
  }

  // Native SDK state is process-global: a new session built while the old one is
  // still tearing down gets its model download cancelled (error 8). Frames that
  // arrive during teardown (this session's or any other's) are dropped; the next
  // one after it builds a fresh SDK.
  #restartSdk() {
    if (this.restarting) return this.restarting;
    const old = this.sdk;
    this.sdk = null;
    this.lastFrameUs = 0;
    this.restarting = (async () => {
      if (!old) return;
      teardowns++;
      try {
        await old.stopAsync();
        await old.destroy();
      } catch {
      } finally {
        teardowns--;
      }
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  // Claims a live Presage slot (MAX_LIVE_SESSIONS). Over the cap the session stays
  // idle, drops frames and tells the game once; it takes the next slot that frees up.
  #claimLive() {
    if (liveSessions.has(this)) return true;
    if (liveSessions.size < MAX_LIVE) {
      liveSessions.add(this);
      this.busyNotified = false;
      if (this.status === 'busy') {
        this.status = 'idle';
        this.hint = '';
      }
      return true;
    }
    this.status = 'busy';
    this.hint = BUSY_MESSAGE;
    if (!this.busyNotified) {
      this.busyNotified = true;
      log(`live session refused: ${liveSessions.size}/${MAX_LIVE} slots in use`);
      this.#send({ t: 'error', code: 'busy', message: BUSY_MESSAGE });
    }
    return false;
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
    this.rec.write({
      k: 'm',
      up: points(b.upperTrace),
      lo: points(b.lowerTrace),
      amp: points(b.amplitude),
      rll: points(b.respiratoryLineLength),
      apnea: flags(b.apnea),
      talking: flags(m.face?.talking),
      rate: rate ? [rate.value, rate.confidence] : undefined,
      pulse: pulse ? [pulse.value, pulse.confidence] : undefined,
      holding: this.detector.holding,
      baseline: this.seededByClient ? undefined : this.detector.baseline, // a client's seed is never written to disk
    });
  }

  onFrame(data) {
    if (this.sim || !this.#claimLive()) return;
    this.#ensureSdk();
    if (!this.sdk) return;
    // Building and starting the SDK blocks the event loop for 1-3 s, so the frames that
    // arrive right after are a stale backlog. Feeding them in order is pointless, and
    // decoding only the newest JPEG would leave a > 2 s timestamp gap that restarts Presage.
    if (performance.now() - this.sdkStartedAt < STARTUP_BACKLOG_MS) {
      this.rx.backlog++;
      return;
    }
    const frame = parseFrame(data);
    if (!frame || frame.tsUs <= this.lastFrameUs) return;
    if (frame.format === FrameFormat.RAW) {
      this.rx.raw++;
      this.#sendFrame(frame.tsUs, frame.payload, frame.width, frame.height);
      return;
    }
    if (!decodeJpeg) {
      if (!this.noJpegNotified) {
        this.noJpegNotified = true;
        log('JPEG frame refused (sharp is unavailable); asking the game for raw frames');
        this.#send({ t: 'error', code: 'frames', message: NO_JPEG_MESSAGE });
      }
      return;
    }
    this.rx.jpeg++;
    this.rx.jpegBytes += frame.payload.byteLength;
    this.jpeg ??= new LatestFrameDecoder(
      (f) => decodeJpeg(f.payload, f.width, f.height),
      (f, pixels) => this.#sendFrame(f.tsUs, pixels, f.width, f.height),
      // At most once per stats window; the stats line counts the rest as "bad".
      (e) => this.jpeg.stats.failed === 1 && log(`JPEG frame rejected: ${e.message}`),
    );
    this.jpeg.push(frame);
  }

  // Also the landing point for decoded JPEG frames, which may finish after the SDK
  // restarted or the session left live mode.
  #sendFrame(tsUs, rgba, width, height) {
    if (this.sim || !this.sdk || tsUs <= this.lastFrameUs) return;
    // A long stall (tab hidden) makes Presage reject the gap; start a fresh pipeline.
    if (this.lastFrameUs && tsUs - this.lastFrameUs > 2_000_000) {
      this.#restartSdk();
      return;
    }
    try {
      this.sdk.sendFrame(rgba, width, height, width * 4, PixelFormat.kRGBA, tsUs);
      this.lastFrameUs = tsUs;
      this.frames++;
    } catch (e) {
      log(`sendFrame failed: ${e.message}`);
      this.#restartSdk();
    }
  }

  #newRx() {
    return { raw: 0, jpeg: 0, jpegBytes: 0, backlog: 0, since: Date.now(), sdkFrames: this.frames };
  }

  // One line a minute (and at close) while frames arrive: what the uplink and decoder cost.
  #logFrameStats() {
    const { raw, jpeg, jpegBytes, backlog, since, sdkFrames } = this.rx;
    this.rx = this.#newRx();
    const decode = this.jpeg?.summary(true);
    const client = this.clientStats.summary(true);
    if (!raw && !jpeg) return;
    const secs = Math.max(1, (Date.now() - since) / 1000);
    let line = `frames, last ${secs.toFixed(0)} s: ${raw} raw, ${jpeg} JPEG`;
    if (backlog) line += `, ${backlog} stale after an SDK start`;
    if (jpeg) {
      const kb = jpegBytes / jpeg / 1000;
      const mbit = (jpegBytes * 8) / secs / 1e6;
      line += ` (${(jpeg / secs).toFixed(1)} fps, avg ${kb.toFixed(1)} kB, ${mbit.toFixed(2)} Mbit/s)`;
    }
    if (decode) {
      line += `; decoded ${decode.decoded} (avg ${decode.avgMs.toFixed(1)} ms, p95 ${decode.p95Ms.toFixed(1)}, max ${decode.maxMs.toFixed(1)}), ${decode.dropped} dropped behind, ${decode.failed} bad`;
    }
    log(`${line}; ${this.frames - sdkFrames} to Presage${client ? `; ${client}` : ''}`);
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
        // Like a real player: breathe in, hold at the top, and come back out
        // with an exhale (the detector ends a hold on that drop).
        holdValue += (1 - holdValue) * 0.1;
        v = holdValue + (Math.random() - 0.5) * 0.02;
        phase = Math.PI / 2;
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

  #knownLiveBaseline() {
    return this.liveBaseline ?? (this.sim ? null : this.detector.baseline);
  }

  // Client -> server JSON messages (binary messages are camera frames):
  //   { t: 'sim', on }            simulator on/off; sent on connect
  //   { t: 'simHold', holding }   the simulator's Shift key
  //   { t: 'label', holding, ts } ground truth for the recording (live only)
  //   { t: 'calib', phase, ts }   guided-calibration phase for the recording (live only)
  //   { t: 'seed', baseline }     (`type: 'seed'` is accepted too) a live breathing baseline
  //                               the game remembered from an earlier connection's state
  //                               messages. Used only if this connection has none yet, and
  //                               only if it is a finite number in [SEED_MIN, SEED_MAX] =
  //                               [0.001, 1000] trace units per second (breath-detector.mjs);
  //                               anything else is ignored. Kept in memory only: never
  //                               logged, recorded or sent anywhere but back in `state`.
  //   { t: 'stats', pipe, camFps, capFps, rvfcFps, renderFps, sentFps, skippedEncoder,
  //     skippedBackpressure, encodeMsAvg, quality }
  //                               every ~10 s while live: the game's camera pipeline numbers
  //                               (game/src/frame-pump.ts). Performance only, never breath or
  //                               health data. Validated (client-stats.mjs: known fields, finite,
  //                               clamped) and only appended to the "frames, last N s" log line.
  onCommand(msg) {
    if (msg.t === 'sim') {
      const on = Boolean(msg.on) || !API_KEY;
      if (on !== this.sim) {
        // The simulator's trace has its own scale: keep the live baseline aside, not in it.
        this.liveBaseline = this.#knownLiveBaseline();
        this.sim = on;
        this.detector = new BreathDetector(on ? {} : { baseline: this.liveBaseline });
        if (on) {
          liveSessions.delete(this);
          this.hint = '';
          this.#restartSdk();
          this.#startSim();
        } else {
          this.#stopSim();
          this.status = 'idle';
        }
      }
      // The game sends this on connect: claim a slot now, so a full server says so before any frame.
      if (!on) this.#claimLive();
    } else if (msg.t === 'simHold') {
      this.simHolding = Boolean(msg.holding);
    } else if (msg.t === 'label' && !this.sim) {
      // Ground truth from the player (Shift held while really holding breath).
      this.rec.write({ k: 'label', ts: msg.ts, holding: Boolean(msg.holding) });
    } else if (msg.t === 'calib' && !this.sim) {
      this.rec.write({ k: 'calib', ts: msg.ts, phase: msg.phase });
    } else if (msg.t === 'stats') {
      this.clientStats.add(parseClientStats(msg));
    } else if (msg.t === 'seed' || msg.type === 'seed') {
      const b = parseSeedBaseline(msg.baseline);
      if (b != null && this.#knownLiveBaseline() == null) {
        this.liveBaseline = b;
        this.seededByClient = true;
        if (!this.sim) this.detector.seed(b);
      }
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
      // Only a live baseline is worth seeding a later connection with: the simulator's trace has its own scale.
      ...(this.sim ? { baseline: null } : {}),
    });
  }

  async close() {
    // The slot frees now; the teardown counter keeps the next native session from overlapping this one.
    liveSessions.delete(this);
    clearInterval(this.tick);
    clearInterval(this.fpsTick);
    clearInterval(this.statsTick);
    this.#logFrameStats();
    this.jpeg?.close();
    this.rec.close();
    this.#stopSim();
    await this.#restartSdk();
  }
}

function log(msg) {
  console.log(`[sensor ${new Date().toLocaleTimeString()}] ${msg}`);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  console.warn(`[sensor] ignoring ${name}=${raw}: expected a whole number >= 0`);
  return fallback;
}

function onConnection(ws) {
  log('game connected');
  watchAlive(ws);
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
}

// Behind the tunnel every socket comes from loopback, so the proxy's client-IP
// header is trusted there (and only there) for the per-IP connection limit.
function clientIp(req) {
  const peer = req.socket.remoteAddress ?? '';
  if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',').at(-1).trim();
  }
  return peer;
}

function refuse(socket, code) {
  socket.end(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Where the PEARL market's keys and state live, and the fish number counter (.market-serial.json):
// MARKET_DIR (relative to the repo root), default sensor/. deploy.sh never touches .market-* there.
const marketDir = () =>
  process.env.MARKET_DIR
    ? resolve(fileURLToPath(new URL('..', import.meta.url)), process.env.MARKET_DIR)
    : fileURLToPath(new URL('.', import.meta.url));

// Serve mode's PEARL market (market.mjs, the same one `npm run market` runs in dev). Imported
// lazily and fenced off: if it cannot start (missing dependency, bad config), the game and the
// sensor still serve and /api/market answers 503.
let market = null;
let marketDown = 'PEARL market is starting, try again in a moment';
async function startMarket() {
  try {
    const dir = marketDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { createMarket, rpcEndpoint } = await import('./market.mjs');
    market = await createMarket({
      rpc: rpcEndpoint(), // SOLANA_RPC, else VITE_SOLANA_RPC, else public devnet
      dir,
      clientIp,
    });
    Promise.resolve(market.ready).catch((e) => log(`PEARL market start-up task failed: ${e?.message ?? e}`));
  } catch (e) {
    marketDown = 'PEARL market is unavailable on this server';
    log(`PEARL market unavailable, /api/market answers 503: ${e?.message ?? e}`);
  }
}

const mode = FORCE_SIM || !API_KEY ? 'simulator' : `Presage live, max ${MAX_LIVE} at a time`;
let wss;
if (SERVE) {
  // One port for the tunnel: the built game over HTTP, the sensor WebSocket at /sensor.
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  wss.on('connection', onConnection);
  const perIp = new Map();
  const serveStatic = staticHandler(SERVE_DIR);
  void startMarket();
  // Fish NFT metadata and art, generated from the URL (nft-meta.mjs). PUBLIC_ORIGIN overrides the
  // origin its JSON points at; by default that is the request's Host.
  const nft = createNftHandler({ log });
  // The Boat and Dive Kit NFTs' metadata and cards (nft-gear.mjs), before `nft`, which 404s other /api/nft/ paths.
  const gear = createGearHandler();
  // Fish numbers (#0042) for new mints, POST /api/nft/serial (nft-serial.mjs), counted in the market
  // dir (startMarket has created it by now). Before `nft`, which answers every other /api/nft/ path.
  const serials = createSerialHandler({ file: join(marketDir(), SERIAL_FILE), clientIp, log });
  const server = createServer(async (req, res) => {
    try {
      let pathname = '';
      try {
        pathname = new URL(req.url ?? '/', 'http://x').pathname;
      } catch {} // the static handler answers 400
      if (pathname.startsWith('/api/')) {
        if (await serials(req, res)) return;
        if (await gear(req, res)) return;
        if (await nft(req, res)) return;
        if (market && (await market.handle(req, res))) return;
        // Never fall through to the index.html fallback: the game would read that as a market answer.
        if (pathname.startsWith('/api/market/')) return sendJson(res, 503, { error: marketDown });
        return sendJson(res, 404, { error: 'Not found' });
      }
      await serveStatic(req, res);
    } catch (e) {
      log(`${req.method} ${req.url} failed: ${e?.message ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.destroy();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    // A malformed request line must not crash the server: new URL throws on it.
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return refuse(socket, 400);
    }
    if (pathname !== '/sensor') return refuse(socket, 404);
    const ip = clientIp(req);
    if ((perIp.get(ip) ?? 0) >= MAX_PER_IP) {
      log(`refused a connection: ${MAX_PER_IP} already open from one address`);
      return refuse(socket, 429);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      ws.once('close', () => {
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n > 0) perIp.set(ip, n);
        else perIp.delete(ip);
      });
      wss.emit('connection', ws, req);
    });
  });
  server.on('error', (e) => {
    console.error(`[sensor] ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    log(`serving ${SERVE_DIR} on http://${HOST}:${PORT}, sensor at /sensor (${mode}), PEARL market at /api/market, NFT metadata at /api/nft`);
    log(`recordings ${RECORD ? 'ON (SENSOR_RECORD=1): sensor/recordings/' : 'off'}`);
  });
} else {
  wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD });
  wss.on('connection', onConnection);
  log(`listening on ws://localhost:${PORT} (${mode})`);
}
if (!API_KEY) log('PRESAGE_API_KEY missing in .env: running simulator only');
if (jpegError) log(`JPEG frames off, raw only (run npm --prefix sensor install): ${jpegError}`);
if (MAX_LIVE > 1) log(`warning: MAX_LIVE_SESSIONS=${MAX_LIVE}, but the Presage SDK can't run two sessions in one process`);

// Also drops half-open sockets (heartbeat.mjs), so a player's reconnect gets their old Presage slot back.
setInterval(() => {
  const dropped = sweepDead(wss.clients);
  if (dropped) log(`dropped ${dropped} unresponsive connection(s)`);
}, 10_000);

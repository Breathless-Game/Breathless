import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { presageEnabled } from '../presage-flag.mjs';

// Presage is off by default (presage-flag.mjs). These start the real sensor (index.mjs) in
// a child process, talk to it like the game does, and check that with the flag off it never
// loads the SmartSpectra SDK and drops camera traffic, even with an API key in the
// environment (production's .env still holds one). Module hooks (fixtures/) make any
// import of the SDK throw, or swap in a fake that says when it is constructed.

const SENSOR = fileURLToPath(new URL('..', import.meta.url));
const HOOKS = fileURLToPath(new URL('./fixtures/smartspectra-register.mjs', import.meta.url));
const KEY = 'test-key-not-a-real-presage-key';

test('PRESAGE_ENABLED: on only for 1 / true', () => {
  for (const v of ['1', 'true', 'TRUE', ' 1 ']) assert.equal(presageEnabled({ PRESAGE_ENABLED: v }), true, v);
  for (const v of [undefined, '', '0', 'false', 'no', 'yes', 'on', '2']) assert.equal(presageEnabled({ PRESAGE_ENABLED: v }), false, String(v));
  assert.equal(presageEnabled({}), false, 'unset is off');
});

async function freePort() {
  const srv = createServer().listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  srv.close();
  await once(srv, 'close');
  return port;
}

/** Starts index.mjs (dev mode, no --sim) and resolves once it listens. */
async function startSensor({ enabled, hook }) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', HOOKS, 'index.mjs'], {
    cwd: SENSOR,
    env: {
      ...process.env,
      // Set, even when empty, so a developer's .env can't override them (dotenv never overrides).
      PRESAGE_ENABLED: enabled ? '1' : '',
      PRESAGE_API_KEY: KEY,
      SENSOR_PORT: String(port),
      SENSOR_RECORD: '0', // never write recordings from a test
      MAX_LIVE_SESSIONS: '1',
      SMARTSPECTRA_HOOK: hook,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const deadline = Date.now() + 15_000;
  while (!out.includes('listening on ws://')) {
    if (child.exitCode != null) throw new Error(`sensor exited early (${child.exitCode}):\n${out}`);
    if (Date.now() > deadline) throw new Error(`sensor never listened:\n${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, port, output: () => out };
}

/** A 4x4 raw RGBA frame in the game's wire format (frames.mjs). */
function rawFrame(tsMs) {
  const buf = Buffer.alloc(12 + 4 * 4 * 4);
  buf.writeDoubleLE(tsMs, 0);
  buf.writeUInt16LE(4, 8);
  buf.writeUInt16LE(4, 10);
  return buf;
}

/** Connects like the game in camera mode: asks for live, sends frames, labels, calibration and a seed. */
async function playCameraMode(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs = [];
  ws.on('message', (d, binary) => {
    if (!binary) msgs.push(JSON.parse(d.toString()));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'sim', on: false }));
  ws.send(JSON.stringify({ t: 'seed', baseline: 0.5 }));
  ws.send(JSON.stringify({ t: 'calib', phase: 'breathe', ts: Date.now() }));
  ws.send(JSON.stringify({ t: 'label', holding: true, ts: Date.now() }));
  for (let i = 0; i < 5; i++) {
    ws.send(rawFrame(Date.now() + i * 33));
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 400));
  ws.close();
  await once(ws, 'close');
  return msgs;
}

test('flag off: the SDK is never loaded and camera traffic is dropped, even with an API key set', async () => {
  // 'block': any import of @smartspectra/* would throw and kill the sensor.
  const sensor = await startSensor({ enabled: false, hook: 'block' });
  try {
    const msgs = await playCameraMode(sensor.port);
    const out = sensor.output();
    assert.equal(sensor.child.exitCode, null, `the sensor died:\n${out}`);
    assert.match(out, /Presage SmartSpectra is disabled.*PRESAGE_ENABLED=1/);
    assert.match(out, /Presage disabled, simulator only/);
    assert.doesNotMatch(out, /FAKE_SMARTSPECTRA|presage status|presage error|402|Insufficient credits|PRESAGE_API_KEY missing/i);
    assert.ok(!out.includes(KEY), 'the API key is never printed');
    const states = msgs.filter((m) => m.t === 'state');
    assert.ok(states.length > 3, 'the simulator still answers');
    for (const s of states) {
      assert.equal(s.source, 'sim', 'never reports presage');
      assert.equal(s.frames, 0, 'no frame reached a pipeline');
      assert.equal(s.baseline, null, 'the seed was ignored');
    }
    const errors = msgs.filter((m) => m.t === 'error');
    assert.deepEqual(
      errors.map((e) => [e.code, e.reason]),
      [['busy', 'off']],
      'a game asking for the camera hears once that it is off (and falls back to the keyboard)',
    );
  } finally {
    sensor.child.kill();
  }
});

test('flag off: the fake SDK is never constructed either', async () => {
  const sensor = await startSensor({ enabled: false, hook: 'fake' });
  try {
    await playCameraMode(sensor.port);
    assert.doesNotMatch(sensor.output(), /FAKE_SMARTSPECTRA/);
  } finally {
    sensor.child.kill();
  }
});

test('flag on: the same traffic does reach the SDK (re-enabling still works)', async () => {
  const sensor = await startSensor({ enabled: true, hook: 'fake' });
  try {
    const msgs = await playCameraMode(sensor.port);
    const out = sensor.output();
    assert.match(out, /Presage live, max 1 at a time/);
    assert.doesNotMatch(out, /Presage SmartSpectra is disabled/);
    assert.match(out, /FAKE_SMARTSPECTRA constructed \(api key set\)/, 'the first frame builds an SDK session');
    assert.ok(!out.includes(KEY), 'the API key is never printed');
    assert.ok(msgs.some((m) => m.t === 'state' && m.source === 'presage'), 'live sessions report presage');
    assert.ok(!msgs.some((m) => m.t === 'error' && m.reason === 'off'));
  } finally {
    sensor.child.kill();
  }
});

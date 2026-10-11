import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const load = async (file) => {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const r = await load('camera-recovery.ts');
const breath = await readFile(new URL('../src/breath.ts', import.meta.url), 'utf8');

test('busy on the first connect falls back at once: the server is simply full', () => {
  assert.equal(r.onBusy(false, 1000, 1000), 'fallback');
});

test('busy on a reconnect waits for the old slot to free, then gives up', () => {
  const since = 50_000;
  assert.equal(r.onBusy(true, since, since), 'wait');
  assert.equal(r.onBusy(true, since, since + r.BUSY_GRACE_MS - 1), 'wait');
  assert.equal(r.onBusy(true, since, since + r.BUSY_GRACE_MS), 'fallback');
});

test('the grace outlasts the sensor dropping a dead socket (two 10 s sweeps)', () => {
  assert.ok(r.BUSY_GRACE_MS > 2 * 10_000 + 5000);
});

test('one automatic re-acquire per cooldown', () => {
  assert.ok(r.canReacquire(-Infinity, 0), 'the first loss may re-acquire');
  assert.ok(!r.canReacquire(10_000, 10_000 + r.REACQUIRE_COOLDOWN_MS - 1), 'a second loss soon after gives up');
  assert.ok(r.canReacquire(10_000, 10_000 + r.REACQUIRE_COOLDOWN_MS), 'a loss much later may again');
});

test('busy frames are throttled to one a second', () => {
  assert.ok(r.busyFrameDue(-Infinity, 0));
  assert.ok(!r.busyFrameDue(1000, 1500));
  assert.ok(r.busyFrameDue(1000, 2000));
});

test('recovering: any of no socket, detector not ready, camera down, waiting for the slot', () => {
  const ok = { connected: true, ready: true, cameraDown: false, waitingSlot: false };
  assert.equal(r.recovering(ok), false);
  for (const k of ['connected', 'ready']) assert.equal(r.recovering({ ...ok, [k]: false }), true, k);
  for (const k of ['cameraDown', 'waitingSlot']) assert.equal(r.recovering({ ...ok, [k]: true }), true, k);
});

test('the last holding value stands while recovering, but not for good', () => {
  assert.equal(r.holdOver(0, 5000), false, 'not recovering');
  assert.equal(r.holdOver(1000, 1000 + r.RECOVERY_HOLD_MAX_MS - 1), true);
  assert.equal(r.holdOver(1000, 1000 + r.RECOVERY_HOLD_MAX_MS), false, 'a signal that never returns stops counting as a hold');
});

test('detector ready: calibrated, and warm only when the sensor sends it', () => {
  assert.equal(r.detectorReady({ calibrated: true }), true, 'older sensor without warm');
  assert.equal(r.detectorReady({ calibrated: true, warm: true }), true);
  assert.equal(r.detectorReady({ calibrated: true, warm: false }), false, 'still warming');
  assert.equal(r.detectorReady({ calibrated: false, warm: true }), false);
});

test('seed: only a usable number is sent', () => {
  assert.deepEqual(r.seedMessage(0.42), { t: 'seed', baseline: 0.42 });
  assert.deepEqual(r.seedMessage(r.SEED_MIN), { t: 'seed', baseline: r.SEED_MIN });
  assert.deepEqual(r.seedMessage(r.SEED_MAX), { t: 'seed', baseline: r.SEED_MAX });
  for (const b of [null, NaN, Infinity, undefined, '0.4', 0, -1, 0.0009, 1000.1]) assert.equal(r.seedMessage(b), null, String(b));
});

test('sensor not ready: presage with no socket or a detector that cannot fire yet', () => {
  const ok = { mode: 'presage', connected: true, calibrated: true };
  assert.equal(r.sensorNotReady(ok), false);
  assert.equal(r.sensorNotReady({ ...ok, connected: false }), true);
  assert.equal(r.sensorNotReady({ ...ok, calibrated: false }), true);
  assert.equal(r.sensorNotReady({ mode: 'keyboard', connected: false, calibrated: false }), false, 'keyboard always counts');
  assert.equal(r.sensorNotReady({ mode: 'sim', connected: true, calibrated: false }), false);
});

test('main.ts: no breathe-underwater penalty while the sensor is not ready', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /breathSince = underwater && !s\.holding && !sensorNotReady\(s\)/);
});

test('breath.ts: a baseline is remembered only in presage mode', () => {
  assert.match(breath, /this\.state\.mode === 'presage' && msg\.source === 'presage' && usableBaseline\(msg\.baseline\)/);
});

test('breath.ts: the baseline is kept in memory only and survives stopLive', () => {
  assert.doesNotMatch(breath, /localStorage|sessionStorage/, 'a refresh relearns');
  const stop = breath.slice(breath.indexOf('  stopLive() {'), breath.indexOf('  private async openCamera('));
  assert.doesNotMatch(stop, /baseline/, 'stopLive keeps it');
  const at = breath.indexOf('ws.onopen = ');
  const open = breath.slice(at, breath.indexOf('ws.onclose = ', at));
  assert.ok(open.indexOf("t: 'sim'") < open.indexOf('this.sendSeed()'), 'seed after the sim switch, which rebuilds the detector');
});

test('breath.ts: no frames from a dead or muted track (a flat trace reads as a HOLD)', () => {
  const send = breath.slice(breath.indexOf('  private sendFrame('), breath.indexOf('  private tickKeyboard('));
  assert.match(send, /track\.readyState !== 'live' \|\| track\.muted/);
});

test('breath.ts: a lost camera is re-opened into the same socket, not via stopLive/startLive', () => {
  const lost = breath.slice(breath.indexOf('  private async cameraLost('), breath.indexOf('  private giveUpCamera('));
  assert.match(lost, /this\.openCamera\(\)/);
  assert.doesNotMatch(lost, /stopLive|startLive|this\.connect\(|ws\.close/);
});

test('stall and silence thresholds', () => {
  assert.ok(!r.frameStalled(0, r.FRAME_STALL_MS - 1));
  assert.ok(r.frameStalled(0, r.FRAME_STALL_MS));
  assert.ok(!r.sensorSilent(0, r.SENSOR_SILENT_MS - 1));
  assert.ok(r.sensorSilent(0, r.SENSOR_SILENT_MS));
});

// breath.ts needs a camera and a DOM; these pin the wiring at the source level.
test('breath.ts watches the camera track and the video', () => {
  for (const ev of ['ended', 'mute', 'unmute']) assert.match(breath, new RegExp(`addEventListener\\('${ev}'`), `track '${ev}'`);
  assert.match(breath, /visibilitychange/, 'resumes the video when the tab comes back');
  assert.match(breath, /addEventListener\('pause'/, 'resumes a paused video');
});

test('breath.ts: busy only stops the camera when onBusy says so', () => {
  const start = breath.indexOf('private onSensorError(');
  const handler = breath.slice(start, breath.indexOf('  sendLabel(', start));
  assert.match(handler, /onBusy\(/);
  assert.doesNotMatch(handler, /this\.stopLive\(\)/, 'a reconnect is not dropped to the keyboard outright');
});

test('breath.ts: the frame pump re-arms before sending, so a throw cannot end it', () => {
  const pump = breath.slice(breath.indexOf('private pumpFrames('), breath.indexOf('private sendFrame('));
  assert.ok(pump.indexOf('requestVideoFrameCallback(push)') < pump.indexOf('this.sendFrame('), 're-armed first');
  assert.match(pump, /try \{[\s\S]*this\.sendFrame\(/);
});

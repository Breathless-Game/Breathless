import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CLIENT_STATS_FIELDS, ClientStatsWindow, MAX_REPORTS_PER_WINDOW, parseClientStats } from '../client-stats.mjs';

const GOOD = {
  t: 'stats',
  pipe: 'mstp',
  camFps: 30,
  capFps: 29.84,
  rvfcFps: 14.2,
  renderFps: 14.1,
  sentFps: 29.6,
  skippedEncoder: 2,
  skippedBackpressure: 3,
  encodeMsAvg: 5.123,
  quality: 0.75,
};

test('a well-formed report keeps its numbers (rounded) and pipe, and drops `t`', () => {
  assert.deepEqual(parseClientStats(GOOD), {
    pipe: 'mstp',
    camFps: 30,
    capFps: 29.84,
    rvfcFps: 14.2,
    renderFps: 14.1,
    sentFps: 29.6,
    skippedEncoder: 2,
    skippedBackpressure: 3,
    encodeMsAvg: 5.12,
    quality: 0.75,
  });
});

test('only finite numbers survive; strings, NaN, Infinity, null and objects are dropped', () => {
  const s = parseClientStats({ ...GOOD, camFps: '30', capFps: NaN, rvfcFps: Infinity, renderFps: null, sentFps: { v: 1 }, quality: -Infinity });
  for (const k of ['camFps', 'capFps', 'rvfcFps', 'renderFps', 'sentFps', 'quality']) assert.equal(s[k], undefined, k);
  assert.equal(s.encodeMsAvg, 5.12);
});

test('numbers are clamped to their range', () => {
  const s = parseClientStats({ camFps: 1e9, sentFps: -5, skippedEncoder: 1e12, encodeMsAvg: 1e7, quality: 7 });
  assert.equal(s.camFps, CLIENT_STATS_FIELDS.camFps[1]);
  assert.equal(s.sentFps, 0);
  assert.equal(s.skippedEncoder, CLIENT_STATS_FIELDS.skippedEncoder[1]);
  assert.equal(s.encodeMsAvg, CLIENT_STATS_FIELDS.encodeMsAvg[1]);
  assert.equal(s.quality, 1);
});

test('unknown fields and pipes are dropped: nothing but performance numbers gets through', () => {
  const s = parseClientStats({ ...GOOD, pipe: 'evil\nline', holding: true, trace: [1, 2], pulse: 72, rate: 15, baseline: 0.8, __proto__: { x: 1 } });
  assert.deepEqual(Object.keys(s).sort(), Object.keys(CLIENT_STATS_FIELDS).sort());
  assert.equal(s.pipe, undefined);
});

test('nothing usable is null', () => {
  for (const m of [null, undefined, 42, 'stats', [], {}, { t: 'stats' }, { camFps: 'x' }]) assert.equal(parseClientStats(m), null, JSON.stringify(m));
});

test('a window averages rates, sums counts and keeps the latest pipe', () => {
  const w = new ClientStatsWindow();
  w.add(parseClientStats(GOOD));
  w.add(parseClientStats({ ...GOOD, pipe: 'bitmap', sentFps: 20.4, skippedBackpressure: 7, quality: 0.65 }));
  assert.equal(
    w.summary(),
    'client (2 reports): bitmap, camera 30.0 fps, captured 29.8, rVFC 14.2, render 14.1, sent 25.0; ' +
      'skipped 4 encoder busy, 10 backpressure; encode avg 5.1 ms, quality 0.70',
  );
});

test('a window without reports adds nothing, and summary(true) starts a new one', () => {
  const w = new ClientStatsWindow();
  assert.equal(w.summary(), '');
  w.add(parseClientStats(GOOD));
  assert.match(w.summary(true), /^client \(1 report\): mstp/);
  assert.equal(w.summary(), '');
});

test('missing fields show as "-"; invalid reports are not counted', () => {
  const w = new ClientStatsWindow();
  assert.equal(w.add(null), false);
  w.add(parseClientStats({ sentFps: 12 }));
  assert.equal(w.summary(), 'client (1 report): ?, camera - fps, captured -, rVFC -, render -, sent 12.0; skipped - encoder busy, - backpressure; encode avg - ms, quality -');
});

test('a window holds a bounded number of reports', () => {
  const w = new ClientStatsWindow();
  for (let i = 0; i < MAX_REPORTS_PER_WINDOW; i++) assert.ok(w.add(parseClientStats(GOOD)));
  assert.equal(w.add(parseClientStats(GOOD)), false);
  assert.match(w.summary(), new RegExp(`^client \\(${MAX_REPORTS_PER_WINDOW} reports\\)`));
});

test('index.mjs only appends stats to the frames log line, never records them', async () => {
  const index = await readFile(new URL('../index.mjs', import.meta.url), 'utf8');
  const branch = index.slice(index.indexOf("msg.t === 'stats'"), index.indexOf("msg.t === 'seed' || msg.type === 'seed'"));
  assert.match(branch, /this\.clientStats\.add\(parseClientStats\(msg\)\)/);
  assert.doesNotMatch(branch, /rec\.write|log\(|#send/);
  assert.match(index, /to Presage\$\{client \? `; \$\{client\}` : ''\}/);
});

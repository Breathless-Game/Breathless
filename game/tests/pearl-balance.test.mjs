import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('../src/pearl-balance.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('formatPearls groups thousands and never shows a bogus number', () => {
  assert.equal(m.formatPearls(0), '0');
  assert.equal(m.formatPearls(15), '15');
  assert.equal(m.formatPearls(999), '999');
  assert.equal(m.formatPearls(1234), '1,234');
  assert.equal(m.formatPearls(1234567), '1,234,567');
  assert.equal(m.formatPearls(12.9), '12');
  assert.equal(m.formatPearls(NaN), '—');
  assert.equal(m.formatPearls(-1), '—');
  assert.equal(m.formatPearls(Infinity), '—');
});

test('store: loading until a read lands, nudges only after, failures keep a known value', () => {
  let n = 0;
  const off = m.onPearlBalance(() => n++);
  assert.equal(m.pearlBalance().status, 'loading');
  m.nudgePearlBalance(7); // a stale cache must not pose as a read
  assert.equal(m.pearlBalance().status, 'loading');
  m.setPearlBalance(15);
  assert.deepEqual(m.pearlBalance(), { status: 'ok', value: 15 });
  m.nudgePearlBalance(20); // optimistic sale
  assert.equal(m.pearlBalance().value, 20);
  const before = n;
  m.nudgePearlBalance(20);
  assert.equal(n, before, 'no change, no notify');
  m.setPearlsUnavailable(new Error('429'));
  assert.equal(m.pearlBalance().status, 'ok', 'a known balance survives a failed read');
  m.setPearlsLoading();
  m.setPearlsUnavailable(new Error('429 Too Many Requests'));
  assert.equal(m.pearlBalance().status, 'unavailable');
  off();
  const after = n;
  m.setPearlBalance(1);
  assert.equal(n, after, 'unsubscribed listeners hear nothing more');
});

test('store: a spend shows the post-burn balance, and a failed sync after it never regresses to loading', () => {
  m.setPearlBalance(100);
  m.nudgePearlBalance(95); // applyPearlSpend + refreshEquipment right after the burn
  assert.deepEqual(m.pearlBalance(), { status: 'ok', value: 95 });
  m.setPearlsUnavailable(new Error('429 Too Many Requests')); // the sync after the burn is rate limited
  assert.deepEqual(m.pearlBalance(), { status: 'ok', value: 95 });
  m.setPearlsUnavailable(new Error('PEARL balance read timed out')); // or never settles
  assert.deepEqual(m.pearlBalance(), { status: 'ok', value: 95 });
});

test('epoch: a read that started before a spend, sale or nudge is dropped; one after it is kept', async () => {
  m.setPearlBalance(100);
  // syncPearls as main.ts runs it: guard first, then the read, then apply only if still current.
  const sync = async (read) => {
    const current = m.readGuard();
    const value = await read;
    if (!current()) return false;
    m.setPearlBalance(value);
    return true;
  };
  let land;
  const early = sync(new Promise((r) => (land = r))); // started before the burn
  m.nudgePearlBalance(90); // burn of 10 confirmed: applyPearlSpend + refreshEquipment
  const late = sync(Promise.resolve(90)); // the read the spend triggers
  assert.equal(await late, true);
  land(100); // the early read lands last, with the pre-burn number
  assert.equal(await early, false);
  assert.deepEqual(m.pearlBalance(), { status: 'ok', value: 90 });

  // A sale credited while a read is out (syncPearls(earned) bumps before nudging).
  const before = m.readGuard();
  m.bumpPearlEpoch();
  assert.equal(before(), false);
  // Nudges that change nothing (refreshEquipment after a read) do not bump.
  const g = m.readGuard();
  m.nudgePearlBalance(90);
  m.setPearlBalance(90);
  assert.equal(g(), true);
});

test('explainPearlError names the cause', () => {
  assert.match(m.explainPearlError(new Error('HTTP 429')), /rate limiting/);
  assert.match(m.explainPearlError(new Error('Failed to fetch')), /market is offline/);
  assert.match(m.explainPearlError('boom'), /unavailable/);
});

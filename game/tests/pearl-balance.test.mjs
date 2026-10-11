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

test('explainPearlError names the cause', () => {
  assert.match(m.explainPearlError(new Error('HTTP 429')), /rate limiting/);
  assert.match(m.explainPearlError(new Error('Failed to fetch')), /market is offline/);
  assert.match(m.explainPearlError('boom'), /unavailable/);
});

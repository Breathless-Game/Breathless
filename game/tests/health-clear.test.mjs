import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// "Delete my health data" is device-wide: every wallet's health and trips, plus the legacy unscoped keys, nothing else.
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const read = (rel) => readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(await read('wallet-storage.ts'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { healthDataKeys, hasHealthData, clearAllHealthData } = await import(dataUrl(outputText));

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

test('healthDataKeys: scoped and unscoped health/trips for any owner, nothing else', () => {
  const keys = [
    'deepbreath.health', 'deepbreath.trips',
    'deepbreath.ownerA.health', 'deepbreath.ownerA.trips',
    'deepbreath.ownerB.health', 'deepbreath.ownerB.trips',
    'deepbreath.ownerA.session', 'deepbreath.ownerA.bank', 'deepbreath.ownerA.equipment',
    'deepbreath.session', 'deepbreath.x.healthy', 'deepbreath.x.trips2', 'deepbreath.x.y.health',
    'deepbreath..health', 'other.ownerA.health', 'ownerA.health', 'deepbreath.', 'health',
  ];
  assert.deepEqual(healthDataKeys(keys), keys.slice(0, 6));
});

test('clearAllHealthData: removes every owner\'s data and keeps the keypairs', () => {
  store.clear();
  for (const k of ['deepbreath.health', 'deepbreath.trips', 'deepbreath.a.health', 'deepbreath.b.trips', 'deepbreath.a.session', 'deepbreath.b.bank']) store.set(k, 'secret');
  assert.equal(hasHealthData(), true);
  clearAllHealthData();
  assert.deepEqual([...store.keys()].sort(), ['deepbreath.a.session', 'deepbreath.b.bank']);
  assert.equal(hasHealthData(), false);
});

test('hasHealthData: trips alone count (the empty report must still offer deletion)', () => {
  store.clear();
  assert.equal(hasHealthData(), false);
  store.set('deepbreath.trips', '[]');
  assert.equal(hasHealthData(), true);
});

test('source: the empty report offers the delete button when device data exists', async () => {
  const src = await read('report.ts');
  const empty = src.slice(src.indexOf('if (!dives.length)'), src.indexOf('this.wire(); return;'));
  assert.match(empty, /hasHealthData\(\)/);
  assert.match(empty, /id="report-delete"/);
  assert.match(await read('health.ts'), /clearAllHealthData\(\)/);
  assert.match(await read('trip.ts'), /clearAllHealthData\(\)/);
});

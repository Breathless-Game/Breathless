import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// "Delete my health data" must take the trip reports too: they carry heart and breathing traces.
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
async function transpile(rel, replace = {}) {
  const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [from, to] of Object.entries(replace)) outputText = outputText.replaceAll(`from '${from}'`, `from '${to}'`);
  return dataUrl(outputText);
}

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// The wallet scopes keys per owner and throws with none connected (trip.ts then uses deepbreath.trips).
globalThis.__owner = null;
const walletStub = dataUrl("export const storageKey = (name) => { if (!globalThis.__owner) throw new Error('Connect a wallet first'); return globalThis.__owner + '.' + name; };");
const trip = await import(await transpile('trip.ts', {
  './wallet': walletStub,
  './fish': dataUrl('export const fishValue = () => 1; export const RARITY = {}; export const RARITY_ORDER = [];'),
  './i18n': dataUrl('export const t = (en) => en;'),
  './maps': dataUrl('export const MAPS = {};'),
  './report': dataUrl("export const compute = () => ({}); export const wellnessDisclaimer = () => 'Wellness only';"),
}));

test('clearTrips: removes this wallet\'s trips and the unscoped fallback', () => {
  store.set('deepbreath.trips', JSON.stringify([{ at: 1 }]));
  store.set('owner1.trips', JSON.stringify([{ at: 2 }]));
  store.set('owner1.health', 'kept by HealthLog.clear');
  globalThis.__owner = 'owner1';
  assert.equal(trip.loadTrips().length, 1);
  trip.clearTrips();
  assert.equal(store.has('owner1.trips'), false);
  assert.equal(store.has('deepbreath.trips'), false);
  assert.deepEqual(trip.loadTrips(), []);
  assert.equal(store.get('owner1.health'), 'kept by HealthLog.clear', 'only trip keys');
});

test('clearTrips: with no wallet connected the unscoped key goes', () => {
  globalThis.__owner = null;
  store.set('deepbreath.trips', JSON.stringify([{ at: 3 }]));
  trip.clearTrips();
  assert.deepEqual(trip.loadTrips(), []);
});

test('Trip.reset: a trip under way keeps no samples and is no longer active', () => {
  const t = new trip.Trip();
  t.start('reef');
  t.catch({ name: 'Cod', rarity: 'common', map: 'reef' });
  t.pulse.push(70); // a sample (sample() waits a second between readings)
  assert.equal(t.active, true);
  assert.equal(t.caught.length, 1);
  t.reset();
  assert.equal(t.active, false);
  assert.deepEqual([t.pulse, t.breath, t.caught], [[], [], []]);
});

test('the delete button clears the trips, the trip under way and the health desk', async () => {
  const report = await readFile(new URL('../src/report.ts', import.meta.url), 'utf8');
  const del = report.slice(report.indexOf("'report-delete')?.addEventListener"));
  assert.ok(del.indexOf('this.log.clear()') < del.indexOf('this.deleted()'), 'health log cleared, then the trips');
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const wiring = main.slice(main.indexOf('const report = new Report('), main.indexOf('\n});\n', main.indexOf('const report = new Report(')));
  for (const call of ['clearTrips()', 'trip.reset()', 'tripReport.close()', 'healthDesk.forget()']) assert.ok(wiring.includes(call), call);
});

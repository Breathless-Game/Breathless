import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/aquarium-state.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const aquarium = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const {
  AQUARIUM_STORAGE_KEY,
  DEFAULT_AQUARIUM_LIGHT,
  FEED_COOLDOWN_MS,
  MAX_FEEDS,
  defaultAquariumState,
  feedAquariumFish,
  feedFish,
  growthScale,
  loadAquariumState,
  normalizeAquariumState,
  normalizeLightColor,
  saveAquariumState,
} = aquarium;

function memoryStore(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    failRead: false,
    failWrite: false,
    getItem(key) {
      if (this.failRead) throw new Error('storage read failed');
      return this.map.has(key) ? this.map.get(key) : null;
    },
    setItem(key, value) {
      if (this.failWrite) throw new Error('storage write failed');
      this.map.set(key, String(value));
    },
  };
}

test('growth scale is monotonic and capped without mutating catch dimensions', () => {
  assert.equal(growthScale(-4), 1);
  assert.equal(growthScale(0), 1);
  for (let count = 1; count <= MAX_FEEDS; count++) {
    assert.ok(growthScale(count) > growthScale(count - 1));
  }
  assert.equal(growthScale(MAX_FEEDS + 20), growthScale(MAX_FEEDS));
  assert.equal(growthScale(Number.NaN), 1);
});

test('feeding accepts one serving, enforces cooldown, then stops at the growth cap', () => {
  let state = defaultAquariumState();
  let result = feedAquariumFish(state, 'fish-a', 1_000);
  assert.equal(result.fed, true);
  assert.equal(result.reason, 'fed');
  assert.deepEqual(result.growth, { feedCount: 1, lastFedAt: 1_000 });
  assert.equal(result.state.growth['fish-a'].feedCount, 1);

  // The old state is immutable, so a UI event cannot accidentally apply the
  // same feeding twice while a click is still bubbling.
  assert.deepEqual(state, defaultAquariumState());
  state = result.state;
  result = feedAquariumFish(state, 'fish-a', 1_000 + FEED_COOLDOWN_MS - 1);
  assert.equal(result.fed, false);
  assert.equal(result.reason, 'cooldown');
  assert.equal(result.state.growth['fish-a'].feedCount, 1);

  for (let count = 2; count <= MAX_FEEDS; count++) {
    result = feedAquariumFish(result.state, 'fish-a', 1_000 + (count - 1) * FEED_COOLDOWN_MS);
    assert.equal(result.fed, true);
    assert.equal(result.state.growth['fish-a'].feedCount, count);
  }
  result = feedAquariumFish(result.state, 'fish-a', 1_000 + MAX_FEEDS * FEED_COOLDOWN_MS);
  assert.equal(result.fed, false);
  assert.equal(result.reason, 'max');
  assert.equal(result.state.growth['fish-a'].feedCount, MAX_FEEDS);
});

test('invalid IDs and malformed growth are harmless', () => {
  const state = normalizeAquariumState({
    growth: {
      'fish-a': { feedCount: 99, lastFedAt: -1 },
      'fish-b': { feedCount: '2.9', lastFedAt: 3 },
      '': { feedCount: 2 },
    },
  });
  assert.deepEqual(state.growth['fish-a'], { feedCount: MAX_FEEDS, lastFedAt: null });
  assert.deepEqual(state.growth['fish-b'], { feedCount: 2, lastFedAt: 3 });
  assert.equal(state.growth[''], undefined);
  const result = feedAquariumFish(state, '', 100);
  assert.equal(result.fed, false);
  assert.equal(result.reason, 'invalid-id');
  assert.deepEqual(result.state, state);
  const direct = feedFish(undefined, 200);
  assert.equal(direct.fed, true);
  assert.equal(direct.growth.feedCount, 1);
});

test('ambient colour accepts six-digit hex values and rejects unsafe input', () => {
  assert.equal(normalizeLightColor('  #aBcD09 '), '#abcd09');
  assert.equal(normalizeLightColor('#abc'), DEFAULT_AQUARIUM_LIGHT);
  assert.equal(normalizeLightColor('rgb(1,2,3)'), DEFAULT_AQUARIUM_LIGHT);
  assert.equal(normalizeLightColor(null), DEFAULT_AQUARIUM_LIGHT);
  assert.equal(normalizeAquariumState({ light: { color: '#FF00AA' } }).light.color, '#ff00aa');
  assert.equal(normalizeAquariumState({ lightColor: '#00cc77' }).light.color, '#00cc77');
  assert.equal(normalizeAquariumState({ light: { color: '#bad' } }).light.color, DEFAULT_AQUARIUM_LIGHT);
});

test('state saves and loads through a supplied storage key, with safe failure fallbacks', () => {
  const storage = memoryStore();
  let state = defaultAquariumState();
  state = feedAquariumFish(state, 'fish-a', 7).state;
  state.light.color = '#123456';
  const saved = saveAquariumState(state, storage, 'wallet-aquarium');
  assert.deepEqual(saved, state);
  assert.deepEqual(loadAquariumState(storage, 'wallet-aquarium'), state);

  // The caller supplies a wallet-namespaced key; one owner's fish and lamp
  // preference must never bleed into another owner's aquarium.
  const other = saveAquariumState({ ...defaultAquariumState(), light: { color: '#abcdef' } }, storage, 'other-wallet-aquarium');
  assert.equal(loadAquariumState(storage, 'wallet-aquarium').light.color, '#123456');
  assert.equal(loadAquariumState(storage, 'other-wallet-aquarium').light.color, other.light.color);

  storage.map.set('broken', '{not json');
  assert.deepEqual(loadAquariumState(storage, 'broken'), defaultAquariumState());
  storage.failRead = true;
  assert.deepEqual(loadAquariumState(storage, 'wallet-aquarium'), defaultAquariumState());
  storage.failRead = false;
  storage.failWrite = true;
  assert.deepEqual(saveAquariumState(state, storage, 'wallet-aquarium'), state);
  assert.equal(AQUARIUM_STORAGE_KEY, 'deepbreath.aquarium');
});

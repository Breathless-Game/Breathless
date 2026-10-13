import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERATOR_V1, fishOf, recordedDepth, rollFish } from './fish-gen.mjs';
import { classifyOwned, createOwnedFishReader, parseOwnedQuery } from './fish-owned.mjs';
import { HttpError } from './market-rules.mjs';

// GET /api/market/fish behind a fake chain: only the game's fish come back (collection fish and
// older session-key fish that pass the generator check), each re-derived from its seed; gear and
// foreign NFTs are left out; reads are cached briefly in memory and nothing is written anywhere.

const OWNER = '11111111111111111111111111111112';
const OTHER = 'So11111111111111111111111111111111111111112';
const COLLECTION = 'AB2Wss9G1w246PoTWc6CQQ4pKnxQKeY1vC6MmyCYvkx5';
const SESSION = 'SysvarRent111111111111111111111111111111111';
let n = 0;

function fishAsset(fish, { ua = { type: 'Collection', address: COLLECTION }, owner = OWNER, noValue = false, extra = {} } = {}) {
  const list = [
    { key: 'rarity', value: fish.rarity },
    { key: 'species', value: fish.species },
    { key: 'depth', value: String(fish.depthM) },
    { key: 'seed', value: fish.id },
  ];
  if (!noValue) list.splice(3, 0, { key: 'value', value: String(fish.value) });
  return {
    publicKey: `Asset${++n}`,
    owner,
    updateAuthority: ua,
    name: `${fish.name} #0042`,
    uri: `https://breathless.gotclass.xyz/api/nft/meta/v2/42/${fish.id}/x.json`,
    attributes: { authority: { type: 'UpdateAuthority' }, attributeList: list },
    ...extra,
  };
}

const gearAsset = () => ({
  publicKey: `Gear${++n}`,
  owner: OWNER,
  updateAuthority: { type: 'Address', address: SESSION },
  name: 'Boat',
  uri: 'https://breathless.gotclass.xyz/api/nft/gear/x.json',
  attributes: { authority: { type: 'UpdateAuthority' }, attributeList: [{ key: 'kind', value: 'boat' }, { key: 'boat', value: '3' }] },
});

const caught = (seed, depth = 130) => rollFish(seed, depth);

test('the query needs an owner public key', () => {
  assert.deepEqual(parseOwnedQuery(new URLSearchParams({ owner: OWNER })), { owner: OWNER });
  assert.throws(() => parseOwnedQuery(new URLSearchParams()), HttpError);
  assert.throws(() => parseOwnedQuery(new URLSearchParams({ owner: 'not a key' })), HttpError);
});

test('a collection fish comes back as the game rolled it, with its recorded depth and value', () => {
  const fish = caught(0x00c0ffee);
  const e = classifyOwned(fishAsset(fish), { collection: COLLECTION });
  assert.equal(e.trust, 'collection');
  assert.equal(e.version, 2);
  assert.equal(e.assetId, `Asset${n}`);
  assert.deepEqual(e.spec, fish); // every field: look, size, name, depth, value
  assert.deepEqual(e.facts, { id: fish.id, rarity: fish.rarity, species: fish.species, depth: fish.depthM, value: fish.value });
});

test('an older fish minted by a session key passes only the generator check, as legacy', () => {
  const fish = caught(0x12345678);
  const legacy = classifyOwned(fishAsset(fish, { ua: { type: 'Address', address: SESSION } }), { collection: COLLECTION });
  assert.equal(legacy.trust, 'legacy');
  // With no value attribute (the first day's mints): the value stays missing, the game falls back.
  const noValue = classifyOwned(fishAsset(fish, { ua: { type: 'Address', address: SESSION }, noValue: true }), { collection: COLLECTION });
  assert.equal(noValue.trust, 'legacy');
  assert.equal('value' in noValue.spec, false);
  // Program mode / no collection yet: legacy fish still come back, collection fish need the collection.
  assert.equal(classifyOwned(fishAsset(fish, { ua: { type: 'Address', address: SESSION } }), { collection: null }).trust, 'legacy');
  assert.ok(classifyOwned(fishAsset(fish), { collection: null }).skip);
});

test('a v1 fish (the first roster) is rebuilt with v1', () => {
  // A seed whose v1 and v2 rolls differ in species.
  let seed = 1;
  while (GENERATOR_V1.fishOf(seed, 'rare').species === fishOf(seed, 'rare').species) seed++;
  const v1 = { ...GENERATOR_V1.fishOf(seed, 'rare'), depthM: 0 };
  const depth = [...Array(400).keys()].find((d) => GENERATOR_V1.rarityAt(seed, d) === 'rare');
  assert.notEqual(depth, undefined);
  const fish = GENERATOR_V1.rollFish(seed, depth);
  const e = classifyOwned(fishAsset({ ...v1, depthM: recordedDepth(depth), value: fish.value }), { collection: COLLECTION });
  assert.equal(e.version, 1);
  assert.equal(e.spec.species, v1.species);
  assert.equal(e.spec.name, fish.name);
});

test('gear, foreign NFTs and fish the generator cannot grow are left out', () => {
  const fish = caught(0x0badf00d);
  assert.equal(classifyOwned(gearAsset(), { collection: COLLECTION }).skip, 'not-a-fish');
  assert.equal(classifyOwned(fishAsset(fish, { ua: { type: 'Collection', address: OTHER } }), { collection: COLLECTION }).skip, 'not-a-fish');
  const forged = fishAsset(fish);
  forged.attributes.attributeList[1] = { key: 'species', value: 'Whale Shark' };
  assert.ok(classifyOwned(forged, { collection: COLLECTION }).skip);
  const forgedLegacy = fishAsset(fish, { ua: { type: 'Address', address: SESSION } });
  forgedLegacy.attributes.attributeList[0] = { key: 'rarity', value: 'mythic' };
  assert.equal(classifyOwned(forgedLegacy, { collection: COLLECTION }).skip, 'generator');
  assert.ok(classifyOwned(fishAsset(fish, { extra: { updateDelegate: { authority: { type: 'Owner' }, additionalDelegates: [] } } }), { collection: COLLECTION }).skip);
  assert.equal(classifyOwned(fishAsset(fish, { ua: { type: 'Address', address: SESSION }, extra: { freezeDelegate: { frozen: false } } }), { collection: COLLECTION }).skip, 'plugin');
});

test('the reader lists only the owner\'s fish, caches briefly, and forgets after a sale', async () => {
  let t = 1000;
  const fish = caught(0x44444444);
  const calls = [];
  const assets = [fishAsset(fish), gearAsset(), fishAsset(caught(0x55555555), { owner: OTHER })];
  const reader = createOwnedFishReader({
    fetchOwned: async (owner) => {
      calls.push(owner);
      return assets;
    },
    collection: async () => COLLECTION,
    ttlMs: 8000,
    now: () => t,
  });
  const first = await reader.read({ owner: OWNER });
  assert.equal(first.owner, OWNER);
  assert.equal(first.collection, COLLECTION);
  assert.deepEqual(first.fish.map((f) => f.spec.id), [fish.id]);
  await reader.read({ owner: OWNER });
  assert.equal(calls.length, 1); // cached
  t += 8000;
  await reader.read({ owner: OWNER });
  assert.equal(calls.length, 2); // stale
  reader.invalidate(OWNER);
  await reader.read({ owner: OWNER });
  assert.equal(calls.length, 3);
  // Two reads at once share one chain read.
  reader.invalidate(OWNER);
  await Promise.all([reader.read({ owner: OWNER }), reader.read({ owner: OWNER })]);
  assert.equal(calls.length, 4);
  // A failed chain read is not cached.
  const failing = createOwnedFishReader({ fetchOwned: async () => { throw new Error('429'); }, collection: async () => COLLECTION });
  await assert.rejects(failing.read({ owner: OWNER }));
  assert.equal(failing.size(), 0);
});

test('a read in flight when the owner is invalidated does not cache its older answer, and leaves nothing behind', async () => {
  let fish = [fishAsset(caught(0x44444444))];
  let gate = null;
  let calls = 0;
  const reader = createOwnedFishReader({
    fetchOwned: async () => {
      calls += 1;
      const out = fish;
      if (gate) await gate;
      return out;
    },
    collection: async () => COLLECTION,
  });
  for (let i = 0; i < 5_000; i++) reader.invalidate(`junk-${i}`);
  assert.equal(reader.pending(), 0);
  let open;
  gate = new Promise((res) => (open = res));
  const before = reader.read({ owner: OWNER });
  reader.invalidate(OWNER); // sold meanwhile, same tick
  await new Promise((res) => setImmediate(res));
  gate = null;
  fish = [];
  const after = reader.read({ owner: OWNER }); // must not join the older read
  assert.equal(reader.pending(), 1);
  open();
  assert.equal((await before).fish.length, 1);
  assert.equal((await after).fish.length, 0);
  assert.equal((await reader.read({ owner: OWNER })).fish.length, 0, 'the cache holds the post-sale list');
  assert.equal(calls, 2);
  assert.equal(reader.pending(), 0);
});

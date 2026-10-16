import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERATOR_V1, fishLook, fishOf, legacyLook, recordedDepth, rollFish, withLegacyLook } from './fish-gen.mjs';
import {
  DAS_PAGE,
  classifyOwned,
  createOwnedFetcher,
  createOwnedFishReader,
  fetchAssetsByIds,
  jsonRpc,
  listOwnedIds,
  parseOwnedQuery,
} from './fish-owned.mjs';
import { HttpError } from './market-rules.mjs';

// GET /api/market/fish behind a fake chain: only the game's fish come back (collection fish and
// older session-key fish that pass the generator check), each re-derived from its seed; gear and
// foreign NFTs are left out; reads are cached briefly in memory and nothing is written anywhere.

const OWNER = '11111111111111111111111111111112';
const OTHER = 'So11111111111111111111111111111111111111112';
const COLLECTION = 'AB2Wss9G1w246PoTWc6CQQ4pKnxQKeY1vC6MmyCYvkx5';
const SESSION = 'SysvarRent111111111111111111111111111111111';
let n = 0;

/** The metadata URI the game mints a fish with (game/src/nft-uri.ts fishMetaPath), from its bank entry. */
const metaUri = (f) =>
  `https://breathless.gotclass.xyz/api/nft/meta/v2/42/${f.id}/${f.rarity}/${f.depthM}-${f.value ?? 1}-${f.lengthCm}-${f.weightKg}/${fishLook(f)}/Reef/${encodeURIComponent(f.name)}.json`;

function fishAsset(fish, { ua = { type: 'Collection', address: COLLECTION }, owner = OWNER, noValue = false, extra = {}, uri = metaUri(fish) } = {}) {
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
    uri,
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
  assert.equal(e.version, 3);
  assert.equal(e.assetId, `Asset${n}`);
  assert.deepEqual(e.spec, fish); // every field: look, size, name, depth, value
  assert.deepEqual(e.facts, { id: fish.id, rarity: fish.rarity, species: fish.species, depth: fish.depthM, value: fish.value });
});

test('the colours come from the NFT URI: random for a new fish, legacy for an old one or a URI that is neither', () => {
  const fish = caught(0x00c0ffee);
  const old = withLegacyLook(fish);
  assert.notEqual(fishLook(old), fishLook(fish));
  // Minted since random colours: its URI carries the look stream's colours.
  assert.deepEqual(classifyOwned(fishAsset(fish), { collection: COLLECTION }).spec, fish);
  // Banked (and minted) before them: the main stream's colours, exactly as the aquarium drew it.
  const e = classifyOwned(fishAsset(old), { collection: COLLECTION });
  assert.deepEqual(e.spec, old);
  assert.deepEqual(e.spec, { ...fish, ...legacyLook(fish.seed, fish.rarity) });
  // Irys, garbage, or a look that is neither: legacy, as before.
  for (const uri of ['https://arweave.net/abc123', 'not a url', '', `https://breathless.gotclass.xyz/api/nft/meta/v2/42/${fish.id}/x.json`, metaUri({ ...fish, hue: fish.hue + 50 })]) {
    assert.deepEqual(classifyOwned(fishAsset(fish, { uri }), { collection: COLLECTION }).spec, old, uri);
  }
  // A v1 fish with its legacy look in the URI rebuilds with it too (legacy trust, session key).
  const legacyMint = classifyOwned(fishAsset(old, { ua: { type: 'Address', address: SESSION } }), { collection: COLLECTION });
  assert.deepEqual(legacyMint.spec, old);
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

// ---- Listing: the DAS owner index + getMultipleAccounts, or getProgramAccounts ------------------

/**
 * One fake chain behind both paths. `assets` (as mpl-core decodes them) are the accounts; the DAS
 * index lists `indexed` (default: every asset) plus `extra` items. fetch answers JSON-RPC like an
 * RPC: "method not found" without DAS, a 429 on `failPage`.
 */
function fakeRpc(assets, { das = true, indexed = assets, extra = [], failPage = null } = {}) {
  const calls = { das: [], accounts: [], gpa: 0 };
  const byId = new Map(assets.map((a) => [a.publicKey, a]));
  const items = [...indexed.map((a) => ({ interface: 'MplCoreAsset', id: a.publicKey, burnt: false })), ...extra];
  const fetch = async (_url, req) => {
    const { params } = JSON.parse(req.body);
    calls.das.push(params);
    const json = (body) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, ...body }) });
    if (!das) return json({ error: { code: -32601, message: 'Method not found' } });
    if (params.page === failPage) return { ok: false, status: 429, json: async () => ({}) };
    const start = (params.page - 1) * params.limit;
    return json({ result: { total: items.length, limit: params.limit, page: params.page, items: items.slice(start, start + params.limit) } });
  };
  return {
    calls,
    das: jsonRpc('https://rpc.example/?api-key=secret', { fetch }),
    fetchByIds: (ids) =>
      fetchAssetsByIds(ids, {
        getAccounts: async (keys) => {
          calls.accounts.push(keys.length);
          return keys.map((k) => (byId.has(k) ? { exists: true, asset: byId.get(k) } : { exists: false }));
        },
        decode: (acc) => acc.asset,
      }),
    fetchByGpa: async (owner) => {
      calls.gpa += 1;
      return assets.filter((a) => a.owner === owner);
    },
  };
}

const ownedFixture = () => [
  fishAsset(caught(0x44444444)),
  fishAsset(caught(0x12345678), { ua: { type: 'Address', address: SESSION } }),
  gearAsset(),
  fishAsset(caught(0x0badf00d), { extra: { updateDelegate: { authority: { type: 'Owner' }, additionalDelegates: [] } } }),
  fishAsset(caught(0x55555555), { owner: OTHER }),
];

const readerOver = (fetchOwned) => createOwnedFishReader({ fetchOwned, collection: async () => COLLECTION, ttlMs: 0 });
const sameRead = (v) => ({ ...v, at: 0 });

test('with DAS the fish come back exactly as getProgramAccounts gives them, and getProgramAccounts is not called', async () => {
  const assets = ownedFixture();
  const rpc = fakeRpc(assets, { indexed: assets.filter((a) => a.owner === OWNER) });
  const logs = [];
  const viaDas = await readerOver(createOwnedFetcher({ ...rpc, label: 'https://rpc.example/…', log: (m) => logs.push(m) })).read({ owner: OWNER });
  assert.equal(rpc.calls.gpa, 0);
  assert.deepEqual(rpc.calls.das, [{ ownerAddress: OWNER, page: 1, limit: DAS_PAGE }]);
  const viaGpa = await readerOver(rpc.fetchByGpa).read({ owner: OWNER });
  assert.deepEqual(sameRead(viaDas), sameRead(viaGpa));
  assert.deepEqual(viaDas.fish.map((f) => f.trust), ['collection', 'legacy']); // gear and the delegated fish left out
  assert.equal(logs.length, 1);
  assert.ok(!logs.join(' ').includes('secret'), 'the RPC key is never logged');
});

test('the DAS index is only an index: stale, burnt, closed and non-Core entries change nothing', async () => {
  const assets = ownedFixture();
  const sold = assets[4]; // OTHER owns it on chain; a lagging index still lists it under OWNER
  const rpc = fakeRpc(assets, {
    indexed: [...assets.filter((a) => a.owner === OWNER), sold],
    extra: [
      { interface: 'V1_NFT', id: 'Legacy111', burnt: false },
      { interface: 'MplCoreAsset', id: assets[0].publicKey, burnt: true },
      { interface: 'MplCoreAsset', id: assets[1].publicKey, burnt: false }, // listed twice
      { interface: 'MplCoreAsset', id: 'Gone11111', burnt: false }, // account closed since
    ],
  });
  const viaDas = await readerOver(createOwnedFetcher({ ...rpc, log: () => {} })).read({ owner: OWNER });
  assert.equal(rpc.calls.gpa, 0);
  assert.deepEqual(sameRead(viaDas), sameRead(await readerOver(rpc.fetchByGpa).read({ owner: OWNER })));
  // An account that no longer decodes as an asset is skipped, not thrown.
  const got = await fetchAssetsByIds(['A', 'B'], {
    getAccounts: async (keys) => keys.map((k) => ({ exists: true, k })),
    decode: (acc) => {
      if (acc.k === 'A') throw new Error('Uninitialized');
      return acc.k;
    },
  });
  assert.deepEqual(got, ['B']);
});

test('an RPC without DAS falls back to getProgramAccounts and is not asked again', async () => {
  const assets = ownedFixture();
  const rpc = fakeRpc(assets, { das: false });
  const logs = [];
  const fetchOwned = createOwnedFetcher({ ...rpc, log: (m) => logs.push(m) });
  assert.equal((await readerOver(fetchOwned).read({ owner: OWNER })).fish.length, 2);
  await fetchOwned(OWNER);
  await fetchOwned(OWNER);
  assert.equal(rpc.calls.das.length, 1, 'one probe per instance');
  assert.equal(rpc.calls.gpa, 3);
  assert.equal(logs.length, 1);
  // No DAS caller at all: straight to getProgramAccounts.
  const none = fakeRpc(assets);
  await createOwnedFetcher({ ...none, das: null, log: () => {} })(OWNER);
  assert.deepEqual([none.calls.das.length, none.calls.gpa], [0, 1]);
});

test('pages are followed to the end; a page failing mid-read means getProgramAccounts for that read only', async () => {
  const assets = ownedFixture().map((a) => ({ ...a, owner: OWNER })); // 5 assets + 2 tokens: 4 pages of 2
  const extra = ['Token1111', 'Token2222'].map((id) => ({ interface: 'FungibleToken', id, burnt: false }));
  const ok = fakeRpc(assets, { extra });
  assert.deepEqual(await listOwnedIds(ok.das, OWNER, { pageSize: 2 }), assets.map((a) => a.publicKey));
  assert.deepEqual(ok.calls.das.map((p) => [p.page, p.limit]), [[1, 2], [2, 2], [3, 2], [4, 2]]);
  await assert.rejects(listOwnedIds(ok.das, OWNER, { pageSize: 2, maxPages: 2 }), /more than 2 pages/); // never a silent cut
  const viaDas = await createOwnedFetcher({ ...ok, pageSize: 2, log: () => {} })(OWNER);
  assert.deepEqual(viaDas, assets);

  const flaky = fakeRpc(assets, { extra, failPage: 2 });
  let t = 0;
  const logs = [];
  const fetchOwned = createOwnedFetcher({ ...flaky, pageSize: 2, log: (m) => logs.push(m), now: () => t });
  assert.equal((await fetchOwned(OWNER)).length, 5);
  assert.deepEqual([flaky.calls.das.length, flaky.calls.gpa, flaky.calls.accounts.length], [2, 1, 0]);
  await fetchOwned(OWNER);
  assert.equal(flaky.calls.das.length, 4, 'DAS is tried again after a transient failure');
  assert.equal(flaky.calls.gpa, 2);
  assert.equal(logs.length, 1, 'failure logs are throttled');
  t += 60_000;
  await fetchOwned(OWNER);
  assert.equal(logs.length, 2);
});

test('getMultipleAccounts is asked for at most 100 accounts at a time', async () => {
  const keys = Array.from({ length: 250 }, (_, i) => `K${i}`);
  const sizes = [];
  const got = await fetchAssetsByIds(keys, {
    getAccounts: async (ks) => {
      sizes.push(ks.length);
      return ks.map((k) => ({ exists: true, k }));
    },
    decode: (acc) => acc.k,
  });
  assert.deepEqual(sizes, [100, 100, 50]);
  assert.deepEqual(got, keys);
});

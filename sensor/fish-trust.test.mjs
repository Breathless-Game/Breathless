import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign as ed25519Sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GENERATORS, GENERATOR_V1, GENERATOR_V2, GENERATOR_V3, LEGACY_ZONES, Rng, fishLook, fishOf, rarityAt, rollFish } from './fish-gen.mjs';
import { publicKey, publicKeyBytes } from '@metaplex-foundation/umi';
import { createFishCollection } from './fish-collection.mjs';
import {
  BAD_SIGNATURE_CODE,
  FishRegistry,
  KvQuota,
  Quota,
  assertSignedByPayer,
  assertTrustedFish,
  capQuotes,
  checkFish,
  checkPayoutCap,
  cosignMigrateMessage,
  cosignMintMessage,
  isLegacyEra,
  isSmallOrderKey,
  migrationProblem,
  mintLimitError,
  paidInWindow,
  parseCosignMigrate,
  parseCosignMint,
  parseRegistry,
  pluginProblem,
} from './fish-trust.mjs';
import {
  DAILY_PEARL_CAP,
  HttpError,
  MIGRATE_BATCH,
  MIGRATIONS_PER_HOUR,
  MINTS_PER_HOUR,
  MINT_WINDOW_MS,
  MPL_CORE_PROGRAM,
  PAYOUT_WINDOW_MS,
  SoldLedger,
  maxPearls,
} from './market-rules.mjs';
import { createSaleDesk, quoteMany } from './market-sale.mjs';
import { RedisRegistry, createMemoryKv, createRedisKv } from './market-store.mjs';
import { createFakeRedis } from './test/fake-redis.mjs';
import * as core from '@metaplex-foundation/mpl-core';
import { string } from '@metaplex-foundation/umi/serializers';

// The market's trust gate: forged fish (no collection, the wrong one, tampered attributes, extra
// plugins) never get a price, single or batch; collection fish the generator agrees with sell; the
// co-signed mint and the legacy migration validate like the generator; the limits hold.

const SELLER = 'Se11er111111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const SESSION = 'Sess1on1111111111111111111111111111111111';
const COLLECTION = 'Co11ection111111111111111111111111111111111';
const OTHER_COLLECTION = 'Gear111111111111111111111111111111111111111';
const ASSET = 'Asset11111111111111111111111111111111111111';
const fishKey = (n) => `Fish${String(n).replace(/0/g, 'z')}`.padEnd(43, '1');
const TX = '5'.repeat(88);

/** The first seed from `from` whose fish rolled at `depth` is `rarity` (deterministic); `ok` filters further. */
function seedFor(rarity, depth, from = 1, gen = GENERATOR_V2, ok = () => true) {
  for (let s = from; s < from + 2_000_000; s++) if (gen.rarityAt(s, depth) === rarity && ok(s)) return s;
  throw new Error(`no ${rarity} seed at ${depth} m`);
}

/** A fish as the game banks it: rolled at spawn depth `spawn`, recorded where caught. */
function caught(seed, spawn, catchDepth = Math.round(spawn), gen = GENERATOR_V2) {
  const f = gen.rollFish(seed, spawn);
  return { ...f, depthM: catchDepth };
}

const attributesOf = (f) => [
  { key: 'rarity', value: f.rarity },
  { key: 'species', value: f.species },
  { key: 'depth', value: String(f.depthM) },
  { key: 'value', value: String(f.value) },
  { key: 'seed', value: f.id },
];

/** A Core asset as fetchAsset returns it (mpl-core 1.10: an asset with plugins also has pluginHeader). */
function asset({ attributeList, ua = { type: 'Collection', address: COLLECTION }, owner = SELLER, attrAuthority = 'UpdateAuthority', extra = {} }) {
  return {
    publicKey: ASSET,
    header: {},
    pluginHeader: { key: 3, pluginRegistryOffset: 339n },
    key: 1,
    owner,
    updateAuthority: ua,
    name: 'x',
    uri: 'y',
    seq: { __option: 'None' },
    attributes: { authority: { type: attrAuthority }, attributeList, offset: 0n },
    ...extra,
  };
}

/** Is a (seed, rarity) a different species in v1 and v2? */
const renamed = (rarity) => (x) => GENERATOR_V1.fishOf(x, rarity).species !== GENERATOR_V2.fishOf(x, rarity).species;

/** Attributes of the game's gear NFTs (game/src/gear-nft.ts gearAttributes). */
const GEAR_KIT = [
  { key: 'kind', value: 'kit' },
  { key: 'schema', value: '1' },
  ...['rod', 'reel', 'net', 'fins', 'tank', 'lamp', 'sonar'].map((key) => ({ key, value: '2' })),
  ...['rod', 'net', 'fins', 'tank', 'lamp', 'reel'].map((s) => ({ key: `${s}Branch`, value: 'a' })),
];
const GEAR_BOAT = [{ key: 'kind', value: 'boat' }, { key: 'schema', value: '1' }, { key: 'ship', value: '3' }, { key: 'shipName', value: 'Echo Scout' }, ...['bait', 'boat', 'boatSpeed', 'boatHull', 'boatDeck'].map((key) => ({ key, value: '1' }))];

const facts = (f) => ({ id: f.id, rarity: f.rarity, species: f.species, depth: f.depthM, value: f.value });

// ---- The generator check ----------------------------------------------------------------------

test('honest catches pass the strict check, wherever in its roaming range the fish was caught, from either generator', () => {
  // v3: today's game. v2: fish caught before legendary and mythic were halved. v1: fish caught
  // before the 35-species roster (banked, still to be minted, or already minted): they keep their
  // old species and odds and must stay mintable and sellable.
  assert.deepEqual(GENERATORS, [GENERATOR_V3, GENERATOR_V2, GENERATOR_V1]);
  for (const gen of [GENERATOR_V3, GENERATOR_V2, GENERATOR_V1]) {
    let n = 0;
    for (let s = 1; n < 3000; s += 7919) {
      const spawn = (s % 997) / 1.7; // 0 .. ~586 m, fractional like the game's spawn depths
      for (const drift of [-24, -9, 0, 3, 12, 24]) {
        const f = caught(s, spawn, Math.min(1000, Math.max(0, Math.round(spawn + drift))), gen);
        const r = checkFish(facts(f));
        assert.ok(r.ok, `v${gen.version} seed ${s} rolled at ${spawn.toFixed(2)} m, caught at ${f.depthM} m: ${r.reason}`);
        assert.deepEqual(r.fish, gen.fishOf(s, f.rarity), 'the fish of the generator that made it');
        n++;
      }
    }
  }
});

test('for one seed the rolled rarity never drops with depth, in every generator (rarityInterval bisects on it)', () => {
  const order = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  for (const gen of GENERATORS) {
    for (let s = 1; s < 3_000_000_000; s += 7_654_321) {
      let prev = 0;
      for (let d = 0; d <= 400; d += 0.5) {
        const r = order.indexOf(gen.rarityAt(s, d));
        assert.ok(r >= prev, `v${gen.version} seed ${s} drops at ${d} m`);
        prev = r;
      }
    }
  }
  assert.equal(rarityAt, GENERATOR_V3.rarityAt, 'the default is today\'s generator');
});

test('generator versions are not mixed: a species from one with odds only the other gives is refused', () => {
  // v1 gave legendaries from 30 m down; v2 not above 80 m. A v1 legendary spawned at 50 m and
  // caught at 20 m is fine as v1's species, impossible as v2's.
  const s = seedFor('legendary', 50, 1, GENERATOR_V1, renamed('legendary'));
  const v1 = caught(s, 50, 20, GENERATOR_V1);
  assert.equal(v1.rarity, 'legendary');
  assert.ok(checkFish(facts(v1)).ok, 'the v1 fish itself');
  const v2species = GENERATOR_V2.fishOf(s, 'legendary').species;
  assert.match(checkFish({ ...facts(v1), species: v2species }).reason, /cannot be legendary when caught at 20 m/, 'v2 species with v1 odds');
  assert.match(checkFish({ ...facts(v1), species: v2species }, { legacy: true }).reason, /cannot be legendary/, 'not even in legacy mode');
  // And the other way: a v2 legendary at 130 m whose v1 species v1 could not make legendary there.
  const t = seedFor('legendary', 130, 1, GENERATOR_V2, (x) => GENERATOR_V1.rarityAt(x, 160) !== 'legendary' && GENERATOR_V1.fishOf(x, 'legendary').species !== GENERATOR_V2.fishOf(x, 'legendary').species);
  const v2 = caught(t, 130, 130);
  assert.ok(checkFish(facts(v2)).ok);
  assert.ok(!checkFish({ ...facts(v2), species: GENERATOR_V1.fishOf(t, 'legendary').species }).ok, 'v1 species with v2 odds');
  assert.ok(!checkFish({ ...facts(v2), species: GENERATOR_V1.fishOf(t, 'legendary').species }, { legacy: true }).ok, 'not even in legacy mode');
  // A species neither roster gives this seed names both.
  const other = GENERATOR_V2.SPECIES_BY_RARITY.legendary.map(([n]) => n).find((n) => n !== v2species && n !== v1.species);
  assert.match(checkFish({ ...facts(v1), species: other }).reason, new RegExp(`is not a ${other}: a legendary from this seed is a ${v2species} or ${v1.species}`));
});

test('a forged rarity, catch value, species or seed fails the strict check', () => {
  const s = seedFor('common', 40);
  const f = caught(s, 40.4);
  assert.ok(checkFish(facts(f)).ok);
  const mythic = fishOf(s, 'mythic');
  assert.match(checkFish({ ...facts(f), rarity: 'mythic', species: mythic.species, value: 4800, depth: 1000 }).reason, /cannot be mythic/);
  assert.match(checkFish({ ...facts(f), value: f.value + 1 }).reason, /does not fit/);
  assert.match(checkFish({ ...facts(f), value: 4800 }).reason, /does not fit/);
  assert.match(checkFish({ ...facts(f), species: 'Moonfin Leviathan' }).reason, /is not a Moonfin Leviathan/);
  assert.match(checkFish({ ...facts(f), id: 'e2e0' }).reason, /Bad fish seed/);
  assert.match(checkFish({ ...facts(f), depth: 1001 }).reason, /Bad depth/);
  assert.match(checkFish({ ...facts(f), value: undefined }).reason, /missing/);
  // The same seed caught far from where it can be that rarity.
  const deep = seedFor('legendary', 300);
  const lf = caught(deep, 300);
  assert.ok(!checkFish({ ...facts(lf), depth: 5 }).ok, 'a legendary recorded at 5 m');
});

test('legacy: fish rolled with the first day\'s zone odds, or with no / plain value, pass only in legacy mode', () => {
  // A seed that the old Abyss table makes mythic but neither depth table can near 45 m. The zone
  // odds were rolled with the v1 roster, so the fish is v1's.
  const abyss = LEGACY_ZONES[2];
  assert.equal(GENERATOR_V1.legacyZones, LEGACY_ZONES);
  assert.deepEqual(GENERATOR_V2.legacyZones, []);
  let s = 1;
  while (!(new Rng(s).weighted(abyss.odds) === 'mythic' && GENERATOR_V1.rarityAt(s, 75) !== 'mythic' && GENERATOR_V2.rarityAt(s, 75) !== 'mythic')) s++;
  const f = { ...GENERATOR_V1.fishOf(s, 'mythic'), depthM: 45, value: Math.round(800 * abyss.rewardMultiplier) };
  assert.ok(!checkFish(facts(f)).ok, 'strict: no depth table can make it');
  assert.ok(checkFish(facts(f), { legacy: true }).ok, 'legacy: the old zone table made it');
  if (GENERATOR_V2.fishOf(s, 'mythic').species !== f.species) {
    const v2 = { ...f, species: GENERATOR_V2.fishOf(s, 'mythic').species };
    assert.ok(!checkFish(facts(v2), { legacy: true }).ok, 'the zone odds never rolled a v2 species');
  }
  assert.ok(checkFish({ ...facts(f), value: undefined }, { legacy: true }).ok, 'no value attribute (first mints)');
  assert.ok(!checkFish({ ...facts(f), value: 4800 }, { legacy: true }).ok, 'but not a made-up value');
  assert.ok(!checkFish({ ...facts(f), depth: 200 }, { legacy: true }).ok, 'and not far from the old zone');
  const c = caught(seedFor('rare', 30), 30);
  assert.ok(checkFish({ ...facts(c), value: 10 }, { legacy: true }).ok, 'plain rarity value (fishValue fallback)');
});

// ---- The asset gate ---------------------------------------------------------------------------

const goodFish = caught(seedFor('rare', 70), 70.6, 72);

test('assertTrustedFish: a collection fish the generator agrees with gets its on-chain value', () => {
  assert.equal(assertTrustedFish(asset({ attributeList: attributesOf(goodFish) }), { collection: COLLECTION }), goodFish.value);
});

/** A fish co-minted before the 35-species roster: a legendary at 50 m (v2 has none above 80 m), with a v1-only species. */
const oldFish = caught(seedFor('legendary', 48.2, 1, GENERATOR_V1, renamed('legendary')), 48.2, 50, GENERATOR_V1);

test('fish from the generator before the 35-species roster stay sellable at their on-chain value', () => {
  assert.ok(!checkFish({ ...facts(oldFish), species: GENERATOR_V2.fishOf(oldFish.seed, 'legendary').species }).ok, 'today\'s generator alone would refuse it');
  assert.equal(assertTrustedFish(asset({ attributeList: attributesOf(oldFish) }), { collection: COLLECTION }), oldFish.value);
  assert.equal(checkFish(facts(oldFish)).version, 1);
  // A rare at 70 m: v2 and v3 have the same roster and the same odds above 80 m, so the newest wins.
  assert.equal(checkFish(facts(goodFish)).version, 3);
});

test('assertTrustedFish refuses forged fish: no collection, the wrong collection, tampered attributes, plugins', () => {
  const forged = [
    { rarity: 'mythic', species: 'Moonfin Leviathan', depthM: 1000, value: 4800, id: goodFish.id },
    { ...goodFish, value: goodFish.value * 10 },
  ];
  const cases = [
    [asset({ attributeList: attributesOf(goodFish), ua: { type: 'Address', address: SESSION } }), /not in the Breathless Fish collection yet/],
    [asset({ attributeList: attributesOf(goodFish), ua: { type: 'None' } }), /Not a Breathless fish/],
    [asset({ attributeList: attributesOf(goodFish), ua: { type: 'Collection', address: OTHER_COLLECTION } }), /Not a Breathless fish/],
    [asset({ attributeList: attributesOf(forged[0]) }), /cannot be mythic/],
    [asset({ attributeList: attributesOf(forged[1]) }), /does not fit/],
    [asset({ attributeList: attributesOf(goodFish), attrAuthority: 'Address' }), /Attributes are controlled by Address/],
    [asset({ attributeList: attributesOf(goodFish), extra: { updateDelegate: { authority: { type: 'Address' } } } }), /updateDelegate/],
    [asset({ attributeList: attributesOf(goodFish), extra: { oracles: [{}] } }), /oracles/],
  ];
  for (const [a, why] of cases) {
    assert.throws(() => assertTrustedFish(a, { collection: COLLECTION }), (e) => e instanceof HttpError && e.status === 422 && why.test(e.message));
  }
  assert.throws(() => assertTrustedFish(asset({ attributeList: attributesOf(goodFish) }), { collection: null }), (e) => e.status === 503);
  // The game's Boat / Dive Kit NFTs: same session key, no collection, no fish attributes.
  for (const gear of [GEAR_KIT, GEAR_BOAT]) {
    assert.throws(
      () => assertTrustedFish(asset({ attributeList: gear, ua: { type: 'Address', address: SESSION } }), { collection: COLLECTION }),
      (e) => e.status === 422 && e.extra?.code === 'not-a-fish' && /Not a Breathless fish/.test(e.message),
    );
  }
  assert.equal(pluginProblem(asset({ attributeList: [], extra: { oracles: [], lifecycleHooks: [] } })), null, 'empty adapter lists are fine');
});

/** A fake server-mode sale desk using the real gate (as fish-collection.mjs's price()). */
function deskWith(assets, { cap } = {}) {
  const ledger = new SoldLedger();
  const payments = [];
  const returned = [];
  const transfer = {
    message: {
      header: { numRequiredSignatures: 1 },
      accounts: [SELLER, MARKET, MPL_CORE_PROGRAM, ...Object.keys(assets)],
      instructions: Object.keys(assets).map((id, i) => ({ programIndex: 2, accountIndexes: [3 + i, 2, 0, 2, 1, 2, 2], data: Uint8Array.of(14, 0) })),
    },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
  };
  const price = (a, seller) => {
    const pearls = assertTrustedFish(a, { collection: COLLECTION });
    checkPayoutCap(ledger.records, seller, pearls, cap ? { cap } : {});
    return pearls;
  };
  const desk = createSaleDesk({
    priceFish: price,
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: async () => transfer,
    loadMarketAsset: async (id) => ({ ...assets[id], owner: MARKET }),
    resolvePending: async (id) => (ledger.get(id).payTx ? 'paid' : 'unpaid'),
    pay: async (id, mint, seller, pearls) => {
      ledger.payPending(id, `pay-${id}`, 100);
      payments.push({ id, pearls });
      ledger.paid(id);
    },
    burnSold: async (id) => ledger.burned(id, `burn-${id}`),
    // A fish over the cap goes back at once (market-refund.test.mjs covers the chain side).
    refund: async (id, transferTx) => {
      returned.push(id);
      ledger.refundPending(id, transferTx, `back-${id}`, 100);
      ledger.refunded(id, transferTx);
      return `back-${id}`;
    },
    resolveRefund: async (id) => (ledger.get(id)?.status === 'refunded' ? 'refunded' : 'unrefunded'),
  });
  const quote = async ({ assetId, seller }) => ({ pearls: price(assets[assetId], seller) });
  return { desk, ledger, payments, returned, quote };
}

test('forged fish are refused and valid collection fish sell, single and batch (quote, sell, sell-batch)', async () => {
  const [V, NOCOLL, WRONG, TAMPER] = [1, 2, 3, 4].map(fishKey);
  const forgedMythic = attributesOf({ rarity: 'mythic', species: 'Moonfin Leviathan', depthM: 1000, value: 4800, id: '0000beef' });
  const assets = {
    [V]: asset({ attributeList: attributesOf(goodFish) }),
    [NOCOLL]: asset({ attributeList: forgedMythic, ua: { type: 'Address', address: SELLER } }),
    [WRONG]: asset({ attributeList: attributesOf(goodFish), ua: { type: 'Collection', address: OTHER_COLLECTION } }),
    [TAMPER]: asset({ attributeList: forgedMythic }),
  };
  const m = deskWith(assets);

  const { quotes } = await quoteMany({ seller: SELLER, assetIds: [V, NOCOLL, WRONG, TAMPER] }, m.quote);
  assert.deepEqual(quotes.map((q) => q.pearls ?? q.status), [goodFish.value, 422, 422, 422]);

  for (const id of [NOCOLL, WRONG, TAMPER]) {
    await assert.rejects(m.desk.sell({ assetId: id, seller: SELLER, transferTx: TX }), (e) => e.status === 422);
  }
  const { results } = await m.desk.sellBatch({ seller: SELLER, sales: [V, NOCOLL, WRONG, TAMPER].map((assetId) => ({ assetId, transferTx: TX })) });
  assert.deepEqual(results.map((r) => r.pearls ?? r.status), [goodFish.value, 422, 422, 422]);
  assert.deepEqual(m.payments, [{ id: V, pearls: goodFish.value }], 'only the valid fish was paid');
  assert.equal(Object.keys(m.ledger.records).length, 1, 'refused fish never enter the ledger');
});

// ---- Co-signed mint ------------------------------------------------------------------------------

const ORIGIN = 'https://breathless.gotclass.xyz';
/** The body the game sends (game/src/fish-cosign.ts), with the URI game/src/nft-uri.ts builds. */
function mintBody(f, { serial = 42, over = {}, fishOver = {} } = {}) {
  const look = fishLook(f);
  const stats = [f.depthM, f.value, f.lengthCm, String(+f.weightKg.toFixed(2))].join('-');
  const name = serial ? `${f.name} #${String(serial).padStart(4, '0')}` : f.name;
  const uri = `${ORIGIN}/api/nft/meta/${serial ? `v2/${serial}/` : 'v1/'}${f.id}/${f.rarity}/${stats}/${look}/${encodeURIComponent('The Abyss')}/${encodeURIComponent(f.name)}.json`;
  return {
    owner: SELLER,
    payer: SESSION,
    asset: ASSET,
    name,
    uri,
    fish: { id: f.id, rarity: f.rarity, species: f.species, depth: f.depthM, value: f.value, ...fishOver },
    ...over,
  };
}

test('cosign-mint accepts the game\'s own request and writes exactly the validated attributes', () => {
  const m = parseCosignMint(mintBody(goodFish), { market: MARKET });
  assert.equal(m.fishId, goodFish.id);
  assert.equal(m.value, goodFish.value, 'the validated value record_catch adds');
  assert.deepEqual(m.attributeList, attributesOf(goodFish));
  assert.ok(parseCosignMint(mintBody(goodFish, { serial: 0 }), { market: MARKET }), 'a fish without a number (v1 URI)');
});

test('cosign-mint accepts a fish banked before the 35-species roster, with its old name, look and size', () => {
  const m = parseCosignMint(mintBody(oldFish), { market: MARKET });
  assert.deepEqual(m.attributeList, attributesOf(oldFish));
  // Its v2 twin (same seed and rarity, today's species) is a different fish: its URI does not fit.
  const twin = GENERATOR_V2.fishOf(oldFish.seed, 'legendary');
  const mixed = mintBody(oldFish, { fishOver: { species: twin.species } });
  assert.throws(() => parseCosignMint(mixed, { market: MARKET }), (e) => e.status === 422);
  assert.throws(() => parseCosignMint(mintBody({ ...oldFish, name: twin.name }), { market: MARKET }), (e) => e.status === 422 && /NFT name/.test(e.message));
});

test('cosign-mint rejects inconsistent params', () => {
  const bad = (body, status, re) =>
    assert.throws(() => parseCosignMint(body, { market: MARKET }), (e) => e instanceof HttpError && e.status === status && re.test(e.message));
  const mythic = fishOf(goodFish.seed, 'mythic');
  bad(mintBody(goodFish, { fishOver: { rarity: 'mythic', species: mythic.species, value: 4800 } }), 422, /cannot be mythic/);
  bad(mintBody(goodFish, { fishOver: { value: 4800 } }), 422, /does not fit/);
  const grown = GENERATORS.map((g) => g.fishOf(goodFish.seed, 'rare').species);
  const notGrown = GENERATOR_V2.SPECIES_BY_RARITY.rare.map(([n]) => n).find((n) => !grown.includes(n));
  bad(mintBody(goodFish, { fishOver: { species: notGrown } }), 422, /is not a/);
  bad(mintBody(goodFish, { fishOver: { id: 'zz' } }), 422, /Bad fish seed/);
  bad(mintBody(goodFish, { fishOver: { value: undefined } }), 422, /Bad catch value/);
  bad(mintBody(goodFish, { over: { name: 'Prismatic Moonfin Leviathan #0042' } }), 422, /NFT name/);
  bad(mintBody(goodFish, { over: { name: `${goodFish.name} #42` } }), 422, /NFT name/);
  bad(mintBody({ ...goodFish, value: goodFish.value }, { over: { uri: mintBody({ ...goodFish, lengthCm: goodFish.lengthCm + 1 }).uri } }), 422, /lengthCm/);
  bad(mintBody(goodFish, { over: { uri: mintBody({ ...goodFish, hue: goodFish.hue + 40 }).uri } }), 422, /lookPath/);
  bad(mintBody(goodFish, { over: { uri: `${ORIGIN}/api/nft/meta/v1/whatever.json` } }), 422, /path/);
  bad(mintBody(goodFish, { over: { uri: 'javascript:alert(1)' } }), 400, /uri/);
  bad(mintBody(goodFish, { over: { payer: MARKET } }), 400, /market wallet/);
  bad(mintBody(goodFish, { over: { owner: MARKET } }), 400, /market wallet/);
  bad(mintBody(goodFish, { over: { asset: SESSION } }), 400, /different/);
  bad(mintBody(goodFish, { over: { owner: 'nope' } }), 400, /owner/);
});

// ---- Legacy migration -----------------------------------------------------------------------------

test('migration validates the legacy fish like a new mint, and only the session key that minted it can move it', () => {
  const legacy = (attributeList, o = {}) => asset({ attributeList, ua: { type: 'Address', address: SESSION }, ...o });
  const opts = { owner: SELLER, payer: SESSION, collection: COLLECTION };
  assert.equal(migrationProblem(legacy(attributesOf(goodFish)), opts), null, 'a v2 fish minted by the game before the collection existed');
  assert.equal(migrationProblem(legacy(attributesOf(oldFish)), opts), null, 'a v1 fish');
  const forged = attributesOf({ ...goodFish, rarity: 'mythic', species: fishOf(goodFish.seed, 'mythic').species, value: 4800, depthM: 1000 });
  assert.match(migrationProblem(legacy(forged), opts), /do not match the game: .*cannot be mythic/);
  assert.match(migrationProblem(legacy(attributesOf({ ...goodFish, value: 999 })), opts), /does not fit/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { ua: { type: 'Address', address: 'An0therDevice1111111111111111111111111111' } }), opts), /another device/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { owner: 'Stranger11111111111111111111111111111111111' }), opts), /another wallet/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { attrAuthority: 'Address' }), opts), /Attributes are controlled/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { extra: { updateDelegate: {} } }), opts), /updateDelegate/);
  assert.match(migrationProblem(asset({ attributeList: attributesOf(goodFish) }), opts), /Already/);
  assert.match(migrationProblem(null, opts), /not found/);
  assert.match(migrationProblem(legacy(GEAR_KIT), opts), /Not a Breathless fish/, 'a Dive Kit NFT is never migrated');
  // Created before the collection (or within the grace) only.
  assert.ok(isLegacyEra(100, 1000, 0));
  assert.ok(isLegacyEra(1500, 1000, 9000));
  assert.ok(!isLegacyEra(1000, 1000, 0));
  assert.ok(isLegacyEra(null, 1000, 0), 'no history left: old');
});

test('cosign-migrate body: bounded, de-duplicated, never paid by the market', () => {
  const ids = Array.from({ length: MIGRATE_BATCH + 1 }, (_, i) => fishKey(i + 1));
  assert.deepEqual(parseCosignMigrate({ owner: SELLER, payer: SESSION, assetIds: ids.slice(0, 2) }, { market: MARKET }).assetIds, ids.slice(0, 2));
  for (const body of [
    { owner: SELLER, payer: MARKET, assetIds: ids.slice(0, 1) },
    { owner: SELLER, payer: SESSION, assetIds: ids },
    { owner: SELLER, payer: SESSION, assetIds: [ids[0], ids[0]] },
    { owner: SELLER, payer: SESSION, assetIds: [] },
  ]) {
    assert.throws(() => parseCosignMigrate(body, { market: MARKET }), (e) => e.status === 400);
  }
});

// ---- Limits ---------------------------------------------------------------------------------------

test('the mint quota counts per key (the game wallet) per hour and says when it opens again', () => {
  const q = new Quota({ limit: 3, windowMs: 60_000 });
  const t = 1_000_000;
  assert.ok(q.take('a', 1, t).ok && q.take('a', 2, t + 1).ok);
  const no = q.take('a', 1, t + 10_000);
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterMs, 50_000);
  assert.ok(q.take('b', 1, t + 10_000).ok, 'another key has its own quota');
  assert.ok(q.take('a', 1, t + 60_000).ok, 'a new window');
  const e = mintLimitError('Mint', 3, 50_000, t);
  assert.equal(e.status, 429);
  assert.deepEqual(e.extra, { code: 'mint-limit', retryAfterMs: 50_000 });
  assert.match(e.message, /at most 3 per game wallet per hour/);
  assert.ok(MINTS_PER_HOUR >= 120, 'normal play never mints anywhere near this');
});

// On Vercel every instance (and every cold start) built its own in-memory Quota, so the bound on
// forged top-value mints (checkFish) was per instance. KvQuota keeps the count in the store's KV.

/** Two "instances" sharing one fake Redis (as Vercel's share Upstash), on one clock. */
function sharedKv(prefix = 'live:') {
  const t = { now: 1_000_000 };
  const redis = createFakeRedis({ now: () => t.now });
  return { t, redis, kv: () => createRedisKv(redis, prefix) };
}

for (const [name, makeKv] of [
  ['Redis KV', () => sharedKv().kv()],
  ['memory KV', () => createMemoryKv()],
]) {
  test(`KvQuota (${name}) answers exactly as Quota: per key, all or nothing, retryAfterMs, a new window`, async () => {
    const q = new KvQuota({ kv: makeKv(), name: 'mint', limit: 3, windowMs: 60_000 });
    const t = 1_000_000;
    assert.ok((await q.take('a', 1, t)).ok && (await q.take('a', 2, t + 1)).ok);
    const no = await q.take('a', 1, t + 10_000);
    assert.equal(no.ok, false);
    assert.equal(no.retryAfterMs, 50_000);
    assert.equal((await q.take('a', 1, t + 59_500)).retryAfterMs, 1000, 'never less than a second, as Quota');
    assert.ok((await q.take('b', 1, t + 10_000)).ok, 'another key has its own quota');
    assert.ok((await q.take('a', 1, t + 60_000)).ok, 'a new window');
    assert.ok((await q.take('a', 2, t + 60_001)).ok, 'the refused takes charged nothing');
    assert.equal((await q.take('a', 1, t + 60_002)).ok, false);
  });
}

test('KvQuota: two instances sharing one Redis take from one count (a Quota each would not)', async () => {
  const { t, kv } = sharedKv();
  const a = new KvQuota({ kv: kv(), name: 'mint', limit: 3, windowMs: 60_000 });
  const b = new KvQuota({ kv: kv(), name: 'mint', limit: 3, windowMs: 60_000 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).take('owner', 1, t.now)));
  assert.equal(results.filter((r) => r.ok).length, 3, 'ten concurrent takes over two instances: exactly the limit passes');
  t.now += 10_000;
  assert.deepEqual(await b.take('owner', 1, t.now), { ok: false, retryAfterMs: 50_000 });
  // The in-memory Quota, one per instance, is the bug this replaces: each instance its own full limit.
  const [m1, m2] = [new Quota({ limit: 3, windowMs: 60_000 }), new Quota({ limit: 3, windowMs: 60_000 })];
  for (let i = 0; i < 3; i++) assert.ok(m1.take('owner', 1, t.now).ok);
  assert.ok(m2.take('owner', 1, t.now).ok, 'per instance');
});

test('KvQuota: every record has a TTL of what is left of its window, and an expired one starts afresh', async () => {
  const { t, redis, kv } = sharedKv();
  const q = new KvQuota({ kv: kv(), name: 'mint', limit: 2, windowMs: 60_000 });
  const start = t.now;
  assert.ok((await q.take('owner', 1, t.now)).ok);
  const key = 'live:kv:quota:mint:owner';
  assert.equal(redis.data.get(key).expiresAt, start + 60_000);
  t.now += 30_000;
  assert.ok((await q.take('owner', 1, t.now)).ok);
  assert.equal(redis.data.get(key).expiresAt, start + 60_000, 'a later take keeps the window\'s end, never extends it');
  assert.equal((await q.take('owner', 1, t.now)).retryAfterMs, 30_000);
  // n > limit: refused, but the window opens (as Quota), with a TTL too.
  const big = new KvQuota({ kv: kv(), name: 'migrate', limit: 2, windowMs: 60_000 });
  assert.deepEqual(await big.take('owner', 5, t.now), { ok: false, retryAfterMs: 60_000 });
  assert.equal(redis.data.get('live:kv:quota:migrate:owner').expiresAt, t.now + 60_000);
  for (const [k, e] of redis.data) assert.ok(Number.isFinite(e.expiresAt), `${k} has a TTL`);
  t.now = start + 60_000; // Redis drops the record exactly at the window's end
  assert.equal(await kv().get('quota:mint:owner'), null);
  assert.ok((await q.take('owner', 2, t.now)).ok, 'a new window, the full limit');
});

test('KvQuota fails closed: a store error refuses the take instead of skipping the limit', async () => {
  const broken = { get: async () => Promise.reject(new Error('fetch failed')), cas: async () => true };
  const q = new KvQuota({ kv: broken, name: 'mint', limit: 3, windowMs: 60_000 });
  await assert.rejects(q.take('owner'), /fetch failed/);
});

/** Bytes of a bare Core CollectionV1 account (no plugins), enough for fetchCollection. */
function collectionAccount(address) {
  const str = (s) => {
    const b = Buffer.from(s);
    const n = Buffer.alloc(4);
    n.writeUInt32LE(b.length);
    return [n, b];
  };
  const data = Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 1), ...str('Breathless Fish'), ...str(''), Buffer.alloc(8)]);
  return { exists: true, publicKey: address, owner: publicKey(MPL_CORE_PROGRAM), lamports: { basisPoints: 1n }, data: new Uint8Array(data), executable: false };
}

const PAST_QUOTA = new Error('past the quota (the test stops before building the transaction)');

/**
 * A fish collection as one instance builds it; the blockhash fetch (after the quota) throws
 * PAST_QUOTA. `assets`: Core asset accounts by address (any other address reads as the
 * collection); `calls.rpc` counts every RPC.
 */
function mintingInstance({ quotaKv, registry = new FishRegistry(), t, mintsPerHour = 3, migrationsPerHour = MIGRATIONS_PER_HOUR, assets = {}, calls = { rpc: 0 } }) {
  const u = {
    identity: { publicKey: { toString: () => MARKET } },
    rpc: {
      getAccount: async (address) => {
        calls.rpc++;
        return assets[String(address)] ?? collectionAccount(address);
      },
      call: async (method) => {
        calls.rpc++;
        if (method === 'getSignaturesForAddress') return []; // no history left: an old fish
        throw new Error(`unexpected rpc ${method}`);
      },
      getLatestBlockhash: async () => {
        calls.rpc++;
        throw PAST_QUOTA;
      },
    },
  };
  return createFishCollection({
    u,
    state: { fishCollection: publicKey(new Uint8Array(32).fill(9)).toString() },
    save: async () => {},
    registry,
    ledger: { records: {} },
    balanceSol: async () => 1,
    log: () => {},
    limits: { mintsPerHour, migrationsPerHour },
    quotaKv,
    now: () => t.now,
  });
}

// The game wallet (payer) signs every co-sign request; its quota is the one spent.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** An ed25519 test key from a 32-byte seed: its address and a signer of UTF-8 strings (base64), like the game's session key. */
function testKey(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const address = publicKey(new Uint8Array(Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url'))).toString();
  return { address, sign: (message) => ed25519Sign(null, Buffer.from(message, 'utf8'), priv).toString('base64') };
}
const GAME = testKey(Buffer.alloc(32, 7));
const GAME2 = testKey(Buffer.alloc(32, 8));

/** A /cosign-mint body as the game sends it: payer = `key`, signed by `signer` (default: the payer). */
function signedMint(f, { key = GAME, signer = key, ...opts } = {}) {
  const body = mintBody(f, { ...opts, over: { payer: key.address, ...opts.over } });
  return { ...body, signature: signer.sign(cosignMintMessage(body)) };
}
/** A /cosign-migrate body as the game sends it. */
function signedMigrate(assetIds, { key = GAME, signer = key, owner = SELLER } = {}) {
  const body = { owner, payer: key.address, assetIds };
  return { ...body, signature: signer.sign(cosignMigrateMessage(body)) };
}

const mintRefused = (retryAfterMs) => (e) => e instanceof HttpError && e.status === 429 && e.extra?.code === 'mint-limit' && e.extra.retryAfterMs === retryAfterMs;

test('cosign-mint on Vercel: two instances sharing Redis share the game wallet\'s mint quota, charged before signing', async () => {
  const { t, redis, kv } = sharedKv();
  const registry = () => new RedisRegistry(redis, 'live:');
  const a = mintingInstance({ quotaKv: kv(), registry: registry(), t });
  const b = mintingInstance({ quotaKv: kv(), registry: registry(), t });
  const start = t.now;
  for (const fc of [a, b, a]) await assert.rejects(fc.cosignMint(signedMint(goodFish)), (e) => e === PAST_QUOTA);
  t.now += 10_000;
  await assert.rejects(b.cosignMint(signedMint(goodFish)), mintRefused(MINT_WINDOW_MS - 10_000), 'the other instance sees the same count');
  await assert.rejects(a.cosignMint(signedMint(goodFish)), mintRefused(MINT_WINDOW_MS - 10_000));
  const c = mintingInstance({ quotaKv: kv(), registry: registry(), t }); // a cold start
  await assert.rejects(c.cosignMint(signedMint(goodFish)), mintRefused(MINT_WINDOW_MS - 10_000), 'a cold start does not reset it');
  assert.ok(redis.data.has(`live:kv:quota:mint:${GAME.address}`), 'counted under the game wallet (payer)');
  assert.ok(![...redis.data.keys()].some((k) => k.startsWith('live:kv:quota:') && k.endsWith(SELLER)), 'never under the owner');
  t.now = start + MINT_WINDOW_MS;
  await assert.rejects(b.cosignMint(signedMint(goodFish)), (e) => e === PAST_QUOTA, 'a new window');
});

test('cosign-mint on one process (file store): the in-memory quota, unchanged', async () => {
  const t = { now: 1_000_000 };
  const fc = mintingInstance({ t });
  for (let i = 0; i < 3; i++) await assert.rejects(fc.cosignMint(signedMint(goodFish)), (e) => e === PAST_QUOTA);
  t.now += 10_000;
  await assert.rejects(fc.cosignMint(signedMint(goodFish)), mintRefused(MINT_WINDOW_MS - 10_000));
  t.now += MINT_WINDOW_MS;
  await assert.rejects(fc.cosignMint(signedMint(goodFish)), (e) => e === PAST_QUOTA, 'a new window');
});

// ---- Signed co-sign requests ------------------------------------------------------------------------
// Both quotas are per game wallet (the payer), so only that wallet may spend them: before this, any
// stranger could POST 240 mints naming a victim's owner address and stall their queue for an hour.

const VECTOR = JSON.parse(readFileSync(new URL('./test/fixtures/cosign-request-vector.json', import.meta.url), 'utf8'));
const badSignature = (e) => e instanceof HttpError && e.status === 401 && e.extra?.code === BAD_SIGNATURE_CODE && e.message.includes(VECTOR.staleGamePhrase);

test('the signed request strings and signatures match the vector the game is pinned to (game/tests/fish-cosign.test.mjs)', () => {
  assert.equal(cosignMintMessage(VECTOR.mint.request), VECTOR.mint.message);
  assert.equal(cosignMigrateMessage(VECTOR.migrate.request), VECTOR.migrate.message);
  const key = testKey(Buffer.from(VECTOR.seedHex, 'hex'));
  assert.equal(key.address, VECTOR.payer);
  assert.equal(key.sign(VECTOR.mint.message), VECTOR.mint.signature, 'ed25519 is deterministic');
  assert.equal(key.sign(VECTOR.migrate.message), VECTOR.migrate.signature);
  assertSignedByPayer(VECTOR.mint.message, VECTOR.payer, VECTOR.mint.signature);
  assertSignedByPayer(VECTOR.migrate.message, VECTOR.payer, VECTOR.migrate.signature);

  assert.throws(() => assertSignedByPayer(VECTOR.migrate.message, VECTOR.payer, VECTOR.mint.signature), badSignature, 'a mint signature is no migration signature');
  assert.throws(() => assertSignedByPayer(VECTOR.mint.message, GAME.address, VECTOR.mint.signature), badSignature, 'another payer');
  assert.throws(() => assertSignedByPayer(`${VECTOR.mint.message} `, VECTOR.payer, VECTOR.mint.signature), badSignature, 'one byte more');
  const sig = VECTOR.mint.signature;
  for (const bad of [undefined, null, '', 42, {}, 'A'.repeat(86) + '==', sig.slice(0, 86), `${sig}=`, Buffer.from(sig, 'base64').toString('hex'), Buffer.from(sig, 'base64').toString('base64url')]) {
    assert.throws(() => assertSignedByPayer(VECTOR.mint.message, VECTOR.payer, bad), badSignature, `signature ${JSON.stringify(bad)?.slice(0, 24)}`);
  }
  assert.throws(() => assertSignedByPayer(VECTOR.mint.message, SESSION, sig), badSignature, 'a payer that is no 32-byte key: 401, not 500');
  assert.throws(() => assertSignedByPayer(VECTOR.mint.message, VECTOR.payer, undefined), /no signature/);
});

test('a small-order payer key is refused: its "signature" (R = identity, S = 0) would verify for any message', () => {
  const payer = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM'; // the identity point, 01 00..00
  const sig = `AQ${'A'.repeat(84)}==`;
  assert.equal(Buffer.from(publicKeyBytes(payer)).toString('hex'), `01${'00'.repeat(31)}`);
  // node:crypto's own verdict on this pair depends on the OpenSSL build (Node 26 on macOS accepts it
  // for any message, CI's Node 24 refuses it), so it is not asserted: the blocklist is why our
  // answer is the same everywhere.
  assert.throws(() => assertSignedByPayer(VECTOR.mint.message, payer, sig), badSignature);
  assert.throws(() => assertSignedByPayer('anything at all', payer, sig), badSignature);
  // The whole torsion subgroup (all 8 points of small order), and the encodings with the sign bit
  // set or y >= p, as libsodium refuses them.
  for (const h of [
    `01${'00'.repeat(31)}`,
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    `${'00'.repeat(31)}80`,
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    `ec${'ff'.repeat(30)}7f`,
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    '00'.repeat(32),
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    `ed${'ff'.repeat(30)}7f`,
    `ee${'ff'.repeat(30)}ff`,
    `01${'00'.repeat(30)}80`,
  ]) {
    assert.ok(isSmallOrderKey(Buffer.from(h, 'hex')), h);
  }
  assert.ok(!isSmallOrderKey(publicKeyBytes(VECTOR.payer)), 'a real key is not');
  assert.ok(!isSmallOrderKey(publicKeyBytes(GAME.address)));
});

test('cosign-mint: a URI the URL parser rejects is a 400, not a 500', () => {
  const body = mintBody(goodFish, { over: { uri: 'http://[/api/nft/meta/v2/42/x.json' } });
  assert.throws(() => parseCosignMint(body, { market: MARKET }), (e) => e instanceof HttpError && e.status === 400 && /uri must be/.test(e.message));
});

test('no field of a signed request can spill into the next: | and \\ are escaped, the route is in the string', () => {
  const r = VECTOR.mint.request;
  const m = (name, species) => cosignMintMessage({ ...r, name, fish: { ...r.fish, species } });
  assert.notEqual(m('a|b', 'c'), m('a', 'b|c'));
  assert.notEqual(m('a\\', '|c'), m('a\\|', 'c'));
  assert.notEqual(m('a\\|b', 'c'), m('a\\', 'b|c'));
  assert.ok(VECTOR.mint.message.startsWith('breathless-cosign-mint|'));
  assert.ok(VECTOR.migrate.message.startsWith('breathless-cosign-migrate|'));
  const two = VECTOR.migrate.request;
  assert.notEqual(cosignMigrateMessage(two), cosignMigrateMessage({ ...two, assetIds: [...two.assetIds].reverse() }), 'the order is signed too');
});

/** A registry and a KV that log every read and write. */
function spied() {
  const log = [];
  const registry = new FishRegistry();
  const mem = createMemoryKv();
  const spy = (name, fn) => (...a) => {
    log.push(name);
    return fn(...a);
  };
  return {
    log,
    registry: { get: spy('registry.get', (...a) => registry.get(...a)), set: spy('registry.set', (...a) => registry.set(...a)) },
    kv: { ...mem, get: spy('kv.get', mem.get), cas: spy('kv.cas', mem.cas), set: spy('kv.set', mem.set) },
  };
}

/** Mint requests a stranger could make with the victim's game wallet named as payer. */
function forgedMints() {
  const good = signedMint(goodFish);
  const { signature, ...unsigned } = good;
  const next = mintBody(goodFish, { serial: 43 });
  return [
    ['unsigned (a game tab from before signatures)', unsigned],
    ['signed by another key', signedMint(goodFish, { signer: GAME2 })],
    ['signed by its payer, then the payer swapped', { ...signedMint(goodFish, { key: GAME2 }), payer: GAME.address }],
    ['the asset changed after signing', { ...good, asset: fishKey(9) }],
    ['the name and URI changed after signing (still a valid fish)', { ...good, name: next.name, uri: next.uri }],
    ['the owner changed after signing', { ...good, owner: OWNER_KEY }],
    ['the migration signature for this asset', { ...good, signature: GAME.sign(cosignMigrateMessage({ owner: good.owner, payer: good.payer, assetIds: [good.asset] })) }],
    ['a signature that is not base64', { ...good, signature: 'not a signature' }],
  ];
}

for (const store of ['in-memory Quota', 'KvQuota']) {
  test(`cosign-mint (${store}): a request its game wallet did not sign is a 401, before any RPC, registry or quota`, async () => {
    const t = { now: 1_000_000 };
    const s = spied();
    const calls = { rpc: 0 };
    const fc = mintingInstance({ t, registry: s.registry, quotaKv: store === 'KvQuota' ? s.kv : undefined, calls });
    for (const [what, body] of forgedMints()) {
      for (let i = 0; i < 5; i++) await assert.rejects(fc.cosignMint(body), badSignature, what);
    }
    assert.equal(calls.rpc, 0, 'no RPC: not even the collection');
    assert.deepEqual(s.log, [], 'no registry and no quota read or write');
    // The game wallet's quota is whole: its own signed requests still get all 3.
    for (let i = 0; i < 3; i++) await assert.rejects(fc.cosignMint(signedMint(goodFish)), (e) => e === PAST_QUOTA, 'correctly signed: works as before');
    await assert.rejects(fc.cosignMint(signedMint(goodFish)), mintRefused(MINT_WINDOW_MS));
    assert.ok(calls.rpc > 0 && s.log.includes('registry.get'));
  });

  test(`cosign-mint (${store}): two game wallets naming the same owner have their own quotas`, async () => {
    const t = { now: 1_000_000 };
    const fc = mintingInstance({ t, quotaKv: store === 'KvQuota' ? createMemoryKv() : undefined });
    for (let i = 0; i < 3; i++) await assert.rejects(fc.cosignMint(signedMint(goodFish)), (e) => e === PAST_QUOTA);
    await assert.rejects(fc.cosignMint(signedMint(goodFish)), mintRefused(MINT_WINDOW_MS), 'the first game wallet is done for the hour');
    for (let i = 0; i < 3; i++) await assert.rejects(fc.cosignMint(signedMint(goodFish, { key: GAME2 })), (e) => e === PAST_QUOTA, 'same owner, another game wallet');
    await assert.rejects(fc.cosignMint(signedMint(goodFish, { key: GAME2 })), mintRefused(MINT_WINDOW_MS));
  });
}

// ---- The same for cosign-migrate, with real Core asset accounts (fetchAsset decodes them).

const OWNER_KEY = publicKey(new Uint8Array(32).fill(2)).toString();
const legacyId = (n) => publicKey(new Uint8Array(32).fill(40 + n)).toString();

/** A Core AssetV1 account with only an Attributes plugin: what the session key minted before the collection. */
function legacyAssetAccount(address, { owner = OWNER_KEY, authority, attributeList = attributesOf(goodFish) }) {
  const base = Buffer.concat([
    Buffer.from([core.Key.AssetV1]),
    Buffer.from(publicKeyBytes(owner)),
    Buffer.from(core.getBaseUpdateAuthoritySerializer().serialize({ __kind: 'Address', fields: [publicKey(authority)] })),
    Buffer.from(string().serialize('Fish')),
    Buffer.from(string().serialize('https://breathless.gotclass.xyz/api/nft/meta/v1/x.json')),
    Buffer.from([0]), // seq: None
  ]);
  const plugin = Buffer.from(core.getPluginSerializer().serialize({ __kind: 'Attributes', fields: [{ attributeList }] }));
  const pluginAt = base.length + 9; // after the 9-byte plugin header
  const registryAt = pluginAt + plugin.length;
  const header = Buffer.from(core.getPluginHeaderV1AccountDataSerializer().serialize({ key: core.Key.PluginHeaderV1, pluginRegistryOffset: BigInt(registryAt) }));
  const record = Buffer.from(core.getRegistryRecordSerializer().serialize({ pluginType: core.PluginType.Attributes, authority: { __kind: 'UpdateAuthority' }, offset: BigInt(pluginAt) }));
  const registry = Buffer.concat([Buffer.from([core.Key.PluginRegistryV1, 1, 0, 0, 0]), record, Buffer.from([0, 0, 0, 0])]);
  return {
    exists: true,
    publicKey: publicKey(address),
    owner: publicKey(MPL_CORE_PROGRAM),
    lamports: { basisPoints: 1n },
    executable: false,
    data: new Uint8Array(Buffer.concat([base, header, plugin, registry])),
  };
}

test('cosign-migrate: unsigned, wrongly signed or a mint signature is a 401 before any RPC, registry or quota; signed, each game wallet has its own quota', async () => {
  const t = { now: 1_000_000 };
  const s = spied();
  const calls = { rpc: 0 };
  const assets = {
    [legacyId(1)]: legacyAssetAccount(legacyId(1), { authority: GAME.address }),
    [legacyId(2)]: legacyAssetAccount(legacyId(2), { authority: GAME2.address }),
  };
  const fc = mintingInstance({ t, registry: s.registry, quotaKv: s.kv, calls, assets, migrationsPerHour: 1 });
  const good = signedMigrate([legacyId(1)], { owner: OWNER_KEY });
  const { signature, ...unsigned } = good;
  const mintSig = signedMint(goodFish, { over: { owner: OWNER_KEY, asset: legacyId(1) } }).signature;
  for (const [what, body] of [
    ['unsigned', unsigned],
    ['signed by another key', signedMigrate([legacyId(1)], { owner: OWNER_KEY, signer: GAME2 })],
    ['another fish listed after signing', { ...good, assetIds: [legacyId(2)] }],
    ['another owner after signing', { ...good, owner: SELLER }],
    ['the mint signature of the same wallet', { ...good, signature: mintSig }],
  ]) {
    await assert.rejects(fc.cosignMigrate(body), badSignature, what);
  }
  assert.equal(calls.rpc, 0, 'no RPC');
  assert.deepEqual(s.log, [], 'no registry and no quota read or write');

  // Signed: checked like before, then its game wallet's quota (1 here) is charged.
  await assert.rejects(fc.cosignMigrate(good), (e) => e === PAST_QUOTA, 'correctly signed: works as before');
  assert.ok(s.log.includes('kv.cas'));
  await assert.rejects(fc.cosignMigrate(signedMigrate([legacyId(1)], { owner: OWNER_KEY })), (e) => e instanceof HttpError && e.status === 429 && e.extra?.code === 'mint-limit', 'that wallet is done for the hour');
  await assert.rejects(fc.cosignMigrate(signedMigrate([legacyId(2)], { owner: OWNER_KEY, key: GAME2 })), (e) => e === PAST_QUOTA, 'same owner, another game wallet: its own quota');
});

test('the daily PEARL cap: per seller, rolling 24 h, cumulative over a quote batch, atomic in the sale desk', async () => {
  const now = 10 * PAYOUT_WINDOW_MS;
  const records = {
    a: { seller: SELLER, pearls: 30_000, at: now - PAYOUT_WINDOW_MS + 3_600_000, status: 'burned' },
    b: { seller: SELLER, pearls: 15_000, at: now - 1000, status: 'paying' },
    old: { seller: SELLER, pearls: 40_000, at: now - PAYOUT_WINDOW_MS - 1, status: 'burned' },
    other: { seller: 'Someone', pearls: 50_000, at: now - 1000, status: 'burned' },
  };
  assert.equal(paidInWindow(records, SELLER, now), 45_000);
  checkPayoutCap(records, SELLER, 5_000, { now });
  assert.throws(
    () => checkPayoutCap(records, SELLER, 5_001, { now }),
    (e) => e.status === 429 && e.extra.code === 'daily-cap' && e.extra.retryAfterMs === 3_600_000 && /paid 45,000 of 50,000/.test(e.message),
  );
  assert.ok(DAILY_PEARL_CAP > maxPearls('mythic') * 5, 'a handful of the best possible fish still sell in a day');

  const capped = capQuotes(records, SELLER, { quotes: [{ assetId: 'x', pearls: 3000 }, { assetId: 'y', pearls: 3000 }, { assetId: 'z', status: 422, error: 'no' }, { assetId: 'w', pearls: 2000 }] }, { now });
  assert.deepEqual(capped.quotes.map((q) => q.pearls ?? q.status), [3000, 429, 422, 2000]);
  // The refused quote carries the cap's code and wait, as a single /quote's 429 body does.
  assert.equal(capped.quotes[1].code, 'daily-cap');
  assert.equal(capped.quotes[1].retryAfterMs, 3_600_000);
  assert.equal(capped.quotes[1].assetId, 'y');
  assert.deepEqual(capped.quotes[2], { assetId: 'z', status: 422, error: 'no' });

  // The desk: a batch of fish worth more than the cap pays up to the cap; the market holds the rest
  // already, so it sends them back to the seller (they sell again once the window rolls on).
  const fishes = {};
  for (let i = 1; i <= 6; i++) fishes[fishKey(i)] = asset({ attributeList: attributesOf(goodFish) });
  const m = deskWith(fishes, { cap: goodFish.value * 4 });
  const { results } = await m.desk.sellBatch({ seller: SELLER, sales: Object.keys(fishes).map((assetId) => ({ assetId, transferTx: TX })) });
  assert.equal(results.filter((r) => r.pearls).length, 4);
  assert.deepEqual(results.filter((r) => !r.pearls).map((r) => [r.status, r.code, r.retryAfterMs > 0, r.refunded]), [[429, 'daily-cap', true, true], [429, 'daily-cap', true, true]]);
  assert.equal(m.payments.reduce((s, p) => s + p.pearls, 0), goodFish.value * 4);
  assert.equal(m.returned.length, 2, 'the two over the cap went back');
  // Refunds count toward no cap: the window's total is still exactly the four paid.
  assert.equal(paidInWindow(m.ledger.records, SELLER), goodFish.value * 4);
});

test('the registry keeps one asset per owner and fish, across a restart', () => {
  const lines = [];
  const r = new FishRegistry([], (e) => lines.push(JSON.stringify(e)));
  r.set(SELLER, 'abcd0123', { asset: ASSET, lastValid: 7, kind: 'mint' }, 5);
  r.set(SELLER, 'abcd0123', { asset: fishKey(2), lastValid: 9, kind: 'mint' }, 6);
  const again = new FishRegistry(parseRegistry(`${lines.join('\n')}\n{broken\n`));
  assert.equal(again.get(SELLER, 'abcd0123').asset, fishKey(2));
  assert.equal(again.get('Someone', 'abcd0123'), null);
});

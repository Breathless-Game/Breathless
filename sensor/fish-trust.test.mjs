import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_ZONES, Rng, fishLook, fishOf, rarityAt, rollFish } from './fish-gen.mjs';
import {
  FishRegistry,
  Quota,
  assertTrustedFish,
  capQuotes,
  checkFish,
  checkPayoutCap,
  isLegacyEra,
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
  MINTS_PER_HOUR,
  MPL_CORE_PROGRAM,
  PAYOUT_WINDOW_MS,
  SoldLedger,
  maxPearls,
} from './market-rules.mjs';
import { createSaleDesk, quoteMany } from './market-sale.mjs';

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

/** The first seed from `from` whose fish rolled at `depth` is `rarity` (deterministic). */
function seedFor(rarity, depth, from = 1) {
  for (let s = from; s < from + 2_000_000; s++) if (rarityAt(s, depth) === rarity) return s;
  throw new Error(`no ${rarity} seed at ${depth} m`);
}

/** A fish as the game banks it: rolled at spawn depth `spawn`, recorded where caught. */
function caught(seed, spawn, catchDepth = Math.round(spawn)) {
  const f = rollFish(seed, spawn);
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

const facts = (f) => ({ id: f.id, rarity: f.rarity, species: f.species, depth: f.depthM, value: f.value });

// ---- The generator check ----------------------------------------------------------------------

test('honest catches pass the strict check, wherever in its roaming range the fish was caught', () => {
  let n = 0;
  for (let s = 1; n < 3000; s += 7919) {
    const spawn = (s % 997) / 1.7; // 0 .. ~586 m, fractional like the game's spawn depths
    for (const drift of [-24, -9, 0, 3, 12, 24]) {
      const f = caught(s, spawn, Math.min(1000, Math.max(0, Math.round(spawn + drift))));
      const r = checkFish(facts(f));
      assert.ok(r.ok, `seed ${s} rolled at ${spawn.toFixed(2)} m, caught at ${f.depthM} m: ${r.reason}`);
      n++;
    }
  }
});

test('for one seed the rolled rarity never drops with depth (rarityInterval bisects on it)', () => {
  const order = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  for (let s = 1; s < 3_000_000_000; s += 7_654_321) {
    let prev = 0;
    for (let d = 0; d <= 400; d += 0.5) {
      const r = order.indexOf(rarityAt(s, d));
      assert.ok(r >= prev, `seed ${s} drops at ${d} m`);
      prev = r;
    }
  }
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
  // A seed that the old Abyss table makes mythic but today's odds cannot near 45 m.
  const abyss = LEGACY_ZONES[2];
  let s = 1;
  while (!(new Rng(s).weighted(abyss.odds) === 'mythic' && rarityAt(s, 75) !== 'mythic')) s++;
  const f = { ...fishOf(s, 'mythic'), depthM: 45, value: Math.round(800 * abyss.rewardMultiplier) };
  assert.ok(!checkFish(facts(f)).ok, 'strict: today\'s generator cannot make it');
  assert.ok(checkFish(facts(f), { legacy: true }).ok, 'legacy: the old zone table made it');
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
  assert.equal(pluginProblem(asset({ attributeList: [], extra: { oracles: [], lifecycleHooks: [] } })), null, 'empty adapter lists are fine');
});

/** A fake server-mode sale desk using the real gate (as fish-collection.mjs's price()). */
function deskWith(assets, { cap } = {}) {
  const ledger = new SoldLedger();
  const payments = [];
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
  });
  const quote = async ({ assetId, seller }) => ({ pearls: price(assets[assetId], seller) });
  return { desk, ledger, payments, quote };
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
  assert.deepEqual(m.attributeList, attributesOf(goodFish));
  assert.ok(parseCosignMint(mintBody(goodFish, { serial: 0 }), { market: MARKET }), 'a fish without a number (v1 URI)');
});

test('cosign-mint rejects inconsistent params', () => {
  const bad = (body, status, re) =>
    assert.throws(() => parseCosignMint(body, { market: MARKET }), (e) => e instanceof HttpError && e.status === status && re.test(e.message));
  const mythic = fishOf(goodFish.seed, 'mythic');
  bad(mintBody(goodFish, { fishOver: { rarity: 'mythic', species: mythic.species, value: 4800 } }), 422, /cannot be mythic/);
  bad(mintBody(goodFish, { fishOver: { value: 4800 } }), 422, /does not fit/);
  bad(mintBody(goodFish, { fishOver: { species: 'Azure Tang' === goodFish.species ? 'Neon Cardinal' : 'Azure Tang' } }), 422, /is not a/);
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
  assert.equal(migrationProblem(legacy(attributesOf(goodFish)), opts), null);
  const forged = attributesOf({ ...goodFish, rarity: 'mythic', species: fishOf(goodFish.seed, 'mythic').species, value: 4800, depthM: 1000 });
  assert.match(migrationProblem(legacy(forged), opts), /do not match the game: .*cannot be mythic/);
  assert.match(migrationProblem(legacy(attributesOf({ ...goodFish, value: 999 })), opts), /does not fit/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { ua: { type: 'Address', address: 'An0therDevice1111111111111111111111111111' } }), opts), /another device/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { owner: 'Stranger11111111111111111111111111111111111' }), opts), /another wallet/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { attrAuthority: 'Address' }), opts), /Attributes are controlled/);
  assert.match(migrationProblem(legacy(attributesOf(goodFish), { extra: { updateDelegate: {} } }), opts), /updateDelegate/);
  assert.match(migrationProblem(asset({ attributeList: attributesOf(goodFish) }), opts), /Already/);
  assert.match(migrationProblem(null, opts), /not found/);
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

test('the mint quota counts per owner per hour and says when it opens again', () => {
  const q = new Quota({ limit: 3, windowMs: 60_000 });
  const t = 1_000_000;
  assert.ok(q.take('a', 1, t).ok && q.take('a', 2, t + 1).ok);
  const no = q.take('a', 1, t + 10_000);
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterMs, 50_000);
  assert.ok(q.take('b', 1, t + 10_000).ok, 'another owner has its own quota');
  assert.ok(q.take('a', 1, t + 60_000).ok, 'a new window');
  const e = mintLimitError('Mint', 3, 50_000, t);
  assert.equal(e.status, 429);
  assert.deepEqual(e.extra, { code: 'mint-limit', retryAfterMs: 50_000 });
  assert.match(e.message, /at most 3 per wallet per hour/);
  assert.ok(MINTS_PER_HOUR >= 120, 'normal play never mints anywhere near this');
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

  // The desk: a batch of fish worth more than the cap pays up to the cap, the rest stay unpaid (the
  // client keeps them pending and the sale resumes when the window rolls on).
  const fishes = {};
  for (let i = 1; i <= 6; i++) fishes[fishKey(i)] = asset({ attributeList: attributesOf(goodFish) });
  const m = deskWith(fishes, { cap: goodFish.value * 4 });
  const { results } = await m.desk.sellBatch({ seller: SELLER, sales: Object.keys(fishes).map((assetId) => ({ assetId, transferTx: TX })) });
  assert.equal(results.filter((r) => r.pearls).length, 4);
  assert.deepEqual(results.filter((r) => !r.pearls).map((r) => r.status), [429, 429]);
  assert.equal(m.payments.reduce((s, p) => s + p.pearls, 0), goodFish.value * 4);
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

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { DAILY_PEARL_CAP, HttpError, MPL_CORE_PROGRAM, SoldLedger, appraise } from '../market-rules.mjs';
import { checkPayoutCap } from '../fish-trust.mjs';
import { createPayout } from '../market-payout.mjs';
import { createSaleDesk } from '../market-sale.mjs';
import { createSweep } from '../market-burn.mjs';
import { createSerialHandler } from '../nft-serial.mjs';
import { createFileStore, createMemoryKv, createRedisKv, createRedisStore, createStore, parseSecretKey, redisCredentials, storeKind } from '../market-store.mjs';
import { createFakeRedis } from './fake-redis.mjs';

// The Redis store against an in-memory fake (fake-redis.mjs). The point of the Redis backend is
// that several serverless instances share one ledger, so the sale tests run two or more separate
// stores, ledgers, payouts and sale desks over ONE fake: one desk with concurrent calls would only
// exercise its in-process lock. The question is always: how many times was the seller paid?

const SELLER = 'Se11er111111111111111111111111111111111111';
const OTHER = 'Other1111111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const fishId = (i) => `Fish${'ABCDEFGH'[i]}`.padEnd(43, '1');
const FISH = Array.from({ length: 6 }, (_, i) => fishId(i));
const TX = '5'.repeat(88);
const RARE = { owner: MARKET, attributes: { attributeList: [{ key: 'rarity', value: 'rare' }, { key: 'depth', value: '5' }, { key: 'value', value: '10' }] } };

const plainPrice = (asset) => {
  const a = appraise(asset.attributes?.attributeList);
  if (!a.ok) throw new HttpError(422, a.reason);
  return a.pearls;
};

/** A transfer of `assets` from SELLER to MARKET, in umi's shape (see market-sale.test.mjs). */
function transferTx(assets, seller = SELLER) {
  const accounts = [seller, MARKET, MPL_CORE_PROGRAM, ...assets];
  return {
    message: {
      header: { numRequiredSignatures: 1 },
      accounts,
      instructions: assets.map((_, i) => ({ programIndex: 2, accountIndexes: [3 + i, 2, 0, 2, 1, 2, 2], data: Uint8Array.of(14, 0) })),
    },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const timeout = () => Object.assign(new Error('fetch failed'), { cause: new Error('Connect Timeout Error') });

/** The chain every instance talks to: built and landed PEARL payouts. `sends` scripts each send: ok | timeout-landed. */
function fakeChain(sends = []) {
  const chain = { height: 1000, built: new Map(), landed: new Map(), sends: new Map(), seq: 0 };
  chain.payouts = (assetId) => [...chain.landed.values()].filter((t) => t.assetId === assetId).length;
  chain.sendsFor = (assetId) => chain.sends.get(assetId) ?? 0;
  chain.deps = {
    build: async (assetId) => {
      const sig = `pay${++chain.seq}`;
      chain.built.set(sig, { assetId });
      return { sig, lastValid: chain.height + 150 };
    },
    send: async ({ sig }) => {
      const { assetId } = chain.built.get(sig);
      chain.sends.set(assetId, chain.sendsFor(assetId) + 1);
      await tick();
      chain.landed.set(sig, { assetId });
      if ((sends.shift() ?? 'ok') === 'timeout-landed') throw timeout();
    },
    confirm: async ({ sig }) => {
      await tick();
      if (!chain.landed.has(sig)) throw new Error('block height exceeded');
      return null;
    },
    getSignatureStatus: async (sig) => (chain.landed.has(sig) ? { error: null, commitment: 'finalized' } : null),
    getBlockHeight: async () => chain.height,
  };
  return chain;
}

/** One serverless instance: its own store, ledger, payout and desk, over the shared fake Redis. */
async function instance(redis, chain, { transfer = transferTx(FISH) } = {}) {
  const store = createRedisStore({ redis, prefix: 'test:', env: {} });
  const { ledger } = await store.openMarketState({ cluster: 'devnet' });
  const payout = createPayout({ ledger, ...chain.deps });
  const desk = createSaleDesk({
    priceFish: plainPrice,
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: async () => transfer,
    loadMarketAsset: async () => RARE,
    resolvePending: payout.resolvePending,
    pay: payout.pay,
    burnSold: async (assetId) => {
      await ledger.burned(assetId, `burn-${assetId}`);
    },
  });
  return { store, ledger, payout, desk };
}

/** Every failure is the 409 "already in progress, retry" a client handles; never anything else. */
function onlyRetryable(results) {
  for (const r of results) {
    if (r.status === 'rejected') {
      assert.ok(r.reason instanceof HttpError, String(r.reason?.stack ?? r.reason));
      assert.equal(r.reason.status, 409, r.reason.message);
    }
  }
}

test('concurrent sells of the same fish on several instances pay the seller exactly once', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain();
  const instances = await Promise.all([1, 2, 3].map(() => instance(redis, chain)));
  const sell = (inst, assetId) => inst.desk.sell({ assetId, seller: SELLER, transferTx: TX });
  // Every fish, three times on every instance, all at once.
  const results = await Promise.allSettled(FISH.flatMap((id) => instances.flatMap((inst) => [sell(inst, id), sell(inst, id), sell(inst, id)])));
  onlyRetryable(results);
  for (const id of FISH) {
    assert.equal(chain.sendsFor(id), 1, `${id}: one payout sent`);
    assert.equal(chain.payouts(id), 1, `${id}: paid once`);
  }
  // The retries the 409s asked for: every instance now answers the same stored result.
  for (const id of FISH) {
    const answers = await Promise.all(instances.map((inst) => sell(inst, id)));
    for (const a of answers) assert.deepEqual(a, answers[0]);
    assert.equal(answers[0].pearls, 10);
    assert.equal(answers[0].extra[1], `burn-${id}`);
    assert.equal(chain.payouts(id), 1);
  }
});

test('concurrent /sell-batch requests for the same fish on two instances pay each fish once', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain();
  const [a, b] = await Promise.all([instance(redis, chain), instance(redis, chain)]);
  const body = { seller: SELLER, sales: FISH.map((assetId) => ({ assetId, transferTx: TX })) };
  const [ra, rb] = await Promise.all([a.desk.sellBatch(body), b.desk.sellBatch(body), a.desk.sellBatch(body)]);
  for (const r of [...ra.results, ...rb.results]) if (r.error) assert.equal(r.status, 409, r.error);
  for (const id of FISH) assert.equal(chain.payouts(id), 1, `${id}: paid once`);
  const again = await b.desk.sellBatch(body);
  assert.ok(again.results.every((r) => r.pearls === 10 && !r.error));
  for (const id of FISH) assert.equal(chain.sendsFor(id), 1);
});

test('a payout whose send timed out (but landed) is settled from the chain by another instance, not paid again', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain(['timeout-landed']);
  const [a, b] = await Promise.all([instance(redis, chain), instance(redis, chain)]);
  const sale = { assetId: FISH[0], seller: SELLER, transferTx: TX };
  await assert.rejects(a.desk.sell(sale), /fetch failed/);
  const r = await b.desk.sell(sale);
  assert.equal(r.pearls, 10);
  assert.equal(chain.sendsFor(FISH[0]), 1);
  assert.equal(chain.payouts(FISH[0]), 1);
  assert.equal((await b.ledger.get(FISH[0])).status, 'burned');
});

test('payPending: the loser of the race sends nothing; a stale "unpaid" can never pay a second time', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain();
  const [a, b] = await Promise.all([instance(redis, chain), instance(redis, chain)]);
  assert.equal(await a.ledger.begin(FISH[0], { seller: SELLER, transferTx: TX, pearls: 10 }), true);
  assert.equal(await b.ledger.begin(FISH[0], { seller: SELLER, transferTx: TX, pearls: 10 }), false, 'SET NX: one record per fish');

  // B looked first and saw no payout in flight...
  assert.equal(await b.payout.resolvePending(FISH[0]), 'unpaid');
  // ...then A paid in full...
  await a.payout.pay(FISH[0], 'PearlMint', SELLER, 10);
  assert.equal((await a.ledger.get(FISH[0])).status, 'paid');
  // ...so B's payout is refused before it is sent.
  await assert.rejects(b.payout.pay(FISH[0], 'PearlMint', SELLER, 10), (e) => e instanceof HttpError && e.status === 409);
  assert.equal(chain.sendsFor(FISH[0]), 1);
  assert.equal(chain.payouts(FISH[0]), 1);

  // The same signature again (a retry of our own write) is fine; another one is not.
  await b.ledger.begin(FISH[1], { seller: SELLER, transferTx: TX, pearls: 10 });
  await b.ledger.payPending(FISH[1], 'sigX', 1150);
  await b.ledger.payPending(FISH[1], 'sigX', 1150);
  await assert.rejects(a.ledger.payPending(FISH[1], 'sigY', 1150), (e) => e.status === 409);
});

test('payDropped forgets only the signature it names', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain();
  const { ledger } = await instance(redis, chain);
  await ledger.begin(FISH[0], { seller: SELLER, transferTx: TX, pearls: 10 });
  await ledger.payPending(FISH[0], 'sig1', 1150);
  await ledger.payDropped(FISH[0], 'sig0'); // a stale drop of an older payout
  assert.equal((await ledger.get(FISH[0])).payTx, 'sig1');
  await ledger.payDropped(FISH[0], 'sig1');
  const r = await ledger.get(FISH[0]);
  assert.equal(r.payTx, undefined);
  assert.equal(r.status, 'paying');
  await ledger.payPending(FISH[0], 'sig2', 1300); // can be paid again now
  assert.equal((await ledger.get(FISH[0])).payTx, 'sig2');
});

test('the Redis ledger keeps SoldLedger\'s record shape at every step', async () => {
  const fileLedger = new SoldLedger();
  const { ledger } = await instance(createFakeRedis(), fakeChain());
  const both = async (fn) => {
    await fn(fileLedger);
    await fn(ledger);
    assert.deepEqual(await ledger.get(FISH[0]), fileLedger.get(FISH[0]));
    assert.equal(await ledger.plan(FISH[0], SELLER), fileLedger.plan(FISH[0], SELLER));
    assert.equal(await ledger.plan(FISH[0], OTHER), 'conflict');
  };
  assert.equal(await ledger.plan(FISH[0], SELLER), 'new');
  await both((l) => l.begin(FISH[0], { seller: SELLER, transferTx: TX, pearls: 35 }, 1_000));
  await both((l) => l.payPending(FISH[0], 'sigA', 1150));
  await both((l) => l.payDropped(FISH[0], 'sigA'));
  await both((l) => l.payPending(FISH[0], 'sigB', 1160));
  await both((l) => l.paid(FISH[0]));
  await both((l) => l.paid(FISH[0])); // twice: no change
  await both((l) => l.burned(FISH[0], 'burnSig'));
  assert.deepEqual(await ledger.result(FISH[0]), fileLedger.result(FISH[0]));
  assert.deepEqual(await ledger.result(FISH[0]), { pearls: 35, tx: 'sigB', extra: [TX, 'burnSig'] });
});

test('the daily cap reads the seller\'s last 24 h from Redis (loadSeller), not other sellers\' sales', async () => {
  const redis = createFakeRedis();
  const now = Date.now();
  const { ledger } = await instance(redis, fakeChain());
  await ledger.begin(FISH[0], { seller: SELLER, transferTx: TX, pearls: DAILY_PEARL_CAP - 5 }, now - 60_000);
  await ledger.begin(FISH[1], { seller: SELLER, transferTx: TX, pearls: 4_000 }, now - 25 * 3600_000); // aged out
  await ledger.begin(FISH[2], { seller: OTHER, transferTx: TX, pearls: 4_000 }, now - 60_000);
  // A second instance that has never seen this seller.
  const { ledger: fresh } = await instance(redis, fakeChain());
  assert.deepEqual(fresh.records, {});
  await fresh.loadSeller(SELLER);
  assert.deepEqual(Object.keys(fresh.records), [FISH[0]]);
  assert.doesNotThrow(() => checkPayoutCap(fresh.records, SELLER, 5));
  assert.throws(() => checkPayoutCap(fresh.records, SELLER, 6), (e) => e.status === 429);
  await fresh.loadSeller(OTHER);
  assert.throws(() => checkPayoutCap(fresh.records, SELLER, 6), (e) => e.status === 429, 'loading another seller keeps this one');
});

test('the sweep reads the Redis ledger through loadAssets and burns only paid fish', async () => {
  const redis = createFakeRedis();
  const { ledger } = await instance(redis, fakeChain());
  for (const [i, status] of ['paid', 'burned', 'paying'].entries()) {
    await ledger.begin(FISH[i], { seller: SELLER, transferTx: TX, pearls: 1 });
    if (status !== 'paying') await ledger.paid(FISH[i]);
    if (status === 'burned') await ledger.burned(FISH[i], '');
  }
  const coll = 'Coll1111111111111111111111111111111111111';
  const owned = FISH.slice(0, 4).map((id) => ({ publicKey: id, owner: MARKET, updateAuthority: { type: 'Collection', address: coll } }));
  const burned = [];
  const sweep = createSweep({ listOwned: async () => owned, collection: () => coll, market: MARKET, ledger, burnOnce: async (id) => burned.push(id) });
  assert.deepEqual(await sweep.run(), { burned: 2, failed: 0, left: 0, unpaid: 1 });
  assert.deepEqual(burned, [FISH[0], FISH[1]]);
});

test('fish numbers: concurrent requests on several instances get distinct, gapless numbers; a key keeps its number', async () => {
  const redis = createFakeRedis();
  const counters = [1, 2, 3].map(() => createRedisStore({ redis, prefix: 'test:', env: {} }).openSerials());
  const ids = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(8, '0'));
  // Every fish asked for three times at once, on different instances.
  const got = await Promise.all(ids.flatMap((id, i) => [0, 1, 2].map((k) => counters[(i + k) % 3].assign(SELLER, id))));
  const byId = new Map();
  ids.forEach((id, i) => byId.set(id, got.slice(3 * i, 3 * i + 3)));
  for (const [id, three] of byId) assert.ok(three.every((n) => n === three[0]), `${id}: the same number every time`);
  const numbers = [...byId.values()].map((t) => t[0]).sort((x, y) => x - y);
  assert.deepEqual(numbers, Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(await counters[0].peek(SELLER, ids[7]), byId.get(ids[7])[0]);
  assert.equal(await counters[1].peek(OTHER, ids[7]), undefined);
  assert.equal(await counters[2].assign(OTHER, ids[7]), 31, 'the same seed for another owner is another fish');
});

test('fish numbers: the Redis counter behind POST /api/nft/serial, and exhaustion fails closed', async () => {
  const redis = createFakeRedis();
  const counter = createRedisStore({ redis, prefix: 'test:', env: {} }).openSerials();
  const handle = createSerialHandler({ counter, log: () => {} });
  async function post(body) {
    const chunks = [Buffer.from(JSON.stringify(body))];
    const req = {
      method: 'POST',
      url: '/api/nft/serial',
      socket: { remoteAddress: '1.2.3.4' },
      on(ev, fn) {
        if (ev === 'data') queueMicrotask(() => chunks.forEach(fn));
        if (ev === 'end') queueMicrotask(() => queueMicrotask(fn));
      },
      destroy() {},
    };
    const res = { headers: {}, setHeader() {}, writeHead(s) { this.status = s; this.headersSent = true; }, end(b) { this.body = JSON.parse(b); } };
    assert.equal(await handle(req, res), true);
    return res;
  }
  assert.deepEqual((await post({ id: 'c61cd89c', owner: SELLER })).body, { serial: 1 });
  assert.deepEqual((await post({ id: 'c61cd89c', owner: SELLER })).body, { serial: 1 });
  redis.data.set('test:serial:last', { type: 'string', value: '999999999', expiresAt: Infinity });
  const full = await post({ id: '0000beef', owner: SELLER });
  assert.equal(full.status, 503);
  assert.match(full.body.error, /exhausted/);
});

test('registry: a retried co-sign writes the same mapping again, and another instance reads it', async () => {
  const redis = createFakeRedis();
  const r1 = createRedisStore({ redis, prefix: 'test:', env: {} }).openRegistry();
  const r2 = createRedisStore({ redis, prefix: 'test:', env: {} }).openRegistry();
  assert.equal(await r2.get(SELLER, 'c61cd89c'), null);
  const e1 = await r1.set(SELLER, 'c61cd89c', { asset: FISH[0], lastValid: 1150, kind: 'mint' }, 5);
  const e2 = await r1.set(SELLER, 'c61cd89c', { asset: FISH[0], lastValid: 1150, kind: 'mint' }, 5);
  assert.deepEqual(e1, e2);
  assert.deepEqual(await r2.get(SELLER, 'c61cd89c'), { k: `${SELLER}/c61cd89c`, asset: FISH[0], lastValid: 1150, kind: 'mint', at: 5 });
  assert.equal(redis.data.get('test:fish').value.size, 1, 'one entry, however often it is retried');
  assert.equal(await r2.get(OTHER, 'c61cd89c'), null);
});

test('market state: saved without the sold set, and refresh() picks up what another instance created', async () => {
  const redis = createFakeRedis();
  const s1 = await createRedisStore({ redis, prefix: 'test:', env: {} }).openMarketState({ cluster: 'devnet' });
  const s2 = await createRedisStore({ redis, prefix: 'test:', env: {} }).openMarketState({ cluster: 'devnet' });
  assert.deepEqual(s1.state, { cluster: 'devnet', mint: null });
  s1.state.pendingMint = 'Mint1';
  await s1.save();
  s1.state.mint = 'Mint1';
  delete s1.state.pendingMint;
  await s1.save();
  assert.equal(s2.state.mint, null);
  s2.state.pendingMint = 'stale';
  await s2.refresh();
  assert.deepEqual(s2.state, { cluster: 'devnet', mint: 'Mint1' });
  assert.equal(JSON.parse(redis.data.get('test:state').value).sold, undefined);
});

/** The KV contract, run against the memory KV (Dell) and the Redis one. */
function kvContract(name, make) {
  test(`kv (${name}): get/set/nx/del/cas/incr and TTLs`, async () => {
    let t = 1_000_000;
    const kv = make(() => t);
    assert.equal(await kv.get('a'), null);
    assert.equal(await kv.set('a', '1'), true);
    assert.equal(await kv.set('a', '2', { nx: true }), false);
    assert.equal(await kv.get('a'), '1');
    assert.equal(await kv.cas('a', '2', '3'), false);
    assert.equal(await kv.cas('a', '1', '3'), true);
    assert.equal(await kv.get('a'), '3');
    assert.equal(await kv.cas('b', null, 'x', { ttlMs: 500 }), true, 'expected null: create only if absent');
    assert.equal(await kv.cas('b', null, 'y'), false);
    assert.equal(await kv.cas('a', '3', null), true, 'next null: delete');
    assert.equal(await kv.get('a'), null);
    assert.equal(await kv.del('a'), false);
    assert.equal(await kv.set('s', 'session', { ttlMs: 1000, nx: true }), true);
    t += 999;
    assert.equal(await kv.get('s'), 'session');
    assert.equal(await kv.get('b'), null, 'b expired after 500 ms');
    t += 1;
    assert.equal(await kv.get('s'), null);
    assert.equal(await kv.set('s', 'again', { nx: true }), true, 'an expired key is free for nx');
    assert.equal(await kv.del('s'), true);
    assert.equal(await kv.incr('n', { ttlMs: 100 }), 1);
    assert.equal(await kv.incr('n', { ttlMs: 100 }), 2);
    t += 100;
    assert.equal(await kv.incr('n'), 1, 'the window restarted');
  });
}
kvContract('memory', (now) => createMemoryKv({ now }));
kvContract('redis', (now) => createRedisKv(createFakeRedis({ now }), 'test:'));

test('kv lock: one holder at a time across instances, released by its own token only', async () => {
  const redis = createFakeRedis();
  const [a, b] = [createRedisStore({ redis, env: {} }), createRedisStore({ redis, env: {} })];
  const tries = await Promise.all([a.lock('setup:mint', 60_000), b.lock('setup:mint', 60_000), a.lock('setup:mint', 60_000)]);
  assert.equal(tries.filter(Boolean).length, 1);
  const release = tries.find(Boolean);
  assert.equal(await b.lock('setup:mint', 60_000), null);
  await release();
  assert.ok(await b.lock('setup:mint', 60_000));
  assert.ok(redis.data.has('market:kv:lock:setup:mint'), 'default prefix "market:"');
});

test('store selection: file by default, Redis only when asked or when its credentials are set', async (t) => {
  assert.equal(storeKind({}), 'file');
  assert.equal(storeKind({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }), 'redis');
  assert.equal(storeKind({ UPSTASH_REDIS_REST_URL: 'https://x' }), 'file', 'a URL without a token is not a database');
  assert.equal(storeKind({ MARKET_STORE: 'file', UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }), 'file');
  assert.equal(storeKind({ MARKET_STORE: 'redis' }), 'redis');
  assert.throws(() => storeKind({ MARKET_STORE: 'sqlite' }), /MARKET_STORE/);
  assert.deepEqual(
    redisCredentials({ UPSTASH_REDIS_REST_URL: 'https://u', UPSTASH_REDIS_REST_TOKEN: 'ut', KV_REST_API_URL: 'https://k', KV_REST_API_TOKEN: 'kt' }),
    { url: 'https://u', token: 'ut' },
    'the UPSTASH_ pair wins, like @upstash/redis fromEnv',
  );
  await assert.rejects(createStore({ env: { MARKET_STORE: 'redis' }, log: () => {} }), /UPSTASH_REDIS_REST_URL/);
  // On Vercel the file store would be a private, throwaway disk per instance: refuse it.
  await assert.rejects(createStore({ dir: '/tmp', env: { VERCEL: '1' }, log: () => {} }), /cannot run on Vercel/);
  const dir = mkdtempSync(join(tmpdir(), 'market-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await createStore({ dir, env: {}, log: () => {} })).kind, 'file');
});

test('MARKET_SECRET_KEY: a JSON byte array or base58, 64 bytes, never echoed in an error', () => {
  const secret = randomBytes(64);
  assert.deepEqual(parseSecretKey(JSON.stringify([...secret])), Uint8Array.from(secret));
  assert.deepEqual(parseSecretKey(`  ${base58.deserialize(secret)[0]}\n`), Uint8Array.from(secret));
  assert.throws(() => parseSecretKey(''), /not set/);
  assert.throws(() => parseSecretKey(undefined), /not set/);
  const short = JSON.stringify([...secret.subarray(0, 32)]);
  assert.throws(() => parseSecretKey(short), (e) => /64-byte/.test(e.message) && !e.message.includes(short.slice(1, 20)));
  assert.throws(() => parseSecretKey(JSON.stringify([...secret.subarray(0, 63), 256])), /64-byte/);
  assert.throws(() => parseSecretKey('0OIl not base58'), (e) => /neither/.test(e.message) && !e.message.includes('0OIl'));
  // The Redis store reads it from its env only; the file store never does.
  const store = createRedisStore({ redis: createFakeRedis(), env: { MARKET_SECRET_KEY: JSON.stringify([...secret]) } });
  assert.deepEqual(store.marketSecret(), Uint8Array.from(secret));
  assert.throws(() => createRedisStore({ redis: createFakeRedis(), env: {} }).marketSecret(), /not set/);
  assert.equal(createFileStore({ dir: '/nonexistent' }).marketSecret(), null);
});

test('the file store reads and writes exactly the files the server always did', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'market-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sold = { [FISH[0]]: { seller: SELLER, transferTx: TX, pearls: 10, status: 'paid', payTx: 'sig', at: 5 } };
  writeFileSync(join(dir, '.market-state.json'), JSON.stringify({ cluster: 'devnet', mint: 'Mint1', fishCollection: 'Coll', sold }));
  writeFileSync(join(dir, '.market-fish.jsonl'), `${JSON.stringify({ k: `${SELLER}/ab`, asset: FISH[1], lastValid: 1, kind: 'mint', at: 2 })}\nnot json\n`);
  const store = createFileStore({ dir });
  const { state, ledger, save } = await store.openMarketState({ cluster: 'ignored' });
  assert.ok(ledger instanceof SoldLedger);
  assert.equal(state.mint, 'Mint1');
  assert.deepEqual(ledger.get(FISH[0]), sold[FISH[0]]);
  ledger.burned(FISH[0], 'burn');
  assert.equal(JSON.parse(readFileSync(join(dir, '.market-state.json'), 'utf8')).sold[FISH[0]].status, 'burned', 'every step is on disk');
  save();
  const reg = store.openRegistry();
  assert.equal(reg.get(SELLER, 'ab').asset, FISH[1]);
  reg.set(SELLER, 'cd', { asset: FISH[2], kind: 'mint' }, 9);
  assert.equal(readFileSync(join(dir, '.market-fish.jsonl'), 'utf8').trim().split('\n').length, 3, 'one appended line');
  assert.equal(store.openSerials(), null, 'nft-serial.mjs keeps its own file');
});

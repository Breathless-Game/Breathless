import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { DAILY_PEARL_CAP, HttpError, MPL_CORE_PROGRAM, SoldLedger, appraise } from '../market-rules.mjs';
import { checkPayoutCap } from '../fish-trust.mjs';
import { pendingIsLive } from '../fish-collection.mjs';
import { SETUP_LOCK, createSellerLock, createSetupStep } from '../market-server-mode.mjs';
import { createPayout } from '../market-payout.mjs';
import { createSaleDesk } from '../market-sale.mjs';
import { SWEEP_RESUME_AFTER_MS, createSweep } from '../market-burn.mjs';
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

const rejected = () => Object.assign(new Error('Transaction simulation failed'), { transactionMessage: 'Transaction simulation failed: Blockhash not found' });

/** The chain every instance talks to: built and landed PEARL payouts. `sends` scripts each send: ok | timeout-landed | rejected. */
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
      const how = sends.shift() ?? 'ok';
      await tick();
      if (how === 'rejected') throw rejected(); // refused by the node: never submitted
      chain.landed.set(sig, { assetId });
      if (how === 'timeout-landed') throw timeout();
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

/**
 * One serverless instance: its own store, ledger, payout and desk, over the shared fake Redis.
 * `cap`: price with the daily cap as fish-collection.mjs does, and hold the seller lock as server mode does.
 */
async function instance(redis, chain, { transfer = transferTx(FISH), cap, refunds } = {}) {
  const store = createRedisStore({ redis, prefix: 'test:', env: {} });
  const { ledger } = await store.openMarketState({ cluster: 'devnet' });
  const payout = createPayout({ ledger, ...chain.deps });
  const capped = (asset, seller) => {
    const pearls = plainPrice(asset);
    checkPayoutCap(ledger.records, seller, pearls, { cap });
    return pearls;
  };
  const desk = createSaleDesk({
    priceFish: cap === undefined ? plainPrice : capped,
    withSellerLock: cap === undefined ? undefined : createSellerLock({ store, shared: true, waitMs: 200, sleep: tick }),
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
    // A fish over the cap goes back at once; `refunds` (market-refund.test.mjs) puts a chain behind it.
    refund: async (assetId) => {
      await ledger.refundPending(assetId, `back-${assetId}`, 0);
      await ledger.refunded(assetId);
      return `back-${assetId}`;
    },
    resolveRefund: async (assetId) => ((await ledger.get(assetId))?.status === 'refunded' ? 'refunded' : 'unrefunded'),
    ...(refunds ? refunds(ledger) : {}),
  });
  return { store, ledger, payout, desk };
}

/** The Dell: the file store's SoldLedger, one process, with the same payout and desk. */
function fileInstance(chain) {
  const ledger = new SoldLedger();
  const payout = createPayout({ ledger, ...chain.deps });
  const desk = createSaleDesk({
    priceFish: plainPrice,
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: async () => transferTx(FISH),
    loadMarketAsset: async () => RARE,
    resolvePending: payout.resolvePending,
    pay: payout.pay,
    burnSold: async (assetId) => ledger.burned(assetId, `burn-${assetId}`),
    // No daily cap here, so no fish is ever sent back.
    refund: async () => assert.fail('nothing is sent back here'),
    resolveRefund: async () => assert.fail('nothing is sent back here'),
  });
  return { ledger, payout, desk };
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

test('the daily cap holds across instances: two sales for a seller just under it, at once, pay exactly one', async () => {
  for (const how of ['two instances', 'one batch']) {
    const redis = createFakeRedis();
    const chain = fakeChain();
    const [a, b] = await Promise.all([instance(redis, chain, { cap: 20 }), instance(redis, chain, { cap: 20 })]);
    // 5 PEARL already today: one more fish (10) fits under 20, two do not.
    await a.ledger.begin(FISH[5], { seller: SELLER, transferTx: TX, pearls: 5 });
    const sell = (inst, assetId) => inst.desk.sell({ assetId, seller: SELLER, transferTx: TX });
    const answers =
      how === 'two instances'
        ? (await Promise.allSettled([sell(a, FISH[0]), sell(b, FISH[1])])).map((r) => (r.status === 'fulfilled' ? r.value : { status: r.reason.status }))
        : (await a.desk.sellBatch({ seller: SELLER, sales: [FISH[0], FISH[1]].map((assetId) => ({ assetId, transferTx: TX })) })).results;
    assert.equal(answers.filter((r) => r.pearls === 10).length, 1, `${how}: one sale paid`);
    assert.deepEqual(answers.filter((r) => r.pearls === undefined).map((r) => r.status), [429], `${how}: the other gets the daily cap`);
    assert.equal(chain.payouts(FISH[0]) + chain.payouts(FISH[1]), 1, `${how}: one payout`);
    assert.equal(redis.data.has('test:kv:lock:seller:' + SELLER), false, `${how}: the seller lock is released`);
  }
});

test('the seller lock: the 24 h total is not re-capped on a resume, and a lock held elsewhere is a 503 to retry', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain(['rejected']);
  const a = await instance(redis, chain, { cap: 10 });
  const sale = { assetId: FISH[0], seller: SELLER, transferTx: TX };
  // Begun at the cap exactly (10 of 10), then the payout was refused: the sale is stuck in 'paying'.
  await assert.rejects(a.desk.sell(sale), /simulation failed/);
  const before = await redis.zrange('test:seller:' + SELLER, 0, -1);
  // The sweep's resume (and the player's retry) pays the stored record without pricing it again.
  const { sweep } = resumingSweep(a.ledger, a.desk);
  assert.deepEqual(await sweep.run(), stats({ resumed: 1 }));
  assert.equal(chain.payouts(FISH[0]), 1);
  assert.deepEqual(await redis.zrange('test:seller:' + SELLER, 0, -1), before, 'counted once in the seller\'s 24 h');
  // Another instance holds a seller's lock (and never lets go): a new sale waits a little, then answers 503.
  const BUYER = 'Buyer' + '1'.repeat(38);
  const store = createRedisStore({ redis, prefix: 'test:', env: {} });
  assert.ok(await store.lock('seller:' + BUYER, 60_000));
  const b = await instance(redis, chain, { cap: 100, transfer: transferTx(FISH, BUYER) });
  await assert.rejects(b.desk.sell({ assetId: FISH[1], seller: BUYER, transferTx: TX }), (e) => e.status === 503 && /still being recorded/.test(e.message));
  assert.equal(await b.ledger.get(FISH[1]), null, 'nothing recorded');
});

const COLL = 'Coll1111111111111111111111111111111111111';
const coreAsset = (id, owner = MARKET) => ({ publicKey: id, owner, updateAuthority: { type: 'Collection', address: COLL } });

/** A sweep over a Redis ledger; `onChain` maps id -> asset (missing: gone). It never lists the chain. */
function redisSweep(ledger, onChain) {
  const burned = [];
  const fetched = [];
  const sweep = createSweep({
    listOwned: async () => {
      throw new Error('the sweep must not list the chain (getProgramAccounts)');
    },
    collection: () => COLL,
    market: MARKET,
    ledger,
    loadAsset: async (id) => {
      fetched.push(id);
      return onChain[id] ?? null;
    },
    burnOnce: async (id) => {
      burned.push(id);
      await ledger.burned(id, `burn-${id}`);
    },
    sleep: async () => {},
  });
  return { sweep, burned, fetched };
}

test('the sweep works from the Redis unburned index: burns paid fish, settles gone ones, idles on one command', async () => {
  const redis = createFakeRedis();
  const { ledger } = await instance(redis, fakeChain());
  for (const [i, status] of ['paid', 'burned', 'paying', 'paid', 'paid'].entries()) {
    await ledger.begin(FISH[i], { seller: SELLER, transferTx: TX, pearls: 1 });
    if (status !== 'paying') await ledger.paid(FISH[i]);
    if (status === 'burned') await ledger.burned(FISH[i], '');
  }
  await ledger.skipBurn(FISH[4], 'owned by someone else, not the market');
  assert.deepEqual(await ledger.unburned(), [FISH[0], FISH[2], FISH[3]], 'index order: oldest sale first; paying ones too');
  // A second instance (another serverless function) sees the same list.
  const { ledger: other } = await instance(redis, fakeChain());
  const onChain = { [FISH[0]]: coreAsset(FISH[0]), [FISH[2]]: coreAsset(FISH[2]) }; // FISH[3]: already gone
  const { sweep, burned, fetched } = redisSweep(other, onChain);
  assert.deepEqual(await sweep.run(), { burned: 1, resumed: 0, refunded: 0, settled: 1, skipped: 0, failed: 0, waiting: 1, left: 0, rateLimited: false });
  assert.deepEqual(burned, [FISH[0]]);
  assert.deepEqual(fetched, [FISH[0], FISH[3]]);
  assert.equal((await ledger.get(FISH[3])).status, 'burned');
  assert.equal((await ledger.get(FISH[2])).status, 'paying', 'a payment in doubt begun just now waits: its request may still be on it');
  assert.deepEqual([...redis.data.get('test:unburned').value.keys()], [FISH[2]], 'only the paying sale is left on the list');
  // Its request finishes it: off the list.
  await ledger.paid(FISH[2]);
  await ledger.burned(FISH[2], 'b');
  assert.equal(redis.data.get('test:unburned'), undefined, 'the index is empty');
  // Idle: one ZRANGE, nothing on the chain.
  const before = redis.calls.length;
  assert.deepEqual(await sweep.run(), { burned: 0, resumed: 0, refunded: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 0, rateLimited: false });
  assert.deepEqual(redis.calls.slice(before), ['zrange']);
  assert.equal(fetched.length, 2);
});

test('Redis unburned index: a sale adds and removes its fish; stale entries are dropped on read', async () => {
  const redis = createFakeRedis();
  const { ledger, desk } = await instance(redis, fakeChain());
  // A whole sale through the desk: paid then burned, so it is never left on the list.
  await desk.sell({ assetId: FISH[0], seller: SELLER, transferTx: TX });
  assert.equal((await ledger.get(FISH[0])).status, 'burned');
  assert.deepEqual(await ledger.unburned(), []);
  // A sale that stops in 'paying' (pay() failed, the player never came back) is on the list from begin().
  await ledger.begin(FISH[1], { seller: SELLER, transferTx: TX, pearls: 1 });
  // A crash between the 'burned' CAS and the ZREM, and an entry with no record at all.
  await ledger.begin(FISH[2], { seller: SELLER, transferTx: TX, pearls: 1 });
  await ledger.paid(FISH[2]);
  await ledger.burned(FISH[2], 'b');
  await redis.zadd('test:unburned', { score: 2, member: FISH[2] }, { score: 3, member: FISH[5] });
  await ledger.begin(FISH[3], { seller: SELLER, transferTx: TX, pearls: 1 });
  await ledger.paid(FISH[3]);
  assert.deepEqual(await ledger.unburned(), [FISH[1], FISH[3]]);
  assert.deepEqual([...redis.data.get('test:unburned').value.keys()].sort(), [FISH[1], FISH[3]].sort(), 'the stale entries are gone');
  // Paid, it stays on the list until burned, in its place (scored by the sale's time).
  await ledger.paid(FISH[1]);
  assert.deepEqual(await ledger.unburned(), [FISH[1], FISH[3]]);
  assert.equal((await ledger.unburned(1)).length, 1, 'bounded');
});

test('Redis unburned index: a listing between begin\'s ZADD and its SET cannot lose the sale', async () => {
  const redis = createFakeRedis();
  const { ledger } = await instance(redis, fakeChain());
  const { ledger: other } = await instance(redis, fakeChain());
  const realSet = redis.set;
  redis.set = async (key, ...rest) => {
    // Another instance's sweep lists right before the record is written: no record yet, so it drops the entry.
    if (key === `test:sold:${FISH[0]}`) assert.deepEqual(await other.unburned(), []);
    return realSet(key, ...rest);
  };
  assert.equal(await ledger.begin(FISH[0], { seller: SELLER, transferTx: TX, pearls: 1 }), true);
  redis.set = realSet;
  assert.deepEqual(await other.unburned(), [FISH[0]], 'begin indexed it again once the record existed');
  // The loser of a begin race writes nothing and leaves the winner's sale listed.
  assert.equal(await other.begin(FISH[0], { seller: OTHER, transferTx: TX, pearls: 9 }), false);
  assert.deepEqual(await ledger.unburned(), [FISH[0]]);
  assert.equal((await ledger.get(FISH[0])).seller, SELLER);
});

test('Redis unburned index: records written before it existed are backfilled once, over SCAN pages', async () => {
  const redis = createFakeRedis({ jitter: false });
  const keys = { sold: (id) => `test:sold:${id}` };
  // The live database before this change: sold records, payouts, seller indexes, sessions; no index.
  const rec = (status, at, extra = {}) => JSON.stringify({ seller: SELLER, transferTx: TX, pearls: 1, status, at, ...extra });
  for (let i = 0; i < 1_100; i++) await redis.set(keys.sold(`Old${i}`), rec('burned', i, { burnTx: 'b' }));
  await redis.set(keys.sold('Stuck2'), rec('paid', 5_000));
  await redis.set(keys.sold('Stuck1'), rec('paid', 4_000));
  await redis.set(keys.sold('Aside'), rec('paid', 3_000, { burnSkipped: 'not in the fish collection' }));
  await redis.set(keys.sold('Paying'), rec('paying', 2_000));
  await redis.set('test:paytx:Paying', JSON.stringify({ payTx: 'p', payLastValid: 1 }));
  await redis.set('test:kv:session', 'x');
  await redis.set('other:sold:Elsewhere', rec('paid', 1)); // another prefix: not ours
  const { ledger } = await instance(redis, fakeChain());
  const before = redis.calls.length;
  assert.deepEqual(await ledger.unburned(), ['Paying', 'Stuck1', 'Stuck2'], 'paid and paying sales, by sale time');
  const calls = redis.calls.slice(before);
  assert.equal(calls.filter((c) => c === 'scan').length, 2, 'two SCAN pages of 1000');
  assert.ok(redis.data.has('test:unburned:ready:v2'));
  // Every later listing, on this instance or a new one, reads the index only.
  let mark = redis.calls.length;
  await ledger.unburned();
  assert.deepEqual(redis.calls.slice(mark), ['zrange', 'mget']);
  const { ledger: fresh } = await instance(redis, fakeChain());
  mark = redis.calls.length;
  assert.deepEqual(await fresh.unburned(), ['Paying', 'Stuck1', 'Stuck2']);
  assert.deepEqual(redis.calls.slice(mark), ['get', 'zrange', 'mget']);
  // Burned through the ledger: off the list, and the backfill never runs again to put it back.
  await fresh.burned('Stuck1', 'sig');
  assert.deepEqual(await ledger.unburned(), ['Paying', 'Stuck2']);
});

test('Redis backfill: a database backfilled when the index held paid sales only is backfilled again', async () => {
  const redis = createFakeRedis();
  const rec = (status, at) => JSON.stringify({ seller: SELLER, transferTx: TX, pearls: 1, status, at });
  await redis.set('test:sold:Paid', rec('paid', 2));
  await redis.set('test:sold:Paying', rec('paying', 1));
  // The index as the first version of the backfill left it: paid sales only, and its ready marker.
  await redis.zadd('test:unburned', { score: 2, member: 'Paid' });
  await redis.set('test:unburned:ready', '1');
  const { ledger } = await instance(redis, fakeChain());
  assert.deepEqual(await ledger.unburned(), ['Paying', 'Paid']);
});

test('Redis backfill: a failed pass leaves no ready marker and runs again', async () => {
  const redis = createFakeRedis();
  await redis.set('test:sold:Stuck', JSON.stringify({ seller: SELLER, transferTx: TX, pearls: 1, status: 'paid', at: 1 }));
  const realScan = redis.scan;
  redis.scan = async () => {
    throw new Error('Upstash: 503');
  };
  const { ledger } = await instance(redis, fakeChain());
  await assert.rejects(ledger.unburned(), /503/);
  assert.equal(redis.data.has('test:unburned:ready:v2'), false);
  redis.scan = realScan;
  assert.deepEqual(await ledger.unburned(), ['Stuck']);
});

/**
 * A sweep that resumes stalled sales through `desk`, wired as market-server-mode.mjs does, with its
 * clock `aheadMs` in the future (by default just past SWEEP_RESUME_AFTER_MS: every paying sale is stale).
 */
function resumingSweep(ledger, desk, { aheadMs = SWEEP_RESUME_AFTER_MS + 1, ...opts } = {}) {
  const resumed = [];
  const sweep = createSweep({
    collection: () => COLL,
    market: MARKET,
    ledger,
    loadAsset: async (id) => coreAsset(id),
    burnOnce: async (id) => ledger.burned(id, `burn-${id}`),
    resumeSale: (assetId, r) => {
      resumed.push(assetId);
      return desk.sellAsset({ assetId, seller: r.seller, transferTx: r.transferTx });
    },
    sleep: async () => {},
    now: () => Date.now() + aheadMs,
    ...opts,
  });
  return { sweep, resumed };
}

const stats = (o) => ({ burned: 0, resumed: 0, refunded: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 0, rateLimited: false, ...o });

test('the sweep finishes a stalled sale whose payout never went out: paid once, by another instance, then burned', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain(['rejected']);
  const [a, b] = await Promise.all([instance(redis, chain), instance(redis, chain)]);
  const sale = { assetId: FISH[0], seller: SELLER, transferTx: TX };
  await assert.rejects(a.desk.sell(sale), /simulation failed/);
  assert.equal((await a.ledger.get(FISH[0])).status, 'paying');
  assert.equal(chain.payouts(FISH[0]), 0);
  // Begun just now: a request may still be working on it, so the sweep leaves it alone.
  const young = resumingSweep(b.ledger, b.desk, { aheadMs: 60_000 });
  assert.deepEqual(await young.sweep.run(), stats({ waiting: 1 }));
  assert.deepEqual(young.resumed, []);
  assert.equal(chain.sendsFor(FISH[0]), 1, 'only the refused send so far');
  // Ten minutes on, the player has not come back (storage cleared, another device): the sweep finishes it.
  const stale = resumingSweep(b.ledger, b.desk);
  assert.deepEqual(await stale.sweep.run(), stats({ resumed: 1 }));
  assert.deepEqual(stale.resumed, [FISH[0]]);
  assert.equal(chain.payouts(FISH[0]), 1);
  const rec = await a.ledger.get(FISH[0]);
  assert.equal(rec.status, 'burned');
  assert.equal(rec.burnTx, `burn-${FISH[0]}`);
  // Nothing left to do, and the player's own retry gets the stored result without a second payout.
  assert.deepEqual(await stale.sweep.run(), stats({}));
  const r = await a.desk.sell(sale);
  assert.equal(r.pearls, 10);
  assert.equal(r.tx, rec.payTx);
  assert.equal(chain.sendsFor(FISH[0]), 2);
  assert.equal(chain.payouts(FISH[0]), 1);
});

test('the sweep settles a stalled sale whose payout already landed from the chain: no second payout', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain(['timeout-landed']);
  const [a, b] = await Promise.all([instance(redis, chain), instance(redis, chain)]);
  await assert.rejects(a.desk.sell({ assetId: FISH[0], seller: SELLER, transferTx: TX }), /fetch failed/);
  const before = await a.ledger.get(FISH[0]);
  assert.equal(before.status, 'paying');
  assert.ok(before.payTx);
  const { sweep } = resumingSweep(b.ledger, b.desk);
  assert.deepEqual(await sweep.run(), stats({ resumed: 1 }));
  assert.equal(chain.sendsFor(FISH[0]), 1, 'nothing sent again');
  assert.equal(chain.payouts(FISH[0]), 1);
  const after = await a.ledger.get(FISH[0]);
  assert.equal(after.status, 'burned');
  assert.equal(after.payTx, before.payTx, 'the earlier payout is the one on record');
});

test('a stalled sale whose payout may still land is not paid again: counted as failed, finished once it expires', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain();
  const { ledger, desk } = await instance(redis, chain);
  await ledger.begin(FISH[0], { seller: SELLER, transferTx: TX, pearls: 10 });
  await ledger.payPending(FISH[0], 'ghost', chain.height + 150); // sent, unconfirmed, blockhash still valid
  const logs = [];
  const { sweep } = resumingSweep(ledger, desk, { log: (m) => logs.push(m) });
  assert.deepEqual(await sweep.run(), stats({ failed: 1 }));
  assert.ok(logs.some((l) => l.includes(FISH[0]) && l.includes('still confirming')));
  assert.equal(chain.sendsFor(FISH[0]), 0);
  assert.equal((await ledger.get(FISH[0])).status, 'paying');
  // Its blockhash expired and it is not on chain: it can never land, so the next sweep pays.
  chain.height += 200;
  assert.deepEqual(await sweep.run(), stats({ resumed: 1 }));
  assert.equal(chain.payouts(FISH[0]), 1);
  assert.equal((await ledger.get(FISH[0])).status, 'burned');
});

test('sweeps and the players\' retries of the same stalled sales, all at once on several instances, pay each fish once', async () => {
  const redis = createFakeRedis();
  const chain = fakeChain(FISH.map(() => 'rejected'));
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => instance(redis, chain)));
  for (const id of FISH) await assert.rejects(a.desk.sell({ assetId: id, seller: SELLER, transferTx: TX }), /simulation failed/);
  const sweeps = [a, b].map((inst) => resumingSweep(inst.ledger, inst.desk, { maxResumesPerRun: FISH.length }).sweep);
  const sell = (inst, assetId) => inst.desk.sell({ assetId, seller: SELLER, transferTx: TX });
  // Same instance (the per-fish lock) and other instances (Redis) racing the sweeps.
  const results = await Promise.allSettled([...sweeps.map((s) => s.run()), ...FISH.flatMap((id) => [sell(a, id), sell(b, id), sell(c, id)])]);
  onlyRetryable(results);
  for (const id of FISH) {
    assert.equal(chain.payouts(id), 1, `${id}: paid once`);
    assert.equal(chain.sendsFor(id), 2, `${id}: the refused send and one payout, nothing else sent`);
  }
  // Whatever is still unfinished (a 409'd request) the next sweep finishes, without paying again.
  await sweeps[0].run();
  for (const id of FISH) {
    assert.equal((await a.ledger.get(id)).status, 'burned', id);
    assert.equal(chain.payouts(id), 1);
  }
});

test('the Dell (file ledger, one process): the sweep and a retry of a stalled sale share the fish\'s lock and pay once', async () => {
  const chain = fakeChain(['rejected', 'timeout-landed']);
  const { ledger, desk } = fileInstance(chain);
  const sale = (assetId) => ({ assetId, seller: SELLER, transferTx: TX });
  await assert.rejects(desk.sell(sale(FISH[0])), /simulation failed/); // never paid
  await assert.rejects(desk.sell(sale(FISH[1])), /fetch failed/); // paid, the answer lost
  assert.deepEqual(ledger.unburned(), [FISH[0], FISH[1]]);
  const { sweep } = resumingSweep(ledger, desk);
  const [out, r0, r1] = await Promise.all([sweep.run(), desk.sell(sale(FISH[0])), desk.sell(sale(FISH[1]))]);
  assert.equal(out.failed, 0);
  assert.equal(r0.pearls, 10);
  assert.equal(r1.pearls, 10);
  for (const id of [FISH[0], FISH[1]]) {
    assert.equal(chain.payouts(id), 1, `${id}: paid once`);
    assert.equal(ledger.get(id).status, 'burned');
  }
  assert.equal(chain.sendsFor(FISH[0]), 2);
  assert.equal(chain.sendsFor(FISH[1]), 1);
  assert.deepEqual(ledger.unburned(), []);
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

const openState = (redis) => createRedisStore({ redis, prefix: 'test:', env: {} }).openMarketState({ cluster: 'devnet' });
const savedState = (redis) => JSON.parse(redis.data.get('test:state').value);

test('market state: one instance saving the mint and another the collection, at once, keeps both', async () => {
  const redis = createFakeRedis();
  const [a, b] = await Promise.all([openState(redis), openState(redis)]);
  const mintSteps = async () => {
    a.state.pendingMint = 'Mint1';
    await a.save();
    a.state.mint = 'Mint1';
    delete a.state.pendingMint;
    await a.save();
  };
  const collectionSteps = async () => {
    b.state.pendingFishCollection = 'Coll1';
    await b.save();
    b.state.fishCollection = 'Coll1';
    b.state.fishCollectionSlot = 77;
    delete b.state.pendingFishCollection;
    await b.save();
  };
  await Promise.all([mintSteps(), collectionSteps()]);
  assert.deepEqual(savedState(redis), { cluster: 'devnet', mint: 'Mint1', fishCollection: 'Coll1', fishCollectionSlot: 77 });
  // A later refresh (under the setup lock) sees both.
  await a.refresh();
  assert.deepEqual(a.state, { cluster: 'devnet', mint: 'Mint1', fishCollection: 'Coll1', fishCollectionSlot: 77 });
  const c = await openState(redis);
  assert.deepEqual(c.state, savedState(redis));
});

test('market state: a lock-free read (adopt) during an in-flight save never drops the pending mint', async () => {
  const redis = createFakeRedis();
  const a = await openState(redis);
  const other = await openState(redis);
  other.state.fishCollection = 'Coll1';
  await other.save();
  a.state.pendingMint = 'Mint1';
  // info() reads while the setup step saves: the read's GET may return the JSON before the save.
  await Promise.all([a.save(), a.adopt(), a.adopt()]);
  assert.equal(a.state.pendingMint, 'Mint1');
  assert.equal(a.state.fishCollection, 'Coll1', 'adopt copies what another instance created');
  assert.equal(savedState(redis).pendingMint, 'Mint1');
  // Finishing the step (as createPearlMint does) then saves the mint and clears the pending address.
  a.state.mint = 'Mint1';
  delete a.state.pendingMint;
  await Promise.all([a.save(), a.adopt()]);
  assert.deepEqual(savedState(redis), { cluster: 'devnet', mint: 'Mint1', fishCollection: 'Coll1' });
  assert.equal(a.state.mint, 'Mint1');
});

test('market state: a saved mint or collection is never replaced, and a delete only removes what this instance knew', async () => {
  const redis = createFakeRedis();
  const [a, b] = await Promise.all([openState(redis), openState(redis)]);
  a.state.mint = 'MintA';
  await a.save();
  b.state.mint = 'MintB'; // a late second mint (a sender frozen past the setup lock)
  await b.save();
  assert.equal(savedState(redis).mint, 'MintA', 'the first saved mint stays');
  assert.equal(b.state.mint, 'MintA', 'the loser now uses the saved one');

  a.state.pendingFishCollection = 'P1';
  await a.save();
  await b.refresh();
  a.state.pendingFishCollection = 'P2'; // a newer step replaced the pending address
  await a.save();
  delete b.state.pendingFishCollection; // b, still knowing P1, clears it
  await b.save();
  assert.equal(savedState(redis).pendingFishCollection, 'P2');
  assert.equal(b.state.pendingFishCollection, 'P2', 'b now holds the value that stayed');
  await b.save();
  assert.equal(savedState(redis).pendingFishCollection, 'P2', 'a second save does not delete it either');
});

test('setup steps: one lock for the mint and the collection; the file store runs them as before', async () => {
  const redis = createFakeRedis();
  const store = createRedisStore({ redis, prefix: 'test:', env: {} });
  const { refresh } = await store.openMarketState({ cluster: 'devnet' });
  const step = createSetupStep({ store, refresh, shared: true });
  assert.equal(SETUP_LOCK, 'setup');
  let finish;
  const mint = step('PEARL mint', () => new Promise((r) => (finish = r)));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(redis.data.has('test:kv:lock:setup'));
  await assert.rejects(step('fish collection', async () => 'Coll1'), (e) => e.status === 503 && /fish collection/.test(e.message));
  // Another instance's store over the same Redis is refused too.
  const other = createRedisStore({ redis, prefix: 'test:', env: {} });
  const otherStep = createSetupStep({ store: other, refresh, shared: true });
  await assert.rejects(otherStep('fish collection', async () => 'Coll1'), (e) => e.status === 503);
  finish('Mint1');
  assert.equal(await mint, 'Mint1');
  assert.equal(await step('fish collection', async () => 'Coll1'), 'Coll1', 'free again once the mint step is done');

  const fileStep = createSetupStep({ store: { lock: () => assert.fail('no lock in one process') }, refresh, shared: false });
  assert.deepEqual(await Promise.all([fileStep('PEARL mint', async () => 1), fileStep('fish collection', async () => 2)]), [1, 2]);
});

test('pendingIsLive: a pending address younger than the setup lock may still land; none in one process', () => {
  const now = 1_000_000;
  assert.equal(pendingIsLive(now - 1000, 240_000, now), true);
  assert.equal(pendingIsLive(now - 240_000, 240_000, now), false);
  assert.equal(pendingIsLive(undefined, 240_000, now), false, 'an old pending address without a time: replace it, as before');
  assert.equal(pendingIsLive(now - 1000, 0, now), false, 'file store: as before');
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { deserializeAssetV1, transfer } from '@metaplex-foundation/mpl-core';
import { AccountNotFoundError, keypairIdentity, sol, publicKey as umiKey } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { checkPayoutCap, paidInWindow } from './fish-trust.mjs';
import { SWEEP_RESUME_AFTER_MS, createSweep } from './market-burn.mjs';
import { createPayout } from './market-payout.mjs';
import { createRefund } from './market-refund.mjs';
import { HttpError, MPL_CORE_PROGRAM, SoldLedger, appraise } from './market-rules.mjs';
import { createSaleDesk } from './market-sale.mjs';
import * as serverMode from './market-server-mode.mjs';
import { createRedisStore } from './market-store.mjs';
import { createFakeRedis } from './test/fake-redis.mjs';

// A fish the daily PEARL cap refuses after the player already transferred it to the market goes
// back to the player (market-refund.mjs, market-sale.mjs). Driven against a fake chain that moves
// fish between owners, with the real sale desk, payout, refund and sweep, over both ledgers: the
// file ledger (one process) and the Redis store's (several instances over one fake Redis). The
// questions are always: was the fish paid (never), burned (never), and how many times was it sent back?

const SELLER = 'Se11er111111111111111111111111111111111111';
const OTHER = 'Second11111111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const COLL = 'Co11ection1111111111111111111111111111111';
const fishId = (i) => `Fish${'ABCDEFGH'[i]}`.padEnd(43, '1');
const [F0, F1, F2] = [0, 1, 2].map(fishId);
const tick = () => new Promise((r) => setImmediate(r));
const OLD_ENOUGH = SWEEP_RESUME_AFTER_MS + 1000;
const { assetOrNull, createSellerLock } = serverMode;
/** What a Core burn leaves at the fish's address (fish-collection.mjs assetState): 1 byte, 00, still Core's. */
const burnedStub = (id) => ({ publicKey: umiKey(id), executable: false, owner: umiKey(MPL_CORE_PROGRAM), lamports: sol(0.001), data: Uint8Array.of(0), exists: true });

const plainPrice = (asset) => {
  const a = appraise(asset.attributes?.attributeList);
  if (!a.ok) throw new HttpError(422, a.reason);
  return a.pearls;
};
const timeout = () => Object.assign(new Error('fetch failed'), { cause: new Error('Connect Timeout Error') });
const rejected = () => Object.assign(new Error('Transaction simulation failed'), { transactionMessage: 'Transaction simulation failed: Blockhash not found' });

/**
 * The chain: who owns each fish, the player's transfers to the market, and every payout, burn and
 * transfer back. `refundSends` scripts each send of a transfer back: ok | lost (timed out, never
 * landed) | timeout-landed | rejected (refused by the node, never submitted).
 */
function world({ values = {}, cap = 15, refundSends = [] } = {}) {
  const w = {
    cap,
    height: 1000,
    skew: 0, // the desks' clock, ahead of the real one by this much
    owners: new Map(),
    txs: new Map(),
    landed: new Map(), // signature -> { error }
    payouts: [],
    burns: [],
    backs: [], // transfers back sent: assetId per send
    burnedByPlayer: new Set(), // fish the player burned from their wallet after they came back
    rounds: [], // the transfer each transfer back was built for
    priced: 0,
    seq: 0,
  };
  let txSeq = 0;
  /** The seller hands `ids` over in one transaction: its signature. */
  w.handOver = (ids, seller = SELLER) => {
    const sig = 'ABCDEFGHJKLMNPQRSTUVWXYZ'[txSeq++].repeat(88);
    const accounts = [seller, MARKET, MPL_CORE_PROGRAM, ...ids];
    w.txs.set(sig, {
      message: {
        header: { numRequiredSignatures: 1 },
        accounts,
        instructions: ids.map((_, i) => ({ programIndex: 2, accountIndexes: [3 + i, 2, 0, 2, 1, 2, 2], data: Uint8Array.of(14, 0) })),
      },
      meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
    });
    for (const id of ids) w.owners.set(id, MARKET);
    return sig;
  };
  w.asset = (id) => (w.owners.has(id) ? { publicKey: id, owner: w.owners.get(id), attributes: { attributeList: [{ key: 'rarity', value: 'rare' }, { key: 'depth', value: '5' }, { key: 'value', value: String(values[id] ?? 10) }] } } : null);
  w.paidFor = (id) => w.payouts.filter((x) => x === id).length;
  w.sentBack = (id) => w.backs.filter((x) => x === id).length;

  /** One market instance's chain-facing deps over `ledger`: payout, refund, price, burn. */
  w.deps = (ledger) => {
    const payout = createPayout({
      ledger,
      build: async (assetId, _mint, seller, pearls) => {
        const r = await ledger.get(assetId);
        assert.equal(r.status, 'paying', `${assetId}: only a sale record is ever paid`);
        return { sig: `pay${++w.seq}`, lastValid: w.height + 150, assetId, seller, pearls };
      },
      send: async (b) => {
        await tick();
        w.payouts.push(b.assetId);
        w.landed.set(b.sig, { error: null });
      },
      confirm: async () => null,
      getSignatureStatus: async (sig) => (w.landed.has(sig) ? { ...w.landed.get(sig), commitment: 'finalized' } : null),
      getBlockHeight: async () => w.height,
    });
    const refunds = createRefund({
      ledger,
      market: MARKET,
      // As market-server-mode.mjs loads it for a refund: umi's fetch, null only for an account that is
      // not there, or the 1-byte account a Core burn leaves (which fetchAsset fails to decode).
      loadAsset: (id) =>
        assetOrNull(
          async () => {
            await tick();
            if (w.rpcError) throw w.rpcError;
            if (w.burnedByPlayer.has(id)) return deserializeAssetV1(burnedStub(id)); // throws, as fetchAsset does
            const a = w.asset(id);
            if (!a) throw new AccountNotFoundError(umiKey(id), 'AssetV1');
            return a;
          },
          async () => (w.burnedByPlayer.has(id) ? burnedStub(id) : { exists: w.owners.has(id), owner: umiKey(MPL_CORE_PROGRAM), data: Uint8Array.of(1) }),
        ),
      build: async (asset, seller, transferTx) => {
        w.rounds.push(transferTx); // each transfer back names its round (refundTransfer's memo)
        await w.onBuild?.(asset, seller);
        return { sig: `back${++w.seq}`, lastValid: w.height + 150, assetId: asset.publicKey, seller };
      },
      send: async (b) => {
        w.backs.push(b.assetId);
        const how = refundSends.shift() ?? 'ok';
        await tick();
        if (how === 'rejected') throw rejected();
        if (how === 'lost') throw timeout();
        const moves = w.owners.get(b.assetId) === MARKET;
        if (moves) w.owners.set(b.assetId, b.seller);
        w.landed.set(b.sig, { error: moves ? null : { InstructionError: [0, 'NotOwner'] } });
        if (how === 'timeout-landed') throw timeout();
      },
      confirm: async (b) => {
        await tick();
        await w.onConfirm?.(b);
        if (!w.landed.has(b.sig)) throw new Error('block height exceeded');
        return w.landed.get(b.sig).error;
      },
      getSignatureStatus: async (sig) => (w.landed.has(sig) ? { ...w.landed.get(sig), commitment: 'finalized' } : null),
      getBlockHeight: async () => w.height,
    });
    return {
      priceFish: (asset, seller) => {
        w.priced++;
        const pearls = plainPrice(asset);
        checkPayoutCap(ledger.records, seller, pearls, { cap: w.cap });
        return pearls;
      },
      market: MARKET,
      ensureMint: async () => 'PearlMint',
      fetchTransfer: async (sig) => w.txs.get(sig) ?? null,
      loadMarketAsset: async (id) => w.asset(id),
      resolvePending: payout.resolvePending,
      pay: payout.pay,
      burnSold: async (id) => {
        const r = await ledger.get(id);
        if (r.status === 'burned') return; // another instance burned it first (the real burn finds it gone)
        assert.equal(r.status, 'paid', `${id}: only a paid fish is ever burned`);
        w.burns.push(id);
        w.owners.delete(id);
        await ledger.burned(id, `burn-${id}`);
      },
      refund: refunds.refund,
      resolveRefund: refunds.resolveRefund,
      now: () => Date.now() + w.skew,
    };
  };
  return w;
}

/** A market instance over `ledger`: its desk, and a sweep that never burns a fish on its way back. */
function instance(w, ledger, { withSellerLock, batchDeadlineMs, sweepAheadMs = OLD_ENOUGH } = {}) {
  const desk = createSaleDesk({ ledger, withSellerLock, batchDeadlineMs, ...w.deps(ledger) });
  const sweep = createSweep({
    collection: () => COLL,
    market: MARKET,
    ledger,
    loadAsset: async (id) => w.asset(id),
    burnOnce: async (id) => {
      assert.equal((await ledger.get(id)).status, 'paid', `${id}: the sweep burns only paid fish`);
      w.burns.push(id);
      await ledger.burned(id, `burn-${id}`);
    },
    resumeSale: (id, r, deadline) => desk.sellAsset({ assetId: id, seller: r.seller, transferTx: r.transferTx }, undefined, deadline),
    resumeRefund: (id, _r, deadline) => desk.resumeRefund(id, deadline),
    sleep: async () => {},
    now: () => Date.now() + sweepAheadMs,
  });
  const sell = (assetId, transferTx, seller = SELLER) => desk.sell({ assetId, seller, transferTx });
  return { ledger, desk, sweep, sell };
}

/** The two ledgers. `make()` -> a new instance; file: always the one process (same ledger), redis: a new one over the shared fake. */
const KINDS = {
  file: (w, opts) => {
    const ledger = new SoldLedger();
    const one = instance(w, ledger, opts);
    return { make: () => one, ledger };
  },
  redis: (w, opts) => {
    const redis = createFakeRedis();
    const open = async () => {
      const store = createRedisStore({ redis, prefix: 'test:', env: {} });
      const { ledger } = await store.openMarketState({ cluster: 'devnet' });
      return instance(w, ledger, { withSellerLock: createSellerLock({ store, shared: true, waitMs: 2000, sleep: tick }), ...opts });
    };
    return { make: open, redis };
  },
};
const each = (name, fn) => {
  for (const kind of Object.keys(KINDS)) test(`${name} (${kind} ledger)`, () => fn(kind));
};

/** The cap's answer for a fish sent back: a 429 'daily-cap' with `refunded`. Returns the error's extra. */
async function capAnswer(promise, refunded) {
  let extra;
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof HttpError, String(e?.stack ?? e));
    assert.equal(e.status, 429, e.message);
    assert.match(e.message, /Daily PEARL limit reached/);
    extra = e.extra;
    return true;
  });
  assert.equal(extra.code, 'daily-cap');
  assert.ok(extra.retryAfterMs >= 1000, `retryAfterMs ${extra.retryAfterMs}`);
  assert.equal(extra.refunded, refunded);
  return extra;
}

/** F0 (10 PEARL) sold today under a cap of 15: any further 10-PEARL fish is over it. */
async function soldOne(w, m) {
  const r = await m.sell(F0, w.handOver([F0]));
  assert.equal(r.pearls, 10);
}

each('over the cap after the transfer: recorded, sent back, a 429 daily-cap with refunded: true, never paid or burned', async (kind) => {
  const w = world();
  const k = KINDS[kind](w);
  const m = await k.make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  const extra = await capAnswer(m.sell(F1, t1), true);
  const rec = await m.ledger.get(F1);
  assert.equal(rec.status, 'refunded');
  assert.equal(extra.refundTx, rec.refundTx);
  assert.match(rec.refundTx, /^back/);
  assert.deepEqual([rec.seller, rec.transferTx, rec.pearls], [SELLER, t1, undefined], 'the refund record names the seller and transfer, and no payment');
  assert.equal(w.owners.get(F1), SELLER, 'the fish is back in the seller\'s wallet');
  // A batch: the same answer per fish, next to a sale that fits (cap raised a little for F2).
  w.cap = 25;
  const t2 = w.handOver([F2, fishId(3)]);
  const { results } = await m.desk.sellBatch({ seller: SELLER, sales: [F2, fishId(3)].map((assetId) => ({ assetId, transferTx: t2 })) });
  assert.equal(results[0].pearls, 10);
  assert.deepEqual(Object.keys(results[1]).sort(), ['assetId', 'code', 'error', 'refundTx', 'refunded', 'retryAfterMs', 'status']);
  assert.deepEqual([results[1].status, results[1].code, results[1].refunded], [429, 'daily-cap', true]);
  assert.equal(w.owners.get(fishId(3)), SELLER);
  for (const id of [F1, fishId(3)]) {
    assert.equal(w.paidFor(id), 0, `${id} never paid`);
    assert.equal(w.sentBack(id), 1, `${id} sent back once`);
  }
  assert.deepEqual(w.burns.sort(), [F0, F2].sort(), 'only the sold fish were burned');
  assert.deepEqual(await m.ledger.unburned(), [], 'nothing left for the sweep');
});

each('other refusals after the transfer keep today\'s behaviour: no record, nothing sent back', async (kind) => {
  const w = world({ values: { [F1]: 999 } }); // over a rare fish's cap: appraise refuses it (422)
  const m = await KINDS[kind](w).make();
  await assert.rejects(m.sell(F1, w.handOver([F1])), (e) => e.status === 422 && e.extra === undefined);
  assert.equal(await m.ledger.get(F1), null);
  assert.equal(w.sentBack(F1), 0);
});

each('the retry of the refused request: the same cap answer, its wait counted down, never priced or paid again', async (kind) => {
  const w = world();
  const m = await KINDS[kind](w).make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  const first = await capAnswer(m.sell(F1, t1), true);
  const priced = w.priced;
  w.skew += 600_000; // ten minutes on
  w.cap = 1_000; // even with room under the cap now, that transfer was answered: it stays refused
  const again = await capAnswer(m.sell(F1, t1), true);
  assert.equal(again.refundTx, first.refundTx);
  assert.ok(Math.abs(first.retryAfterMs - 600_000 - again.retryAfterMs) < 1000, `${first.retryAfterMs} -> ${again.retryAfterMs}`);
  const { results } = await m.desk.sellBatch({ seller: SELLER, sales: [{ assetId: F1, transferTx: t1 }] });
  assert.deepEqual([results[0].status, results[0].refunded, results[0].refundTx], [429, true, first.refundTx]);
  assert.equal(w.priced, priced, 'not priced again');
  assert.equal(w.paidFor(F1), 0);
  assert.equal(w.sentBack(F1), 1);
  // Another wallet naming that transfer is refused outright.
  await assert.rejects(m.sell(F1, t1, OTHER), (e) => e.status === 409);
});

each('handed over again with a new transfer after the refund: a new sale, paid once; the old transfer never pays', async (kind) => {
  const w = world();
  const k = KINDS[kind](w);
  const m = await k.make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  await capAnswer(m.sell(F1, t1), true);
  // Still over the cap: refused and sent back again, the first transfer remembered.
  const t2 = w.handOver([F1]);
  await capAnswer(m.sell(F1, t2), true);
  assert.deepEqual((await m.ledger.get(F1)).refundedTransfers, [t1]);
  assert.equal(w.sentBack(F1), 2);
  assert.deepEqual(w.rounds, [t1, t2], 'each transfer back built for its own round');
  // The window rolled on: the fish sells under a third transfer, on another instance (Redis), twice at once.
  w.cap = 1_000;
  const t3 = w.handOver([F1]);
  const n = await k.make();
  const [a, b] = await Promise.all([m.sell(F1, t3), n.sell(F1, t3)].map((p) => p.catch((e) => e)));
  for (const r of [a, b]) if (r instanceof Error) assert.equal(r.status, 409, r.message); // the other's payout is confirming
  const sold = [a, b].find((r) => !(r instanceof Error));
  assert.equal(sold.pearls, 10);
  assert.equal(w.paidFor(F1), 1, 'paid once');
  assert.deepEqual(sold.extra, [t3, `burn-${F1}`]);
  const rec = await m.ledger.get(F1);
  assert.deepEqual([rec.status, rec.transferTx, rec.refundedTransfers], ['burned', t3, [t1, t2]]);
  // Replays: the old transfers get the stored sale (a fish is sold once), never a second payout.
  for (const t of [t1, t2, t3]) assert.equal((await m.sell(F1, t)).tx, sold.tx);
  assert.equal(w.paidFor(F1), 1);
  assert.equal(w.sentBack(F1), 2);
});

each('a refund pays nothing, so it counts toward no cap: a fish that fits still sells', async (kind) => {
  const w = world({ cap: 20, values: { [F1]: 15 } });
  const m = await KINDS[kind](w).make();
  await soldOne(w, m); // 10 of 20
  await capAnswer(m.sell(F1, w.handOver([F1])), true); // 25 > 20: sent back
  const r = await m.sell(F2, w.handOver([F2])); // 20 of 20 only if F1's 15 does not count
  assert.equal(r.pearls, 10);
  // As the cap reads them (SoldLedger.records; RedisLedger.loadSeller): the refund is not a payment.
  if (m.ledger.loadSeller) await m.ledger.loadSeller(SELLER);
  assert.equal(paidInWindow(m.ledger.records, SELLER), 20);
});

each('two sells of the refused fish at once (two instances on Redis): one transfer back', async (kind) => {
  const w = world();
  const k = KINDS[kind](w);
  const [m, n] = [await k.make(), await k.make()];
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  const tries = [m.sell(F1, t1), n.sell(F1, t1), n.desk.sellBatch({ seller: SELLER, sales: [{ assetId: F1, transferTx: t1 }] })];
  const out = await Promise.allSettled(tries);
  for (const r of out.slice(0, 2)) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.status, 429, r.reason.message);
    assert.equal(r.reason.extra.code, 'daily-cap');
    assert.ok([true, 'pending'].includes(r.reason.extra.refunded));
  }
  assert.deepEqual([out[2].value.results[0].status, out[2].value.results[0].code], [429, 'daily-cap']);
  assert.equal(w.sentBack(F1), 1, 'sent back once');
  assert.equal(w.paidFor(F1), 0);
  assert.equal(w.owners.get(F1), SELLER);
  // Whatever answered 'pending' finds it back now.
  await capAnswer(n.sell(F1, t1), true);
});

each('the transfer back times out and never lands: refunding, never paid; the sweep waits for its expiry, then sends it once more', async (kind) => {
  const w = world({ refundSends: ['lost'] });
  const k = KINDS[kind](w);
  const m = await k.make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  await capAnswer(m.sell(F1, t1), 'pending');
  const rec = await m.ledger.get(F1);
  assert.equal(rec.status, 'refunding');
  assert.match(rec.refundTx, /^back/, 'its signature was kept: it might still land');
  assert.deepEqual(await m.ledger.unburned(), [F1], "on the sweep's list");
  assert.equal(w.owners.get(F1), MARKET);
  // The player's retry: still in flight, nothing sent again.
  await capAnswer(m.sell(F1, t1), 'pending');
  assert.equal(w.sentBack(F1), 1);
  // The sweep (another instance on Redis): too young first, then in flight (409, counted as failed).
  const s = await k.make();
  const young = instance(w, s.ledger, { sweepAheadMs: 0, withSellerLock: undefined });
  assert.deepEqual(await young.sweep.run(), stats({ waiting: 1 }));
  assert.deepEqual(await s.sweep.run(), stats({ failed: 1 }));
  assert.equal(w.sentBack(F1), 1);
  // Its blockhash expired unseen: it can never land, so the sweep sends the fish back once more.
  w.height += 500;
  assert.deepEqual(await s.sweep.run(), stats({ refunded: 1 }));
  assert.equal(w.sentBack(F1), 2);
  assert.equal(w.owners.get(F1), SELLER);
  assert.equal((await m.ledger.get(F1)).status, 'refunded');
  assert.deepEqual(await s.sweep.run(), stats({}), 'nothing left');
  await capAnswer(m.sell(F1, t1), true);
  assert.equal(w.paidFor(F1), 0);
  assert.deepEqual(w.burns, [F0]);
});

each('the transfer back timed out but landed: the sweep asks the chain, marks it refunded and sends nothing', async (kind) => {
  const w = world({ refundSends: ['timeout-landed'] });
  const k = KINDS[kind](w);
  const m = await k.make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  await capAnswer(m.sell(F1, t1), 'pending');
  assert.equal(w.owners.get(F1), SELLER, 'it did go');
  const s = await k.make();
  assert.deepEqual(await s.sweep.run(), stats({ refunded: 1 }));
  assert.equal(w.sentBack(F1), 1, 'not sent again');
  assert.equal((await m.ledger.get(F1)).status, 'refunded');
});

each('the node refused the transfer back: forgotten at once, and the player\'s retry sends it', async (kind) => {
  const w = world({ refundSends: ['rejected'] });
  const m = await KINDS[kind](w).make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  await capAnswer(m.sell(F1, t1), 'pending');
  assert.equal((await m.ledger.get(F1)).refundTx, undefined, 'never submitted: nothing to wait for');
  const extra = await capAnswer(m.sell(F1, t1), true);
  assert.equal(w.sentBack(F1), 2);
  assert.equal(extra.refundTx, (await m.ledger.get(F1)).refundTx);
  assert.equal(w.paidFor(F1), 0);
});

each('the refund landed unseen and the seller handed the fish over again: the chain says so, and it sells as new', async (kind) => {
  const w = world({ refundSends: ['timeout-landed'] });
  const m = await KINDS[kind](w).make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  await capAnswer(m.sell(F1, t1), 'pending');
  w.cap = 1_000;
  const t2 = w.handOver([F1]); // the market holds it again, under a new transfer
  const r = await m.sell(F1, t2);
  assert.equal(r.pearls, 10);
  assert.equal(w.sentBack(F1), 1, 'not sent back a second time');
  assert.equal(w.paidFor(F1), 1);
  assert.deepEqual((await m.ledger.get(F1)).refundedTransfers, [t1]);
});

each('a new transfer while the refund may still land waits (409): nothing paid, nothing sent', async (kind) => {
  const w = world({ refundSends: ['lost'] });
  const m = await KINDS[kind](w).make();
  await soldOne(w, m);
  await capAnswer(m.sell(F1, w.handOver([F1])), 'pending');
  await assert.rejects(m.sell(F1, 'Z'.repeat(88)), (e) => e.status === 409 && /on its way back/.test(e.message));
  assert.equal(w.sentBack(F1), 1);
  assert.equal(w.paidFor(F1), 0);
});

each('past the request\'s deadline no transfer back is sent: refunded \'pending\', and the sweep sends it', async (kind) => {
  const w = world();
  const k = KINDS[kind](w, { batchDeadlineMs: 1000 });
  const m = await k.make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  const load = m.desk; // the price check runs late: move the desks' clock past the deadline as the fish loads
  const real = w.asset;
  w.asset = (id) => {
    if (id === F1) w.skew += 1500;
    return real(id);
  };
  await capAnswer(load.sell({ assetId: F1, seller: SELLER, transferTx: t1 }), 'pending');
  w.asset = real;
  assert.equal(w.sentBack(F1), 0, 'nothing sent after the deadline');
  assert.equal((await m.ledger.get(F1)).status, 'refunding');
  const s = await k.make();
  assert.deepEqual(await s.sweep.run(), stats({ refunded: 1 }));
  assert.equal(w.sentBack(F1), 1);
  assert.equal(w.owners.get(F1), SELLER);
});

const stats = (o) => ({ burned: 0, resumed: 0, refunded: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 0, rateLimited: false, ...o });

test('Redis: the refund record\'s steps, one refund signature on record, and the work list', async () => {
  const redis = createFakeRedis();
  const open = async () => (await createRedisStore({ redis, prefix: 'test:', env: {} }).openMarketState({ cluster: 'devnet' })).ledger;
  const [a, b] = [await open(), await open()];
  const rec = { seller: SELLER, transferTx: 'T1', reason: 'Daily PEARL limit reached', retryAt: 5 };
  const [wa, wb] = await Promise.all([a.refunding(F1, rec, 100), b.refunding(F1, rec, 100)]);
  assert.deepEqual([wa, wb].sort(), [false, true], 'one instance records it');
  assert.deepEqual(await a.get(F1), { ...rec, status: 'refunding', at: 100 });
  assert.deepEqual(await redis.zrange('test:seller:' + SELLER, 0, -1), [], 'a refund is not in the seller\'s index');
  assert.equal(await a.begin(F1, { seller: SELLER, transferTx: 'T2', pearls: 10 }), false, 'no sale over a refund under way');
  assert.deepEqual(await a.unburned(), [F1]);
  await a.refundPending(F1, 'T1', 'back1', 50);
  await a.refundPending(F1, 'T1', 'back1', 50); // its own again: fine
  await assert.rejects(b.refundPending(F1, 'T1', 'back2', 60), (e) => e.status === 409);
  await b.refundDropped(F1, 'back2'); // not the one on record: kept
  assert.equal((await a.get(F1)).refundTx, 'back1');
  assert.equal(await b.refunded(F1, 'T1'), true);
  assert.deepEqual(await a.get(F1), { ...rec, status: 'refunded', at: 100, refundTx: 'back1' });
  assert.deepEqual(await a.unburned(), []);
  assert.equal(await a.plan(F1, SELLER, 'T1'), 'refunded');
  assert.equal(await a.plan(F1, OTHER, 'T2'), 'new');
  // Handed over again: two instances begin it at once, one wins; the transfer sent back is never begun again.
  const [ba, bb] = await Promise.all([a.begin(F1, { seller: SELLER, transferTx: 'T2', pearls: 10 }, 200), b.begin(F1, { seller: SELLER, transferTx: 'T2', pearls: 10 }, 200)]);
  assert.deepEqual([ba, bb].sort(), [false, true]);
  assert.deepEqual(await a.get(F1), { seller: SELLER, transferTx: 'T2', pearls: 10, status: 'paying', at: 200, refundedTransfers: ['T1'] });
  assert.deepEqual(await a.unburned(), [F1]);
  assert.equal(await a.plan(F1, SELLER, 'T2'), 'resume');
});

test('the file ledger: the same steps, and a refunded fish replaced only by a new transfer', () => {
  const l = new SoldLedger();
  const rec = { seller: SELLER, transferTx: 'T1', reason: 'cap', retryAt: 5 };
  assert.equal(l.refunding(F1, rec, 100), true);
  assert.equal(l.refunding(F1, rec, 100), false);
  assert.throws(() => l.begin(F1, { seller: SELLER, transferTx: 'T2', pearls: 1 }), /already in the ledger/);
  assert.equal(l.plan(F1, SELLER, 'T1'), 'refund');
  assert.equal(l.plan(F1, OTHER, 'T1'), 'conflict');
  assert.equal(l.plan(F1, OTHER, 'T2'), 'refund', 'another transfer waits for the refund');
  assert.deepEqual(l.unburned(), [F1]);
  l.refundPending(F1, 'T1', 'back1', 50);
  assert.throws(() => l.refundPending(F1, 'T1', 'back2', 60), (e) => e.status === 409);
  assert.equal(l.refunded(F1, 'T1'), true);
  assert.deepEqual(l.unburned(), []);
  assert.throws(() => l.begin(F1, { seller: SELLER, transferTx: 'T1', pearls: 1 }), /already in the ledger/, 'the transfer sent back never sells');
  l.begin(F1, { seller: SELLER, transferTx: 'T2', pearls: 1 }, 200);
  assert.deepEqual(l.get(F1), { seller: SELLER, transferTx: 'T2', pearls: 1, status: 'paying', at: 200, refundedTransfers: ['T1'] });
  // The cap reads every record, and skips refunds.
  const records = { a: { seller: SELLER, pearls: 9, at: Date.now(), status: 'refunding' }, b: { seller: SELLER, pearls: 9, at: Date.now(), status: 'refunded' } };
  assert.equal(paidInWindow(records, SELLER), 0);
  assert.doesNotThrow(() => checkPayoutCap(records, SELLER, 10, { cap: 10 }));
});

test('the sweep never burns a fish on its way back: refunding is resumed (or waits), refunded is left alone', async () => {
  const l = new SoldLedger();
  l.begin('Paid', { seller: SELLER, transferTx: 'tx', pearls: 1 }, 1);
  l.paid('Paid');
  l.refunding('Back', { seller: SELLER, transferTx: 'tx', reason: 'cap', retryAt: 0 }, 2);
  l.refunding('Raced', { seller: SELLER, transferTx: 'tx', reason: 'cap', retryAt: 0 }, 3);
  const asset = (id) => ({ publicKey: id, owner: MARKET, updateAuthority: { type: 'Collection', address: COLL } });
  const burned = [];
  const resumed = [];
  const fetched = [];
  const listing = l.unburned.bind(l);
  // 'Raced' is sent back by a request between the listing and the sweep's read.
  const ledger = Object.assign(Object.create(l), {
    unburned: (n) => {
      const ids = listing(n);
      l.refunded('Raced', 'tx');
      return ids;
    },
  });
  const make = (resumeRefund) =>
    createSweep({
      collection: () => COLL,
      market: MARKET,
      ledger,
      loadAsset: async (id) => (fetched.push(id), asset(id)),
      burnOnce: async (id) => {
        burned.push(id);
        l.burned(id, 'sig');
      },
      resumeRefund,
      sleep: async () => {},
      now: () => Date.now() + OLD_ENOUGH,
    });
  // Without a refund path: it waits, it is never burned.
  assert.deepEqual(await make(null).run(), stats({ burned: 1, waiting: 1 }));
  assert.deepEqual(burned, ['Paid']);
  assert.deepEqual(fetched, ['Paid'], 'no fetch for the fish on their way back');
  // With one: resumed, still never burned.
  assert.deepEqual(
    await make(async (id) => {
      resumed.push(id);
      l.refunded(id, 'tx');
    }).run(),
    stats({ refunded: 1 }),
  );
  assert.deepEqual(resumed, ['Back']);
  assert.deepEqual(burned, ['Paid']);
  assert.deepEqual(l.unburned(), []);
});

// ---- One refund round never acts on the next. A round is the refund of one transfer (transferTx):
// the fish handed over again under another transfer is a new round, which a late or stalled step of
// the earlier one (another instance) must neither close nor claim.

const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
const LEDGERS = {
  file: async () => new SoldLedger(),
  redis: async () => (await createRedisStore({ redis: createFakeRedis(), prefix: 'test:', env: {} }).openMarketState({ cluster: 'devnet' })).ledger,
};

test('a late "refunded" from the first round never closes the second: the fish handed over again still goes back (Redis, two instances)', async () => {
  const w = world();
  const k = KINDS.redis(w);
  const [a, b] = [await k.make(), await k.make()];
  await soldOne(w, a);
  const slowConfirm = gate();
  const bBuilding = gate();
  const bGo = gate();
  let confirms = 0;
  let builds = 0;
  w.onConfirm = async () => {
    if (++confirms === 1) await slowConfirm.p;
  };
  w.onBuild = async () => {
    if (++builds === 2) {
      bBuilding.open();
      await bGo.p;
    }
  };
  const t1 = w.handOver([F1]);
  const pA = a.sell(F1, t1).catch((e) => e);
  while (w.owners.get(F1) !== SELLER) await tick(); // A's transfer back landed; A still waits on its confirmation
  const t2 = w.handOver([F1]); // handed over again from another device, still over the cap
  const pB = b.sell(F1, t2).catch((e) => e);
  await bBuilding.p; // B found the first refund landed, recorded the second, and is building its transfer back
  assert.deepEqual([(await b.ledger.get(F1)).status, (await b.ledger.get(F1)).transferTx], ['refunding', t2]);
  slowConfirm.open();
  const eA = await pA; // A's confirmation returns now: its "refunded" is for the first round only
  assert.equal(eA.status, 409, eA.message);
  assert.equal(eA.extra?.refunded, undefined, 'A does not answer for the second round');
  assert.equal((await a.ledger.get(F1)).status, 'refunding', 'the second round is still open');
  bGo.open();
  const extra = await capAnswer(Promise.reject(await pB), true);
  assert.equal(w.owners.get(F1), SELLER, 'the fish handed over again went back too');
  const rec = await a.ledger.get(F1);
  assert.deepEqual([rec.status, rec.transferTx, rec.refundTx, rec.refundedTransfers], ['refunded', t2, extra.refundTx, [t1]]);
  assert.equal(w.sentBack(F1), 2);
  assert.equal(w.paidFor(F1), 0);
  assert.deepEqual(await (await k.make()).sweep.run(), stats({}), 'nothing left over');
  await capAnswer(a.sell(F1, t1), true); // the first transfer's retry: it went back
});

test('a stalled first round cannot claim the next one: the fish is never sent to the wallet it left (Redis, three instances)', async () => {
  const w = world();
  const k = KINDS.redis(w);
  const [a, b, c] = [await k.make(), await k.make(), await k.make()];
  await soldOne(w, a);
  const aBuilding = gate();
  const aGo = gate();
  const cBuilding = gate();
  const cGo = gate();
  let builds = 0;
  w.onBuild = async () => {
    const n = ++builds;
    if (n === 1) aBuilding.open(), await aGo.p;
    if (n === 3) cBuilding.open(), await cGo.p;
  };
  const t1 = w.handOver([F1]);
  const pA = a.sell(F1, t1).catch((e) => e);
  await aBuilding.p; // A recorded the refund, read its seller, and stalls before putting its signature on record
  await capAnswer(b.sell(F1, t1), true); // the player's retry on another instance sends it back first
  assert.equal(w.owners.get(F1), SELLER);
  // The seller passes the fish on, and its new owner hands it over, over the cap too.
  w.owners.set(F1, OTHER);
  w.cap = 5;
  const t3 = w.handOver([F1], OTHER);
  const pC = c.sell(F1, t3, OTHER).catch((e) => e);
  await cBuilding.p;
  assert.deepEqual([(await c.ledger.get(F1)).seller, (await c.ledger.get(F1)).transferTx], [OTHER, t3]);
  aGo.open();
  const eA = await pA;
  assert.equal(eA.status, 409, eA.message);
  assert.equal(w.owners.get(F1), MARKET, 'A sent nothing: not to the wallet the fish left');
  assert.equal(w.sentBack(F1), 1);
  cGo.open();
  await capAnswer(Promise.reject(await pC), true);
  assert.equal(w.owners.get(F1), OTHER, 'back with the wallet that handed it over');
  assert.equal(w.sentBack(F1), 2);
  assert.equal(w.paidFor(F1), 0);
});

for (const [kind, open] of Object.entries(LEDGERS)) {
  test(`the ledger's refund steps are scoped to their transfer (${kind} ledger)`, async () => {
    const l = await open();
    const rec = (transferTx) => ({ seller: SELLER, transferTx, reason: 'cap', retryAt: 0 });
    assert.equal(await l.refunding(F1, rec('T1'), 1), true);
    await l.refundPending(F1, 'T1', 'back1', 50);
    assert.equal(await l.refunded(F1, 'T1'), true);
    assert.equal(await l.refunded(F1, 'T1'), true, 'again (another instance): already so');
    assert.equal(await l.refunding(F1, rec('T2'), 2), true, 'handed over again, refused again');
    assert.equal(await l.refunded(F1, 'T1'), false, 'a late step of the first round');
    await assert.rejects(async () => l.refundPending(F1, 'T1', 'back9', 50), (e) => e.status === 409);
    const open2 = await l.get(F1);
    assert.deepEqual([open2.status, open2.transferTx, open2.refundTx], ['refunding', 'T2', undefined], 'the second round untouched');
    assert.deepEqual(await l.unburned(), [F1], "still on the sweep's list");
    await l.refundPending(F1, 'T2', 'back2', 60);
    assert.equal(await l.refunded(F1, 'T2'), true);
    assert.deepEqual(await l.unburned(), []);
    assert.equal((await l.get(F1)).refundTx, 'back2');
  });
}

each('an RPC error other than "no such account" never reads as the fish gone: nothing marked refunded, sent once it clears', async (kind) => {
  const w = world();
  const k = KINDS[kind](w);
  const m = await k.make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  for (const err of [
    Object.assign(new Error('failed to get info about account: Node is behind by 120 slots'), { code: -32005 }),
    Object.assign(new Error('Internal error'), { code: -32603 }),
    new Error('Failed to deserialize the account'),
  ]) {
    w.rpcError = err;
    await capAnswer(m.sell(F1, t1), 'pending');
    assert.equal((await m.ledger.get(F1)).status, 'refunding', err.message);
    assert.deepEqual(await (await k.make()).sweep.run(), stats({ failed: 1 }), err.message);
    assert.equal((await m.ledger.get(F1)).status, 'refunding', err.message);
  }
  assert.equal(w.sentBack(F1), 0);
  assert.equal(w.owners.get(F1), MARKET);
  w.rpcError = null;
  assert.deepEqual(await (await k.make()).sweep.run(), stats({ refunded: 1 }));
  assert.equal(w.owners.get(F1), SELLER);
  assert.equal(w.sentBack(F1), 1);
  await capAnswer(m.sell(F1, t1), true);
});

test('assetOrNull: null only for a fish account that does not exist', async () => {
  const at = umiKey('11111111111111111111111111111111');
  assert.equal(
    await assetOrNull(async () => {
      throw new AccountNotFoundError(at, 'AssetV1'); // as mpl-core's fetchAsset throws it
    }),
    null,
  );
  for (const e of [
    Object.assign(new Error('Node is behind'), { code: -32005 }),
    new Error('Failed to deserialize'),
    new Error('429 Too Many Requests'),
    new AccountNotFoundError(at, 'CollectionV1'), // the collection, not the fish
  ]) {
    await assert.rejects(
      assetOrNull(async () => {
        throw e;
      }),
      (x) => x === e,
    );
  }
});

each('fish that went back unseen and that the player then burned are finished by the sweep, and starve no other', async (kind) => {
  const ids = [1, 2, 3, 4].map(fishId);
  const w = world({ refundSends: ids.map(() => 'timeout-landed') });
  const k = KINDS[kind](w);
  const m = await k.make();
  await soldOne(w, m);
  for (const id of ids) await capAnswer(m.sell(id, w.handOver([id])), 'pending'); // each back with the seller, its round still 'refunding'
  for (const id of ids) assert.equal(w.owners.get(id), SELLER);
  // The player burns the three oldest from their wallet before the sweep gets to them.
  for (const id of ids.slice(0, 3)) {
    w.burnedByPlayer.add(id);
    w.owners.delete(id);
  }
  const runs = [];
  for (let i = 0; i < 2; i++) runs.push(await (await k.make()).sweep.run());
  assert.deepEqual(
    runs.map((r) => [r.refunded, r.failed]),
    [
      [3, 0],
      [1, 0],
    ],
    "three a run (the sweep's resume budget), none failing",
  );
  for (const id of ids) assert.equal((await m.ledger.get(id)).status, 'refunded', id);
  assert.equal(w.sentBack(ids[0]), 1, 'nothing sent again');
  await capAnswer(m.sell(ids[0], (await m.ledger.get(ids[0])).transferTx), true);
});

test('assetOrNull: a burned fish (the 1-byte account a Core burn leaves) is null; any other undecodable account throws', async () => {
  const id = fishId(1);
  const decode = (acct) => () => Promise.resolve().then(() => deserializeAssetV1(acct));
  assert.equal(await assetOrNull(decode(burnedStub(id)), async () => burnedStub(id)), null);
  const junk = { ...burnedStub(id), data: Uint8Array.of(7, 7) }; // a live Core account that does not decode as an asset
  await assert.rejects(assetOrNull(decode(junk), async () => junk), (e) => e.name === 'UnexpectedAccountError');
  await assert.rejects(assetOrNull(decode(burnedStub(id))), (e) => e.name === 'UnexpectedAccountError', 'no raw read to check with: throws');
  const down = new Error('Node is behind');
  await assert.rejects(
    assetOrNull(decode(burnedStub(id)), async () => {
      throw down;
    }),
    (e) => e === down,
  );
});

test('two refund rounds of one fish to one seller under one blockhash are two different transactions', async () => {
  const u = createUmi('http://127.0.0.1:1'); // offline: nothing here touches the RPC
  u.use(keypairIdentity(u.eddsa.generateKeypair()));
  const seller = u.eddsa.generateKeypair().publicKey; // the wallet the fish goes back to
  const asset = { publicKey: umiKey(fishId(1)), owner: u.identity.publicKey, updateAuthority: { type: 'Address', address: u.identity.publicKey } };
  const blockhash = { blockhash: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM', lastValidBlockHeight: 100 };
  const sig = async (builder) => (await builder.setBlockhash(blockhash).buildAndSign(u)).signatures[0].join(',');
  assert.equal(typeof serverMode.refundTransfer, 'function', 'market-server-mode.mjs builds the transfer back with refundTransfer');
  const round = (transferTx) => sig(serverMode.refundTransfer(u, { asset, seller, transferTx }));
  // The bare transfer is the same bytes, so the same signature, every time: a second round's would be "already processed".
  const bare = () => sig(transfer(u, { asset, newOwner: seller }));
  assert.equal(await bare(), await bare());
  const [t1, t2] = ['A'.repeat(88), 'B'.repeat(88)];
  assert.notEqual(await round(t1), await round(t2), 'each names its own transfer');
  assert.equal(await round(t1), await round(t1), 'a rebuild of one round is the same transaction');
});

each('the chain unreadable while a new transfer waits on the last refund: a 409 to try again, not a 500', async (kind) => {
  const w = world({ refundSends: ['rejected'] }); // never submitted: no signature on record, so the fish is looked up
  const m = await KINDS[kind](w).make();
  await soldOne(w, m);
  const t1 = w.handOver([F1]);
  await capAnswer(m.sell(F1, t1), 'pending');
  w.rpcError = Object.assign(new Error('Node is behind'), { code: -32005 });
  const t2 = w.handOver([F1]);
  await assert.rejects(m.sell(F1, t2), (e) => e.status === 409 && /on its way back/.test(e.message));
  const { results } = await m.desk.sellBatch({ seller: SELLER, sales: [{ assetId: F1, transferTx: t2 }] });
  assert.equal(results[0].status, 409, results[0].error);
  assert.deepEqual([(await m.ledger.get(F1)).status, (await m.ledger.get(F1)).transferTx], ['refunding', t1], 'left for the sweep');
  assert.equal(w.paidFor(F1), 0);
});

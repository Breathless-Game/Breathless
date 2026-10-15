import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, MAX_BATCH, MAX_BATCH_TXS, MPL_CORE_PROGRAM, RateLimiter, SoldLedger, appraise, parseQuoteBatchBody, parseSellBatchBody, withLock } from './market-rules.mjs';
import { createPayout } from './market-payout.mjs';
import { createSaleDesk, poll, quoteMany } from './market-sale.mjs';
import { createSweep } from './market-burn.mjs';

// The desk's price gate without the collection check (fish-trust.test.mjs covers that): the on-chain value.
const plainPrice = (asset) => {
  const a = appraise(asset.attributes?.attributeList);
  if (!a.ok) throw new HttpError(422, a.reason);
  return a.pearls;
};

// Server mode's batch sale, driven with a fake chain: one transaction moving several fish, the
// same transaction replayed, fish that are not in it, the wrong seller, and concurrent duplicates.

const SELLER = 'Se11er111111111111111111111111111111111111';
const OTHER = 'Stranger11111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const fish = (n) => `Fish${String(n).replace(/0/g, 'z')}`.padEnd(43, '1');
const [A, B, C, D] = [1, 2, 3, 4].map(fish);
const sig = (n) => String(n).repeat(88);
const TX = sig(5);
const TX_OTHER = sig(6);

/**
 * A confirmed transaction in umi's shape. `signers` sign it (the first pays); each move is a Core
 * TransferV1 { asset, authority } to `to`, with the collection, authority (when omitted) and the
 * optional accounts filled with Core's program id as umi does.
 */
function transferTx({ signers = [SELLER], moves, to = MARKET, err = null }) {
  const accounts = [...signers, to, MPL_CORE_PROGRAM];
  const at = (k) => {
    if (!accounts.includes(k)) accounts.push(k);
    return accounts.indexOf(k);
  };
  const core = at(MPL_CORE_PROGRAM);
  const instructions = moves.map(({ asset, authority }) => ({
    programIndex: core,
    accountIndexes: [at(asset), core, 0, authority ? at(authority) : core, at(to), core, core],
    data: Uint8Array.of(14, 0),
  }));
  return { message: { header: { numRequiredSignatures: signers.length }, accounts, instructions }, meta: { err, loadedAddresses: { writable: [], readonly: [] } } };
}

const attrs = (rarity, value) => [
  { key: 'rarity', value: rarity },
  { key: 'depth', value: '5' },
  { key: 'value', value: String(value) },
];

/** No fish in these desks is ever sent back (market-refund.test.mjs covers that). */
const noRefund = { refund: async () => assert.fail('nothing is sent back here'), resolveRefund: async () => assert.fail('nothing is sent back here') };

/** A fake market: the chain (transactions, asset owners), the ledger and every payment made. A refund moves the fish back at once. */
function setup({ txs = {}, owners = {}, values = {}, payDelayMs = 0, priceFish = plainPrice } = {}) {
  const ledger = new SoldLedger();
  const payments = [];
  const burns = [];
  const refunds = [];
  let fetches = 0;
  let paySeq = 0;
  const desk = createSaleDesk({
    priceFish,
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: async (s) => {
      fetches++;
      return txs[s] ?? null;
    },
    loadMarketAsset: async (id) => (id in owners ? { owner: owners[id], attributes: { attributeList: attrs('common', values[id] ?? 1) } } : null),
    resolvePending: async (id) => (ledger.get(id).payTx ? 'paid' : 'unpaid'),
    pay: async (id, mint, seller, pearls) => {
      ledger.payPending(id, `pay-${++paySeq}`, 100);
      if (payDelayMs) await new Promise((r) => setTimeout(r, payDelayMs));
      payments.push({ id, seller, pearls });
      ledger.paid(id);
    },
    burnSold: async (id) => {
      burns.push(id);
      ledger.burned(id, `burn-${id}`);
    },
    refund: async (id, transferTx) => {
      refunds.push(id);
      ledger.refundPending(id, transferTx, `back-${id}`, 100);
      owners[id] = ledger.get(id).seller;
      ledger.refunded(id, transferTx);
      return `back-${id}`;
    },
    resolveRefund: async (id) => (owners[id] === MARKET ? 'unrefunded' : (ledger.refunded(id, ledger.get(id).transferTx), 'refunded')),
  });
  return { desk, ledger, payments, burns, refunds, fetches: () => fetches };
}

const batch = (sales, seller = SELLER) => ({ seller, sales: sales.map(([assetId, transferTx = TX]) => ({ assetId, transferTx })) });
const paidTo = (payments) => Object.fromEntries(payments.map((p) => [p.id, p.pearls]));

test('one transaction moving three fish: each fish is paid once, at its own on-chain value', async () => {
  const m = setup({
    txs: { [TX]: transferTx({ moves: [{ asset: A }, { asset: B }, { asset: C }] }) },
    owners: { [A]: MARKET, [B]: MARKET, [C]: MARKET },
    values: { [A]: 1, [B]: 2, [C]: 3 },
  });
  const { results } = await m.desk.sellBatch(batch([[A], [B], [C]]));
  assert.deepEqual(
    results.map((r) => [r.assetId, r.pearls, r.extra[0]]),
    [
      [A, 1, TX],
      [B, 2, TX],
      [C, 3, TX],
    ],
  );
  assert.deepEqual(paidTo(m.payments), { [A]: 1, [B]: 2, [C]: 3 });
  assert.equal(m.payments.length, 3);
  assert.ok(m.payments.every((p) => p.seller === SELLER));
  assert.equal(new Set(results.map((r) => r.tx)).size, 3, 'a pay transaction per fish');
  assert.deepEqual(m.burns.sort(), [A, B, C].sort());
  assert.equal(m.fetches(), 1, 'the shared transfer is fetched once per batch');
});

test('a price in the request is ignored: the market pays the on-chain value', async () => {
  const m = setup({ txs: { [TX]: transferTx({ moves: [{ asset: A }] }) }, owners: { [A]: MARKET }, values: { [A]: 2 } });
  const body = batch([[A]]);
  body.sales[0].pearls = 9999;
  body.pearls = 9999;
  const { results } = await m.desk.sellBatch(body);
  assert.equal(results[0].pearls, 2);
  assert.deepEqual(paidTo(m.payments), { [A]: 2 });
});

test('replaying the same transaction (batch or single /sell) returns the stored results and pays nothing more', async () => {
  const m = setup({
    txs: { [TX]: transferTx({ moves: [{ asset: A }, { asset: B }] }) },
    owners: { [A]: MARKET, [B]: MARKET },
  });
  const first = await m.desk.sellBatch(batch([[A], [B]]));
  const again = await m.desk.sellBatch(batch([[A], [B]]));
  assert.deepEqual(again, first);
  const single = await m.desk.sell({ assetId: B, seller: SELLER, transferTx: TX });
  assert.deepEqual({ assetId: B, ...single }, first.results[1]);
  assert.equal(m.payments.length, 2);
});

test('a fish that is not in the named transaction is refused, and the rest of the batch still sells', async () => {
  const m = setup({
    txs: { [TX]: transferTx({ moves: [{ asset: A }, { asset: B }] }) },
    // D is even owned by the market (sold in some other transaction), but TX did not move it.
    owners: { [A]: MARKET, [B]: MARKET, [D]: MARKET },
  });
  const { results } = await m.desk.sellBatch(batch([[A], [D], [B]]));
  assert.equal(results[0].pearls, 1);
  assert.equal(results[1].status, 400);
  assert.match(results[1].error, /not a transfer of this asset/);
  assert.equal(results[2].pearls, 1);
  assert.deepEqual(Object.keys(paidTo(m.payments)).sort(), [A, B].sort());
  assert.equal(m.ledger.get(D), null, 'nothing is recorded for the refused fish');
});

test('a transfer to someone else, a failed transfer, or a missing one never pays', async () => {
  const m = setup({
    txs: {
      [TX]: transferTx({ moves: [{ asset: A }], to: OTHER }),
      [TX_OTHER]: transferTx({ moves: [{ asset: B }], err: { InstructionError: [0, 'x'] } }),
    },
    owners: { [A]: MARKET, [B]: MARKET, [C]: MARKET },
  });
  const { results } = await m.desk.sellBatch(batch([[A, TX], [B, TX_OTHER]]));
  assert.match(results[0].error, /not a transfer of this asset/);
  assert.match(results[1].error, /failed on-chain/);
  const missing = await m.desk.sellBatch(batch([[C, sig(7)]]));
  assert.match(missing.results[0].error, /not found/);
  assert.equal(m.payments.length, 0);
});

test('the wrong seller: someone who did not sign, or a co-signer who did not own the fish, is refused', async () => {
  const m = setup({
    txs: {
      [TX]: transferTx({ moves: [{ asset: A }, { asset: B }] }),
      // OTHER paid the fee and signed, but SELLER was the authority that let C go.
      [TX_OTHER]: transferTx({ signers: [OTHER, SELLER], moves: [{ asset: C, authority: SELLER }] }),
    },
    owners: { [A]: MARKET, [B]: MARKET, [C]: MARKET },
  });
  const stranger = await m.desk.sellBatch(batch([[A], [B]], OTHER));
  assert.ok(stranger.results.every((r) => r.status === 400 && /not signed by the seller/.test(r.error)));
  const coSigner = await m.desk.sellBatch(batch([[C, TX_OTHER]], OTHER));
  assert.equal(coSigner.results[0].status, 400);
  assert.match(coSigner.results[0].error, /seller did not transfer this fish/);
  assert.equal(m.payments.length, 0);
  // The real owner can still sell all three.
  const owner = await m.desk.sellBatch(batch([[A], [B], [C, TX_OTHER]]));
  assert.ok(owner.results.every((r) => r.pearls === 1));
  // And once sold, another wallet is told so.
  const late = await m.desk.sellBatch(batch([[A]], OTHER));
  assert.equal(late.results[0].status, 409);
  assert.equal(m.payments.length, 3);
});

test('the market must own the fish now, even when the transaction moved it', async () => {
  const m = setup({ txs: { [TX]: transferTx({ moves: [{ asset: A }] }) }, owners: { [A]: SELLER } });
  const { results } = await m.desk.sellBatch(batch([[A]]));
  assert.match(results[0].error, /does not own this fish/);
  assert.equal(m.payments.length, 0);
});

test('concurrent duplicate requests (batches and singles, overlapping) pay every fish exactly once', async () => {
  const m = setup({
    txs: { [TX]: transferTx({ moves: [{ asset: A }, { asset: B }, { asset: C }] }) },
    owners: { [A]: MARKET, [B]: MARKET, [C]: MARKET },
    values: { [A]: 1, [B]: 2, [C]: 3 },
    payDelayMs: 15,
  });
  const runs = await Promise.all([
    m.desk.sellBatch(batch([[A], [B], [C]])),
    m.desk.sellBatch(batch([[C], [B], [A]])),
    m.desk.sellBatch(batch([[B], [C]])),
    m.desk.sell({ assetId: A, seller: SELLER, transferTx: TX }).then((r) => ({ results: [{ assetId: A, ...r }] })),
    m.desk.sell({ assetId: C, seller: SELLER, transferTx: TX }).then((r) => ({ results: [{ assetId: C, ...r }] })),
  ]);
  assert.equal(m.payments.length, 3);
  assert.deepEqual(paidTo(m.payments), { [A]: 1, [B]: 2, [C]: 3 });
  // Every request saw the same, successful result for each fish.
  const byFish = new Map();
  for (const { results } of runs) {
    for (const r of results) {
      assert.equal(r.error, undefined, `${r.assetId}: ${r.error}`);
      if (byFish.has(r.assetId)) assert.deepEqual(r, byFish.get(r.assetId));
      else byFish.set(r.assetId, r);
    }
  }
  assert.equal(byFish.size, 3);
});

test('a payment that fails for one fish leaves the others paid, and a retry pays only that fish', async () => {
  const m = setup({
    txs: { [TX]: transferTx({ moves: [{ asset: A }, { asset: B }] }) },
    owners: { [A]: MARKET, [B]: MARKET },
  });
  let failB = true;
  // Swap in a pay that drops B's first payment (rejected in preflight).
  const ledger = m.ledger;
  const payments = [];
  const desk = createSaleDesk({
    priceFish: plainPrice,
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: async () => transferTx({ moves: [{ asset: A }, { asset: B }] }),
    loadMarketAsset: async () => ({ owner: MARKET, attributes: { attributeList: attrs('common', 1) } }),
    resolvePending: async (id) => (ledger.get(id).payTx ? 'paid' : 'unpaid'),
    pay: async (id, mint, seller, pearls) => {
      if (id === B && failB) {
        failB = false;
        throw new Error('blockhash not found');
      }
      ledger.payPending(id, `pay-${id}`, 1);
      payments.push(id);
      ledger.paid(id);
    },
    burnSold: async (id) => ledger.burned(id, `burn-${id}`),
    ...noRefund,
  });
  const first = await desk.sellBatch(batch([[A], [B]]));
  assert.equal(first.results[0].pearls, 1);
  assert.equal(first.results[1].status, 500);
  assert.equal(ledger.plan(B, SELLER), 'resume');
  const second = await desk.sellBatch(batch([[A], [B]]));
  assert.ok(second.results.every((r) => r.pearls === 1));
  assert.deepEqual(payments, [A, B]);
});

test('batch bodies: non-empty, at most MAX_BATCH, no fish twice, well-formed ids and signatures', () => {
  assert.deepEqual(parseSellBatchBody(batch([[A], [B]])), batch([[A], [B]]));
  assert.throws(() => parseSellBatchBody(null), /JSON object/);
  assert.throws(() => parseSellBatchBody({ seller: SELLER, sales: [] }), /non-empty/);
  assert.throws(() => parseSellBatchBody(batch([[A], [A]])), /twice/);
  assert.throws(() => parseSellBatchBody(batch([[A, 'abc']])), /transferTx/);
  assert.throws(() => parseSellBatchBody(batch([['not base58 0OIl']])), /assetId/);
  assert.throws(() => parseSellBatchBody({ ...batch([[A]]), seller: 7 }), /seller/);
  const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => [fish(i + 10)]);
  assert.throws(() => parseSellBatchBody(batch(many)), /At most/);
  assert.equal(parseSellBatchBody(batch(many.slice(0, MAX_BATCH))).sales.length, MAX_BATCH);
  assert.deepEqual(parseQuoteBatchBody({ seller: SELLER, assetIds: [A, B] }), { seller: SELLER, assetIds: [A, B] });
  assert.throws(() => parseQuoteBatchBody({ seller: SELLER, assetIds: [A, A] }), /twice/);
  assert.throws(() => parseQuoteBatchBody({ seller: SELLER, assetIds: 'A' }), /non-empty array/);
});

test('quoteMany answers per fish and keeps the order', async () => {
  const quote = async ({ assetId }) => {
    if (assetId === B) throw new HttpError(410, 'gone');
    return { pearls: assetId === A ? 1 : 3 };
  };
  const { quotes } = await quoteMany({ seller: SELLER, assetIds: [A, B, C] }, quote);
  assert.deepEqual(quotes, [
    { assetId: A, pearls: 1 },
    { assetId: B, status: 410, error: 'gone' },
    { assetId: C, pearls: 3 },
  ]);
});

test('a daily-cap refusal keeps its code and retryAfterMs per fish in /sell-batch and /quote-batch, as /sell does', async () => {
  const capped = () => new HttpError(429, 'Daily PEARL limit reached', { code: 'daily-cap', retryAfterMs: 3_600_000, assetId: 'not-this-one' });
  const m = setup({
    txs: { [TX]: transferTx({ moves: [{ asset: A }, { asset: B }] }) },
    owners: { [A]: MARKET, [B]: MARKET },
    priceFish: (asset) => {
      if (asset.attributes.attributeList.find((x) => x.key === 'value').value === '2') throw capped();
      return plainPrice(asset);
    },
    values: { [A]: 1, [B]: 2 },
  });
  const { results } = await m.desk.sellBatch(batch([[A], [B]]));
  assert.equal(results[0].pearls, 1);
  // The market held B already, so it went back to the seller (market-refund.test.mjs has the rest).
  // Its wait is counted from the answer, a few ms after the price check that gave it.
  const { retryAfterMs, ...back } = results[1];
  assert.ok(retryAfterMs > 3_600_000 - 1000 && retryAfterMs <= 3_600_000, `retryAfterMs ${retryAfterMs}`);
  assert.deepEqual(back, { assetId: B, status: 429, error: 'Daily PEARL limit reached', code: 'daily-cap', refunded: true, refundTx: `back-${B}` });
  assert.deepEqual(paidTo(m.payments), { [A]: 1 });
  assert.deepEqual(m.refunds, [B]);
  // Other refusals keep their shape: no extra fields.
  const { quotes } = await quoteMany({ seller: SELLER, assetIds: [A, B, C] }, async ({ assetId }) => {
    if (assetId === A) throw capped();
    if (assetId === B) throw new HttpError(410, 'gone');
    return { pearls: 3 };
  });
  assert.deepEqual(quotes, [
    { assetId: A, status: 429, error: 'Daily PEARL limit reached', code: 'daily-cap', retryAfterMs: 3_600_000 },
    { assetId: B, status: 410, error: 'gone' },
    { assetId: C, pearls: 3 },
  ]);
});

test('withLock runs same-key calls one after another, other keys in parallel, and survives a failure', async () => {
  const locks = new Map();
  const log = [];
  const job = (key, name, ms, fail = false) =>
    withLock(locks, key, async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    });
  const results = await Promise.allSettled([job('a', 'a1', 20, true), job('a', 'a2', 5), job('b', 'b1', 5)]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'fulfilled', 'fulfilled'],
  );
  assert.ok(log.indexOf('end a1') < log.indexOf('start a2'), 'a2 waits for a1');
  assert.ok(log.indexOf('start b1') < log.indexOf('end a1'), 'b1 does not wait for a1');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(locks.size, 0);
});

test('rate limiter: a batch can cost more than one hit', () => {
  const rl = new RateLimiter({ limit: 5, windowMs: 1000 });
  assert.equal(rl.allow('a', 0), true);
  assert.equal(rl.allow('a', 1, 4), true);
  assert.equal(rl.allow('a', 2), false);
});

// ---- RPC amplification: a batch names at most MAX_BATCH_TXS transfers, each fetched (polled) once.

/**
 * A desk whose fetchTransfer is the real poll() over a fake getTransaction that counts its calls:
 * a known transfer is "not found" for its first `lagPolls` calls (still confirming), an unknown one forever.
 */
function pollingSetup({ txs = {}, owners = {}, lagPolls = 0 } = {}) {
  const ledger = new SoldLedger();
  const rpcCalls = new Map();
  const getTransaction = async (s) => {
    const n = (rpcCalls.get(s) ?? 0) + 1;
    rpcCalls.set(s, n);
    return s in txs && n > lagPolls ? txs[s] : null;
  };
  const payments = [];
  const desk = createSaleDesk({
    priceFish: plainPrice,
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: (s) => poll(() => getTransaction(s), (t) => t !== null, 6, 0),
    loadMarketAsset: async (id) => (id in owners ? { owner: owners[id], attributes: { attributeList: attrs('common', 1) } } : null),
    resolvePending: async (id) => (ledger.get(id).payTx ? 'paid' : 'unpaid'),
    pay: async (id) => {
      ledger.payPending(id, `pay-${id}`, 100);
      payments.push(id);
      ledger.paid(id);
    },
    burnSold: async (id) => ledger.burned(id, `burn-${id}`),
    ...noRefund,
  });
  const total = () => [...rpcCalls.values()].reduce((a, b) => a + b, 0);
  return { desk, payments, rpcCalls, total };
}

const twentyFour = Array.from({ length: MAX_BATCH }, (_, i) => fish(i + 10));
const fakeSig = (i) => String(i + 1).replace(/0/g, 'z').padStart(88, '9');

test('sell-batch: 3 distinct transferTx in one request is a 400, before any RPC', async () => {
  const m = pollingSetup();
  const body = batch([[A, TX], [B, TX_OTHER], [C, sig(7)]]);
  const is400 = (e) => e instanceof HttpError && e.status === 400 && /At most 2 different transferTx/.test(e.message);
  assert.equal(MAX_BATCH_TXS, 2);
  assert.throws(() => parseSellBatchBody(body), is400);
  await assert.rejects(m.desk.sellBatch(body), is400);
  // The reviewer's case: 24 fish over 24 made-up signatures (was ~144 RPCs) is refused the same way.
  await assert.rejects(m.desk.sellBatch(batch(twentyFour.map((id, i) => [id, fakeSig(i)]))), is400);
  assert.equal(m.total(), 0, 'no transfer was looked up');
});

test('sell-batch: 24 fish over 2 transfers sell, and each transfer is polled once for the whole batch', async () => {
  const [first, second] = [twentyFour.slice(0, 20), twentyFour.slice(20)]; // the client packs 20 fish per transfer
  const m = pollingSetup({
    txs: {
      [TX]: transferTx({ moves: first.map((asset) => ({ asset })) }),
      [TX_OTHER]: transferTx({ moves: second.map((asset) => ({ asset })) }),
    },
    owners: Object.fromEntries(twentyFour.map((id) => [id, MARKET])),
    lagPolls: 2, // each transfer is "not found" twice before it shows up
  });
  const { results } = await m.desk.sellBatch(batch(twentyFour.map((id, i) => [id, i < 20 ? TX : TX_OTHER])));
  assert.ok(results.every((r) => r.pearls === 1), JSON.stringify(results.find((r) => r.error)));
  assert.equal(m.payments.length, MAX_BATCH);
  assert.deepEqual(Object.fromEntries(m.rpcCalls), { [TX]: 3, [TX_OTHER]: 3 }, 'one poll sequence per transfer, not per fish');
});

test('sell-batch: 24 fish naming 2 made-up transfers cost 2 poll sequences (12 RPCs), not 24', async () => {
  const m = pollingSetup();
  const { results } = await m.desk.sellBatch(batch(twentyFour.map((id, i) => [id, i % 2 ? TX : TX_OTHER])));
  assert.ok(results.every((r) => r.status === 400 && /not found/.test(r.error)));
  assert.equal(m.total(), 12);
  assert.equal(m.payments.length, 0);
});

/**
 * A desk on a clock the test moves, with the real payout (market-payout.mjs) over a fake chain.
 * `hooks.fetch` / `hooks.confirm` / `hooks.mint` run as the asset is loaded, as a payout confirms
 * and as a sale (or resume) starts paying (to move the clock); the test may swap them.
 */
function deadlineSetup({ onFetch = () => {}, onConfirm = () => {} } = {}) {
  const hooks = { fetch: onFetch, confirm: onConfirm, mint: () => {} };
  const clock = { t: 1_000_000 };
  const ledger = new SoldLedger();
  const sent = [];
  const burns = [];
  let seq = 0;
  const payout = createPayout({
    ledger,
    build: async (assetId) => ({ sig: `pay-${++seq}`, lastValid: 500, assetId }),
    send: async (built) => {
      sent.push(built.assetId);
    },
    confirm: async () => {
      hooks.confirm(clock);
      return null;
    },
    getSignatureStatus: async () => null,
    getBlockHeight: async () => 100,
  });
  const desk = createSaleDesk({
    priceFish: plainPrice,
    ledger,
    market: MARKET,
    ensureMint: async () => {
      hooks.mint(clock);
      return 'PearlMint';
    },
    fetchTransfer: async () => transferTx({ moves: [{ asset: A }, { asset: B }] }),
    loadMarketAsset: async () => {
      hooks.fetch(clock);
      return { owner: MARKET, attributes: { attributeList: attrs('common', 3) } };
    },
    resolvePending: payout.resolvePending,
    pay: payout.pay,
    burnSold: async (id) => {
      burns.push(id);
      ledger.burned(id, `burn-${id}`);
    },
    ...noRefund,
    batchDeadlineMs: 1000,
    now: () => clock.t,
  });
  return { desk, ledger, sent, burns, clock, hooks };
}

test('deadline: past it before the payout, /sell and /sell-batch answer 503 and send nothing; the retry pays once', async () => {
  // Fetching the fish took longer than the request has.
  const m = deadlineSetup({ onFetch: (c) => (c.t += 1500) });
  await assert.rejects(m.desk.sell({ assetId: A, seller: SELLER, transferTx: TX }), (e) => e instanceof HttpError && e.status === 503 && /sell this fish again/.test(e.message));
  const { results } = await m.desk.sellBatch(batch([[B]]));
  assert.deepEqual(results, [{ assetId: B, status: 503, error: 'Out of time for this request, sell this fish again' }]);
  assert.deepEqual(m.sent, [], 'no payout sent');
  for (const id of [A, B]) {
    assert.equal(m.ledger.get(id).status, 'paying');
    assert.equal(m.ledger.get(id).payTx, undefined, 'no payout recorded either');
  }
  // The game sells them again with a fresh deadline: resumed (no new fetch), paid once, burned.
  assert.equal((await m.desk.sell({ assetId: A, seller: SELLER, transferTx: TX })).pearls, 3);
  assert.equal((await m.desk.sellBatch(batch([[B]]))).results[0].pearls, 3);
  assert.deepEqual(m.sent, [A, B]);
  assert.deepEqual(m.burns, [A, B]);
});

test('deadline: a payout sent before it is still confirmed and recorded; only the burn is left to the sweep', async () => {
  // The confirmation comes back after the deadline.
  const m = deadlineSetup({ onConfirm: (c) => (c.t += 1500) });
  const r = await m.desk.sell({ assetId: A, seller: SELLER, transferTx: TX });
  assert.equal(r.pearls, 3);
  assert.equal(r.tx, 'pay-1', 'the payout that went out is the one on record');
  assert.equal(m.ledger.get(A).status, 'paid', 'confirmed, not dropped');
  assert.deepEqual(m.burns, [], 'no burn sent after the deadline');
  assert.deepEqual(m.ledger.unburned(), [A], "on the sweep's list");
  // A retry answers the same sale, pays nothing more and burns it.
  const again = await m.desk.sell({ assetId: A, seller: SELLER, transferTx: TX });
  assert.equal(again.tx, 'pay-1');
  assert.deepEqual(m.sent, [A]);
  assert.deepEqual(m.burns, [A]);
});

test('deadline: a sweep resuming a stalled sale near its deadline sends no payout after it; the next sweep pays once', async () => {
  const m = deadlineSetup({ onFetch: (c) => (c.t += 1500) });
  await assert.rejects(m.desk.sell({ assetId: A, seller: SELLER, transferTx: TX }), (e) => e.status === 503);
  assert.equal(m.ledger.get(A).status, 'paying');
  m.clock.t = Date.now() + 1000; // the ledger stamps the sale with the real clock: the sweep's sees it as old enough
  const sweep = createSweep({
    collection: () => 'Coll',
    market: MARKET,
    ledger: m.ledger,
    loadAsset: async () => assert.fail('only the stalled sale is on the list'),
    burnOnce: async () => assert.fail('the desk burns a resumed sale'),
    resumeSale: (assetId, r, deadline) => m.desk.sellAsset({ assetId, seller: r.seller, transferTx: r.transferTx }, undefined, deadline),
    resumeAfterMs: 0,
    sleep: async () => {},
    now: () => m.clock.t,
  });
  // The resume starts in time, but the sweep's deadline passes before its payout would go out.
  m.hooks.mint = (c) => (c.t += 1500);
  assert.deepEqual(await sweep.run({ deadlineMs: 1000 }), { burned: 0, resumed: 0, refunded: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 1, rateLimited: false, outOfTime: true });
  assert.deepEqual(m.sent, [], 'no payout sent');
  assert.equal(m.ledger.get(A).status, 'paying');
  // The next sweep has the time: paid once, burned.
  m.hooks.mint = () => {};
  assert.deepEqual(await sweep.run({ deadlineMs: 1000 }), { burned: 0, resumed: 1, refunded: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 0, rateLimited: false, outOfTime: false });
  assert.deepEqual(m.sent, [A]);
  assert.deepEqual(m.burns, [A]);
});

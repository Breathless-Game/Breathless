import assert from 'node:assert/strict';
import test from 'node:test';
import { createBurnRetry } from './market-burn.mjs';
import { createPayout } from './market-payout.mjs';
import { HttpError, MPL_CORE_PROGRAM, SoldLedger, appraise } from './market-rules.mjs';
import { createSaleDesk, poll } from './market-sale.mjs';
import { guardRpc } from './rpc-guard.mjs';

// The 2026-10-11 incident, replayed against a fake chain: one wallet bulk-sells 18 fish while the
// RPC answers 429 to a share of the calls. The sale desk, payout and burns run through the real
// rpc-guard (limiter, backoff, polled confirmations), so this checks the pieces together:
// bounded concurrency, a correct per-fish result, every fish paid exactly once, failed burns
// retried, and no unhandled rejection.

const SELLER = 'Se11er111111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const TX = '5'.repeat(88);
const FISH = [...'ABCDEFGHJKLMNPQRST'].map((c) => `Fish${c}`.padEnd(43, '1')); // base58: no I or O
const tick = () => new Promise((r) => setImmediate(r));
const RATE_LIMITED = () => new Error('429 Too Many Requests:  {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}}');

const plainPrice = (asset) => {
  const a = appraise(asset.attributes?.attributeList);
  if (!a.ok) throw new HttpError(422, a.reason);
  return a.pearls;
};

/** One confirmed transaction in which the seller moved every fish to the market (umi's shape). */
function transferOfAll(fish) {
  const accounts = [SELLER, MARKET, MPL_CORE_PROGRAM, ...fish];
  const core = 2;
  return {
    message: {
      header: { numRequiredSignatures: 1 },
      accounts,
      instructions: fish.map((_, i) => ({ programIndex: core, accountIndexes: [3 + i, core, 0, core, 1, core, core], data: Uint8Array.of(14, 0) })),
    },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
  };
}

/**
 * A fake chain behind a fake umi RPC. `rateLimit(name, n, args)` returns true to answer that call
 * with a 429. Pay and burn transactions land when sent (a resend of one signature lands once).
 */
function fakeChain(rateLimit = () => false) {
  const calls = {};
  const landed = new Map(); // sig -> tx
  const owners = new Map(FISH.map((f) => [f, MARKET]));
  let height = 10;
  let active = 0;
  let peak = 0;
  const fn = (name, impl) => async (...args) => {
    const n = (calls[name] = (calls[name] ?? 0) + 1);
    active++;
    peak = Math.max(peak, active);
    try {
      await tick();
      if (rateLimit(name, n, args)) throw RATE_LIMITED();
      return await impl(...args);
    } finally {
      active--;
    }
  };
  const rpc = {
    getEndpoint: () => 'http://fake',
    getCluster: () => 'custom',
    getTransaction: fn('getTransaction', async (sig) => (sig === TX ? transferOfAll(FISH) : null)),
    getAccount: fn('getAccount', async (id) =>
      owners.has(id) ? { owner: owners.get(id), attributes: { attributeList: [{ key: 'rarity', value: 'rare' }, { key: 'depth', value: '5' }, { key: 'value', value: '10' }] } } : null,
    ),
    getLatestBlockhash: fn('getLatestBlockhash', async () => ({ blockhash: `bh${Math.floor(height / 100)}`, lastValidBlockHeight: Math.floor(height / 100) * 100 + 99 })),
    sendTransaction: fn('sendTransaction', async (tx) => {
      if (!landed.has(tx.sig)) {
        landed.set(tx.sig, tx);
        if (tx.kind === 'burn') owners.delete(tx.assetId);
      }
      return tx.sig;
    }),
    getSignatureStatuses: fn('getSignatureStatuses', async (sigs) => sigs.map((s) => (landed.has(s) ? { slot: 1, error: null, commitment: 'confirmed' } : null))),
    call: fn('call', async (method) => (method === 'getBlockHeight' ? height : null)),
    confirmTransaction: async () => {
      calls.web3Confirm = (calls.web3Confirm ?? 0) + 1;
      throw new Error('web3.js confirmTransaction must never be called');
    },
  };
  const paymentsFor = (id) => [...landed.values()].filter((t) => t.kind === 'pay' && t.assetId === id).length;
  return { rpc, calls, owners, peak: () => peak, paymentsFor, setHeight: (h) => (height = h) };
}

/** The server mode's sale desk wired to a guarded fake RPC, as market-server-mode.mjs wires it. */
function market(chain, { limit = 3 } = {}) {
  const ledger = new SoldLedger();
  const g = guardRpc(chain.rpc, { limit, sleep: tick, baseMs: 1, tries: 8, confirmIntervalMs: 0, log: () => {} });
  const payout = createPayout({
    ledger,
    async build(assetId, _mint, seller, pearls) {
      const blockhash = await g.getLatestBlockhash();
      const sig = `pay-${assetId}-${blockhash.blockhash}`; // same blockhash, same transaction, same signature
      return { tx: { kind: 'pay', sig, assetId, seller, pearls }, sig, blockhash, lastValid: blockhash.lastValidBlockHeight };
    },
    send: ({ tx }) => g.sendTransaction(tx),
    confirm: async ({ sig, blockhash }) => (await g.confirmTransaction(sig, { strategy: { type: 'blockhash', ...blockhash }, commitment: 'confirmed' })).value.err,
    getSignatureStatus: async (sig) => (await g.getSignatureStatuses([sig], { searchTransactionHistory: true }))[0],
    getBlockHeight: () => g.call('getBlockHeight', [{ commitment: 'finalized' }]),
  });
  const burnOnce = async (id) => {
    if (!(await g.getAccount(id))) return ledger.burned(id, '');
    const blockhash = await g.getLatestBlockhash();
    const sig = await g.sendTransaction({ kind: 'burn', sig: `burn-${id}`, assetId: id });
    await g.confirmTransaction(sig, { strategy: { type: 'blockhash', ...blockhash } });
    ledger.burned(id, sig);
  };
  const timers = [];
  const burnRetry = createBurnRetry({ burnOnce, delaysMs: [1, 1, 1], setTimer: (fn) => (timers.push(fn), { unref() {} }), clearTimer: () => {} });
  const desk = createSaleDesk({
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: (sig) => poll(() => g.getTransaction(sig), (t) => t !== null, 6, 0),
    loadMarketAsset: (id) => poll(() => g.getAccount(id), (a) => a?.owner === MARKET, 6, 0),
    priceFish: plainPrice,
    resolvePending: payout.resolvePending,
    pay: payout.pay,
    log: (m) => process.env.DEBUG_429 && console.log(m),
    burnSold: async (id) => {
      try {
        await burnOnce(id);
      } catch {
        burnRetry.retry(id);
      }
    },
  });
  const runRetries = async () => {
    while (timers.length) {
      timers.shift()();
      for (let i = 0; i < 20; i++) await tick();
    }
  };
  return { desk, ledger, burnRetry, runRetries };
}

const body = (fish = FISH) => ({ seller: SELLER, sales: fish.map((assetId) => ({ assetId, transferTx: TX })) });

async function noUnhandled(fn) {
  const seen = [];
  const on = (r) => seen.push(r);
  process.on('unhandledRejection', on);
  try {
    await fn();
    for (let i = 0; i < 10; i++) await tick();
  } finally {
    process.off('unhandledRejection', on);
  }
  assert.deepEqual(seen, [], `unhandled rejections: ${seen.map(String).join('; ')}`);
}

test('bulk sell of 18 fish while every 3rd RPC call is a 429: all paid once, at most 3 RPC calls in flight', async () => {
  const chain = fakeChain((_name, n) => n % 3 === 0);
  const m = market(chain);
  await noUnhandled(async () => {
    const { results } = await m.desk.sellBatch(body());
    assert.equal(results.length, 18);
    for (const [i, r] of results.entries()) {
      assert.equal(r.assetId, FISH[i], 'results keep the request order');
      assert.equal(r.pearls, 10, `${r.assetId}: ${r.error}`);
    }
    for (const f of FISH) assert.equal(chain.paymentsFor(f), 1, `${f} paid once`);
    assert.ok(chain.peak() <= 3, `peak ${chain.peak()} RPC calls in flight`);
    assert.equal(chain.calls.web3Confirm, undefined);
  });
});

test('a payout the RPC keeps refusing is a per-fish 503; the retry waits for expiry, then pays exactly once', async () => {
  const STUCK = FISH[4];
  let refuse = true;
  const chain = fakeChain((name, _n, args) => refuse && name === 'sendTransaction' && args[0]?.assetId === STUCK && args[0]?.kind === 'pay');
  const m = market(chain);
  await noUnhandled(async () => {
    const first = (await m.desk.sellBatch(body())).results;
    const stuck = first.find((r) => r.assetId === STUCK);
    assert.equal(stuck.status, 503);
    assert.match(stuck.error, /RPC is busy/);
    assert.equal(first.filter((r) => r.pearls === 10).length, 17, 'the other 17 sold');
    assert.equal(chain.paymentsFor(STUCK), 0);
    assert.equal(m.ledger.get(STUCK).status, 'paying', 'the signature is kept: a 429 is never treated as "not sent"');

    refuse = false;
    // Its blockhash is still valid: it might yet land, so the market must not pay again.
    const again = (await m.desk.sellBatch(body([STUCK]))).results[0];
    assert.equal(again.status, 409);
    assert.equal(chain.paymentsFor(STUCK), 0);

    chain.setHeight(500); // finalized past lastValidBlockHeight: it can never land now
    const last = (await m.desk.sellBatch(body([STUCK]))).results[0];
    assert.equal(last.pearls, 10);
    assert.equal(chain.paymentsFor(STUCK), 1);
    for (const f of FISH) assert.equal(chain.paymentsFor(f), 1);

    // Replaying the whole batch pays nobody again.
    const replay = (await m.desk.sellBatch(body())).results;
    assert.ok(replay.every((r) => r.pearls === 10));
    for (const f of FISH) assert.equal(chain.paymentsFor(f), 1);
  });
});

test('burns refused with 429 after payment are retried until every sold fish is gone', async () => {
  let refuseBurns = true;
  const chain = fakeChain((name, _n, args) => refuseBurns && name === 'sendTransaction' && args[0]?.kind === 'burn');
  const m = market(chain);
  await noUnhandled(async () => {
    const { results } = await m.desk.sellBatch(body(FISH.slice(0, 6)));
    assert.ok(results.every((r) => r.pearls === 10), 'the player is paid even though the burns failed');
    assert.equal(m.burnRetry.pending().length, 6);
    assert.equal(chain.owners.size, 18, 'nothing burned yet');

    refuseBurns = false;
    await m.runRetries();
    assert.equal(m.burnRetry.pending().length, 0);
    for (const f of FISH.slice(0, 6)) {
      assert.equal(chain.owners.has(f), false, `${f} burned`);
      assert.equal(m.ledger.get(f).status, 'burned');
      assert.equal(chain.paymentsFor(f), 1);
    }
  });
});

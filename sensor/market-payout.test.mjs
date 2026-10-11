import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, MPL_CORE_PROGRAM, SoldLedger } from './market-rules.mjs';
import { createPayout, rejectedBeforeSubmit } from './market-payout.mjs';
import { createSaleDesk } from './market-sale.mjs';

// Server mode's PEARL payout against a fake chain: sends that time out after the transaction
// landed (or before it did), preflight refusals, a crash between recording and sending, and
// blockhash expiry. The question is always the same: how many times was the seller paid?

const SELLER = 'Se11er111111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const A = 'FishA'.padEnd(43, '1');
const B = 'FishB'.padEnd(43, '1');
const TX = '5'.repeat(88);

/** A transfer of `assets` from SELLER to MARKET, in umi's shape (see market-sale.test.mjs). */
function transferTx(assets) {
  const accounts = [SELLER, MARKET, MPL_CORE_PROGRAM, ...assets];
  return {
    message: {
      header: { numRequiredSignatures: 1 },
      accounts,
      instructions: assets.map((_, i) => ({ programIndex: 2, accountIndexes: [3 + i, 2, 0, 2, 1, 2, 2], data: Uint8Array.of(14, 0) })),
    },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
  };
}

/** web3.js's SendTransactionError, as thrown when the node answers sendTransaction with an error. */
class SendTransactionError extends Error {
  constructor(transactionMessage) {
    super(`Simulation failed. \nMessage: ${transactionMessage}.`);
    this.transactionMessage = transactionMessage;
  }
}
const timeout = () => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
class Crash extends Error {}

/**
 * The chain: pay transactions that landed (sig -> { assetId, err, commitment }) and the finalized
 * block height. `sends` scripts what each sendTransaction does, in order:
 *   ok              lands, returns
 *   timeout-landed  lands, then the HTTP call times out
 *   timeout-lost    times out, never lands
 *   accepted        returns, but has not landed yet (confirm times out); land it with chain.land()
 *   preflight       the node refuses it (SendTransactionError); `preflight-wrapped`: inside umi's ProgramError
 *   crash-before    the process dies after the signature was persisted, before the send
 *   crash-after     the process dies right after the tx went out (it lands)
 */
function fakeChain(sends) {
  const chain = { height: 1000, landed: new Map(), built: new Map(), sendCount: 0, seq: 0 };
  chain.land = (sig, { err = null, commitment = 'finalized' } = {}) => chain.landed.set(sig, { assetId: chain.built.get(sig).assetId, err, commitment });
  /** Successful PEARL mints for a fish: the number of times its seller was paid. */
  chain.payouts = (assetId) => [...chain.landed.values()].filter((t) => t.assetId === assetId && !t.err).length;
  chain.deps = (ledger, disk) => ({
    build: async (assetId, mint, seller, pearls) => {
      const sig = `pay${++chain.seq}`;
      chain.built.set(sig, { assetId, pearls });
      return { sig, lastValid: chain.height + 150 };
    },
    send: async ({ sig }) => {
      chain.sendCount++;
      // Recorded before sending: what is on disk already names this transaction and its expiry.
      const saved = JSON.parse(disk.json)[chain.built.get(sig).assetId];
      assert.equal(saved.payTx, sig, 'pay signature persisted before the send');
      assert.equal(saved.payLastValid, chain.height + 150, 'expiry persisted before the send');
      const what = sends.shift() ?? 'ok';
      if (what === 'ok' || what === 'timeout-landed' || what === 'crash-after') chain.land(sig);
      if (what === 'timeout-landed' || what === 'timeout-lost') throw timeout();
      if (what === 'preflight') throw new SendTransactionError('Transaction simulation failed: Blockhash not found');
      if (what === 'preflight-wrapped') throw Object.assign(new Error('ProgramError'), { source: 'program', cause: new SendTransactionError('custom program error: 0x1') });
      if (what.startsWith('crash')) throw new Crash();
    },
    confirm: async ({ sig }) => {
      const t = chain.landed.get(sig);
      if (!t) throw new Error('block height exceeded'); // web3.js gives up waiting
      return t.err;
    },
    getSignatureStatus: async (sig) => {
      const t = chain.landed.get(sig);
      return t ? { error: t.err, commitment: t.commitment } : null;
    },
    getBlockHeight: async () => chain.height,
  });
  return chain;
}

/** A market process: ledger (persisted to `disk`), payout and sale desk. `boot` again for a restart. */
function boot(chain, disk) {
  const ledger = new SoldLedger(disk.json ? JSON.parse(disk.json) : {}, () => {
    disk.json = JSON.stringify(ledger.toJSON());
  });
  const payout = createPayout({ ledger, ...chain.deps(ledger, disk) });
  const desk = createSaleDesk({
    ledger,
    market: MARKET,
    ensureMint: async () => 'PearlMint',
    fetchTransfer: async () => transferTx([A, B]),
    loadMarketAsset: async () => ({ owner: MARKET, attributes: { attributeList: [{ key: 'rarity', value: 'rare' }, { key: 'depth', value: '5' }, { key: 'value', value: '10' }] } }),
    resolvePending: payout.resolvePending,
    pay: payout.pay,
    burnSold: async (id) => ledger.burned(id, `burn-${id}`),
  });
  const sell = (assetId = A) => desk.sell({ assetId, seller: SELLER, transferTx: TX });
  return { ledger, desk, sell };
}

const inFlight = (e) => e instanceof HttpError && e.status === 409 && /still confirming/.test(e.message);

test('payout send times out but the tx landed: resolvePending finds it, exactly one payout', async () => {
  const chain = fakeChain(['timeout-landed']);
  const m = boot(chain, {});
  await assert.rejects(m.sell(), /fetch failed/);
  assert.equal(m.ledger.get(A).payTx, 'pay1', 'the signature is kept after a timeout');
  assert.equal(m.ledger.get(A).status, 'paying');
  const r = await m.sell();
  assert.equal(r.pearls, 10);
  assert.equal(r.tx, 'pay1');
  assert.equal(chain.sendCount, 1, 'never sent again');
  assert.equal(chain.payouts(A), 1);
  await m.sell();
  assert.equal(chain.payouts(A), 1);
});

test('send times out and the tx never lands: in-flight until the blockhash expires, then exactly one re-pay', async () => {
  const chain = fakeChain(['timeout-lost', 'ok']);
  const m = boot(chain, {});
  await assert.rejects(m.sell(), /fetch failed/);
  const lastValid = m.ledger.get(A).payLastValid;
  await assert.rejects(m.sell(), inFlight);
  chain.height = lastValid; // still valid at exactly lastValidBlockHeight
  await assert.rejects(m.sell(), inFlight);
  assert.equal(chain.sendCount, 1, 'no re-pay before expiry');
  chain.height = lastValid + 1; // finalized chain is past it: pay1 can never land
  const r = await m.sell();
  assert.equal(r.tx, 'pay2');
  assert.equal(chain.sendCount, 2);
  assert.equal(chain.payouts(A), 1);
  await m.sell();
  assert.equal(chain.sendCount, 2);
});

test('a send that went out but lands only after the confirmation timed out is paid once, never re-sent', async () => {
  const chain = fakeChain(['accepted']);
  const m = boot(chain, {});
  await assert.rejects(m.sell(), /block height exceeded/);
  await assert.rejects(m.sell(), inFlight);
  chain.land('pay1', { commitment: 'processed' });
  await assert.rejects(m.sell(), inFlight, 'processed only: could still be dropped with its fork');
  chain.land('pay1', { commitment: 'confirmed' });
  chain.height += 1000; // even long after expiry, a landed tx is paid, not re-paid
  assert.equal((await m.sell()).tx, 'pay1');
  assert.equal(chain.sendCount, 1);
  assert.equal(chain.payouts(A), 1);
});

test('preflight failure: payDropped at once, then a safe re-pay (also when umi wraps it in a ProgramError)', async () => {
  const chain = fakeChain(['preflight', 'ok', 'preflight-wrapped', 'ok']);
  const m = boot(chain, {});
  await assert.rejects(m.sell(A), /Simulation failed/);
  assert.equal(m.ledger.get(A).payTx, undefined, 'the refused payout is forgotten');
  assert.equal((await m.sell(A)).tx, 'pay2', 'paid again right away, no wait for expiry');
  await assert.rejects(m.sell(B), /ProgramError/);
  assert.equal(m.ledger.get(B).payTx, undefined);
  assert.equal((await m.sell(B)).tx, 'pay4');
  assert.equal(chain.payouts(A), 1);
  assert.equal(chain.payouts(B), 1);
});

test('a pay tx that landed and failed on-chain minted nothing: dropped, paid once more', async () => {
  const chain = fakeChain(['accepted', 'ok']);
  const m = boot(chain, {});
  await assert.rejects(m.sell(), /block height exceeded/);
  chain.land('pay1', { err: { InstructionError: [1, 'x'] } });
  assert.equal((await m.sell()).tx, 'pay2');
  assert.equal(chain.payouts(A), 1);
});

test('a crash between recording and sending never pays twice (tx not sent, or sent and landed)', async () => {
  // Not sent: after the restart it stays in flight until its blockhash expires, then one payment.
  {
    const chain = fakeChain(['crash-before', 'ok']);
    const disk = {};
    await assert.rejects(boot(chain, disk).sell(), Crash);
    const restarted = boot(chain, disk);
    assert.equal(restarted.ledger.get(A).payTx, 'pay1');
    await assert.rejects(restarted.sell(), inFlight);
    chain.height += 151;
    assert.equal((await restarted.sell()).tx, 'pay2');
    assert.equal(chain.payouts(A), 1);
  }
  // Sent and landed: the restart finds it, and nothing is sent again.
  {
    const chain = fakeChain(['crash-after']);
    const disk = {};
    await assert.rejects(boot(chain, disk).sell(), Crash);
    const restarted = boot(chain, disk);
    assert.equal((await restarted.sell()).tx, 'pay1');
    chain.height += 1000;
    await restarted.sell();
    assert.equal(chain.sendCount, 1);
    assert.equal(chain.payouts(A), 1);
  }
});

test('rejectedBeforeSubmit: only a node refusal counts; timeouts, network and unknown errors do not', () => {
  assert.equal(rejectedBeforeSubmit(new SendTransactionError('Transaction simulation failed: Blockhash not found')), true);
  assert.equal(rejectedBeforeSubmit({ name: 'ProgramError', cause: new SendTransactionError('custom program error: 0x1') }), true);
  assert.equal(rejectedBeforeSubmit(new SendTransactionError('Transaction simulation failed: This transaction has already been processed')), false);
  assert.equal(rejectedBeforeSubmit(timeout()), false);
  assert.equal(rejectedBeforeSubmit(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), false);
  assert.equal(rejectedBeforeSubmit(new Error('503 Service Unavailable')), false);
  assert.equal(rejectedBeforeSubmit(new TypeError('fetch failed')), false);
  assert.equal(rejectedBeforeSubmit(null), false);
  assert.equal(rejectedBeforeSubmit('boom'), false);
});

// Server mode's sale desk: what POST /sell and POST /sell-batch do with each fish, with the
// chain behind injected functions so market-sale.test.mjs can drive it with fakes.
//
// Every fish is sold on its own, under a lock on its asset id, through the SoldLedger's
// paying -> paid -> burned steps. A batch is only a loop over fish: several fish may name the
// same transfer transaction (the player moved them all with one signature), and that is safe
// because the ledger is keyed by asset, not by transaction. Each fish is paid by its own PEARL
// mint transaction, so a crash or timeout is resolved fish by fish, exactly as for one sale.
//
// The daily PEARL cap is checked again when the fish is priced, after the market already holds it
// (the quote's check can be stale: another tab or device sold meanwhile). A fish refused there is
// sent back to the seller (refunding -> refunded, market-refund.mjs) and answered with the cap's
// 429 plus `refunded`: true once it is back, 'pending' while the sweep still has to finish it.

import { HttpError, MAX_BATCH, checkTransferTx, mapLimit, parseSellBatchBody, parseSellBody, planFor, withLock } from './market-rules.mjs';
import { isTransientRpcError } from './rpc-guard.mjs';

/** Fish of one batch worked on at once: bounded so the RPC isn't flooded. */
export const BATCH_CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A request past its deadline sends nothing more for this fish: the game sells it again. */
const outOfTime = () => new HttpError(503, 'Out of time for this request, sell this fish again');

/** Call `fn` until `ok(result)`, at most `tries` times `gapMs` apart; returns the last result. */
export async function poll(fn, ok, tries = 6, gapMs = 1000) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    if (i < tries - 1) await sleep(gapMs);
  }
  return last;
}

/**
 * One fish's failure in a batch. The RPC refusing us (429, timeout) is a 503 the game retries: its
 * transfer stays pending on the client and the ledger decides, fish by fish, what is left to do.
 * An HttpError's extra (e.g. { code: 'daily-cap', retryAfterMs }) goes along, as in a /sell body.
 */
const errorOf = (assetId, e) => {
  if (!(e instanceof HttpError) && isTransientRpcError(e)) {
    return { assetId, status: 503, error: 'The Solana RPC is busy, try selling this fish again in a minute' };
  }
  const extra = e instanceof HttpError ? e.extra : undefined;
  return { ...extra, assetId, status: e instanceof HttpError ? e.status : 500, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) };
};

/**
 * deps:
 *   ledger            SoldLedger, or the Redis store's ledger (market-store.mjs): every call is awaited,
 *                     which costs the file ledger nothing (its writes happen before the await yields)
 *   market            the market wallet's address (base58)
 *   ensureMint()      -> the PEARL mint address
 *   fetchTransfer(sig)-> umi TransactionWithMeta or null (may poll until it shows up)
 *   loadMarketAsset(assetId) -> the Core asset once the market owns it (may poll), else whatever was found, or null
 *   resolvePending(assetId)  -> 'paid' | 'unpaid' | 'in-flight'
 *   pay(assetId, mint, seller, pearls)  sends and confirms one PEARL mint; updates the ledger
 *   burnSold(assetId)  best effort; updates the ledger
 *   refund(assetId)    sends a 'refunding' fish back to its seller and confirms it; updates the
 *                      ledger; throws when it did not land (market-refund.mjs)
 *   resolveRefund(assetId) -> 'refunded' | 'unrefunded' | 'in-flight'  (asks the chain, market-refund.mjs)
 *   priceFish(asset, seller) -> PEARL for a fetched asset, or throws HttpError (fish-trust.mjs; synchronous)
 *   withSellerLock(seller, fn) optional: runs fn(held) holding the seller's lock across instances
 *                     (market-server-mode.mjs createSellerLock; the Redis store only)
 *   log(msg)
 */
export function createSaleDesk({
  ledger,
  market,
  ensureMint,
  fetchTransfer,
  loadMarketAsset,
  resolvePending,
  pay,
  burnSold,
  refund,
  resolveRefund,
  priceFish,
  withSellerLock,
  log = () => {},
  // A /sell or /sell-batch starts no new fish, and sends no payout, after this long (ms): those fish
  // come back as a 503 the game retries, and a paid fish's burn is left to the sweep. A transaction
  // already sent is still confirmed. Unlimited on a long-running server; a serverless host sets it
  // below its function time limit.
  batchDeadlineMs = Infinity,
  now = Date.now,
}) {
  if (typeof priceFish !== 'function') throw new Error('createSaleDesk: priceFish is required (the trusted-fish gate)');
  if (typeof refund !== 'function' || typeof resolveRefund !== 'function') {
    throw new Error('createSaleDesk: refund and resolveRefund are required (a fish refused after its transfer goes back)');
  }
  const locks = new Map();
  const conflict = () => new HttpError(409, 'This fish was already sold by another wallet');
  const busyReturning = () => new HttpError(409, 'This fish is still on its way back to its seller, try again in a minute');
  const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

  /**
   * The answer for a fish sent back (r: its refund record): the daily cap's 429 as the price check
   * gave it, its wait counted from now, and `refunded`: true (with the transfer back, refundTx) once
   * the record says the fish is back, else 'pending' (the sweep finishes it).
   */
  const returned = (r) => {
    const back = r?.status === 'refunded';
    return new HttpError(429, r?.reason || 'Daily PEARL limit reached', {
      code: 'daily-cap',
      retryAfterMs: Math.max(1000, Number(r?.retryAt) - now() || 0),
      refunded: back ? true : 'pending',
      ...(back && r.refundTx ? { refundTx: r.refundTx } : {}),
    });
  };

  /**
   * A fish on its way back, or sent back (plan 'refund' / 'refunded'). The transfer that was refused
   * (this request's, or its retry): send the fish back unless that is done, in flight or out of time
   * (the sweep finishes it then), and throw the cap's answer: never a payout. Another transfer: the
   * seller handed the fish over again, which can only be once the refund landed: ask the chain, then
   * return the plan for this transfer ('new'), or 409 while the refund is still under way.
   * `recorded`: this request has just recorded the refund, with the market holding the fish, so
   * there is nothing on chain to ask about yet.
   */
  async function sendBack(assetId, seller, transferTx, deadline, recorded = false) {
    let r = await ledger.get(assetId);
    if (r?.status === 'refunding' && r.transferTx !== transferTx) {
      if ((await resolveRefund(assetId)) !== 'refunded') throw busyReturning();
      r = await ledger.get(assetId);
    }
    const plan = planFor(r, seller, transferTx);
    if (plan !== 'refund' && plan !== 'refunded') return plan;
    if (plan === 'refund') {
      if (r.transferTx !== transferTx) throw busyReturning(); // a new cycle began meanwhile (another instance)
      try {
        const state = recorded ? 'unrefunded' : await resolveRefund(assetId);
        if (state === 'unrefunded' && now() > deadline) log(`[market] out of time, returning ${assetId} to ${r.seller} is left to the sweep`);
        else if (state === 'unrefunded') {
          const sig = await refund(assetId);
          log(`[market] daily cap reached: returned ${assetId} to ${r.seller}${sig ? ` (${sig})` : ''}`);
        }
      } catch (e) {
        // The RPC refused or timed out, or another instance's refund is on record: the record keeps
        // what is left to do, and the sweep (or a retry) finishes it. The answer is the cap's anyway.
        log(`[market] returning ${assetId} to ${r.seller} did not finish, left to the sweep: ${short(e)}`);
      }
      r = await ledger.get(assetId);
    }
    throw returned(r);
  }

  /**
   * Sell one fish. `getTransfer` lets a batch fetch each shared transaction once. The sweep
   * (market-burn.mjs) calls it too, with a stalled 'paying' record's own seller and transfer: plan
   * says 'resume', so the transfer verified at begin() is not fetched again, and resolvePending
   * asks the chain whether the earlier payout landed before anything is paid. `deadline` (a time,
   * ms): no payout, burn or refund is sent after it.
   */
  function sellAsset({ assetId, seller, transferTx }, getTransfer = fetchTransfer, deadline = Infinity) {
    /** This request recorded the fish's refund (book), so sendBack has nothing to look up first. */
    let recorded = false;
    /**
     * Price the fish and record the sale; returns the plan from there. The price comes from the
     * fish's on-chain attributes, never from the request: priceFish is fish-trust's gate (collection
     * + generator check) and the daily cap over the seller's sales so far, so pricing and begin()
     * must not interleave with another sale for the same seller. The file ledger: priceFish is
     * synchronous and begin() writes before it yields, one step. The Redis ledger reads the seller's
     * last 24 h first and records over several commands, so server mode runs this under
     * withSellerLock, across instances, and records nothing once `held` says the lock may be gone.
     * Over the daily cap, the market already holds the fish: it records the refund instead ('refund';
     * the transfer back is sent after, outside the seller's lock: it can take a minute).
     */
    const book = async (asset, held = () => true) => {
      if (withSellerLock) {
        // Another instance may have begun this very fish while we waited: priced again, it would count against itself.
        const fresh = await ledger.plan(assetId, seller, transferTx);
        if (fresh !== 'new') return fresh;
      }
      if (ledger.loadSeller) await ledger.loadSeller(seller);
      let pearls;
      try {
        pearls = priceFish(asset, seller);
      } catch (e) {
        if (!(e instanceof HttpError && e.extra?.code === 'daily-cap')) throw e;
        // A refund pays nothing and counts toward no cap, so it needs no `held`. false: another
        // instance recorded this fish first (as for begin below).
        const back = { seller, transferTx, reason: e.message, retryAt: now() + (Number(e.extra.retryAfterMs) || 0) };
        if ((await ledger.refunding(assetId, back)) === false) return ledger.plan(assetId, seller, transferTx);
        recorded = true;
        return 'refund';
      }
      if (!held()) throw new HttpError(503, 'Recording this sale took too long, sell this fish again');
      // false only from the Redis ledger: another instance began this fish first (SET NX). Take
      // up its record from where it is instead of starting a second sale of the same fish.
      if ((await ledger.begin(assetId, { seller, transferTx, pearls })) === false) return ledger.plan(assetId, seller, transferTx);
      return 'resume';
    };

    return withLock(locks, assetId, async () => {
      let plan = await ledger.plan(assetId, seller, transferTx);
      if (plan === 'refund' || plan === 'refunded') plan = await sendBack(assetId, seller, transferTx, deadline);
      if (plan === 'conflict') throw conflict();
      if (plan === 'done') return ledger.result(assetId);
      const mint = await ensureMint();

      if (plan === 'new') {
        const tx = await getTransfer(transferTx);
        const bad = checkTransferTx(tx, { assetId, seller, market });
        if (bad) throw new HttpError(400, bad);
        const asset = await loadMarketAsset(assetId);
        if (asset?.owner?.toString() !== market) throw new HttpError(400, 'The market does not own this fish yet');
        plan = withSellerLock ? await withSellerLock(seller, (held) => book(asset, held)) : await book(asset);
        if (plan === 'refund' || plan === 'refunded') plan = await sendBack(assetId, seller, transferTx, deadline, recorded);
        if (plan === 'conflict') throw conflict();
        if (plan === 'done') return ledger.result(assetId);
      }
      // Only a sale record pays or burns: never a refund, and never a record that changed under us.
      if (plan !== 'resume' && plan !== 'burn') throw new HttpError(409, 'This fish changed hands while it was being sold, sell it again');

      if (plan === 'resume') {
        const pending = await resolvePending(assetId);
        if (pending === 'in-flight') throw new HttpError(409, 'Payment is still confirming, retry in a few seconds');
        if (pending === 'unpaid') {
          // Nothing sent yet, and the record stays 'paying': a retry (or the sweep) resumes it.
          if (now() > deadline) throw outOfTime();
          const r = await ledger.get(assetId);
          await pay(assetId, mint, seller, r.pearls);
          log(`[market] paid ${r.pearls} PEARL to ${seller} for ${assetId}`);
        }
      }

      // Paid: the answer is the sale either way. Out of time, the burn waits for the sweep (as a failed one does).
      if (now() > deadline) log(`[market] out of time, the burn of ${assetId} is left to the sweep`);
      else await burnSold(assetId);
      return ledger.result(assetId);
    });
  }

  /**
   * The sweep's retry of a fish stuck on its way back (a 'refunding' record old enough that no
   * request is still on it), under the fish's lock: asks the chain first (resolveRefund), sends it
   * back only if it did not go, nothing after `deadline`. Returns the transfer back's signature (''
   * when the market turned out not to hold the fish); throws when it is still in flight (409), out
   * of time (503) or the send failed.
   */
  function resumeRefund(assetId, deadline = Infinity) {
    return withLock(locks, assetId, async () => {
      const r = await ledger.get(assetId);
      if (r?.status !== 'refunding') return r?.refundTx ?? '';
      const state = await resolveRefund(assetId);
      if (state === 'refunded') return (await ledger.get(assetId))?.refundTx ?? '';
      if (state === 'in-flight') throw new HttpError(409, 'The transfer returning this fish is still confirming');
      if (now() > deadline) throw outOfTime();
      const sig = await refund(assetId);
      log(`[market] returned ${assetId} to ${r.seller}${sig ? ` (${sig})` : ''}`);
      return sig;
    });
  }

  /** POST /sell: one fish. */
  function sell(body) {
    return sellAsset(parseSellBody(body), fetchTransfer, now() + batchDeadlineMs);
  }

  /**
   * POST /sell-batch: { seller, sales: [{ assetId, transferTx }] } -> { results: [...] }, one per
   * sale in order: { assetId, pearls, tx, extra } when sold, { assetId, status, error } when not.
   * A fish that fails never stops the others.
   *
   * RPC cost: parseSellBatchBody allows at most MAX_BATCH_TXS distinct transfers, and each one is
   * fetched (polled) once, the first time a fish needs it, its result shared by all of its fish.
   * So a batch of made-up signatures costs at most MAX_BATCH_TXS polls, however many fish it names.
   */
  async function sellBatch(body) {
    const { seller, sales } = parseSellBatchBody(body);
    const fetched = new Map();
    const getTransfer = (sig) => {
      if (!fetched.has(sig)) fetched.set(sig, fetchTransfer(sig));
      return fetched.get(sig);
    };
    const deadline = now() + batchDeadlineMs;
    const results = await mapLimit(sales, BATCH_CONCURRENCY, async ({ assetId, transferTx }) => {
      if (now() > deadline) return errorOf(assetId, outOfTime());
      try {
        return { assetId, ...(await sellAsset({ assetId, seller, transferTx }, getTransfer, deadline)) };
      } catch (e) {
        if (!(e instanceof HttpError)) log(`[market] batch sale of ${assetId} failed: ${String(e?.message ?? e).split('\n')[0]}`);
        return errorOf(assetId, e);
      }
    });
    return { results };
  }

  return { sell, sellBatch, sellAsset, resumeRefund, MAX_BATCH };
}

/** POST /quote-batch, given the single-fish quote: { quotes: [{ assetId, pearls } | { assetId, status, error }] }. */
export async function quoteMany({ seller, assetIds }, quote) {
  const quotes = await mapLimit(assetIds, BATCH_CONCURRENCY, async (assetId) => {
    try {
      return { assetId, ...(await quote({ assetId, seller })) };
    } catch (e) {
      return errorOf(assetId, e);
    }
  });
  return { quotes };
}

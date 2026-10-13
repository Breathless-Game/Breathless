// Server mode's sale desk: what POST /sell and POST /sell-batch do with each fish, with the
// chain behind injected functions so market-sale.test.mjs can drive it with fakes.
//
// Every fish is sold on its own, under a lock on its asset id, through the SoldLedger's
// paying -> paid -> burned steps. A batch is only a loop over fish: several fish may name the
// same transfer transaction (the player moved them all with one signature), and that is safe
// because the ledger is keyed by asset, not by transaction. Each fish is paid by its own PEARL
// mint transaction, so a crash or timeout is resolved fish by fish, exactly as for one sale.

import { HttpError, MAX_BATCH, checkTransferTx, mapLimit, parseSellBatchBody, parseSellBody, withLock } from './market-rules.mjs';
import { isTransientRpcError } from './rpc-guard.mjs';

/** Fish of one batch worked on at once: bounded so the RPC isn't flooded. */
export const BATCH_CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 */
const errorOf = (assetId, e) => {
  if (!(e instanceof HttpError) && isTransientRpcError(e)) {
    return { assetId, status: 503, error: 'The Solana RPC is busy, try selling this fish again in a minute' };
  }
  return { assetId, status: e instanceof HttpError ? e.status : 500, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) };
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
  priceFish,
  withSellerLock,
  log = () => {},
  // A /sell-batch starts no new fish after this long (ms): they come back as a 503 the game retries.
  // Unlimited on a long-running server; a serverless host sets it below its function time limit.
  batchDeadlineMs = Infinity,
}) {
  if (typeof priceFish !== 'function') throw new Error('createSaleDesk: priceFish is required (the trusted-fish gate)');
  const locks = new Map();
  const conflict = () => new HttpError(409, 'This fish was already sold by another wallet');

  /**
   * Sell one fish. `getTransfer` lets a batch fetch each shared transaction once. The sweep
   * (market-burn.mjs) calls it too, with a stalled 'paying' record's own seller and transfer: plan
   * says 'resume', so the transfer verified at begin() is not fetched again, and resolvePending
   * asks the chain whether the earlier payout landed before anything is paid.
   */
  function sellAsset({ assetId, seller, transferTx }, getTransfer = fetchTransfer) {
    /**
     * Price the fish and record the sale; returns the plan from there. The price comes from the
     * fish's on-chain attributes, never from the request: priceFish is fish-trust's gate (collection
     * + generator check) and the daily cap over the seller's sales so far, so pricing and begin()
     * must not interleave with another sale for the same seller. The file ledger: priceFish is
     * synchronous and begin() writes before it yields, one step. The Redis ledger reads the seller's
     * last 24 h first and records over several commands, so server mode runs this under
     * withSellerLock, across instances, and records nothing once `held` says the lock may be gone.
     */
    const book = async (asset, held = () => true) => {
      if (withSellerLock) {
        // Another instance may have begun this very fish while we waited: priced again, it would count against itself.
        const fresh = await ledger.plan(assetId, seller);
        if (fresh !== 'new') return fresh;
      }
      if (ledger.loadSeller) await ledger.loadSeller(seller);
      const pearls = priceFish(asset, seller);
      if (!held()) throw new HttpError(503, 'Recording this sale took too long, sell this fish again');
      // false only from the Redis ledger: another instance began this fish first (SET NX). Take
      // up its record from where it is instead of starting a second sale of the same fish.
      if ((await ledger.begin(assetId, { seller, transferTx, pearls })) === false) return ledger.plan(assetId, seller);
      return 'resume';
    };

    return withLock(locks, assetId, async () => {
      let plan = await ledger.plan(assetId, seller);
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
        if (plan === 'conflict') throw conflict();
        if (plan === 'done') return ledger.result(assetId);
      }

      if (plan === 'resume') {
        const pending = await resolvePending(assetId);
        if (pending === 'in-flight') throw new HttpError(409, 'Payment is still confirming, retry in a few seconds');
        if (pending === 'unpaid') {
          const r = await ledger.get(assetId);
          await pay(assetId, mint, seller, r.pearls);
          log(`[market] paid ${r.pearls} PEARL to ${seller} for ${assetId}`);
        }
      }

      await burnSold(assetId);
      return ledger.result(assetId);
    });
  }

  /** POST /sell: one fish. */
  function sell(body) {
    return sellAsset(parseSellBody(body));
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
    const deadline = Date.now() + batchDeadlineMs;
    const results = await mapLimit(sales, BATCH_CONCURRENCY, async ({ assetId, transferTx }) => {
      if (Date.now() > deadline) return { assetId, status: 503, error: 'Out of time for this request, sell this fish again' };
      try {
        return { assetId, ...(await sellAsset({ assetId, seller, transferTx }, getTransfer)) };
      } catch (e) {
        if (!(e instanceof HttpError)) log(`[market] batch sale of ${assetId} failed: ${String(e?.message ?? e).split('\n')[0]}`);
        return errorOf(assetId, e);
      }
    });
    return { results };
  }

  return { sell, sellBatch, sellAsset, MAX_BATCH };
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

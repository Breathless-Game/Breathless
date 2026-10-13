// Server mode: sold fish must not stay in the market wallet. A sale pays first and burns second,
// so a burn that fails (an RPC 429, a timeout) leaves a paid fish behind. Two things finish it:
//
//   createBurnRetry  retries one failed burn in memory with backoff (15 s ... 10 min).
//   createSweep      on start-up and every 10 minutes (Vercel: after a sale and from a daily cron),
//                    finishes the sales the sold ledger says are not finished: burns the fish paid
//                    but not burned yet, and resumes the sales stuck in 'paying'.
//
// The ledger is the work list (ledger.unburned: the file ledger filters its records, the Redis one
// keeps an index), so a sweep never scans the chain: the old getProgramAccounts over every mpl-core
// asset the market owns was rate limited (429) by the public devnet RPC on every run, and it ate
// into the budget the players' requests share. Each paid candidate costs one getAccount (loadAsset):
//   gone (already burned)               -> marked burned in the ledger, no transaction
//   not the market's, or not our fish   -> set aside in the ledger (skipBurn), logged, never burned
//   the market's fish                   -> burned (burnOnce)
// A sale stuck in 'paying' (its pay() failed or timed out and the player never sent /sell again:
// cleared storage, another device) is handed to the sale desk's own resume path (resumeSale =
// desk.sellAsset with the record's seller and transfer), once it is SWEEP_RESUME_AFTER_MS old: the
// desk asks the chain whether the earlier payout landed before it pays (market-payout.mjs), and
// burns the fish once paid. Younger ones wait: a request may still be working on them.
// A fish the market holds with no sale record (a transfer whose /sell never arrived) is not on the
// list: the game resumes that sale later and gets paid then. Calls are spaced gapMs apart, at most
// maxPerRun fish per sweep (of which at most maxResumesPerRun resumed sales), and a 429 (after
// rpc-guard.mjs has already backed off) ends the sweep early: the rest wait for the next one
// instead of the whole sweep failing. So does run({ deadlineMs }) once that long has passed (a
// serverless host, below its function time limit): no burn or resume is started after it.

import { isRateLimited } from './rpc-guard.mjs';

const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/** Backoff between retries of one failed burn; after the last one the next sweep takes over. */
export const BURN_RETRY_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000, 600_000]);
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Fish burned per sweep at most (a full /sell-batch is 24): bounded RPC per 10 minutes. */
export const SWEEP_MAX_PER_RUN = 24;
/**
 * Stalled sales resumed per sweep at most. A resume sends and confirms a PEARL payout, which can
 * take up to the confirmer's 90 s timeout when the RPC struggles; a few keep a sweep within
 * Vercel's 300 s function limit and its sweep lock. The rest wait for the next sweep.
 */
export const SWEEP_MAX_RESUMES_PER_RUN = 3;
/**
 * A 'paying' sale is the sweep's to resume only this long after it began. No request can still be
 * working on it by then: a request lives at most 300 s (Vercel's maxDuration; a /sell or /sell-batch
 * sends no payout after 240 s), its payout's blockhash expires within ~60-90 s and its confirmation
 * gives up after 90 s. So the sweep never races a live sale; if a client's retry does run at the same time,
 * the per-fish lock (one process) and Redis's payPending SET NX (several) still let only one pay.
 */
export const SWEEP_RESUME_AFTER_MS = 10 * 60_000;

/**
 * deps: burnOnce(assetId) -> burn signature or '' (throws on failure), log.
 * retry(assetId) schedules it unless already scheduled; the first retry waits delaysMs[0].
 */
export function createBurnRetry({ burnOnce, log = () => {}, delaysMs = BURN_RETRY_DELAYS_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Map(); // assetId -> { tries, timer }

  function schedule(assetId, tries) {
    if (tries >= delaysMs.length) {
      pending.delete(assetId);
      log(`[market] burn of ${assetId} still failing after ${tries} retries; the next sweep will try again`);
      return;
    }
    const timer = setTimer(() => {
      attempt(assetId, tries).catch((e) => log(`[market] burn retry of ${assetId} crashed: ${short(e)}`));
    }, delaysMs[tries]);
    timer?.unref?.();
    pending.set(assetId, { tries, timer });
  }

  async function attempt(assetId, tries) {
    try {
      const sig = await burnOnce(assetId);
      pending.delete(assetId);
      log(`[market] burn of ${assetId} retried ok${sig ? ` (${sig})` : ''}`);
    } catch (e) {
      log(`[market] burn retry ${tries + 1}/${delaysMs.length} of ${assetId} failed: ${short(e)}`);
      schedule(assetId, tries + 1);
    }
  }

  return {
    retry(assetId) {
      if (!pending.has(assetId)) schedule(assetId, 0);
    },
    has: (assetId) => pending.has(assetId),
    pending: () => [...pending.keys()],
    stop() {
      for (const { timer } of pending.values()) clearTimer(timer);
      pending.clear();
    },
  };
}

/** Gap between two fish of one sweep: a little air for the players' requests on the shared RPC. */
export const SWEEP_GAP_MS = 250;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Why the sweep must not burn this fish, or null when it may: it must be ours and the market's. */
export function burnBlocker(asset, { market, collection }) {
  if (String(asset?.owner) !== market) return `owned by ${String(asset?.owner)}, not the market`;
  const ua = asset?.updateAuthority;
  if (ua?.type !== 'Collection' || String(ua.address) !== collection) return 'not in the fish collection';
  return null;
}

/**
 * deps:
 *   collection()  -> the fish collection address, or null before it exists
 *   market        the market wallet's address
 *   ledger        SoldLedger, or the Redis store's ledger: unburned(limit), get(id), burned(id, sig), skipBurn(id, why)
 *   loadAsset(id) -> the mpl-core asset, or null when it does not exist; throws on an RPC error (429, timeout)
 *   burnOnce(id, asset) burns it (asset: already fetched, so no second fetch); throws on failure
 *   resumeSale(id, record)  finishes a sale stuck in 'paying': the sale desk's sellAsset (pays only
 *                 if the earlier payout did not land, then burns); throws like a /sell. Without it,
 *                 paying sales are left alone.
 * Returns { burned, resumed, settled, skipped, failed, waiting, left, rateLimited }: resumed = stalled
 * sales finished (paid now or found paid, then burned); settled = already gone, marked burned;
 * skipped = set aside; waiting = paying sales too young to resume; left = sales seen but not tried
 * this time (at least that many remain). With a deadline, also outOfTime: it stopped there.
 */
export function createSweep({
  collection,
  market,
  ledger,
  loadAsset,
  burnOnce,
  resumeSale = null,
  log = () => {},
  maxPerRun = SWEEP_MAX_PER_RUN,
  maxResumesPerRun = SWEEP_MAX_RESUMES_PER_RUN,
  resumeAfterMs = SWEEP_RESUME_AFTER_MS,
  intervalMs = SWEEP_INTERVAL_MS,
  gapMs = SWEEP_GAP_MS,
  sleep = sleepMs,
  now = Date.now,
}) {
  let running = null;

  async function sweepOnce({ deadlineMs = Infinity } = {}) {
    const out = { burned: 0, resumed: 0, settled: 0, skipped: 0, failed: 0, waiting: 0, left: 0, rateLimited: false };
    const deadline = now() + deadlineMs;
    if (Number.isFinite(deadlineMs)) out.outOfTime = false;
    const coll = collection();
    if (!coll) return out;
    // One more than we will try, to know whether any are left for the next sweep.
    const ids = await ledger.unburned(maxPerRun + 1);
    const batch = ids.slice(0, maxPerRun);
    let tried = 0;
    let resumes = 0;
    for (const id of batch) {
      if (now() > deadline) {
        out.outOfTime = true;
        break; // this fish and the rest wait for the next sweep
      }
      try {
        const r = await ledger.get(id);
        if (r?.status === 'paying') {
          // Too young (a request may still be on it) or no resume path: not the sweep's yet.
          if (!resumeSale || !(now() - Number(r.at) >= resumeAfterMs)) {
            out.waiting++;
            continue;
          }
          if (resumes >= maxResumesPerRun) continue; // counted in `left`
          if (tried) await sleep(gapMs);
          resumes++;
          await resumeSale(id, r);
          out.resumed++;
          log(`[market] sweep: finished the stalled sale of ${id} to ${r.seller}`);
          tried++;
          continue;
        }
        if (tried) await sleep(gapMs);
        const asset = await loadAsset(id);
        if (!asset) {
          // Burned already (or never existed): nothing left to burn. Keep a signature the sale desk
          // may have recorded since the listing.
          const r = await ledger.get(id);
          await ledger.burned(id, r?.burnTx ?? '');
          out.settled++;
        } else {
          const why = burnBlocker(asset, { market, collection: coll });
          if (why) {
            await ledger.skipBurn(id, why);
            out.skipped++;
            log(`[market] sweep: not burning paid fish ${id}: ${why}`);
          } else {
            await burnOnce(id, asset);
            out.burned++;
          }
        }
      } catch (e) {
        if (isRateLimited(e)) {
          out.rateLimited = true;
          break; // this fish and the rest wait for the next sweep
        }
        out.failed++;
        log(`[market] sweep: finishing the sale of ${id} failed: ${short(e)}`);
      }
      tried++;
    }
    out.left = ids.length - tried - out.waiting;
    if (tried || out.left) {
      log(
        `[market] sweep: burned ${out.burned} paid fish still in the market wallet` +
          (out.resumed ? `, finished ${out.resumed} stalled sales` : '') +
          (out.settled ? `, ${out.settled} already gone` : '') +
          (out.skipped ? `, ${out.skipped} set aside` : '') +
          (out.failed ? `, ${out.failed} failed` : '') +
          (out.rateLimited ? '; RPC rate limited (429), stopped early' : '') +
          (out.outOfTime ? '; out of time, stopped early' : '') +
          (out.left ? `; ${ids.length > maxPerRun || out.rateLimited || out.outOfTime ? 'more' : out.left} left for the next sweep` : ''),
      );
    }
    return out;
  }
  /** One sweep at a time; a sweep that throws (RPC down) is logged, never unhandled. opts: { deadlineMs }. */
  function run(opts) {
    running ??= sweepOnce(opts)
      .catch((e) => {
        log(`[market] sweep failed: ${short(e)}`);
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  function start() {
    const t = setInterval(() => void run(), intervalMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  return { run, sweepOnce, start };
}

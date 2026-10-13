// Server mode: sold fish must not stay in the market wallet. A sale pays first and burns second,
// so a burn that fails (an RPC 429, a timeout) leaves a paid fish behind. Two things finish it:
//
//   createBurnRetry  retries one failed burn in memory with backoff (15 s ... 10 min).
//   createSweep      on start-up and every 10 minutes (Vercel: after a sale and from a daily cron),
//                    burns the fish the sold ledger says were paid but not burned yet.
//
// The ledger is the work list (ledger.unburned: the file ledger filters its records, the Redis one
// keeps an index), so a sweep never scans the chain: the old getProgramAccounts over every mpl-core
// asset the market owns was rate limited (429) by the public devnet RPC on every run, and it ate
// into the budget the players' requests share. Each candidate costs one getAccount (loadAsset):
//   gone (already burned)               -> marked burned in the ledger, no transaction
//   not the market's, or not our fish   -> set aside in the ledger (skipBurn), logged, never burned
//   the market's fish                   -> burned (burnOnce)
// A fish the market holds with no paid record (a transfer whose /sell never arrived) is not on the
// list: the game resumes that sale later and gets paid then. Calls are spaced gapMs apart, at most
// maxPerRun fish per sweep, and a 429 (after rpc-guard.mjs has already backed off) ends the sweep
// early: the rest wait for the next one instead of the whole sweep failing.

import { isRateLimited } from './rpc-guard.mjs';

const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/** Backoff between retries of one failed burn; after the last one the next sweep takes over. */
export const BURN_RETRY_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000, 600_000]);
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Fish burned per sweep at most (a full /sell-batch is 24): bounded RPC per 10 minutes. */
export const SWEEP_MAX_PER_RUN = 24;

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
 * Returns { burned, settled, skipped, failed, left, rateLimited }: settled = already gone, marked
 * burned; skipped = set aside; left = fish seen but not tried this time (at least that many remain).
 */
export function createSweep({
  collection,
  market,
  ledger,
  loadAsset,
  burnOnce,
  log = () => {},
  maxPerRun = SWEEP_MAX_PER_RUN,
  intervalMs = SWEEP_INTERVAL_MS,
  gapMs = SWEEP_GAP_MS,
  sleep = sleepMs,
}) {
  let running = null;

  async function sweepOnce() {
    const out = { burned: 0, settled: 0, skipped: 0, failed: 0, left: 0, rateLimited: false };
    const coll = collection();
    if (!coll) return out;
    // One more than we will try, to know whether any are left for the next sweep.
    const ids = await ledger.unburned(maxPerRun + 1);
    const batch = ids.slice(0, maxPerRun);
    let tried = 0;
    for (const id of batch) {
      if (tried) await sleep(gapMs);
      try {
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
        log(`[market] sweep: burn of ${id} failed: ${short(e)}`);
      }
      tried++;
    }
    out.left = ids.length - tried;
    if (tried || out.left) {
      log(
        `[market] sweep: burned ${out.burned} paid fish still in the market wallet` +
          (out.settled ? `, ${out.settled} already gone` : '') +
          (out.skipped ? `, ${out.skipped} set aside` : '') +
          (out.failed ? `, ${out.failed} failed` : '') +
          (out.rateLimited ? '; RPC rate limited (429), stopped early' : '') +
          (out.left ? `; ${ids.length > maxPerRun || out.rateLimited ? 'more' : out.left} left for the next sweep` : ''),
      );
    }
    return out;
  }
  /** One sweep at a time; a sweep that throws (RPC down) is logged, never unhandled. */
  function run() {
    running ??= sweepOnce()
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

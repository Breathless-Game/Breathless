// Server mode: sold fish must not stay in the market wallet. A sale pays first and burns second,
// so a burn that fails (an RPC 429, a timeout) leaves a paid fish behind. Two things finish it:
//
//   createBurnRetry  retries one failed burn in memory with backoff (15 s ... 10 min).
//   createSweep      on start-up and every 10 minutes, lists the fish the market wallet itself owns
//                    in the Breathless collection and burns the ones the sold ledger says were paid.
//
// The chain is the source of truth for what is still unburned; nothing new is written to disk.
// A fish the market owns with NO paid record is a transfer whose /sell never arrived (the game
// resumes it later and gets paid then), so the sweep leaves it alone: burning it would take a
// fish nobody was paid for. Burns go through the guarded RPC (rpc-guard.mjs), and each sweep
// burns at most maxPerRun fish, so neither can flood the RPC.

const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/** Backoff between retries of one failed burn; after the last one the next sweep takes over. */
export const BURN_RETRY_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000, 600_000]);
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Fish burned per sweep at most (a full /sell-batch is 24): bounded RPC per 10 minutes. */
export const SWEEP_MAX_PER_RUN = 24;

/** Ledger states whose fish the market has paid for (a 'burned' record whose fish still exists was marked too early). */
const PAID = new Set(['paid', 'burned']);

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

/**
 * The fish a sweep burns: in our collection, owned by the market wallet, and paid for per the ledger.
 * `assets`: mpl-core assets ({ publicKey, owner, updateAuthority: { type, address } }).
 * Returns { burn: [assetId], unpaid: [assetId] } (unpaid: held but never sold, left alone).
 */
export function pickStranded(assets, { market, collection, ledger }) {
  const burn = [];
  const unpaid = [];
  for (const a of assets ?? []) {
    const ua = a?.updateAuthority;
    if (String(a?.owner) !== market) continue;
    if (ua?.type !== 'Collection' || String(ua.address) !== collection) continue;
    const id = String(a.publicKey);
    if (PAID.has(ledger.get(id)?.status)) burn.push(id);
    else if (!ledger.get(id)) unpaid.push(id); // 'paying' records are the sale desk's to resolve
  }
  return { burn, unpaid };
}

/**
 * deps:
 *   listOwned()   -> the market wallet's mpl-core assets (one getProgramAccounts)
 *   collection()  -> the fish collection address, or null before it exists
 *   market        the market wallet's address
 *   ledger        SoldLedger, or the Redis store's ledger (read through its loadAssets snapshot)
 *   burnOnce(id)  as above
 */
export function createSweep({ listOwned, collection, market, ledger, burnOnce, log = () => {}, maxPerRun = SWEEP_MAX_PER_RUN, intervalMs = SWEEP_INTERVAL_MS }) {
  let running = null;

  async function sweepOnce() {
    const coll = collection();
    if (!coll) return { burned: 0, failed: 0, left: 0, unpaid: 0 };
    const owned = await listOwned();
    // The Redis ledger reads just these fish's records first; the file one has them all in memory.
    const view = ledger.loadAssets ? await ledger.loadAssets((owned ?? []).map((a) => String(a?.publicKey))) : ledger;
    const { burn, unpaid } = pickStranded(owned, { market, collection: coll, ledger: view });
    let burned = 0;
    let failed = 0;
    const now = burn.slice(0, maxPerRun);
    for (const id of now) {
      try {
        await burnOnce(id);
        burned++;
      } catch (e) {
        failed++;
        log(`[market] sweep: burn of ${id} failed: ${short(e)}`);
      }
    }
    const left = burn.length - now.length;
    if (burn.length || unpaid.length) {
      log(
        `[market] sweep: burned ${burned} paid fish still in the market wallet` +
          (failed ? `, ${failed} failed` : '') +
          (left ? `, ${left} left for the next sweep` : '') +
          (unpaid.length ? `; ${unpaid.length} transferred but never sold (left alone)` : ''),
      );
    }
    return { burned, failed, left, unpaid: unpaid.length };
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

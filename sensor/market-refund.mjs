// Server mode's refund: send a fish the market will not pay for back to its seller, and after a
// crash or a timeout decide from the chain whether it went. The chain is behind injected functions
// so market-refund.test.mjs can drive it with a fake.
//
// Why a fish comes back: the player transfers it to the market first and the market prices it
// after, under the seller's lock (market-sale.mjs). If the daily PEARL cap is reached in between
// (another tab or device sold meanwhile), the market owns a fish it must not pay for. It records
// the refund ('refunding', SoldLedger), then transfers the fish back (a Core TransferV1 the market
// signs and pays for), then marks it 'refunded'. The fish never gets paid or burned on the way.
//
// The rule that keeps one fish from being sent twice (harmless on chain, a second transfer would
// just fail, but a fee) or, worse, sent back after the player handed it over AGAIN: before any
// resend, ask the chain (resolveRefund):
//   - the market no longer holds the fish        -> it went back: refunded
//   - it does, and the recorded refund landed     -> it went back and the seller has handed it over
//                                                    again (a new sale): refunded
//   - it does, and the refund failed, or expired  -> forget it (refundDropped): send again
//     unseen (finalized height > lastValid)
//   - anything else                               -> in flight: wait
// As for payouts (market-payout.mjs), a send the node refused before forwarding is forgotten at once.

import { rejectedBeforeSubmit } from './market-payout.mjs';

const LANDED = new Set(['confirmed', 'finalized']);

/**
 * deps:
 *   ledger                    SoldLedger, or the Redis store's ledger (refundPending, refundDropped, refunded)
 *   market                    the market wallet's address
 *   loadAsset(assetId)        -> the Core asset, or null when it does not exist; throws on an RPC error
 *   build(asset, seller)      -> { tx, sig, lastValid, ... }  a signed, unsent transfer of `asset` to `seller`
 *   send(built)               submits it; throws on any failure (see rejectedBeforeSubmit)
 *   confirm(built)            waits for it: the on-chain error (null when it succeeded); throws on timeout/expiry
 *   getSignatureStatus(sig)   -> null | { error, commitment }  (searching history)
 *   getBlockHeight()          -> the FINALIZED block height
 */
export function createRefund({ ledger, market, loadAsset, build, send, confirm, getSignatureStatus, getBlockHeight }) {
  const marketHolds = (asset) => asset != null && String(asset.owner) === market;

  /**
   * Send a 'refunding' fish back to its seller and confirm it; marks it refunded. Returns the refund
   * signature ('' when the market turned out not to hold the fish any more). The signature and expiry
   * are persisted before sending (another instance's refund on record: 409, nothing sent). Throws when
   * it did not land (the record keeps whatever resolveRefund needs to decide later).
   */
  async function refund(assetId) {
    const r = await ledger.get(assetId);
    if (r?.status !== 'refunding') return r?.refundTx ?? '';
    const asset = await loadAsset(assetId); // throws on an RPC error: "not the market's" must be true
    if (!marketHolds(asset)) {
      await ledger.refunded(assetId);
      return '';
    }
    const built = await build(asset, r.seller);
    await ledger.refundPending(assetId, built.sig, built.lastValid);
    try {
      await send(built);
    } catch (e) {
      // Refused by the node: never submitted, safe to send again. Anything else may have reached a leader.
      if (rejectedBeforeSubmit(e)) await ledger.refundDropped(assetId, built.sig);
      throw e;
    }
    const err = await confirm(built); // a timeout throws with the signature kept, for resolveRefund
    if (err) {
      await ledger.refundDropped(assetId, built.sig); // landed and failed: it moved nothing and can never run again
      throw new Error('The transfer returning this fish failed on-chain');
    }
    await ledger.refunded(assetId);
    return built.sig;
  }

  /** A 'refunding' record a request or the sweep finds: did the fish go back? 'refunded' | 'unrefunded' | 'in-flight'. */
  async function resolveRefund(assetId) {
    const r = await ledger.get(assetId);
    if (r?.status === 'refunded') return 'refunded';
    if (r?.status !== 'refunding') return 'in-flight'; // not a refund (never asked of one): send nothing
    const asset = await loadAsset(assetId); // throws on an RPC error
    // Only a refund moves a fish out of the market without paying for it (a paid one is burned, never this record).
    if (!marketHolds(asset)) {
      await ledger.refunded(assetId);
      return 'refunded';
    }
    if (!r.refundTx) return 'unrefunded';
    // The height is read BEFORE the status: past the blockhash's last valid height on the finalized
    // chain, a lookup made afterwards that finds nothing means it never landed (market-payout.mjs).
    const height = await getBlockHeight();
    const status = await getSignatureStatus(r.refundTx);
    if (status) {
      if (!LANDED.has(status.commitment)) return 'in-flight';
      if (status.error) {
        await ledger.refundDropped(assetId, r.refundTx);
        return 'unrefunded';
      }
      // It went back, and the market holds the fish again: the seller handed it over anew.
      await ledger.refunded(assetId);
      return 'refunded';
    }
    if (Number.isSafeInteger(r.refundLastValid) && height > r.refundLastValid) {
      await ledger.refundDropped(assetId, r.refundTx); // expired and not on chain: it can never land now
      return 'unrefunded';
    }
    return 'in-flight';
  }

  return { refund, resolveRefund };
}

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
//
// A round is the refund of one transfer (the record's transferTx): the fish handed over again under
// another transfer is a new round. Every ledger step names the round it acts for, so a step of an
// earlier round that comes late (a slow confirmation, another instance) never closes the next round
// (the fish would stay the market's, recorded as returned) nor puts its signature on it (the fish
// would go to the wallet it left). "Not the market's" is read only from the chain saying so: the
// account has another owner, or definitely does not exist (loadAsset); any other RPC error throws.

import { rejectedBeforeSubmit } from './market-payout.mjs';
import { HttpError } from './market-rules.mjs';

/** A step of one refund round found the fish in another round (handed over again meanwhile). */
const anotherRound = () => new HttpError(409, 'This fish was handed over again while it was being returned, try again in a minute');

const LANDED = new Set(['confirmed', 'finalized']);

/**
 * deps:
 *   ledger                    SoldLedger, or the Redis store's ledger (refundPending, refundDropped, refunded)
 *   market                    the market wallet's address
 *   loadAsset(assetId)        -> the Core asset, or null only when the account definitely does not
 *                                exist; throws on any other error (assetOrNull, market-server-mode.mjs)
 *   build(asset, seller)      -> { tx, sig, lastValid, ... }  a signed, unsent transfer of `asset` to `seller`
 *   send(built)               submits it; throws on any failure (see rejectedBeforeSubmit)
 *   confirm(built)            waits for it: the on-chain error (null when it succeeded); throws on timeout/expiry
 *   getSignatureStatus(sig)   -> null | { error, commitment }  (searching history)
 *   getBlockHeight()          -> the FINALIZED block height
 */
export function createRefund({ ledger, market, loadAsset, build, send, confirm, getSignatureStatus, getBlockHeight }) {
  const marketHolds = (asset) => asset != null && String(asset.owner) === market;

  /**
   * Send the 'refunding' fish of round `transferTx` back to its seller and confirm it; marks that
   * round refunded. Returns the refund signature ('' when the market turned out not to hold the fish
   * any more). The signature and expiry are persisted before sending (another instance's refund on
   * record, or the record already another round's: 409, nothing sent). Throws when it did not land
   * (the record keeps whatever resolveRefund needs to decide later).
   */
  async function refund(assetId, transferTx) {
    const r = await ledger.get(assetId);
    if (r?.transferTx !== transferTx) throw anotherRound();
    if (r.status !== 'refunding') return r.refundTx ?? '';
    const asset = await loadAsset(assetId); // throws on an RPC error: "not the market's" must be true
    if (!marketHolds(asset)) {
      if (!(await ledger.refunded(assetId, transferTx))) throw anotherRound();
      return '';
    }
    const built = await build(asset, r.seller);
    await ledger.refundPending(assetId, transferTx, built.sig, built.lastValid); // 409 if the round moved on meanwhile
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
    // It landed: this round's fish went back. false only if another instance already found it so and
    // the seller handed the fish over again since; that next round is left as it is.
    await ledger.refunded(assetId, transferTx);
    return built.sig;
  }

  /**
   * The 'refunding' record a request or the sweep finds: did the fish go back? 'refunded' |
   * 'unrefunded' | 'in-flight', for the round on record (its transferTx) when this was called. A
   * record that moved on to another round meanwhile reads 'in-flight': the caller sends nothing.
   */
  async function resolveRefund(assetId) {
    const r = await ledger.get(assetId);
    if (r?.status === 'refunded') return 'refunded';
    if (r?.status !== 'refunding') return 'in-flight'; // not a refund (never asked of one): send nothing
    const round = r.transferTx;
    const done = async () => ((await ledger.refunded(assetId, round)) ? 'refunded' : 'in-flight');
    const asset = await loadAsset(assetId); // throws on any RPC error but "no such account"
    // Only a refund moves a fish out of the market without paying for it (a paid one is burned, never this record).
    if (!marketHolds(asset)) return done();
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
      return done();
    }
    if (Number.isSafeInteger(r.refundLastValid) && height > r.refundLastValid) {
      await ledger.refundDropped(assetId, r.refundTx); // expired and not on chain: it can never land now
      return 'unrefunded';
    }
    return 'in-flight';
  }

  return { refund, resolveRefund };
}

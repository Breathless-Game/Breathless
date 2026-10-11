// Server mode's PEARL payout: send one mint-to-seller transaction per fish and, after a crash or
// a timeout, decide from the chain whether it landed. The chain is behind injected functions so
// market-payout.test.mjs can drive it with a fake.
//
// The rule that keeps a fish from being paid twice: a payout is only forgotten (payDropped, so
// the next request pays again) when it is KNOWN never to mint:
//   - the RPC node answered the send with an error (preflight / simulation failed): a node
//     returns that error before it forwards anything, so the transaction never reached a leader;
//   - it landed and failed (its signature is consumed, it can never run again);
//   - its blockhash expired (finalized block height > lastValidBlockHeight) and it is not on chain.
// Anything else (a timeout, a dropped connection, an error we don't recognise) keeps the
// signature, and resolvePending answers 'in-flight' until one of the above is true.

/**
 * Did the RPC node refuse this send? True only for web3.js's SendTransactionError (thrown when
 * the JSON-RPC response carries an `error`, which with preflight on is always before forwarding),
 * possibly wrapped by umi in a ProgramError (`cause`). "Already processed" means it DID land.
 */
export function rejectedBeforeSubmit(e) {
  for (let x = e, depth = 0; x && typeof x === 'object' && depth < 5; x = x.cause, depth++) {
    if (typeof x.transactionMessage === 'string') return !/already (been )?processed/i.test(x.transactionMessage);
  }
  return false;
}

const LANDED = new Set(['confirmed', 'finalized']);

/**
 * deps:
 *   ledger                       SoldLedger
 *   build(assetId, mint, seller, pearls) -> { tx, sig, lastValid, ... }  a signed, unsent payout
 *   send(built)                  submits it; throws on any failure (see rejectedBeforeSubmit)
 *   confirm(built)               waits for it: the on-chain error (null when it succeeded); throws on timeout/expiry
 *   getSignatureStatus(sig)      -> null | { error, commitment }  (searching history)
 *   getBlockHeight()             -> the FINALIZED block height
 */
export function createPayout({ ledger, build, send, confirm, getSignatureStatus, getBlockHeight }) {
  /** Mint `pearls` to the seller for `assetId`. The signature and expiry are persisted before sending. */
  async function pay(assetId, mint, seller, pearls) {
    const built = await build(assetId, mint, seller, pearls);
    ledger.payPending(assetId, built.sig, built.lastValid);
    try {
      await send(built);
    } catch (e) {
      // Refused by the node: never submitted, safe to pay again. Anything else (a timeout, a reset
      // connection) may have reached a leader: keep the signature, resolvePending decides later.
      if (rejectedBeforeSubmit(e)) ledger.payDropped(assetId);
      throw e;
    }
    // A timeout or blockheight-exceeded here throws with the signature kept, for resolvePending.
    const err = await confirm(built);
    if (err) {
      ledger.payDropped(assetId); // landed and failed: it minted nothing and can never run again
      throw new Error('PEARL mint transaction failed');
    }
    ledger.paid(assetId);
  }

  /** A record stuck in `paying` (crash or timeout): did its pay tx land? 'paid' | 'unpaid' | 'in-flight'. */
  async function resolvePending(assetId) {
    const r = ledger.get(assetId);
    if (!r.payTx) return 'unpaid';
    // The height is read BEFORE the status: if the finalized chain was already past the blockhash's
    // last valid height, any block that could hold the tx is finalized too, so a status lookup
    // made afterwards that finds nothing means it never landed.
    const height = await getBlockHeight();
    const status = await getSignatureStatus(r.payTx);
    if (status) {
      if (!LANDED.has(status.commitment)) return 'in-flight'; // processed only: could still be on a fork
      if (status.error) {
        ledger.payDropped(assetId); // landed and failed: nothing was minted
        return 'unpaid';
      }
      ledger.paid(assetId);
      return 'paid';
    }
    if (Number.isSafeInteger(r.payLastValid) && height > r.payLastValid) {
      ledger.payDropped(assetId); // expired and not on chain: it can never land now
      return 'unpaid';
    }
    return 'in-flight';
  }

  return { pay, resolvePending };
}

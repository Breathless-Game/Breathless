// When can a signed transaction no longer land? Normally at the lastValidBlockHeight of the
// blockhash the caller fetched before signing. The desktop app's browser wallet (desktop-wallet.ts)
// may put a fresher blockhash in while the player takes their time in the browser, so every owner
// transaction is confirmed (and journaled) with the expiry of the blockhash it was actually signed
// with: expiryOf(signedTx, fetched). No imports: pearl.ts, player-chain.ts and wallet.ts share it.

export interface BlockhashExpiry {
  blockhash: string;
  lastValidBlockHeight: number;
}

const KEEP = 64;
const known = new Map<string, number>();

/** A blockhash a transaction was re-signed with, and its expiry. */
export function noteBlockhashExpiry(blockhash: string, lastValidBlockHeight: number): void {
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error('Bad lastValidBlockHeight');
  known.delete(blockhash);
  known.set(blockhash, lastValidBlockHeight);
  while (known.size > KEEP) known.delete(known.keys().next().value as string);
}

/**
 * The blockhash `tx` was signed with and its expiry: `fetched` when it is that one, else the one
 * noted when its blockhash was swapped. Throws when neither (better than confirming against the
 * wrong expiry and calling a transaction that may still land "failed"); nothing is sent by then.
 */
export function expiryOf(tx: { message: { blockhash: string } }, fetched: BlockhashExpiry): BlockhashExpiry {
  const blockhash = tx.message.blockhash;
  if (blockhash === fetched.blockhash) return fetched;
  const lastValidBlockHeight = known.get(blockhash);
  if (lastValidBlockHeight === undefined) throw new Error(`No expiry known for blockhash ${blockhash}; not sending`);
  return { blockhash, lastValidBlockHeight };
}

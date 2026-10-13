import type { PublicKey, Signer, Transaction, TransactionSignature, Umi } from '@metaplex-foundation/umi';
import { addressBytes, checkRelayedTransaction, fromBase64, RelayCheckError, toBase64, zeroSignatures, type Verify } from './link-tx';
import { t } from './i18n';

// The desktop app's owner signer: an umi Signer whose signatures come from the player's wallet in
// their normal browser, through the server relay (desktop-wallet.ts runs the relay and its UI).
// Only type imports from umi, so tests load this with a real umi and a simulated link page.
//
// Signer order and the blockhash swap. umi's buildAndSign signs with the fee payer first, then
// each instruction's signers, so the owner is not always first: burnFish's fee payer is the
// session key, which has signed by the time the owner is asked. The link page may put a fresher
// blockhash in (the player can take longer than a blockhash lives), and that invalidates every
// signature made before. So:
//   - every signature slot is zeroed before the relay (the page only ever signs the owner's);
//   - slots already signed by a key this device holds (the session key: `local`) are signed
//     again over the returned message; slots signed later are signed over it in the first place;
//   - a slot signed by a key this device does NOT hold (the market's oracle co-signature on a
//     program-mode sale) can't be redone: then the page is told to keep the blockhash, and the
//     returned message must be byte-identical, blockhash included;
//   - each returned transaction is checked (link-tx.ts checkRelayedTransaction) before anything
//     is kept from it; only the owner's signature and the message are taken from it.
// Callers confirm with expiryOf (blockhash-expiry.ts): `noteExpiry` records the new blockhash's
// lastValidBlockHeight before the signed transactions are handed back.

export interface RelayRequest {
  owner: string;
  /** Unsigned transactions (every signature slot zero), base64. */
  txs: string[];
  /** Sign as is: some slot already holds a signature this device can't make again. */
  keepBlockhash: boolean;
}

export interface RelayResponse {
  /** The transactions as the browser wallet signed them, base64. */
  txs: string[];
  /** The blockhash the link page put in, and its expiry (absent when it kept the original). */
  blockhash?: string;
  lastValidBlockHeight?: number;
}

export interface RelaySignerDeps {
  umi: Pick<Umi, 'transactions'>;
  /** The owner's address. */
  address: string;
  /** Signers this device holds that may have signed before the owner (the session key). */
  local: readonly Signer[];
  relay(req: RelayRequest): Promise<RelayResponse>;
  verify: Verify;
  /** Record the new blockhash's expiry (blockhash-expiry.ts noteBlockhashExpiry). */
  noteExpiry(blockhash: string, lastValidBlockHeight: number): void | Promise<void>;
}

const isZero = (sig: Uint8Array) => sig.every((b) => b === 0);

/** Thrown when the relay's answer can't be used: retrying the same request won't help. */
export class RelayError extends Error {
  readonly noRetry = true;
  constructor(message: string) {
    super(message);
    this.name = 'RelayError';
  }
}

export function createRelaySigner(deps: RelaySignerDeps): Signer {
  const { umi, address, local, verify } = deps;
  const owner = addressBytes(address);
  const holder = (key: PublicKey) => local.find((s) => s.publicKey.toString() === key.toString()) ?? null;

  async function signAll(txs: Transaction[]): Promise<Transaction[]> {
    if (!txs.length) return [];
    const plans = txs.map((tx) => {
      const n = tx.message.header.numRequiredSignatures;
      const ownerIndex = tx.message.accounts.findIndex((k, i) => i < n && k.toString() === address);
      if (ownerIndex < 0) throw new RelayError(t('This transaction does not ask for the owner to sign', '这笔交易不需要钱包所有者签名'));
      const before = tx.signatures.map((s, i) => (i !== ownerIndex && i < n && !isZero(s) ? i : -1)).filter((i) => i >= 0);
      return { tx, ownerIndex, before };
    });
    const keepBlockhash = plans.some((p) => p.before.some((i) => !holder(p.tx.message.accounts[i])));
    const sent = plans.map((p) => zeroSignatures(umi.transactions.serialize(p.tx)));
    const res = await deps.relay({ owner: address, txs: sent.map(toBase64), keepBlockhash });
    if (!Array.isArray(res?.txs) || res.txs.length !== txs.length) throw new RelayError(t(`The browser wallet returned ${res?.txs?.length ?? 0} of ${txs.length} transactions`, `浏览器钱包只返回了 ${res?.txs?.length ?? 0} / ${txs.length} 笔交易`));

    const checked = sent.map((unsigned, i) => {
      let got: Uint8Array;
      try {
        got = fromBase64(res.txs[i]);
      } catch {
        throw new RelayError(t('The browser wallet returned an unreadable transaction', '浏览器钱包返回的交易无法解析'));
      }
      try {
        return checkRelayedTransaction(unsigned, got, owner, verify, { keepBlockhash });
      } catch (e) {
        const why = e instanceof RelayCheckError ? t(e.message, e.zh) : String((e as Error).message);
        throw new RelayError(t(`Refused the browser wallet's transaction: ${why}`, `已拒绝浏览器钱包返回的交易：${why}`));
      }
    });
    const swapped = checked.filter((c) => c.blockhashChanged);
    if (swapped.length) {
      // One fetch on the page, so one blockhash for the batch; its expiry is needed to confirm.
      if (swapped.some((c) => c.blockhash !== res.blockhash) || res.lastValidBlockHeight === undefined) {
        throw new RelayError(t('The browser wallet changed the blockhash without saying until when it is valid', '浏览器钱包换了 blockhash，却没有给出它的有效期'));
      }
      await deps.noteExpiry(res.blockhash as string, res.lastValidBlockHeight);
    }

    const out: Transaction[] = [];
    for (const [i, p] of plans.entries()) {
      const c = checked[i];
      const signatures: TransactionSignature[] = p.tx.signatures.map((s, j) =>
        j === c.ownerIndex ? c.ownerSignature : c.blockhashChanged ? new Uint8Array(64) : s,
      );
      let tx: Transaction = { message: umi.transactions.deserializeMessage(c.message), serializedMessage: c.message, signatures };
      if (c.blockhashChanged) for (const j of p.before) tx = await holder(p.tx.message.accounts[j])!.signTransaction(tx);
      out.push(tx);
    }
    return out;
  }

  return {
    // umi's PublicKey is the base58 string itself (addressBytes above checked it).
    publicKey: address as PublicKey,
    async signMessage() {
      throw new RelayError(t('The browser wallet signs transactions only', '浏览器钱包只签交易'));
    },
    signTransaction: async (tx) => (await signAll([tx]))[0],
    signAllTransactions: signAll,
  };
}

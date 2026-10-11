// Pearls, the in-game currency, are a real SPL token (PEARL, decimals 0) on
// Solana devnet. This is the player's side; the market is sensor/market.mjs,
// reached same-origin at /api/market (Vite proxies it in dev). Like chain.ts,
// the chain libraries load lazily.
//
// The market runs in one of two modes, reported by /api/market/info:
//   program  The fish_market program owns PEARL. The server quotes a sell_fish
//            transaction it has co-signed as oracle; the owner signs and sends
//            it, and the program burns the fish and mints PEARL atomically.
//   server   Fallback. The owner transfers the fish to the market wallet, which
//            verifies the transfer, mints PEARL to the owner and burns the fish.
//            Many fish go at once: their Core transfers are packed into as few
//            transactions as fit, and the wallet signs them all in ONE prompt
//            (signAllTransactions); the market then verifies and pays each fish.
// Either way the owner (wallet.ts) signs and pays the fees.

// Already loaded by main.ts; only the chain libraries below are lazy.
import { storageKey } from './wallet';

export type SellStep = 'verify' | 'sign' | 'confirm';
/** What a sale of several fish is doing: the step, how many fish it is at, and (at 'sign') how many transactions the one prompt covers. */
export interface SellProgress {
  step: SellStep;
  fish: number;
  txs?: number;
}
/** One fish's outcome in sellManyToMarket: its result, or why it did not sell (it stays the player's, or resumes next time). */
export interface SellOutcome {
  assetId: string;
  result?: SellResult;
  error?: string;
  /** The player declined the wallet prompt: nothing was sent. */
  rejected?: boolean;
}
export interface SellResult {
  pearls: number;
  /** The tx that paid the PEARL: sell_fish (program mode) or the market's mint (server mode). */
  tx: string;
  /** Server mode only: [transfer tx, burn tx]. */
  extra?: string[];
}
export interface MarketInfo {
  mode: 'program' | 'server';
  symbol: string;
  /** PEARL mint; null in server mode until the market wallet has SOL to create it. */
  pearlMint: string | null;
  tokenProgram: string;
  /** Program mode: the fish_market program and the oracle that co-signs quotes. */
  programId: string | null;
  oracle: string | null;
  /** Server mode: the market wallet (PEARL mint authority, receives sold fish). */
  market: string | null;
  /** Whether the market side can pay its fees (always true in program mode). */
  funded: boolean;
  /** Program mode: the on-chain config exists and names this server as oracle. */
  ready?: boolean;
  /** Server mode: POST /quote-batch and /sell-batch exist (older servers sell one fish per request). */
  batch?: boolean;
}
type LiveInfo = MarketInfo & { pearlMint: string };

export class InsufficientPearlsError extends Error {
  constructor(
    readonly have: number,
    readonly need: number,
  ) {
    super(`Not enough PEARL: have ${have}, need ${need}`);
    this.name = 'InsufficientPearlsError';
  }
}

const API = '/api/market';
/**
 * assetId -> a sale already signed or sent, so a retry after a timeout or reload resumes instead of
 * starting over. Server mode writes it after the wallet signed the transfer and before it is sent;
 * `lastValid` (the transfer's blockhash expiry) tells a transfer that never landed from a slow one.
 * Entries from before batching have no `lastValid` and go straight to the market as before.
 */
const PENDING_KEY = 'deepbreath.pearl.pending';
type Pending =
  | { mode: 'program'; tx: string; pearls: number }
  | { mode: 'server'; transferTx: string; lastValid?: number };

/**
 * Most fish per transfer transaction. Measured with umi (sensor/, mpl-core 1.x): a TransferV1
 * transaction is 200 bytes plus 44 per fish without a collection, so 23 fit in Solana's 1232
 * bytes. 20 (1080 bytes) leaves ~150 bytes for what a wallet may add before signing (Phantom
 * can append Lighthouse guard instructions). Packing also measures, so a fish in a collection
 * (one more account) still never overflows.
 */
const FISH_PER_TX = 20;
const TX_BYTE_BUDGET = 1232 - 150;
/** The server's MAX_BATCH (sensor/market-rules.mjs): fish per /quote-batch or /sell-batch request. */
const MARKET_BATCH = 24;

const offline = () =>
  new Error(import.meta.env?.DEV ? 'PEARL market is offline (run `npm run market`)' : 'PEARL market is offline, try again later');

async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      `${API}${path}`,
      body === undefined
        ? undefined
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    throw offline();
  }
  // No JSON at all (a proxy error page, or a static server answering with index.html) means no market.
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!json || typeof json !== 'object') throw offline();
  if (!res.ok) throw new Error(json.error ?? `PEARL market error ${res.status}`);
  return json;
}

export function marketInfo(): Promise<MarketInfo> {
  return api<MarketInfo>('/info');
}

async function liveInfo(): Promise<LiveInfo> {
  const info = await marketInfo();
  if (!info.pearlMint) throw new Error(`PEARL is not live yet: the market wallet ${info.market} needs devnet SOL`);
  return info as LiveInfo;
}

// getUmi() hands out one Umi per connected owner; register the toolbox on each.
const toolboxReady = new WeakSet<object>();

async function lib() {
  const [chain, wallet, toolbox, core, umi, serializers] = await Promise.all([
    import('./chain'),
    import('./wallet'),
    import('@metaplex-foundation/mpl-toolbox'),
    import('@metaplex-foundation/mpl-core'),
    import('@metaplex-foundation/umi'),
    import('@metaplex-foundation/umi/serializers'),
  ]);
  const u = chain.getUmi();
  if (!toolboxReady.has(u)) {
    u.use(toolbox.mplToolbox());
    toolboxReady.add(u);
  }
  return {
    u,
    owner: wallet.ownerAddress(u),
    signer: wallet.ownerSigner(u),
    toolbox,
    core,
    umi,
    base58: serializers.base58,
  };
}

async function pearlAccount(info: LiveInfo) {
  const { u, owner, toolbox, umi } = await lib();
  const ata = toolbox.findAssociatedTokenPda(u, {
    mint: umi.publicKey(info.pearlMint),
    owner: umi.publicKey(owner),
    tokenProgramId: umi.publicKey(info.tokenProgram),
  });
  const acc = await u.rpc.getAccount(ata[0]);
  // SPL token account (Token and Token-2022 alike): mint 32, owner 32, amount u64 LE at 64.
  const amount =
    acc.exists && acc.data.length >= 72
      ? Number(new DataView(acc.data.buffer, acc.data.byteOffset).getBigUint64(64, true))
      : 0;
  return { ata, amount };
}

/** PEARL held by the owner. 0 before the first sale (no token account yet). */
export async function pearlBalance(): Promise<number> {
  const info = await marketInfo();
  if (!info.pearlMint) return 0;
  return (await pearlAccount(info as LiveInfo)).amount;
}

function pending(): Record<string, Pending> {
  try {
    return JSON.parse(localStorage.getItem(storageKey(PENDING_KEY)) ?? '{}') as Record<string, Pending>;
  } catch {
    return {};
  }
}

function setPending(assetId: string, entry: Pending | null) {
  try {
    const all = pending();
    if (entry) all[assetId] = entry;
    else delete all[assetId];
    localStorage.setItem(storageKey(PENDING_KEY), JSON.stringify(all));
  } catch {}
}

/** Sell a fish NFT for its catch value in PEARL. Safe to call again after a failure or timeout. */
export async function sellToMarket(assetId: string, onStep?: (s: SellStep) => void): Promise<SellResult> {
  const info = await liveInfo();
  if (info.mode === 'program') return sellViaProgram(info, assetId, onStep);
  const [out] = await sellManyViaServer(info, [assetId], (p) => onStep?.(p.step));
  if (out.result) return out.result;
  throw new Error(out.error ?? 'Sale failed');
}

/**
 * Sell several fish. Server mode: one wallet prompt for all of them (their transfers packed
 * into as few transactions as fit, signed together). Program mode: each fish is its own
 * sell_fish transaction and prompt, as before. Never throws for one fish: every fish gets an
 * outcome, in the order given. Safe to call again with the same fish after any failure.
 */
export async function sellManyToMarket(assetIds: string[], onProgress?: (p: SellProgress) => void): Promise<SellOutcome[]> {
  const info = await liveInfo();
  if (info.mode === 'server') return sellManyViaServer(info, assetIds, onProgress);
  const out: SellOutcome[] = [];
  for (const assetId of assetIds) {
    try {
      out.push({ assetId, result: await sellViaProgram(info, assetId, (step) => onProgress?.({ step, fish: 1, txs: 1 })) });
    } catch (e) {
      out.push(failure(assetId, e));
    }
  }
  return out;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Same test as isUserRejection in wallet-storage.ts (inlined: pearl-e2e.mjs loads this file on its own). */
const rejectedByUser = (e: unknown) => {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === 4001 || (typeof err?.message === 'string' && /user rejected|rejected the request|cancel/i.test(err.message));
};
const failure = (assetId: string, e: unknown): SellOutcome => ({
  assetId,
  error: messageOf(e).slice(0, 200),
  ...(rejectedByUser(e) ? { rejected: true } : {}),
});
const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sellViaProgram(info: LiveInfo, assetId: string, onStep?: (s: SellStep) => void): Promise<SellResult> {
  const { u, owner, signer, base58 } = await lib();
  const prev = pending()[assetId];
  if (prev?.mode === 'program') {
    const [status] = await u.rpc.getSignatureStatuses([base58.serialize(prev.tx)], { searchTransactionHistory: true });
    if (status && !status.error) {
      setPending(assetId, null);
      return { pearls: prev.pearls, tx: prev.tx };
    }
  }

  onStep?.('verify');
  const quote = await api<{ tx: string; pearls: number; lastValidBlockHeight: number }>('/quote', {
    assetId,
    seller: owner,
  });
  const tx = u.transactions.deserialize(Uint8Array.from(atob(quote.tx), (c) => c.charCodeAt(0)));
  // Sign only what we expect: one sell_fish call, paid by the owner, co-signed by the oracle.
  const m = tx.message;
  if (
    m.accounts[0] !== owner ||
    m.header.numRequiredSignatures !== 2 ||
    m.instructions.length !== 1 ||
    m.accounts[m.instructions[0].programIndex] !== info.programId
  ) {
    throw new Error('The market sent an unexpected transaction; not signing it');
  }

  onStep?.('sign');
  const signed = await signer.signTransaction(tx);
  const sigBytes = await u.rpc.sendTransaction(signed, { preflightCommitment: 'confirmed' });
  const sig = base58.deserialize(sigBytes)[0];
  setPending(assetId, { mode: 'program', tx: sig, pearls: quote.pearls });

  onStep?.('confirm');
  const res = await u.rpc.confirmTransaction(sigBytes, {
    commitment: 'confirmed',
    strategy: { type: 'blockhash', blockhash: m.blockhash, lastValidBlockHeight: quote.lastValidBlockHeight },
  });
  setPending(assetId, null);
  if (res.value.err) throw new Error(`Sale failed on-chain: ${JSON.stringify(res.value.err)}`);
  return { pearls: quote.pearls, tx: sig };
}

type Lib = Awaited<ReturnType<typeof lib>>;
type Tx = Parameters<Lib['signer']['signTransaction']>[0];

/**
 * Transfers signed earlier (this page or before a reload): did they land? 'landed', 'failed' (it
 * never will, so the fish is still the player's) or 'unknown' (an entry from before batching, with
 * no expiry: the market looks it up, as it always did). Waits while one may still land.
 */
async function settleTransfers(l: Lib, entries: { transferTx: string; lastValid?: number }[]) {
  const verdict = new Map<string, 'landed' | 'failed' | 'unknown'>();
  const expiry = new Map(entries.map((e) => [e.transferTx, e.lastValid]));
  let open = [...expiry.keys()].filter((sig) => {
    if (expiry.get(sig) !== undefined) return true;
    verdict.set(sig, 'unknown');
    return false;
  });
  while (open.length) {
    const statuses = await l.u.rpc.getSignatureStatuses(
      open.map((sig) => l.base58.serialize(sig)),
      { searchTransactionHistory: true },
    );
    const height = await l.u.rpc.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]);
    open = open.filter((sig, i) => {
      const st = statuses[i];
      if (st && st.commitment !== 'processed') {
        verdict.set(sig, st.error ? 'failed' : 'landed');
        return false;
      }
      if (!st && height > (expiry.get(sig) as number)) {
        verdict.set(sig, 'failed'); // its blockhash expired before it landed: it never will
        return false;
      }
      return true;
    });
    if (open.length) await sleep(2000);
  }
  return verdict;
}

/** Sign every transaction with one wallet prompt; a wallet that can't do several at once signs them one by one. */
async function signAll(signer: Lib['signer'], txs: Tx[]): Promise<Tx[]> {
  if (txs.length === 1) return [await signer.signTransaction(txs[0])];
  try {
    const signed = await signer.signAllTransactions(txs);
    if (signed.length === txs.length) return signed;
    console.warn(`wallet returned ${signed.length} of ${txs.length} signed transactions; signing one at a time`);
  } catch (e) {
    if (rejectedByUser(e)) throw e;
    console.warn('wallet could not sign the transactions together; signing one at a time', e);
  }
  const out: Tx[] = [];
  for (const tx of txs) out.push(await signer.signTransaction(tx));
  return out;
}

async function sellManyViaServer(info: LiveInfo, assetIds: string[], onProgress?: (p: SellProgress) => void): Promise<SellOutcome[]> {
  const l = await lib();
  const { u, owner, signer, core, umi, base58 } = l;
  const market = info.market as string;
  const done = new Map<string, SellOutcome>();
  const fail = (id: string, e: unknown) => done.set(id, failure(id, e));
  /** assetId -> transfer signature, for fish the market now holds (or soon will). */
  const handedOver = new Map<string, string>();

  // 1. Fish signed or sent earlier: finish those without a new prompt.
  const prev = pending();
  const resumed = assetIds.filter((id) => prev[id]?.mode === 'server');
  if (resumed.length) {
    const entries = resumed.map((id) => prev[id] as Extract<Pending, { mode: 'server' }>);
    const verdict = await settleTransfers(l, entries);
    resumed.forEach((id, i) => {
      if (verdict.get(entries[i].transferTx) === 'failed') setPending(id, null); // still the player's: sold afresh below
      else handedOver.set(id, entries[i].transferTx);
    });
  }

  // 2. Price the rest first, so the market never ends up holding a fish it refuses to pay for.
  let fresh = assetIds.filter((id) => !handedOver.has(id));
  if (fresh.length) {
    onProgress?.({ step: 'verify', fish: assetIds.length });
    const refused = new Map<string, string>();
    if (info.batch) {
      for (const ids of chunks(fresh, MARKET_BATCH)) {
        const { quotes } = await api<{ quotes: { assetId: string; pearls?: number; error?: string }[] }>('/quote-batch', {
          seller: owner,
          assetIds: ids,
        });
        for (const q of quotes) if (q.error) refused.set(q.assetId, q.error);
      }
    } else {
      // An older market: one quote per fish.
      for (const id of fresh) await api('/quote', { assetId: id, seller: owner }).catch((e) => refused.set(id, messageOf(e)));
    }
    for (const [id, why] of refused) fail(id, new Error(why));
    fresh = fresh.filter((id) => !refused.has(id));
  }

  // 3. Hand the fish over: every transfer in as few transactions as fit, all signed in one prompt.
  if (fresh.length) {
    const assets = await Promise.all(fresh.map((id) => core.fetchAsset(u, umi.publicKey(id)).catch((e: unknown) => e as Error)));
    const toMove: { id: string; asset: Exclude<(typeof assets)[number], Error> }[] = [];
    await Promise.all(
      assets.map(async (asset, i) => {
        const id = fresh[i];
        if (asset instanceof Error) return fail(id, asset);
        if (asset.owner === market) {
          // Handed over earlier but the confirmation was lost: the latest tx on the asset is that transfer.
          const [last] = await u.rpc.call<{ signature: string }[]>('getSignaturesForAddress', [id, { limit: 1, commitment: 'confirmed' }]);
          if (last) handedOver.set(id, last.signature);
          else fail(id, new Error('The market holds this fish but its transfer was not found'));
        } else if (asset.owner !== owner) fail(id, new Error('This fish belongs to another wallet'));
        else toMove.push({ id, asset });
      }),
    );
    toMove.sort((a, b) => fresh.indexOf(a.id) - fresh.indexOf(b.id));

    if (toMove.length) {
      const blockhash = await u.rpc.getLatestBlockhash({ commitment: 'confirmed' });
      const start = () => umi.transactionBuilder().setFeePayer(signer).setBlockhash(blockhash);
      const groups: { ids: string[]; tx: Tx }[] = [];
      let ids: string[] = [];
      let builder = start();
      for (const { id, asset } of toMove) {
        const ua = asset.updateAuthority;
        const ix = core.transferV1(u, {
          asset: asset.publicKey,
          collection: ua.type === 'Collection' && ua.address ? ua.address : undefined,
          newOwner: umi.publicKey(market),
          payer: signer,
          authority: signer,
        });
        const next = builder.add(ix);
        if (ids.length && (ids.length >= FISH_PER_TX || next.getTransactionSize(u) > TX_BYTE_BUDGET)) {
          groups.push({ ids, tx: builder.build(u) });
          ids = [id];
          builder = start().add(ix);
        } else {
          ids.push(id);
          builder = next;
        }
      }
      groups.push({ ids, tx: builder.build(u) });

      onProgress?.({ step: 'sign', fish: toMove.length, txs: groups.length });
      let signed: Tx[] = [];
      try {
        signed = await signAll(signer, groups.map((g) => g.tx));
      } catch (e) {
        // Declined (or the wallet failed): nothing was sent, every fish is still the player's.
        for (const { id } of toMove) fail(id, e);
      }

      // Remember each transfer before it is sent: a reload from here on resumes instead of losing the fish.
      // The signature is read from what the wallet returned (a wallet may have changed the transaction).
      const sent = signed.map((tx, i) => ({ ids: groups[i].ids, tx, sig: base58.deserialize(tx.signatures[0])[0] }));
      for (const g of sent) for (const id of g.ids) setPending(id, { mode: 'server', transferTx: g.sig, lastValid: blockhash.lastValidBlockHeight });

      if (sent.length) onProgress?.({ step: 'confirm', fish: toMove.length });
      await Promise.all(
        sent.map(async (g) => {
          try {
            await u.rpc.sendTransaction(g.tx, { preflightCommitment: 'confirmed' });
          } catch (e) {
            // Refused in preflight, so never broadcast: the fish stay the player's.
            for (const id of g.ids) {
              setPending(id, null);
              fail(id, e);
            }
            return;
          }
          const res = await u.rpc
            .confirmTransaction(base58.serialize(g.sig), { commitment: 'confirmed', strategy: { type: 'blockhash', ...blockhash } })
            .catch(() => null);
          if (res?.value.err) {
            for (const id of g.ids) {
              setPending(id, null);
              fail(id, new Error(`Transfer failed on-chain: ${JSON.stringify(res.value.err)}`));
            }
            return;
          }
          // Confirmed, or the confirmation timed out: the market looks the transfer up (and a retry resumes it).
          for (const id of g.ids) handedOver.set(id, g.sig);
        }),
      );
    }
  }

  // 4. The market verifies each transfer and pays each fish.
  const sales = assetIds.filter((id) => handedOver.has(id)).map((id) => ({ assetId: id, transferTx: handedOver.get(id)! }));
  if (sales.length) {
    onProgress?.({ step: 'confirm', fish: sales.length });
    const settle = (id: string, r: SellResult | Error) => {
      if (r instanceof Error) return fail(id, r); // the transfer stays pending: the next try resumes it
      setPending(id, null);
      done.set(id, { assetId: id, result: r });
    };
    const asError = (e: unknown) => (e instanceof Error ? e : new Error(messageOf(e)));
    if (info.batch) {
      for (const batch of chunks(sales, MARKET_BATCH)) {
        try {
          const { results } = await api<{ results: (SellResult & { assetId: string; error?: string })[] }>('/sell-batch', {
            seller: owner,
            sales: batch,
          });
          for (const { assetId, error, pearls, tx, extra } of results) settle(assetId, error ? new Error(error) : { pearls, tx, extra });
        } catch (e) {
          for (const s of batch) settle(s.assetId, asError(e));
        }
      }
    } else {
      // An older market: one /sell per fish, each naming the transfer it was in (shared or not).
      for (const s of sales) settle(s.assetId, await api<SellResult>('/sell', { ...s, seller: owner }).catch(asError));
    }
  }

  return assetIds.map((id) => done.get(id) ?? { assetId: id, error: 'Sale did not finish; try again' });
}

/** Spend PEARL by burning it from the owner's token account. Returns the tx signature. */
export async function spendPearls(amount: number): Promise<string> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`spendPearls: amount must be a positive whole number, got ${amount}`);
  }
  const info = await liveInfo();
  const { u, signer, toolbox, umi, base58 } = await lib();
  const { ata, amount: have } = await pearlAccount(info);
  if (have < amount) throw new InsufficientPearlsError(have, amount);
  // A plain SPL burn by the holder, sent to whichever token program owns the mint.
  const [ix] = toolbox
    .burnToken(u, { account: ata, mint: umi.publicKey(info.pearlMint), authority: signer, amount: BigInt(amount) })
    .getInstructions();
  const { signature } = await umi
    .transactionBuilder()
    .add({ instruction: { ...ix, programId: umi.publicKey(info.tokenProgram) }, signers: [signer], bytesCreatedOnChain: 0 })
    .setFeePayer(signer)
    .sendAndConfirm(u);
  return base58.deserialize(signature)[0];
}

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
// Either way the owner (wallet.ts) signs and pays the fees.

export type SellStep = 'verify' | 'sign' | 'confirm';
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
/** assetId -> a sale already sent, so a retry after a timeout resumes instead of starting over. */
const PENDING_KEY = 'deepbreath.pearl.pending';
type Pending = { mode: 'program'; tx: string; pearls: number } | { mode: 'server'; transferTx: string };

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

let toolboxReady = false;

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
  if (!toolboxReady) {
    u.use(toolbox.mplToolbox());
    toolboxReady = true;
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
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}') as Record<string, Pending>;
  } catch {
    return {};
  }
}

function setPending(assetId: string, entry: Pending | null) {
  try {
    const all = pending();
    if (entry) all[assetId] = entry;
    else delete all[assetId];
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {}
}

/** Sell a fish NFT for its catch value in PEARL. Safe to call again after a failure or timeout. */
export async function sellToMarket(assetId: string, onStep?: (s: SellStep) => void): Promise<SellResult> {
  const info = await liveInfo();
  return info.mode === 'program' ? sellViaProgram(info, assetId, onStep) : sellViaServer(info, assetId, onStep);
}

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

async function sellViaServer(info: LiveInfo, assetId: string, onStep?: (s: SellStep) => void): Promise<SellResult> {
  const { u, owner, signer, core, umi, base58 } = await lib();
  const market = info.market as string;
  const prev = pending()[assetId];
  let transferTx = prev?.mode === 'server' ? prev.transferTx : '';

  if (!transferTx) {
    // Price it first, so the market never ends up holding a fish it refuses to pay for.
    onStep?.('verify');
    await api('/quote', { assetId, seller: owner });

    onStep?.('sign');
    const asset = await core.fetchAsset(u, umi.publicKey(assetId));
    if (asset.owner === market) {
      // Handed over earlier but the confirmation was lost: the latest tx on the asset is that transfer.
      const [last] = await u.rpc.call<{ signature: string }[]>('getSignaturesForAddress', [
        assetId,
        { limit: 1, commitment: 'confirmed' },
      ]);
      if (!last) throw new Error('The market holds this fish but its transfer was not found');
      transferTx = last.signature;
    } else {
      if (asset.owner !== owner) throw new Error('This fish belongs to another wallet');
      const ua = asset.updateAuthority;
      const collection = ua.type === 'Collection' && ua.address ? await core.fetchCollection(u, ua.address) : undefined;
      const { signature } = await core
        .transfer(u, { asset, collection, newOwner: umi.publicKey(market), authority: signer, payer: signer })
        .setFeePayer(signer)
        .sendAndConfirm(u);
      transferTx = base58.deserialize(signature)[0];
    }
    setPending(assetId, { mode: 'server', transferTx });
  }

  onStep?.('confirm');
  const result = await api<SellResult>('/sell', { assetId, seller: owner, transferTx });
  setPending(assetId, null);
  return result;
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

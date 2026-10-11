import type { FishSpec, Rarity } from './fish';

// The rules of the fish economy, with no runtime imports so tests/market.test.mjs can load it
// straight from TypeScript:
//   bank → NFT queued (pending) → minting → minted ──sell──► PEARL, fish leaves the bank
//                                      └→ failed → retried with backoff, or by hand
// Banking pays nothing; Pearls come only from selling a minted fish to the market.

/** A Pearl amount as text, pluralised: "1 Pearl", "0 Pearls", "12 Pearls". */
export function pearls(n: number): string {
  return `${n} ${n === 1 ? 'Pearl' : 'Pearls'}`;
}

export type NftStatus = 'pending' | 'minting' | 'minted' | 'failed';

/** A fish in the bank (`deepbreath.bank`), with its NFT and sale state. */
export interface BankedFish extends FishSpec {
  /** Where the fish's NFT is. Missing on a legacy fish nobody has asked to mint. */
  nft?: NftStatus;
  /** Banked under the old rule that paid Pearls on surfacing: already paid out, so never sold. */
  legacy?: true;
  /** Mint transaction, once minted. */
  mintTx?: string;
  /** Failed mint attempts since the last success or manual retry. */
  mintTries?: number;
  /** When a failed mint is retried automatically (epoch ms). Unset once retries run out. */
  retryAt?: number;
  mintError?: string;
  /** The player asked to sell: mint first if needed, then sell. */
  sellQueued?: true;
  /** The NFT's metadata URI points at our host (minted that way, or repaired from a dead Irys URI), or cannot be changed by us. */
  metaFixed?: true;
  /** The fish's global number (#0042), from our server before it is minted (or repaired). Never made up locally. */
  serial?: number;
  /** The NFT's on-chain name and URI carry the number (minted that way, or repaired), or cannot be changed by us. */
  nameFixed?: true;
  /** Failed attempts to write the number onto an already-minted NFT; repairs stop after a few. */
  repairTries?: number;
  /** The NFT is in the market's fish collection (minted into it, or migrated): the market will buy it. */
  trusted?: true;
  /** Why the market can never buy this NFT from here (e.g. minted by a game wallet on another device). */
  sellBlock?: string;
}

/** Same range as isSerial in nft-uri.ts (kept import-free here for the tests). */
const validSerial = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 999_999_999;

/** Automatic attempts before a failed mint waits for the player's Retry. */
export const MAX_AUTO_MINT_TRIES = 4;

/** Backoff after the nth failed attempt: 15 s, 30 s, 60 s, … capped at 10 min. */
export function retryDelayMs(tries: number): number {
  return Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, tries - 1));
}

/** A freshly banked fish: its NFT is queued straight away. */
export function bankEntry(fish: FishSpec): BankedFish {
  return { ...fish, nft: 'pending' };
}

export type NftEvent =
  | { type: 'start' }
  | { type: 'minted'; assetId: string; tx: string }
  | { type: 'failed'; error: string; now: number }
  /** The wallet ran out of SOL mid-mint: not the fish's fault, so no attempt is counted. */
  | { type: 'no-funds' }
  /** The market's per-wallet mint limit: back to the queue, no attempt counted, the queue waits. */
  | { type: 'paused' }
  /** The player's Retry on a failed mint. */
  | { type: 'retry' }
  /** The player's Mint on a legacy fish. */
  | { type: 'enqueue' }
  | { type: 'sell' }
  | { type: 'cancel-sell' };

/** Apply one event. Events that make no sense in the current state change nothing. */
export function nftStep(f: BankedFish, e: NftEvent): BankedFish {
  const s = f.nft;
  switch (e.type) {
    case 'start':
      return s === 'pending' || s === 'failed' ? { ...f, nft: 'minting', retryAt: undefined } : f;
    case 'minted':
      return s === 'minting'
        ? { ...f, nft: 'minted', assetId: e.assetId, mintTx: e.tx, mintTries: undefined, mintError: undefined, retryAt: undefined }
        : f;
    case 'failed': {
      if (s !== 'minting') return f;
      const tries = (f.mintTries ?? 0) + 1;
      const retryAt = tries < MAX_AUTO_MINT_TRIES ? e.now + retryDelayMs(tries) : undefined;
      return { ...f, nft: 'failed', mintTries: tries, mintError: e.error, retryAt };
    }
    case 'no-funds':
    case 'paused':
      return s === 'minting' ? { ...f, nft: 'pending' } : f;
    case 'retry':
      return s === 'failed' ? { ...f, nft: 'pending', mintTries: undefined, mintError: undefined, retryAt: undefined } : f;
    case 'enqueue':
      return s === undefined ? { ...f, nft: 'pending' } : f;
    case 'sell':
      if (f.legacy || f.sellBlock || s === undefined || s === 'minting') return f;
      // Mint & sell on a failed fish is also a retry.
      return s === 'failed' ? { ...nftStep(f, { type: 'retry' }), sellQueued: true } : { ...f, sellQueued: true };
    case 'cancel-sell':
      return f.sellQueued ? { ...f, sellQueued: undefined } : f;
  }
}

/**
 * Bring a saved bank up to date. Fish with no NFT status were banked by the old rule, which paid
 * their Pearls on surfacing: they become legacy (paid out, not sellable, not auto-minted). A mint cut
 * off by a reload goes back to the queue. Nothing is dropped except entries that are not fish at all.
 */
export function migrateBank(saved: unknown): { bank: BankedFish[]; changed: boolean } {
  if (!Array.isArray(saved)) return { bank: [], changed: false };
  let changed = false;
  const bank: BankedFish[] = [];
  for (const entry of saved) {
    if (!entry || typeof entry !== 'object') {
      changed = true;
      continue;
    }
    const f = { ...(entry as BankedFish) };
    if (f.nft === undefined && !f.legacy) f.legacy = true;
    if (f.nft !== undefined && !(['pending', 'minting', 'minted', 'failed'] as unknown[]).includes(f.nft)) f.nft = 'pending';
    if (f.assetId) f.nft = 'minted';
    else if (f.nft === 'minting' || f.nft === 'minted') f.nft = 'pending';
    if (f.legacy && f.sellQueued) delete f.sellQueued;
    if (f.serial !== undefined && !validSerial(f.serial)) delete f.serial;
    if (
      f.nft !== (entry as BankedFish).nft ||
      f.legacy !== (entry as BankedFish).legacy ||
      f.sellQueued !== (entry as BankedFish).sellQueued ||
      f.serial !== (entry as BankedFish).serial
    ) {
      changed = true;
    }
    bank.push(f);
  }
  return { bank, changed };
}

function mintable(f: BankedFish, now: number): boolean {
  return f.nft === 'pending' || (f.nft === 'failed' && f.retryAt !== undefined && f.retryAt <= now);
}

/** The next fish to mint, one at a time: fish the player wants to sell first, then oldest first. */
export function nextToMint(bank: readonly BankedFish[], now: number): BankedFish | null {
  return bank.find((f) => f.sellQueued && mintable(f, now)) ?? bank.find((f) => mintable(f, now)) ?? null;
}

/** When the queue should wake for the earliest automatic retry, if any. */
export function nextRetryAt(bank: readonly BankedFish[]): number | null {
  let at: number | null = null;
  for (const f of bank) if (f.nft === 'failed' && f.retryAt !== undefined && (at === null || f.retryAt < at)) at = f.retryAt;
  return at;
}

/** The next minted fish waiting to be sold. */
export function nextToSell(bank: readonly BankedFish[]): BankedFish | null {
  return bank.find((f) => f.sellQueued && f.nft === 'minted' && !f.legacy) ?? null;
}

/**
 * A banked fish that has not started settling: its NFT is only queued (never sent to mint, never
 * failed a mint, no asset or transaction), and it is in no sale flow. Only such a fish can be taken
 * back; anything minting, minted, failed or sale-pending is out of reach for good.
 */
export function unsettled(f: BankedFish): boolean {
  return f.nft === 'pending' && !f.legacy && !f.sellQueued && !f.assetId && !f.mintTx && !f.mintTries;
}

/**
 * What a shark bite takes from the bank: the fish banked during this dive (`thisDive`, by identity)
 * that are still unsettled and that the NFT queue is not working on right now (`busy`: minting or
 * selling it). Fish from earlier dives are never in `thisDive`, so they are never taken.
 */
export function biteForfeit(
  bank: readonly BankedFish[],
  thisDive: ReadonlySet<BankedFish>,
  busy: (f: BankedFish) => boolean = () => false,
): BankedFish[] {
  return bank.filter((f) => thisDive.has(f) && unsettled(f) && !busy(f));
}

export type SellQuote =
  | { ok: true; pearls: number; mintFirst: boolean }
  | { ok: false; reason: 'paid-out' | 'minting' | 'blocked' };

/**
 * What selling pays: the fish's catch value (`fishValue`, passed in), exactly what banking used to pay.
 * Legacy fish were already paid. A fish still minting must finish first; an unminted one is minted, then sold.
 */
export function sellQuote(f: BankedFish, value: (f: BankedFish) => number): SellQuote {
  if (f.legacy) return { ok: false, reason: 'paid-out' };
  if (f.sellBlock) return { ok: false, reason: 'blocked' };
  if (f.nft === 'minting') return { ok: false, reason: 'minting' };
  return { ok: true, pearls: value(f), mintFirst: f.nft !== 'minted' };
}

const CONFIRM_RARITIES: ReadonlySet<Rarity> = new Set<Rarity>(['epic', 'legendary', 'mythic']);

/** Epic and rarer fish ask before they are sold. */
export function needsConfirm(rarity: Rarity): boolean {
  return CONFIRM_RARITIES.has(rarity);
}

/** Fish of one rarity that "Sell all" would queue now. */
export function bulkSellable(bank: readonly BankedFish[], rarity: Rarity): BankedFish[] {
  return bank.filter((f) => f.rarity === rarity && !f.sellQueued && sellQuote(f, () => 0).ok);
}

/** Fish "Sell all" would queue now: every sellable fish except the ones that ask first (epic and rarer). */
export function bulkSellableBelowEpic(bank: readonly BankedFish[]): BankedFish[] {
  return bank.filter((f) => !needsConfirm(f.rarity) && !f.sellQueued && sellQuote(f, () => 0).ok);
}

// ---- Map unlock progress -------------------------------------------------
// Maps unlock by the lifetime value of every fish ever banked. Selling never lowers it.

/**
 * Lifetime banked value for a save from before selling: the old saved number was the highest bank
 * total, and the bank only ever grew, so it already is the lifetime value. Taking the max with the
 * current bank also covers a bank that predates map progress.
 */
export function migrateUnlockProgress(saved: number, bankTotal: number): number {
  return Math.max(Number.isFinite(saved) ? saved : 0, Number.isFinite(bankTotal) ? bankTotal : 0);
}

/** Lifetime value after banking `added` more. */
export function addBankedValue(lifetime: number, added: number): number {
  return lifetime + Math.max(0, Number.isFinite(added) ? added : 0);
}

/** Errors that mean the burner wallet cannot pay (for the upload or the transaction). */
export function isFundsError(message: string): boolean {
  return /insufficient|0x1\b|debit an account|not enough (balance|funds|sol)/i.test(message);
}

/**
 * Split /sell-batch sales into requests the market accepts: at most `maxFish` fish and at most
 * `maxTxs` different transfer transactions each (sensor/market-rules.mjs MAX_BATCH, MAX_BATCH_TXS).
 * Fish moved by the same transfer stay together and keep their order; a resumed sale can mix many
 * older transfers, which then simply take more requests.
 */
export function sellBatches<T extends { transferTx: string }>(sales: T[], maxFish: number, maxTxs: number): T[][] {
  const byTx = new Map<string, T[]>();
  for (const s of sales) {
    const group = byTx.get(s.transferTx);
    if (group) group.push(s);
    else byTx.set(s.transferTx, [s]);
  }
  const out: T[][] = [];
  let batch: T[] = [];
  let txs = new Set<string>();
  for (const [tx, group] of byTx) {
    for (const s of group) {
      if (batch.length >= maxFish || (!txs.has(tx) && txs.size >= maxTxs)) {
        out.push(batch);
        batch = [];
        txs = new Set();
      }
      batch.push(s);
      txs.add(tx);
    }
  }
  if (batch.length) out.push(batch);
  return out;
}

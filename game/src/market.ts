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
  /** The market's per-game-wallet mint limit: back to the queue, no attempt counted, the queue waits. */
  | { type: 'paused' }
  /**
   * This one fish can't be minted yet (409 'mint-in-flight': an earlier co-sign of it may still
   * land): back to the queue until `until`, no attempt counted; the queue moves on to other fish.
   */
  | { type: 'deferred'; until: number }
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
    case 'deferred':
      return s === 'minting' ? { ...f, nft: 'pending', retryAt: e.until } : f;
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
 * The market's answer to a co-sign request it would not take because it was not signed by our game
 * wallet (sensor/fish-trust.mjs assertSignedByPayer, 401 'bad-request-signature'), read from the
 * error text alone: a game tab loaded before the market began checking signatures counted that 401
 * as a failed attempt and saved only the message (BankedFish.mintError).
 */
export const isUnsignedRequestError = (message: unknown) => typeof message === 'string' && /not signed by its game wallet/.test(message);

/**
 * Bring a saved bank up to date. Fish with no NFT status were banked by the old rule, which paid
 * their Pearls on surfacing: they become legacy (paid out, not sellable, not auto-minted). A mint cut
 * off by a reload goes back to the queue. A mint that failed only because an older game tab sent
 * the market an unsigned request (isUnsignedRequestError) goes back to the queue too, its attempts
 * reset: this game signs, so it will go through. Nothing is dropped except entries that are not fish at all.
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
    else if (f.nft === 'failed' && !f.mintTx && isUnsignedRequestError(f.mintError)) {
      f.nft = 'pending';
      delete f.mintTries;
      delete f.mintError;
      delete f.retryAt;
    }
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

/** Queued and due: a pending fish (unless deferred until later) or a failed one whose retry time came. */
function mintable(f: BankedFish, now: number): boolean {
  if (f.nft === 'pending') return f.retryAt === undefined || f.retryAt <= now;
  return f.nft === 'failed' && f.retryAt !== undefined && f.retryAt <= now;
}

/** The next fish to mint, one at a time: fish the player wants to sell first, then oldest first. */
export function nextToMint(bank: readonly BankedFish[], now: number): BankedFish | null {
  return bank.find((f) => f.sellQueued && mintable(f, now)) ?? bank.find((f) => mintable(f, now)) ?? null;
}

/** When the queue should wake for the earliest automatic retry, if any. */
export function nextRetryAt(bank: readonly BankedFish[]): number | null {
  let at: number | null = null;
  for (const f of bank) if ((f.nft === 'failed' || f.nft === 'pending') && f.retryAt !== undefined && (at === null || f.retryAt < at)) at = f.retryAt;
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

// ---- Bulk-sell selection ---------------------------------------------------
// The Collection's checkboxes. Pure helpers so the rule stays in step with the per-card Sell button.

type Selling = { has(f: BankedFish): boolean };
const NOT_SELLING: Selling = { has: () => false };

/** Why a fish cannot be ticked for a bulk sale, or null when it can. Same rule as the Sell button, plus fish already queued or selling. */
export function bulkSelectBlock(f: BankedFish, selling: Selling = NOT_SELLING): 'paid-out' | 'blocked' | 'minting' | 'queued' | null {
  const quote = sellQuote(f, () => 0);
  if (!quote.ok) return quote.reason;
  if (f.sellQueued || selling.has(f)) return 'queued';
  return null;
}

/** Can this fish be ticked for a bulk sale? */
export function bulkSelectable(f: BankedFish, selling: Selling = NOT_SELLING): boolean {
  return bulkSelectBlock(f, selling) === null;
}

/** Keep only ticked fish that are still in the bank and still sellable (in bank order). */
export function pruneSelection(selected: ReadonlySet<BankedFish>, bank: readonly BankedFish[], selling: Selling = NOT_SELLING): Set<BankedFish> {
  return new Set(bank.filter((f) => selected.has(f) && bulkSelectable(f, selling)));
}

/** Count, total value, and whether the sale needs an extra confirm (any epic or rarer fish). */
export function selectionSummary(list: readonly BankedFish[], value: (f: BankedFish) => number): { count: number; total: number; needsConfirm: boolean } {
  return { count: list.length, total: list.reduce((s, f) => s + value(f), 0), needsConfirm: list.some((f) => needsConfirm(f.rarity)) };
}

/** Shift-click range: every selectable item between two positions of the displayed order, inclusive, in either direction. */
export function selectionRange<T>(order: readonly T[], from: T, to: T, selectable: (item: T) => boolean): T[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return selectable(to) ? [to] : [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1).filter(selectable);
}

// ---- Map unlock progress -------------------------------------------------
// Maps and ships unlock by the lifetime banked value on chain (player_state Progress, which
// record_catch raises with each co-signed mint; main.ts applyMapProgress). Selling never lowers it.

/**
 * The market refused to co-sign a mint because this fish's NFT was already sold or burned
 * (sensor/fish-collection.mjs claim, HTTP 409 'already-burned'). The fish is spent for good:
 * retrying can never succeed. Duck-typed like mintPauseOf below (fish-cosign.ts CosignError).
 */
export function isSpentFishError(e: unknown): boolean {
  const x = e as { status?: unknown; code?: unknown } | null;
  return x?.status === 409 && x.code === 'already-burned';
}

/** An RPC (or other HTTP) throttling error, read from its message: Solana RPCs answer 429 "Too Many Requests". */
export function isRateLimitError(e: unknown): boolean {
  return /\b429\b|too many requests/i.test(e instanceof Error ? e.message : String(e));
}

/** 'limit': the market's per-game-wallet mint limit. 'busy': the market, its RPC or ours is down or throttled for now. */
export type MintPauseKind = 'limit' | 'busy';

const MINT_LIMIT_PAUSE_MS = 60_000;
const MINT_BUSY_PAUSE_MS = 30_000;
const MAX_MINT_PAUSE_MS = 60 * 60_000;

/**
 * A mint error that is not the fish's fault, so the whole queue waits instead of the fish spending
 * one of its MAX_AUTO_MINT_TRIES (and every other queued fish spending one too, one after another):
 * - the market's mint limit (HTTP 429 from a co-sign request, fish-cosign.ts CosignError);
 * - the market offline (status 0), unreachable behind its gateway (502/504), or failing for now
 *   on purpose (503: sensor/market.mjs answers 503 when its RPC refuses it, "so the game retries";
 *   chain.ts throws 503 'collection-pending' while the market's fish collection is still being
 *   created). A 500 (or any other 5xx) is the market's catch-all and may be a bug tied to this one
 *   fish: it counts as a failed attempt, or that fish (always picked first) would block the queue forever;
 * - 401 'bad-request-signature': the market did not accept the session key's request signature
 *   (sensor/fish-trust.mjs assertSignedByPayer). A version mismatch, not the fish's fault: it stays
 *   queued; reloading the page loads a game that signs the way this market checks;
 * - the Solana RPC throttling our own send/confirm (429 / "Too Many Requests" in the message; only
 *   for errors with no HTTP status, so a market 4xx is never misread as throttling).
 * Returns how long to wait (the server's retryAfterMs when it gives one, capped at an hour), else null.
 * Everything else (4xx validation errors, 500, failed transactions, 409 'already-burned', and
 * 409 'mint-in-flight', which is about one fish: mintDeferralOf) is not a pause.
 */
export function mintPauseOf(e: unknown): { ms: number; kind: MintPauseKind } | null {
  const x = e as { status?: unknown; code?: unknown; retryAfterMs?: unknown } | null;
  const status = typeof x?.status === 'number' ? x.status : null;
  let kind: MintPauseKind;
  let fallback: number;
  if (status === 429) {
    kind = 'limit';
    fallback = MINT_LIMIT_PAUSE_MS;
  } else if (
    status === 0 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status === 401 && x?.code === 'bad-request-signature') ||
    (status === null && e != null && isRateLimitError(e))
  ) {
    kind = 'busy';
    fallback = MINT_BUSY_PAUSE_MS;
  } else {
    return null;
  }
  const after = x?.retryAfterMs;
  const ms = typeof after === 'number' && after > 0 ? Math.min(after, MAX_MINT_PAUSE_MS) : fallback;
  return { ms, kind };
}

const MINT_IN_FLIGHT_MS = 30_000;

/**
 * 409 'mint-in-flight' (sensor/fish-collection.mjs claim): an earlier co-sign of this fish may still
 * land. That is about this one fish, so only it waits (nftStep 'deferred': the server's retryAfterMs,
 * capped at an hour) and the queue mints the others meanwhile. A whole-queue pause would let one
 * stuck fish, always picked first, hold up every other fish for as long as it stays stuck (someone
 * who knew its id could keep it "in flight" by replaying an old co-sign of it). Returns ms, or null.
 */
export function mintDeferralOf(e: unknown): number | null {
  const x = e as { status?: unknown; code?: unknown; retryAfterMs?: unknown } | null;
  if (x?.status !== 409 || x.code !== 'mint-in-flight') return null;
  const after = x.retryAfterMs;
  return typeof after === 'number' && after > 0 ? Math.min(after, MAX_MINT_PAUSE_MS) : MINT_IN_FLIGHT_MS;
}

/**
 * What to tell the player about a fish the daily PEARL cap refused after it was already transferred
 * to the market: the market sends it back to their wallet (sensor/market-refund.mjs). `refunded` is
 * true once that transfer landed, 'pending' while it is still on its way. Null for any other outcome.
 * The time is when the cap takes this fish again (`retryAfterMs` from `now`), in UTC like the server's.
 */
export function returnedFishNote(
  o: { code?: string; refunded?: true | 'pending'; retryAfterMs?: number },
  now: number,
): { en: string; zh: string } | null {
  if (o.code !== 'daily-cap' || !o.refunded) return null;
  const at = new Date(now + Math.max(0, o.retryAfterMs ?? 0)).toISOString().slice(11, 16);
  return o.refunded === true
    ? {
        en: `Daily PEARL limit reached — your fish was returned to your wallet; you can sell it again after ${at} UTC.`,
        zh: `已达每日 PEARL 上限——这条鱼已退回你的钱包，${at} UTC 之后可以再次出售。`,
      }
    : {
        en: `Daily PEARL limit reached — your fish is being returned to your wallet; you can sell it again after ${at} UTC.`,
        zh: `已达每日 PEARL 上限——这条鱼正在退回你的钱包，${at} UTC 之后可以再次出售。`,
      };
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

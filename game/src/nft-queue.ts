import { fishValue } from './fish';
import {
  isFundsError,
  nextRetryAt,
  nextToMint,
  nftStep,
  sellQuote,
  unsettled,
  type BankedFish,
  type NftEvent,
} from './market';
import type { MintStep } from './chain';
import { nftName, requestSerial } from './nft-uri';
import type { SellResult, SellStep } from './pearl';
import { walletState } from './wallet';

// Background chain work for the bank, one job at a time per lane: mint queued fish, then sell the
// ones the player asked to sell, all together: every fish queued for sale goes in one batch, so
// the player's wallet asks once (pearl.ts packs the transfers and signs them in one prompt). Fish
// that must be minted first are all minted before that batch starts. The rules live in market.ts; this class only runs them. Solana code
// is imported lazily on the first job, so it never delays or breaks a dive.
// Mints are paid by the game (session) wallet, so only they wait for its SOL. Sales are signed and
// paid by the owner's own wallet, which says so itself if it is short.
// Nothing runs before a wallet connects; logging out stops the queue, and main.ts reloads the page when the wallet changes.
// Every fish gets its global number (#0042) from our server just before it is minted; if the server
// cannot answer, the fish stays queued and the queue asks again later. A number is never made up.

type Chain = typeof import('./chain');
type Pearl = typeof import('./pearl');

/** 'needs-sol': mints paused until the game (session) wallet has devnet SOL. 'offline': the RPC did not answer. */
export type Funds = 'unknown' | 'ok' | 'needs-sol' | 'offline';
/** 'waiting': the fish number server did not answer, so mints wait for it. */
export type Serials = 'ok' | 'waiting';

const MIN_MINT_SOL = 0.02; // the Core asset rent and fees, with headroom
const MIN_REPAIR_SOL = 0.01; // a metadata URI repair: one fee plus a little rent for the longer URI
const POLL_MS = 60_000;
const SERIAL_RETRY_MS = 15_000; // the number server is ours: it should be back soon
const MAX_REPAIR_TRIES = 3; // failed attempts to number an already-minted NFT before giving up on it
const START_DELAY_MS = 4000;
/** Most fish per sale batch: two full transfer transactions, still one wallet prompt. */
const MAX_SELL_BATCH = 40;

export interface NftQueueHooks {
  /** Any status changed: redraw whatever shows it. */
  changed(): void;
  /** Fish were sold (one batch) and have left the bank. */
  sold(sales: { fish: BankedFish; result: SellResult }[]): void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class NftQueue {
  /** Lazy module loaders. Kept as fields so a browser test can swap in a fake chain. */
  loadChain: () => Promise<Chain> = () => import('./chain');
  loadPearl: () => Promise<Pearl> = () => import('./pearl');
  /** Asks our server for a fish's number (swappable for tests). */
  fetchSerial: (id: string, owner: string) => Promise<number> = requestSerial;

  funds: Funds = 'unknown';
  serials: Serials = 'ok';
  balance: number | null = null;
  /** The fish being minted and its step. */
  minting: { fish: BankedFish; step: MintStep | null } | null = null;
  /** Fish being sold, with their current step. */
  readonly selling = new Map<BankedFish, SellStep | null>();
  /** Why the last sale of a fish failed. */
  readonly sellErrors = new Map<BankedFish, string>();
  /** The last batch: how many sold and for how much (the first fish's name and result, for one), and how many did not. */
  lastSale: { name: string; result: SellResult; count: number; total: number; failed: number } | null = null;
  /** The batch being sold now: how many fish and its step ('sign' is the one wallet prompt). */
  batch: { step: SellStep | null; fish: number; txs?: number } | null = null;
  /** The player declined the last batch's wallet prompt: shown once, not on every card. */
  declined: number = 0;

  private mintBusy = false;
  private sellBusy = false;
  private repairBusy = false;
  private repairsDone = false;
  private airdropTried = false;
  private wakeTimer = 0;
  private pollTimer = 0;
  private startTimer = 0;
  private stopped = false;

  constructor(
    private bank: BankedFish[],
    private save: () => void,
    private hooks: NftQueueHooks,
  ) {}

  /** Resume fish left queued by an earlier session, once the page has settled. */
  start() {
    this.stopped = false;
    window.clearTimeout(this.startTimer);
    this.startTimer = window.setTimeout(() => this.kick(), START_DELAY_MS);
  }

  /**
   * Logging out: start no new job (mint, sale, repair, number request) and drop every timer, the
   * number retry included. A number still on its way is ignored; a transaction already sent finishes
   * or resumes next login.
   */
  stop() {
    this.stopped = true;
    for (const t of [this.startTimer, this.wakeTimer, this.pollTimer]) window.clearTimeout(t);
    this.startTimer = this.wakeTimer = this.pollTimer = 0;
  }

  /** A mint or sale is under way right now. */
  get busy() {
    return this.minting !== null || this.selling.size > 0;
  }

  /** The queue has this fish in hand right now: minting it, or selling it. */
  holds(f: BankedFish): boolean {
    return this.minting?.fish === f || this.selling.has(f);
  }

  /**
   * Take fish out of the bank for good (a shark bite on the Open Ocean). Only fish still unsettled
   * (market.ts) and not in the queue's hands go; the rest stay. Returns those removed. Safe at any
   * point of runMints(): a fish picked but still waiting on its number is re-checked against the
   * bank before it is sent, so once it is gone from the bank (and the saved bank) it is never minted.
   */
  forfeit(fish: readonly BankedFish[]): BankedFish[] {
    const gone = fish.filter((f) => unsettled(f) && !this.holds(f) && this.bank.includes(f));
    if (!gone.length) return gone;
    for (const f of gone) this.bank.splice(this.bank.indexOf(f), 1);
    this.save();
    this.hooks.changed();
    return gone;
  }

  kick() {
    if (this.stopped || !walletState().connected) return;
    void this.runMints();
    void this.runSells();
  }

  /** Check the wallet again now (the collection panel opened, or SOL arrived). */
  recheck() {
    if (this.funds !== 'needs-sol' && this.funds !== 'offline' && this.serials !== 'waiting') return;
    window.clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    this.kick();
  }

  /** Mint a legacy fish on request. */
  enqueue(f: BankedFish) {
    this.apply(f, { type: 'enqueue' });
    this.kick();
  }

  retry(f: BankedFish) {
    this.apply(f, { type: 'retry' });
    this.kick();
  }

  /** Sell a fish: minted ones go to the market now, unminted ones are minted first. */
  sell(f: BankedFish) {
    this.sellMany([f]);
  }

  /** Sell several fish in one batch (one wallet approval). Unminted ones are minted first, then all go together. */
  sellMany(list: readonly BankedFish[]) {
    let any = false;
    for (const f of list) {
      if (!sellQuote(f, fishValue).ok || this.selling.has(f)) continue;
      this.sellErrors.delete(f);
      this.apply(f, { type: 'sell' });
      any = true;
    }
    if (!any) return;
    this.declined = 0;
    this.kick();
  }

  cancelSell(f: BankedFish) {
    if (!this.selling.has(f)) this.apply(f, { type: 'cancel-sell' });
  }

  private apply(f: BankedFish, e: NftEvent) {
    const next = nftStep(f, e);
    if (next === f) return;
    Object.assign(f, next);
    this.save();
    this.hooks.changed();
  }

  private setFunds(funds: Funds) {
    if (funds === 'ok') this.airdropTried = false; // a new shortfall later earns one more airdrop try
    if (funds === this.funds) return;
    this.funds = funds;
    this.hooks.changed();
  }

  /** Does the game wallet have enough SOL for the next mint? Tries one airdrop per shortfall, then pauses and polls. */
  private async ensureFunds(min: number): Promise<boolean> {
    try {
      const c = await this.loadChain();
      this.balance = await c.balanceSol();
      if (this.stopped) return false;
      if (this.balance < min && !this.airdropTried) {
        this.airdropTried = true;
        try {
          await c.airdrop(1);
          this.balance = await c.balanceSol();
        } catch (e) {
          console.warn('devnet airdrop failed', e);
        }
      }
      if (this.balance >= min) {
        this.setFunds('ok');
        return true;
      }
      this.setFunds('needs-sol');
    } catch (e) {
      console.warn('Solana unavailable', e);
      this.setFunds('offline');
    }
    this.schedulePoll();
    return false;
  }

  private async balanceBelow(min: number): Promise<boolean> {
    try {
      this.balance = await (await this.loadChain()).balanceSol();
      return this.balance < min;
    } catch {
      return false;
    }
  }

  private schedulePoll(ms = POLL_MS) {
    if (this.stopped || this.pollTimer) return;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = 0;
      if (document.hidden) this.schedulePoll(ms);
      else this.kick();
    }, ms);
  }

  /** Make sure the fish has its number from our server. False (and a retry scheduled) if the server did not answer. */
  private async ensureSerial(f: BankedFish): Promise<boolean> {
    if (f.serial) return true;
    const owner = walletState().owner;
    if (this.stopped || !owner) return false;
    try {
      const serial = await this.fetchSerial(f.id, owner);
      // Logged out (or the account changed) while the server answered: drop the answer, start nothing.
      if (this.stopped || walletState().owner !== owner) return false;
      if (!f.serial) f.serial = serial;
      this.save();
      if (this.serials !== 'ok') {
        this.serials = 'ok';
        this.hooks.changed();
      }
      return true;
    } catch (e) {
      if (this.stopped) return false;
      console.warn('fish number unavailable, waiting', e);
      if (this.serials !== 'waiting') {
        this.serials = 'waiting';
        this.hooks.changed();
      }
      this.schedulePoll(SERIAL_RETRY_MS);
      return false;
    }
  }

  private scheduleWake() {
    window.clearTimeout(this.wakeTimer);
    if (this.stopped) return;
    const at = nextRetryAt(this.bank);
    if (at !== null) this.wakeTimer = window.setTimeout(() => this.kick(), Math.max(1000, at - Date.now()));
  }

  private async runMints() {
    if (this.mintBusy) return;
    this.mintBusy = true;
    try {
      while (!this.stopped && nextToMint(this.bank, Date.now())) {
        if (!(await this.ensureFunds(MIN_MINT_SOL))) return;
        // Pick after the await: the player may have sold or cancelled in the meantime.
        const f = nextToMint(this.bank, Date.now());
        if (!f) break;
        // Its number first: the mint writes it into the on-chain name and the URI. No answer, no mint.
        if (!(await this.ensureSerial(f))) return;
        if (nextToMint(this.bank, Date.now()) !== f) continue; // the queue changed during the request
        if (this.stopped) return; // logged out during the checks above: send nothing
        this.minting = { fish: f, step: null };
        this.apply(f, { type: 'start' });
        try {
          const c = await this.loadChain();
          const res = await c.mintFish(f, (step) => {
            this.minting = { fish: f, step };
            this.hooks.changed();
          });
          f.metaFixed = true; // minted with a URI on our host and its number; saved by apply
          f.nameFixed = true;
          this.apply(f, { type: 'minted', assetId: res.asset, tx: res.signature });
        } catch (e) {
          const msg = errorText(e);
          console.error('mint failed', e);
          // A real shortfall pauses the queue without costing the fish an attempt. If the wallet looks
          // funded after all, count it as a failure so a misread error cannot loop.
          if (isFundsError(msg) && (await this.balanceBelow(MIN_MINT_SOL))) this.apply(f, { type: 'no-funds' });
          else this.apply(f, { type: 'failed', error: msg.slice(0, 200), now: Date.now() });
        } finally {
          this.minting = null;
          this.hooks.changed();
        }
      }
      this.scheduleWake();
    } finally {
      this.mintBusy = false;
      // Fish minted for a sale go to the market together, in one batch, once the minting stops.
      void this.runSells();
      void this.runRepairs();
    }
  }

  /**
   * Once per page load, after the mints: give fish minted before numbering their number, and re-point
   * fish minted with the old Irys URIs (which stopped resolving) at our metadata host. One
   * session-signed update per fish sets both name and URI, no prompt. A fish we cannot update
   * (another session key) is marked so it is not fetched again; one that keeps failing is given up
   * after MAX_REPAIR_TRIES. If the number server is down, repairs wait for it like mints do.
   */
  private async runRepairs() {
    if (this.stopped || this.repairBusy || this.repairsDone || this.mintBusy || !walletState().connected) return;
    const todo = () =>
      this.bank.filter(
        (f) =>
          f.nft === 'minted' &&
          f.assetId &&
          !(f.metaFixed && f.nameFixed) &&
          (f.repairTries ?? 0) < MAX_REPAIR_TRIES &&
          !f.sellQueued &&
          !this.selling.has(f),
      );
    if (!todo().length) return;
    this.repairBusy = true;
    try {
      if (await this.balanceBelow(MIN_REPAIR_SOL)) return; // try again after the next mint or top-up
      if (this.stopped) return;
      this.repairsDone = true;
      const c = await this.loadChain();
      for (const f of todo()) {
        if (this.stopped) break;
        if (!todo().includes(f)) continue; // sold or queued for sale meanwhile
        if (!(await this.ensureSerial(f))) {
          this.repairsDone = false; // the number server is down (or we logged out): the next run picks these up
          break;
        }
        if (this.stopped) break;
        try {
          const result = await c.repairFishUri(f as typeof f & { assetId: string });
          if (result === 'updated') console.info(`NFT name and metadata updated: ${nftName(f)} (${f.assetId})`);
          f.metaFixed = true;
          f.nameFixed = true;
          delete f.repairTries;
          this.save();
          this.hooks.changed();
        } catch (e) {
          console.warn('NFT metadata repair failed', f.assetId, e);
          // Short of SOL is not the fish's fault: stop for now without counting it.
          if (isFundsError(errorText(e))) break;
          f.repairTries = (f.repairTries ?? 0) + 1;
          this.save();
        }
      }
    } catch (e) {
      console.warn('NFT metadata repair skipped', e);
    } finally {
      this.repairBusy = false;
    }
  }

  /** Fish queued for sale that still need their NFT first. */
  private waitingForMint() {
    return this.bank.some((f) => f.sellQueued && !f.legacy && f.nft !== 'minted');
  }

  private async runSells() {
    if (this.sellBusy) return;
    this.sellBusy = true;
    try {
      // Let a click that queues many fish finish queueing them, so they share one batch.
      await Promise.resolve();
      while (!this.stopped) {
        // While the mint queue is still minting fish for a sale, wait: runMints calls back when it stops,
        // so all of them go in one approval. If minting is paused (no SOL, no number), sell what is minted.
        if (this.mintBusy && this.waitingForMint()) return;
        const batch = this.bank.filter((f) => f.sellQueued && f.nft === 'minted' && !f.legacy && f.assetId).slice(0, MAX_SELL_BATCH);
        if (!batch.length) return;
        if (!(await this.sellBatch(batch))) return;
      }
    } finally {
      this.sellBusy = false;
    }
  }

  /** Sell one batch. False if the player declined the prompt (so nothing is retried on its own). */
  private async sellBatch(batch: BankedFish[]): Promise<boolean> {
    for (const f of batch) {
      this.selling.set(f, null);
      this.sellErrors.delete(f);
    }
    this.batch = { step: null, fish: batch.length };
    this.hooks.changed();
    let declined = 0;
    try {
      const pearl = await this.loadPearl();
      const outcomes = await pearl.sellManyToMarket(
        batch.map((f) => f.assetId!),
        (p) => {
          this.batch = { ...p, fish: batch.length };
          for (const f of batch) this.selling.set(f, p.step);
          this.hooks.changed();
        },
      );
      const sold: { fish: BankedFish; result: SellResult }[] = [];
      outcomes.forEach((o, i) => {
        const f = batch[i];
        if (o.result) {
          const at = this.bank.indexOf(f);
          if (at >= 0) this.bank.splice(at, 1);
          sold.push({ fish: f, result: o.result });
          return;
        }
        if (o.rejected) declined++;
        else this.sellErrors.set(f, (o.error ?? 'Sale failed').slice(0, 200));
        this.apply(f, { type: 'cancel-sell' });
      });
      this.save();
      if (sold.length) {
        this.lastSale = {
          name: nftName(sold[0].fish),
          result: sold[0].result,
          count: sold.length,
          total: sold.reduce((s, x) => s + x.result.pearls, 0),
          failed: outcomes.length - sold.length - declined,
        };
        this.hooks.sold(sold);
      }
    } catch (e) {
      // Nothing reached the market (it is offline, or the chain code failed to load).
      console.error('sale failed', e);
      for (const f of batch) {
        this.sellErrors.set(f, errorText(e).slice(0, 200));
        this.apply(f, { type: 'cancel-sell' });
      }
    } finally {
      for (const f of batch) this.selling.delete(f);
      this.batch = null;
      this.declined = declined;
      this.hooks.changed();
    }
    return declined === 0;
  }
}

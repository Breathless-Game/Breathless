import { fishValue } from './fish';
import {
  isFundsError,
  nextRetryAt,
  nextToMint,
  nextToSell,
  nftStep,
  sellQuote,
  type BankedFish,
  type NftEvent,
} from './market';
import type { MintStep } from './chain';
import type { SellResult, SellStep } from './pearl';
import { walletState } from './wallet';

// Background chain work for the bank, one job at a time per lane: mint queued fish, then sell the
// ones the player asked to sell. The rules live in market.ts; this class only runs them. Solana code
// is imported lazily on the first job, so it never delays or breaks a dive.
// Mints are paid by the game (session) wallet, so only they wait for its SOL. Sales are signed and
// paid by the owner's Phantom wallet, which says so itself if it is short.
// Nothing runs before Phantom connects; main.ts reloads the page when the wallet changes.

type Chain = typeof import('./chain');
type Pearl = typeof import('./pearl');

/** 'needs-sol': mints paused until the game (session) wallet has devnet SOL. 'offline': the RPC did not answer. */
export type Funds = 'unknown' | 'ok' | 'needs-sol' | 'offline';

const MIN_MINT_SOL = 0.02; // Irys upload of the card and metadata plus the Core asset rent, with headroom
const POLL_MS = 60_000;
const START_DELAY_MS = 4000;

export interface NftQueueHooks {
  /** Any status changed: redraw whatever shows it. */
  changed(): void;
  /** A fish was sold and has left the bank. */
  sold(fish: BankedFish, result: SellResult): void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class NftQueue {
  /** Lazy module loaders. Kept as fields so a browser test can swap in a fake chain. */
  loadChain: () => Promise<Chain> = () => import('./chain');
  loadPearl: () => Promise<Pearl> = () => import('./pearl');

  funds: Funds = 'unknown';
  balance: number | null = null;
  /** The fish being minted and its step. */
  minting: { fish: BankedFish; step: MintStep | null } | null = null;
  /** Fish being sold, with their current step. */
  readonly selling = new Map<BankedFish, SellStep | null>();
  /** Why the last sale of a fish failed. */
  readonly sellErrors = new Map<BankedFish, string>();
  lastSale: { name: string; result: SellResult } | null = null;

  private mintBusy = false;
  private sellBusy = false;
  private airdropTried = false;
  private wakeTimer = 0;
  private pollTimer = 0;

  constructor(
    private bank: BankedFish[],
    private save: () => void,
    private hooks: NftQueueHooks,
  ) {}

  /** Resume fish left queued by an earlier session, once the page has settled. */
  start() {
    window.setTimeout(() => this.kick(), START_DELAY_MS);
  }

  kick() {
    if (!walletState().connected) return;
    void this.runMints();
    void this.runSells();
  }

  /** Check the wallet again now (the collection panel opened, or SOL arrived). */
  recheck() {
    if (this.funds !== 'needs-sol' && this.funds !== 'offline') return;
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
    if (!sellQuote(f, fishValue).ok || this.selling.has(f)) return;
    this.sellErrors.delete(f);
    this.apply(f, { type: 'sell' });
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

  private schedulePoll() {
    if (this.pollTimer) return;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = 0;
      if (document.hidden) this.schedulePoll();
      else this.kick();
    }, POLL_MS);
  }

  private scheduleWake() {
    window.clearTimeout(this.wakeTimer);
    const at = nextRetryAt(this.bank);
    if (at !== null) this.wakeTimer = window.setTimeout(() => this.kick(), Math.max(1000, at - Date.now()));
  }

  private async runMints() {
    if (this.mintBusy) return;
    this.mintBusy = true;
    try {
      while (nextToMint(this.bank, Date.now())) {
        if (!(await this.ensureFunds(MIN_MINT_SOL))) return;
        // Pick after the await: the player may have sold or cancelled in the meantime.
        const f = nextToMint(this.bank, Date.now());
        if (!f) break;
        this.minting = { fish: f, step: null };
        this.apply(f, { type: 'start' });
        try {
          const c = await this.loadChain();
          const res = await c.mintFish(f, (step) => {
            this.minting = { fish: f, step };
            this.hooks.changed();
          });
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
        if (f.sellQueued && f.nft === 'minted') void this.runSells();
      }
      this.scheduleWake();
    } finally {
      this.mintBusy = false;
    }
  }

  private async runSells() {
    if (this.sellBusy) return;
    this.sellBusy = true;
    try {
      // One at a time: each sale is its own Phantom approval.
      for (let f = nextToSell(this.bank); f; f = nextToSell(this.bank)) await this.sellOne(f);
    } finally {
      this.sellBusy = false;
    }
  }

  private async sellOne(f: BankedFish) {
    this.selling.set(f, null);
    this.hooks.changed();
    try {
      const pearl = await this.loadPearl();
      const result = await pearl.sellToMarket(f.assetId!, (step) => {
        this.selling.set(f, step);
        this.hooks.changed();
      });
      const i = this.bank.indexOf(f);
      if (i >= 0) this.bank.splice(i, 1);
      this.save();
      this.lastSale = { name: f.name, result };
      this.hooks.sold(f, result);
    } catch (e) {
      console.error('sale failed', e);
      this.sellErrors.set(f, errorText(e).slice(0, 200));
      this.apply(f, { type: 'cancel-sell' });
    } finally {
      this.selling.delete(f);
      this.hooks.changed();
    }
  }
}

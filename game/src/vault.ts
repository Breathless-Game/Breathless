import { fishValue, zoneForDepth } from './fish';
import { MAPS, type MapId } from './maps';
import { bulkSellable, isFundsError, needsConfirm, sellQuote, type BankedFish } from './market';
import type { NftQueue } from './nft-queue';
import { fishCard } from './portrait';
import { sessionBalance, topUpSession, walletState } from './wallet';
import { isUserRejection } from './wallet-storage';

// The collection panel: banked fish as NFT cards, the devnet wallets, and selling.
// The player's wallet owns the fish and signs sales; the game wallet pays mint fees without
// prompts. Chain code is loaded lazily (through the queue), so a Solana hiccup
// can never break the dive itself.

/** Below this the game wallet can't cover a mint (the queue's MIN_MINT_SOL): offer a top-up from the player's wallet. */
const FUND_BELOW_SOL = 0.02;
const FUND_SOL = 0.1;

const $ = (id: string) => document.getElementById(id)!;

/** The wallet app the player logged in with ("Phantom", "MetaMask", …). Plain text: never put it in innerHTML. */
const walletName = () => walletState().wallet?.name ?? 'Your wallet';

const STEP_LABEL = {
  mint: 'Minting on Solana…',
};

/** Solana Explorer on devnet. Pure, so the panel needs no chain code to link an address. */
const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

function explorerLink(address: string, label = 'View on Explorer ↗') {
  const a = el('a', 'explorer', label);
  a.href = explorerAddress(address);
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

const SELL_LABEL = {
  verify: 'Market verifying…',
  sign: 'Burning NFT for PEARL…',
  confirm: 'Confirming…',
};

const FAUCET_HINT = 'Faucet is rate limited. Use Fund game wallet, or faucet.solana.com with the game wallet address above.';
const CONFIRM_MS = 5000;

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
/** Only real signatures get an explorer link. */
const isSignature = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(s);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

export class Vault {
  private panel = $('collection');
  private grid = $('collection-grid');
  private walletEl = $('wallet');
  private marketEl = $('market-bar');
  private cards = new WeakMap<BankedFish, { fig: HTMLElement; cap: HTMLElement }>();
  private confirming: BankedFish | null = null;
  private confirmTimer = 0;

  constructor(
    private bank: BankedFish[],
    private queue: NftQueue,
  ) {}

  get open() {
    return !this.panel.classList.contains('hidden');
  }

  toggle(show = !this.open) {
    this.panel.classList.toggle('hidden', !show);
    if (!show) return;
    this.render();
    this.refreshWallet();
    this.queue.recheck();
  }

  /** Redraw after the bank or the queue changed. Card art is cached, so this is cheap. */
  refresh() {
    if (this.open) this.render();
  }

  private async refreshWallet(note = '') {
    const { owner, session } = walletState();
    if (!owner || !session) {
      this.walletEl.textContent = 'Connect a wallet to mint.';
      return;
    }
    const ownerLink = () => explorerLink(owner, 'View wallet on Explorer ↗');
    this.walletEl.replaceChildren('Connecting to Solana devnet… ', ownerLink());
    try {
      const c = await this.queue.loadChain();
      let sol: number | null = null;
      try {
        sol = await sessionBalance();
      } catch {}
      const bal = sol == null ? 'balance unavailable' : `${sol.toFixed(3)} SOL`;
      const link = (a: string) => `<a target="_blank" rel="noopener" href="${c.explorer('address', a)}">${short(a)}</a>`;
      const fund = sol != null && sol < FUND_BELOW_SOL ? ` <button id="fund" class="mini primary">Fund game wallet (${FUND_SOL} SOL)</button>` : '';
      this.walletEl.innerHTML = `<span class="owner-name"></span> ${link(owner)} <span class="owner-explorer"></span> · Game wallet ${link(session)} · <b>${bal}</b>${fund} <button id="airdrop" class="mini">Airdrop 1 SOL</button> <span class="note"></span>`;
      this.walletEl.querySelector('.owner-name')!.textContent = walletName();
      this.walletEl.querySelector('.owner-explorer')!.replaceWith(ownerLink());
      this.walletEl.querySelector('.note')!.textContent = note;
      $('airdrop').addEventListener('click', () => this.airdrop());
      if (fund) $('fund').addEventListener('click', () => this.fund());
    } catch (e) {
      this.walletEl.replaceChildren(`Solana unavailable: ${(e as Error).message} `, ownerLink());
    }
  }

  /** The player's wallet sends devnet SOL to the game wallet (one prompt). */
  private async fund() {
    const btn = $('fund') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = `Approve in ${walletName()}…`;
    try {
      await topUpSession(FUND_SOL);
      await this.refreshWallet('Game wallet funded.');
      this.queue.recheck();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error('top-up failed', e);
      await this.refreshWallet(
        isUserRejection(e)
          ? 'Top-up cancelled.'
          : /insufficient|debit an account|0x1\b/i.test(msg)
            ? `${walletName()} needs devnet SOL (faucet.solana.com) and must be on Devnet.`
            : `Top-up failed: ${msg.slice(0, 100)}`,
      );
    }
  }

  private async airdrop() {
    const c = await this.queue.loadChain();
    const btn = $('airdrop') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    try {
      await c.airdrop(1);
      await this.refreshWallet('Airdrop received.');
      this.queue.recheck();
    } catch {
      await this.refreshWallet(FAUCET_HINT);
    }
  }

  private render() {
    this.renderMarket();
    const sorted = [...this.bank].sort((a, b) => fishValue(b) - fishValue(a));
    if (!sorted.length) {
      this.grid.textContent = 'Nothing banked yet. Dive!';
      return;
    }
    this.grid.replaceChildren(...sorted.map((f) => this.card(f)));
  }

  /** Queue status, the needs-SOL pause, "Sell all commons" and the last sale. */
  private renderMarket() {
    const q = this.queue;
    const parts: HTMLElement[] = [];
    const queued = this.bank.filter((f) => f.nft === 'pending' || f.nft === 'failed').length;
    const waiting = queued || this.bank.some((f) => f.sellQueued);
    if (q.funds === 'needs-sol' && waiting) {
      parts.push(el('span', 'paused', '⏸ Minting paused: the game wallet needs devnet SOL. Use Fund game wallet above. Checking again every minute.'));
    } else if (q.funds === 'offline' && waiting) {
      parts.push(el('span', 'paused', '⏸ Solana devnet is not answering. Retrying every minute.'));
    } else if (q.minting) {
      const step = q.minting.step ? STEP_LABEL[q.minting.step] : 'Starting…';
      parts.push(el('span', '', `Minting ${q.minting.fish.name}: ${step}${queued ? ` · ${queued} more queued` : ''}`));
    } else if (queued) {
      parts.push(el('span', '', `${queued} NFT${queued > 1 ? 's' : ''} queued`));
    }
    const commons = bulkSellable(this.bank, 'common');
    if (commons.length) {
      const total = commons.reduce((s, f) => s + fishValue(f), 0);
      const btn = el('button', 'mini', `Sell all commons (${commons.length}) · ${total} Pearls`);
      btn.addEventListener('click', () => commons.forEach((f) => this.queue.sell(f)));
      parts.push(btn);
    }
    if (q.lastSale) {
      const { name, result } = q.lastSale;
      const sale = el('span', 'sale', `Sold ${name} · +${result.pearls} Pearls`);
      if (isSignature(result.tx)) {
        const a = el('a', '', 'tx ↗');
        a.target = '_blank';
        a.rel = 'noopener';
        void q.loadChain().then((c) => (a.href = c.explorer('tx', result.tx)));
        sale.append(' · ', a);
      }
      parts.push(sale);
    }
    this.marketEl.replaceChildren(...parts);
  }

  private card(f: BankedFish) {
    let card = this.cards.get(f);
    if (!card) {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.src = fishCard(f);
      const cap = document.createElement('figcaption');
      fig.append(img, cap);
      card = { fig, cap };
      this.cards.set(f, card);
    }
    this.caption(f, card.cap);
    return card.fig;
  }

  private caption(f: BankedFish, cap: HTMLElement) {
    const q = this.queue;
    const meta = document.createElement('span');
    const where = f.map && f.map in MAPS ? MAPS[f.map as MapId].name : zoneForDepth(f.depthM).name;
    meta.textContent = `${where} · ${f.depthM} m · ${fishValue(f)} pts · seed ${f.id}`;
    const row = el('div', 'nft-row');
    row.append(this.nftBadge(f), this.sellControl(f));
    cap.replaceChildren(meta, row);
    // The chain is the source of truth: a direct link works even when a wallet hides the NFT.
    if (f.nft === 'minted' && f.assetId) cap.appendChild(explorerLink(f.assetId));
    const err = q.sellErrors.get(f) ?? (f.nft === 'failed' ? f.mintError : undefined);
    if (err) {
      const sale = q.sellErrors.has(f);
      const line = el('div', 'err', sale ? `Sale failed: ${err}` : `Mint failed: ${err}`);
      // Mints are paid by the game wallet, sales by the player's own wallet.
      if (sale && isUserRejection({ message: err })) line.textContent = `Sale cancelled in ${walletName()}.`;
      else if (isFundsError(err)) {
        line.textContent = sale
          ? `${walletName()} needs devnet SOL for the sale fee (faucet.solana.com) and must be on Devnet.`
          : 'The game wallet is out of devnet SOL. Fund it above.';
      }
      cap.appendChild(line);
    }
  }

  private nftBadge(f: BankedFish): HTMLElement {
    const q = this.queue;
    if (f.nft === 'minted' && f.assetId) {
      const a = el('a', 'onchain', '✓ On-chain');
      a.target = '_blank';
      a.rel = 'noopener';
      void q.loadChain().then((c) => (a.href = c.explorer('address', f.assetId!)));
      return a;
    }
    if (f.nft === 'minting') {
      const step = q.minting?.fish === f && q.minting.step ? STEP_LABEL[q.minting.step] : 'Minting…';
      return el('span', 'nft-status busy', step);
    }
    if (f.nft === 'pending') {
      return el('span', 'nft-status', q.funds === 'needs-sol' ? 'NFT queued · needs SOL' : 'NFT queued');
    }
    if (f.nft === 'failed') {
      const wrap = el('span', 'nft-status failed', f.retryAt ? 'Mint failed · retrying soon ' : 'Mint failed ');
      const btn = el('button', 'mini', 'Retry');
      btn.addEventListener('click', () => this.queue.retry(f));
      wrap.appendChild(btn);
      return wrap;
    }
    // A legacy fish keeps the manual Mint button.
    const btn = el('button', 'mini primary', 'Mint NFT');
    btn.addEventListener('click', () => this.queue.enqueue(f));
    return btn;
  }

  private sellControl(f: BankedFish): HTMLElement {
    const q = this.queue;
    const quote = sellQuote(f, fishValue);
    if (!quote.ok && quote.reason === 'paid-out') {
      const tag = el('span', 'paid', 'Paid out');
      tag.title = 'Banked before selling existed: its Pearls were paid on surfacing.';
      return tag;
    }
    if (q.selling.has(f)) {
      const step = q.selling.get(f);
      const btn = el('button', 'mini', step ? SELL_LABEL[step] : 'Selling…');
      btn.disabled = true;
      return btn;
    }
    if (f.sellQueued) {
      const wrap = el('span', 'sell-queued', f.nft === 'minted' ? 'Sale queued ' : 'Mint, then sell ');
      const cancel = el('button', 'mini', 'Cancel');
      cancel.addEventListener('click', () => this.queue.cancelSell(f));
      wrap.appendChild(cancel);
      return wrap;
    }
    if (!quote.ok) {
      const btn = el('button', 'mini sell', `Sell · ${fishValue(f)} Pearls`);
      btn.disabled = true;
      btn.title = 'Wait for the mint to finish';
      return btn;
    }
    const verb = quote.mintFirst ? 'Mint & sell' : 'Sell';
    if (this.confirming === f) {
      const wrap = el('span', 'sell-confirm', '');
      const yes = el('button', 'mini primary', `Confirm · ${quote.pearls} Pearls`);
      const no = el('button', 'mini', 'Cancel');
      yes.addEventListener('click', () => {
        this.setConfirming(null);
        this.queue.sell(f);
      });
      no.addEventListener('click', () => this.setConfirming(null));
      wrap.append(yes, no);
      return wrap;
    }
    const btn = el('button', 'mini sell', `${verb} · ${quote.pearls} Pearls`);
    btn.title = quote.mintFirst ? 'Mints the NFT first: the market only buys NFTs' : 'The market burns the NFT and pays you its value in PEARL';
    btn.addEventListener('click', () => {
      if (needsConfirm(f.rarity)) this.setConfirming(f);
      else this.queue.sell(f);
    });
    return btn;
  }

  /** Epic and rarer fish ask once more; the question goes away on its own. */
  private setConfirming(f: BankedFish | null) {
    this.confirming = f;
    window.clearTimeout(this.confirmTimer);
    if (f) this.confirmTimer = window.setTimeout(() => this.setConfirming(null), CONFIRM_MS);
    this.refresh();
  }
}

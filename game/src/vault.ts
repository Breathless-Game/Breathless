import { fishValue, zoneForDepth } from './fish';
import { MAPS, type MapId } from './maps';
import { bulkSellable, isFundsError, needsConfirm, pearls, sellQuote, type BankedFish } from './market';
import type { NftQueue } from './nft-queue';
import { formatSerial, nftName } from './nft-uri';
import { fishCard } from './portrait';
import { sessionBalance, topUpSession, walletState } from './wallet';
import { explorerAddress, isUserRejection } from './wallet-storage';

// The collection panel: banked fish as NFT cards, the devnet wallets, and selling.
// The player's wallet owns the fish and signs sales; the game wallet pays mint fees without
// prompts. Chain code is loaded lazily (through the queue), so a Solana hiccup
// can never break the dive itself.
//
// Layout: a title row (count, close), the two wallets side by side (the player's own row is
// login.ts's #collection-wallet; this file fills the game wallet), a notice for the mint queue,
// a toolbar for bulk actions, then the cards. Every address and name goes in as text, never HTML.

/** Below this the game wallet can't cover a mint (the queue's MIN_MINT_SOL): offer a top-up from the player's wallet. */
const FUND_BELOW_SOL = 0.02;
const FUND_SOL = 0.1;

const $ = (id: string) => document.getElementById(id)!;

/** The wallet app the player logged in with ("Phantom", "MetaMask", …). Plain text: never put it in innerHTML. */
const walletName = () => walletState().wallet?.name ?? 'Your wallet';

const STEP_LABEL = {
  mint: 'Minting on Solana…',
};

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

const FAUCET_HINT = 'Faucet is rate limited. Use Fund game wallet, or faucet.solana.com with the game wallet address.';
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

type Tone = 'info' | 'warn' | 'busy';

/** An inline notice: an icon, a line of text and an optional detail line. */
function notice(tone: Tone, text: string, detail = '') {
  const box = el('div', `notice notice-${tone}`);
  const icon = el('span', 'notice-icon', tone === 'warn' ? '!' : tone === 'busy' ? '' : 'i');
  icon.setAttribute('aria-hidden', 'true');
  const body = el('div', 'notice-body');
  body.append(el('span', 'notice-text', text));
  if (detail) body.append(el('span', 'notice-detail', detail));
  box.append(icon, body);
  return box;
}

export class Vault {
  private panel = $('collection');
  private grid = $('collection-grid');
  private countEl = $('collection-count');
  private walletEl = $('wallet');
  private noticeEl = $('collection-notice');
  private marketEl = $('market-bar');
  private cards = new WeakMap<BankedFish, { fig: HTMLElement; cap: HTMLElement; img: HTMLImageElement; serial?: number }>();
  private confirming: BankedFish | null = null;
  private confirmTimer = 0;
  private funding = false;

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

  /** The game wallet card: its address, SOL balance, Fund (when low) and Airdrop, and the last result. */
  private async refreshWallet(note = '') {
    const { owner, session } = walletState();
    if (!owner || !session) {
      this.walletEl.replaceChildren(el('span', 'wallet-card-empty', 'Connect a wallet to mint.'));
      return;
    }
    this.walletEl.replaceChildren(el('span', 'wallet-card-empty', 'Connecting to Solana devnet…'));
    try {
      const c = await this.queue.loadChain();
      let sol: number | null = null;
      try {
        sol = await sessionBalance();
      } catch {}
      const low = sol != null && sol < FUND_BELOW_SOL;

      const info = el('div', 'game-wallet-info');
      const addr = el('a', 'wallet-addr', short(session));
      addr.href = c.explorer('address', session);
      addr.target = '_blank';
      addr.rel = 'noopener';
      addr.title = `${session}\nView on Solana Explorer (devnet)`;
      const bal = el('span', `game-wallet-balance${low ? ' low' : ''}`, sol == null ? 'balance unavailable' : `${sol.toFixed(3)} SOL`);
      info.append(addr, bal);

      const actions = el('div', 'game-wallet-actions');
      if (low) {
        const fund = el('button', 'mini primary', `Fund ${FUND_SOL} SOL`);
        fund.id = 'fund';
        fund.title = `Send ${FUND_SOL} devnet SOL from ${walletName()} to the game wallet (one prompt)`;
        fund.addEventListener('click', () => this.fund(fund));
        actions.append(fund);
      }
      const airdrop = el('button', 'mini ghost', 'Airdrop 1 SOL');
      airdrop.id = 'airdrop';
      airdrop.title = 'Ask the devnet faucet for 1 SOL (often rate limited)';
      airdrop.addEventListener('click', () => this.airdrop());
      actions.append(airdrop);

      this.walletEl.replaceChildren(info, actions);
      if (note) this.walletEl.append(el('div', 'note', note));
    } catch (e) {
      this.walletEl.replaceChildren(el('span', 'wallet-card-empty', `Solana unavailable: ${(e as Error).message}`));
    }
  }

  /** The player's wallet sends devnet SOL to the game wallet (one prompt). */
  private async fund(btn: HTMLButtonElement) {
    if (this.funding) return;
    this.funding = true;
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
    } finally {
      this.funding = false;
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
    const worth = this.bank.filter((f) => !f.legacy).reduce((s, f) => s + fishValue(f), 0);
    this.countEl.textContent = sorted.length ? `${sorted.length} fish · worth ${pearls(worth)}` : '';
    if (!sorted.length) {
      this.grid.replaceChildren(el('p', 'collection-empty', 'Nothing banked yet. Dive!'));
      return;
    }
    this.grid.replaceChildren(...sorted.map((f) => this.card(f)));
  }

  /** The mint queue's notice, then the toolbar: "Sell all commons" and the last sale. */
  private renderMarket() {
    const q = this.queue;
    const queued = this.bank.filter((f) => f.nft === 'pending' || f.nft === 'failed').length;
    const waiting = queued || this.bank.some((f) => f.sellQueued);
    const more = queued ? `${queued} NFT${queued > 1 ? 's' : ''} waiting` : '';
    let box: HTMLElement | null = null;
    if (q.funds === 'needs-sol' && waiting) {
      // Fund sits on the game wallet card just above: one button, not two.
      box = notice('warn', 'Minting paused: the game wallet needs devnet SOL.', `Fund it above. Checking again every minute.${more ? ` ${more}.` : ''}`);
    } else if (q.funds === 'offline' && waiting) {
      box = notice('warn', 'Solana devnet is not answering.', 'Retrying every minute.');
    } else if (q.serials === 'waiting' && queued) {
      box = notice('warn', 'Waiting for fish numbers: the game server is not answering.', 'Retrying shortly.');
    } else if (q.minting) {
      const step = q.minting.step ? STEP_LABEL[q.minting.step] : 'Starting…';
      box = notice('busy', `Minting ${nftName(q.minting.fish)}: ${step}`, queued ? `${queued} more queued` : '');
    } else if (queued) {
      box = notice('info', `${queued} NFT${queued > 1 ? 's' : ''} queued`);
    }
    this.noticeEl.replaceChildren(...(box ? [box] : []));

    const parts: HTMLElement[] = [];
    const commons = bulkSellable(this.bank, 'common');
    if (commons.length) {
      const total = commons.reduce((s, f) => s + fishValue(f), 0);
      const btn = el('button', 'mini', `Sell all commons (${commons.length}) · ${pearls(total)}`);
      btn.addEventListener('click', () => commons.forEach((f) => this.queue.sell(f)));
      parts.push(btn);
    }
    if (q.lastSale) {
      const { name, result } = q.lastSale;
      const sale = el('span', 'sale', `Sold ${name} · +${pearls(result.pearls)}`);
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
      img.alt = f.name;
      const cap = document.createElement('figcaption');
      fig.append(img, cap);
      card = { fig, cap, img, serial: f.serial };
      this.cards.set(f, card);
    }
    // The number arrives after the first render (just before the mint, or with a repair): redraw once.
    if (card.serial !== f.serial) {
      card.serial = f.serial;
      card.img.src = fishCard(f);
    }
    this.caption(f, card.cap);
    return card.fig;
  }

  /**
   * Under the art (which already shows the name, rarity, size, depth, seed and number): where it
   * was caught and its value, the NFT status pill, then the actions, pinned to the card's bottom.
   */
  private caption(f: BankedFish, cap: HTMLElement) {
    const q = this.queue;
    const where = f.map && f.map in MAPS ? MAPS[f.map as MapId].name : zoneForDepth(f.depthM).name;
    const meta = el('div', 'card-meta');
    meta.append(el('span', 'card-where', where), el('span', 'card-value', pearls(fishValue(f))));
    const status = el('div', 'card-status');
    status.append(this.nftBadge(f));
    // The chain is the source of truth: a direct link works even when a wallet hides the NFT.
    if (f.nft === 'minted' && f.assetId) status.appendChild(explorerLink(f.assetId));
    const parts: HTMLElement[] = [meta, status];
    const err = q.sellErrors.get(f) ?? (f.nft === 'failed' ? f.mintError : undefined);
    if (err) {
      const sale = q.sellErrors.has(f);
      const line = el('div', 'err', sale ? `Sale failed: ${err}` : `Mint failed: ${err}`);
      line.title = line.textContent ?? '';
      // Mints are paid by the game wallet, sales by the player's own wallet.
      if (sale && isUserRejection({ message: err })) line.textContent = `Sale cancelled in ${walletName()}.`;
      else if (isFundsError(err)) {
        line.textContent = sale
          ? `${walletName()} needs devnet SOL for the sale fee (faucet.solana.com) and must be on Devnet.`
          : 'The game wallet is out of devnet SOL. Fund it above.';
      }
      parts.push(line);
    }
    const actions = el('div', 'card-actions');
    const fix = this.nftAction(f);
    if (fix) actions.append(fix);
    actions.append(this.sellControl(f));
    parts.push(actions);
    cap.replaceChildren(...parts);
  }

  /** The NFT's state as a small coloured pill. A minted fish's pill links to its asset. */
  private nftBadge(f: BankedFish): HTMLElement {
    const q = this.queue;
    const num = f.serial ? `${formatSerial(f.serial)} · ` : '';
    const pill = (tone: string, text: string) => el('span', `nft-status pill pill-${tone}`, `${num}${text}`);
    if (f.nft === 'minted' && f.assetId) {
      const a = el('a', 'onchain pill pill-ok', `${num}On-chain ✓`);
      a.target = '_blank';
      a.rel = 'noopener';
      void q.loadChain().then((c) => (a.href = c.explorer('address', f.assetId!)));
      return a;
    }
    if (f.nft === 'minting') {
      const step = q.minting?.fish === f && q.minting.step ? STEP_LABEL[q.minting.step] : 'Minting…';
      const p = pill('busy', step);
      p.classList.add('busy');
      return p;
    }
    if (f.nft === 'pending') {
      if (q.funds === 'needs-sol') return pill('warn', 'NFT queued · needs SOL');
      if (q.serials === 'waiting' && !f.serial) return pill('warn', 'Waiting for number');
      return pill('info', 'NFT queued');
    }
    if (f.nft === 'failed') {
      const p = pill('err', f.retryAt ? 'Mint failed · retrying soon' : 'Mint failed');
      p.classList.add('failed');
      return p;
    }
    return pill('muted', 'Not minted');
  }

  /** What fixes a stuck NFT: Retry a failed mint, or Mint a legacy fish nobody asked to mint. */
  private nftAction(f: BankedFish): HTMLElement | null {
    if (f.nft === 'failed') {
      const btn = el('button', 'mini', 'Retry');
      btn.addEventListener('click', () => this.queue.retry(f));
      return btn;
    }
    if (f.nft === undefined) {
      // A legacy fish keeps the manual Mint button.
      const btn = el('button', 'mini primary', 'Mint NFT');
      btn.addEventListener('click', () => this.queue.enqueue(f));
      return btn;
    }
    return null;
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
      const btn = el('button', 'mini sell', `Sell · ${pearls(fishValue(f))}`);
      btn.disabled = true;
      btn.title = 'Wait for the mint to finish';
      return btn;
    }
    const verb = quote.mintFirst ? 'Mint & sell' : 'Sell';
    if (this.confirming === f) {
      const wrap = el('span', 'sell-confirm', '');
      const yes = el('button', 'mini primary', `Confirm${f.serial ? ` ${formatSerial(f.serial)}` : ''} · ${pearls(quote.pearls)}`);
      const no = el('button', 'mini', 'Cancel');
      yes.addEventListener('click', () => {
        this.setConfirming(null);
        this.queue.sell(f);
      });
      no.addEventListener('click', () => this.setConfirming(null));
      wrap.append(yes, no);
      return wrap;
    }
    const btn = el('button', 'mini sell', `${verb} · ${pearls(quote.pearls)}`);
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

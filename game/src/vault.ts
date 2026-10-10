import { fishValue, zoneForDepth, type FishSpec } from './fish';
import { MAPS, type MapId } from './maps';
import { fishCard } from './portrait';
import { sessionBalance, topUpSession, walletState } from './wallet';
import { isUserRejection } from './wallet-storage';

// The collection panel: banked fish as NFT cards, plus the devnet wallets
// (Phantom owns the fish; the game wallet pays mint fees without prompts).
// Chain code is loaded lazily the first time the panel opens, so a Solana
// hiccup can never break the dive itself.

/** Below this the game wallet can't cover many mints: offer a Phantom top-up. */
const FUND_BELOW_SOL = 0.02;
const FUND_SOL = 0.1;

type Chain = typeof import('./chain');

const $ = (id: string) => document.getElementById(id)!;

const STEP_LABEL = {
  'upload-image': 'Uploading art…',
  'upload-metadata': 'Uploading metadata…',
  mint: 'Minting on Solana…',
};

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export class Vault {
  private panel = $('collection');
  private grid = $('collection-grid');
  private walletEl = $('wallet');
  private chain: Promise<Chain> | null = null;
  private busy = new Set<string>();

  constructor(
    private bank: FishSpec[],
    private save: () => void,
  ) {}

  get open() {
    return !this.panel.classList.contains('hidden');
  }

  toggle(show = !this.open) {
    this.panel.classList.toggle('hidden', !show);
    if (!show) return;
    this.render();
    this.refreshWallet();
  }

  private loadChain() {
    this.chain ??= import('./chain');
    return this.chain;
  }

  private async refreshWallet(note = '') {
    const { owner, session } = walletState();
    if (!owner || !session) {
      this.walletEl.textContent = 'Connect Phantom to mint.';
      return;
    }
    this.walletEl.textContent = 'Connecting to Solana devnet…';
    try {
      const c = await this.loadChain();
      let sol: number | null = null;
      try {
        sol = await sessionBalance();
      } catch {}
      const bal = sol == null ? 'balance unavailable' : `${sol.toFixed(3)} SOL`;
      const link = (a: string) => `<a target="_blank" rel="noopener" href="${c.explorer('address', a)}">${short(a)}</a>`;
      const fund = sol != null && sol < FUND_BELOW_SOL ? ` <button id="fund" class="mini primary">Fund game wallet (${FUND_SOL} SOL)</button>` : '';
      this.walletEl.innerHTML = `Phantom ${link(owner)} · Game wallet ${link(session)} · <b>${bal}</b>${fund} <button id="airdrop" class="mini">Airdrop 1 SOL</button> <span class="note"></span>`;
      this.walletEl.querySelector('.note')!.textContent = note;
      $('airdrop').addEventListener('click', () => this.airdrop());
      if (fund) $('fund').addEventListener('click', () => this.fund());
    } catch (e) {
      this.walletEl.textContent = `Solana unavailable: ${(e as Error).message}`;
    }
  }

  /** Phantom sends devnet SOL to the game wallet (one prompt). */
  private async fund() {
    const btn = $('fund') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Approve in Phantom…';
    try {
      await topUpSession(FUND_SOL);
      await this.refreshWallet('Game wallet funded.');
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error('top-up failed', e);
      await this.refreshWallet(
        isUserRejection(e)
          ? 'Top-up cancelled.'
          : /insufficient|debit an account|0x1\b/i.test(msg)
            ? 'Your Phantom wallet needs devnet SOL (faucet.solana.com), and Phantom must be on Devnet.'
            : `Top-up failed: ${msg.slice(0, 100)}`,
      );
    }
  }

  private async airdrop() {
    const c = await this.loadChain();
    const btn = $('airdrop') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    try {
      await c.airdrop(1);
      await this.refreshWallet('Airdrop received.');
    } catch {
      await this.refreshWallet('Faucet is rate limited. Use faucet.solana.com with the address above.');
    }
  }

  private render() {
    this.grid.innerHTML = '';
    const sorted = [...this.bank].sort((a, b) => fishValue(b) - fishValue(a));
    if (!sorted.length) {
      this.grid.textContent = 'Nothing banked yet. Dive!';
      return;
    }
    for (const f of sorted) this.grid.appendChild(this.card(f));
  }

  private card(f: FishSpec) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = fishCard(f);
    const cap = document.createElement('figcaption');
    fig.append(img, cap);
    this.caption(f, cap);
    return fig;
  }

  private caption(f: FishSpec, cap: HTMLElement) {
    cap.innerHTML = '';
    const meta = document.createElement('span');
    const where = f.map && f.map in MAPS ? MAPS[f.map as MapId].name : zoneForDepth(f.depthM).name;
    meta.textContent = `${where} · ${f.depthM} m · ${fishValue(f)} pts · seed ${f.id}`;
    cap.appendChild(meta);
    if (f.assetId) {
      const a = document.createElement('a');
      a.className = 'onchain';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '✓ On-chain';
      this.loadChain().then((c) => (a.href = c.explorer('address', f.assetId!)));
      cap.appendChild(a);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'mini primary';
    btn.textContent = this.busy.has(f.id) ? 'Minting…' : 'Mint NFT';
    btn.disabled = this.busy.has(f.id);
    btn.addEventListener('click', () => this.mint(f, cap));
    cap.appendChild(btn);
  }

  private async mint(f: FishSpec, cap: HTMLElement) {
    if (this.busy.has(f.id)) return;
    this.busy.add(f.id);
    const btn = cap.querySelector('button')!;
    btn.disabled = true;
    try {
      const c = await this.loadChain();
      const res = await c.mintFish(f, (s) => (btn.textContent = STEP_LABEL[s]));
      f.assetId = res.asset;
      this.save();
      this.busy.delete(f.id);
      this.caption(f, cap);
      this.refreshWallet(`Minted ${f.name}.`);
    } catch (e) {
      this.busy.delete(f.id);
      const msg = (e as Error).message ?? String(e);
      console.error('mint failed', e);
      this.caption(f, cap);
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = /insufficient|0x1\b|debit an account/i.test(msg)
        ? 'Game wallet is out of SOL. Fund it above.'
        : `Mint failed: ${msg.slice(0, 120)}`;
      cap.appendChild(err);
    }
  }
}

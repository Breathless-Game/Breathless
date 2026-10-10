import { RARITY, type FishSpec } from './fish';
import { fishCard } from './portrait';

// The collection panel: banked fish as NFT cards, plus the devnet wallet.
// Chain code is loaded lazily the first time the panel opens, so a Solana
// hiccup can never break the dive itself.

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
    this.walletEl.textContent = 'Connecting to Solana devnet…';
    try {
      const c = await this.loadChain();
      const addr = c.walletAddress();
      let bal = '…';
      try {
        bal = `${(await c.balanceSol()).toFixed(3)} SOL`;
      } catch {
        bal = 'balance unavailable';
      }
      this.walletEl.innerHTML = `Devnet wallet <a target="_blank" rel="noopener" href="${c.explorer('address', addr)}">${short(addr)}</a> · <b>${bal}</b> <button id="airdrop" class="mini">Airdrop 1 SOL</button> <span class="note"></span>`;
      this.walletEl.querySelector('.note')!.textContent = note;
      $('airdrop').addEventListener('click', () => this.airdrop());
    } catch (e) {
      this.walletEl.textContent = `Solana unavailable: ${(e as Error).message}`;
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
    const sorted = [...this.bank].sort((a, b) => RARITY[b.rarity].value - RARITY[a.rarity].value);
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
    meta.textContent = `seed ${f.id} · ${f.depthM} m`;
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
        ? 'Not enough devnet SOL. Airdrop first.'
        : `Mint failed: ${msg.slice(0, 120)}`;
      cap.appendChild(err);
    }
  }
}

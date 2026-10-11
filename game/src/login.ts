import { connectWallet, onWalletChange, walletState, type WalletState } from './wallet';
import { onWalletsChange, ownerWallets } from './owner-wallets';
import { LAST_WALLET_KEY, devnetHint, isUserRejection, shortAddress, walletTiles, type WalletTile } from './wallet-storage';
import phantomLogo from './wallet-logos/phantom.svg';
import metamaskLogo from './wallet-logos/metamask.svg';
import solflareLogo from './wallet-logos/solflare.svg';
import backpackLogo from './wallet-logos/backpack.svg';

// The login gate between the title screen and the workbench: the player's
// wallet is the account, so nothing past the title runs without it. A tile per
// wallet: installed ones connect, well-known ones that aren't installed link to
// their site. main.ts moves on to the workbench once the wallet reports connected.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Bundled marks for wallets that aren't installed (an installed wallet shows its own icon). */
const LOGOS: Record<string, string> = { phantom: phantomLogo, metamask: metamaskLogo, solflare: solflareLogo, backpack: backpackLogo };

const logoFor = (name: string, icon = '') => icon || LOGOS[name.toLowerCase()] || '';

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

/** The wallet's logo, or its initial when it has none. */
function logo(name: string, icon = '') {
  const src = logoFor(name, icon);
  if (!src) return make('span', 'wallet-logo wallet-logo-letter', name.slice(0, 1).toUpperCase());
  const img = make('img', 'wallet-logo');
  img.src = src;
  img.alt = '';
  img.draggable = false;
  return img;
}

function lastWallet(): string | null {
  try {
    return localStorage.getItem(LAST_WALLET_KEY);
  } catch {
    return null;
  }
}

/** Keys the tiles use: the game's own handlers (Enter, arrows to swim) must not see them. */
const PICKER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ']);

export class LoginGate {
  private root = $('login');
  private grid = $('login-wallets');
  private status = $('login-status');
  private hint = $('login-hint');
  /** The wallet whose prompt is open. */
  private connecting: string | null = null;

  constructor(back: () => void) {
    $('login-back').addEventListener('click', back);
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    // A wallet extension that registers while the gate is up gets its tile right away.
    onWalletsChange(() => this.visible && this.render());
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  show() {
    this.connecting = null;
    this.status.textContent = '';
    const tiles = this.render();
    this.root.classList.remove('hidden');
    this.tiles()[0]?.focus();
    if (!tiles.some((t) => t.installed)) this.status.textContent = 'No Solana wallet found in this browser. Install one, then reload this page.';
  }

  hide() {
    this.root.classList.add('hidden');
  }

  private tiles() {
    return [...this.grid.querySelectorAll<HTMLButtonElement>('.wallet-tile')];
  }

  /** Installed wallets are looked up on every render: extensions can inject after the page loads. */
  private render(): WalletTile[] {
    const installed = ownerWallets();
    const tiles = walletTiles(installed, lastWallet());
    const focused = (document.activeElement as HTMLElement | null)?.dataset.wallet;
    this.grid.replaceChildren(
      ...tiles.map((t) => {
        const w = installed.find((x) => x.name === t.name);
        const busy = this.connecting === t.name;
        const btn = make('button', 'wallet-tile');
        btn.type = 'button';
        btn.dataset.wallet = t.name;
        btn.classList.toggle('missing', !t.installed);
        btn.classList.toggle('busy', busy);
        btn.setAttribute('aria-disabled', String(this.connecting !== null && !busy));
        btn.setAttribute(
          'aria-label',
          `${t.name}${t.installed ? '' : ', not installed: opens its site'}${t.lastUsed ? ', last used' : ''}`,
        );
        const art = make('span', 'wallet-art');
        art.append(logo(t.name, w?.icon));
        if (busy) art.append(make('span', 'wallet-spinner'));
        btn.append(art, make('span', 'wallet-name', busy ? 'Connecting…' : t.name));
        if (!t.installed) btn.append(make('span', 'wallet-tag', 'Install ↗'));
        else if (t.lastUsed) btn.append(make('span', 'wallet-tag wallet-tag-last', 'Last used'));
        else if (!t.devnet) btn.append(make('span', 'wallet-tag wallet-tag-warn', 'Devnet?'));
        btn.addEventListener('click', () => void this.pick(t));
        btn.addEventListener('focus', () => this.showHint(t));
        btn.addEventListener('pointerenter', () => this.showHint(t));
        return btn;
      }),
    );
    if (focused) this.tiles().find((b) => b.dataset.wallet === focused)?.focus();
    this.showHint(tiles.find((t) => t.name === focused) ?? tiles[0]);
    return tiles;
  }

  private showHint(t: WalletTile | undefined) {
    this.hint.textContent = t ? devnetHint(t.name) : '';
  }

  private async pick(t: WalletTile) {
    if (this.connecting) return;
    if (!t.installed) {
      if (t.url) window.open(t.url, '_blank', 'noopener');
      this.status.textContent = `Install ${t.name}, then reload this page.`;
      return;
    }
    this.connecting = t.name;
    this.status.textContent = '';
    this.render();
    try {
      await connectWallet(t.name);
    } catch (e) {
      this.status.textContent = isUserRejection(e)
        ? `${t.name}: connection cancelled.`
        : `Could not connect ${t.name}: ${(e as Error).message ?? String(e)}`;
    } finally {
      this.connecting = null;
      if (this.visible) this.render();
    }
  }

  /** Arrow keys walk the tiles (as laid out in rows); Enter and Space press the focused one. */
  private onKey(e: KeyboardEvent) {
    if (!PICKER_KEYS.has(e.key)) return;
    e.stopPropagation();
    const tiles = this.tiles();
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || e.key === 'Enter' || e.key === ' ') return; // the button's own click
    e.preventDefault();
    const perRow = Math.max(1, tiles.filter((b) => b.offsetTop === tiles[0].offsetTop).length);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow, ArrowDown: perRow }[e.key];
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : Math.min(tiles.length - 1, Math.max(0, i + (step ?? 0)));
    tiles[next]?.focus();
  }
}

export interface LogoutHooks {
  /** What logging out right now would cost (a dive in progress), or null. */
  warning(): string | null;
  /** End any dive, stop background work, then disconnect. */
  logOut(): Promise<void>;
}

/**
 * The wallet's logo, the connected address and a Log out button, kept current. With a dive under
 * way the button asks once more, inline. `empty`: what to show while logged
 * out; without it the row hides itself.
 */
export function mountWalletRow(el: HTMLElement, hooks: LogoutHooks, empty?: string) {
  let confirming: string | null = null;
  const render = () => {
    const s: WalletState = walletState();
    el.replaceChildren();
    el.classList.toggle('hidden', !s.owner && empty === undefined);
    el.classList.toggle('wallet-confirming', confirming !== null);
    if (!s.owner) {
      confirming = null;
      el.textContent = empty ?? '';
      return;
    }
    if (confirming !== null) {
      const question = make('span', 'wallet-question', `${confirming} Log out?`);
      const yes = make('button', 'mini danger', 'Log out');
      const no = make('button', 'mini', 'Cancel');
      yes.addEventListener('click', () => go(yes));
      no.addEventListener('click', () => {
        confirming = null;
        render();
      });
      el.append(question, yes, no);
      no.focus();
      return;
    }
    const name = s.wallet?.name ?? 'Wallet';
    const mark = logo(name, s.wallet?.icon);
    mark.title = name;
    const addr = make('span', 'wallet-addr', shortAddress(s.owner));
    addr.title = `${name} · ${s.owner}\nTo switch, pick another account in ${name}.`;
    const btn = make('button', 'mini wallet-logout', 'Log out');
    btn.setAttribute('aria-description', 'Your progress stays saved for this wallet.');
    btn.addEventListener('click', () => {
      confirming = hooks.warning();
      if (confirming === null) go(btn);
      else render();
    });
    el.append(mark, addr, btn);
  };
  const go = (btn: HTMLButtonElement) => {
    btn.disabled = true;
    btn.textContent = 'Logging out…';
    confirming = null;
    void hooks.logOut().catch((e) => {
      console.error('logout failed', e);
      render();
    });
  };
  // A confirm left behind (a click or focus elsewhere, Esc) quietly backs out.
  const dismiss = (e: Event) => {
    if (confirming === null) return;
    if (e.type !== 'keydown' && el.contains(e.target as Node | null)) return;
    confirming = null;
    render();
  };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('focusin', dismiss);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && dismiss(e), true);
  // The title and the workbench read clicks off the window: keep this row's out of them.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  render();
  onWalletChange(render);
}

import { connectWallet, onWalletChange, walletState, type WalletState } from './wallet';
import { onWalletsChange, ownerWallets } from './owner-wallets';
import { orbNfts } from './explorer-links';
import { formatPearls, onPearlBalance, pearlBalance } from './pearl-balance';
import { LAST_WALLET_KEY, devnetHint, explorerAddress, isUserRejection, shortAddress, walletTiles, type WalletTile } from './wallet-storage';
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

export interface WalletRowOptions {
  /** What to show while logged out; without it the row hides itself. */
  empty?: string;
  /** A compact account chip: the address is a button that opens a menu (Copy address, NFTs on Orb, Explorer, Log out). */
  menu?: boolean;
  /** Link the address on Helius Orb (its NFTs) and Solana Explorer (devnet), beside it. */
  explorer?: boolean;
}

/** Keys a focused row control handles itself: the game's window handlers (Enter starts, arrows swim) must not see them. */
const ROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ']);

/**
 * The wallet's logo, the connected address and Log out, kept current. With a dive under way Log out
 * asks once more, inline. `menu`: Log out (with Copy address and Explorer) sits in a small menu the
 * address opens, for the title chip. `empty` (or a plain string): what to show while logged out;
 * without it the row hides itself.
 */
export function mountWalletRow(el: HTMLElement, hooks: LogoutHooks, options: WalletRowOptions | string = {}) {
  const { empty, menu = false, explorer = false } = typeof options === 'string' ? { empty: options } : options;
  let confirming: string | null = null;
  /** The account menu (menu mode), while open. */
  let open: { trigger: HTMLButtonElement; list: HTMLElement } | null = null;
  let copiedTimer = 0;
  /** The PEARL pill beside the chip (menu mode), while a wallet is connected. */
  let badge: HTMLElement | null = null;

  const paintBadge = () => {
    if (!badge) return;
    const b = pearlBalance();
    const amount = b.status === 'ok' ? formatPearls(b.value) : b.status === 'loading' ? '…' : '—';
    badge.querySelector('.pearl-amount')!.textContent = amount;
    badge.dataset.state = b.status;
    badge.title =
      b.status === 'ok'
        ? 'Your PEARL balance on chain (devnet)'
        : b.status === 'loading'
          ? 'Reading your PEARL balance…'
          : b.reason;
    badge.setAttribute('aria-label', b.status === 'ok' ? `${amount} PEARL` : `PEARL balance: ${b.status === 'loading' ? 'loading' : 'unavailable'}`);
  };
  const makeBadge = () => {
    badge = make('span', 'pearl-badge');
    badge.setAttribute('role', 'status');
    badge.append(make('span', 'pearl-glyph', '◉'), make('span', 'pearl-amount'), make('span', 'pearl-unit', 'PEARL'));
    paintBadge();
    return badge;
  };

  const menuItems = () => (open ? [...open.list.querySelectorAll<HTMLElement>('[role="menuitem"]')] : []);
  const closeMenu = (refocus: boolean) => {
    if (!open) return;
    const { trigger, list } = open;
    open = null;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    el.classList.remove('wallet-menu-open');
    if (refocus) trigger.focus();
  };
  const openMenu = (trigger: HTMLButtonElement, list: HTMLElement, focus: 'first' | 'last' | null) => {
    open = { trigger, list };
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    el.classList.add('wallet-menu-open');
    const all = menuItems();
    if (focus) (focus === 'first' ? all[0] : all[all.length - 1])?.focus();
  };

  /** Log out, or ask first when it would cost something (a dive in progress). */
  const askLogout = (btn: HTMLButtonElement) => {
    confirming = hooks.warning();
    if (confirming === null) go(btn);
    else render();
  };

  const render = () => {
    const s: WalletState = walletState();
    open = null;
    window.clearTimeout(copiedTimer);
    el.replaceChildren();
    badge = null;
    el.classList.remove('wallet-menu-open');
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
    const owner = s.owner;
    const name = s.wallet?.name ?? 'Wallet';
    const mark = logo(name, s.wallet?.icon);
    const addr = make('span', 'wallet-addr', shortAddress(owner));
    if (menu) {
      el.append(makeBadge(), ...accountMenu(owner, name, mark, addr));
      return;
    }
    mark.title = name;
    addr.title = `${name} · ${owner}\nTo switch, pick another account in ${name}.`;
    el.append(mark, addr);
    if (explorer) {
      const a = make('a', 'wallet-explorer', 'Explorer ↗');
      a.href = explorerAddress(owner);
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = 'View this wallet on Solana Explorer (devnet)';
      // The owner wallet holds the minted fish: Helius Orb shows them as NFTs.
      const orb = make('a', 'wallet-orb', 'View on chain ↗');
      orb.href = orbNfts(owner);
      orb.target = '_blank';
      orb.rel = 'noopener noreferrer';
      orb.title = "This wallet's NFTs (your fish) on Helius Orb (devnet)";
      el.append(orb, a);
    }
    const btn = make('button', 'mini wallet-logout', 'Log out');
    btn.setAttribute('aria-description', 'Your progress stays saved for this wallet.');
    btn.addEventListener('click', () => askLogout(btn));
    el.append(btn);
  };

  /** The chip: a button with the logo and address, and the menu it opens. */
  const accountMenu = (owner: string, name: string, mark: HTMLElement, addr: HTMLElement) => {
    const trigger = make('button', 'wallet-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', `${name} ${shortAddress(owner)}: account menu`);
    trigger.title = `${name} · ${owner}`;
    trigger.append(mark, addr, make('span', 'wallet-caret'));

    const list = make('div', 'wallet-menu');
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-label', `${name} account`);
    list.hidden = true;
    const head = make('div', 'wallet-menu-head');
    head.append(make('span', 'wallet-menu-name', name), make('span', 'wallet-menu-addr', shortAddress(owner)));
    const item = <K extends 'button' | 'a'>(tag: K, label: string, extra = '') => {
      const node = make(tag, `wallet-menu-item${extra}`, label);
      node.setAttribute('role', 'menuitem');
      node.tabIndex = -1;
      return node;
    };
    const copy = item('button', 'Copy address');
    copy.addEventListener('click', () => {
      const done = (label: string) => {
        copy.textContent = label;
        window.clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => (copy.textContent = 'Copy address'), 1400);
      };
      // Some embedded browsers refuse the async clipboard: fall back to a hidden selection (kept
      // inside the row, so focusing it doesn't count as leaving the menu).
      const legacyCopy = () => {
        const t = document.createElement('textarea');
        t.value = owner;
        t.readOnly = true;
        t.className = 'wallet-copy-buffer';
        el.append(t);
        t.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch {}
        t.remove();
        copy.focus();
        done(ok ? 'Copied ✓' : 'Copy failed');
      };
      if (!navigator.clipboard) return legacyCopy();
      navigator.clipboard.writeText(owner).then(() => done('Copied ✓'), legacyCopy);
    });
    const view = item('a', 'View on Explorer ↗');
    view.href = explorerAddress(owner);
    view.target = '_blank';
    view.rel = 'noopener';
    view.addEventListener('click', () => closeMenu(false));
    const nfts = item('a', 'View NFTs on chain ↗');
    nfts.href = orbNfts(owner);
    nfts.target = '_blank';
    nfts.rel = 'noopener noreferrer';
    nfts.title = 'Your fish as NFTs on Helius Orb (devnet)';
    nfts.addEventListener('click', () => closeMenu(false));
    const out = item('button', 'Log out', ' wallet-menu-danger wallet-logout');
    out.setAttribute('aria-description', 'Your progress stays saved for this wallet.');
    out.addEventListener('click', () => askLogout(out));
    list.append(head, copy, nfts, view, make('div', 'wallet-menu-sep'), out);

    trigger.addEventListener('click', () => (open ? closeMenu(false) : openMenu(trigger, list, null)));
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu(trigger, list, e.key === 'ArrowDown' ? 'first' : 'last');
      } else if ((e.key === 'Enter' || e.key === ' ') && !open) {
        // Opened from the keyboard: focus goes into the menu.
        e.preventDefault();
        openMenu(trigger, list, 'first');
      }
    });
    list.addEventListener('keydown', (e) => {
      const all = menuItems();
      const i = all.indexOf(document.activeElement as HTMLElement);
      const to = (n: number) => all[(n + all.length) % all.length]?.focus();
      if (e.key === 'ArrowDown') to(i + 1);
      else if (e.key === 'ArrowUp') to(i - 1);
      else if (e.key === 'Home') to(0);
      else if (e.key === 'End') to(all.length - 1);
      else if (e.key === 'Tab') return closeMenu(false);
      else return;
      e.preventDefault();
    });
    return [trigger, list];
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
  // An open menu or a confirm left behind (a click or focus elsewhere, Esc) quietly backs out.
  const dismiss = (e: Event) => {
    if (confirming === null && !open) return;
    if (e.type !== 'keydown' && el.contains(e.target as Node | null)) return;
    if (open) {
      if (e.type === 'keydown') e.stopPropagation(); // Esc closes the menu, not the screen behind it
      return closeMenu(e.type === 'keydown');
    }
    confirming = null;
    render();
  };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('focusin', dismiss);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && dismiss(e), true);
  // The title and the workbench read clicks off the window: keep this row's out of them.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('keydown', (e) => ROW_KEYS.has(e.key) && e.stopPropagation());
  render();
  onWalletChange(render);
  onPearlBalance(paintBadge);
}

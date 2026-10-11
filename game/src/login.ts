import { connectWallet, onWalletChange, phantomInstalled, walletState, type WalletState } from './wallet';
import { isUserRejection, shortAddress } from './wallet-storage';

// The login gate between the title screen and the workbench: Phantom is the
// account, so nothing past the title runs without it. main.ts moves on to the
// workbench once the wallet reports connected.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class LoginGate {
  private root = $('login');
  private connect = $<HTMLButtonElement>('login-connect');
  private install = $('login-install');
  private status = $('login-status');

  constructor(back: () => void) {
    this.connect.addEventListener('click', () => this.tryConnect());
    $('login-back').addEventListener('click', back);
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  show() {
    // Checked on every show: Phantom can inject after the page loads.
    const installed = phantomInstalled();
    this.connect.classList.toggle('hidden', !installed);
    this.connect.disabled = false;
    this.connect.textContent = 'Connect Phantom';
    this.install.classList.toggle('hidden', installed);
    this.status.textContent = installed ? '' : "Phantom isn't installed in this browser. Install it, then reload this page.";
    this.root.classList.remove('hidden');
    if (installed) this.connect.focus();
  }

  hide() {
    this.root.classList.add('hidden');
  }

  private async tryConnect() {
    this.connect.disabled = true;
    this.connect.textContent = 'Approve in Phantom…';
    this.status.textContent = '';
    try {
      await connectWallet();
    } catch (e) {
      this.status.textContent = isUserRejection(e)
        ? 'Connection cancelled.'
        : `Could not connect: ${(e as Error).message ?? String(e)}`;
    } finally {
      this.connect.disabled = false;
      this.connect.textContent = 'Connect Phantom';
    }
  }
}

export interface LogoutHooks {
  /** What logging out right now would cost (a dive in progress), or null. */
  warning(): string | null;
  /** End any dive, stop background work, then disconnect. */
  logOut(): Promise<void>;
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

/**
 * The connected address and a Log out button, kept current. With a dive under
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
    const addr = make('span', 'wallet-addr', shortAddress(s.owner));
    addr.title = `${s.owner}\nTo switch, pick another account in your wallet.`;
    const btn = make('button', 'mini wallet-logout', 'Log out');
    btn.setAttribute('aria-description', 'Your progress stays saved for this wallet.');
    btn.addEventListener('click', () => {
      confirming = hooks.warning();
      if (confirming === null) go(btn);
      else render();
    });
    el.append(addr, btn);
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

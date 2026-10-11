import { connectWallet, disconnectWallet, onWalletChange, phantomInstalled, walletState, type WalletState } from './wallet';
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

/** The connected address and a Disconnect button, kept current. Used in Settings. */
export function mountWalletRow(el: HTMLElement) {
  const render = (s: WalletState) => {
    el.replaceChildren();
    if (!s.owner) {
      el.textContent = 'Not connected';
      return;
    }
    const addr = document.createElement('span');
    addr.className = 'wallet-addr';
    addr.textContent = shortAddress(s.owner);
    addr.title = `${s.owner}\nTo switch, pick another account in Phantom.`;
    const btn = document.createElement('button');
    btn.className = 'mini';
    btn.textContent = 'Disconnect';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void disconnectWallet();
    });
    el.append(addr, btn);
  };
  render(walletState());
  onWalletChange(render);
}

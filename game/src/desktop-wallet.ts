import type { Signer, Umi } from '@metaplex-foundation/umi';
import type { OwnerWallet } from './owner-wallets';
import { breathlessDesktop } from './desktop';
import { t } from './i18n';
import { checkLogin, fromBase64, loginMessage, RelayCheckError, type Verify } from './link-tx';
import { createRelaySigner, RelayError, type RelayRequest, type RelayResponse } from './relay-signer';
import { noteBlockhashExpiry } from './blockhash-expiry';
import browserLogo from './wallet-logos/browser.svg';

// The desktop app's owner wallet, "Browser wallet". Wallet extensions don't exist inside Electron,
// so every owner action goes to the player's normal browser through the server relay
// (sensor/link-relay.mjs): the app opens /link.html there, the player approves in their own
// wallet, and the app polls for the answer and checks it (link-tx.ts) before using it.
//
//   connect   the wallet signs a login message naming this session; the verified key is the owner.
//             Page loads after that restore the owner from storage with no browser round trip.
//   sign      relay-signer.ts: the owner's signature on the app's own transactions.

export const BROWSER_WALLET = 'Browser wallet';
/** Device-wide (the app's own storage): the owner the browser wallet logged in as. */
export const DESKTOP_OWNER_KEY = 'deepbreath.desktop.owner';
const POLL_MS = 1500;

/** The player said no (here or in the browser): reads as a declined wallet prompt (wallet-storage isUserRejection). */
class RelayCancelled extends Error {
  readonly code = 4001;
  constructor() {
    super('User rejected the request in the browser wallet');
    this.name = 'RelayCancelled';
  }
}

interface LinkSession {
  sid: string;
  appToken: string;
  pageToken: string;
  matchCode: string;
  expiresAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function verifier(): Promise<Verify> {
  const { ed25519 } = await import('@noble/curves/ed25519');
  return (sig, msg, pub) => {
    try {
      return ed25519.verify(sig, msg, pub, { zip215: false });
    } catch {
      return false;
    }
  };
}

function randomId(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- The waiting screen --------------------------------------------------------

interface Waiting {
  /** Resolves when the player presses Cancel. */
  cancelled: Promise<void>;
  note(text: string): void;
  close(): void;
}

function showWaiting(kind: 'connect' | 'sign', session: LinkSession, url: string, reopen: () => void): Waiting {
  const el = (tag: string, cls: string, text = '') => {
    const n = document.createElement(tag);
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const root = el('div', 'link-wait');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const card = el('div', 'link-wait-card');
  const title = el(
    'h3',
    'link-wait-title',
    kind === 'connect' ? t('Log in with your browser wallet', '用浏览器里的钱包登录') : t('Approve in your browser wallet', '在浏览器钱包中确认'),
  );
  const lead = el(
    'p',
    'link-wait-lead',
    t(
      'A page opened in your browser. Check that it shows this code, then approve there.',
      '浏览器中已打开一个页面。请确认它显示的是下面这个代码，然后在那里确认。',
    ),
  );
  const code = el('div', 'link-wait-code', session.matchCode);
  code.setAttribute('aria-label', t(`Code ${session.matchCode.split('').join(' ')}`, `代码 ${session.matchCode.split('').join(' ')}`));
  const status = el('p', 'link-wait-status', t('Waiting for your browser wallet…', '正在等待浏览器钱包…'));
  status.setAttribute('role', 'status');
  const row = el('div', 'link-wait-actions');
  const again = el('button', 'mini', t('Open the page again', '重新打开页面')) as HTMLButtonElement;
  const copy = el('button', 'mini', t('Copy link', '复制链接')) as HTMLButtonElement;
  const cancel = el('button', 'mini danger', t('Cancel', '取消')) as HTMLButtonElement;
  for (const b of [again, copy, cancel]) b.type = 'button';
  again.addEventListener('click', reopen);
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(url).then(
      () => (copy.textContent = t('Copied ✓', '已复制 ✓')),
      () => (copy.textContent = t('Copy failed', '复制失败')),
    );
  });
  row.append(again, copy, cancel);
  card.append(title, lead, code, status, row);
  root.append(card);
  // The game reads keys and clicks off the window: keep this screen's to itself.
  for (const type of ['pointerdown', 'keydown', 'keyup', 'wheel'] as const) root.addEventListener(type, (e) => e.stopPropagation());
  document.body.append(root);
  cancel.focus();
  const cancelled = new Promise<void>((resolve) => {
    cancel.addEventListener('click', () => resolve());
    root.addEventListener('keydown', (e) => e.key === 'Escape' && resolve());
  });
  return {
    cancelled,
    note: (text) => (status.textContent = text),
    close: () => root.remove(),
  };
}

// ---- The relay ---------------------------------------------------------------------

let active = false;

async function api(path: string, init: RequestInit): Promise<Response> {
  return fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
}

/** Run one request through the browser: create the session, open the page, wait for its answer. */
async function relay<R>(kind: 'connect' | 'sign', payload: unknown): Promise<{ session: LinkSession; result: R }> {
  const bridge = breathlessDesktop();
  if (!bridge) throw new RelayError(t('The browser wallet works in the desktop app only', '浏览器钱包只能在桌面版中使用'));
  if (active) throw new RelayError(t('Finish the browser wallet request that is already open first.', '请先完成已打开的浏览器钱包请求。'));
  active = true;
  try {
    const created = await api('/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, payload }) });
    if (!created.ok) {
      const why = ((await created.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${created.status}`;
      throw new RelayError(t(`Could not reach the wallet link: ${why}`, `无法连接钱包中转：${why}`));
    }
    const session = (await created.json()) as LinkSession;
    const url = `${location.origin}/link.html?sid=${encodeURIComponent(session.sid)}#t=${encodeURIComponent(session.pageToken)}`;
    let ui: Waiting | null = null;
    const open = async () => {
      const r = (await bridge.walletRequest({ kind: 'openLink', url }).catch(() => null)) as { ok?: boolean } | null;
      if (!r?.ok) ui?.note(t('Could not open your browser. Copy the link and open it there.', '无法打开浏览器。请复制链接，在浏览器中打开。'));
    };
    ui = showWaiting(kind, session, url, () => void open());
    void open();
    let stop = false;
    const cancel = ui.cancelled.then(() => {
      stop = true;
    });
    const auth = { Authorization: `Bearer ${session.appToken}` };
    const forget = () => void api(`/api/link/${encodeURIComponent(session.sid)}`, { method: 'DELETE', headers: auth }).catch(() => {});
    try {
      for (;;) {
        await Promise.race([sleep(POLL_MS), cancel]);
        if (stop) {
          forget();
          throw new RelayCancelled();
        }
        if (Date.now() > session.expiresAt + 5000) {
          forget();
          throw new RelayError(t('The browser wallet request expired. Try again.', '浏览器钱包请求已过期，请重试。'));
        }
        let res: Response;
        try {
          res = await api(`/api/link/${encodeURIComponent(session.sid)}/result`, { headers: auth });
        } catch {
          continue; // offline for a moment: keep waiting
        }
        if (res.status === 202 || res.status === 429 || res.status >= 500) continue;
        if (res.status === 404 || res.status === 401) throw new RelayError(t('The browser wallet request expired. Try again.', '浏览器钱包请求已过期，请重试。'));
        const body = (await res.json()) as { status: string; result?: R };
        if (body.status === 'cancelled') throw new RelayCancelled();
        if (body.status === 'done' && body.result) return { session, result: body.result };
        throw new RelayError(t('Unexpected answer from the wallet link', '钱包中转返回了意外的结果'));
      }
    } finally {
      ui.close();
    }
  } finally {
    active = false;
  }
}

// ---- The wallet ---------------------------------------------------------------------

function storedOwner(): string | null {
  try {
    return localStorage.getItem(DESKTOP_OWNER_KEY);
  } catch {
    return null;
  }
}

/** Log in: the browser wallet signs a message naming this session; returns the verified address. */
async function login(): Promise<string> {
  const nonce = randomId(24);
  const { session, result } = await relay<{ publicKey: string; signature: string }>('connect', { nonce });
  const now = Date.now();
  if (!(session.expiresAt > now - 60_000 && session.expiresAt < now + 15 * 60_000)) throw new RelayError(t('The wallet link gave an implausible expiry', '钱包中转给出的有效期不合理'));
  const expected = loginMessage({ sid: session.sid, nonce, expiresAt: session.expiresAt, origin: location.origin });
  try {
    return checkLogin(expected, result.publicKey, fromBase64(result.signature), await verifier());
  } catch (e) {
    const why = e instanceof RelayCheckError ? t(e.message, e.zh) : String((e as Error).message);
    throw new RelayError(t(`Login refused: ${why}`, `登录被拒绝：${why}`));
  }
}

let wallet: OwnerWallet | null = null;

/** The desktop app's one owner wallet. */
export function browserWallet(): OwnerWallet {
  return (wallet ??= {
    name: BROWSER_WALLET,
    icon: browserLogo,
    devnet: true,
    async connect(silent) {
      if (silent) return storedOwner();
      const address = await login();
      localStorage.setItem(DESKTOP_OWNER_KEY, address);
      return address;
    },
    async disconnect() {
      try {
        localStorage.removeItem(DESKTOP_OWNER_KEY);
      } catch {}
    },
    // No extension to tell us about account switches: the owner changes only by logging in again.
    watch: () => () => {},
    signer(umi: Umi, address: string, local: readonly Signer[] = []): Signer {
      let verify: Verify | null = null;
      return createRelaySigner({
        umi,
        address,
        local,
        verify: (sig, msg, pub) => verify!(sig, msg, pub),
        relay: async (req: RelayRequest) => {
          verify ??= await verifier();
          return (await relay<RelayResponse>('sign', req)).result;
        },
        // A blockhash lives ~150 blocks: never trust the page with a later expiry than that from now.
        noteExpiry: async (blockhash, lastValid) => {
          const height = await (umi as Partial<Umi>).rpc?.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
          noteBlockhashExpiry(blockhash, typeof height === 'number' ? Math.min(lastValid, height + 300) : lastValid);
        },
      });
    },
  });
}

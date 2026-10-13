import './link.css';
import { initI18n, lang, onLangChange, setLang, t } from './i18n';
import { onWalletsChange, ownerWallets, type OwnerWallet } from './owner-wallets';
import { INSTRUCTION_DISCRIMINATORS, playerStateProgramId } from './player-state';
import { KNOWN_WALLETS, isUserRejection, shortAddress } from './wallet-storage';
import {
  anchorNames,
  base58Decode,
  checkWalletEdits,
  defaultComputeUnits,
  formatUnits,
  fromBase64,
  loginMessage,
  parseTransaction,
  priorityFeeLamports,
  RelayCheckError,
  summarizeTransaction,
  toBase64,
  withBlockhash,
  type InstructionSummary,
  type ProgramLabels,
  type TxSummary,
} from './link-tx';

// The desktop app's wallet link, opened in the player's normal browser (desktop-wallet.ts opens
// /link.html?sid=…#t=<page token>). It reads the request from the relay (sensor/link-relay.mjs),
// shows the code the app shows, connects a wallet here (owner-wallets.ts), shows what each
// transaction does as decoded from its own bytes, and signs:
//   connect  signMessage("breathless-desktop-login|<sid>|<nonce>|<expiresAt>|<origin>")
//   sign     a fresh blockhash put in (the player may take longer than one lives), then one
//            wallet prompt for all of them. The app accepts back only that, or a compute budget
//            the wallet changed (link-tx.ts checkWalletEdits); this page checks the same first.
// The answer goes back once; Cancel tells the app no.

const RPC = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? 'https://api.devnet.solana.com'; // as in chain.ts
const FISH_MARKET_PROGRAM = '5HEuVNCHKjpfnsdJzov3zDy9UFSj8V2tzF8L9eQnKsDG';
const FISH_MARKET_IX: Record<string, readonly number[]> = { sell_fish: [202, 178, 229, 28, 243, 203, 69, 115] };

interface Request {
  kind: 'connect' | 'sign';
  payload: { nonce?: string; owner?: string; txs?: string[]; keepBlockhash?: boolean };
  matchCode: string;
  expiresAt: number;
}

type Phase =
  | { at: 'loading' }
  | { at: 'broken'; why: string }
  | { at: 'pick' }
  | { at: 'ready'; wallet: OwnerWallet; address: string }
  | { at: 'working'; wallet: OwnerWallet; address: string; what: string }
  | { at: 'finished'; cancelled: boolean };

const root = document.getElementById('link') as HTMLElement;
const params = new URLSearchParams(location.search);
const sid = params.get('sid') ?? '';
const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
// Out of the address bar and history: the token is only needed in memory.
history.replaceState(null, '', location.pathname + location.search);

let req: Request | null = null;
let phase: Phase = { at: 'loading' };
let error = '';
/** Names for addresses the summary shows (the market, PEARL), from this site's market. */
const names = new Map<string, string>();
let labels: ProgramLabels = {};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const button = (label: string, cls: string, onClick: () => void) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api/link/${encodeURIComponent(sid)}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { ...(init.headers as Record<string, string>), 'X-Link-Token': token },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw Object.assign(new Error(String(body.error ?? `HTTP ${res.status}`)), { status: res.status });
  return body;
}

function set(next: Phase, why = '') {
  phase = next;
  error = why;
  render();
}

// ---- Rendering ---------------------------------------------------------------------

function header(): HTMLElement {
  const top = el('header', 'link-top');
  top.append(el('span', 'link-brand', '屏息 Breathless'));
  const toggle = button(lang() === 'zh' ? 'English' : '中文', 'link-lang', () => setLang(lang() === 'zh' ? 'en' : 'zh'));
  toggle.setAttribute('aria-label', t('Switch language', '切换语言'));
  top.append(toggle);
  return top;
}

function codeBlock(r: Request): HTMLElement {
  const box = el('section', 'link-code-box');
  box.append(
    el('p', 'link-code-label', t('The desktop app shows this code:', '桌面版显示的代码应为：')),
    el('div', 'link-code', r.matchCode),
    el('p', 'link-muted', t("Only continue if it matches. If it doesn't, close this page.", '只有一致时才继续。不一致就关闭此页面。')),
  );
  return box;
}

function minutesLeft(r: Request) {
  const s = Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function who(address: string): string {
  if (req?.payload.owner === address || (phase as { address?: string }).address === address) return t('you', '你');
  const name = names.get(address.split('#')[0]);
  if (address.includes('#')) return t('an address from a lookup table', '查找表中的地址');
  return name ? `${name} (${shortAddress(address)})` : shortAddress(address);
}

const sol = (lamports: bigint) => `${formatUnits(lamports, 9)} SOL`;

function tokenName(mint: string | undefined, program: string) {
  return (mint && names.get(mint)) || (program === 'Token-2022' ? t('tokens (Token-2022)', '代币 (Token-2022)') : t('tokens', '代币'));
}

/** One line per instruction, Core transfers to one owner counted together. */
function describe(s: TxSummary): { text: string; warn?: boolean; quiet?: boolean }[] {
  const lines: { text: string; warn?: boolean; quiet?: boolean }[] = [];
  const transfers = new Map<string, number>();
  const budget: { seen: boolean; units?: number; microLamports?: bigint } = { seen: false };
  for (const ix of s.instructions as InstructionSummary[]) {
    switch (ix.kind) {
      case 'sol-transfer':
        lines.push({ text: t(`Send ${sol(ix.lamports)} from ${who(ix.from)} to ${who(ix.to)}`, `从${who(ix.from)}向 ${who(ix.to)} 转账 ${sol(ix.lamports)}`) });
        break;
      case 'create-account':
        lines.push({ text: t(`Create account ${who(ix.account)}, funded with ${sol(ix.lamports)} by ${who(ix.from)}`, `创建账户 ${who(ix.account)}，由${who(ix.from)}存入 ${sol(ix.lamports)}`) });
        break;
      case 'token-transfer': {
        const amount = ix.decimals !== undefined ? formatUnits(ix.amount, ix.decimals) : ix.amount.toString();
        lines.push({ text: t(`Transfer ${amount} ${tokenName(ix.mint, ix.program)} (authority: ${who(ix.authority)})`, `转出 ${amount} ${tokenName(ix.mint, ix.program)}（授权方：${who(ix.authority)}）`) });
        break;
      }
      case 'token-burn': {
        const amount = ix.decimals !== undefined ? formatUnits(ix.amount, ix.decimals) : ix.amount.toString();
        lines.push({ text: t(`Burn ${amount} ${tokenName(ix.mint, ix.program)} (spend; authority: ${who(ix.authority)})`, `销毁 ${amount} ${tokenName(ix.mint, ix.program)}（消费；授权方：${who(ix.authority)}）`) });
        break;
      }
      case 'core-transfer':
        transfers.set(ix.newOwner, (transfers.get(ix.newOwner) ?? 0) + 1);
        break;
      case 'core-burn':
        lines.push({ text: t(`Burn the NFT ${shortAddress(ix.asset)} (destroyed for good)`, `销毁 NFT ${shortAddress(ix.asset)}（永久销毁）`), warn: true });
        break;
      case 'create-token-account':
        lines.push({ text: t(`Open a token account for ${who(ix.owner)}`, `为${who(ix.owner)}开设代币账户`), quiet: true });
        break;
      case 'compute-budget':
        if (ix.units !== undefined) budget.units = ix.units;
        if (ix.microLamports !== undefined) budget.microLamports = ix.microLamports;
        budget.seen = true;
        break;
      case 'memo':
        lines.push({ text: t(`Memo: ${ix.text}`, `备注：${ix.text}`), quiet: true });
        break;
      case 'named':
        lines.push({ text: `${ix.label}: ${ix.name}` });
        break;
      case 'unknown':
        lines.push({
          text: ix.label
            ? t(`${ix.label}: an instruction this page can't read (${ix.bytes} bytes)`, `${ix.label}：本页无法解读的指令（${ix.bytes} 字节）`)
            : t(`Unknown program ${shortAddress(ix.program)} (${ix.bytes} bytes of data)`, `未知程序 ${shortAddress(ix.program)}（${ix.bytes} 字节数据）`),
          warn: true,
        });
        break;
    }
  }
  for (const [to, n] of transfers) {
    lines.unshift({ text: t(`Hand over ${n} fish NFT${n === 1 ? '' : 's'} to ${who(to)}`, `把 ${n} 条鱼 NFT 转给 ${who(to)}`) });
  }
  if (budget.seen) {
    const others = s.instructions.filter((ix) => ix.kind !== 'compute-budget').length;
    const fee = priorityFeeLamports(budget.units ?? defaultComputeUnits(others), budget.microLamports ?? 0n);
    lines.push({ text: t(`Priority fee: up to ${sol(fee)}`, `优先费：最多 ${sol(fee)}`), quiet: true });
  }
  return lines;
}

function summaryBlock(r: Request): HTMLElement {
  const box = el('section', 'link-summary');
  const txs = (r.payload.txs ?? []).map((b) => summarizeTransaction(fromBase64(b), labels));
  const n = txs.length;
  box.append(el('h2', '', n === 1 ? t('What you are signing', '你要签署的内容') : t(`What you are signing (${n} transactions, one prompt)`, `你要签署的内容（${n} 笔交易，一次确认）`)));
  txs.forEach((s, i) => {
    const card = el('div', 'link-tx');
    if (n > 1) card.append(el('h3', '', t(`Transaction ${i + 1}`, `交易 ${i + 1}`)));
    const list = el('ul');
    for (const line of describe(s)) list.append(el('li', line.warn ? 'warn' : line.quiet ? 'quiet' : '', line.text));
    card.append(list);
    card.append(el('p', 'link-muted', t(`Network fee paid by ${who(s.feePayer)}. Signers: ${s.signers.map(who).join(', ')}.`, `网络手续费由${who(s.feePayer)}支付。签名方：${s.signers.map(who).join('、')}。`)));
    if (s.usesLookupTables) card.append(el('p', 'link-muted warn', t('Uses address lookup tables: some accounts are not shown.', '使用了地址查找表：部分账户未显示。')));
    box.append(card);
  });
  box.append(el('p', 'link-muted', t('Read from the transactions themselves, not from a description.', '以上内容直接解读自交易本身，而非文字说明。')));
  return box;
}

function walletPicker(): HTMLElement {
  const box = el('section', 'link-wallets');
  const wallets = ownerWallets();
  box.append(el('h2', '', t('Choose your wallet', '选择你的钱包')));
  if (!wallets.length) {
    box.append(el('p', '', t('No Solana wallet found in this browser. Install one, then reload this page.', '这个浏览器里没有找到 Solana 钱包。请安装一个，然后刷新本页。')));
    const links = el('p', 'link-muted');
    for (const k of KNOWN_WALLETS) {
      const a = el('a', '', k.name);
      a.href = k.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      links.append(a, ' ');
    }
    box.append(links);
    return box;
  }
  const grid = el('div', 'link-wallet-grid');
  for (const w of wallets) {
    const b = button('', 'link-wallet', () => void connect(w));
    if (w.icon) {
      const img = el('img');
      img.src = w.icon;
      img.alt = '';
      b.append(img);
    }
    b.append(el('span', '', w.name));
    grid.append(b);
  }
  box.append(grid);
  return box;
}

function render() {
  const view: HTMLElement[] = [header()];
  const r = req;
  if (phase.at === 'loading') view.push(el('p', 'link-muted', t('Loading…', '加载中…')));
  else if (phase.at === 'broken') {
    view.push(el('h1', '', t('This link cannot be used', '此链接无法使用')), el('p', '', phase.why));
  } else if (phase.at === 'finished') {
    view.push(
      el('h1', '', phase.cancelled ? t('Cancelled', '已取消') : t('Done', '完成')),
      el('p', '', t('You can close this tab and go back to the Breathless app.', '你可以关闭此标签页，回到屏息桌面版。')),
    );
  } else if (r) {
    view.push(el('h1', '', r.kind === 'connect' ? t('Log in to the Breathless desktop app', '登录屏息桌面版') : t('Approve in the Breathless desktop app', '为屏息桌面版确认')));
    view.push(codeBlock(r));
    if (r.kind === 'sign') view.push(summaryBlock(r));
    if (phase.at === 'pick') view.push(walletPicker());
    else {
      const p = phase;
      const acct = el('section', 'link-account');
      acct.append(el('p', '', t(`Wallet: ${p.wallet.name} · ${shortAddress(p.address)}`, `钱包：${p.wallet.name} · ${shortAddress(p.address)}`)));
      if (r.kind === 'sign' && p.address !== r.payload.owner) {
        acct.append(
          el(
            'p',
            'warn',
            t(
              `This request is for ${shortAddress(r.payload.owner ?? '')}. Switch to that account in your wallet, then choose it again.`,
              `此请求属于 ${shortAddress(r.payload.owner ?? '')}。请在钱包中切换到那个账户，然后重新选择。`,
            ),
          ),
        );
      }
      view.push(acct);
    }
    if (error) view.push(el('p', 'link-error', error));
    const row = el('div', 'link-actions');
    if (phase.at === 'ready' && (r.kind === 'connect' || phase.address === r.payload.owner)) {
      const n = r.payload.txs?.length ?? 0;
      const label = r.kind === 'connect' ? t('Sign in', '签名登录') : n === 1 ? t('Sign', '签名') : t(`Sign ${n} transactions`, `签署 ${n} 笔交易`);
      const go = phase;
      row.append(button(label, 'link-primary', () => void sign(go.wallet, go.address)));
    }
    if (phase.at === 'ready') row.append(button(t('Use another wallet', '换一个钱包'), 'link-secondary', () => set({ at: 'pick' })));
    if (phase.at === 'working') row.append(el('span', 'link-muted', phase.what));
    else row.append(button(t('Cancel', '取消'), 'link-secondary', () => void cancel()));
    view.push(row);
    view.push(el('p', 'link-muted link-expiry', t(`This link expires in ${minutesLeft(r)}.`, `此链接将在 ${minutesLeft(r)} 后过期。`)));
  }
  root.replaceChildren(...view);
}

// ---- Actions -------------------------------------------------------------------------

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function connect(w: OwnerWallet) {
  if (!req) return;
  set({ at: 'working', wallet: w, address: '', what: t('Connecting…', '连接中…') });
  try {
    const address = await w.connect(false);
    if (!address) throw new Error(t(`${w.name} didn't share a Solana account`, `${w.name} 没有提供 Solana 账户`));
    set({ at: 'ready', wallet: w, address });
  } catch (e) {
    set({ at: 'pick' }, isUserRejection(e) ? t('Connection cancelled.', '已取消连接。') : t(`Could not connect: ${message(e)}`, `无法连接：${message(e)}`));
  }
}

async function latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
  });
  const body = (await res.json()) as { result?: { value?: { blockhash: string; lastValidBlockHeight: number } }; error?: { message?: string } };
  const v = body.result?.value;
  if (!v) throw new Error(body.error?.message ?? `RPC HTTP ${res.status}`);
  return v;
}

async function sign(w: OwnerWallet, address: string) {
  const r = req;
  if (!r) return;
  set({ at: 'working', wallet: w, address, what: t(`Waiting for ${w.name}…`, `正在等待 ${w.name}…`) });
  try {
    let result: Record<string, unknown>;
    if (r.kind === 'connect') {
      if (!w.signMessageBytes) throw new Error(t(`${w.name} can't sign messages`, `${w.name} 无法签名消息`));
      const text = loginMessage({ sid, nonce: r.payload.nonce ?? '', expiresAt: r.expiresAt, origin: location.origin });
      const signature = await w.signMessageBytes(address, new TextEncoder().encode(text));
      result = { publicKey: address, signature: toBase64(signature) };
    } else {
      if (address !== r.payload.owner) throw new Error(t('This is not the account the app asked for.', '这不是桌面版请求的账户。'));
      if (!w.signTransactionBytes) throw new Error(t(`${w.name} can't sign here`, `${w.name} 无法在此签名`));
      const original = (r.payload.txs ?? []).map(fromBase64);
      let fresh: { blockhash: string; lastValidBlockHeight: number } | null = null;
      let toSign = original;
      if (!r.payload.keepBlockhash) {
        fresh = await latestBlockhash();
        const bh = base58Decode(fresh.blockhash);
        toSign = original.map((tx) => withBlockhash(tx, bh));
      }
      const signed = await w.signTransactionBytes(address, toSign);
      if (signed.length !== toSign.length) throw new Error(t('The wallet returned the wrong number of transactions.', '钱包返回的交易数量不对。'));
      // Wallets may change a transaction while signing (Phantom adds a priority fee): the app's own
      // rule, checked here first so a refusal says what changed. The blockhash is this page's to set,
      // and one that arrived signed by another key must come back as it went.
      signed.forEach((tx, i) => {
        const sent = parseTransaction(toSign[i]);
        try {
          checkWalletEdits(sent.message, parseTransaction(tx).message, { keepBlockhash: true, exact: sent.signatures.some((sig) => sig.some((b) => b !== 0)) });
        } catch (e) {
          const why = e instanceof RelayCheckError ? t(e.message, e.zh) : message(e);
          throw new Error(t(`${w.name} changed the transaction in a way the desktop app can't accept: ${why}`, `${w.name} 改动了交易，桌面版无法接受：${why}`));
        }
      });
      result = { txs: signed.map(toBase64), ...(fresh ?? {}) };
    }
    await api('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
    set({ at: 'finished', cancelled: false });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 404 || status === 409) return set({ at: 'broken', why: t('This link expired or was already used. Start again from the desktop app.', '此链接已过期或已被使用。请在桌面版中重新开始。') });
    set({ at: 'ready', wallet: w, address }, isUserRejection(e) ? t('Declined in the wallet.', '已在钱包中拒绝。') : message(e));
  }
}

async function cancel() {
  try {
    await api('/cancel', { method: 'POST' });
  } catch {
    // Expired or answered already: the app has stopped waiting either way.
  }
  set({ at: 'finished', cancelled: true });
}

// ---- Start ---------------------------------------------------------------------------

async function loadNames() {
  labels = {
    [playerStateProgramId().toString()]: { label: t('Breathless player state', '屏息玩家状态'), instructions: anchorNames(INSTRUCTION_DISCRIMINATORS) },
    [FISH_MARKET_PROGRAM]: { label: t('Breathless fish market', '屏息鱼市场'), instructions: anchorNames(FISH_MARKET_IX) },
  };
  try {
    const res = await fetch('/api/market/info', { cache: 'no-store' });
    const info = (await res.json()) as { market?: string; pearlMint?: string; programId?: string };
    if (info.market) names.set(info.market, t('the Breathless market', '屏息市场'));
    if (info.pearlMint) names.set(info.pearlMint, 'PEARL');
    if (info.programId && !labels[info.programId]) labels[info.programId] = { label: t('Breathless fish market', '屏息鱼市场'), instructions: anchorNames(FISH_MARKET_IX) };
  } catch {
    // Names only: the summary shows addresses without them.
  }
}

async function start() {
  initI18n();
  onLangChange(() => {
    void loadNames().then(render);
  });
  onWalletsChange(() => phase.at === 'pick' && render());
  if (!/^[A-Za-z0-9_-]{43}$/.test(sid) || !token) return set({ at: 'broken', why: t('This link is incomplete. Start again from the desktop app.', '此链接不完整。请在桌面版中重新开始。') });
  try {
    const [got] = await Promise.all([api(''), loadNames()]);
    req = got as unknown as Request;
  } catch (e) {
    const status = (e as { status?: number }).status;
    return set({
      at: 'broken',
      why: status === 401 || status === 404 ? t('This link expired or was already used. Start again from the desktop app.', '此链接已过期或已被使用。请在桌面版中重新开始。') : t(`Could not load the request: ${message(e)}`, `无法读取请求：${message(e)}`),
    });
  }
  set({ at: 'pick' });
  // The countdown, and an expired link says so.
  const tick = window.setInterval(() => {
    if (!req || phase.at === 'finished' || phase.at === 'broken') return window.clearInterval(tick);
    if (Date.now() > req.expiresAt) {
      window.clearInterval(tick);
      return set({ at: 'broken', why: t('This link expired. Start again from the desktop app.', '此链接已过期。请在桌面版中重新开始。') });
    }
    const exp = root.querySelector('.link-expiry');
    if (exp) exp.textContent = t(`This link expires in ${minutesLeft(req)}.`, `此链接将在 ${minutesLeft(req)} 后过期。`);
  }, 1000);
}

void start();

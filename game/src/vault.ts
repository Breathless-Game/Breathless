import { fishValue, zoneForDepth } from './fish';
import { onLangChange, pickName, t } from './i18n';
import { MAPS, type MapId } from './maps';
import { bulkSelectable, bulkSelectBlock, bulkSellable, bulkSellableBelowEpic, isFundsError, needsConfirm, pearls, pruneSelection, selectionRange, selectionSummary, sellQuote, type BankedFish } from './market';
import type { NftQueue } from './nft-queue';
import { formatSerial, nftName } from './nft-uri';
import { fishCard } from './portrait';
import { sessionBalance, topUpSession, walletState } from './wallet';
import { explorerAddress, explorerTx, isUserRejection } from './wallet-storage';

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
const walletName = () => walletState().wallet?.name ?? t('Your wallet', '你的钱包');

const STEP_LABEL = {
  mint: () => t('Minting on Solana…', '正在 Solana 上铸造…'),
};

function explorerLink(address: string, label = t('View on Explorer ↗', '在浏览器中查看 ↗')) {
  const a = el('a', 'explorer', label);
  a.href = explorerAddress(address);
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

const SELL_LABEL = {
  verify: () => t('Market verifying…', '市场验证中…'),
  sign: () => t(`Approve in ${walletName()}…`, `请在 ${walletName()} 中确认…`),
  confirm: () => t('Confirming…', '确认中…'),
};

const faucetHint = () =>
  t(
    'Faucet is rate limited. Use Fund game wallet, or faucet.solana.com with the game wallet address.',
    '水龙头已限流。请为游戏钱包充值，或用游戏钱包地址前往 faucet.solana.com 领取。',
  );
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
  /** "Sell all" is asking once more (it never takes epic or rarer fish, but it is still many fish). */
  private confirmingAll = false;
  private confirmTimer = 0;
  /** Fish ticked for a bulk sale. Survives re-renders; pruned to fish still in the bank and sellable. */
  private selected = new Set<BankedFish>();
  /** The last fish ticked: the anchor for shift-click range select. */
  private anchor: BankedFish | null = null;
  /** The selection toolbar is asking once more (it holds epic or rarer fish). */
  private confirmingSelected = false;
  /** Cards in display order, for range select. */
  private order: BankedFish[] = [];
  private funding = false;

  constructor(
    private bank: BankedFish[],
    private queue: NftQueue,
  ) {
    onLangChange(() => {
      if (!this.open) return;
      this.render();
      void this.refreshWallet();
    });
  }

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
      this.walletEl.replaceChildren(el('span', 'wallet-card-empty', t('Connect a wallet to mint.', '连接钱包后即可铸造。')));
      return;
    }
    this.walletEl.replaceChildren(el('span', 'wallet-card-empty', t('Connecting to Solana devnet…', '正在连接 Solana devnet…')));
    try {
      let sol: number | null = null;
      try {
        sol = await sessionBalance();
      } catch {}
      const low = sol != null && sol < FUND_BELOW_SOL;

      const info = el('div', 'game-wallet-info');
      const addr = el('a', 'wallet-addr', short(session));
      addr.href = explorerAddress(session);
      addr.target = '_blank';
      addr.rel = 'noopener';
      addr.title = `${session}\n${t('View on Solana Explorer (devnet)', '在 Solana 浏览器中查看（devnet）')}`;
      const bal = el('span', `game-wallet-balance${low ? ' low' : ''}`, sol == null ? t('balance unavailable', '余额不可用') : `${sol.toFixed(3)} SOL`);
      info.append(addr, bal);

      const actions = el('div', 'game-wallet-actions');
      if (low) {
        const fund = el('button', 'mini primary', t(`Fund ${FUND_SOL} SOL`, `充值 ${FUND_SOL} SOL`));
        fund.id = 'fund';
        fund.title = t(
          `Send ${FUND_SOL} devnet SOL from ${walletName()} to the game wallet (one prompt)`,
          `从 ${walletName()} 向游戏钱包发送 ${FUND_SOL} devnet SOL（需确认一次）`,
        );
        fund.addEventListener('click', () => this.fund(fund));
        actions.append(fund);
      }
      const airdrop = el('button', 'mini ghost', t('Airdrop 1 SOL', '空投 1 SOL'));
      airdrop.id = 'airdrop';
      airdrop.title = t('Ask the devnet faucet for 1 SOL (often rate limited)', '向 devnet 水龙头申请 1 SOL（常被限流）');
      airdrop.addEventListener('click', () => this.airdrop());
      actions.append(airdrop);

      this.walletEl.replaceChildren(info, actions);
      if (note) this.walletEl.append(el('div', 'note', note));
    } catch (e) {
      this.walletEl.replaceChildren(el('span', 'wallet-card-empty', `${t('Solana unavailable', 'Solana 不可用')}: ${(e as Error).message}`));
    }
  }

  /** The player's wallet sends devnet SOL to the game wallet (one prompt). */
  private async fund(btn: HTMLButtonElement) {
    if (this.funding) return;
    this.funding = true;
    btn.disabled = true;
    btn.textContent = t(`Approve in ${walletName()}…`, `请在 ${walletName()} 中确认…`);
    try {
      await topUpSession(FUND_SOL);
      await this.refreshWallet(t('Game wallet funded.', '游戏钱包已充值。'));
      this.queue.recheck();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error('top-up failed', e);
      await this.refreshWallet(
        isUserRejection(e)
          ? t('Top-up cancelled.', '已取消充值。')
          : /insufficient|debit an account|0x1\b/i.test(msg)
            ? t(
                `${walletName()} needs devnet SOL (faucet.solana.com) and must be on Devnet.`,
                `${walletName()} 需要 devnet SOL（faucet.solana.com），且须切换到 Devnet。`,
              )
            : `${t('Top-up failed', '充值失败')}: ${msg.slice(0, 100)}`,
      );
    } finally {
      this.funding = false;
    }
  }

  private async airdrop() {
    const c = await this.queue.loadChain();
    const btn = $('airdrop') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('Requesting…', '申请中…');
    try {
      await c.airdrop(1);
      await this.refreshWallet(t('Airdrop received.', '空投已到账。'));
      this.queue.recheck();
    } catch {
      await this.refreshWallet(faucetHint());
    }
  }

  private render() {
    this.selected = pruneSelection(this.selected, this.bank, this.queue.selling);
    if (!this.selected.size) {
      this.confirmingSelected = false;
      this.anchor = null;
    }
    this.renderMarket();
    const sorted = [...this.bank].sort((a, b) => fishValue(b) - fishValue(a));
    this.order = sorted;
    const worth = this.bank.filter((f) => !f.legacy).reduce((s, f) => s + fishValue(f), 0);
    this.countEl.textContent = sorted.length ? t(`${sorted.length} fish · worth ${pearls(worth)}`, `${sorted.length} 条鱼 · 价值 ${pearls(worth)}`) : '';
    if (!sorted.length) {
      this.grid.replaceChildren(el('p', 'collection-empty', t('Nothing banked yet. Dive!', '还没有收获。去下潜吧！')));
      return;
    }
    this.grid.replaceChildren(...sorted.map((f) => this.card(f)));
  }

  /** The mint queue's notice, then the toolbar: "Sell all commons" and the last sale. */
  private renderMarket() {
    const q = this.queue;
    const queued = this.bank.filter((f) => f.nft === 'pending' || f.nft === 'failed').length;
    const waiting = queued || this.bank.some((f) => f.sellQueued);
    const more = queued ? t(`${queued} NFT${queued > 1 ? 's' : ''} waiting`, `${queued} 个 NFT 等待中`) : '';
    let box: HTMLElement | null = null;
    const forSale = this.bank.filter((f) => f.sellQueued && f.nft !== 'minted').length;
    if (q.batch) {
      box = this.batchNotice(q.batch);
    } else if (q.mintPause && q.mintPause.until > Date.now() && queued) {
      const busy = q.mintPause.kind === 'busy';
      const at = new Date(q.mintPause.until).toLocaleTimeString([], busy ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
      box = busy
        ? notice('warn', t('Minting paused: the PEARL market or Solana devnet is busy.', '铸造已暂停：PEARL 市场或 Solana devnet 繁忙。'), t(`Nothing is lost: ${queued} NFT${queued > 1 ? 's' : ''} stay queued and retry at ${at}.`, `不会丢失：${queued} 个 NFT 仍在排队，将于 ${at} 重试。`))
        : notice('warn', `Minting paused until ${at}: this wallet reached the market's hourly mint limit.`, `Nothing is lost: ${queued} NFT${queued > 1 ? 's' : ''} stay queued and mint on their own.`);
    } else if (q.funds === 'needs-sol' && waiting) {
      // Fund sits on the game wallet card just above: one button, not two.
      box = notice('warn', t('Minting paused: the game wallet needs devnet SOL.', '铸造已暂停：游戏钱包需要 devnet SOL。'), t(`Fund it above. Checking again every minute.${more ? ` ${more}.` : ''}`, `请在上方充值，每分钟重新检查一次。${more ? `${more}。` : ''}`));
    } else if (q.funds === 'offline' && waiting) {
      box = notice('warn', t('Solana devnet is not answering.', 'Solana devnet 没有响应。'), t('Retrying every minute.', '每分钟重试一次。'));
    } else if (q.serials === 'waiting' && queued) {
      box = notice('warn', t('Waiting for fish numbers: the game server is not answering.', '正在等待鱼的编号：游戏服务器没有响应。'), t('Retrying shortly.', '稍后重试。'));
    } else if (q.minting) {
      const step = q.minting.step ? STEP_LABEL[q.minting.step]() : t('Starting…', '启动中…');
      const then = forSale > 1 ? t(` Then ${forSale} fish sell together: one approval in ${walletName()}.`, `随后 ${forSale} 条鱼一起出售：在 ${walletName()} 中确认一次。`) : '';
      box = notice('busy', t(`Minting ${nftName(q.minting.fish)}: ${step}`, `正在铸造 ${nftName(q.minting.fish)}：${step}`), `${queued ? t(`${queued} more queued.`, `还有 ${queued} 个排队中。`) : ''}${then}`.trim());
    } else if (q.declined) {
      box = notice('info', t(`Sale cancelled in ${walletName()}.`, `已在 ${walletName()} 中取消出售。`), t(`Nothing was sent: ${q.declined === 1 ? 'the fish is' : `all ${q.declined} fish are`} still yours.`, `没有发送任何内容：${q.declined === 1 ? '这条鱼' : `全部 ${q.declined} 条鱼`}仍归你所有。`));
    } else if (queued) {
      box = notice('info', t(`${queued} NFT${queued > 1 ? 's' : ''} queued`, `${queued} 个 NFT 排队中`));
    }
    this.noticeEl.replaceChildren(...(box ? [box] : []));

    const parts: HTMLElement[] = [];
    const worth = (list: BankedFish[]) => list.reduce((s, f) => s + fishValue(f), 0);
    const commons = bulkSellable(this.bank, 'common');
    // Every bulk sale is one batch: one approval in the player's wallet, however many fish.
    if (commons.length) {
      const btn = el('button', 'mini', t(`Sell all commons (${commons.length}) · ${pearls(worth(commons))}`, `出售全部普通鱼 (${commons.length}) · ${pearls(worth(commons))}`));
      btn.title = t(`One approval in ${walletName()} for all of them`, `在 ${walletName()} 中一次确认全部`);
      btn.addEventListener('click', () => this.queue.sellMany(bulkSellable(this.bank, 'common')));
      parts.push(btn);
    }
    // "Sell all" only when it is more than the commons: every fish below epic, after one more click.
    const below = bulkSellableBelowEpic(this.bank);
    if (below.length > commons.length) {
      if (this.confirmingAll) {
        const wrap = el('span', 'sell-confirm', '');
        const yes = el('button', 'mini primary', t(`Confirm ${below.length} · ${pearls(worth(below))}`, `确认 ${below.length} 条 · ${pearls(worth(below))}`));
        yes.title = t('Epic, legendary and mythic fish are kept', '史诗、传说和神话级的鱼会保留');
        const no = el('button', 'mini cancel-x', '✕');
        no.title = t('Cancel', '取消');
        no.setAttribute('aria-label', t('Cancel', '取消'));
        yes.addEventListener('click', () => {
          this.setConfirmingAll(false);
          this.queue.sellMany(bulkSellableBelowEpic(this.bank));
        });
        no.addEventListener('click', () => this.setConfirmingAll(false));
        wrap.append(yes, no);
        parts.push(wrap);
      } else {
        const btn = el('button', 'mini', t(`Sell all below epic (${below.length}) · ${pearls(worth(below))}`, `出售史诗以下全部 (${below.length}) · ${pearls(worth(below))}`));
        btn.title = t(`Every fish except epic, legendary and mythic, with one approval in ${walletName()}`, `除史诗、传说和神话级外的所有鱼，在 ${walletName()} 中确认一次`);
        btn.addEventListener('click', () => this.setConfirmingAll(true));
        parts.push(btn);
      }
    }
    // Always present (disabled when nothing is ticked) so the toolbar never changes size.
    parts.push(this.selectionBar());
    if (q.lastSale) {
      const { name, result, count, total, failed } = q.lastSale;
      const what = count > 1 ? t(`Sold ${count} fish · +${pearls(total)}`, `已售出 ${count} 条鱼 · +${pearls(total)}`) : t(`Sold ${name} · +${pearls(result.pearls)}`, `已售出 ${name} · +${pearls(result.pearls)}`);
      const sale = el('span', 'sale', failed ? t(`${what} · ${failed} not sold`, `${what} · ${failed} 条未售出`) : what);
      if (isSignature(result.tx)) {
        const a = el('a', '', 'tx ↗');
        a.target = '_blank';
        a.rel = 'noopener';
        a.href = explorerTx(result.tx);
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
    card.fig.classList.toggle('selected', this.selected.has(f));
    card.fig.querySelector('.card-select')?.remove();
    card.fig.prepend(this.checkbox(f));
    return card.fig;
  }

  /** The bulk-sell tick on a card. Disabled, with the reason, when the fish cannot be sold. */
  private checkbox(f: BankedFish) {
    const block = bulkSelectBlock(f, this.queue.selling);
    const label = el('label', 'card-select');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.selected.has(f);
    box.setAttribute('aria-label', t(`Select ${f.name} to sell`, `选择 ${f.name} 出售`));
    if (block) {
      box.disabled = true;
      label.title =
        block === 'queued' ? t('Already being sold', '正在出售')
        : block === 'minting' ? t('Wait for the NFT to mint first', '请等待 NFT 铸造完成')
        : block === 'paid-out' ? t('Already paid out', '已结算')
        : (f.sellBlock ?? t('Not sellable', '无法出售'));
    }
    // Never let the tick reach the card.
    label.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      if (block) return;
      const on = box.checked;
      if (e.shiftKey && this.anchor && this.anchor !== f) {
        const range = selectionRange(this.order, this.anchor, f, (x) => bulkSelectable(x, this.queue.selling));
        for (const x of range) on ? this.selected.add(x) : this.selected.delete(x);
      } else if (on) this.selected.add(f);
      else this.selected.delete(f);
      this.anchor = f;
      this.confirmingSelected = false;
      this.render();
    });
    label.append(box);
    return label;
  }

  /** Shown while something is ticked: sell them together, select every sellable fish, or clear. */
  private selectionBar() {
    const chosen = [...this.selected];
    const sum = selectionSummary(chosen, fishValue);
    const bar = el('span', 'select-bar');
    const go = () => {
      const list = [...this.selected];
      this.selected = new Set();
      this.anchor = null;
      this.setConfirmingSelected(false);
      this.queue.sellMany(list);
    };
    if (this.confirmingSelected && sum.needsConfirm) {
      const yes = el('button', 'mini primary', t(`Confirm ${sum.count} · ${pearls(sum.total)}`, `确认 ${sum.count} 条 · ${pearls(sum.total)}`));
      yes.title = t('Includes epic, legendary or mythic fish', '包含史诗、传说或神话级的鱼');
      const no = el('button', 'mini cancel-x', '✕');
      no.title = t('Cancel', '取消');
      no.setAttribute('aria-label', t('Cancel', '取消'));
      yes.addEventListener('click', go);
      no.addEventListener('click', () => this.setConfirmingSelected(false));
      const wrap = el('span', 'sell-confirm', '');
      wrap.append(yes, no);
      bar.append(wrap);
    } else if (!sum.count) {
      const sell = el('button', 'mini primary', t('Select fish to sell', '勾选要出售的鱼'));
      sell.disabled = true;
      bar.append(sell);
    } else {
      const sell = el('button', 'mini primary', t(`Sell selected (${sum.count}) · ${pearls(sum.total)}`, `出售所选 (${sum.count}) · ${pearls(sum.total)}`));
      sell.title = t(`One approval in ${walletName()} for all of them`, `在 ${walletName()} 中一次确认全部`);
      sell.addEventListener('click', () => (sum.needsConfirm ? this.setConfirmingSelected(true) : go()));
      bar.append(sell);
    }
    const all = el('button', 'mini', t('Select all sellable', '全选可出售'));
    all.addEventListener('click', () => {
      this.selected = new Set(this.bank.filter((x) => bulkSelectable(x, this.queue.selling)));
      this.confirmingSelected = false;
      this.render();
    });
    const clear = el('button', 'mini', t('Clear', '清除'));
    clear.disabled = !sum.count;
    clear.addEventListener('click', () => {
      this.selected = new Set();
      this.anchor = null;
      this.setConfirmingSelected(false);
      this.render();
    });
    bar.append(all, clear);
    return bar;
  }

  private setConfirmingSelected(on: boolean) {
    this.confirmingSelected = on;
    window.clearTimeout(this.confirmTimer);
    if (on) this.confirmTimer = window.setTimeout(() => this.setConfirmingSelected(false), CONFIRM_MS);
    this.refresh();
  }

  /**
   * Under the art (which already shows the name, rarity, size, depth, seed and number): where it
   * was caught and its value, the NFT status pill, then the actions, pinned to the card's bottom.
   */
  private caption(f: BankedFish, cap: HTMLElement) {
    const q = this.queue;
    const where = f.map && f.map in MAPS ? pickName(MAPS[f.map as MapId]) : zoneForDepth(f.depthM).name;
    const meta = el('div', 'card-meta');
    meta.append(el('span', 'card-where', where), el('span', 'card-value', pearls(fishValue(f))));
    const status = el('div', 'card-status');
    status.append(this.nftBadge(f));
    // The chain is the source of truth: a direct link works even when a wallet hides the NFT.
    if (f.nft === 'minted' && f.assetId) status.appendChild(explorerLink(f.assetId));
    // One reserved line, always present: errors never add a row (clamped; the full text is in the title).
    const parts: HTMLElement[] = [meta, status];
    const err = q.sellErrors.get(f) ?? (f.nft === 'failed' ? f.mintError : undefined);
    const line = el('div', 'card-note', '');
    if (f.sellBlock && !q.sellErrors.has(f)) {
      line.className = 'card-note err';
      line.textContent = `Not sellable: ${f.sellBlock}`;
    } else if (err) {
      const sale = q.sellErrors.has(f);
      line.className = 'card-note err';
      line.textContent = sale ? t(`Sale failed: ${err}`, `出售失败：${err}`) : t(`Mint failed: ${err}`, `铸造失败：${err}`);
      // Mints are paid by the game wallet, sales by the player's own wallet.
      if (sale && isUserRejection({ message: err })) line.textContent = t(`Sale cancelled in ${walletName()}.`, `已在 ${walletName()} 中取消出售。`);
      else if (isFundsError(err)) {
        line.textContent = sale
          ? t(`${walletName()} needs devnet SOL for the sale fee (faucet.solana.com) and must be on Devnet.`, `${walletName()} 需要 devnet SOL 支付出售手续费（faucet.solana.com），且须切换到 Devnet。`)
          : t('The game wallet is out of devnet SOL. Fund it above.', '游戏钱包的 devnet SOL 用完了，请在上方充值。');
      }
    }
    if (line.textContent) {
      line.title = line.textContent;
      line.tabIndex = 0;
    }
    parts.push(line);
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
      const a = el('a', 'onchain pill pill-ok', `${num}${t('On-chain ✓', '已上链 ✓')}`);
      a.target = '_blank';
      a.rel = 'noopener';
      a.href = explorerAddress(f.assetId);
      return a;
    }
    if (f.nft === 'minting') {
      const step = q.minting?.fish === f && q.minting.step ? STEP_LABEL[q.minting.step]() : t('Minting…', '铸造中…');
      const p = pill('busy', step);
      p.classList.add('busy');
      return p;
    }
    if (f.nft === 'pending') {
      if (q.funds === 'needs-sol') return pill('warn', t('NFT queued · needs SOL', 'NFT 排队中 · 需要 SOL'));
      if (q.serials === 'waiting' && !f.serial) return pill('warn', t('Waiting for number', '等待编号'));
      return pill('info', t('NFT queued', 'NFT 排队中'));
    }
    if (f.nft === 'failed') {
      const p = pill('err', f.retryAt ? t('Mint failed · retrying soon', '铸造失败 · 即将重试') : t('Mint failed', '铸造失败'));
      p.classList.add('failed');
      return p;
    }
    return pill('muted', t('Not minted', '未铸造'));
  }

  /** What fixes a stuck NFT: Retry a failed mint, or Mint a legacy fish nobody asked to mint. */
  private nftAction(f: BankedFish): HTMLElement | null {
    if (f.nft === 'failed') {
      const btn = el('button', 'mini', t('Retry', '重试'));
      btn.addEventListener('click', () => this.queue.retry(f));
      return btn;
    }
    if (f.nft === undefined) {
      // A legacy fish keeps the manual Mint button.
      const btn = el('button', 'mini primary', t('Mint NFT', '铸造 NFT'));
      btn.addEventListener('click', () => this.queue.enqueue(f));
      return btn;
    }
    return null;
  }

  private sellControl(f: BankedFish): HTMLElement {
    const q = this.queue;
    const quote = sellQuote(f, fishValue);
    if (!quote.ok && quote.reason === 'paid-out') {
      const tag = el('span', 'paid', t('Paid out', '已结算'));
      tag.title = t('Banked before selling existed: its Pearls were paid on surfacing.', '在出售功能上线前入库：珍珠已在上浮时发放。');
      return tag;
    }
    if (!quote.ok && quote.reason === 'blocked') {
      const tag = el('span', 'paid', 'Not sellable');
      tag.title = f.sellBlock ?? 'The market cannot buy this NFT';
      return tag;
    }
    if (q.selling.has(f)) {
      const step = q.selling.get(f);
      const btn = el('button', 'mini', step ? SELL_LABEL[step]() : t('Selling…', '出售中…'));
      btn.disabled = true;
      return btn;
    }
    if (f.sellQueued) {
      const wrap = el('span', 'sell-queued', f.nft === 'minted' ? t('Sale queued ', '出售排队中 ') : t('Mint, then sell ', '先铸造再出售 '));
      const cancel = el('button', 'mini', t('Cancel', '取消'));
      cancel.addEventListener('click', () => this.queue.cancelSell(f));
      wrap.appendChild(cancel);
      return wrap;
    }
    if (!quote.ok) {
      const btn = el('button', 'mini sell', `${t('Sell', '出售')} · ${pearls(fishValue(f))}`);
      btn.disabled = true;
      btn.title = t('Wait for the mint to finish', '请等待铸造完成');
      return btn;
    }
    const verb = quote.mintFirst ? t('Mint & sell', '铸造并出售') : t('Sell', '出售');
    if (this.confirming === f) {
      const wrap = el('span', 'sell-confirm', '');
      // Same footprint as the Sell button: "Confirm · N" plus a small cancel, no extra row.
      const yes = el('button', 'mini primary', `${t('Confirm', '确认')} · ${pearls(quote.pearls)}`);
      yes.title = `${t('Confirm', '确认')}${f.serial ? ` ${formatSerial(f.serial)}` : ''} · ${pearls(quote.pearls)}`;
      const no = el('button', 'mini cancel-x', '✕');
      no.title = t('Cancel', '取消');
      no.setAttribute('aria-label', t('Cancel', '取消'));
      yes.addEventListener('click', () => {
        this.setConfirming(null);
        this.queue.sell(f);
      });
      no.addEventListener('click', () => this.setConfirming(null));
      wrap.append(yes, no);
      return wrap;
    }
    const btn = el('button', 'mini sell', `${verb} · ${pearls(quote.pearls)}`);
    btn.title = quote.mintFirst
      ? t('Mints the NFT first: the market only buys NFTs', '先铸造 NFT：市场只收购 NFT')
      : t('The market burns the NFT and pays you its value in PEARL', '市场销毁这个 NFT，并按价值支付 PEARL');
    btn.addEventListener('click', () => {
      if (needsConfirm(f.rarity)) this.setConfirming(f);
      else this.queue.sell(f);
    });
    return btn;
  }

  /** The notice while a batch sells: what it waits for, and that the wallet asks only once. */
  private batchNotice(b: { step: string | null; fish: number; txs?: number }) {
    const n = b.fish;
    const fish = t(n === 1 ? '1 fish' : `${n} fish`, `${n} 条鱼`);
    if (b.step === 'sign') {
      const once = n > 1 ? t('approve once', '确认一次') : t('approve', '确认');
      const detail = b.txs && b.txs > 1 ? t(`${b.txs} transfers, one approval.`, `${b.txs} 笔转账，确认一次。`) : n > 1 ? t(`One transfer for all ${n}.`, `全部 ${n} 条一笔转账。`) : '';
      return notice('busy', t(`Selling ${fish}… ${once} in ${walletName()}`, `正在出售 ${fish}… 请在 ${walletName()} 中${once}`), detail);
    }
    if (b.step === 'confirm') return notice('busy', t(`Selling ${fish}: confirming on Solana…`, `正在出售 ${fish}：Solana 确认中…`), t('The market checks each transfer and pays each fish in PEARL.', '市场会核对每笔转账，并为每条鱼支付 PEARL。'));
    return notice('busy', t(`Selling ${fish}: the market is checking prices…`, `正在出售 ${fish}：市场正在核价…`));
  }

  private setConfirmingAll(on: boolean) {
    this.confirmingAll = on;
    window.clearTimeout(this.confirmTimer);
    if (on) this.confirmTimer = window.setTimeout(() => this.setConfirmingAll(false), CONFIRM_MS);
    this.refresh();
  }

  /** Epic and rarer fish ask once more; the question goes away on its own. */
  private setConfirming(f: BankedFish | null) {
    this.confirming = f;
    window.clearTimeout(this.confirmTimer);
    if (f) this.confirmTimer = window.setTimeout(() => this.setConfirming(null), CONFIRM_MS);
    this.refresh();
  }
}

import { coreAsset } from './explorer-links';
import { type GearKind, type GearState } from './gear-nft';
import { onLangChange, t } from './i18n';
import type { GearNftStatus } from './gear-sync';

// The workbench's on-chain gear card: one row per NFT (Boat, Dive Kit) with its sync status and a
// link to it on the Metaplex Core explorer. Statically loaded, so it imports nothing chain-related:
// the link comes from explorer-links.ts.

const title = (kind: GearKind) => (kind === 'boat' ? t('Boat', '船') : t('Dive Kit', '潜水装备'));

function stateLabel(state: GearState): string {
  switch (state) {
    case 'off': return t('Not synced', '未同步');
    case 'syncing': return t('Syncing to chain…', '正在同步上链…');
    case 'synced': return t('On-chain ✓', '已上链 ✓');
    case 'needs-sol': return t('Waiting for SOL', '等待 SOL');
    case 'offline': return t('Offline · will retry', '离线 · 稍后重试');
    case 'retrying': return t('Retrying soon…', '即将重试…');
    case 'paused': return t('Sync paused · local levels in use', '同步已暂停 · 使用本地等级');
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

let lastRender: (() => void) | null = null;
let unsub: (() => void) | null = null;

/** Redraw the card. `statuses` empty (sync off): the card hides. */
export function renderGearChain(root: HTMLElement, statuses: readonly GearNftStatus[]) {
  lastRender = () => renderGearChain(root, statuses);
  if (!unsub) unsub = onLangChange(() => lastRender?.());
  root.hidden = statuses.length === 0 || statuses.every((s) => s.state === 'off');
  if (root.hidden) return;
  const rows = statuses.map((s) => {
    const row = el('div', 'gc-row');
    row.dataset.state = s.state;
    row.append(el('span', 'gc-name', title(s.kind)), el('span', 'gc-state', stateLabel(s.state)));
    if (s.asset) {
      const a = el('a', 'gc-link', t('View on chain ↗', '在链上查看 ↗'));
      a.href = coreAsset(s.asset);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = t(`${title(s.kind)} NFT ${s.asset} on Metaplex Core explorer (devnet)`, `${title(s.kind)} NFT ${s.asset}，Metaplex Core 浏览器（devnet）`);
      row.append(a);
    } else row.append(el('span', 'gc-link muted', t('not minted yet', '尚未铸造')));
    return row;
  });
  const orphaned = statuses.some((s) => s.orphaned.length > 0);
  root.replaceChildren(
    el('div', 'gc-title small muted', t('ON-CHAIN GEAR · devnet', '链上装备 · devnet')),
    ...rows,
    el(
      'div',
      'gc-note small muted',
      orphaned
        ? t('Minted a fresh pair: the earlier ones belong to another browser’s game wallet.', '已重新铸造一组：之前的属于另一个浏览器的游戏钱包。')
        : t('Kept in step by this browser’s game wallet. Upgrades apply at once either way.', '由此浏览器的游戏钱包保持同步。无论如何，升级都会立即生效。'),
    ),
  );
}

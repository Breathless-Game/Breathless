import { coreAsset } from './explorer-links';
import { GEAR_STATE_LABELS, type GearKind } from './gear-nft';
import type { GearNftStatus } from './gear-sync';

// The workbench's on-chain gear card: one row per NFT (Boat, Dive Kit) with its sync status and a
// link to it on the Metaplex Core explorer. Statically loaded, so it imports nothing chain-related:
// the link comes from explorer-links.ts.

const TITLES: Record<GearKind, string> = { boat: 'Boat', kit: 'Dive Kit' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Redraw the card. `statuses` empty (sync off): the card hides. */
export function renderGearChain(root: HTMLElement, statuses: readonly GearNftStatus[]) {
  root.hidden = statuses.length === 0 || statuses.every((s) => s.state === 'off');
  if (root.hidden) return;
  const rows = statuses.map((s) => {
    const row = el('div', 'gc-row');
    row.dataset.state = s.state;
    row.append(el('span', 'gc-name', TITLES[s.kind]), el('span', 'gc-state', GEAR_STATE_LABELS[s.state]));
    if (s.asset) {
      const a = el('a', 'gc-link', 'View on chain ↗');
      a.href = coreAsset(s.asset);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = `${TITLES[s.kind]} NFT ${s.asset} on Metaplex Core explorer (devnet)`;
      row.append(a);
    } else row.append(el('span', 'gc-link muted', 'not minted yet'));
    return row;
  });
  const orphaned = statuses.some((s) => s.orphaned.length > 0);
  root.replaceChildren(
    el('div', 'gc-title small muted', 'ON-CHAIN GEAR · devnet'),
    ...rows,
    el(
      'div',
      'gc-note small muted',
      orphaned
        ? 'Minted a fresh pair: the earlier ones belong to another browser’s game wallet.'
        : 'Kept in step by this browser’s game wallet. Upgrades apply at once either way.',
    ),
  );
}

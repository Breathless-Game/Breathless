// Whether the player's own wallet is asking them something right now (an owner signature: a sale,
// a purchase, a burn, a top-up). While it is, the game may lose its window: the desktop app's
// Browser wallet opens the system browser over the game (desktop-wallet.ts), and per Electron's
// page-visibility docs a fully covered window on macOS reads as a hidden page. A hidden tab
// mid-dive used to send the diver aboard to the workbench (main.ts pause), so a sale from the
// Collection mid-dive left the player at the title's fish instead of where they were.
// No imports, so tests/wallet-prompt.test.mjs can load it on its own.

let open = 0;

/** True while an owner signature request is waiting on the player. */
export function walletPromptOpen(): boolean {
  return open > 0;
}

/** Run `ask` (one owner signature request) counted as an open wallet prompt until it settles. */
export async function duringWalletPrompt<T>(ask: () => Promise<T>): Promise<T> {
  open++;
  try {
    return await ask();
  } finally {
    open--;
  }
}

/** The owner signer's shape (umi's Signer): its key and the three calls that prompt the player. */
export interface PromptingSigner<Tx, Key> {
  publicKey: Key;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(tx: Tx): Promise<Tx>;
  signAllTransactions(txs: Tx[]): Promise<Tx[]>;
}

/** `signer` with every prompting call counted by walletPromptOpen. */
export function trackPrompts<Tx, Key>(signer: PromptingSigner<Tx, Key>): PromptingSigner<Tx, Key> {
  return {
    publicKey: signer.publicKey,
    signMessage: (message) => duringWalletPrompt(() => signer.signMessage(message)),
    signTransaction: (tx) => duringWalletPrompt(() => signer.signTransaction(tx)),
    signAllTransactions: (txs) => duringWalletPrompt(() => signer.signAllTransactions(txs)),
  };
}

/**
 * What the tab going hidden does to the game. board: mid-dive, nobody watching, so go aboard to
 * the workbench as Esc does. hold: mid-dive, but the player's wallet took the window: freeze the
 * dive where it is (shouldResume says when it carries on). none: not in a running dive.
 */
export type HiddenAction = 'board' | 'hold' | 'none';

export function onTabHidden(s: { playing: boolean; paused: boolean; promptOpen: boolean }): HiddenAction {
  if (!s.playing || s.paused) return 'none';
  return s.promptOpen ? 'hold' : 'board';
}

/**
 * A dive held for the wallet carries on only once the tab shows again and no prompt is open: the
 * player may come back to read the desktop app's code before approving, and the dive must not run
 * on under its waiting screen.
 */
export function shouldResume(s: { held: boolean; hidden: boolean; promptOpen: boolean }): boolean {
  return s.held && !s.hidden && !s.promptOpen;
}

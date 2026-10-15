// Whether the player's own wallet is asking them something right now (an owner signature: a sale,
// a purchase, a burn, a top-up). While it is, the game is expected to lose its window: Phantom's
// popup in fullscreen, or the desktop app's Browser wallet, which opens the system browser over the
// game (desktop-wallet.ts). On macOS a fully covered window reads as a hidden tab, and a hidden tab
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
 * dive where it is and carry on when the tab shows again. none: not in a running dive.
 */
export type HiddenAction = 'board' | 'hold' | 'none';

export function onTabHidden(s: { playing: boolean; paused: boolean; promptOpen: boolean }): HiddenAction {
  if (!s.playing || s.paused) return 'none';
  return s.promptOpen ? 'hold' : 'board';
}

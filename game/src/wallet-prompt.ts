// Whether the player's own wallet is asking them something right now (an owner signature: a sale,
// a purchase, a burn, a top-up). While it is, the game may lose its window: the desktop app's
// Browser wallet opens the system browser over the game (desktop-wallet.ts), and per Electron's
// page-visibility docs a fully covered window on macOS reads as a hidden page. A hidden tab
// mid-dive used to send the diver aboard to the workbench (main.ts pause), so a sale from the
// Collection mid-dive left the player at the title's fish instead of where they were. A wallet may
// also report its accounts in flux while it shows a prompt; wallet.ts waits for the prompt to settle
// before it logs anyone out or reloads (accountsVerdict).
// No imports, so tests/wallet-prompt.test.mjs can load it on its own.

let open = 0;
let settled: (() => void)[] = [];

/**
 * How long one prompt may hold the game (a dive frozen, an account check deferred). A wallet can
 * hang without ever answering (Phantom's popup gone, the promise left pending): past this the prompt
 * stops counting, so the dive carries on and the deferred check runs. The prompt itself still
 * settles (or fails) only when the wallet answers.
 */
export const PROMPT_HOLD_MS = 3 * 60_000;

/** The timer behind the cap; tests pass their own clock. */
export interface PromptTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: PromptTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** True while an owner signature request is waiting on the player. */
export function walletPromptOpen(): boolean {
  return open > 0;
}

/** Resolves once no owner signature request is open (at once if none is). */
export function promptsSettled(): Promise<void> {
  if (open === 0) return Promise.resolve();
  return new Promise((resolve) => settled.push(resolve));
}

/**
 * Run `ask` (one owner signature request) counted as an open wallet prompt until it settles, or
 * until PROMPT_HOLD_MS, whichever comes first.
 */
export async function duringWalletPrompt<T>(ask: () => Promise<T>, timers: PromptTimers = realTimers): Promise<T> {
  open++;
  // Each prompt lets go of its count once: a late answer after the cap must not release a newer prompt.
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    open--;
    if (open === 0) {
      const waiting = settled;
      settled = [];
      for (const resolve of waiting) resolve();
    }
  };
  const cap = timers.setTimeout(release, PROMPT_HOLD_MS);
  try {
    return await ask();
  } finally {
    timers.clearTimeout(cap);
    release();
  }
}

/**
 * What a wallet's account report means for the logged-in owner. keep: the owner is still there (or
 * nobody is logged in). defer: a prompt is open, so the report may be the wallet's own churn while
 * it signs: ask the wallet again once the prompt settles. switched: another account (drop the owner;
 * main.ts reloads). disconnected: no account for this site (a logout, then the same).
 */
export type AccountsVerdict = 'keep' | 'defer' | 'switched' | 'disconnected';

export function accountsVerdict(s: { owner: string | null; addresses: readonly string[]; promptOpen: boolean }): AccountsVerdict {
  if (!s.owner || s.addresses.includes(s.owner)) return 'keep';
  if (s.promptOpen) return 'defer';
  return s.addresses.length ? 'switched' : 'disconnected';
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
 * A running dive freezes while the owner's wallet asks something, visible tab or not: the player is
 * in the wallet's popup, not steering the diver, and a shark bite meanwhile would end the dive on
 * the title (main.ts sharkBite → goToMenu).
 */
export function shouldHold(s: { playing: boolean; paused: boolean; held: boolean; promptOpen: boolean }): boolean {
  return s.playing && !s.paused && !s.held && s.promptOpen;
}

/**
 * A dive held for the wallet carries on only once the tab shows again and no prompt is open: the
 * player may come back to read the desktop app's code before approving, and the dive must not run
 * on under its waiting screen.
 */
export function shouldResume(s: { held: boolean; hidden: boolean; promptOpen: boolean }): boolean {
  return s.held && !s.hidden && !s.promptOpen;
}

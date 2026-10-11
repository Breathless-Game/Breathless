/**
 * What the title-screen PEARL badge shows. A tiny chain-free store: main.ts publishes into it from the
 * one place the balance is read (syncPearls), and the wallet chip subscribes. No imports, so it stays
 * out of the lazy Umi/Solana chunk and costs the entry bundle almost nothing.
 */
export type PearlBalance =
  | { status: 'loading' }
  | { status: 'ok'; value: number }
  | { status: 'unavailable'; reason: string };

let current: PearlBalance = { status: 'loading' };
const listeners = new Set<() => void>();

const set = (next: PearlBalance) => {
  current = next;
  for (const fn of listeners) fn();
};

export const pearlBalance = (): PearlBalance => current;

/** Call to get told about every change. Returns the unsubscribe. */
export function onPearlBalance(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A balance read landed (or a sale / spend moved it). */
export const setPearlBalance = (value: number) => set({ status: 'ok', value });

/** A read is in flight and nothing is known yet: shown as "…", never as 0. */
export const setPearlsLoading = () => set({ status: 'loading' });

/** A read failed. A balance already known stays shown: it is the best cache there is. */
export function setPearlsUnavailable(error: unknown) {
  if (current.status === 'ok') return;
  set({ status: 'unavailable', reason: explainPearlError(error) });
}

/**
 * Local changes (a sale credited, a spend, any nudge) bump this epoch. A read that started before one
 * may answer with the old balance after it: `readGuard()` taken before the read says whether its
 * answer is still current, and an old one is dropped (the change already shows the newer number,
 * and the read that change triggers brings the chain's).
 */
let epoch = 0;
export function bumpPearlEpoch() {
  epoch++;
}
export function readGuard(): () => boolean {
  const started = epoch;
  return () => epoch === started;
}

/** Mirror an optimistic cache change (sale, spend) once a real balance is on show. */
export function nudgePearlBalance(value: number) {
  if (current.status === 'ok' && current.value !== value) {
    epoch++;
    set({ status: 'ok', value });
  }
}

/** 1234 -> "1,234". Anything not a finite non-negative number is "—". */
export function formatPearls(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Why the balance could not be read, in words a player can use. */
export function explainPearlError(error: unknown): string {
  const text = String((error as Error | undefined)?.message ?? error ?? '');
  if (/429|rate.?limit|too many/i.test(text)) return 'The Solana RPC is rate limiting (429). Retry shortly.';
  if (/market|offline|fetch|network|failed to load|503|502/i.test(text)) return 'The market is offline, so the PEARL balance cannot be read.';
  return 'PEARL balance unavailable right now.';
}

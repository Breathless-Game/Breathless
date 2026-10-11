// Payment safety for on-chain PEARL purchases (and every other value-moving transaction):
//   - a confirmed transaction can still have failed on chain (web3.js confirmTransaction does not
//     throw then, it sets `value.err`), so every send checks it;
//   - only one payment at a time (one shared lock for upgrades, food and synthesis);
//   - a payment whose confirmation was lost is remembered per wallet and settled later, delivering
//     its item exactly once if it landed.
// No value imports: tests load this file on its own, and pearl.ts, chain.ts, wallet.ts and
// main.ts all share it.

/** A transaction that was confirmed but failed on chain: nothing it did took effect. */
export class TxFailedError extends Error {
  constructor(
    readonly label: string,
    readonly err: unknown,
  ) {
    super(`${label} failed on-chain: ${safeJson(err)}`);
    this.name = 'TxFailedError';
  }
}

/** Another PEARL payment is still in flight; this one was refused before anything was signed. */
export class PaymentInProgressError extends Error {
  constructor() {
    super('Another payment is in progress');
    this.name = 'PaymentInProgressError';
  }
}

/**
 * The payment was sent but its outcome is not known yet. It is recorded for this wallet and
 * settled on the next load: delivered once if it landed, dropped if it failed or expired.
 */
export class PaymentPendingError extends Error {
  constructor(readonly signature: string) {
    super(`Payment ${signature} is not confirmed yet`);
    this.name = 'PaymentPendingError';
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface ConfirmResultLike {
  value: { err: unknown };
}

/** Throw if a confirmed transaction failed on chain (`value.err` set). */
export function assertLanded(result: ConfirmResultLike, label: string): void {
  const err = result?.value?.err;
  if (err !== null && err !== undefined) throw new TxFailedError(label, err);
}

/**
 * `builder.sendAndConfirm(ctx)` that also throws when the transaction failed on chain. Resolves
 * with the signature (whatever type the builder uses).
 */
export async function confirmedOrThrow<S, C>(
  builder: { sendAndConfirm(ctx: C): Promise<{ signature: S; result: ConfirmResultLike }> },
  ctx: C,
  label: string,
): Promise<S> {
  const { signature, result } = await builder.sendAndConfirm(ctx);
  assertLanded(result, label);
  return signature;
}

/**
 * Was a send refused before it reached the network (preflight / simulation)? Then the transaction
 * was never broadcast and cannot land. Anything else (timeouts, network errors) may have been
 * broadcast and must be looked up.
 */
export function neverBroadcast(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { logs?: unknown; cause?: { logs?: unknown }; message?: unknown };
  if (Array.isArray(err.logs) || Array.isArray(err.cause?.logs)) return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (/already been processed/i.test(msg)) return false;
  return /simulation failed|preflight check|blockhash not found|insufficient (funds|lamports)/i.test(msg);
}

// ---- One payment at a time ----

/**
 * A refusing lock: while a payment runs, another one is refused with PaymentInProgressError
 * (a queue would pop a second, unexpected wallet prompt). Released however `fn` ends.
 */
export class PaymentLock {
  private held = false;
  get busy(): boolean {
    return this.held;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held) throw new PaymentInProgressError();
    this.held = true;
    try {
      return await fn();
    } finally {
      this.held = false;
    }
  }
}

/** The one lock every PEARL payment (and the pending-purchase settlement) goes through. */
export const paymentLock = new PaymentLock();

// ---- Signature status ----

export interface SigStatus {
  error: unknown;
  commitment?: string | null;
}
export type SigVerdict = 'ok' | 'failed' | 'unknown';

/**
 * 'ok' / 'failed' once the transaction is confirmed; 'failed' too when it is not found and its
 * blockhash has expired (it never will land); otherwise 'unknown'.
 */
export function verdictOf(status: SigStatus | null | undefined, height?: number, lastValid?: number): SigVerdict {
  if (status && status.commitment !== 'processed') return status.error ? 'failed' : 'ok';
  if (!status && height !== undefined && lastValid !== undefined && height > lastValid) return 'failed';
  return 'unknown';
}

export interface StatusDeps {
  statuses(signatures: string[]): Promise<(SigStatus | null)[]>;
  blockHeight(): Promise<number>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** Poll one signature until it is settled or `timeoutMs` passes ('unknown'). RPC errors just retry. */
export async function waitForSignature(
  signature: string,
  lastValid: number | undefined,
  deps: StatusDeps,
  { timeoutMs = 45_000, intervalMs = 2_000 } = {},
): Promise<SigVerdict> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  for (;;) {
    try {
      const [status] = await deps.statuses([signature]);
      const height = status ? undefined : await deps.blockHeight().catch(() => undefined);
      const verdict = verdictOf(status, height, lastValid);
      if (verdict !== 'unknown') return verdict;
    } catch (e) {
      console.warn('signature status unavailable, retrying', e);
    }
    if (now() - start >= timeoutMs) return 'unknown';
    await sleep(intervalMs);
  }
}

// ---- Pending purchases (per wallet, in localStorage) ----

/** Per-wallet storage name (pass it through wallet.ts storageKey). */
export const PENDING_PURCHASES = 'pearl.purchases.pending';

export interface PendingPurchase<W = unknown> {
  signature: string;
  /** What the payment buys: handed back to the delivery code as is. */
  what: W;
  cost: number;
  /** When it was signed (ms). */
  ts: number;
  /** The transaction's blockhash expiry: after this block height it can no longer land. */
  lastValid?: number;
}

export interface PurchaseStore {
  load(): PendingPurchase[];
  save(list: PendingPurchase[]): void;
}

const isRecord = (r: unknown): r is PendingPurchase =>
  !!r && typeof r === 'object' && typeof (r as PendingPurchase).signature === 'string' && typeof (r as PendingPurchase).ts === 'number';

/** A store over localStorage (or any Storage) under `key()`. Unreadable data reads as empty. */
export function createPurchaseStore(key: () => string, storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = () => localStorage): PurchaseStore {
  return {
    load() {
      try {
        const raw: unknown = JSON.parse(storage().getItem(key()) ?? '[]');
        return Array.isArray(raw) ? raw.filter(isRecord) : [];
      } catch {
        return [];
      }
    },
    save(list) {
      try {
        if (list.length) storage().setItem(key(), JSON.stringify(list));
        else storage().removeItem(key());
      } catch (e) {
        console.error('could not save pending PEARL purchases', e);
      }
    },
  };
}

export function addPending(store: PurchaseStore, rec: PendingPurchase): void {
  store.save([...store.load().filter((r) => r.signature !== rec.signature), rec]);
}

/** Remove a record; true only if it was there (so exactly one caller gets to deliver it). */
export function takePending(store: PurchaseStore, signature: string): PendingPurchase | null {
  const list = store.load();
  const rec = list.find((r) => r.signature === signature) ?? null;
  if (rec) store.save(list.filter((r) => r.signature !== signature));
  return rec;
}

export interface ReconcileReport {
  delivered: string[];
  dropped: string[];
  kept: string[];
}

/** Without a known blockhash expiry, a record this old that the chain does not know is expired. */
export const PENDING_MAX_AGE_MS = 10 * 60_000;

/**
 * Settle every recorded purchase: landed -> removed, then delivered once; failed or expired ->
 * removed; still unknown -> kept. If the status lookup itself fails, nothing changes. A record is
 * removed before its delivery in the same tick, so it can never be delivered twice (a delivery
 * that throws is logged loudly with its signature).
 */
export async function reconcilePending(
  store: PurchaseStore,
  deps: StatusDeps,
  deliver: (rec: PendingPurchase) => void,
  { maxAgeMs = PENDING_MAX_AGE_MS } = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = { delivered: [], dropped: [], kept: [] };
  const records = store.load();
  if (!records.length) return report;
  const statuses = await deps.statuses(records.map((r) => r.signature));
  const height = await deps.blockHeight().catch(() => undefined);
  const now = (deps.now ?? Date.now)();
  records.forEach((rec, i) => {
    const status = statuses[i] ?? null;
    let verdict = verdictOf(status, height, rec.lastValid);
    if (verdict === 'unknown' && !status && now - rec.ts > maxAgeMs) verdict = 'failed';
    if (verdict === 'unknown') {
      report.kept.push(rec.signature);
      return;
    }
    // Re-read: another settlement (or the payment itself) may have taken it meanwhile.
    const taken = takePending(store, rec.signature);
    if (!taken) return;
    if (verdict === 'failed') {
      report.dropped.push(rec.signature);
      return;
    }
    report.delivered.push(rec.signature);
    try {
      deliver(taken);
    } catch (e) {
      console.error(`PEARL purchase ${rec.signature} was paid but its delivery threw`, rec, e);
    }
  });
  return report;
}

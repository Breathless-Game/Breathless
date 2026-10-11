/**
 * PEARL and session-SOL balances read through the market server (GET /api/market/balance), so the
 * title badge and the vault never load the Umi/Solana chunk just to show a number. No chain imports.
 *
 * Returns null when the server is older and has no such endpoint (404): the caller then reads the
 * chain directly, as before. That answer is remembered for a few minutes so a deploy window costs
 * one extra request, not one per read. Concurrent reads for the same wallet share one request.
 */
export interface Balances {
  /** Whole PEARL held by the owner (0 before the first sale). */
  pearl: number;
  /** The session wallet's SOL, or null when no session was asked about. */
  sessionSol: number | null;
  /** When the server read the chain (ms). */
  at: number;
}

const MISSING_RETRY_MS = 5 * 60_000;
let missingUntil = 0;
/** This page changed the balance itself (a burn, a program-mode sale): the next read skips the server's cache. */
let stale = false;
const inflight = new Map<string, Promise<Balances | null>>();

/** Call after this client burned or earned PEARL in a transaction the server did not send. */
export function markBalanceStale() {
  stale = true;
}

const offline = () =>
  new Error(import.meta.env?.DEV ? 'PEARL market is offline (run `npm run market`)' : 'PEARL market is offline, try again later');

async function request(owner: string, session: string | null, fresh: boolean): Promise<Balances | null> {
  const q = new URLSearchParams({ owner });
  if (session) q.set('session', session);
  if (fresh) q.set('fresh', '1');
  let res: Response;
  try {
    res = await fetch(`/api/market/balance?${q}`);
  } catch {
    throw offline();
  }
  const json = (await res.json().catch(() => null)) as
    | { pearl?: number | string; sessionSol?: number | null; at?: number; error?: string }
    | null;
  if (!json || typeof json !== 'object') throw offline(); // a proxy error page or index.html: no market
  if (res.status === 404) {
    missingUntil = Date.now() + MISSING_RETRY_MS;
    return null;
  }
  if (!res.ok) throw new Error(json.error ?? `PEARL market error ${res.status}`);
  const pearl = Number(json.pearl);
  if (!Number.isFinite(pearl)) throw new Error('PEARL market sent an unreadable balance');
  return { pearl, sessionSol: typeof json.sessionSol === 'number' ? json.sessionSol : null, at: json.at ?? Date.now() };
}

/** Balances from the market, or null when this server has no balance endpoint (read the chain instead). */
export function readBalances(owner: string, session: string | null): Promise<Balances | null> {
  if (Date.now() < missingUntil) return Promise.resolve(null);
  const fresh = stale;
  const key = `${owner}:${session ?? ''}:${fresh}`;
  const running = inflight.get(key);
  if (running) return running;
  stale = false;
  const p = request(owner, session, fresh)
    .catch((e) => {
      if (fresh) stale = true; // still owed a fresh read
      throw e;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

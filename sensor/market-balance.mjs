// GET /api/market/balance?owner=<pubkey>[&session=<pubkey>][&fresh=1]: the player's PEARL and
// session-wallet SOL in one read, so the game's title badge never has to load the Umi/Solana
// stack just to show a number. Read-only: one getMultipleAccounts call (owner's PEARL token
// account, session wallet, PEARL mint), cached per (owner, session) for a few seconds.
//
//   -> { pearl, raw, decimals, sessionSol, at }
//      pearl       whole PEARL (a number; a string only past Number.MAX_SAFE_INTEGER)
//      raw         the token account's u64 amount, as a string
//      decimals    the mint's decimals (PEARL is 0)
//      sessionSol  the session wallet's SOL, or null when no session was given
//      at          when the chain was read (ms), so a cached answer shows its age
//
// The server forgets an owner's entry after it pays them for a sale (invalidate). A client that
// changed its own balance (burn, program-mode sale) asks once with fresh=1, which does the same.

import { publicKey } from '@metaplex-foundation/umi';
import { HttpError, isAddress, singleFlight } from './market-rules.mjs';

export const BALANCE_TTL_MS = 8_000;
const MAX_ENTRIES = 5_000;

/** A base58 string that decodes to a 32-byte public key. */
export function isPubkey(s) {
  if (!isAddress(s)) return false;
  try {
    publicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** Validate the query. Throws HttpError(400). */
export function parseBalanceQuery(params) {
  const owner = params.get('owner');
  const session = params.get('session') || null;
  if (!isPubkey(owner)) throw new HttpError(400, 'owner must be a base58 public key');
  if (session !== null && !isPubkey(session)) throw new HttpError(400, 'session must be a base58 public key');
  return { owner, session, fresh: params.get('fresh') === '1' };
}

/** SPL token account (Token and Token-2022): amount is a u64 LE at byte 64. */
function tokenAmount(acc) {
  if (!acc?.exists || acc.data.length < 72) return 0n;
  return new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigUint64(64, true);
}

/** SPL mint: decimals is the u8 at byte 44. */
function mintDecimals(acc) {
  return acc?.exists && acc.data.length > 44 ? acc.data[44] : 0;
}

function lamportsOf(acc) {
  if (!acc?.exists) return 0n;
  const l = acc.lamports;
  return typeof l === 'bigint' ? l : BigInt(l?.basisPoints ?? 0);
}

function wholeTokens(raw, decimals) {
  const whole = raw / 10n ** BigInt(decimals);
  return whole <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(whole) : whole.toString();
}

/**
 * deps:
 *   getAccounts(addresses: string[]) -> [{ exists, data: Uint8Array, lamports }]  (one RPC call)
 *   ataOf(owner, mint, tokenProgram) -> string   the owner's associated token account
 *   mintInfo() -> { pearlMint: string | null, tokenProgram: string }
 */
export function createBalanceReader({ getAccounts, ataOf, mintInfo, ttlMs = BALANCE_TTL_MS, now = Date.now, maxEntries = MAX_ENTRIES }) {
  const cache = new Map(); // "owner:session" -> { at, value }
  // owner -> { gen, reads }, only while a read for that owner is in flight: invalidate bumps gen so
  // those reads don't store their (older) answer. Nothing in flight, nothing to guard: no entry, so
  // invalidating any number of owners keeps nothing.
  const reading = new Map();
  const flights = new Map();

  const keyOf = (owner, session) => `${owner}:${session ?? ''}`;

  async function readChain(owner, session) {
    const { pearlMint, tokenProgram } = await mintInfo();
    const addrs = [];
    if (pearlMint) addrs.push(ataOf(owner, pearlMint, tokenProgram), pearlMint);
    if (session) addrs.push(session);
    const accs = addrs.length ? await getAccounts(addrs) : [];
    const raw = pearlMint ? tokenAmount(accs[0]) : 0n;
    const decimals = pearlMint ? mintDecimals(accs[1]) : 0;
    const sessionSol = session ? Number(lamportsOf(accs[pearlMint ? 2 : 0])) / 1e9 : null;
    return { pearl: wholeTokens(raw, decimals), raw: raw.toString(), decimals, sessionSol, at: now() };
  }

  function store(key, value) {
    cache.set(key, { at: now(), value });
    if (cache.size <= maxEntries) return;
    const t = now();
    for (const [k, e] of cache) if (t - e.at >= ttlMs) cache.delete(k);
    for (const k of cache.keys()) {
      if (cache.size <= maxEntries) break;
      cache.delete(k); // oldest first (insertion order)
    }
  }

  /** Forget everything cached for this owner; reads already in flight will not store their (older) answer. */
  function invalidate(owner) {
    if (!owner) return;
    const r = reading.get(owner);
    if (r) r.gen += 1;
    for (const k of cache.keys()) if (k.startsWith(`${owner}:`)) cache.delete(k);
  }

  async function read({ owner, session = null, fresh = false }) {
    if (fresh) invalidate(owner);
    const key = keyOf(owner, session);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    let r = reading.get(owner);
    if (!r) reading.set(owner, (r = { gen: 0, reads: 0 }));
    r.reads += 1; // now, not inside the flight: an invalidate right after this call must see it
    const gen = r.gen;
    return singleFlight(flights, `${key}:${gen}`, async () => {
      const value = await readChain(owner, session);
      if (r.gen === gen) store(key, value);
      return value;
    }).finally(() => {
      if (--r.reads === 0) reading.delete(owner);
    });
  }

  // pending: owners with a read in flight (the only ones whose generation is kept).
  return { read, invalidate, size: () => cache.size, pending: () => reading.size };
}

// The market's Solana RPC, made safe to share: every call goes through one concurrency limiter,
// a 429 pauses every caller with exponential backoff, and confirmations are polled over HTTP
// (one batched getSignatureStatuses per tick for every transaction being waited on) instead of
// web3.js's confirmTransaction.
//
// Why not confirmTransaction: web3.js 1.x starts a fire-and-forget getSignatureStatus inside
// getTransactionConfirmationPromise (lib/index.cjs.js, `const response = await
// this.getSignatureStatus(signature)` in an un-awaited async IIFE). When that call fails (a 429
// from the public devnet RPC after its own retries) the rejection has no handler, and Node
// exits: on 2026-10-11 one bulk sell took the whole server (every game and camera session)
// down three times. It also opens a signatureSubscribe websocket per confirmation, which the
// public RPC rate-limits too. Polling avoids both.
//
//   umi.use({ install(umi) { umi.rpc = guardRpc(umi.rpc, { limit: 3 }) } })
//
// Pure apart from the timers it is given, so rpc-guard.test.mjs drives it with fakes.

import { base58 } from '@metaplex-foundation/umi/serializers';

/** RPC calls the market has in flight at once (SOLANA_RPC_CONCURRENCY overrides). */
export const RPC_CONCURRENCY = 3;
export const DEVNET = 'https://api.devnet.solana.com';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/** The RPC the server uses: SOLANA_RPC, else VITE_SOLANA_RPC, else public devnet. */
export function rpcEndpoint(env = process.env) {
  return (env.SOLANA_RPC || env.VITE_SOLANA_RPC || DEVNET).trim();
}

/** An RPC URL safe to log: a provider key may sit in the path or the query, so only the origin is shown. */
export function redactRpc(url) {
  try {
    const u = new URL(url);
    return (u.pathname.replace(/\/+$/, '') || u.search) ? `${u.origin}/…` : u.origin;
  } catch {
    return '(invalid RPC URL)';
  }
}

/** Walk an error and its causes. */
function* chain(e) {
  for (let x = e, depth = 0; x && depth < 5; x = x.cause, depth++) yield x;
}

/** The RPC answered 429 (web3.js: "429 Too Many Requests: ..."; some providers say "rate limit"). */
export function isRateLimited(e) {
  for (const x of chain(e)) {
    if (x?.status === 429 || x?.code === 429) return true;
    if (/\b429\b|too many requests|rate.?limit/i.test(String(x?.message ?? x))) return true;
  }
  return false;
}

/** Worth trying again later: rate limits, 5xx, timeouts and network failures. Not "account not found". */
export function isTransientRpcError(e) {
  if (isRateLimited(e)) return true;
  for (const x of chain(e)) {
    const msg = String(x?.message ?? x);
    if (/\b50[0-4]\b|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timed? ?out|aborted/i.test(msg)) return true;
  }
  return false;
}

/** At most `max` calls of run(fn) in flight; the rest wait in order. */
export function createLimiter(max) {
  if (!(max >= 1)) throw new Error(`createLimiter: max must be >= 1, got ${max}`);
  let active = 0;
  const queue = [];
  const acquire = () => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  };
  const release = () => {
    const next = queue.shift();
    if (next) next(); // the slot passes straight on
    else active--;
  };
  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
  };
}

/**
 * Retry fn on 429 only, with exponential backoff and jitter. A 429 anywhere pauses every call
 * made through this backoff (pausedUntil), so parallel callers stop hammering together.
 * Any other error is thrown at once: a send that failed for another reason must not be resent
 * blindly (market-payout.mjs decides that).
 */
export function createBackoff({ tries = 6, baseMs = 500, maxMs = 8_000, sleep = realSleep, now = Date.now, random = Math.random, onRateLimit = () => {} } = {}) {
  let pausedUntil = 0;
  return {
    async call(fn) {
      for (let attempt = 1; ; attempt++) {
        const wait = pausedUntil - now();
        if (wait > 0) await sleep(wait);
        try {
          return await fn();
        } catch (e) {
          if (!isRateLimited(e) || attempt >= tries) throw e;
          const delay = Math.round(Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.75 + random() * 0.5));
          pausedUntil = Math.max(pausedUntil, now() + delay);
          onRateLimit(delay, attempt, e);
        }
      }
    },
    get pausedUntil() {
      return pausedUntil;
    },
  };
}

const RANK = { processed: 0, confirmed: 1, finalized: 2 };
const reached = (have, want) => (RANK[have] ?? -1) >= (RANK[want] ?? 1);
const keyOf = (sig) => (typeof sig === 'string' ? sig : Buffer.from(sig).toString('hex'));

export class BlockheightExceededError extends Error {
  constructor() {
    super('Transaction expired: block height exceeded before it was confirmed');
    this.name = 'TransactionExpiredBlockheightExceededError';
  }
}

/**
 * Batched confirmation by polling. confirm(signature, { lastValidBlockHeight, commitment }) resolves
 * { context: { slot }, value: { err } } (umi's confirmTransaction shape) once the transaction reaches
 * `commitment`; rejects when its blockhash expired unconfirmed, or after timeoutMs. One loop serves
 * every waiter: per tick one getBlockHeight and one getSignatureStatuses for all of them.
 *
 * The height is read BEFORE the statuses: a transaction can only land in a block at or below its
 * lastValidBlockHeight, so if the chain was already past that before we looked and the lookup
 * finds nothing, it never landed.
 */
export function createConfirmer({ getSignatureStatuses, getBlockHeight, intervalMs = 1_500, timeoutMs = 90_000, sleep = realSleep, now = Date.now, log = () => {} }) {
  const waiting = new Set(); // { signature, key, lastValid, commitment, since, resolve, reject }
  let running = false;
  let lastErrorLog = 0;

  async function tick() {
    const entries = [...waiting];
    let height = null;
    let statuses = null;
    try {
      height = Number(await getBlockHeight());
    } catch (e) {
      noteError(e);
    }
    const sigs = new Map();
    for (const w of entries) if (!sigs.has(w.key)) sigs.set(w.key, w.signature);
    try {
      const list = [...sigs.values()];
      const got = await getSignatureStatuses(list);
      statuses = new Map([...sigs.keys()].map((k, i) => [k, got[i] ?? null]));
    } catch (e) {
      noteError(e);
    }
    const t = now();
    for (const w of entries) {
      const s = statuses?.get(w.key);
      if (s && reached(s.commitment, w.commitment)) {
        settle(w, () => w.resolve({ context: { slot: Number(s.slot ?? 0) }, value: { err: s.error ?? null } }));
      } else if (statuses && !s && Number.isFinite(height) && Number.isSafeInteger(w.lastValid) && height > w.lastValid) {
        settle(w, () => w.reject(new BlockheightExceededError()));
      } else if (t - w.since >= timeoutMs) {
        settle(w, () => w.reject(new Error(`Transaction confirmation timed out after ${Math.round(timeoutMs / 1000)}s`)));
      }
    }
  }

  function settle(w, fn) {
    waiting.delete(w);
    fn();
  }

  function noteError(e) {
    if (now() - lastErrorLog < 10_000) return;
    lastErrorLog = now();
    log(`[rpc] confirmation poll failed (will retry): ${firstLine(e)}`);
  }

  async function loop() {
    while (waiting.size) {
      await sleep(intervalMs);
      try {
        await tick();
      } catch (e) {
        noteError(e); // tick catches its own RPC errors; this is only a backstop
      }
    }
    running = false; // synchronously after the size check, so a new waiter can't be missed
  }

  function confirm(signature, { lastValidBlockHeight, commitment = 'confirmed' } = {}) {
    return new Promise((resolve, reject) => {
      waiting.add({ signature, key: keyOf(signature), lastValid: Number(lastValidBlockHeight), commitment, since: now(), resolve, reject });
      if (!running) {
        running = true;
        loop().catch((e) => {
          running = false;
          log(`[rpc] confirmation loop stopped: ${firstLine(e)}`);
        });
      }
    });
  }

  return { confirm, pending: () => waiting.size };
}

const SYNC_METHODS = new Set(['getEndpoint', 'getCluster']);

/**
 * Wrap umi's RpcInterface: every async method runs through one limiter and the 429 backoff
 * (each individual RPC call holds a slot only while it runs, so callers can nest freely);
 * confirmTransaction is replaced by the polling confirmer and airdrop by a request + the same
 * confirmer, so nothing on the server ever reaches web3.js's confirmTransaction.
 */
export function guardRpc(rpc, { limit = RPC_CONCURRENCY, log = console.log, sleep = realSleep, now = Date.now, random = Math.random, tries, baseMs, maxMs, confirmIntervalMs, confirmTimeoutMs } = {}) {
  const limiter = createLimiter(limit);
  let limited = 0;
  let lastLog = 0;
  const backoff = createBackoff({
    tries,
    baseMs,
    maxMs,
    sleep,
    now,
    random,
    onRateLimit(delay) {
      limited++;
      if (now() - lastLog < 10_000) return;
      lastLog = now();
      log(`[rpc] Solana RPC rate limit (429): pausing market RPC ${delay}ms (${limited} rate-limited call(s) so far)`);
    },
  });
  const wrap = (fn) => (...args) => limiter.run(() => backoff.call(() => fn(...args)));

  const out = {};
  for (const [name, value] of Object.entries(rpc)) {
    out[name] = typeof value === 'function' && !SYNC_METHODS.has(name) ? wrap(value.bind(rpc)) : value;
  }

  const confirmer = createConfirmer({
    getSignatureStatuses: (sigs) => out.getSignatureStatuses(sigs, { searchTransactionHistory: false }),
    getBlockHeight: () => out.call('getBlockHeight', [{ commitment: 'confirmed' }]),
    intervalMs: confirmIntervalMs,
    timeoutMs: confirmTimeoutMs,
    sleep,
    now,
    log,
  });

  out.confirmTransaction = (signature, options = {}) =>
    confirmer.confirm(signature, { lastValidBlockHeight: options.strategy?.lastValidBlockHeight, commitment: options.commitment ?? 'confirmed' });

  out.airdrop = async (publicKey, amount, options = {}) => {
    const blockhash = await out.getLatestBlockhash({ commitment: 'confirmed' });
    const sig = await out.call('requestAirdrop', [publicKey.toString(), Number(amount.basisPoints)]);
    await out.confirmTransaction(base58.serialize(sig), { commitment: options.commitment ?? 'confirmed', strategy: { type: 'blockhash', ...blockhash } });
  };

  Object.defineProperty(out, 'guard', { value: { limiter, backoff, confirmer, rateLimited: () => limited }, enumerable: false });
  return out;
}

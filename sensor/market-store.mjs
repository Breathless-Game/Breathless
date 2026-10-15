// Where server mode keeps its state, behind one interface with two backends:
//
//   file   The default, and the only one the long-running server (index.mjs, market-server.mjs)
//          uses. Exactly the files it always wrote, in the market dir (MARKET_DIR, default sensor/):
//            .market-keypair.json  the market wallet (Solana CLI format, mode 600; created if missing)
//            .market-state.json    the PEARL mint, the fish collection and the sold ledger
//            .market-serial.json   the fish number counter (nft-serial.mjs)
//            .market-fish.jsonl    the (owner, fish id) -> asset registry (fish-trust.mjs FishRegistry)
//          One process owns them, so the in-memory objects (SoldLedger, FishRegistry, the serial
//          counter) are the truth and every step is persisted before the next one starts.
//   redis  Upstash Redis over its REST API, for a serverless host (Vercel, api/index.mjs), where
//          several instances serve requests at once and nothing survives on local disk. Chosen
//          only when MARKET_STORE=redis, or when the Upstash credentials are in the environment
//          (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or Vercel's KV_REST_API_URL +
//          KV_REST_API_TOKEN; the UPSTASH_ pair wins, as in @upstash/redis's own fromEnv). The
//          market wallet then comes from MARKET_SECRET_KEY and is never generated or written.
//
// What keeps two instances from paying for one fish twice (each step is one atomic Redis command):
//   begin       SET sold:<asset> NX            one sale record per fish; the loser re-plans from it.
//               (CAS over a refunded record)   A fish sent back and handed over again replaces its
//                                              'refunded' record by compare-and-set instead
//   refunding   the same, for a fish the market sends back instead (market-sale.mjs): one record
//   payPending  SET paytx:<asset> NX           one payout in flight per fish; the loser gets a 409
//                                              before it sends anything. Never deleted except by
//   payDropped  CAS paytx:<asset> sig -> gone  (only the signature it names, only once it is known
//                                              never to land), so a stale "unpaid" can't pay again
//   paid/burned CAS sold:<asset> old -> new    compare-and-set on the record's exact JSON
//   refundPending / refundDropped / refunded   the same CAS: one refund signature on record per
//                                              fish, so only one instance sends the fish back
//   serial      one Lua script: HGET the owner+fish key, else INCR the counter and HSET it
//   unburned    ZSET of unfinished sales, paying, paid but not burned, or refunding (the sweep's work
//               list): ZADD at begin / refunding (before the SET NX, and again after it) and before
//               the 'paid' CAS, ZREM after the 'burned' or 'refunded' one, so a crash in between leaves
//               at most a stale entry, which the next listing checks against its record and drops
//   registry    HSET (owner/fish -> entry): a retried append writes the same mapping again
//
// The generic KV (store.kv) is for short-lived shared state such as sessions and throttles: an
// in-memory Map on the long-running server, Redis keys under <prefix>kv: on a serverless host.
//
//   kv.get(key)                               -> string | null
//   kv.set(key, value, { ttlMs?, nx? })        -> true, or false when nx and the key exists
//   kv.del(key)                               -> true when it existed
//   kv.cas(key, expected, next, { ttlMs? })    -> true when the value was `expected` (null: absent)
//                                                and is now `next` (null: deleted); else false
//   kv.incr(key, { ttlMs? })                   -> the new count; the TTL starts at the first incr
//
// Keys and values are strings (callers JSON-encode); a TTL is in milliseconds. Everything in Redis
// lives under MARKET_STORE_PREFIX (default "market:"), so a test deployment can share a database
// with nothing else, or use its own prefix (deploy/VERCEL.md).

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { HttpError, PAYOUT_WINDOW_MS, SoldLedger, isUnfinished, planFor, recordOver } from './market-rules.mjs';
import { FishRegistry, parseRegistry } from './fish-trust.mjs';
import { MAX_SERIAL } from './nft-serial.mjs';

export const STATE_FILE = '.market-state.json';
export const REGISTRY_FILE = '.market-fish.jsonl';
export const KEYPAIR_FILE = '.market-keypair.json';
export const DEFAULT_PREFIX = 'market:';

// ---- Selection ---------------------------------------------------------------------------------

/** The Upstash REST credentials in `env`, or null. UPSTASH_REDIS_REST_* first, then Vercel's KV_REST_API_*. */
export function redisCredentials(env = process.env) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: env.UPSTASH_REDIS_REST_URL.trim(), token: env.UPSTASH_REDIS_REST_TOKEN.trim() };
  }
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return { url: env.KV_REST_API_URL.trim(), token: env.KV_REST_API_TOKEN.trim() };
  return null;
}

/** 'file' or 'redis': MARKET_STORE when set, else redis exactly when the credentials are there. */
export function storeKind(env = process.env) {
  const asked = String(env.MARKET_STORE ?? '').trim().toLowerCase();
  if (asked === 'file' || asked === 'redis') return asked;
  if (asked) throw new Error(`MARKET_STORE must be "file" or "redis", not "${asked}"`);
  return redisCredentials(env) ? 'redis' : 'file';
}

/**
 * The market wallet's 64-byte secret key from MARKET_SECRET_KEY: a JSON byte array (the Solana CLI
 * keypair file's contents) or base58. Throws on anything else; the value is never echoed.
 */
export function parseSecretKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('MARKET_SECRET_KEY is not set: the Redis store never creates a market wallet (deploy/VERCEL.md)');
  let bytes;
  try {
    bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58.serialize(s);
  } catch {
    throw new Error('MARKET_SECRET_KEY is neither a JSON byte array nor base58');
  }
  if (bytes.length !== 64 || (s.startsWith('[') && !JSON.parse(s).every((b) => Number.isInteger(b) && b >= 0 && b <= 255))) {
    throw new Error(`MARKET_SECRET_KEY must be a 64-byte secret key (got ${bytes.length} bytes)`);
  }
  return bytes;
}

/**
 * The store. `kind` overrides the environment ('file' | 'redis'). File: `dir` is required. Redis:
 * `redis` injects a client (tests: test/fake-redis.mjs), else one is built from the credentials.
 */
export async function createStore({ kind, dir, env = process.env, redis, prefix = env.MARKET_STORE_PREFIX || DEFAULT_PREFIX, log = console.log } = {}) {
  kind ??= storeKind(env);
  if (kind === 'file') {
    // A serverless instance's disk is neither shared nor kept: a file ledger there could pay twice.
    if (env.VERCEL === '1') throw new Error('The file store cannot run on Vercel: connect Upstash Redis (deploy/VERCEL.md)');
    if (!dir) throw new Error('createStore: dir is required for the file store');
    return createFileStore({ dir });
  }
  if (kind !== 'redis') throw new Error(`Unknown store kind "${kind}"`);
  if (!redis) {
    const creds = redisCredentials(env);
    if (!creds) throw new Error('MARKET_STORE=redis, but neither UPSTASH_REDIS_REST_URL/_TOKEN nor KV_REST_API_URL/_TOKEN is set');
    const { Redis } = await import('@upstash/redis');
    // Raw strings in and out: the store does its own JSON, and CAS compares exact bytes.
    redis = new Redis({ url: creds.url, token: creds.token, automaticDeserialization: false });
  }
  log(`[market] store: Upstash Redis (prefix "${prefix}")`);
  return createRedisStore({ redis, prefix, env });
}

// ---- File backend --------------------------------------------------------------------------------

export function createFileStore({ dir }) {
  const kv = createMemoryKv();
  return {
    kind: 'file',
    dir,
    /** The market wallet: null here, market.mjs reads (or creates) <dir>/.market-keypair.json as always. */
    marketSecret: () => null,

    /** { state, ledger, save, refresh, adopt } exactly as server mode always kept them: one JSON file, tmp + rename. */
    async openMarketState({ cluster }) {
      const statePath = path.join(dir, STATE_FILE);
      const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { cluster, mint: null, sold: {} };
      state.sold ??= {};
      const save = () => {
        const tmp = `${statePath}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...state, sold: ledger.toJSON() }, null, 2));
        renameSync(tmp, statePath);
      };
      const ledger = new SoldLedger(state.sold, save);
      // One process: the object in memory is already the newest state.
      return { state, ledger, save, refresh: async () => {}, adopt: async () => {} };
    },

    /** The co-sign registry: the JSON-lines file, one appended line per co-signed mint or migration. */
    openRegistry() {
      const registryPath = path.join(dir, REGISTRY_FILE);
      return new FishRegistry(existsSync(registryPath) ? parseRegistry(readFileSync(registryPath, 'utf8')) : [], (e) =>
        appendFileSync(registryPath, `${JSON.stringify(e)}\n`, { mode: 0o600 }),
      );
    },

    /** null: nft-serial.mjs keeps its own file counter (<dir>/.market-serial.json). */
    openSerials: () => null,

    kv,
    lock: (name, ttlMs) => takeLock(kv, name, ttlMs),
  };
}

/** The KV in one process's memory (the long-running server). Same semantics as the Redis one. */
export function createMemoryKv({ now = () => Date.now() } = {}) {
  const map = new Map(); // key -> { value, expiresAt }
  const live = (key) => {
    const e = map.get(key);
    if (e && e.expiresAt <= now()) {
      map.delete(key);
      return null;
    }
    return e ?? null;
  };
  const put = (key, value, ttlMs) => map.set(key, { value: String(value), expiresAt: ttlMs ? now() + ttlMs : Infinity });
  let ops = 0;
  const sweep = () => {
    if (++ops % 1000) return;
    for (const k of map.keys()) live(k);
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, { ttlMs, nx = false } = {}) {
      sweep();
      if (nx && live(key)) return false;
      put(key, value, ttlMs);
      return true;
    },
    async del(key) {
      return Boolean(live(key)) && map.delete(key);
    },
    async cas(key, expected, next, { ttlMs } = {}) {
      const cur = live(key)?.value ?? null;
      if (cur !== (expected === null ? null : String(expected))) return false;
      if (next === null) map.delete(key);
      else put(key, next, ttlMs);
      return true;
    },
    async incr(key, { ttlMs } = {}) {
      sweep();
      const e = live(key);
      const n = (e ? Number(e.value) : 0) + 1;
      if (e) e.value = String(n);
      else put(key, n, ttlMs);
      return n;
    },
  };
}

/** A lock: `release` when held, null when someone else holds it. It frees itself after ttlMs. */
async function takeLock(kv, name, ttlMs) {
  const token = randomBytes(12).toString('hex');
  if (!(await kv.set(`lock:${name}`, token, { nx: true, ttlMs }))) return null;
  return () => kv.cas(`lock:${name}`, token, null);
}

// ---- Redis backend -------------------------------------------------------------------------------
// The client is @upstash/redis (automaticDeserialization off) or anything with the same methods:
// get, set(k, v, { nx, px }), del, mget, hget, hset, zadd(k, ...{ score, member }), zrem(k, ...members),
// zrange(k, min, max, { byScore }) and by rank zrange(k, start, stop), scan(cursor, { match, count }), eval.
// The scripts below are the only Lua; test/fake-redis.mjs runs a JS twin of each, keyed by its text.

/** Compare-and-set one string key. ARGV: hasExpected, expected, hasNext, next, ttlMs ('' for none). */
export const CAS_SCRIPT = `local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if cur ~= ARGV[2] then return 0 end
elseif cur then
  return 0
end
if ARGV[3] == '1' then
  if ARGV[5] ~= '' then redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5]) else redis.call('SET', KEYS[1], ARGV[4]) end
else
  redis.call('DEL', KEYS[1])
end
return 1`;

/** INCR with a TTL set on the first increment. ARGV: ttlMs ('' for none). */
export const INCR_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 and ARGV[1] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * The fish number for one owner + fish: the one it already has, else the next (INCR), recorded in
 * the same step, so a retry or a race for the same key never gets a second number and the counter
 * has no gaps. KEYS: keys hash, counter. ARGV: "<owner>/<id>", MAX_SERIAL. -1 when exhausted.
 */
export const SERIAL_SCRIPT = `local hit = redis.call('HGET', KEYS[1], ARGV[1])
if hit then return tonumber(hit) end
local last = tonumber(redis.call('GET', KEYS[2]) or '0')
if last >= tonumber(ARGV[2]) then return -1 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], ARGV[1], n)
return n`;

/** Redis key names under `prefix`; the import script (scripts/import-to-redis.mjs) writes the same. */
export function redisKeys(prefix = DEFAULT_PREFIX) {
  return {
    state: `${prefix}state`,
    sold: (assetId) => `${prefix}sold:${assetId}`,
    payTx: (assetId) => `${prefix}paytx:${assetId}`,
    seller: (seller) => `${prefix}seller:${seller}`,
    fish: `${prefix}fish`,
    serialLast: `${prefix}serial:last`,
    serialKeys: `${prefix}serial:keys`,
    unburned: `${prefix}unburned`,
    // v2: the index holds paying sales too; a database backfilled when it held paid ones only is backfilled again.
    unburnedReady: `${prefix}unburned:ready:v2`,
    kv: (key) => `${prefix}kv:${key}`,
  };
}

/** CAS_SCRIPT on one key: true when it was `expected` (null: absent) and is now `next` (null: deleted). */
export function redisCas(redis, key, expected, next, ttlMs) {
  return redis
    .eval(CAS_SCRIPT, [key], [expected === null ? '0' : '1', expected ?? '', next === null ? '0' : '1', next ?? '', ttlMs ? String(Math.ceil(ttlMs)) : ''])
    .then((r) => Number(r) === 1);
}

export function createRedisKv(redis, prefix = DEFAULT_PREFIX) {
  const k = redisKeys(prefix).kv;
  return {
    async get(key) {
      const v = await redis.get(k(key));
      return v === null || v === undefined ? null : String(v);
    },
    async set(key, value, { ttlMs, nx = false } = {}) {
      const opts = {};
      if (ttlMs) opts.px = Math.ceil(ttlMs);
      if (nx) opts.nx = true;
      return (await redis.set(k(key), String(value), opts)) !== null;
    },
    async del(key) {
      return Number(await redis.del(k(key))) > 0;
    },
    cas: (key, expected, next, { ttlMs } = {}) =>
      redisCas(redis, k(key), expected === null ? null : String(expected), next === null ? null : String(next), ttlMs),
    async incr(key, { ttlMs } = {}) {
      return Number(await redis.eval(INCR_SCRIPT, [k(key)], [ttlMs ? String(Math.ceil(ttlMs)) : '']));
    },
  };
}

const parse = (s) => (s === null || s === undefined ? null : JSON.parse(s));
/** CAS retries when another instance changed a record between our read and our write. */
const CAS_TRIES = 8;
/** SCAN page size for the one-time backfill of the unburned index. */
const BACKFILL_SCAN_COUNT = 1000;


/**
 * Server mode's sold ledger in Redis, with SoldLedger's steps (market-rules.mjs), all async. The
 * record is one JSON string per fish; a payout in flight is its own key (see the top of this file).
 * `records` is a read-only snapshot for the daily cap: loadSeller(seller) fills in that seller's
 * last 24 h before each price check. loadAssets(ids) reads some fish's records at once (the export).
 * unburned(limit) is the sweep's work list, from the `unburned` index (see the top of this file).
 */
export class RedisLedger {
  constructor(redis, prefix = DEFAULT_PREFIX, { now = () => Date.now(), windowMs = PAYOUT_WINDOW_MS } = {}) {
    this.redis = redis;
    this.keys = redisKeys(prefix);
    this.now = now;
    this.windowMs = windowMs;
    this.bySeller = new Map(); // seller -> { at, records: { assetId: record } }
    this.indexed = false; // the unburned index is known to be backfilled
  }

  /** The record with its payout in flight merged in, as SoldLedger keeps it; null if never sold. */
  async get(assetId) {
    const [rec, pay] = await this.redis.mget(this.keys.sold(assetId), this.keys.payTx(assetId));
    return merge(parse(rec), parse(pay));
  }

  /** SoldLedger.plan on a fresh read: new | resume | burn | done | conflict | refund | refunded. */
  async plan(assetId, seller, transferTx) {
    return planFor(await this.get(assetId), seller, transferTx);
  }

  /** true when this call created the record, false when another instance already had (SET NX, or the CAS below). */
  async begin(assetId, { seller, transferTx, pearls }, now = this.now()) {
    // Index first: an entry whose record never got written (or is another seller's) is skipped on read.
    await this.redis.zadd(this.keys.seller(seller), { score: now, member: assetId });
    return this.#create(assetId, { seller, transferTx, pearls, status: 'paying', at: now }, now);
  }

  /**
   * SoldLedger.refunding: true when this call recorded the refund, false when another instance
   * recorded something first. Not in the seller's index: a refund is no payment, so the daily cap
   * never needs to read it.
   */
  async refunding(assetId, { seller, transferTx, reason, retryAt }, now = this.now()) {
    return this.#create(assetId, { seller, transferTx, status: 'refunding', reason, retryAt, at: now }, now);
  }

  /**
   * Write a fish's first record (SET NX), or replace a refunded one (CAS on its exact JSON: a fish
   * handed over again after it was sent back, recordOver). false when another instance was first,
   * or the record there must stay.
   */
  async #create(assetId, rec, now) {
    // On the sweep's work list from the start, so a sale stuck in 'paying' (or a fish stuck on its
    // way back) is found and resumed.
    const entry = { score: now, member: assetId };
    await this.redis.zadd(this.keys.unburned, entry);
    const key = this.keys.sold(assetId);
    if ((await this.redis.set(key, JSON.stringify(rec), { nx: true })) === null) {
      const cur = await this.redis.get(key);
      const next = cur === null || cur === undefined ? null : recordOver(JSON.parse(cur), rec);
      if (!next || !(await redisCas(this.redis, key, String(cur), JSON.stringify(next)))) return false;
    }
    // Again now that the record exists: a listing between the first ZADD and the SET saw no record
    // (or a refunded one) and may have dropped the entry as stale.
    await this.redis.zadd(this.keys.unburned, entry);
    return true;
  }

  /** Persist the pay tx before sending it. Another instance's payout already in flight: 409, send nothing. */
  async payPending(assetId, payTx, payLastValid) {
    const key = this.keys.payTx(assetId);
    if ((await this.redis.set(key, JSON.stringify({ payTx, payLastValid }), { nx: true })) !== null) return;
    if (parse(await this.redis.get(key))?.payTx === payTx) return; // our own, written by an earlier try
    throw new HttpError(409, 'Payment is still confirming, retry in a few seconds');
  }

  /** The pay tx `payTx` is known not to have landed: forget it (only that one), so it can be paid again. */
  async payDropped(assetId, payTx) {
    const key = this.keys.payTx(assetId);
    const cur = await this.redis.get(key);
    if (cur === null || cur === undefined) return;
    if (payTx !== undefined && parse(cur).payTx !== payTx) return; // someone else's newer payout
    await redisCas(this.redis, key, String(cur), null);
  }

  async paid(assetId) {
    let at;
    let unfinished = false;
    await this.#update(assetId, (r, pay) => {
      at = r.at;
      unfinished = r.status === 'paying' || isUnfinished(r);
      if (r.status !== 'paying') return null; // already paid (or burned) by another instance
      const next = { ...r, status: 'paid' };
      if (pay?.payTx !== undefined) next.payTx = pay.payTx;
      delete next.payLastValid;
      return next;
    });
    // On the sweep's work list until burned. begin() indexed it already; this puts back an entry a
    // sale begun before the index held paying sales never had. Scored by the sale's time, as begin,
    // the backfill and the import do, so the list stays oldest sale first.
    if (unfinished) await this.redis.zadd(this.keys.unburned, { score: Number(at) || this.now(), member: assetId });
  }

  async burned(assetId, burnTx) {
    await this.#update(assetId, (r, pay) => {
      const next = { ...merge(r, pay), status: 'burned', burnTx };
      return JSON.stringify(next) === JSON.stringify(merge(r, pay)) ? null : next;
    });
    await this.redis.zrem(this.keys.unburned, assetId);
  }

  /**
   * SoldLedger.refundPending: the refund's signature onto the record (CAS) before it is sent. The
   * CAS lets only one instance's refund on record: another one there already is a 409, send nothing.
   */
  async refundPending(assetId, refundTx, refundLastValid) {
    await this.#update(assetId, (r) => {
      if (r.status !== 'refunding') throw new HttpError(409, 'This fish is not being returned');
      if (r.refundTx === refundTx) return null; // our own, written by an earlier try
      if (r.refundTx !== undefined) throw new HttpError(409, 'This fish is already on its way back, retry in a minute');
      return { ...r, refundTx, refundLastValid };
    });
  }

  /** SoldLedger.refundDropped: forget the refund `refundTx` (only that one) once it is known never to land. */
  async refundDropped(assetId, refundTx) {
    await this.#update(assetId, (r) => {
      if (r.status !== 'refunding' || r.refundTx === undefined || (refundTx !== undefined && r.refundTx !== refundTx)) return null;
      const next = { ...r };
      delete next.refundTx;
      delete next.refundLastValid;
      return next;
    });
  }

  /** SoldLedger.refunded: finished, and off the work list. */
  async refunded(assetId) {
    await this.#update(assetId, (r) => {
      if (r.status !== 'refunding') return null; // already marked by another instance
      const next = { ...r, status: 'refunded' };
      delete next.refundLastValid;
      return next;
    });
    await this.redis.zrem(this.keys.unburned, assetId);
    // Handed over and begun again between the CAS and the ZREM: put its entry back.
    const rec = parse(await this.redis.get(this.keys.sold(assetId)));
    if (isUnfinished(rec)) await this.redis.zadd(this.keys.unburned, { score: Number(rec.at) || this.now(), member: assetId });
  }

  /** SoldLedger.skipBurn: a paid fish the sweep must not burn, recorded and taken off the work list. */
  async skipBurn(assetId, reason) {
    await this.#update(assetId, (r) => (r.burnSkipped === String(reason) ? null : { ...r, burnSkipped: String(reason) }));
    await this.redis.zrem(this.keys.unburned, assetId);
  }

  /**
   * SoldLedger.unburned: up to `limit` unfinished sales (paying, paid and not burned, or refunding),
   * oldest first. Two commands
   * (ZRANGE, MGET; ZRANGE alone when there is nothing to do), plus a ZREM when stale entries are
   * dropped. The first call on a database without the index backfills it once (#ensureIndex).
   */
  async unburned(limit = 100) {
    await this.#ensureIndex();
    const n = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 100;
    const ids = (await this.redis.zrange(this.keys.unburned, 0, n - 1)).map(String);
    if (!ids.length) return [];
    const recs = await this.redis.mget(...ids.map((id) => this.keys.sold(id)));
    const live = [];
    const stale = [];
    ids.forEach((id, i) => (isUnfinished(parse(recs[i])) ? live : stale).push(id));
    if (stale.length) await this.redis.zrem(this.keys.unburned, ...stale);
    return live;
  }

  /**
   * The unburned index, built once from the records written before it existed: SCAN sold:*, MGET
   * them, ZADD the unfinished ones (isUnfinished; refunds are newer than v2, so a v2 index already
   * holds every one), then SET the ready marker (only after a full pass, so a failed
   * backfill runs again). Idempotent, so two instances doing it at once is harmless; the sweep
   * lock makes that rare anyway. Later calls on this instance cost nothing, on a new instance one GET.
   */
  async #ensureIndex() {
    if (this.indexed) return;
    if (await this.redis.get(this.keys.unburnedReady)) {
      this.indexed = true;
      return;
    }
    const soldPrefix = this.keys.sold('');
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, { match: `${soldPrefix}*`, count: BACKFILL_SCAN_COUNT });
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const vals = await this.redis.mget(...chunk);
        const add = [];
        chunk.forEach((k, j) => {
          const r = parse(vals[j]);
          if (isUnfinished(r)) add.push({ score: Number(r.at) || 0, member: String(k).slice(soldPrefix.length) });
        });
        if (add.length) await this.redis.zadd(this.keys.unburned, ...add);
      }
      cursor = String(next);
    } while (cursor !== '0');
    await this.redis.set(this.keys.unburnedReady, String(this.now()));
    this.indexed = true;
  }

  async result(assetId) {
    const r = await this.get(assetId);
    return { pearls: r.pearls, tx: r.payTx ?? '', extra: [r.transferTx, r.burnTx ?? ''] };
  }

  /** Read `seller`'s sales of the last 24 h into `records` (the cap counts nothing older). */
  async loadSeller(seller) {
    const now = this.now();
    const ids = await this.redis.zrange(this.keys.seller(seller), now - this.windowMs, '+inf', { byScore: true });
    const recs = ids.length ? await this.redis.mget(...ids.map((id) => this.keys.sold(id))) : [];
    const records = {};
    ids.forEach((id, i) => {
      const r = parse(recs[i]);
      if (r) records[id] = r;
    });
    this.bySeller.set(seller, { at: now, records });
    for (const [s, e] of this.bySeller) if (now - e.at > 60_000) this.bySeller.delete(s);
  }

  /** The snapshot checkPayoutCap reads: every loaded seller's recent records. */
  get records() {
    const out = {};
    for (const { records } of this.bySeller.values()) Object.assign(out, records);
    return out;
  }

  /** { get(id) } over these fish's records, for the sweep's synchronous pickStranded. */
  async loadAssets(ids) {
    const map = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const vals = await this.redis.mget(...chunk.flatMap((id) => [this.keys.sold(id), this.keys.payTx(id)]));
      chunk.forEach((id, j) => {
        const r = merge(parse(vals[2 * j]), parse(vals[2 * j + 1]));
        if (r) map.set(id, r);
      });
    }
    return { get: (id) => map.get(id) ?? null };
  }

  /** Read, change, compare-and-set; again if another instance wrote in between. `fn` -> next or null (no change). */
  async #update(assetId, fn) {
    const key = this.keys.sold(assetId);
    for (let i = 0; i < CAS_TRIES; i++) {
      const [cur, pay] = await this.redis.mget(key, this.keys.payTx(assetId));
      if (cur === null || cur === undefined) throw new Error(`Asset ${assetId} is not in the ledger`);
      const next = fn(JSON.parse(cur), parse(pay));
      if (!next) return;
      if (await redisCas(this.redis, key, String(cur), JSON.stringify(next))) return;
    }
    throw new HttpError(503, 'The sale ledger is busy, retry in a few seconds');
  }
}

/** SoldLedger's shape: a payout in flight shows as payTx/payLastValid while the record is 'paying'. */
function merge(rec, pay) {
  if (!rec) return null;
  return rec.status === 'paying' && pay ? { ...rec, payTx: pay.payTx, payLastValid: pay.payLastValid } : rec;
}

/** FishRegistry (fish-trust.mjs) in one Redis hash, async. */
export class RedisRegistry {
  constructor(redis, prefix = DEFAULT_PREFIX) {
    this.redis = redis;
    this.key = redisKeys(prefix).fish;
  }

  async get(owner, fishId) {
    return parse(await this.redis.hget(this.key, FishRegistry.key(owner, fishId)));
  }

  /** Overwrites, like a later line in the file: a retried co-sign records the same mapping again. */
  async set(owner, fishId, { asset, lastValid = null, kind }, now = Date.now()) {
    const e = { k: FishRegistry.key(owner, fishId), asset, lastValid, kind, at: now };
    await this.redis.hset(this.key, { [e.k]: JSON.stringify(e) });
    return e;
  }
}

/** The fish number counter (nft-serial.mjs createSerialCounter) in Redis: peek and assign, async. */
export function createRedisSerials(redis, prefix = DEFAULT_PREFIX) {
  const keys = redisKeys(prefix);
  return {
    async peek(owner, id) {
      const v = await redis.hget(keys.serialKeys, `${owner}/${id}`);
      return v === null || v === undefined ? undefined : Number(v);
    },
    async assign(owner, id) {
      const n = Number(await redis.eval(SERIAL_SCRIPT, [keys.serialKeys, keys.serialLast], [`${owner}/${id}`, String(MAX_SERIAL)]));
      if (n === -1) throw new HttpError(503, 'Fish numbers are exhausted');
      if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(503, 'Could not get a fish number');
      return n;
    },
  };
}

/** Market state fields set once and never replaced: two instances racing keep the first one saved. */
const WRITE_ONCE = ['mint', 'fishCollection', 'fishCollectionSlot'];
/** Equal as stored state: an absent field and null are the same. */
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createRedisStore({ redis, prefix = DEFAULT_PREFIX, env = process.env }) {
  const keys = redisKeys(prefix);
  const kv = createRedisKv(redis, prefix);
  return {
    kind: 'redis',
    prefix,
    redis,
    /** The market wallet from MARKET_SECRET_KEY (throws if it is missing or malformed). */
    marketSecret: () => parseSecretKey(env.MARKET_SECRET_KEY),

    /**
     * { state, ledger, save, refresh, adopt }: the PEARL mint and fish collection (one JSON key, no
     * sold set: that is RedisLedger). Several instances write it, so save() never writes the whole
     * object: it compare-and-sets only the fields this instance changed since it last read Redis
     * (`base`) onto whatever Redis holds now. A field another instance changed meanwhile stays
     * theirs: a delete only removes the value this instance knew, and a set write-once field
     * (WRITE_ONCE: the mint, the collection) is never replaced; its winner is copied into `state`.
     * refresh() replaces `state` with Redis's copy: only under the setup lock (market-server-mode.mjs),
     * where no save of this instance is in flight. adopt() is the lock-free read: it only copies a
     * write-once field another instance created into `state`, and never deletes anything.
     */
    async openMarketState({ cluster }) {
      const read = async () => {
        const raw = await redis.get(keys.state);
        const obj = parse(raw) ?? {};
        delete obj.sold;
        return { raw: raw === null || raw === undefined ? null : String(raw), obj };
      };
      let { obj: base } = await read();
      const state = Object.keys(base).length ? structuredClone(base) : { cluster, mint: null };
      const save = async () => {
        for (let i = 0; i < CAS_TRIES; i++) {
          const { raw, obj: cur } = await read();
          const next = { ...cur };
          const theirs = []; // changed here, but another instance's value stays
          for (const k of new Set([...Object.keys(state), ...Object.keys(base)])) {
            if (k === 'sold' || same(state[k], base[k])) continue; // not changed here
            if (WRITE_ONCE.includes(k) && cur[k] != null && !same(cur[k], state[k])) theirs.push(k); // first writer wins
            else if (state[k] !== undefined) next[k] = state[k];
            else if (same(cur[k], base[k])) delete next[k];
            else theirs.push(k);
          }
          const text = JSON.stringify(next);
          if (await redisCas(redis, keys.state, raw, text)) {
            base = JSON.parse(text);
            // Take what stayed theirs into `state` too, so a later save doesn't see it as ours to change.
            for (const k of theirs) state[k] = structuredClone(next[k]);
            for (const k of WRITE_ONCE) if (next[k] != null) state[k] = next[k];
            return;
          }
        }
        throw new HttpError(503, 'The market state is busy, retry in a few seconds');
      };
      const refresh = async () => {
        const { obj: fresh } = await read();
        if (!Object.keys(fresh).length) return; // nothing saved yet
        for (const k of Object.keys(state)) if (!(k in fresh)) delete state[k];
        Object.assign(state, structuredClone(fresh));
        base = fresh;
      };
      const adopt = async () => {
        const { obj: fresh } = await read();
        for (const k of WRITE_ONCE) if (state[k] == null && fresh[k] != null) state[k] = base[k] = fresh[k];
      };
      return { state, ledger: new RedisLedger(redis, prefix), save, refresh, adopt };
    },

    openRegistry: () => new RedisRegistry(redis, prefix),
    openSerials: () => createRedisSerials(redis, prefix),
    kv,
    lock: (name, ttlMs) => takeLock(kv, name, ttlMs),
  };
}

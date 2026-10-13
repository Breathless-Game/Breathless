// Fish numbers: every minted fish NFT gets a global, sequential serial (#0001, #0042, #10000, …),
// handed out here before the game mints it. The game puts it in the on-chain name and the metadata
// URI (game/src/nft-uri.ts), so wallets show "Lively Striped Wrasse #0042".
//
//   POST /api/nft/serial   { id: <fish id, hex>, owner: <Phantom address> }  ->  { serial }
//
// The same owner + fish always gets the same number, so a retried mint (or a repair of an already
// minted fish) never burns a second one. The counter lives in <MARKET_DIR>/.market-serial.json,
// which is kept like the market's other state (.market-*): a redeploy must never reset it. Writes
// go to a temp file and are renamed into place, and a number is only answered once it is on disk:
// a crash or restart can never hand the same number out twice. An unreadable file fails closed
// (503) rather than starting again from 1. On Vercel the counter is in Redis
// instead (market-store.mjs createRedisSerials, one INCR in a Lua script), passed in as `counter`.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { HttpError, RateLimiter, isAddress } from './market-rules.mjs';

export const SERIAL_FILE = '.market-serial.json';
export const SERIAL_PATH = '/api/nft/serial';
/** Nine digits: #999999999. Matches the parsers in nft-meta.mjs and game/src/nft-uri.ts. */
export const MAX_SERIAL = 999_999_999;
/** How many owner + fish keys are remembered for idempotency (oldest dropped first). */
const MAX_KEYS = 20_000;
const BODY_LIMIT = 1024;

const isFishId = (s) => typeof s === 'string' && /^[0-9a-f]{1,16}$/.test(s);

/**
 * The counter itself, backed by `file`. Synchronous on purpose: Node runs one request handler at a
 * time, so assignments are serialised in-process without a lock.
 */
export function createSerialCounter(file) {
  let last = 0;
  const keys = new Map(); // "<owner>/<id>" -> serial, oldest first
  if (existsSync(file)) {
    // Throws on a corrupt file: better no numbers than duplicate numbers.
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || !Number.isSafeInteger(saved.last) || saved.last < 0) {
      throw new Error(`${file} is not a fish number counter`);
    }
    last = saved.last;
    for (const [k, v] of Object.entries(saved.keys ?? {})) {
      if (Number.isSafeInteger(v) && v > 0) {
        keys.set(k, v);
        last = Math.max(last, v);
      }
    }
  }

  function persist() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ last, keys: Object.fromEntries(keys) }));
    renameSync(tmp, file);
  }

  return {
    get last() {
      return last;
    },
    /** The number already given to this owner's fish, if any. */
    peek: (owner, id) => keys.get(`${owner}/${id}`),
    /** This owner's fish's number, assigning (and saving) the next one if it has none. */
    assign(owner, id) {
      const key = `${owner}/${id}`;
      const hit = keys.get(key);
      if (hit) return hit;
      if (last >= MAX_SERIAL) throw new HttpError(503, 'Fish numbers are exhausted');
      const serial = last + 1;
      keys.set(key, serial);
      let evicted;
      if (keys.size > MAX_KEYS) {
        evicted = keys.entries().next().value;
        keys.delete(evicted[0]);
      }
      last = serial;
      try {
        persist();
      } catch (e) {
        // Not on disk, so not handed out: roll back and let the game retry.
        last = serial - 1;
        keys.delete(key);
        if (evicted) keys.set(evicted[0], evicted[1]);
        throw new HttpError(503, `Could not save the fish number: ${e?.code ?? e?.message ?? e}`);
      }
      return serial;
    },
  };
}

/**
 * Mount on an http server before the NFT metadata handler (which answers every other /api/nft/
 * path): `if (await serials(req, res)) return;`. Returns false for anything but /api/nft/serial.
 * The counter loads on first use, so a bad file only takes this route down, never the server.
 * `counter` ({ peek, assign }, may be async) replaces the file: the Redis store's.
 */
export function createSerialHandler({ file, counter = null, clientIp = (req) => req.socket?.remoteAddress ?? '?', log = console.log, limit = 30 } = {}) {
  if (!file && !counter) throw new Error('createSerialHandler: file (or counter) is required');
  let loadError = null;
  // Only new numbers count: a returning player's repair asks again for fish it already numbered.
  const limiter = new RateLimiter({ limit, windowMs: 60_000 });

  function load() {
    if (counter || loadError) return counter;
    try {
      counter = createSerialCounter(file);
    } catch (e) {
      loadError = e;
      log(`[nft] fish number counter unavailable, ${SERIAL_PATH} answers 503 until it is fixed: ${e?.message ?? e}`);
    }
    return counter;
  }

  function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size <= BODY_LIMIT) parts.push(c);
        else req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'));
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      // Destroyed past the limit, or the client went away: settle either way (a no-op after 'end').
      req.on('close', () => reject(new HttpError(413, 'Body too large')));
      req.on('error', () => reject(new HttpError(413, 'Body too large')));
    });
  }

  return async function handle(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return false;
    }
    if (pathname !== SERIAL_PATH) return false;
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'Method not allowed');
      }
      const body = await readJson(req);
      const id = body?.id;
      const owner = body?.owner;
      if (!isFishId(id)) throw new HttpError(400, 'id must be the fish id (hex)');
      if (typeof owner !== 'string' || !isAddress(owner)) throw new HttpError(400, 'owner must be a Solana address');
      const c = load();
      if (!c) throw new HttpError(503, 'Fish numbers are unavailable on this server');
      if (!(await c.peek(owner, id)) && !limiter.allow(clientIp(req))) throw new HttpError(429, 'Too many new fish numbers, slow down');
      send(res, 200, { serial: await c.assign(owner, id) });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log(`[nft] ${SERIAL_PATH} failed: ${e?.message ?? e}`);
      if (status === 429) res.setHeader('Retry-After', '30');
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : 'Internal error' });
      else res.end();
    }
    return true;
  };
}

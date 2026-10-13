// The desktop app's wallet relay: /api/link. Browser wallet extensions (Phantom, Solflare, ...)
// don't exist inside the Electron app (desktop/), so it asks the player's normal browser instead:
//
//   1. the app (the game page inside Electron)   POST /api/link {kind, payload}
//        -> {sid, appToken, pageToken, matchCode, expiresAt}
//   2. the app opens https://<site>/link.html?sid=<sid>#t=<pageToken> in the system browser
//   3. the link page                             GET  /api/link/<sid>          (X-Link-Token: pageToken)
//        shows the match code, connects a wallet, decodes and signs, then
//                                                POST /api/link/<sid>/result   (X-Link-Token)
//                                             or POST /api/link/<sid>/cancel   (X-Link-Token)
//   4. the app polls every ~1.5 s                GET  /api/link/<sid>/result   (Authorization: Bearer appToken)
//        202 {status:'pending'} / 200 {status:'done', result} / 200 {status:'cancelled'}; the
//        session is deleted once the app has its answer. The app gives up with DELETE /api/link/<sid>.
//
// The server only passes things through: the app verifies every signature itself (the login's
// signMessage, each transaction byte for byte except its blockhash), so a server that lies can
// only make a request fail. Sessions live 5 minutes in the shared KV (market-store.mjs: memory under
// `npm start`, Redis on Vercel), so any instance can serve any step. Only SHA-256 hashes of the two
// tokens are stored; the page's token stops working once it posted a result or cancelled. Tokens
// and payloads are never logged.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const LINK_TTL_MS = 5 * 60_000;
/** Request bodies: a batch of 24 signed transactions is ~40 kB of base64. */
export const LINK_BODY_LIMIT = 64 * 1024;
/** New sessions per IP per minute. */
export const LINK_CREATES_PER_MIN = 10;
/** Every /api/link request per IP per minute (the app polls 40 times a minute). */
export const LINK_REQUESTS_PER_MIN = 240;
/** The most transactions one request may carry (a sale signs up to 24 fish in a few transactions). */
export const LINK_MAX_TXS = 24;
/** A legacy or v0 transaction is at most 1232 bytes; its base64. */
const MAX_TX_B64 = 1700;
/** After the result is in, the app still has this long to collect it. */
const DONE_GRACE_MS = 60_000;

const ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG_B64_LEN = 88; // 64 bytes

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hash = (token) => createHash('sha256').update(String(token)).digest();
const token = () => randomBytes(32).toString('base64url');

function tokenMatches(given, storedHex) {
  if (typeof given !== 'string' || !given || typeof storedHex !== 'string') return false;
  const want = Buffer.from(storedHex, 'hex');
  const got = hash(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

const isB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && s.length % 4 === 0 && B64_RE.test(s);
const isB58 = (s) => typeof s === 'string' && B58_RE.test(s);

/** What the app may ask for. Throws 400 on anything else. */
export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected {kind, payload}');
  const { kind, payload } = body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'payload must be an object');
  if (kind === 'connect') {
    if (!NONCE_RE.test(String(payload.nonce ?? ''))) throw new HttpError(400, 'connect needs a nonce');
    return { kind, payload: { nonce: payload.nonce } };
  }
  if (kind === 'sign') {
    const { owner, txs, keepBlockhash = false } = payload;
    if (!isB58(owner)) throw new HttpError(400, 'sign needs the owner address');
    if (!Array.isArray(txs) || txs.length < 1 || txs.length > LINK_MAX_TXS) throw new HttpError(400, `sign needs 1 to ${LINK_MAX_TXS} transactions`);
    if (!txs.every((t) => isB64(t, MAX_TX_B64))) throw new HttpError(400, 'Each transaction must be base64');
    if (typeof keepBlockhash !== 'boolean') throw new HttpError(400, 'keepBlockhash must be true or false');
    return { kind, payload: { owner, txs, keepBlockhash } };
  }
  throw new HttpError(400, 'kind must be "connect" or "sign"');
}

/** What the link page may post back for a session of `kind`. Shapes only: the app checks the cryptography. */
export function validateResult(kind, payload, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a result object');
  if (kind === 'connect') {
    const { publicKey, signature } = body;
    if (!isB58(publicKey)) throw new HttpError(400, 'publicKey must be a base58 address');
    if (!isB64(signature, SIG_B64_LEN) || signature.length !== SIG_B64_LEN) throw new HttpError(400, 'signature must be 64 bytes of base64');
    return { publicKey, signature };
  }
  const { txs, blockhash, lastValidBlockHeight } = body;
  if (!Array.isArray(txs) || txs.length !== payload.txs.length) throw new HttpError(400, `Expected ${payload.txs.length} signed transactions`);
  if (!txs.every((t) => isB64(t, MAX_TX_B64))) throw new HttpError(400, 'Each transaction must be base64');
  if (blockhash !== undefined && !isB58(blockhash)) throw new HttpError(400, 'blockhash must be base58');
  if (lastValidBlockHeight !== undefined && !(Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0)) {
    throw new HttpError(400, 'lastValidBlockHeight must be a positive integer');
  }
  return { txs, ...(blockhash !== undefined ? { blockhash } : {}), ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}) };
}

/** A four-digit code the player compares between the app and the browser. */
const matchCode = () => String(randomInt(0, 10_000)).padStart(4, '0');

/**
 * The /api/link handler: `(req, res) => Promise<boolean>`, false for any other path.
 *   kv        the store's KV (market-store.mjs createMemoryKv / createRedisKv)
 *   clientIp  (req) => the player's address, for the rate limits
 *   now       the clock (tests)
 */
export function createLinkHandler({ kv, clientIp = (req) => req.socket?.remoteAddress ?? '?', log = console.log, now = () => Date.now() } = {}) {
  if (!kv) throw new Error('createLinkHandler: kv is required');
  const key = (sid) => `link:${sid}`;

  async function limit(name, ip, max) {
    const window = Math.floor(now() / 60_000);
    const n = await kv.incr(`link:rl:${name}:${ip}:${window}`, { ttlMs: 60_000 });
    if (n > max) throw new HttpError(429, 'Too many requests, slow down');
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > LINK_BODY_LIMIT) {
        req.resume();
        return reject(new HttpError(413, 'Body too large'));
      }
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size <= LINK_BODY_LIMIT) parts.push(c); // past the limit: drain without keeping, so the 413 still gets sent
        else if (size > 16 * LINK_BODY_LIMIT) req.destroy();
      });
      req.on('end', () => {
        if (size > LINK_BODY_LIMIT) return reject(new HttpError(413, 'Body too large'));
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'));
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /** The session's raw JSON and its parsed record, or a 404. Expired sessions are gone even if the KV still holds them. */
  async function load(sid) {
    if (!ID_RE.test(sid)) throw new HttpError(404, 'No such link');
    const raw = await kv.get(key(sid));
    const rec = raw ? JSON.parse(raw) : null;
    if (!rec || (rec.status === 'open' && rec.expiresAt <= now())) throw new HttpError(404, 'This link expired or was closed');
    return { raw, rec };
  }

  const pageToken = (req) => req.headers['x-link-token'];
  const appToken = (req) => {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    return m ? m[1] : '';
  };

  async function create(req, ip) {
    await limit('create', ip, LINK_CREATES_PER_MIN);
    const { kind, payload } = validateRequest(await readJson(req));
    const sid = token();
    const app = token();
    const page = token();
    const expiresAt = now() + LINK_TTL_MS;
    const rec = { kind, payload, appHash: hash(app).toString('hex'), pageHash: hash(page).toString('hex'), matchCode: matchCode(), expiresAt, status: 'open' };
    if (!(await kv.set(key(sid), JSON.stringify(rec), { nx: true, ttlMs: LINK_TTL_MS }))) throw new HttpError(503, 'Try again');
    return [201, { sid, appToken: app, pageToken: page, matchCode: rec.matchCode, expiresAt }];
  }

  /** The link page reads what to sign. */
  async function forPage(req, sid) {
    const { rec } = await load(sid);
    if (rec.status !== 'open' || !tokenMatches(pageToken(req), rec.pageHash)) throw new HttpError(401, 'This link is no longer valid');
    return [200, { kind: rec.kind, payload: rec.payload, matchCode: rec.matchCode, expiresAt: rec.expiresAt }];
  }

  /** The link page's one answer: a result or a cancel. The first wins; the page token then stops working. */
  async function finish(req, sid, cancel) {
    const body = cancel ? null : await readJson(req);
    const { raw, rec } = await load(sid);
    if (rec.status !== 'open' || !tokenMatches(pageToken(req), rec.pageHash)) throw new HttpError(401, 'This link is no longer valid');
    const next = { ...rec, pageHash: null, payload: null };
    if (cancel) next.status = 'cancelled';
    else {
      next.status = 'done';
      next.result = validateResult(rec.kind, rec.payload, body);
    }
    const ttlMs = Math.max(rec.expiresAt - now(), 0) + DONE_GRACE_MS;
    if (!(await kv.cas(key(sid), raw, JSON.stringify(next), { ttlMs }))) throw new HttpError(409, 'This link already has an answer');
    return [200, { ok: true }];
  }

  /** The app polls. Its answer is handed over once, then the session is gone. */
  async function poll(req, sid) {
    const { raw, rec } = await load(sid);
    if (!tokenMatches(appToken(req), rec.appHash)) throw new HttpError(401, 'Unauthorized');
    if (rec.status === 'open') return [202, { status: 'pending', expiresAt: rec.expiresAt }];
    if (!(await kv.cas(key(sid), raw, null))) throw new HttpError(404, 'This link expired or was closed');
    return [200, rec.status === 'done' ? { status: 'done', result: rec.result } : { status: 'cancelled' }];
  }

  /** The app closed its waiting screen. */
  async function drop(req, sid) {
    const { rec } = await load(sid);
    if (!tokenMatches(appToken(req), rec.appHash)) throw new HttpError(401, 'Unauthorized');
    await kv.del(key(sid));
    return [200, { ok: true }];
  }

  function send(res, status, obj) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(JSON.stringify(obj));
  }

  return async function handle(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (pathname !== '/api/link' && !pathname.startsWith('/api/link/')) return false;
    const parts = pathname.split('/').slice(3); // ['', 'api', 'link', sid, action]
    const [sid, action] = parts;
    const m = req.method;
    try {
      const ip = clientIp(req);
      await limit('all', ip, LINK_REQUESTS_PER_MIN);
      let out;
      if (parts.length === 0 && m === 'POST') out = await create(req, ip);
      else if (parts.length === 1 && m === 'GET') out = await forPage(req, sid);
      else if (parts.length === 1 && m === 'DELETE') out = await drop(req, sid);
      else if (parts.length === 2 && action === 'result' && m === 'POST') out = await finish(req, sid, false);
      else if (parts.length === 2 && action === 'cancel' && m === 'POST') out = await finish(req, sid, true);
      else if (parts.length === 2 && action === 'result' && m === 'GET') out = await poll(req, sid);
      else throw new HttpError(parts.length <= 2 && (!action || action === 'result' || action === 'cancel') ? 405 : 404, 'Not found');
      send(res, out[0], out[1]);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      // Never the body or a token: only what failed.
      if (status >= 500) log(`[link] ${m} /api/link failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`);
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : 'Internal error' });
      else res.end();
    }
    return true;
  };
}

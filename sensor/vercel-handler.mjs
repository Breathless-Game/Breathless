// Every /api route on Vercel, in one function (api/index.mjs; vercel.json rewrites /api/* to it).
// The same handlers `npm start` mounts (index.mjs), wired for a serverless host:
//
//   - state in Redis (market-store.mjs), the market wallet from MARKET_SECRET_KEY, read-only;
//   - no timers and no start-up work: an instance may be frozen between requests, so the burn
//     sweep runs from the daily cron (GET /api/cron/sweep, Bearer CRON_SECRET) and, at most every
//     SWEEP_EVERY_MS, after a sale, in waitUntil once the seller has their answer;
//   - built lazily, once per instance, on the first request that needs it. /api/nft/* never waits
//     for the market and keeps working when it cannot start;
//   - no WebSocket: there is no /sensor here. With Presage off the production game never opens one
//     (game/src/features.ts breathModeList: keyboard only), so nothing is lost.
//
// Per instance, not per deployment (each instance has its own memory): the rate limiters in
// market.mjs, nft-serial.mjs and nft-meta.mjs, the fish mint/migration quotas, the rpc-guard
// concurrency limit and 429 backoff, and the balance / owned-fish caches. Vercel runs a handful
// of instances under load, so each limit is that many times looser than in one `npm start`
// process. What must hold across instances (one payout per fish, gapless fish numbers, one PEARL
// mint) is in Redis.

import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGearHandler } from './nft-gear.mjs';
import { createNftHandler } from './nft-meta.mjs';
import { SERIAL_FILE, createSerialHandler } from './nft-serial.mjs';
import { createStore } from './market-store.mjs';
import { createLinkHandler } from './link-relay.mjs';

/** How long Vercel's CDN keeps an NFT's metadata and art (nft-meta.mjs, nft-gear.mjs): a year, the most it allows. */
export const NFT_CDN_CACHE = 'max-age=31536000';
/**
 * A /sell or /sell-batch starts no fish and sends no payout after this long (503, sell again).
 * maxDuration is 300 s, and a payout sent just before the deadline can still take ~110 s: up to
 * ~20 s of 429 backoff on the send, then up to 90 s for the confirmation.
 */
export const BATCH_DEADLINE_MS = 180_000;
/**
 * A sweep starts no burn or resume, and a resume sends no payout, after this long into the function
 * (the after-sale one counts from its sale's request); the rest wait for the next one. 180 s for the
 * same reason as BATCH_DEADLINE_MS: what was sent just before it still has ~110 s to confirm.
 */
export const SWEEP_DEADLINE_MS = 180_000;
/** The opportunistic sweep after a sale runs at most this often, across all instances. */
export const SWEEP_EVERY_MS = 10 * 60_000;
/** One sweep at a time across instances; longer than any sweep (SWEEP_MAX_PER_RUN burns) takes. */
const SWEEP_LOCK_MS = 5 * 60_000;
export const CRON_PATH = '/api/cron/sweep';
const SALES = new Set(['/api/market/sell', '/api/market/sell-batch']);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The client's IP for the rate limits. Vercel sets x-real-ip (and x-forwarded-for) itself and
 * overwrites what the client sent. Behind Cloudflare's proxy (orange cloud) this would be
 * Cloudflare's address: keep the DNS record DNS-only (deploy/VERCEL.md).
 */
export function vercelClientIp(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? '?';
}

/** `Authorization: Bearer <CRON_SECRET>`, compared in constant time. No secret set: nobody gets in. */
export function cronAuthorized(req, secret) {
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The path the function was asked for. Vercel's rewrite keeps the original URL in req.url; should
 * it ever show the rewrite's destination (/api/index) instead, the path comes from its __path query
 * (vercel.json passes it). __path is taken out of the query either way.
 */
export function originalUrl(rawUrl) {
  const url = new URL(rawUrl ?? '/', 'http://localhost');
  const fallback = url.searchParams.get('__path');
  url.searchParams.delete('__path');
  if (url.pathname === '/api/index' || url.pathname === '/api/index.mjs') url.pathname = fallback != null ? `/api/${fallback}` : '/api/';
  return url.pathname + url.search;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/**
 * The request handler. Everything is an option so the tests and a local run can swap pieces in:
 *   env         process.env (MARKET_STORE, UPSTASH_REDIS_REST_*, MARKET_SECRET_KEY, CRON_SECRET, ...)
 *   redis       a Redis client instead of @upstash/redis (the tests' fake)
 *   createMarket market.mjs's, imported on first use
 *   waitUntil   @vercel/functions' (keeps the instance alive for the after-sale sweep)
 */
export function createVercelHandler({ env = process.env, redis, log = console.log, createMarket, waitUntil, now = () => Date.now() } = {}) {
  // MARKET_DIR is only for a local run on the file store (Vercel refuses that store: market-store.mjs).
  const dir = env.MARKET_DIR ? resolve(REPO_ROOT, env.MARKET_DIR) : undefined;
  const nft = createNftHandler({ publicOrigin: env.PUBLIC_ORIGIN, log, cdnCache: NFT_CDN_CACHE });
  const gear = createGearHandler({ publicOrigin: env.PUBLIC_ORIGIN, cdnCache: NFT_CDN_CACHE });

  // Built once per instance; a failure is not kept, so the next request tries again.
  let storeP = null;
  const getStore = () =>
    (storeP ??= createStore({ env, dir, redis, log }).catch((e) => {
      storeP = null;
      throw e;
    }));
  let serialsP = null;
  const getSerials = () =>
    (serialsP ??= getStore()
      .then((store) => createSerialHandler({ counter: store.openSerials(), file: store.kind === 'file' ? resolve(store.dir, SERIAL_FILE) : undefined, clientIp: vercelClientIp, log }))
      .catch((e) => {
        serialsP = null;
        throw e;
      }));
  let marketP = null;
  const getMarket = () =>
    (marketP ??= (async () => {
      const store = await getStore();
      const { createMarket: make, rpcEndpoint } = createMarket ? { createMarket, rpcEndpoint: () => env.SOLANA_RPC } : await import('./market.mjs');
      return make({ rpc: rpcEndpoint(), dir, clientIp: vercelClientIp, log, store, background: false, batchDeadlineMs: BATCH_DEADLINE_MS });
    })().catch((e) => {
      marketP = null;
      throw e;
    }));
  // The desktop app's wallet relay (link-relay.mjs): its sessions in the store's KV, so every instance sees them.
  let linkP = null;
  const getLink = () =>
    (linkP ??= getStore()
      .then((store) => createLinkHandler({ kv: store.kv, clientIp: vercelClientIp, log, now }))
      .catch((e) => {
        linkP = null;
        throw e;
      }));
  let waitUntilP = null;
  const getWaitUntil = () => (waitUntilP ??= waitUntil ? Promise.resolve(waitUntil) : import('@vercel/functions').then((m) => m.waitUntil, () => (p) => p));

  /** One sweep at a time across instances (a lock in the store's KV); null when another is running. */
  async function sweepLocked(market, store, deadlineMs = SWEEP_DEADLINE_MS) {
    const release = await store.lock('sweep', SWEEP_LOCK_MS);
    if (!release) return null;
    try {
      return await market.sweep({ deadlineMs });
    } finally {
      await release();
    }
  }

  /** After a sale (its request began at `started`): sweep if nobody has in the last SWEEP_EVERY_MS. Never throws. */
  async function sweepSoon(market, store, started) {
    try {
      if (now() - started >= SWEEP_DEADLINE_MS) return; // no time left in this function
      if (!(await store.kv.set('sweep:last', String(now()), { nx: true, ttlMs: SWEEP_EVERY_MS }))) return;
      await sweepLocked(market, store, SWEEP_DEADLINE_MS - (now() - started));
    } catch (e) {
      log(`[market] after-sale sweep failed: ${e?.message ?? e}`);
    }
  }

  /** The cron's sweep (its request began at `started`): what a cold start took comes off its deadline. */
  async function cron(req, res, started) {
    if (!cronAuthorized(req, env.CRON_SECRET)) return sendJson(res, 401, { error: 'Unauthorized' });
    const [market, store] = await Promise.all([getMarket(), getStore()]);
    const result = await sweepLocked(market, store, SWEEP_DEADLINE_MS - (now() - started));
    sendJson(res, 200, result ? { swept: true, ...result } : { swept: false, reason: 'another sweep is running, or the sweep failed (see the log)' });
  }

  return async function handler(req, res) {
    const started = now();
    req.url = originalUrl(req.url);
    const pathname = req.url.split('?')[0];
    try {
      if (pathname === CRON_PATH) return void (await cron(req, res, started));
      if (pathname === '/api/nft/serial') {
        let serials;
        try {
          serials = await getSerials();
        } catch (e) {
          log(`fish numbers unavailable: ${e?.message ?? e}`);
          return sendJson(res, 503, { error: 'Fish numbers are unavailable, try again in a moment' });
        }
        if (await serials(req, res)) return;
      }
      if (await gear(req, res)) return;
      if (await nft(req, res)) return;
      if (pathname === '/api/link' || pathname.startsWith('/api/link/')) {
        let link;
        try {
          link = await getLink();
        } catch (e) {
          log(`wallet link unavailable: ${e?.message ?? e}`);
          return sendJson(res, 503, { error: 'The wallet link is unavailable, try again in a moment' });
        }
        if (await link(req, res)) return;
      }
      if (pathname.startsWith('/api/market/')) {
        let market;
        try {
          market = await getMarket();
        } catch (e) {
          log(`PEARL market unavailable, /api/market answers 503: ${e?.message ?? e}`);
          return sendJson(res, 503, { error: 'PEARL market is unavailable on this server' });
        }
        await market.handle(req, res);
        if (req.method === 'POST' && SALES.has(pathname) && res.statusCode === 200) {
          const store = await getStore();
          (await getWaitUntil())(sweepSoon(market, store, started));
        }
        return;
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      log(`${req.method} ${req.url} failed: ${e?.message ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.destroy();
    }
  };
}

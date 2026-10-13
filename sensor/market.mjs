// PEARL market: the server side of the in-game currency, in one of two modes
// picked at start-up.
//
//   program  FISH_MARKET_PROGRAM_ID is set. The
//            fish_market Anchor program owns PEARL and does burn + pay atomically;
//            this server is its oracle and only co-signs `sell_fish` quotes.
//            The IDL at game/src/idl/fish_market.json, when present, drives the
//            instruction layout. See market-program-mode.mjs.
//   server   Fallback. The market wallet owns the PEARL mint, receives the fish,
//            pays and burns. See market-server-mode.mjs.
//
//   const market = await createMarket({ rpc, dir });
//   http.createServer(async (req, res) => { if (await market.handle(req, res)) return; ... });
//
// Routes: GET /api/market/info, POST /api/market/quote, POST /api/market/sell (server mode),
// and for selling many fish with one wallet approval (server mode): POST /api/market/quote-batch
// { seller, assetIds } and POST /api/market/sell-batch { seller, sales: [{ assetId, transferTx }] }.
// GET /api/market/balance?owner=&session= reads PEARL + session SOL for the title badge (market-balance.mjs).
// GET /api/market/fish?owner= lists the game's fish NFTs the wallet owns, re-derived (fish-owned.mjs).
//
// Secrets (gitignored, mode 600, Solana CLI format, never logged; only public keys are printed):
//   program mode  MARKET_ORACLE_KEYPAIR, default <dir>/.market-oracle.json
//   server mode   <dir>/.market-keypair.json (+ <dir>/.market-state.json, public)
// With the Redis store (market-store.mjs, a serverless host) server mode's state is in Redis and
// the market wallet is MARKET_SECRET_KEY, read-only: never generated, never written to disk.
// Program mode needs the file store.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { deserializeAssetV1, fetchAssetsByOwner, mplCore } from '@metaplex-foundation/mpl-core';
import { findAssociatedTokenPda, mplToolbox } from '@metaplex-foundation/mpl-toolbox';
import { mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { HttpError, RateLimiter, isAddress } from './market-rules.mjs';
import { DEVNET, RPC_CONCURRENCY, guardRpc, isTransientRpcError, redactRpc, rpcEndpoint } from './rpc-guard.mjs';

export { rpcEndpoint };

/** A batch request counts as one sale-request per this many fish (at least one) against the trade limit. */
const FISH_PER_TRADE_HIT = 5;
import { DEFAULT_LAYOUT, layoutFromIdl } from './fish-market.mjs';
import { createProgramMode } from './market-program-mode.mjs';
import { createServerMode } from './market-server-mode.mjs';
import { createBalanceReader, parseBalanceQuery } from './market-balance.mjs';
import { createOwnedFetcher, createOwnedFishReader, fetchAssetsByIds, jsonRpc, parseOwnedQuery } from './fish-owned.mjs';
import { KEYPAIR_FILE, createStore } from './market-store.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDL_PATH = path.join(REPO_ROOT, 'game/src/idl/fish_market.json');
const BODY_LIMIT = 16 * 1024;

/** Load a Solana CLI keypair file, or create one (mode 600) if it does not exist. */
function useKeypair(u, file, label, log) {
  let secret;
  if (existsSync(file)) {
    secret = Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')));
    try {
      chmodSync(file, 0o600);
    } catch {}
  } else {
    secret = u.eddsa.generateKeypair().secretKey;
    writeFileSync(file, JSON.stringify(Array.from(secret)), { mode: 0o600, flag: 'wx' });
    const shown = file.startsWith(REPO_ROOT) ? path.relative(REPO_ROOT, file) : file;
    log(`[market] generated a new ${label} keypair at ${shown}`);
  }
  u.use(keypairIdentity(u.eddsa.createKeypairFromSecretKey(secret)));
}

/** The market wallet from the store's secret (MARKET_SECRET_KEY): nothing is generated or written. */
function useSecret(u, secret) {
  let keypair;
  try {
    keypair = u.eddsa.createKeypairFromSecretKey(secret);
  } catch {
    throw new Error('MARKET_SECRET_KEY is not a valid ed25519 secret key'); // never the key itself
  }
  u.use(keypairIdentity(keypair));
}

/** The fish collection server mode created in this dir, if any (program mode then only buys its fish). */
function savedFishCollection(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, '.market-state.json'), 'utf8')).fishCollection ?? null;
  } catch {
    return null;
  }
}

function loadIdl(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export async function createMarket({
  rpc = DEVNET,
  // Market RPC calls in flight at once (rpc-guard.mjs); a paid RPC plan can raise it.
  rpcConcurrency = Number(process.env.SOLANA_RPC_CONCURRENCY) || RPC_CONCURRENCY,
  dir,
  programId = process.env.FISH_MARKET_PROGRAM_ID,
  oracleKeypair = process.env.MARKET_ORACLE_KEYPAIR,
  idl,
  log = console.log,
  // Rate limits key on this. Behind a local proxy or tunnel pass one that reads the forwarded client IP.
  clientIp = (req) => req.socket?.remoteAddress ?? '?',
  // Server mode, for tests and the e2e only: { legacyGraceSlots, limits: { mintsPerHour, migrationsPerHour, dailyPearls } }.
  fishOptions = {},
  // Where state lives (market-store.mjs): a store, or its kind ('file' | 'redis'); default: the
  // environment's choice (MARKET_STORE, else Redis exactly when its credentials are set).
  store,
  // A serverless host: no timers or start-up work (see createServerMode), and a /sell-batch deadline.
  background = true,
  batchDeadlineMs,
} = {}) {
  if (!store || typeof store === 'string') store = await createStore({ kind: store, dir, log });
  if (store.kind === 'file' && !dir) throw new Error('createMarket: dir is required');
  programId ||= null; // only the env var (or option) turns program mode on, so server mode stays the safe default
  if (programId && !isAddress(programId)) throw new Error(`FISH_MARKET_PROGRAM_ID is not an address: ${programId}`);

  // Every Solana call the market makes goes through this one umi, and so through guardRpc: one
  // concurrency limit, one 429 backoff (web3.js's own retry is off so the two don't stack), and
  // confirmations polled over HTTP, never web3.js's confirmTransaction (see rpc-guard.mjs).
  const u = createUmi(rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true }).use(mplCore()).use(mplToolbox()).use(mplTokenMetadata());
  u.use({
    install(umi) {
      umi.rpc = guardRpc(umi.rpc, { limit: rpcConcurrency, log });
    },
  });
  log(`[market] Solana RPC ${redactRpc(rpc)}, at most ${rpcConcurrency} call(s) in flight`);
  let mode;
  if (programId && store.kind !== 'file') throw new Error('Program mode (FISH_MARKET_PROGRAM_ID) needs the file store: its oracle key is a file');
  if (programId) {
    idl ??= loadIdl(IDL_PATH);
    const layout = idl ? layoutFromIdl(idl) : DEFAULT_LAYOUT; // a mismatched IDL fails here, loudly
    if (layout.address && layout.address !== programId) {
      log(`[market] WARNING: the IDL's address ${layout.address} differs from FISH_MARKET_PROGRAM_ID ${programId}`);
    }
    // A relative MARKET_ORACLE_KEYPAIR is relative to the repo root (the default reads as sensor/.market-oracle.json).
    const file = oracleKeypair ? path.resolve(REPO_ROOT, oracleKeypair) : path.join(dir, '.market-oracle.json');
    useKeypair(u, file, 'oracle', log);
    mode = createProgramMode({ u, programId, layout, log, fishCollection: savedFishCollection(dir) });
  } else {
    const secret = store.marketSecret(); // null: the file store's keypair file
    if (secret) useSecret(u, secret);
    else useKeypair(u, path.join(dir, KEYPAIR_FILE), 'market', log);
    mode = await createServerMode({ u, rpc, dir, log, fishOptions, store, background, batchDeadlineMs });
  }
  const modeName = programId ? 'program' : 'server';

  // ---- HTTP. Behind the Vite proxy every request comes from 127.0.0.1, so limits are lenient
  // (`npm start` passes clientIp, so there they are per player).
  const limiter = new RateLimiter({ limit: 120, windowMs: 60_000 });
  const tradeLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });
  // Balance reads: a badge refresh is cheap (cached), but keep one player from hammering the RPC.
  const balanceLimiter = new RateLimiter({ limit: 60, windowMs: 60_000 });
  const freshLimiter = new RateLimiter({ limit: 20, windowMs: 60_000 }); // fresh=1 skips the cache

  // The PEARL mint and its token program for balance reads. mode.info() may hit the RPC, so keep it
  // a minute once the mint exists (it never changes), a few seconds while it does not yet.
  let mintMemo = { at: 0, value: null };
  async function mintInfo() {
    const ttl = mintMemo.value?.pearlMint ? 60_000 : 5_000;
    if (Date.now() - mintMemo.at < ttl) return mintMemo.value;
    const { pearlMint, tokenProgram } = await mode.info();
    mintMemo = { at: Date.now(), value: { pearlMint: pearlMint ?? null, tokenProgram } };
    return mintMemo.value;
  }
  const balances = createBalanceReader({
    getAccounts: async (addrs) =>
      (await u.rpc.getAccounts(addrs.map((a) => publicKey(a)))).map((a) => (a.exists ? { exists: true, data: a.data, lamports: a.lamports.basisPoints } : { exists: false })),
    ataOf: (owner, mint, tokenProgram) =>
      findAssociatedTokenPda(u, { mint: publicKey(mint), owner: publicKey(owner), tokenProgramId: publicKey(tokenProgram) })[0].toString(),
    mintInfo,
  });
  // Owned fish (a wallet rebuilding its aquarium from the chain): the RPC's DAS owner index plus
  // getMultipleAccounts when it has one, else one getProgramAccounts per read (fish-owned.mjs);
  // cached a few seconds in memory. Attributes live on the asset itself, so no collection fetch.
  const ownedLimiter = new RateLimiter({ limit: 20, windowMs: 60_000 });
  let collMemo = { at: 0, value: null };
  async function fishCollection() {
    const ttl = collMemo.value ? 60_000 : 5_000;
    if (Date.now() - collMemo.at < ttl) return collMemo.value;
    collMemo = { at: Date.now(), value: (await mode.info()).fishCollection ?? null };
    return collMemo.value;
  }
  // DAS goes over plain fetch (see jsonRpc) but through the same limiter and 429 backoff as umi.
  const dasCall = jsonRpc(rpc);
  const das = (method, params) => u.rpc.guard.limiter.run(() => u.rpc.guard.backoff.call(() => dasCall(method, params)));
  const ownedFish = createOwnedFishReader({
    fetchOwned: createOwnedFetcher({
      das,
      fetchByIds: (ids) => fetchAssetsByIds(ids, { getAccounts: (keys) => u.rpc.getAccounts(keys.map((k) => publicKey(k))), decode: deserializeAssetV1 }),
      fetchByGpa: (owner) => fetchAssetsByOwner(u, owner, { skipDerivePlugins: true }),
      label: redactRpc(rpc),
      log,
    }),
    collection: fishCollection,
  });
  /**
   * A sale paid (or may have paid) the seller: their next balance (and owned-fish) read goes to the
   * chain. Runs even when the body failed validation, so only a real address gets that far.
   */
  const paidSeller = (body) => {
    const seller = isAddress(body?.seller) ? body.seller : null;
    balances.invalidate(seller);
    ownedFish.invalidate(seller);
  };

  function send(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size <= BODY_LIMIT) parts.push(c); // past the limit: drain without keeping, so the 413 still gets sent
        else if (size > 64 * BODY_LIMIT) req.destroy(); // but not forever
      });
      req.on('end', () => {
        if (size > BODY_LIMIT) return reject(new HttpError(413, 'Body too large'));
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'));
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /** A batch already paid one trade hit to get here; bigger ones pay a little more (rounded up). */
  function chargeBatch(ip, fish) {
    const extra = Math.ceil(fish / FISH_PER_TRADE_HIT) - 1;
    if (extra > 0 && !tradeLimiter.allow(ip, Date.now(), extra)) throw new HttpError(429, 'Too many sales, slow down');
  }
  const batchSize = (list) => (Array.isArray(list) ? list.length : 0);
  const PROGRAM_MODE = 'Program mode: sign the quoted sell_fish transaction instead';

  const ROUTES = {
    'GET /api/market/info': () => mode.info(),
    'GET /api/market/balance': (_req, ip, url) => {
      if (!balanceLimiter.allow(ip)) throw new HttpError(429, 'Too many balance reads, slow down');
      const q = parseBalanceQuery(url.searchParams);
      return balances.read({ ...q, fresh: q.fresh && freshLimiter.allow(ip) });
    },
    'GET /api/market/fish': (_req, ip, url) => {
      if (!ownedLimiter.allow(ip)) throw new HttpError(429, 'Too many fish reads, slow down');
      return ownedFish.read(parseOwnedQuery(url.searchParams));
    },
    'POST /api/market/quote': async (req) => mode.quote(await readJson(req)),
    'POST /api/market/sell': async (req) => {
      if (!mode.sell) throw new HttpError(409, PROGRAM_MODE);
      const body = await readJson(req);
      try {
        return await mode.sell(body);
      } finally {
        paidSeller(body);
      }
    },
    'POST /api/market/quote-batch': async (req, ip) => {
      if (!mode.quoteBatch) throw new HttpError(409, 'Program mode: quote each fish with /quote');
      const body = await readJson(req);
      chargeBatch(ip, batchSize(body?.assetIds));
      return mode.quoteBatch(body);
    },
    // Fish NFTs enter the market's collection only through these (fish-collection.mjs).
    'POST /api/market/cosign-mint': async (req) => {
      if (!mode.cosignMint) throw new HttpError(409, 'Program mode: mint without a co-signature');
      return mode.cosignMint(await readJson(req));
    },
    'POST /api/market/cosign-migrate': async (req) => {
      if (!mode.cosignMigrate) throw new HttpError(409, 'Program mode: nothing to migrate');
      return mode.cosignMigrate(await readJson(req));
    },
    'POST /api/market/sell-batch': async (req, ip) => {
      if (!mode.sellBatch) throw new HttpError(409, PROGRAM_MODE);
      const body = await readJson(req);
      chargeBatch(ip, batchSize(body?.sales));
      try {
        return await mode.sellBatch(body);
      } finally {
        paidSeller(body);
      }
    },
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/market/')) return false;
    const ip = clientIp(req);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (!limiter.allow(ip)) throw new HttpError(429, 'Too many requests');
      const fn = ROUTES[route];
      if (!fn) {
        const known = Object.keys(ROUTES).some((r) => r.endsWith(` ${url.pathname}`));
        throw new HttpError(known ? 405 : 404, known ? 'Method not allowed' : 'Not found');
      }
      if (req.method === 'POST' && !tradeLimiter.allow(ip)) throw new HttpError(429, 'Too many sales, slow down');
      send(res, 200, await fn(req, ip, url));
    } catch (e) {
      // The RPC refusing us (429, timeout) is temporary: 503, so the game retries instead of giving up.
      const busy = !(e instanceof HttpError) && isTransientRpcError(e);
      const status = e instanceof HttpError ? e.status : busy ? 503 : 500;
      const error = e instanceof HttpError ? e.message : String(e?.message ?? e).split('\n')[0].slice(0, 200);
      if (status >= 500) log(`[market] ${route} failed: ${error}`);
      // e.extra: e.g. { code, retryAfterMs } on a limit, { assetId } on an already-minted fish.
      if (!res.headersSent) send(res, status, { ...(e instanceof HttpError ? e.extra : undefined), error });
      else res.end();
    }
    return true;
  }

  return {
    mode: modeName,
    info: mode.info,
    handle,
    ready: mode.ready,
    // Server mode: burn the paid fish still in the market wallet (market-burn.mjs); a serverless host calls it.
    sweep: mode.sweep ?? (async () => null),
    store,
    publicKey: u.identity.publicKey.toString(),
  };
}

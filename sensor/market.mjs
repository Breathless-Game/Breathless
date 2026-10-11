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
//
// Secrets (gitignored, mode 600, Solana CLI format, never logged; only public keys are printed):
//   program mode  MARKET_ORACLE_KEYPAIR, default <dir>/.market-oracle.json
//   server mode   <dir>/.market-keypair.json (+ <dir>/.market-state.json, public)

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keypairIdentity } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { mplToolbox } from '@metaplex-foundation/mpl-toolbox';
import { mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { HttpError, RateLimiter, isAddress } from './market-rules.mjs';

/** A batch request counts as one sale-request per this many fish (at least one) against the trade limit. */
const FISH_PER_TRADE_HIT = 5;
import { DEFAULT_LAYOUT, layoutFromIdl } from './fish-market.mjs';
import { createProgramMode } from './market-program-mode.mjs';
import { createServerMode } from './market-server-mode.mjs';

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
  rpc = 'https://api.devnet.solana.com',
  dir,
  programId = process.env.FISH_MARKET_PROGRAM_ID,
  oracleKeypair = process.env.MARKET_ORACLE_KEYPAIR,
  idl,
  log = console.log,
  // Rate limits key on this. Behind a local proxy or tunnel pass one that reads the forwarded client IP.
  clientIp = (req) => req.socket?.remoteAddress ?? '?',
  // Server mode, for tests and the e2e only: { legacyGraceSlots, limits: { mintsPerHour, migrationsPerHour, dailyPearls } }.
  fishOptions = {},
} = {}) {
  if (!dir) throw new Error('createMarket: dir is required');
  programId ||= null; // only the env var (or option) turns program mode on, so server mode stays the safe default
  if (programId && !isAddress(programId)) throw new Error(`FISH_MARKET_PROGRAM_ID is not an address: ${programId}`);

  const u = createUmi(rpc, 'confirmed').use(mplCore()).use(mplToolbox()).use(mplTokenMetadata());
  let mode;
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
    useKeypair(u, path.join(dir, '.market-keypair.json'), 'market', log);
    mode = createServerMode({ u, rpc, dir, log, fishOptions });
  }
  const modeName = programId ? 'program' : 'server';

  // ---- HTTP. Behind the Vite proxy every request comes from 127.0.0.1, so limits are lenient
  // (`npm start` passes clientIp, so there they are per player).
  const limiter = new RateLimiter({ limit: 120, windowMs: 60_000 });
  const tradeLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });

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
    'POST /api/market/quote': async (req) => mode.quote(await readJson(req)),
    'POST /api/market/sell': async (req) => {
      if (!mode.sell) throw new HttpError(409, PROGRAM_MODE);
      return mode.sell(await readJson(req));
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
      return mode.sellBatch(body);
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
      send(res, 200, await fn(req, ip));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const error = e instanceof HttpError ? e.message : String(e?.message ?? e).split('\n')[0].slice(0, 200);
      if (status === 500) log(`[market] ${route} failed: ${error}`);
      // e.extra: e.g. { code, retryAfterMs } on a limit, { assetId } on an already-minted fish.
      if (!res.headersSent) send(res, status, { ...(e instanceof HttpError ? e.extra : undefined), error });
      else res.end();
    }
    return true;
  }

  return { mode: modeName, info: mode.info, handle, ready: mode.ready, publicKey: u.identity.publicKey.toString() };
}

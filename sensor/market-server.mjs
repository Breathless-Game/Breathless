// Standalone PEARL market for development. The game's Vite dev server proxies
// /api to it (game/vite.config.ts). In production `npm start` (index.mjs --serve)
// mounts the same `market.handle` on the game's HTTP server instead.
//
//   npm run market            (from the repo root, or `npm run market` in sensor/)

import { config } from 'dotenv';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarket, rpcEndpoint } from './market.mjs';
import { guardProcess } from './process-guard.mjs';
import { createGearHandler } from './nft-gear.mjs';
import { createNftHandler } from './nft-meta.mjs';
import { SERIAL_FILE, createSerialHandler } from './nft-serial.mjs';
import { createLinkHandler } from './link-relay.mjs';
import { createMemoryKv } from './market-store.mjs';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
guardProcess();

const PORT = Number(process.env.MARKET_PORT ?? 8795);
const RPC = rpcEndpoint(); // SOLANA_RPC, else VITE_SOLANA_RPC, else public devnet

// MARKET_DIR is relative to the repo root, like MARKET_ORACLE_KEYPAIR; default sensor/.
const DIR = process.env.MARKET_DIR
  ? resolve(fileURLToPath(new URL('..', import.meta.url)), process.env.MARKET_DIR)
  : fileURLToPath(new URL('.', import.meta.url));
mkdirSync(DIR, { recursive: true, mode: 0o700 });

// Always the file store, like the fish number counter below (Redis is for Vercel: api/index.mjs).
const market = await createMarket({ rpc: RPC, dir: DIR, store: 'file' });

// The fish NFT metadata host too, so the Vite proxy serves /api/nft in dev as `npm start` does.
const nft = createNftHandler();
// The Boat and Dive Kit NFTs (nft-gear.mjs); before `nft` too.
const gear = createGearHandler();
// And the fish numbers (#0042) the game asks for before each mint; before `nft`, which claims /api/nft/.
const serials = createSerialHandler({ file: join(DIR, SERIAL_FILE) });
// The desktop app's wallet relay (link-relay.mjs), its sessions in this process's memory.
const link = createLinkHandler({ kv: createMemoryKv() });

const server = http.createServer(async (req, res) => {
  if (await link(req, res)) return;
  if (await serials(req, res)) return;
  if (await gear(req, res)) return;
  if (await nft(req, res)) return;
  if (await market.handle(req, res)) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[market] listening on http://127.0.0.1:${PORT}/api/market/info`));

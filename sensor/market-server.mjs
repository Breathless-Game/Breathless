// Standalone PEARL market for development. The game's Vite dev server proxies
// /api to it (game/vite.config.ts). In production the same `market.handle`
// is meant to be mounted on the game's HTTP server instead.
//
//   npm run market            (from the repo root, or `npm run market` in sensor/)

import { config } from 'dotenv';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMarket } from './market.mjs';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const PORT = Number(process.env.MARKET_PORT ?? 8795);
const RPC = process.env.SOLANA_RPC ?? process.env.VITE_SOLANA_RPC ?? 'https://api.devnet.solana.com';

const market = await createMarket({ rpc: RPC, dir: fileURLToPath(new URL('.', import.meta.url)) });

const server = http.createServer(async (req, res) => {
  if (await market.handle(req, res)) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[market] listening on http://127.0.0.1:${PORT}/api/market/info`));

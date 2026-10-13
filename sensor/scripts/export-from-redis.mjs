// The way out of Redis, if the market ever has to leave Vercel (deploy/VERCEL.md, "Rolling back
// and moving the market"): write the Redis store's state
// out as the three files server mode reads, in the formats it always used:
//
//   .market-state.json   the PEARL mint, the fish collection, and the sold ledger
//   .market-fish.jsonl   the (owner, fish id) -> asset registry
//   .market-serial.json  the fish number counter
//
//   node sensor/scripts/export-from-redis.mjs <out-dir>
//
// Credentials from the environment only, as import-to-redis.mjs. <out-dir> must not hold any of
// the three files already: this never overwrites a market's state; copy the files into place
// yourself, with that market stopped. The market wallet stays where it is (MARKET_SECRET_KEY).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFIX, REGISTRY_FILE, RedisLedger, STATE_FILE, redisCredentials, redisKeys } from '../market-store.mjs';
import { SERIAL_FILE } from '../nft-serial.mjs';

/** Every key under `match`, over as many SCAN pages as it takes. */
async function scanAll(redis, match) {
  const out = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, { match, count: 500 });
    out.push(...keys);
    cursor = String(next);
  } while (cursor !== '0');
  return out;
}

/** { state (with sold), registry: [entries], serial: { last, keys } }, as the files hold them. */
export async function exportFromRedis({ redis, prefix = DEFAULT_PREFIX }) {
  const keys = redisKeys(prefix);
  const raw = await redis.get(keys.state);
  const state = raw === null || raw === undefined ? { mint: null } : JSON.parse(raw);
  const soldPrefix = keys.sold('');
  const ids = (await scanAll(redis, `${soldPrefix}*`)).map((k) => k.slice(soldPrefix.length)).sort();
  // SoldLedger's shape: a payout in flight shows as payTx/payLastValid on its 'paying' record.
  const view = await new RedisLedger(redis, prefix).loadAssets(ids);
  const sold = {};
  for (const id of ids) {
    const r = view.get(id);
    if (r) sold[id] = r;
  }
  const fish = (await redis.hgetall(keys.fish)) ?? {};
  const registry = Object.values(fish)
    .map((v) => JSON.parse(String(v)))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const serialKeys = (await redis.hgetall(keys.serialKeys)) ?? {};
  const serial = { last: Number((await redis.get(keys.serialLast)) ?? 0), keys: {} };
  for (const [k, v] of Object.entries(serialKeys).sort((a, b) => Number(a[1]) - Number(b[1]))) serial.keys[k] = Number(v);
  return { state: { ...state, sold }, registry, serial };
}

/** Write the export into `dir`; refuses if any of the three files is already there. */
export function writeMarketDir(dir, { state, registry, serial }) {
  const files = [STATE_FILE, REGISTRY_FILE, SERIAL_FILE].map((f) => path.join(dir, f));
  const there = files.filter((f) => existsSync(f));
  if (there.length) throw new Error(`Refusing to overwrite ${there.join(', ')}: export into an empty directory`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(files[0], JSON.stringify(state, null, 2));
  writeFileSync(files[1], registry.map((e) => `${JSON.stringify(e)}\n`).join(''));
  writeFileSync(files[2], JSON.stringify(serial));
}

async function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) throw new Error('Usage: node sensor/scripts/export-from-redis.mjs <out-dir>');
  const creds = redisCredentials(process.env);
  if (!creds) throw new Error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN) in the environment');
  const prefix = process.env.MARKET_STORE_PREFIX || DEFAULT_PREFIX;
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({ url: creds.url, token: creds.token, automaticDeserialization: false });
  const data = await exportFromRedis({ redis, prefix });
  writeMarketDir(path.resolve(dir), data);
  console.log(`Exported "${prefix}" to ${path.resolve(dir)}:`);
  console.log(`  sold records: ${Object.keys(data.state.sold).length}; registry entries: ${data.registry.length}; fish numbers: ${Object.keys(data.serial.keys).length}, counter at ${data.serial.last}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`export failed: ${e?.message ?? e}`);
    process.exit(1);
  });
}

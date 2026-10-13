// Copy server mode's state files into the Redis store (market-store.mjs), for the move to Vercel
// (deploy/VERCEL.md, cutover). Reads, from the market dir (default sensor/):
//
//   .market-state.json   the PEARL mint, the fish collection, and the sold ledger
//   .market-fish.jsonl   the (owner, fish id) -> asset registry
//   .market-serial.json  the fish number counter
//
// and never the market wallet (.market-keypair.json): that goes into MARKET_SECRET_KEY by hand.
//
//   node sensor/scripts/import-to-redis.mjs [dir] [--dry-run]
//
// Credentials from the environment only (UPSTASH_REDIS_REST_URL + _TOKEN, or KV_REST_API_URL +
// _TOKEN), and MARKET_STORE_PREFIX (default "market:"). --dry-run reads the files and prints what
// it would write, counts only, without connecting.
//
// Safe to run again: nothing already in Redis is overwritten (SET NX / HSETNX), except the state
// key (mint and collection, the same values from the same file) and the counter, which only moves
// up. Run it with the Dell's market stopped; if the files changed after an earlier import, empty
// the prefix first (deploy/VERCEL.md) so the newer records win.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFIX, REGISTRY_FILE, STATE_FILE, redisCas, redisCredentials, redisKeys } from '../market-store.mjs';
import { parseRegistry } from '../fish-trust.mjs';
import { SERIAL_FILE } from '../nft-serial.mjs';

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

/** The three files, parsed: { state (no sold), sold, registry (last line per key wins), serial }. */
export function readMarketDir(dir) {
  const full = readJson(path.join(dir, STATE_FILE)) ?? {};
  const { sold = {}, ...state } = full;
  const registry = new Map();
  const regFile = path.join(dir, REGISTRY_FILE);
  if (existsSync(regFile)) for (const e of parseRegistry(readFileSync(regFile, 'utf8'))) if (e && typeof e.k === 'string') registry.set(e.k, e);
  const saved = readJson(path.join(dir, SERIAL_FILE));
  const serial = { last: Number.isSafeInteger(saved?.last) ? saved.last : 0, keys: {} };
  for (const [k, v] of Object.entries(saved?.keys ?? {})) {
    if (Number.isSafeInteger(v) && v > 0) {
      serial.keys[k] = v;
      serial.last = Math.max(serial.last, v);
    }
  }
  return { hasState: Object.keys(full).length > 0, state, sold, registry, serial };
}

/**
 * Write `data` (readMarketDir) under `prefix`. Returns counts: { sold: { added, kept }, payouts,
 * registry: { added, kept }, serials: { added, kept }, serialLast, state }.
 */
export async function importToRedis({ redis, prefix = DEFAULT_PREFIX, data, dryRun = false }) {
  const keys = redisKeys(prefix);
  const out = { sold: { added: 0, kept: 0 }, payouts: 0, registry: { added: 0, kept: 0 }, serials: { added: 0, kept: 0 }, serialLast: data.serial.last, state: data.hasState };
  if (dryRun) {
    out.sold.added = Object.keys(data.sold).length;
    out.payouts = Object.values(data.sold).filter((r) => r?.status === 'paying' && r.payTx).length;
    out.registry.added = data.registry.size;
    out.serials.added = Object.keys(data.serial.keys).length;
    return out;
  }
  if (data.hasState) await redis.set(keys.state, JSON.stringify(data.state));

  for (const [assetId, rec] of Object.entries(data.sold)) {
    if (!rec || typeof rec.seller !== 'string') continue;
    // A payout in flight is its own key in Redis (RedisLedger); the record keeps the rest.
    const { payTx, payLastValid, ...rest } = rec;
    const inFlight = rec.status === 'paying' && payTx !== undefined;
    const record = inFlight ? rest : rec;
    await redis.zadd(keys.seller(rec.seller), { score: Number(rec.at) || 0, member: assetId });
    // A paid fish not burned yet goes on the sweep's work list (RedisLedger.unburned), index first as
    // the ledger does it: if Redis already holds a newer record, the listing drops the stale entry.
    if (rec.status === 'paid' && !rec.burnSkipped) await redis.zadd(keys.unburned, { score: Number(rec.at) || 0, member: assetId });
    if ((await redis.set(keys.sold(assetId), JSON.stringify(record), { nx: true })) !== null) out.sold.added++;
    else out.sold.kept++;
    if (inFlight && (await redis.set(keys.payTx(assetId), JSON.stringify({ payTx, payLastValid }), { nx: true })) !== null) out.payouts++;
  }

  for (const [k, e] of data.registry) {
    if (Number(await redis.hsetnx(keys.fish, k, JSON.stringify(e))) === 1) out.registry.added++;
    else out.registry.kept++;
  }

  for (const [k, n] of Object.entries(data.serial.keys)) {
    if (Number(await redis.hsetnx(keys.serialKeys, k, String(n))) === 1) out.serials.added++;
    else out.serials.kept++;
  }
  // The counter only moves up: numbers handed out in Redis since an earlier import stay taken.
  for (;;) {
    const cur = await redis.get(keys.serialLast);
    if (cur !== null && cur !== undefined && Number(cur) >= data.serial.last) {
      out.serialLast = Number(cur);
      break;
    }
    if (await redisCas(redis, keys.serialLast, cur ?? null, String(data.serial.last))) break;
  }
  return out;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const args = argv.filter((a) => !a.startsWith('--'));
  const dir = path.resolve(args[0] ?? fileURLToPath(new URL('..', import.meta.url)));
  if (!existsSync(dir)) throw new Error(`No such directory: ${dir}`);
  const prefix = process.env.MARKET_STORE_PREFIX || DEFAULT_PREFIX;
  const data = readMarketDir(dir);
  let redis = null;
  if (!dryRun) {
    const creds = redisCredentials(process.env);
    if (!creds) throw new Error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN) in the environment');
    const { Redis } = await import('@upstash/redis');
    redis = new Redis({ url: creds.url, token: creds.token, automaticDeserialization: false });
  }
  const r = await importToRedis({ redis, prefix, data, dryRun });
  const pair = ({ added, kept }) => `${added} written${dryRun ? '' : `, ${kept} already there`}`;
  console.log(`${dryRun ? '[dry run] would import' : 'Imported'} from ${dir} under "${prefix}":`);
  console.log(`  state (mint, collection): ${data.hasState ? (data.state.mint ? 'mint set' : 'no mint yet') : 'no state file'}${data.state.fishCollection ? ', collection set' : ''}`);
  console.log(`  sold records: ${pair(r.sold)}; payouts in flight: ${r.payouts}`);
  console.log(`  registry entries: ${pair(r.registry)}`);
  console.log(`  fish numbers: ${pair(r.serials)}; counter at ${r.serialLast}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`import failed: ${e?.message ?? e}`);
    process.exit(1);
  });
}

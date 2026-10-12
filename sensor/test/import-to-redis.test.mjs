import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileStore, createRedisStore } from '../market-store.mjs';
import { createSerialCounter } from '../nft-serial.mjs';
import { importToRedis, readMarketDir } from '../scripts/import-to-redis.mjs';
import { createFakeRedis } from './fake-redis.mjs';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OWNER = '7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs';
const A = 'FishA111111111111111111111111111111111111111';
const B = 'FishB111111111111111111111111111111111111111';
const C = 'FishC111111111111111111111111111111111111111';

/** A market dir as the Dell leaves it: a burned sale, a paid one, one with its payout in flight. */
function marketDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'import-redis-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const sold = {
    [A]: { seller: SELLER, transferTx: 'tA', pearls: 10, status: 'burned', at: now - 1000, payTx: 'pA', burnTx: 'bA' },
    [B]: { seller: SELLER, transferTx: 'tB', pearls: 20, status: 'paid', at: now - 500, payTx: 'pB' },
    [C]: { seller: OWNER, transferTx: 'tC', pearls: 30, status: 'paying', at: now - 100, payTx: 'pC', payLastValid: 1234 },
  };
  writeFileSync(join(dir, '.market-state.json'), JSON.stringify({ cluster: 'devnet', mint: 'Mint111', fishCollection: 'Coll111', sold }));
  const reg = (k, asset, at) => JSON.stringify({ k, asset, lastValid: null, kind: 'mint', at });
  writeFileSync(join(dir, '.market-fish.jsonl'), [reg(`${OWNER}/aa`, A, 1), reg(`${OWNER}/bb`, B, 2), 'torn line', reg(`${OWNER}/aa`, C, 3), ''].join('\n'));
  writeFileSync(join(dir, '.market-serial.json'), JSON.stringify({ last: 41, keys: { [`${OWNER}/aa`]: 7, [`${OWNER}/bb`]: 41 } }));
  // The wallet sits next to them; the import must never need it.
  writeFileSync(join(dir, '.market-keypair.json'), 'not read');
  return { dir, sold };
}

test('import: the Redis store then reads exactly what the file store does', async (t) => {
  const { dir, sold } = marketDir(t);
  const redis = createFakeRedis();
  const r = await importToRedis({ redis, prefix: 'm:', data: readMarketDir(dir) });
  assert.deepEqual(r, { sold: { added: 3, kept: 0 }, payouts: 1, registry: { added: 2, kept: 0 }, serials: { added: 2, kept: 0 }, serialLast: 41, state: true });

  const file = createFileStore({ dir });
  const fromFile = await file.openMarketState({ cluster: 'devnet' });
  const store = createRedisStore({ redis, prefix: 'm:', env: {} });
  const fromRedis = await store.openMarketState({ cluster: 'devnet' });
  assert.deepEqual(fromRedis.state, { cluster: 'devnet', mint: 'Mint111', fishCollection: 'Coll111' });
  for (const id of Object.keys(sold)) {
    assert.deepEqual(await fromRedis.ledger.get(id), fromFile.ledger.get(id), id);
    assert.equal(await fromRedis.ledger.plan(id, sold[id].seller), fromFile.ledger.plan(id, sold[id].seller), id);
  }
  // The payout in flight is still guarded: another payout for C is refused before it is sent.
  await assert.rejects(fromRedis.ledger.payPending(C, 'other', 1), (e) => e.status === 409);
  await fromRedis.ledger.loadSeller(SELLER);
  assert.deepEqual(Object.keys(fromRedis.ledger.records).sort(), [A, B]);

  const reg = store.openRegistry();
  assert.equal((await reg.get(OWNER, 'aa')).asset, C, 'the last line for a key wins, as when the file is loaded');
  assert.equal((await reg.get(OWNER, 'bb')).asset, B);

  const serials = store.openSerials();
  const fileSerials = createSerialCounter(join(dir, '.market-serial.json'));
  assert.equal(await serials.peek(OWNER, 'aa'), fileSerials.peek(OWNER, 'aa'));
  assert.equal(await serials.assign(OWNER, 'new'), 42, 'numbering carries on where the Dell stopped');
});

test('import: running it again changes nothing, and never undoes what Redis did since', async (t) => {
  const { dir } = marketDir(t);
  const redis = createFakeRedis();
  const data = readMarketDir(dir);
  await importToRedis({ redis, prefix: 'm:', data });
  const store = createRedisStore({ redis, prefix: 'm:', env: {} });
  const { ledger } = await store.openMarketState({ cluster: 'devnet' });
  await ledger.paid(C); // the payout landed after the import
  await store.openSerials().assign(OWNER, 'cc'); // 42
  const before = JSON.stringify([...redis.data].map(([k, v]) => [k, v.type === 'string' ? v.value : [...v.value]]));
  const again = await importToRedis({ redis, prefix: 'm:', data });
  assert.deepEqual(again, { sold: { added: 0, kept: 3 }, payouts: 0, registry: { added: 0, kept: 2 }, serials: { added: 0, kept: 2 }, serialLast: 42, state: true });
  const after = JSON.stringify([...redis.data].map(([k, v]) => [k, v.type === 'string' ? v.value : [...v.value]]));
  assert.equal(after, before);
  assert.equal((await ledger.get(C)).status, 'paid');
});

test('import --dry-run: counts only, nothing written', async (t) => {
  const { dir } = marketDir(t);
  const redis = createFakeRedis();
  const r = await importToRedis({ redis, data: readMarketDir(dir), dryRun: true });
  assert.deepEqual(r, { sold: { added: 3, kept: 0 }, payouts: 1, registry: { added: 2, kept: 0 }, serials: { added: 2, kept: 0 }, serialLast: 41, state: true });
  assert.equal(redis.calls.length, 0);
  assert.equal(redis.data.size, 0);
});

test('import: an empty market dir imports nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'import-redis-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const redis = createFakeRedis();
  const r = await importToRedis({ redis, data: readMarketDir(dir) });
  assert.equal(r.state, false);
  assert.equal(redis.data.get('market:state'), undefined);
  assert.equal(redis.data.get('market:serial:last').value, '0');
});

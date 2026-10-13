import assert from 'node:assert/strict';
import test from 'node:test';
import { publicKey } from '@metaplex-foundation/umi';
import { assetState, createFishCollection } from '../fish-collection.mjs';
import { FishRegistry } from '../fish-trust.mjs';
import { RedisRegistry } from '../market-store.mjs';
import { HttpError, MPL_CORE_PROGRAM } from '../market-rules.mjs';
import { createFakeRedis } from './fake-redis.mjs';

// claim() (fish-collection.mjs) is the gate before every co-signed mint and migration: one asset
// per (owner, fish). A fish whose NFT was sold (the market burns it) or burned must never be
// co-signed again, while a mint that never landed frees the fish once its blockhash expires.

const key = (n) => publicKey(new Uint8Array(32).fill(n));
const MARKET = key(1);
const OWNER = key(2);
const PRIOR = key(3);
const NEXT = key(4);
const FISH = '00c0ffee';
const SYSTEM = '11111111111111111111111111111111';

/** What devnet returns for a burned Core asset (8ETwpY…): Core still owns a 1-byte account, data 00. */
const burned = () => ({ exists: true, owner: publicKey(MPL_CORE_PROGRAM), data: new Uint8Array([0]), lamports: { basisPoints: 2155320n } });
const live = () => ({ exists: true, owner: publicKey(MPL_CORE_PROGRAM), data: new Uint8Array([1, ...new Uint8Array(40)]) });
const strayLamports = () => ({ exists: true, owner: publicKey(SYSTEM), data: new Uint8Array(0) });
const missing = () => ({ exists: false });

function setup({ account = missing, height = 100, registry = new FishRegistry() } = {}) {
  const calls = { getAccount: 0 };
  const chain = { account, height };
  const u = {
    identity: { publicKey: MARKET },
    rpc: {
      async getAccount(id) {
        calls.getAccount++;
        assert.equal(String(id), PRIOR, 'only the earlier asset is looked up');
        return chain.account();
      },
      async call(method) {
        if (method === 'getBlockHeight') return chain.height;
        throw new Error(`unexpected rpc ${method}`);
      },
    },
  };
  const fc = createFishCollection({
    u,
    state: { fishCollection: key(9) },
    save: async () => {},
    registry,
    ledger: { records: {} },
    balanceSol: async () => 1,
    log: () => {},
  });
  return { fc, chain, calls, registry };
}

const refused = (code) => (e) => e instanceof HttpError && e.status === 409 && e.extra?.code === code;

test('assetState: the burned stub devnet shows, a live asset, nothing there, stray lamports', () => {
  assert.equal(assetState(burned()), 'burned');
  assert.equal(assetState({ ...burned(), data: new Uint8Array(0) }), 'burned');
  assert.equal(assetState(live()), 'live');
  assert.equal(assetState(missing()), 'missing');
  assert.equal(assetState(strayLamports()), 'missing');
});

test('a fish with no earlier co-sign is free, and no chain lookup is needed', async () => {
  const { fc, calls } = setup();
  assert.equal(await fc.claim(OWNER, FISH, NEXT), 'free');
  assert.equal(calls.getAccount, 0);
});

test('the same asset again is a retry: signed again without a chain lookup', async () => {
  const { fc, calls, registry } = setup({ account: burned });
  registry.set(OWNER, FISH, { asset: PRIOR, lastValid: 50, kind: 'mint' });
  assert.equal(await fc.claim(OWNER, FISH, PRIOR), 'same');
  assert.equal(calls.getAccount, 0);
});

test('a live earlier asset: 409 already-minted with its address (the game adopts it)', async () => {
  const { fc, registry } = setup({ account: live, height: 1000 });
  registry.set(OWNER, FISH, { asset: PRIOR, lastValid: 50, kind: 'mint' });
  await assert.rejects(fc.claim(OWNER, FISH, NEXT), (e) => refused('already-minted')(e) && e.extra.assetId === PRIOR);
});

for (const [name, makeRegistry] of [
  ['file registry', () => new FishRegistry()],
  ['Redis registry', () => new RedisRegistry(createFakeRedis())],
]) {
  test(`${name}: a sold or burned fish is never co-signed again, before or after its blockhash expires`, async () => {
    const { fc, chain, registry } = setup({ account: burned, height: 40, registry: makeRegistry() });
    await registry.set(OWNER, FISH, { asset: PRIOR, lastValid: 50, kind: 'mint' });
    for (const height of [40, 51, 10_000]) {
      chain.height = height;
      await assert.rejects(fc.claim(OWNER, FISH, NEXT), (e) => refused('already-burned')(e) && e.extra.assetId === PRIOR, `height ${height}`);
    }
    assert.equal((await registry.get(OWNER, FISH)).asset, PRIOR, 'the registry still points at the burned asset');
  });
}

test('a migrated fish that was later burned is refused too', async () => {
  const { fc, registry } = setup({ account: burned, height: 10_000 });
  registry.set(OWNER, FISH, { asset: PRIOR, lastValid: 50, kind: 'migrate' });
  await assert.rejects(fc.claim(OWNER, FISH, NEXT), refused('already-burned'));
});

test('a mint that never landed: in flight until its blockhash expires, then free again', async () => {
  const { fc, chain, registry } = setup({ account: missing, height: 50 });
  registry.set(OWNER, FISH, { asset: PRIOR, lastValid: 50, kind: 'mint' });
  await assert.rejects(fc.claim(OWNER, FISH, NEXT), refused('mint-in-flight'));
  chain.height = 51;
  assert.equal(await fc.claim(OWNER, FISH, NEXT), 'free');
  chain.account = strayLamports; // someone sent SOL to the unused address: still nothing minted there
  assert.equal(await fc.claim(OWNER, FISH, NEXT), 'free');
});

test('an RPC failure looking up the earlier asset is never read as free', async () => {
  const errors = [
    Object.assign(new Error('429 Too Many Requests'), { status: 429 }),
    new Error('fetch failed'),
    new Error('Request timed out'),
    new Error('Internal JSON-RPC error'), // not even transient: still not "free"
  ];
  for (const err of errors) {
    const { fc, registry } = setup({
      account: () => {
        throw err;
      },
      height: 10_000,
    });
    registry.set(OWNER, FISH, { asset: PRIOR, lastValid: 50, kind: 'mint' });
    await assert.rejects(fc.claim(OWNER, FISH, NEXT), (e) => e === err, err.message);
  }
});

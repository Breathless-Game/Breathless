import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BlockheightExceededError,
  createBackoff,
  createConfirmer,
  createLimiter,
  guardRpc,
  isRateLimited,
  isTransientRpcError,
  redactRpc,
  rpcEndpoint,
} from './rpc-guard.mjs';

// The market's RPC guard, with fake RPCs and instant timers: concurrency cap, 429 backoff,
// polled confirmations, and no unhandled rejection whatever the RPC throws.

const tick = () => new Promise((r) => setImmediate(r));
const instant = () => tick(); // a sleep that returns at once (but still yields)
const RATE_LIMITED = () => new Error('429 Too Many Requests:  {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}}');

/** Record unhandled rejections during fn; node:test runs each file in its own process. */
async function noUnhandled(fn) {
  const seen = [];
  const on = (r) => seen.push(r);
  process.on('unhandledRejection', on);
  try {
    await fn();
    for (let i = 0; i < 5; i++) await tick();
  } finally {
    process.off('unhandledRejection', on);
  }
  assert.deepEqual(seen, [], `unhandled rejections: ${seen.map(String).join('; ')}`);
}

test('limiter: never more than `max` in flight, every call finishes, results in order', async () => {
  const lim = createLimiter(3);
  let active = 0;
  let peak = 0;
  const out = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      lim.run(async () => {
        active++;
        peak = Math.max(peak, active);
        for (let k = 0; k < (i % 4) + 1; k++) await tick();
        active--;
        return i;
      }),
    ),
  );
  assert.equal(peak, 3);
  assert.deepEqual(out, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(lim.active, 0);
  assert.equal(lim.queued, 0);
});

test('limiter: a call that throws frees its slot', async () => {
  const lim = createLimiter(1);
  await assert.rejects(lim.run(async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await lim.run(async () => 'next'), 'next');
  assert.equal(lim.active, 0);
});

test('backoff: retries only a 429, with growing delays; other errors are thrown at once', async () => {
  const sleeps = [];
  let t = 0;
  const b = createBackoff({ baseMs: 100, maxMs: 1000, random: () => 0.5, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  let n = 0;
  assert.equal(await b.call(async () => (++n < 3 ? Promise.reject(RATE_LIMITED()) : 'ok')), 'ok');
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [100, 200]);

  let m = 0;
  await assert.rejects(b.call(async () => { m++; throw new Error('Transaction simulation failed'); }), /simulation/);
  assert.equal(m, 1, 'a non-429 error is never retried');

  let k = 0;
  const few = createBackoff({ tries: 3, baseMs: 1, sleep: instant });
  await assert.rejects(few.call(async () => { k++; throw RATE_LIMITED(); }), /429/);
  assert.equal(k, 3, 'gives up after `tries`');
});

test('error classes: 429 and transient vs permanent', () => {
  assert.ok(isRateLimited(RATE_LIMITED()));
  assert.ok(isRateLimited({ cause: RATE_LIMITED() }));
  assert.ok(isRateLimited(new Error('failed to get recent blockhash: Error: 429 Too Many Requests')));
  assert.ok(!isRateLimited(new Error('Account does not exist')));
  assert.ok(isTransientRpcError(new TypeError('fetch failed')));
  assert.ok(isTransientRpcError(new Error('503 Service Unavailable')));
  assert.ok(!isTransientRpcError(new Error('The account of type [AssetV1] was not found at the provided address')));
});

test('rpcEndpoint and redactRpc: one env rule, and a key in the URL is never logged', () => {
  assert.equal(rpcEndpoint({}), 'https://api.devnet.solana.com');
  assert.equal(rpcEndpoint({ VITE_SOLANA_RPC: 'https://a.example' }), 'https://a.example');
  assert.equal(rpcEndpoint({ SOLANA_RPC: ' https://b.example ', VITE_SOLANA_RPC: 'https://a.example' }), 'https://b.example');
  assert.equal(rpcEndpoint({ SOLANA_RPC: '', VITE_SOLANA_RPC: 'https://a.example' }), 'https://a.example');
  assert.equal(redactRpc('https://api.devnet.solana.com'), 'https://api.devnet.solana.com');
  assert.equal(redactRpc('https://devnet.example-rpc.com/?api-key=SECRET'), 'https://devnet.example-rpc.com/…');
  assert.equal(redactRpc('https://example-rpc.com/v2/SECRET'), 'https://example-rpc.com/…');
  assert.equal(redactRpc('https://user:SECRET@example-rpc.com'), 'https://example-rpc.com');
  assert.ok(!redactRpc('not a url SECRET').includes('SECRET'));
});

/** A fake umi RPC: signatures in `landed` confirm; `fail(name, n)` makes the n-th call of a method throw. */
function fakeRpc({ landed = new Map(), height = () => 10, fail = () => null } = {}) {
  const calls = {};
  let active = 0;
  let peak = 0;
  const fn = (name, impl) => async (...args) => {
    const n = (calls[name] = (calls[name] ?? 0) + 1);
    active++;
    peak = Math.max(peak, active);
    try {
      await tick();
      const err = fail(name, n, args);
      if (err) throw err;
      return await impl(...args);
    } finally {
      active--;
    }
  };
  const rpc = {
    getEndpoint: () => 'http://fake',
    getCluster: () => 'custom',
    getAccount: fn('getAccount', async (id) => ({ id })),
    getLatestBlockhash: fn('getLatestBlockhash', async () => ({ blockhash: 'bh', lastValidBlockHeight: 100 })),
    getSignatureStatuses: fn('getSignatureStatuses', async (sigs) => sigs.map((s) => landed.get(String(s)) ?? null)),
    call: fn('call', async (method) => (method === 'getBlockHeight' ? height() : method === 'requestAirdrop' ? '1111' : null)),
    sendTransaction: fn('sendTransaction', async (tx) => tx),
    confirmTransaction: () => {
      calls.web3Confirm = (calls.web3Confirm ?? 0) + 1;
      throw new Error('web3.js confirmTransaction must never be called');
    },
  };
  return { rpc, calls, peak: () => peak };
}

test('guardRpc: caps every method together at `limit` calls in flight', async () => {
  const f = fakeRpc();
  const g = guardRpc(f.rpc, { limit: 3, sleep: instant, log: () => {} });
  assert.equal(g.getEndpoint(), 'http://fake', 'sync methods stay sync');
  await Promise.all([...Array.from({ length: 12 }, (_, i) => g.getAccount(i)), ...Array.from({ length: 6 }, () => g.getLatestBlockhash())]);
  assert.equal(f.peak(), 3);
  assert.equal(f.calls.getAccount, 12);
});

test('guardRpc: a 429 is retried and logged once, not thrown at the caller', async () => {
  const logs = [];
  const f = fakeRpc({ fail: (name, n) => (name === 'getAccount' && n <= 2 ? RATE_LIMITED() : null) });
  const g = guardRpc(f.rpc, { limit: 2, sleep: instant, log: (m) => logs.push(m), baseMs: 1 });
  assert.deepEqual(await g.getAccount('A'), { id: 'A' });
  assert.equal(f.calls.getAccount, 3);
  assert.equal(logs.filter((l) => l.includes('429')).length, 1, 'throttled to one log line');
});

test('confirmTransaction is polled (batched), never web3.js confirmTransaction', async () => {
  const landed = new Map([
    ['S1', { slot: 5, error: null, commitment: 'confirmed' }],
    ['S2', { slot: 6, error: { InstructionError: [0, 'x'] }, commitment: 'finalized' }],
  ]);
  const f = fakeRpc({ landed });
  const g = guardRpc(f.rpc, { sleep: instant, log: () => {} });
  const strategy = { type: 'blockhash', blockhash: 'bh', lastValidBlockHeight: 100 };
  const [a, b] = await Promise.all([g.confirmTransaction('S1', { strategy, commitment: 'confirmed' }), g.confirmTransaction('S2', { strategy, commitment: 'confirmed' })]);
  assert.deepEqual(a, { context: { slot: 5 }, value: { err: null } });
  assert.deepEqual(b.value.err, { InstructionError: [0, 'x'] });
  assert.equal(f.calls.getSignatureStatuses, 1, 'both waiters answered by one getSignatureStatuses');
  assert.equal(f.calls.web3Confirm, undefined);
});

test('confirmer: processed is not enough; expiry needs height > lastValid AND no status; RPC errors keep waiting', async () => {
  let height = 50;
  const statuses = new Map();
  let polls = 0;
  const c = createConfirmer({
    sleep: instant,
    getBlockHeight: async () => height,
    getSignatureStatuses: async (sigs) => {
      polls++;
      if (polls <= 2) throw RATE_LIMITED(); // a rate-limited poll is not a failure of the transaction
      return sigs.map((s) => statuses.get(s) ?? null);
    },
  });
  await noUnhandled(async () => {
    const p = c.confirm('A', { lastValidBlockHeight: 100, commitment: 'confirmed' });
    statuses.set('A', { slot: 1, error: null, commitment: 'processed' });
    height = 200; // past lastValid, but A is in a block already: keep waiting
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(c.pending(), 1);
    statuses.set('A', { slot: 1, error: null, commitment: 'confirmed' });
    assert.equal((await p).value.err, null);

    const q = c.confirm('B', { lastValidBlockHeight: 100 });
    await assert.rejects(q, (e) => e instanceof BlockheightExceededError);
  });
});

test('confirmer: gives up after timeoutMs when the RPC never answers', async () => {
  let t = 0;
  const c = createConfirmer({
    sleep: async () => {
      t += 1000;
      await tick();
    },
    now: () => t,
    timeoutMs: 5000,
    getBlockHeight: async () => Promise.reject(RATE_LIMITED()),
    getSignatureStatuses: async () => Promise.reject(RATE_LIMITED()),
  });
  await noUnhandled(() => assert.rejects(c.confirm('X', { lastValidBlockHeight: 100 }), /timed out/));
});

test('a confirmation whose every poll is rate limited never becomes an unhandled rejection', async () => {
  const f = fakeRpc({ fail: (name) => (name === 'getSignatureStatuses' || name === 'call' ? RATE_LIMITED() : null) });
  let t = 0;
  const g = guardRpc(f.rpc, {
    sleep: async (ms) => {
      t += ms || 1;
      await tick();
    },
    now: () => t,
    tries: 2,
    baseMs: 1,
    confirmIntervalMs: 1000,
    confirmTimeoutMs: 10_000,
    log: () => {},
  });
  await noUnhandled(() => assert.rejects(g.confirmTransaction('Z', { strategy: { lastValidBlockHeight: 100 } }), /timed out/));
});

test('airdrop goes through requestAirdrop + the polled confirm', async () => {
  const landed = new Map();
  const f = fakeRpc({ landed });
  const g = guardRpc(f.rpc, { sleep: instant, log: () => {} });
  // requestAirdrop returns base58 '1111' -> bytes; the fake keys statuses by String(bytes).
  const { base58 } = await import('@metaplex-foundation/umi/serializers');
  landed.set(String(base58.serialize('1111')), { slot: 1, error: null, commitment: 'confirmed' });
  await g.airdrop('Wallet1111111111111111111111111111111111111', { basisPoints: 1_000_000_000n });
  assert.equal(f.calls.web3Confirm, undefined);
});

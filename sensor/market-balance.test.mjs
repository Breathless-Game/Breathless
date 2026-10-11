import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from './market-rules.mjs';
import { createBalanceReader, isPubkey, parseBalanceQuery } from './market-balance.mjs';

// The balance read behind GET /api/market/balance, with a fake chain: account layout, caching,
// invalidation after a sale, fresh reads, and an invalidate racing a read already in flight.

const OWNER = '11111111111111111111111111111112';
const OTHER = 'So11111111111111111111111111111111111111112';
const SESSION = 'SysvarRent111111111111111111111111111111111';
const MINT = 'TokenkegQfeZyiNwAJbNbGkPFTZBdCi2kjB8vSgCnGDw'; // any valid key
const TOKEN = 'TokenkegQfeZyiNwAJbNbGkPFTZBdCi2kjB8vSgCnGDw';
const ata = (owner) => `ata-of-${owner}`;

function tokenAccount(amount) {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, BigInt(amount), true);
  return { exists: true, data, lamports: 2039280n };
}
function mintAccount(decimals) {
  const data = new Uint8Array(82);
  data[44] = decimals;
  return { exists: true, data, lamports: 1461600n };
}

function fakeChain({ amount = 0, decimals = 0, sessionLamports = 0n, mint = MINT } = {}) {
  const chain = { amount, decimals, sessionLamports, mint, calls: [], gate: null };
  chain.getAccounts = async (addrs) => {
    chain.calls.push(addrs);
    const out = addrs.map((a) => {
      if (a.startsWith('ata-of-')) return chain.amount === null ? { exists: false } : tokenAccount(chain.amount);
      if (a === chain.mint) return mintAccount(chain.decimals);
      if (a === SESSION) return chain.sessionLamports ? { exists: true, data: new Uint8Array(), lamports: chain.sessionLamports } : { exists: false };
      return { exists: false };
    });
    if (chain.gate) await chain.gate; // the chain was read, the answer is still on its way
    return out;
  };
  return chain;
}

function reader(chain, clock = { t: 1_000 }) {
  return createBalanceReader({
    getAccounts: chain.getAccounts,
    ataOf: (owner, mint, tp) => {
      assert.equal(mint, chain.mint);
      assert.equal(tp, TOKEN);
      return ata(owner);
    },
    mintInfo: async () => ({ pearlMint: chain.mint, tokenProgram: TOKEN }),
    ttlMs: 8_000,
    now: () => clock.t,
  });
}

test('query validation: owner required, session optional, both real public keys', () => {
  const q = (s) => parseBalanceQuery(new URLSearchParams(s));
  assert.deepEqual(q(`owner=${OWNER}&session=${SESSION}`), { owner: OWNER, session: SESSION, fresh: false });
  assert.deepEqual(q(`owner=${OWNER}&fresh=1`), { owner: OWNER, session: null, fresh: true });
  for (const bad of ['', 'owner=', 'owner=abc', `owner=${OWNER}0`, `owner=${OWNER}&session=nope`, 'owner=0OIl1111111111111111111111111111']) {
    assert.throws(() => q(bad), (e) => e instanceof HttpError && e.status === 400, bad);
  }
  // base58 of the right length that does not decode to 32 bytes
  assert.equal(isPubkey('z'.repeat(44)), false);
  assert.equal(isPubkey(OWNER), true);
});

test('reads PEARL, decimals and session SOL in one RPC call', async () => {
  const chain = fakeChain({ amount: 1234, sessionLamports: 250_000_000n });
  const out = await reader(chain).read({ owner: OWNER, session: SESSION });
  assert.deepEqual(out, { pearl: 1234, raw: '1234', decimals: 0, sessionSol: 0.25, at: 1_000 });
  assert.equal(chain.calls.length, 1);
  assert.deepEqual(chain.calls[0], [ata(OWNER), MINT, SESSION]);
});

test('no token account yet is 0; no session is null SOL; an unfunded session is 0', async () => {
  const chain = fakeChain({ amount: null });
  const r = reader(chain);
  assert.deepEqual(await r.read({ owner: OWNER }), { pearl: 0, raw: '0', decimals: 0, sessionSol: null, at: 1_000 });
  assert.equal((await r.read({ owner: OWNER, session: SESSION })).sessionSol, 0);
});

test('no PEARL mint yet: 0 PEARL without reading a token account', async () => {
  const chain = fakeChain({ mint: null, sessionLamports: 1_000_000_000n });
  const out = await reader(chain).read({ owner: OWNER, session: SESSION });
  assert.deepEqual(out, { pearl: 0, raw: '0', decimals: 0, sessionSol: 1, at: 1_000 });
  assert.deepEqual(chain.calls, [[SESSION]]);
  const none = fakeChain({ mint: null });
  assert.equal((await reader(none).read({ owner: OWNER })).pearl, 0);
  assert.deepEqual(none.calls, []);
});

test('decimals scale the whole amount; huge amounts stay exact as strings', async () => {
  const chain = fakeChain({ amount: 1_234_567n, decimals: 3 });
  assert.equal((await reader(chain).read({ owner: OWNER })).pearl, 1234);
  const big = fakeChain({ amount: 2n ** 64n - 1n });
  const out = await reader(big).read({ owner: OWNER });
  assert.equal(out.raw, '18446744073709551615');
  assert.equal(out.pearl, '18446744073709551615');
});

test('cached per (owner, session) for the TTL, then read again', async () => {
  const clock = { t: 1_000 };
  const chain = fakeChain({ amount: 5 });
  const r = reader(chain, clock);
  await r.read({ owner: OWNER, session: SESSION });
  chain.amount = 9;
  clock.t += 7_999;
  assert.equal((await r.read({ owner: OWNER, session: SESSION })).pearl, 5);
  assert.equal(chain.calls.length, 1);
  assert.equal((await r.read({ owner: OWNER })).pearl, 9, 'a different session is its own entry');
  clock.t += 1;
  assert.equal((await r.read({ owner: OWNER, session: SESSION })).pearl, 9);
  assert.equal(chain.calls.length, 3);
});

test('concurrent reads for the same key share one RPC call', async () => {
  const chain = fakeChain({ amount: 3 });
  const r = reader(chain);
  const outs = await Promise.all([1, 2, 3].map(() => r.read({ owner: OWNER, session: SESSION })));
  assert.deepEqual(outs.map((o) => o.pearl), [3, 3, 3]);
  assert.equal(chain.calls.length, 1);
});

test('invalidate (a sale paid the owner) and fresh=1 both skip the cache, only for that owner', async () => {
  const chain = fakeChain({ amount: 1 });
  const r = reader(chain);
  await r.read({ owner: OWNER, session: SESSION });
  await r.read({ owner: OTHER });
  chain.amount = 50;
  r.invalidate(OWNER);
  assert.equal((await r.read({ owner: OWNER, session: SESSION })).pearl, 50);
  assert.equal((await r.read({ owner: OTHER })).pearl, 1, 'another owner keeps its entry');
  chain.amount = 40;
  assert.equal((await r.read({ owner: OWNER, session: SESSION })).pearl, 50);
  assert.equal((await r.read({ owner: OWNER, session: SESSION, fresh: true })).pearl, 40);
});

test('a read in flight when the owner is invalidated does not cache its older answer', async () => {
  const chain = fakeChain({ amount: 10 });
  const r = reader(chain);
  let open;
  chain.gate = new Promise((res) => (open = res));
  const before = r.read({ owner: OWNER }); // reads the pre-sale chain
  await new Promise((res) => setImmediate(res));
  r.invalidate(OWNER); // the sale paid out meanwhile
  chain.gate = null;
  chain.amount = 25;
  const after = r.read({ owner: OWNER }); // must not join the older read
  open();
  assert.equal((await before).pearl, 10);
  assert.equal((await after).pearl, 25);
  assert.equal((await r.read({ owner: OWNER })).pearl, 25, 'the cache holds the post-sale value');
  assert.equal(chain.calls.length, 2);
});

test('the cache stays bounded', async () => {
  const chain = fakeChain({ amount: 1 });
  const r = createBalanceReader({
    getAccounts: chain.getAccounts,
    ataOf: (o) => ata(o),
    mintInfo: async () => ({ pearlMint: MINT, tokenProgram: TOKEN }),
    maxEntries: 3,
  });
  for (const s of [OWNER, OTHER, SESSION, MINT, '11111111111111111111111111111113']) await r.read({ owner: s });
  assert.equal(r.size(), 3);
});

test('GET /api/market/balance is routed: 400 on bad keys, 405 on POST, rate limited per IP', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createMarket } = await import('./market.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'balance-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Nothing listens on port 9: no chain reads are expected for these requests.
  const market = await createMarket({ rpc: 'http://127.0.0.1:9', dir, log: () => {}, clientIp: (req) => req.ip });
  async function call(method, url, ip = '1.1.1.1') {
    const req = { method, url, ip, on() {} };
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(body) {
        this.body = body ? JSON.parse(body) : null;
      },
    };
    assert.equal(await market.handle(req, res), true);
    return res;
  }
  const bad = await call('GET', '/api/market/balance?owner=nope');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /owner/);
  assert.equal((await call('GET', `/api/market/balance?owner=${OWNER}&session=xyz`)).status, 400);
  assert.equal((await call('POST', `/api/market/balance?owner=${OWNER}`)).status, 405);
  let last;
  for (let i = 0; i < 61; i++) last = await call('GET', '/api/market/balance?owner=bad', '2.2.2.2');
  assert.equal(last.status, 429);
  assert.equal((await call('GET', '/api/market/balance?owner=bad', '3.3.3.3')).status, 400, 'other IPs are unaffected');
});

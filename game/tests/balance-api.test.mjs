import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// balance-api.ts against a fake /api/market/balance: one request per read, shared while in flight,
// fresh=1 once after a local change, and null (fall back to the chain) on an older server's 404.

const src = readFileSync(new URL('../src/balance-api.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
let n = 0;
/** A fresh copy of the module (its own cache and flags) per test. */
const load = () => import('data:text/javascript;base64,' + Buffer.from(`${js}\n// ${n++}`).toString('base64'));

const OWNER = 'Owner1111111111111111111111111111111111111';
const SESSION = 'Sess1on111111111111111111111111111111111111';

function fakeFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url, 'http://x'));
    const { status = 200, body } = await respond(calls.length);
    return { status, ok: status >= 200 && status < 300, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
  };
  return calls;
}
const ok = (pearl, sessionSol = 0.5) => ({ body: { pearl, raw: String(pearl), decimals: 0, sessionSol, at: 1 } });

test('reads both balances with one request and shares it while in flight', async () => {
  const m = await load();
  const calls = fakeFetch(() => ok(42));
  const [a, b] = await Promise.all([m.readBalances(OWNER, SESSION), m.readBalances(OWNER, SESSION)]);
  assert.deepEqual(a, { pearl: 42, sessionSol: 0.5, at: 1 });
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api/market/balance');
  assert.equal(calls[0].searchParams.get('owner'), OWNER);
  assert.equal(calls[0].searchParams.get('session'), SESSION);
  assert.equal(calls[0].searchParams.get('fresh'), null);
  await m.readBalances(OWNER, null);
  assert.equal(calls[1].searchParams.get('session'), null);
});

test('a string amount (past 2^53) still reads as a number', async () => {
  const m = await load();
  fakeFetch(() => ok('12'));
  assert.equal((await m.readBalances(OWNER, SESSION)).pearl, 12);
});

test('after a local change the next read asks for fresh=1, once; a failed fresh read is retried', async () => {
  const m = await load();
  let fail = false;
  const calls = fakeFetch(() => (fail ? { status: 429, body: { error: 'Too many balance reads, slow down' } } : ok(7)));
  m.markBalanceStale();
  fail = true;
  await assert.rejects(m.readBalances(OWNER, SESSION), /Too many/);
  fail = false;
  await m.readBalances(OWNER, SESSION);
  await m.readBalances(OWNER, SESSION);
  assert.deepEqual(calls.map((u) => u.searchParams.get('fresh')), ['1', '1', null]);
});

test('an older server (404) means null, remembered so the next reads go straight to the chain', async () => {
  const m = await load();
  const calls = fakeFetch(() => ({ status: 404, body: { error: 'Not found' } }));
  assert.equal(await m.readBalances(OWNER, SESSION), null);
  assert.equal(await m.readBalances(OWNER, SESSION), null);
  assert.equal(calls.length, 1);
});

test('no market (network error or a non-JSON page) is an offline error, not a fallback', async () => {
  const m = await load();
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(m.readBalances(OWNER, SESSION), /offline/);
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('html'); } });
  await assert.rejects(m.readBalances(OWNER, SESSION), /offline/);
  fakeFetch(() => ({ status: 500, body: { error: 'boom' } }));
  await assert.rejects(m.readBalances(OWNER, SESSION), /boom/);
});

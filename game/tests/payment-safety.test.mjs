import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const js = ts.transpileModule(read('payment-safety.ts'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const memoryStore = (list = []) => {
  let saved = JSON.stringify(list);
  return { load: () => JSON.parse(saved), save: (l) => (saved = JSON.stringify(l)) };
};
const quiet = (fn) => async () => {
  const { error, warn } = console;
  console.error = console.warn = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, { error, warn });
  }
};

test('assertLanded / confirmedOrThrow: a confirmed tx with value.err throws, a clean one passes', async () => {
  assert.doesNotThrow(() => m.assertLanded({ value: { err: null } }, 'Burn'));
  assert.throws(() => m.assertLanded({ value: { err: { InstructionError: [0, 'Custom'] } } }, 'Burn'), (e) => {
    assert.ok(e instanceof m.TxFailedError);
    assert.match(e.message, /Burn failed on-chain/);
    assert.match(e.message, /InstructionError/);
    return true;
  });
  const builder = (err) => ({ sendAndConfirm: async (ctx) => ({ signature: `sig-${ctx}`, result: { value: { err } } }) });
  assert.equal(await m.confirmedOrThrow(builder(null), 'u', 'Top-up'), 'sig-u');
  await assert.rejects(m.confirmedOrThrow(builder({ err: 1 }), 'u', 'Top-up'), m.TxFailedError);
});

test('neverBroadcast: only preflight refusals count as never sent', () => {
  assert.equal(m.neverBroadcast(Object.assign(new Error('x'), { logs: [] })), true);
  assert.equal(m.neverBroadcast(new Error('Transaction simulation failed: insufficient funds')), true);
  assert.equal(m.neverBroadcast(new Error('Blockhash not found')), true);
  assert.equal(m.neverBroadcast(new Error('This transaction has already been processed')), false);
  assert.equal(m.neverBroadcast(new Error('fetch failed')), false);
  assert.equal(m.neverBroadcast(new Error('block height exceeded')), false);
  assert.equal(m.neverBroadcast(null), false);
});

test('PaymentLock: one payment at a time, a second is refused, released however the first ends', async () => {
  const lock = new m.PaymentLock();
  let release;
  let inside = 0;
  let maxInside = 0;
  const slow = () =>
    lock.run(async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => (release = r));
      inside--;
      return 'first';
    });
  const first = slow();
  assert.equal(lock.busy, true);
  await assert.rejects(lock.run(async () => 'second'), m.PaymentInProgressError);
  release();
  assert.equal(await first, 'first');
  assert.equal(lock.busy, false);
  await assert.rejects(lock.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(lock.busy, false, 'a throw releases the lock');
  assert.equal(await lock.run(async () => 'third'), 'third');
  assert.equal(maxInside, 1);
  assert.ok(m.paymentLock instanceof m.PaymentLock, 'one shared lock is exported');
});

test('verdictOf: confirmed ok/failed, expired, still unknown', () => {
  assert.equal(m.verdictOf({ error: null, commitment: 'confirmed' }), 'ok');
  assert.equal(m.verdictOf({ error: null, commitment: 'finalized' }), 'ok');
  assert.equal(m.verdictOf({ error: { x: 1 }, commitment: 'confirmed' }), 'failed');
  assert.equal(m.verdictOf({ error: null, commitment: 'processed' }), 'unknown');
  assert.equal(m.verdictOf(null, 101, 100), 'failed', 'not found after its blockhash expired');
  assert.equal(m.verdictOf(null, 100, 100), 'unknown');
  assert.equal(m.verdictOf(null, undefined, 100), 'unknown');
  assert.equal(m.verdictOf(null, 500, undefined), 'unknown');
});

test('waitForSignature: polls until settled, retries RPC errors, gives up as unknown after the timeout', quiet(async () => {
  let clock = 0;
  const base = { blockHeight: async () => 10, sleep: async (ms) => { clock += ms; }, now: () => clock };
  let calls = 0;
  const landsThird = { ...base, statuses: async () => (++calls === 1 ? Promise.reject(new Error('rpc down')) : calls < 3 ? [null] : [{ error: null, commitment: 'confirmed' }]) };
  assert.equal(await m.waitForSignature('s', 100, landsThird), 'ok');
  assert.equal(calls, 3);

  clock = 0;
  assert.equal(await m.waitForSignature('s', 5, { ...base, statuses: async () => [null] }), 'failed', 'expired blockhash');

  clock = 0;
  const v = await m.waitForSignature('s', 100, { ...base, statuses: async () => [null] }, { timeoutMs: 10_000, intervalMs: 2_000 });
  assert.equal(v, 'unknown');
  assert.ok(clock >= 10_000 && clock <= 12_000, 'bounded wait');
}));

test('reconcilePending: a landed purchase is delivered exactly once, failed and expired ones are dropped', async () => {
  const now = 1_000_000;
  const store = memoryStore([
    { signature: 'ok', what: { kind: 'upgrade' }, cost: 50, ts: now - 1000, lastValid: 100 },
    { signature: 'failed', what: { kind: 'food' }, cost: 5, ts: now - 1000, lastValid: 100 },
    { signature: 'expired', what: { kind: 'craft' }, cost: 10, ts: now - 1000, lastValid: 90 },
    { signature: 'old', what: { kind: 'craft' }, cost: 10, ts: now - m.PENDING_MAX_AGE_MS - 1 },
    { signature: 'young', what: { kind: 'craft' }, cost: 10, ts: now - 1000, lastValid: 200 },
  ]);
  const chain = {
    ok: { error: null, commitment: 'confirmed' },
    failed: { error: { InstructionError: [0, 'x'] }, commitment: 'confirmed' },
  };
  const deps = { statuses: async (sigs) => sigs.map((s) => chain[s] ?? null), blockHeight: async () => 150, now: () => now };
  const delivered = [];
  const report = await m.reconcilePending(store, deps, (rec) => delivered.push(rec.signature));
  assert.deepEqual(delivered, ['ok']);
  assert.deepEqual(report.delivered, ['ok']);
  assert.deepEqual(report.dropped.sort(), ['expired', 'failed', 'old']);
  assert.deepEqual(report.kept, ['young']);
  assert.deepEqual(store.load().map((r) => r.signature), ['young']);

  // Again (a reload, a second timer): nothing is delivered twice.
  await m.reconcilePending(store, deps, (rec) => delivered.push(rec.signature));
  assert.deepEqual(delivered, ['ok']);
});

test('reconcilePending: two overlapping settlements still deliver once', async () => {
  const store = memoryStore([{ signature: 'ok', what: 1, cost: 5, ts: Date.now() }]);
  const deps = { statuses: async () => [{ error: null, commitment: 'finalized' }], blockHeight: async () => 1 };
  let n = 0;
  await Promise.all([m.reconcilePending(store, deps, () => n++), m.reconcilePending(store, deps, () => n++)]);
  assert.equal(n, 1);
  assert.deepEqual(store.load(), []);
});

test('reconcilePending: an RPC failure changes nothing; a delivery that throws is logged and not retried', quiet(async () => {
  const rec = { signature: 'ok', what: 1, cost: 5, ts: Date.now() };
  const store = memoryStore([rec]);
  await assert.rejects(m.reconcilePending(store, { statuses: async () => { throw new Error('rpc down'); }, blockHeight: async () => 1 }, () => assert.fail()));
  assert.equal(store.load().length, 1, 'kept for next time');

  const deps = { statuses: async () => [{ error: null, commitment: 'confirmed' }], blockHeight: async () => { throw new Error('no height'); } };
  let n = 0;
  const report = await m.reconcilePending(store, deps, () => { n++; throw new Error('delivery broke'); });
  assert.equal(n, 1);
  assert.deepEqual(report.delivered, ['ok']);
  assert.deepEqual(store.load(), [], 'removed before delivery: never delivered twice');
}));

test('createPurchaseStore: per-key JSON list, junk reads as empty, addPending/takePending dedupe', () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const store = m.createPurchaseStore(() => 'deepbreath.W.pearl.purchases.pending', () => storage);
  assert.deepEqual(store.load(), []);
  data.set('deepbreath.W.pearl.purchases.pending', '{not json');
  assert.deepEqual(store.load(), []);
  m.addPending(store, { signature: 'a', what: 1, cost: 1, ts: 1 });
  m.addPending(store, { signature: 'a', what: 2, cost: 1, ts: 2 });
  assert.equal(store.load().length, 1);
  assert.equal(m.takePending(store, 'a').what, 2);
  assert.equal(m.takePending(store, 'a'), null, 'only one taker');
  assert.equal(data.has('deepbreath.W.pearl.purchases.pending'), false);
});

// ---- Source-level guards on the code that needs a wallet and a DOM ----

test('every value-moving sendAndConfirm in src goes through confirmedOrThrow', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'payment-safety.ts')) {
    assert.doesNotMatch(read(file), /\.sendAndConfirm\(/, `${file} calls sendAndConfirm without checking value.err`);
  }
});

test('spendPearls: locked, signature recorded before sending, on-chain errors and lost confirmations handled', () => {
  const src = read('pearl.ts');
  const body = src.slice(src.indexOf('export async function spendPearls('), src.indexOf('const purchases = createPurchaseStore'));
  assert.match(body, /return paymentLock\.run\(/, 'one payment at a time');
  const balance = body.indexOf('pearlAccount(info)');
  assert.ok(balance > body.indexOf('paymentLock.run('), 'the balance is read inside the lock');
  const signed = body.indexOf('.buildAndSign(u)');
  const recorded = body.indexOf('addPending(purchases');
  const sent = body.indexOf('u.rpc.sendTransaction(tx');
  assert.ok(signed > 0 && recorded > signed && sent > recorded, 'sign, record, then send');
  assert.match(body, /res\.value\.err \? 'failed' : 'ok'/, 'value.err fails the burn');
  assert.match(body, /waitForSignature\(signature/, 'a lost confirmation is looked up');
  assert.match(body, /throw new PaymentPendingError\(signature\)/);
});

test('main.ts: every Pearl purchase pays through payAndDeliver and delivers through deliverPurchase', () => {
  const src = read('main.ts');
  assert.equal(src.match(/\.spendPearls\(/g)?.length, 1, 'one call site');
  const pay = src.slice(src.indexOf('async function payAndDeliver('), src.indexOf('const paidNotApplied'));
  assert.match(pay, /\.spendPearls\(cost, purchase\)/);
  assert.match(pay, /deliverPurchase\(purchase, signature, false\)/);
  assert.match(src, /deliverPurchase\(rec\.what as Purchase, rec\.signature, true\)/, 'reconcile uses the same delivery');
  const load = src.slice(src.indexOf('function loadWalletProgress()'), src.indexOf('\n}\n', src.indexOf('function loadWalletProgress()')));
  assert.match(load, /void reconcilePurchases\(\);/, 'settled on wallet load');
  // Synthesis: the craft is validated before the burn.
  const craft = src.slice(src.indexOf('async function synthCraft('), src.indexOf('async function synthUpgrade('));
  assert.ok(craft.indexOf('craftRecipe(synthesisState, id)') < craft.indexOf('spendSynthesisPearls('), 'craft checked before paying');
  assert.match(src, /'Another payment is in progress', '另一笔付款正在进行'/);
});

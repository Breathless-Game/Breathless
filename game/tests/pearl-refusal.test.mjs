import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// pearl.ts's market errors: a /quote or /sell refused with a JSON body, and one fish refused inside a
// /quote-batch or /sell-batch answer, give the same error and the same SellOutcome (the daily PEARL
// cap's code and wait included). pearl.ts is loaded with its imports stubbed: none of them run here.

const stub = (names) => `data:text/javascript;base64,${Buffer.from(names.map((n) => `export const ${n} = () => {};`).join('\n')).toString('base64')}`;
const STUBS = {
  wallet: stub(['storageKey', 'walletState']),
  market: stub(['sellBatches']),
  'balance-api': stub(['markBalanceStale', 'readBalances']),
  'payment-safety': `data:text/javascript;base64,${Buffer.from(
    ['addPending', 'createPurchaseStore', 'neverBroadcast', 'paymentLock', 'takePending', 'waitForSignature', 'reconcilePending']
      .map((n) => `export const ${n} = () => {};`)
      .concat(['export class PaymentPendingError extends Error {}', 'export class TxFailedError extends Error {}', "export const PENDING_PURCHASES = 'p';"])
      .join('\n'),
  ).toString('base64')}`,
  'blockhash-expiry': stub(['expiryOf']),
};

const source = readFileSync(new URL('../src/pearl.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const code = outputText.replace(/from ['"]\.\/([\w-]+)['"]/g, (all, name) => {
  assert.ok(STUBS[name], `pearl.ts imports ./${name}: add a stub`);
  return `from '${STUBS[name]}'`;
});
const pearl = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const CAP = { status: 429, error: 'Daily PEARL limit reached: … it can be sold after 14:05 UTC.', code: 'daily-cap', retryAfterMs: 3_600_000 };

test('a refused /info, /quote or /sell throws a MarketError with the body\'s code and wait', async () => {
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: CAP.code, retryAfterMs: CAP.retryAfterMs, error: CAP.error }), { status: 429 });
  try {
    await assert.rejects(pearl.marketInfo(), (e) => {
      assert.ok(e instanceof pearl.MarketError);
      assert.ok(e instanceof Error);
      assert.deepEqual([e.message, e.status, e.code, e.retryAfterMs], [CAP.error, 429, 'daily-cap', 3_600_000]);
      return true;
    });
  } finally {
    globalThis.fetch = fetch0;
  }
});

test('a daily-cap fish in a batch answer becomes the same outcome as a refused single sale', () => {
  const outcome = pearl.failure('FishA', pearl.refusalOf(CAP));
  assert.deepEqual(outcome, { assetId: 'FishA', error: CAP.error, code: 'daily-cap', retryAfterMs: 3_600_000 });
  assert.deepEqual(pearl.failure('FishA', new pearl.MarketError(CAP.error, 429, 'daily-cap', 3_600_000)), outcome);
});

test('other refusals and errors keep their outcome: just the message', () => {
  assert.deepEqual(pearl.failure('FishB', pearl.refusalOf({ status: 410, error: 'Fish not found' })), { assetId: 'FishB', error: 'Fish not found' });
  assert.deepEqual(pearl.failure('FishC', new Error('Transfer failed on-chain')), { assetId: 'FishC', error: 'Transfer failed on-chain' });
  assert.deepEqual(pearl.failure('FishD', Object.assign(new Error('User rejected the request'), { code: 4001 })), {
    assetId: 'FishD',
    error: 'User rejected the request',
    rejected: true,
  });
});

// A fish the daily cap refused after its transfer: the market sends it back to the wallet (sensor/market-refund.mjs).
const marketSrc = readFileSync(new URL('../src/market.ts', import.meta.url), 'utf8');
const marketJs = ts.transpileModule(marketSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const market = await import(`data:text/javascript;base64,${Buffer.from(marketJs).toString('base64')}`);
const RETURNED = { ...CAP, refunded: true, refundTx: 'Back1111' };

test('a fish sent back carries refunded and its transfer into the outcome, from a single answer or a batch', async () => {
  assert.deepEqual(pearl.failure('FishA', pearl.refusalOf(RETURNED)), {
    assetId: 'FishA',
    error: CAP.error,
    code: 'daily-cap',
    retryAfterMs: 3_600_000,
    refunded: true,
    refundTx: 'Back1111',
  });
  assert.equal(pearl.failure('FishA', pearl.refusalOf({ ...CAP, refunded: 'pending' })).refunded, 'pending');
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(RETURNED), { status: 429 });
  try {
    await assert.rejects(pearl.marketInfo(), (e) => e instanceof pearl.MarketError && e.refunded === true && e.refundTx === 'Back1111');
  } finally {
    globalThis.fetch = fetch0;
  }
});

test('the remembered transfer of a fish sent back is forgotten; one still on its way back, or any other refusal, is kept', () => {
  const store = new Map();
  const ls0 = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => store.get(String(k)) ?? null, setItem: (k, v) => store.set(String(k), String(v)) };
  const KEY = 'undefined'; // storageKey is stubbed out
  const saved = () => Object.keys(JSON.parse(store.get(KEY) ?? '{}')).sort();
  try {
    store.set(KEY, JSON.stringify(Object.fromEntries(['A', 'B', 'C', 'D'].map((id) => [id, { mode: 'server', transferTx: 'T' }]))));
    assert.equal(pearl.forgetReturned('A', pearl.refusalOf(RETURNED)), true);
    assert.equal(pearl.forgetReturned('B', pearl.refusalOf({ ...CAP, refunded: 'pending' })), false);
    assert.equal(pearl.forgetReturned('C', pearl.refusalOf(CAP)), false);
    assert.equal(pearl.forgetReturned('D', new Error('Sale did not finish')), false);
    assert.deepEqual(saved(), ['B', 'C', 'D']);
  } finally {
    globalThis.localStorage = ls0;
  }
});

test('the player is told the fish went back to the wallet, and when it sells again (UTC); other errors keep their text', () => {
  const now = Date.UTC(2026, 9, 15, 13, 5);
  const note = market.returnedFishNote(pearl.failure('FishA', pearl.refusalOf(RETURNED)), now);
  assert.deepEqual(note, {
    en: 'Daily PEARL limit reached — your fish was returned to your wallet; you can sell it again after 14:05 UTC.',
    zh: '已达每日 PEARL 上限——这条鱼已退回你的钱包，14:05 UTC 之后可以再次出售。',
  });
  assert.match(market.returnedFishNote({ ...RETURNED, refunded: 'pending' }, now).en, /is being returned to your wallet; .* after 14:05 UTC/);
  assert.equal(market.returnedFishNote(pearl.failure('FishA', pearl.refusalOf(CAP)), now), null, 'a cap refusal before the transfer: the server text');
  assert.equal(market.returnedFishNote({ error: 'Fish not found' }, now), null);
});

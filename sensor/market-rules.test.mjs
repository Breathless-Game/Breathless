import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MAX_MULTIPLIER,
  MPL_CORE_PROGRAM,
  RARITY_VALUE,
  RateLimiter,
  SoldLedger,
  ZONES,
  appraise,
  catchValue,
  checkTransferTx,
  maxPearls,
  parseQuoteBody,
  parseSellBody,
  singleFlight,
} from './market-rules.mjs';

const attrs = (o) => Object.entries(o).map(([key, value]) => ({ key, value: String(value) }));

test('the mirrored rarity values and zones match game/src/fish.ts', async () => {
  const src = await readFile(new URL('../game/src/fish.ts', import.meta.url), 'utf8');
  for (const [rarity, value] of Object.entries(RARITY_VALUE)) {
    const m = src.match(new RegExp(`^\\s*${rarity}: \\{[^\\n]*\\bvalue: (\\d+)`, 'm'));
    assert.ok(m, `RARITY.${rarity} not found in fish.ts`);
    assert.equal(Number(m[1]), value, `RARITY.${rarity}.value`);
  }
  const multipliers = [...src.matchAll(/rewardMultiplier: ([\d.]+),\s*top: (\d+),\s*bottom: (\d+)/g)].map((m) => m.slice(1).map(Number));
  assert.deepEqual(multipliers, ZONES.map((z) => [z.rewardMultiplier, z.top, z.bottom]));
});

test('catch value is rarity value x zone multiplier, like rollFish', () => {
  assert.equal(catchValue('common', 5), 1);
  assert.equal(catchValue('rare', 25), 16);
  assert.equal(catchValue('mythic', 50), 2000);
  assert.equal(catchValue('legendary', 400), 375); // below the last zone counts as the last zone
  assert.equal(maxPearls('mythic'), 800 * MAX_MULTIPLIER);
});

test('appraise recomputes the value from on-chain rarity and depth (chain.ts shape)', () => {
  const r = appraise(attrs({ rarity: 'epic', species: 'Ghost Angelfish', depth: 40, seed: 'deadbeef' }));
  assert.deepEqual(r, { ok: true, pearls: 88, rarity: 'epic', depth: 40, cap: 210 });
});

test('appraise accepts an on-chain catch value up to the rarity cap and rejects absurd ones', () => {
  assert.equal(appraise(attrs({ rarity: 'rare', depth: 10, 'Catch value': 60 })).pearls, 60);
  assert.equal(appraise(attrs({ rarity: 'rare', depth: 10, value: 7 })).pearls, 7);
  const over = appraise(attrs({ rarity: 'rare', depth: 10, 'Catch value': 61 }));
  assert.equal(over.ok, false);
  assert.match(over.reason, /over the rare cap of 60/);
  for (const bad of ['0', '-5', '1.5', '1e400', 'lots', '9007199254740993']) {
    assert.equal(appraise(attrs({ rarity: 'mythic', depth: 50, 'Catch value': bad })).ok, false, bad);
  }
});

test('appraise rejects unknown rarities and missing or silly depths', () => {
  assert.equal(appraise(attrs({ rarity: 'godlike', depth: 10 })).ok, false);
  assert.equal(appraise(attrs({ rarity: '__proto__', depth: 10 })).ok, false);
  assert.equal(appraise(attrs({ rarity: 'rare' })).ok, false);
  assert.equal(appraise(attrs({ rarity: 'rare', depth: -1 })).ok, false);
  assert.equal(appraise(attrs({ rarity: 'rare', depth: 'NaN' })).ok, false);
  assert.equal(appraise(undefined).ok, false);
});

test('appraise clamps to the program config max_value, which arrives as a u64 bigint', () => {
  const fish = attrs({ rarity: 'mythic', depth: 50 });
  assert.equal(appraise(fish, { maxValue: 500n }).pearls, 500);
  assert.equal(appraise(fish, { maxValue: 1_000_000n }).pearls, 2000);
  assert.equal(appraise(fish, { maxValue: 0n }).ok, false);
  // The rarity cap is a rejection, not a clamp: an absurd claim never sells.
  assert.equal(appraise(attrs({ rarity: 'common', depth: 1, value: 999 }), { maxValue: 10n }).ok, false);
});

test('parseQuoteBody and parseSellBody only let well-formed base58 through', () => {
  const ok = {
    assetId: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
    seller: '11111111111111111111111111111111',
  };
  assert.deepEqual(parseQuoteBody({ ...ok, extra: 1 }), ok);
  assert.throws(() => parseQuoteBody(null), /JSON object/);
  assert.throws(() => parseQuoteBody({ ...ok, assetId: 'not base58 0OIl' }), /assetId/);
  assert.throws(() => parseQuoteBody({ ...ok, seller: 42 }), /seller/);
  const sell = { ...ok, transferTx: '5'.repeat(88) };
  assert.deepEqual(parseSellBody(sell), sell);
  assert.throws(() => parseSellBody({ ...ok, transferTx: 'abc' }), /transferTx/);
  assert.throws(() => parseSellBody({ ...sell, seller: undefined }), /seller/);
});

const ASSET = 'Asset1111111111111111111111111111111111111';
const SELLER = 'Se11er111111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const OTHER = 'Other111111111111111111111111111111111111';

function transferTx({ feePayer = SELLER, newOwner = MARKET, asset = ASSET, discriminator = 14, err = null } = {}) {
  // accounts: [feePayer(signer), asset, newOwner, core program]
  return {
    message: {
      header: { numRequiredSignatures: 1 },
      accounts: [feePayer, asset, newOwner, MPL_CORE_PROGRAM],
      // TransferV1 accounts: asset, collection(placeholder), payer, authority, newOwner
      instructions: [{ programIndex: 3, accountIndexes: [1, 3, 0, 0, 2, 3, 3], data: Uint8Array.of(discriminator, 0) }],
    },
    meta: { err, loadedAddresses: { writable: [], readonly: [] } },
  };
}

test('server mode: checkTransferTx accepts a seller-signed core transfer of the asset to the market', () => {
  const ctx = { assetId: ASSET, seller: SELLER, market: MARKET };
  assert.equal(checkTransferTx(transferTx(), ctx), null);
  assert.match(checkTransferTx(null, ctx), /not found/);
  assert.match(checkTransferTx(transferTx({ err: { InstructionError: [0, 'x'] } }), ctx), /failed/);
  assert.match(checkTransferTx(transferTx({ feePayer: OTHER }), ctx), /seller/);
  assert.match(checkTransferTx(transferTx({ newOwner: OTHER }), ctx), /not a transfer/);
  assert.match(checkTransferTx(transferTx({ asset: OTHER }), ctx), /not a transfer/);
  assert.match(checkTransferTx(transferTx({ discriminator: 0 }), ctx), /not a transfer/); // e.g. a CreateV1
});

test('server mode ledger: a sale moves paying -> paid -> burned and a retry returns the stored result', () => {
  let saves = 0;
  const book = new SoldLedger({}, () => saves++);
  assert.equal(book.plan(ASSET, SELLER), 'new');
  book.begin(ASSET, { seller: SELLER, transferTx: 'tx1', pearls: 16 });
  assert.equal(book.plan(ASSET, SELLER), 'resume');
  assert.equal(book.plan(ASSET, OTHER), 'conflict');
  book.payPending(ASSET, 'pay1', 123);
  book.paid(ASSET);
  assert.equal(book.plan(ASSET, SELLER), 'burn');
  book.burned(ASSET, 'burn1');
  assert.equal(book.plan(ASSET, SELLER), 'done');
  assert.deepEqual(book.result(ASSET), { pearls: 16, tx: 'pay1', extra: ['tx1', 'burn1'] });
  assert.equal(saves, 4);
  assert.throws(() => book.begin(ASSET, { seller: SELLER, transferTx: 'tx2', pearls: 16 }), /already/);
});

test('server mode ledger: a dropped pay tx can be paid again, and state survives a reload', () => {
  const book = new SoldLedger();
  book.begin(ASSET, { seller: SELLER, transferTx: 'tx1', pearls: 5 });
  book.payPending(ASSET, 'pay1', 99);
  book.payDropped(ASSET);
  assert.equal(book.get(ASSET).payTx, undefined);
  assert.equal(book.plan(ASSET, SELLER), 'resume');
  const reloaded = new SoldLedger(JSON.parse(JSON.stringify(book.toJSON())));
  assert.equal(reloaded.plan(ASSET, SELLER), 'resume');
  assert.equal(reloaded.get(ASSET).pearls, 5);
});

test('server mode: singleFlight runs concurrent same-key calls once and pays once', async () => {
  const map = new Map();
  const book = new SoldLedger();
  let payments = 0;
  const sell = () =>
    singleFlight(map, ASSET, async () => {
      if (book.plan(ASSET, SELLER) === 'new') {
        await new Promise((r) => setTimeout(r, 10));
        book.begin(ASSET, { seller: SELLER, transferTx: 'tx', pearls: 3 });
        payments++;
        book.paid(ASSET);
        book.burned(ASSET, 'b');
      }
      return book.result(ASSET);
    });
  const results = await Promise.all([sell(), sell(), sell()]);
  assert.equal(payments, 1);
  assert.deepEqual(results[0], results[2]);
  assert.equal(map.size, 0);
  await sell(); // a later retry hits the ledger, not the chain
  assert.equal(payments, 1);
});

test('rate limiter allows `limit` hits per window per key', () => {
  const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(rl.allow('a', 0), true);
  assert.equal(rl.allow('a', 10), true);
  assert.equal(rl.allow('a', 20), false);
  assert.equal(rl.allow('b', 20), true);
  assert.equal(rl.allow('a', 1000), true);
});

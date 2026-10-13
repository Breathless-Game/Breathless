import assert from 'node:assert/strict';
import test from 'node:test';
import { burnBlocker, createBurnRetry, createSweep } from './market-burn.mjs';
import { SoldLedger } from './market-rules.mjs';

// Burns that fail after a payout are retried, and the sweep burns the fish the ledger says were
// paid but not burned, one cheap account fetch each, without ever listing the chain.

const MARKET = 'Market11111111111111111111111111111111111';
const PLAYER = 'Se11er111111111111111111111111111111111111';
const COLL = 'Co11ection1111111111111111111111111111111';
const OTHER_COLL = 'OtherCo11ection111111111111111111111111111';
const tick = () => new Promise((r) => setImmediate(r));

/** Timers the test fires by hand: [{ fn, ms }]. */
function manualTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, ms, unref() {} };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    async fireNext() {
      const t = timers.shift();
      t.fn();
      for (let i = 0; i < 5; i++) await tick();
      return t.ms;
    },
  };
}

test('a failed burn is retried with backoff until it lands, once per fish', async () => {
  const clock = manualTimers();
  let attempts = 0;
  const logs = [];
  const retry = createBurnRetry({
    burnOnce: async (id) => {
      attempts++;
      if (attempts < 3) throw new Error('429 Too Many Requests');
      return `burn-${id}`;
    },
    log: (m) => logs.push(m),
    delaysMs: [10, 20, 40],
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  retry.retry('FishA');
  retry.retry('FishA'); // a second failure report for the same fish while it is queued: still one timer
  assert.equal(clock.timers.length, 1);
  assert.equal(await clock.fireNext(), 10);
  assert.equal(await clock.fireNext(), 20);
  assert.equal(await clock.fireNext(), 40);
  assert.equal(attempts, 3);
  assert.equal(retry.has('FishA'), false);
  assert.equal(clock.timers.length, 0);
  assert.ok(logs.at(-1).includes('retried ok'));
});

test('burn retries give up after the last delay (the sweep takes over) and never throw', async () => {
  const clock = manualTimers();
  const logs = [];
  const retry = createBurnRetry({
    burnOnce: async () => {
      throw new Error('429 Too Many Requests');
    },
    log: (m) => logs.push(m),
    delaysMs: [1, 2],
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  retry.retry('FishB');
  await clock.fireNext();
  await clock.fireNext();
  assert.equal(clock.timers.length, 0);
  assert.equal(retry.has('FishB'), false);
  assert.ok(logs.at(-1).includes('next sweep'));
});

const asset = (id, { owner = MARKET, coll = COLL, type = 'Collection' } = {}) => ({ publicKey: id, owner, updateAuthority: { type, address: coll } });

function ledgerWith(entries) {
  const l = new SoldLedger();
  let at = 1_000;
  for (const [id, status] of Object.entries(entries)) {
    l.begin(id, { seller: PLAYER, transferTx: 'tx', pearls: 1 }, at++);
    if (status !== 'paying') l.paid(id);
    if (status === 'burned') l.burned(id, '');
  }
  return l;
}

/** A chain of `assets` by id behind loadAsset; `fail(id, n)` may throw for the n-th fetch overall. */
function fakeChain(assets, fail = () => {}) {
  const byId = new Map(assets.map((a) => [a.publicKey, a]));
  const fetched = [];
  return {
    fetched,
    loadAsset: async (id) => {
      fetched.push(id);
      fail(id, fetched.length);
      return byId.get(id) ?? null;
    },
  };
}

const noSleep = async () => {};

/** A sweep over `ledger` and `chain`; `listOwned` is passed too and must never be called. */
function sweepOver(ledger, chain, { burnOnce, ...opts } = {}) {
  const burned = [];
  const logs = [];
  const sweep = createSweep({
    listOwned: async () => {
      throw new Error('the sweep must not list the chain (getProgramAccounts)');
    },
    collection: () => COLL,
    market: MARKET,
    ledger,
    loadAsset: chain.loadAsset,
    burnOnce:
      burnOnce ??
      (async (id, a) => {
        assert.equal(a?.publicKey, id, 'burnOnce gets the asset the sweep already fetched');
        burned.push(id);
        ledger.burned(id, `sig-${id}`);
        return `sig-${id}`;
      }),
    log: (m) => logs.push(m),
    sleep: noSleep,
    ...opts,
  });
  return { sweep, burned, logs };
}

test('SoldLedger.unburned: paid, not burned, not set aside; oldest first; bounded', () => {
  const ledger = ledgerWith({ B: 'paid', A: 'paid', Burned: 'burned', Paying: 'paying', C: 'paid' });
  assert.deepEqual(ledger.unburned(), ['B', 'A', 'C']);
  assert.deepEqual(ledger.unburned(2), ['B', 'A']);
  ledger.skipBurn('A', 'owned by someone else');
  assert.deepEqual(ledger.unburned(), ['B', 'C']);
  assert.equal(ledger.get('A').status, 'paid', 'set aside is not burned');
  ledger.burned('B', 'sig');
  assert.deepEqual(ledger.unburned(), ['C']);
});

test('burnBlocker: only the market\'s fish of our collection may be burned', () => {
  assert.equal(burnBlocker(asset('X'), { market: MARKET, collection: COLL }), null);
  assert.match(burnBlocker(asset('X', { owner: PLAYER }), { market: MARKET, collection: COLL }), /not the market/);
  assert.match(burnBlocker(asset('X', { coll: OTHER_COLL }), { market: MARKET, collection: COLL }), /collection/);
  assert.match(burnBlocker(asset('X', { type: 'Address', coll: MARKET }), { market: MARKET, collection: COLL }), /collection/);
});

test('the sweep burns paid-unburned fish from the ledger and settles the rest without burning', async () => {
  const ledger = ledgerWith({
    Paid: 'paid', // sold, paid, burn failed: burn it
    Gone: 'paid', // burned already (the record missed it): settle it as burned, no transaction
    PlayerOwned: 'paid', // the market does not hold it: set aside, never burned
    OtherColl: 'paid', // not a Breathless fish: set aside
    Paying: 'paying', // payment unresolved: the sale desk's job
    Done: 'burned', // finished
  });
  const chain = fakeChain([asset('Paid'), asset('PlayerOwned', { owner: PLAYER }), asset('OtherColl', { coll: OTHER_COLL }), asset('Paying'), asset('Done')]);
  const { sweep, burned, logs } = sweepOver(ledger, chain);
  assert.deepEqual(await sweep.run(), { burned: 1, settled: 1, skipped: 2, failed: 0, left: 0, rateLimited: false });
  assert.deepEqual(burned, ['Paid']);
  assert.deepEqual(chain.fetched, ['Paid', 'Gone', 'PlayerOwned', 'OtherColl'], 'one fetch per candidate, nothing else');
  assert.equal(ledger.get('Gone').status, 'burned');
  assert.equal(ledger.get('PlayerOwned').status, 'paid');
  assert.match(ledger.get('PlayerOwned').burnSkipped, /not the market/);
  assert.ok(logs.some((l) => l.includes('not burning paid fish PlayerOwned')));
  assert.deepEqual(ledger.unburned(), [], 'every candidate left the list');
  // Nothing to do next time: no fetch at all.
  assert.deepEqual(await sweep.run(), { burned: 0, settled: 0, skipped: 0, failed: 0, left: 0, rateLimited: false });
  assert.equal(chain.fetched.length, 4);
});

test('a sweep burns at most maxPerRun, keeps going past a failed burn, spaces its calls, and does nothing before the collection exists', async () => {
  const ids = Array.from({ length: 5 }, (_, i) => `F${i}`);
  const ledger = ledgerWith(Object.fromEntries(ids.map((id) => [id, 'paid'])));
  const chain = fakeChain(ids.map((id) => asset(id)));
  const burned = [];
  const sleeps = [];
  let coll = null;
  const sweep = createSweep({
    collection: () => coll,
    market: MARKET,
    ledger,
    loadAsset: chain.loadAsset,
    maxPerRun: 3,
    gapMs: 7,
    sleep: async (ms) => sleeps.push(ms),
    burnOnce: async (id) => {
      if (id === 'F1') throw new Error('burn transaction failed on-chain: {"InstructionError":[0,"Custom"]}');
      burned.push(id);
      ledger.burned(id, 'sig');
    },
  });
  assert.deepEqual(await sweep.run(), { burned: 0, settled: 0, skipped: 0, failed: 0, left: 0, rateLimited: false });
  assert.equal(chain.fetched.length, 0);
  coll = COLL;
  assert.deepEqual(await sweep.run(), { burned: 2, settled: 0, skipped: 0, failed: 1, left: 1, rateLimited: false });
  assert.deepEqual(burned, ['F0', 'F2']);
  assert.deepEqual(sleeps, [7, 7], 'a gap between fish, none before the first');
  // The failed one stays on the list (oldest first) and is tried again with the rest.
  assert.deepEqual(ledger.unburned(), ['F1', 'F3', 'F4']);
});

test('a 429 mid-sweep stops it early without throwing; the rest wait for the next sweep', async () => {
  const ids = ['A', 'B', 'C', 'D'];
  const ledger = ledgerWith(Object.fromEntries(ids.map((id) => [id, 'paid'])));
  let limited = true;
  const chain = fakeChain(
    ids.map((id) => asset(id)),
    (id) => {
      if (limited && id === 'B') throw new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests from your IP"}}');
    },
  );
  const { sweep, burned, logs } = sweepOver(ledger, chain);
  assert.deepEqual(await sweep.run(), { burned: 1, settled: 0, skipped: 0, failed: 0, left: 3, rateLimited: true });
  assert.deepEqual(burned, ['A']);
  assert.deepEqual(chain.fetched, ['A', 'B'], 'nothing after the 429');
  assert.ok(logs.some((l) => l.includes('rate limited') && l.includes('left for the next sweep')));
  assert.ok(!logs.some((l) => l.includes('sweep failed')));
  assert.deepEqual(ledger.unburned(), ['B', 'C', 'D']);
  // A 429 from the burn itself stops the sweep the same way.
  limited = false;
  const r2 = sweepOver(ledger, chain, {
    burnOnce: async (id) => {
      if (id === 'C') throw new Error('429 Too Many Requests');
      ledger.burned(id, 'sig');
    },
  });
  assert.deepEqual(await r2.sweep.run(), { burned: 1, settled: 0, skipped: 0, failed: 0, left: 2, rateLimited: true });
  const r3 = sweepOver(ledger, chain);
  assert.deepEqual(await r3.sweep.run(), { burned: 2, settled: 0, skipped: 0, failed: 0, left: 0, rateLimited: false });
  assert.deepEqual(ledger.unburned(), []);
});

test('a sweep whose ledger listing fails logs and resolves: no unhandled rejection', async () => {
  const seen = [];
  const on = (r) => seen.push(r);
  process.on('unhandledRejection', on);
  const logs = [];
  let listings = 0;
  try {
    const sweep = createSweep({
      collection: () => COLL,
      market: MARKET,
      ledger: {
        unburned: async () => {
          listings++;
          throw new Error('Upstash: 503 Service Unavailable');
        },
      },
      loadAsset: async () => null,
      burnOnce: async () => {},
      log: (m) => logs.push(m),
    });
    // Two overlapping runs share one sweep.
    const [a, b] = await Promise.all([sweep.run(), sweep.run()]);
    assert.equal(a, null);
    assert.equal(b, null);
    for (let i = 0; i < 5; i++) await tick();
  } finally {
    process.off('unhandledRejection', on);
  }
  assert.deepEqual(seen, []);
  assert.equal(listings, 1);
  assert.equal(logs.filter((l) => l.includes('sweep failed')).length, 1);
});

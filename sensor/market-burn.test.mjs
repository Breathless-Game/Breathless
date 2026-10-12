import assert from 'node:assert/strict';
import test from 'node:test';
import { createBurnRetry, createSweep, pickStranded } from './market-burn.mjs';
import { SoldLedger } from './market-rules.mjs';

// Burns that fail after a payout are retried, and the sweep burns the paid fish the market
// wallet still holds, and nothing else.

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
  for (const [id, status] of Object.entries(entries)) {
    l.begin(id, { seller: PLAYER, transferTx: 'tx', pearls: 1 });
    if (status !== 'paying') l.paid(id);
    if (status === 'burned') l.burned(id, '');
  }
  return l;
}

const ON_CHAIN = [
  asset('Paid'), // sold, paid, burn failed: burn it
  asset('MarkedBurned'), // the ledger says burned but it still exists: burn it
  asset('NeverSold'), // transferred to the market, /sell never came: the player is owed, leave it
  asset('Paying'), // payment unresolved: the sale desk's job
  asset('PlayerOwned', { owner: PLAYER }), // not ours
  asset('OtherColl', { coll: OTHER_COLL }), // not a Breathless fish
  asset('NoColl', { type: 'Address', coll: MARKET }), // not in a collection
];
const LEDGER = { Paid: 'paid', MarkedBurned: 'burned', Paying: 'paying', PlayerOwned: 'paid', OtherColl: 'paid', NoColl: 'paid' };

test('pickStranded: only market-owned fish of our collection that the ledger says were paid', () => {
  const { burn, unpaid } = pickStranded(ON_CHAIN, { market: MARKET, collection: COLL, ledger: ledgerWith(LEDGER) });
  assert.deepEqual(burn, ['Paid', 'MarkedBurned']);
  assert.deepEqual(unpaid, ['NeverSold']);
});

test('the start-up sweep burns exactly the paid collection fish the market wallet owns', async () => {
  const burned = [];
  const logs = [];
  const sweep = createSweep({
    listOwned: async () => ON_CHAIN,
    collection: () => COLL,
    market: MARKET,
    ledger: ledgerWith(LEDGER),
    burnOnce: async (id) => {
      burned.push(id);
      return `sig-${id}`;
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(await sweep.run(), { burned: 2, failed: 0, left: 0, unpaid: 1 });
  assert.deepEqual(burned, ['Paid', 'MarkedBurned']);
  assert.ok(logs.some((l) => l.includes('1 transferred but never sold')));
});

test('a sweep burns at most maxPerRun, keeps going past a failed burn, and does nothing before the collection exists', async () => {
  const many = Array.from({ length: 5 }, (_, i) => asset(`F${i}`));
  const ledger = ledgerWith(Object.fromEntries(many.map((a) => [a.publicKey, 'paid'])));
  const burned = [];
  let coll = null;
  const sweep = createSweep({
    listOwned: async () => many,
    collection: () => coll,
    market: MARKET,
    ledger,
    maxPerRun: 3,
    burnOnce: async (id) => {
      if (id === 'F1') throw new Error('429 Too Many Requests');
      burned.push(id);
    },
  });
  assert.deepEqual(await sweep.run(), { burned: 0, failed: 0, left: 0, unpaid: 0 });
  coll = COLL;
  assert.deepEqual(await sweep.run(), { burned: 2, failed: 1, left: 2, unpaid: 0 });
  assert.deepEqual(burned, ['F0', 'F2']);
});

test('a sweep whose listing is rate limited logs and resolves: no unhandled rejection', async () => {
  const seen = [];
  const on = (r) => seen.push(r);
  process.on('unhandledRejection', on);
  const logs = [];
  try {
    const sweep = createSweep({
      listOwned: async () => {
        throw new Error('429 Too Many Requests');
      },
      collection: () => COLL,
      market: MARKET,
      ledger: new SoldLedger(),
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
  assert.equal(logs.filter((l) => l.includes('sweep failed')).length, 1);
});

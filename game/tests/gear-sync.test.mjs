import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The background sync of the Boat and Dive Kit NFTs (src/gear-sync.ts), run with a fake chain and
// fake timers: first mint, coalescing, one transaction at a time, waiting for SOL, persistence across
// reloads, backoff and pause, and another browser's assets.
const transpile = async (file) =>
  ts.transpileModule(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const nftUrl = dataUrl(await transpile('gear-nft.ts'));
const G = await import(nftUrl);
const { GearSync, GEAR_QUIET_MS, GEAR_MAX_WAIT_MS, GEAR_START_DELAY_MS } = await import(
  dataUrl((await transpile('gear-sync.ts')).replace(/from ['"]\.\/gear-nft['"]/, `from '${nftUrl}'`)),
);

const SESSION = 'Sess1111111111111111111111111111111111111111';
const OWNER_KEY = 'deepbreath.Owner11111111111111111111111111111111.gear-nft';
let assetN = 0;
const newAsset = () => `Asset${String(++assetN).padStart(39, '1')}`.replace(/0/g, '2');
const tx = () => `Sig${String(Math.random()).slice(2).replace(/0/g, '9')}`.padEnd(64, 'z');

/** Timers that only move when the test says so. */
function fakeTimers() {
  let now = 1_000_000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(i) {
      timers.delete(i);
    },
    pending: () => timers.size,
    /** Move the clock, firing due timers in order and letting the promises they start settle. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
      await settle();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A chain that records every call. `balance` and `fail` can be changed mid-test. */
function fakeChain() {
  const chain = {
    balance: 1,
    airdropOk: false,
    fail: null, // an Error to throw from the next mint/update calls
    onChain: new Map(), // asset -> { uri, attributes, authority }
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    gate: null, // a promise every send waits for
    async balanceSol() {
      return chain.balance;
    },
    async airdrop() {
      chain.calls.push({ op: 'airdrop' });
      if (!chain.airdropOk) throw new Error('429 Too Many Requests');
      chain.balance += 1;
    },
    keys: 0,
    newGearKey() {
      const n = ++chain.keys;
      return Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + n) % 256);
    },
    async send(op, req, fn) {
      chain.inFlight++;
      chain.maxInFlight = Math.max(chain.maxInFlight, chain.inFlight);
      try {
        if (chain.gate) await chain.gate;
        if (chain.fail) throw chain.fail;
        chain.calls.push({ op, ...req });
        return fn();
      } finally {
        chain.inFlight--;
      }
    },
    keyAssets: new Map(), // secret (joined) -> asset address, so a reused secret gives the same address
    mintGear(req) {
      const k = Array.from(req.secret).join(',');
      if (!chain.keyAssets.has(k)) chain.keyAssets.set(k, newAsset());
      const asset = chain.keyAssets.get(k);
      if (chain.onChain.has(asset)) return Promise.resolve({ asset, signature: null, uri: chain.onChain.get(asset).uri });
      return chain.send('mint', req, () => {
        const uri = `https://origin.test${req.path}`;
        chain.onChain.set(asset, { uri, attributes: req.attributes, authority: SESSION });
        return { asset, signature: tx(), uri };
      });
    },
    updateGear(req) {
      const a = chain.onChain.get(req.asset);
      if (!a) return Promise.resolve({ status: 'missing' });
      if (a.authority !== SESSION) return Promise.resolve({ status: 'not-ours' });
      return chain.send('update', req, () => {
        a.uri = `https://origin.test${req.path}`;
        a.attributes = req.attributes;
        return { status: 'updated', signature: tx() };
      });
    },
  };
  return chain;
}

function setup({ store = new Map(), chain = fakeChain(), timers = fakeTimers(), levels } = {}) {
  const state = levels ?? {
    boat: G.normalizeBoat({ ship: 0 }),
    kit: G.normalizeKit({}),
  };
  const kv = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let redraws = 0;
  const sync = new GearSync({
    key: () => OWNER_KEY,
    store: kv,
    session: () => SESSION,
    snapshot: () => ({ boat: G.normalizeBoat(state.boat), kit: G.normalizeKit(state.kit) }),
    loadChain: async () => chain,
    isFundsError: (m) => /insufficient|not enough/i.test(m),
    timers,
    changed: () => redraws++,
  });
  return { sync, chain, timers, store, state, redraws: () => redraws };
}

const ops = (chain, op) => chain.calls.filter((c) => c.op === op);
const attr = (list, key) => list.find((a) => a.key === key)?.value;

test('first login mints the Boat and the Dive Kit once and remembers them per owner', async () => {
  const t = setup();
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  const mints = ops(t.chain, 'mint');
  assert.deepEqual(mints.map((m) => m.kind), ['boat', 'kit']);
  assert.deepEqual(mints.map((m) => m.name), ['Breathless Boat', 'Breathless Dive Kit']);
  assert.equal(attr(mints[1].attributes, 'net'), '1');
  const rec = JSON.parse(t.store.get(OWNER_KEY));
  assert.ok(rec.boat.asset && rec.kit.asset);
  assert.equal(rec.kit.authority, SESSION);
  assert.equal(rec.kit.synced, G.gearMetaPath('kit', { boat: t.state.boat, kit: G.normalizeKit({}) }));
  assert.equal(rec.kit.pendingKey, undefined);
  assert.equal(t.sync.status('boat').state, 'synced');
  assert.equal(t.sync.status('kit').state, 'synced');

  // A reload: same record, nothing to do.
  const again = setup({ store: t.store, chain: t.chain });
  again.sync.start();
  await again.timers.advance(GEAR_START_DELAY_MS + 1000);
  assert.equal(t.chain.calls.length, 2);
});

test('quick upgrades coalesce into ONE update with the latest absolute levels', async () => {
  const t = setup();
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  t.chain.calls.length = 0;

  t.state.kit.net = 2;
  t.sync.levelsChanged();
  assert.equal(t.sync.status('kit').state, 'syncing'); // shown at once, sent after the quiet period
  await t.timers.advance(1000);
  t.state.kit.net = 3;
  t.state.kit.fins = 2;
  t.sync.levelsChanged();
  await t.timers.advance(1000);
  t.sync.levelsChanged(); // e.g. a pearl balance refresh: no level moved
  await t.timers.advance(GEAR_QUIET_MS - 1);
  assert.equal(t.chain.calls.length, 0, 'nothing sent while changes are still settling');
  await t.timers.advance(10);
  const updates = ops(t.chain, 'update');
  assert.equal(updates.length, 1);
  assert.equal(attr(updates[0].attributes, 'net'), '3');
  assert.equal(attr(updates[0].attributes, 'fins'), '2');
  assert.match(updates[0].path, /\/kit\/1-1-3-2-1-1-1\//);
  assert.equal(ops(t.chain, 'mint').length, 0);
  assert.equal(t.sync.status('kit').state, 'synced');
  assert.equal(t.sync.status('boat').state, 'synced', 'the boat did not change, so it was not touched');

  // Equipping a ship touches only the boat.
  t.state.boat.ship = 2;
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS);
  assert.deepEqual(t.chain.calls.map((c) => c.op), ['update', 'update']);
  assert.equal(attr(t.chain.calls[1].attributes, 'shipName'), 'Twin Cast');
});

test('a steady stream of changes still lands after the max wait', async () => {
  const t = setup();
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  t.chain.calls.length = 0;
  for (let i = 0; i < 10; i++) {
    t.state.kit.lamp = (i % 3) + 1;
    t.sync.levelsChanged();
    await t.timers.advance(2000);
  }
  // 20 s of changes 2 s apart: the 15 s cap fired once mid-stream, the quiet period once after.
  await t.timers.advance(GEAR_QUIET_MS);
  const updates = ops(t.chain, 'update');
  assert.ok(updates.length >= 1 && updates.length <= 2, `${updates.length} updates`);
  assert.equal(attr(updates.at(-1).attributes, 'lamp'), String(t.state.kit.lamp));
  assert.ok(GEAR_MAX_WAIT_MS <= 15_000);
});

test('a reset to level 1 (the shark penalty) syncs like any other change', async () => {
  const t = setup({ levels: { boat: { ship: 3, bait: 1 }, kit: { net: 3, fins: 2, tank: 3, branches: { net: 'fine', fins: 'silent' } } } });
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  t.chain.calls.length = 0;
  t.state.kit = { branches: t.state.kit.branches }; // every dive level back to 1, branches kept in storage
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS);
  const [u] = ops(t.chain, 'update');
  assert.equal(ops(t.chain, 'update').length, 1);
  assert.match(u.path, /\/kit\/1-1-1-1-1-1-1\/far-wide-sprint-long-focus-fastReel\.json$/);
  assert.equal(attr(u.attributes, 'netBranch'), 'wide');
  assert.equal(t.chain.calls.filter((c) => c.kind === 'boat').length, 0, 'boat untouched');
});

test('never two transactions at once; changes during one are sent right after it', async () => {
  const t = setup();
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  t.chain.calls.length = 0;
  let release;
  t.chain.gate = new Promise((r) => (release = r));
  t.state.kit.net = 2;
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS);
  assert.equal(t.chain.inFlight, 1);
  t.state.kit.net = 3;
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS * 3);
  assert.equal(t.chain.inFlight, 1, 'the second change waits for the first transaction');
  t.chain.gate = null;
  release();
  await t.timers.advance(10);
  await t.sync.running;
  await t.timers.advance(10);
  assert.equal(t.chain.maxInFlight, 1);
  const updates = ops(t.chain, 'update');
  assert.deepEqual(updates.map((u) => attr(u.attributes, 'net')), ['2', '3']);
});

test('no SOL: waits (no mint, no failure counted), then resumes once funded', async () => {
  const t = setup();
  t.chain.balance = 0;
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  assert.equal(ops(t.chain, 'airdrop').length, 1, 'one faucet try per shortfall');
  assert.equal(ops(t.chain, 'mint').length, 0);
  assert.equal(t.sync.status('boat').state, 'needs-sol');
  assert.equal(t.sync.status('kit').state, 'needs-sol');
  // Levels keep changing locally meanwhile; the chain just waits.
  t.state.kit.reel = 2;
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS);
  assert.equal(ops(t.chain, 'mint').length, 0);
  t.chain.balance = 0.5; // topped up
  await t.timers.advance(60_000);
  assert.deepEqual(ops(t.chain, 'mint').map((m) => m.kind), ['boat', 'kit']);
  assert.equal(attr(ops(t.chain, 'mint')[1].attributes, 'reel'), '2', 'minted with the levels of now');
  assert.equal(t.sync.status('kit').state, 'synced');
  assert.equal(JSON.parse(t.store.get(OWNER_KEY)).kit.fails, undefined);
});

test('a queued change survives a reload and is sent by the next page', async () => {
  const t = setup();
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  t.chain.balance = 0;
  t.state.kit.tank = 3;
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS);
  assert.equal(ops(t.chain, 'update').length, 0);
  t.sync.stop(); // the page closes

  t.chain.balance = 1;
  const next = setup({ store: t.store, chain: t.chain, levels: { boat: t.state.boat, kit: { tank: 3 } } });
  next.sync.start();
  await next.timers.advance(GEAR_START_DELAY_MS);
  const updates = ops(t.chain, 'update');
  assert.equal(updates.length, 1);
  assert.equal(attr(updates[0].attributes, 'tank'), '3');
  assert.equal(ops(t.chain, 'mint').length, 2, 'no second pair');
});

test('a mint that landed before the page closed is adopted, not minted twice', async () => {
  const t = setup();
  t.chain.fail = new Error('Failed to fetch'); // the confirmation never arrives …
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  const rec = JSON.parse(t.store.get(OWNER_KEY));
  assert.equal(rec.boat.pendingKey.length, 64, 'the new asset key was saved before sending');
  // … but the transaction did land: the chain holds the boat at that key's address.
  const k = rec.boat.pendingKey.join(',');
  const asset = 'Landed1111111111111111111111111111111111111';
  t.chain.keyAssets.set(k, asset);
  t.chain.onChain.set(asset, { uri: `https://origin.test${G.gearMetaPath('boat', { boat: G.normalizeBoat({}), kit: G.normalizeKit({}) })}`, attributes: [], authority: SESSION });
  t.chain.fail = null;
  const next = setup({ store: t.store, chain: t.chain });
  next.sync.start();
  // The failed attempt left a short backoff in the record; the next page honours it.
  await next.timers.advance(GEAR_START_DELAY_MS + 10_000);
  const after = JSON.parse(t.store.get(OWNER_KEY));
  assert.equal(after.boat.asset, asset);
  assert.deepEqual(ops(t.chain, 'mint').map((m) => m.kind), ['kit'], 'only the kit was minted');
  assert.equal(next.sync.log.find((e) => e.kind === 'boat').action, 'adopt');
});

test('repeated failures back off, then pause with local levels in use; a level change retries once', async () => {
  const t = setup();
  t.chain.fail = new Error('Transaction simulation failed: custom program error');
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  // 5 s, 10 s, 20 s, 40 s backoff for the boat (the kit waits its turn behind it each pass).
  await t.timers.advance(5 * 60_000);
  const rec = JSON.parse(t.store.get(OWNER_KEY));
  assert.equal(rec.boat.fails, 5);
  assert.equal(t.sync.status('boat').state, 'paused');
  assert.equal(G.GEAR_STATE_LABELS.paused, 'Sync paused · local levels in use');
  const before = t.sync.log.length;
  await t.timers.advance(30 * 60_000);
  assert.equal(t.sync.log.filter((e) => e.kind === 'boat').length, t.sync.log.slice(0, before).filter((e) => e.kind === 'boat').length, 'paused: no more boat attempts');

  t.chain.fail = null;
  t.state.boat.ship = 1;
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS);
  assert.equal(ops(t.chain, 'mint').filter((m) => m.kind === 'boat').length, 1);
  assert.equal(t.sync.status('boat').state, 'synced');
});

test('assets this session key cannot update (another browser) get a fresh pair', async () => {
  const t = setup();
  t.sync.start();
  await t.timers.advance(GEAR_START_DELAY_MS);
  const first = JSON.parse(t.store.get(OWNER_KEY));
  // Another device's key is now the update authority of the kit (e.g. the record was copied over).
  t.chain.onChain.get(first.kit.asset).authority = 'Xther111111111111111111111111111111111111111';
  t.state.kit.sonar = 2;
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_QUIET_MS + 10);
  const after = JSON.parse(t.store.get(OWNER_KEY));
  assert.notEqual(after.kit.asset, first.kit.asset);
  assert.deepEqual(after.kit.orphaned, [first.kit.asset]);
  assert.equal(t.sync.status('kit').orphaned.length, 1);
  const lastMint = ops(t.chain, 'mint').at(-1);
  assert.equal(lastMint.kind, 'kit');
  assert.equal(attr(lastMint.attributes, 'sonar'), '2');

  // And a record whose authority is another key mints fresh without asking the chain first.
  const store = new Map([[OWNER_KEY, JSON.stringify({ boat: { ...after.boat, authority: 'Xther111111111111111111111111111111111111111' }, kit: after.kit })]]);
  const other = setup({ store, chain: t.chain, levels: { boat: t.state.boat, kit: t.state.kit } });
  other.sync.start();
  await other.timers.advance(GEAR_START_DELAY_MS);
  assert.equal(ops(t.chain, 'mint').at(-1).kind, 'boat');
});

test('stopped (logged out): level changes send nothing', async () => {
  const t = setup();
  t.sync.start();
  t.sync.stop();
  t.sync.levelsChanged();
  await t.timers.advance(GEAR_START_DELAY_MS * 3);
  assert.equal(t.chain.calls.length, 0);
  assert.equal(t.timers.pending(), 0);
  assert.equal(t.sync.status('kit').state, 'off');
});

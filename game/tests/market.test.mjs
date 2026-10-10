import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Stand-in for wallet.ts: equipment.ts only needs storageKey, and the real one pulls in Umi and Phantom.
// It maps names to the pre-namespacing keys so the fixtures below keep their shape.
const WALLET_STUB = `data:text/javascript;base64,${Buffer.from("export const storageKey = (name) => (name.startsWith('deepbreath.') ? name : 'deepbreath.' + name);").toString('base64')}`;

// Transpile market.ts and equipment.ts in memory to keep tests usable on Node 20.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const code = outputText.replace(/from ['"]\.\/wallet['"]/g, `from '${WALLET_STUB}'`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const {
  MAX_AUTO_MINT_TRIES,
  addBankedValue,
  bankEntry,
  bulkSellable,
  migrateBank,
  migrateUnlockProgress,
  needsConfirm,
  nextRetryAt,
  nextToMint,
  nextToSell,
  nftStep,
  retryDelayMs,
  sellQuote,
} = await load('../src/market.ts');
const equipment = await load('../src/equipment.ts');

const RARITY_VALUE = { common: 1, uncommon: 3, rare: 10, epic: 35, legendary: 150, mythic: 800 };
// Same rule as fishValue() in fish.ts: the stored catch value, else the plain rarity value.
const fishValue = (f) => f.value ?? RARITY_VALUE[f.rarity];

let seq = 0;
const fish = (rarity = 'common', extra = {}) => ({ id: `f${++seq}`, rarity, name: `${rarity} fish`, depthM: 5, value: RARITY_VALUE[rarity] * 2, ...extra });

test('a banked fish is queued, minted, and remembers its asset', () => {
  const a = bankEntry(fish());
  assert.equal(a.nft, 'pending');
  const b = nftStep(a, { type: 'start' });
  assert.equal(b.nft, 'minting');
  assert.equal(a.nft, 'pending', 'transitions return a new entry');
  const c = nftStep(b, { type: 'minted', assetId: 'Asset1', tx: 'Sig1' });
  assert.equal(c.nft, 'minted');
  assert.equal(c.assetId, 'Asset1');
  assert.equal(c.mintTx, 'Sig1');
});

test('failed mints back off, stop retrying on their own, and a manual retry starts over', () => {
  let f = nftStep(bankEntry(fish()), { type: 'start' });
  const now = 1_000_000;
  f = nftStep(f, { type: 'failed', error: 'boom', now });
  assert.equal(f.nft, 'failed');
  assert.equal(f.mintTries, 1);
  assert.equal(f.retryAt, now + retryDelayMs(1));
  assert.equal(nextToMint([f], now), null, 'not before its backoff');
  assert.equal(nextToMint([f], f.retryAt), f);
  assert.equal(nextRetryAt([f]), f.retryAt);
  assert.ok(retryDelayMs(2) > retryDelayMs(1));
  assert.ok(retryDelayMs(50) <= 10 * 60_000);

  for (let i = 1; i < MAX_AUTO_MINT_TRIES; i++) f = nftStep(nftStep(f, { type: 'start' }), { type: 'failed', error: 'boom', now });
  assert.equal(f.mintTries, MAX_AUTO_MINT_TRIES);
  assert.equal(f.retryAt, undefined, 'out of automatic retries');
  assert.equal(nextToMint([f], Number.MAX_SAFE_INTEGER), null);
  assert.equal(nextRetryAt([f]), null);

  const retried = nftStep(f, { type: 'retry' });
  assert.equal(retried.nft, 'pending');
  assert.equal(retried.mintTries, undefined);
  assert.equal(retried.mintError, undefined);
});

test('running out of SOL mid-mint re-queues the fish without costing an attempt', () => {
  const f = nftStep(nftStep(bankEntry(fish()), { type: 'start' }), { type: 'no-funds' });
  assert.equal(f.nft, 'pending');
  assert.equal(f.mintTries, undefined);
});

test('events that do not fit the state change nothing', () => {
  const pending = bankEntry(fish());
  const minted = { ...fish(), nft: 'minted', assetId: 'A' };
  assert.equal(nftStep(pending, { type: 'minted', assetId: 'X', tx: 'Y' }), pending);
  assert.equal(nftStep(pending, { type: 'failed', error: 'e', now: 0 }), pending);
  assert.equal(nftStep(pending, { type: 'retry' }), pending);
  assert.equal(nftStep(minted, { type: 'start' }), minted);
  assert.equal(nftStep(minted, { type: 'enqueue' }), minted);
  const minting = nftStep(pending, { type: 'start' });
  assert.equal(nftStep(minting, { type: 'sell' }), minting, 'no selling while minting');
});

test('the queue mints one fish at a time, fish the player wants to sell first', () => {
  const legacy = { ...fish(), legacy: true };
  const a = bankEntry(fish());
  const b = bankEntry(fish());
  const minted = { ...fish(), nft: 'minted', assetId: 'A' };
  assert.equal(nextToMint([legacy, minted, a, b], 0), a, 'legacy fish are not auto-minted');
  const bSell = nftStep(b, { type: 'sell' });
  assert.equal(nextToMint([legacy, a, bSell], 0), bSell);
  assert.equal(nextToSell([a, bSell]), null, 'unminted fish are minted before they are sold');
  const mintedSell = nftStep(minted, { type: 'sell' });
  assert.equal(nextToSell([a, mintedSell]), mintedSell);
  assert.equal(nftStep(mintedSell, { type: 'cancel-sell' }).sellQueued, undefined);
  const enqueued = nftStep(legacy, { type: 'enqueue' });
  assert.equal(enqueued.nft, 'pending', 'the manual Mint button queues a legacy fish');
  assert.equal(enqueued.legacy, true, 'and it stays paid out');
});

test('legacy saves: old fish become paid-out, minted ones keep their asset, nothing is lost', () => {
  const old = [
    { ...fish('rare'), name: 'Old rare' },
    { ...fish('epic'), assetId: 'MintedByHand' },
    { ...fish('common'), value: undefined },
  ];
  const { bank, changed } = migrateBank(JSON.parse(JSON.stringify(old)));
  assert.equal(changed, true);
  assert.equal(bank.length, 3);
  assert.ok(bank.every((f) => f.legacy === true));
  assert.equal(bank[0].nft, undefined, 'not auto-minted');
  assert.equal(bank[1].nft, 'minted');
  assert.equal(bank[1].assetId, 'MintedByHand');
  for (let i = 0; i < old.length; i++) for (const [k, v] of Object.entries(old[i])) assert.deepEqual(bank[i][k], v);
  assert.equal(nextToMint(bank, Date.now()), null);

  const again = migrateBank(JSON.parse(JSON.stringify(bank)));
  assert.equal(again.changed, false, 'migration is idempotent');
  assert.deepEqual(again.bank, bank);
});

test('new saves: a mint cut off by a reload goes back to the queue', () => {
  const saved = [bankEntry(fish()), { ...bankEntry(fish()), nft: 'minting' }, { ...fish(), nft: 'minted', assetId: 'A' }];
  const { bank, changed } = migrateBank(saved);
  assert.equal(changed, true);
  assert.deepEqual(bank.map((f) => f.nft), ['pending', 'pending', 'minted']);
  assert.ok(bank.every((f) => !f.legacy));
  assert.deepEqual(migrateBank('garbage'), { bank: [], changed: false });
  assert.equal(migrateBank([null, saved[0]]).bank.length, 1);
});

test('selling pays the catch value banking used to pay; legacy fish were already paid', () => {
  const minted = { ...fish('rare'), nft: 'minted', assetId: 'A' };
  assert.deepEqual(sellQuote(minted, fishValue), { ok: true, pearls: fishValue(minted), mintFirst: false });
  assert.deepEqual(sellQuote(bankEntry(fish('epic')), fishValue), { ok: true, pearls: 70, mintFirst: true });
  const failed = { ...fish(), nft: 'failed' };
  assert.equal(sellQuote(failed, fishValue).mintFirst, true);
  assert.deepEqual(sellQuote({ ...fish(), nft: 'minting' }, fishValue), { ok: false, reason: 'minting' });
  assert.deepEqual(sellQuote({ ...minted, legacy: true }, fishValue), { ok: false, reason: 'paid-out' });
  assert.deepEqual(sellQuote({ ...fish('rare'), legacy: true }, fishValue), { ok: false, reason: 'paid-out' });
  assert.equal(nftStep({ ...minted, legacy: true }, { type: 'sell' }).sellQueued, undefined);

  // Mint & sell on a failed fish retries the mint at once.
  const failedSell = nftStep({ ...failed, mintTries: 4, mintError: 'x' }, { type: 'sell' });
  assert.equal(failedSell.nft, 'pending');
  assert.equal(failedSell.sellQueued, true);
  assert.equal(failedSell.mintTries, undefined);

  // Fish banked before catch values were stored sell at their rarity value.
  assert.equal(sellQuote({ ...minted, value: undefined }, fishValue).pearls, 10);
});

test('epic and rarer fish need a confirm; "sell all commons" skips paid-out, minting and queued fish', () => {
  assert.deepEqual(
    ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].map(needsConfirm),
    [false, false, false, true, true, true],
  );
  const ok1 = bankEntry(fish('common'));
  const ok2 = { ...fish('common'), nft: 'minted', assetId: 'A' };
  const bank = [
    ok1,
    ok2,
    { ...fish('common'), legacy: true },
    { ...fish('common'), nft: 'minting' },
    nftStep(bankEntry(fish('common')), { type: 'sell' }),
    bankEntry(fish('rare')),
  ];
  assert.deepEqual(bulkSellable(bank, 'common'), [ok1, ok2]);
});

test('map unlock progress is lifetime banked value: selling never lowers it', () => {
  // Old saves: the saved best was the high-water mark of a bank that only grew, i.e. the lifetime value.
  assert.equal(migrateUnlockProgress(140, 140), 140);
  assert.equal(migrateUnlockProgress(0, 90), 90, 'a bank older than map progress still counts');
  assert.equal(migrateUnlockProgress(200, 50), 200, 'never drops to the current bank');
  assert.equal(migrateUnlockProgress(Number.NaN, 12), 12);

  let rand = 7;
  const next = () => (rand = (rand * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let lifetime = migrateUnlockProgress(30, 30);
  let bank = [30];
  const unlocked = (v) => [0, 150, 1000].filter((t) => v >= t).length;
  let maps = unlocked(lifetime);
  for (let step = 0; step < 500; step++) {
    const before = lifetime;
    if (next() < 0.5 || !bank.length) {
      const added = Array.from({ length: 1 + Math.floor(next() * 6) }, () => Math.ceil(next() * 40));
      bank.push(...added);
      lifetime = addBankedValue(lifetime, added.reduce((s, v) => s + v, 0));
    } else {
      bank.splice(Math.floor(next() * bank.length), 1); // sold
    }
    lifetime = migrateUnlockProgress(lifetime, bank.reduce((s, v) => s + v, 0)); // a reload in between
    assert.ok(lifetime >= before, 'progress never goes backwards');
    assert.ok(unlocked(lifetime) >= maps, 'a map never re-locks');
    maps = unlocked(lifetime);
  }
  assert.equal(maps, 3);
  assert.equal(addBankedValue(10, -5), 10);
});

function fakeStorage(data = {}) {
  const map = new Map(Object.entries(data));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

test('Pearls saved before on-chain PEARL become a separate legacy balance', () => {
  globalThis.localStorage = fakeStorage({ 'deepbreath.equipment': JSON.stringify({ rodLevel: 2, pearls: 420 }) });
  const state = equipment.loadEquipment();
  assert.deepEqual(state, { rodLevel: 2, pearls: 0, legacyPearls: 420 });
  assert.equal(equipment.totalPearls(state), 420);
  // Saved back in the new shape, so the next load does not migrate again.
  assert.deepEqual(JSON.parse(localStorage.getItem('deepbreath.equipment')), state);
  state.pearls = 15; // on-chain cache
  equipment.saveEquipment(state);
  assert.deepEqual(equipment.loadEquipment(), { rodLevel: 2, pearls: 15, legacyPearls: 420 });

  globalThis.localStorage = fakeStorage({ 'deepbreath.pearls': '77' });
  assert.deepEqual(equipment.loadEquipment(), { rodLevel: 1, pearls: 0, legacyPearls: 77 });
  delete globalThis.localStorage;
});

test('upgrades spend legacy Pearls first and burn only the rest on-chain', () => {
  const lv2 = equipment.ROD_TIERS[1];
  assert.deepEqual(equipment.planUpgrade({ rodLevel: 1, pearls: 0, legacyPearls: 500 }), { tier: lv2, fromLegacy: lv2.cost, fromChain: 0 });
  assert.deepEqual(equipment.planUpgrade({ rodLevel: 1, pearls: 250, legacyPearls: 100 }), { tier: lv2, fromLegacy: 100, fromChain: lv2.cost - 100 });
  assert.deepEqual(equipment.planUpgrade({ rodLevel: 1, pearls: 400, legacyPearls: 0 }), { tier: lv2, fromLegacy: 0, fromChain: lv2.cost });
  assert.equal(equipment.planUpgrade({ rodLevel: 1, pearls: 150, legacyPearls: 149 }), null, 'one short');
  assert.equal(equipment.planUpgrade({ rodLevel: 3, pearls: 1e6, legacyPearls: 0 }), null, 'maxed out');
});

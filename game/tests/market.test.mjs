import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Stand-in for wallet.ts: equipment.ts only needs storageKey, and the real one pulls in Umi and Phantom.
// It maps names to the pre-namespacing keys so the fixtures below keep their shape.
const WALLET_STUB = `data:text/javascript;base64,${Buffer.from("export const storageKey = (name) => (name.startsWith('deepbreath.') ? name : 'deepbreath.' + name);").toString('base64')}`;
const lampLightingCode = 'export const lampProfile=(level,path)=>{const tier=Math.max(1,Math.min(3,Math.floor(Number(level)||1)));const wide=path==="wideLamp";const profiles=wide?[[18,48,.65,2,.55,.12,.03],[24,60,1.03,2,.8,.2,.045],[32,74,1.25,2,.9,.24,.05]]:[[18,48,.65,2,.55,.12,.03],[33,74,.52,2,.3,.09,.018],[48,102,.43,2,.24,.075,.014]];const p=profiles[tier-1];return {distance:p[0],intensity:p[1],angle:p[2],decay:p[3],penumbra:p[4],scatter:p[5],extinction:p[6]};};';
const LAMP_LIGHTING_STUB = `data:text/javascript;base64,${Buffer.from(lampLightingCode).toString('base64')}`;

// Transpile market.ts and equipment.ts in memory to keep tests usable on Node 20.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const code = outputText
    .replace(/from ['"]\.\/wallet['"]/g, `from '${WALLET_STUB}'`)
    .replace(/from ['"]\.\/lamp-lighting['"]/g, `from '${LAMP_LIGHTING_STUB}'`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const {
  MAX_AUTO_MINT_TRIES,
  bankEntry,
  bulkSellable,
  bulkSellableBelowEpic,
  isRateLimitError,
  isSpentFishError,
  migrateBank,
  mintPauseOf,
  needsConfirm,
  nextRetryAt,
  nextToMint,
  nextToSell,
  nftStep,
  pearls,
  retryDelayMs,
  sellBatches,
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

test('"sell all" takes every sellable fish below epic, and never an epic, legendary or mythic one', () => {
  const common = bankEntry(fish('common'));
  const rare = { ...fish('rare'), nft: 'minted', assetId: 'R' };
  const uncommon = bankEntry(fish('uncommon'));
  const bank = [
    common,
    rare,
    uncommon,
    { ...fish('epic'), nft: 'minted', assetId: 'E' },
    { ...fish('legendary'), nft: 'minted', assetId: 'L' },
    bankEntry(fish('mythic')),
    { ...fish('rare'), legacy: true },
    { ...fish('uncommon'), nft: 'minting' },
    nftStep(bankEntry(fish('rare')), { type: 'sell' }),
  ];
  assert.deepEqual(bulkSellableBelowEpic(bank), [common, rare, uncommon]);
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
  // A rod-only save migrates to the six-slot loadout: rodLevel becomes the net tier, the rest start at Lv1.
  const slots = (net) => ({ rodLevel: net, netLevel: net, rodGearLevel: 1, reelLevel: 1, finsLevel: 1, tankLevel: 1, lampLevel: 1, sonarLevel: 1 });
  const paths = { ...equipment.DEFAULT_EQUIPMENT_PATHS };
  globalThis.localStorage = fakeStorage({ 'deepbreath.equipment': JSON.stringify({ rodLevel: 2, pearls: 420 }) });
  const state = equipment.loadEquipment();
  assert.deepEqual(state, { ...slots(2), pearls: 0, legacyPearls: 420, paths });
  assert.equal(equipment.spendablePearls(state), 0, 'legacy Pearls are kept but not spendable');
  // Saved back in the new shape, so the next load does not migrate again.
  assert.deepEqual(JSON.parse(localStorage.getItem('deepbreath.equipment')), state);
  state.pearls = 15; // on-chain cache
  equipment.saveEquipment(state);
  assert.deepEqual(equipment.loadEquipment(), { ...slots(2), pearls: 15, legacyPearls: 420, paths });
  assert.equal(equipment.spendablePearls(equipment.loadEquipment()), 15);

  globalThis.localStorage = fakeStorage({ 'deepbreath.pearls': '77' });
  assert.deepEqual(equipment.loadEquipment(), { ...slots(1), pearls: 0, legacyPearls: 77, paths });
  delete globalThis.localStorage;
});

test('upgrades are paid in on-chain PEARL only: legacy Pearls never count', () => {
  const lv2 = equipment.ROD_TIERS[1];
  assert.equal(equipment.planUpgrade({ rodLevel: 1, pearls: 0, legacyPearls: 500 }), null, 'legacy alone cannot pay');
  assert.equal(equipment.planUpgrade({ rodLevel: 1, pearls: lv2.cost - 1, legacyPearls: 100 }), null, 'legacy does not top up');
  assert.deepEqual(equipment.planUpgrade({ rodLevel: 1, pearls: lv2.cost, legacyPearls: 0 }), { tier: lv2 }, 'exact balance pays');
  assert.deepEqual(equipment.planUpgrade({ rodLevel: 1, pearls: 400, legacyPearls: 50 }), { tier: lv2 });
  assert.equal(equipment.planUpgrade({ rodLevel: 1, pearls: 0, legacyPearls: 0 }), null, 'zero balance');
  assert.equal(equipment.planUpgrade({ rodLevel: 3, pearls: 1e6, legacyPearls: 0 }), null, 'maxed out');
});

test('flat Pearl prices (fish food, synthesis) burn exactly the cost on-chain', () => {
  assert.equal(equipment.planPearlSpend({ pearls: 50, legacyPearls: 500 }, 24), 24);
  assert.equal(equipment.planPearlSpend({ pearls: 24, legacyPearls: 0 }, 24), 24, 'exact balance pays');
  assert.equal(equipment.planPearlSpend({ pearls: 10, legacyPearls: 500 }, 24), null, 'legacy Pearls do not count');
  assert.equal(equipment.planPearlSpend({ pearls: 0, legacyPearls: 0 }, 8), null, 'empty balance never pays');
  assert.equal(equipment.planPearlSpend({ pearls: 7, legacyPearls: 0 }, 8), null, 'one short');
  assert.equal(equipment.planPearlSpend({ pearls: 100, legacyPearls: 0 }, 0), null, 'zero cost is not a purchase');
  assert.equal(equipment.planPearlSpend({ pearls: 100, legacyPearls: 0 }, 2.5), null, 'whole Pearls only');
  const start = { rodLevel: 2, reelLevel: 3, pearls: 50, legacyPearls: 10 };
  const after = equipment.applyPearlSpend(start, equipment.planPearlSpend(start, 24));
  assert.equal(after.legacyPearls, 10, 'legacy value is preserved untouched');
  assert.equal(after.pearls, 26);
  assert.equal(after.netLevel, 2, 'gear levels are untouched');
  assert.equal(after.reelLevel, 3);
  assert.equal(equipment.spendablePearls(after), equipment.spendablePearls(start) - 24);
});

test('slot upgrades burn the full tier cost on-chain and keep the other slots', () => {
  const start = { rodLevel: 2, pearls: 250, legacyPearls: 100, finsLevel: 3 };
  const fins = equipment.planSlotUpgrade(start, 'fins');
  assert.equal(fins, null, 'fins already maxed');
  const plan = equipment.planSlotUpgrade(start, 'reel');
  const cost = equipment.EQUIPMENT_TIERS.reel[1].cost;
  assert.deepEqual({ ...plan, tier: plan.tier.level }, { slot: 'reel', tier: 2 });
  assert.equal(plan.tier.cost, cost);
  const after = equipment.applySlotUpgrade(start, plan);
  assert.equal(after.reelLevel, 2);
  assert.equal(after.netLevel, 2);
  assert.equal(after.finsLevel, 3);
  assert.equal(after.legacyPearls, 100, 'legacy value is preserved untouched');
  assert.equal(after.pearls, 250 - cost);
  assert.equal(equipment.planSlotUpgrade({ ...start, pearls: cost - 1, legacyPearls: 1e6 }, 'reel'), null, 'one short, legacy ignored');
  assert.ok(equipment.planSlotUpgrade({ ...start, pearls: cost, legacyPearls: 0 }, 'reel'), 'exact balance pays');
  assert.equal(equipment.applySlotUpgrade(start, plan, 0).pearls, 250, 'an already-paid fee is not taken twice');
});

test('deep sonar cable tiers are bought through the same slot plan', () => {
  const [lv1, lv2, lv3] = equipment.EQUIPMENT_TIERS.sonar;
  assert.deepEqual([lv1.cost, lv2.cost, lv3.cost], [0, 300, 1200]);
  const start = { rodLevel: 2, reelLevel: 2, pearls: 400, legacyPearls: 120 };
  assert.equal(equipment.slotTier(start, 'sonar').level, 1, 'older saves start at the 10 m cable');
  const plan = equipment.planSlotUpgrade(start, 'sonar');
  assert.deepEqual({ ...plan, tier: plan.tier.level }, { slot: 'sonar', tier: 2 });
  const after = equipment.applySlotUpgrade(start, plan);
  assert.equal(after.sonarLevel, 2);
  assert.equal(after.netLevel, 2);
  assert.equal(after.reelLevel, 2);
  assert.equal(after.legacyPearls, 120);
  assert.equal(after.pearls, 400 - lv2.cost);
  assert.equal(equipment.planSlotUpgrade(after, 'sonar'), null, 'Lv3 costs more than is left');
  assert.equal(equipment.nextSlotTier({ ...after, sonarLevel: 3 }, 'sonar'), null, 'maxed out');
  assert.equal(equipment.deriveStats(after).netCapacity, equipment.deriveStats({ ...after, sonarLevel: 1 }).netCapacity, 'sonar leaves the other stats alone');
});

test('migrateBank keeps a valid fish number and drops a broken one', () => {
  const base = { id: 'a1', name: 'Grey Perch', rarity: 'common', depthM: 3, nft: 'minted', assetId: 'Asset1111111111111111111111111111111111111' };
  const { bank, changed } = migrateBank([
    { ...base, serial: 42 },
    { ...base, serial: 1234567 },
    { ...base, serial: '42' },
    { ...base, serial: 0 },
    { ...base, serial: 4.2 },
  ]);
  assert.deepEqual(
    bank.map((f) => f.serial),
    [42, 1234567, undefined, undefined, undefined],
  );
  assert.equal(changed, true);
  assert.equal(migrateBank([{ ...base, serial: 42 }]).changed, false);
});

test('Pearl amounts are pluralised', () => {
  assert.equal(pearls(1), '1 Pearl');
  assert.equal(pearls(0), '0 Pearls');
  assert.equal(pearls(12), '12 Pearls');
});

test('sellBatches: at most 24 fish and 2 transfers per /sell-batch request, every sale kept once', () => {
  const sale = (n, tx) => ({ assetId: `fish${n}`, transferTx: tx });
  const check = (sales, expectedRequests) => {
    const out = sellBatches(sales, 24, 2);
    for (const b of out) {
      assert.ok(b.length >= 1 && b.length <= 24, `${b.length} fish`);
      assert.ok(new Set(b.map((s) => s.transferTx)).size <= 2);
    }
    assert.deepEqual(out.flat().map((s) => s.assetId).sort(), sales.map((s) => s.assetId).sort());
    assert.equal(out.length, expectedRequests);
    return out;
  };
  // A fresh sale packs 20 fish per transfer, so 24 fish over 2 transfers is still one request.
  const fresh = Array.from({ length: 24 }, (_, i) => sale(i, i < 20 ? 'T1' : 'T2'));
  assert.deepEqual(check(fresh, 1)[0], fresh);
  // 47 fish over 3 transfers (20/20/7).
  check(Array.from({ length: 47 }, (_, i) => sale(i, `T${Math.floor(i / 20)}`)), 2);
  // A resume that mixes a fresh 10-fish transfer with 5 older single-fish ones, interleaved.
  const older = Array.from({ length: 5 }, (_, i) => sale(100 + i, `OLD${i}`));
  const mixed = Array.from({ length: 10 }, (_, i) => sale(i, 'NEW')).flatMap((s, i) => (older[i] ? [s, older[i]] : [s]));
  check(mixed, 3);
  // Every fish its own transfer (handed over earlier, found by getSignaturesForAddress).
  check(Array.from({ length: 7 }, (_, i) => sale(i, `S${i}`)), 4);
  assert.deepEqual(sellBatches([], 24, 2), []);
});

test('a mint refused as already sold or burned is spent for good; other refusals are not', () => {
  // fish-cosign.ts CosignError carries the market's status and code (sensor/fish-collection.mjs claim).
  const cosignError = (status, code) => Object.assign(new Error('refused'), { status, code });
  assert.equal(isSpentFishError(cosignError(409, 'already-burned')), true);
  assert.equal(isSpentFishError(cosignError(409, 'already-minted')), false, 'adopted by cosignMint instead');
  assert.equal(isSpentFishError(cosignError(409, 'mint-in-flight')), false, 'retried with backoff');
  assert.equal(isSpentFishError(cosignError(429, 'already-burned')), false);
  assert.equal(isSpentFishError(new Error('already-burned')), false);
  assert.equal(isSpentFishError(null), false);
  assert.equal(isSpentFishError(undefined), false);
});

test('transient mint errors pause the whole queue instead of costing the fish an attempt', () => {
  // fish-cosign.ts CosignError carries the market's status, code and retryAfterMs.
  const cosignError = (status, code, retryAfterMs) => Object.assign(new Error('refused'), { status, code, retryAfterMs });
  // The market offline (status 0) or failing for now (5xx, e.g. its RPC refusing it, or chain.ts's 'collection-pending').
  assert.deepEqual(mintPauseOf(cosignError(503)), { ms: 30_000, kind: 'busy' });
  assert.deepEqual(mintPauseOf(cosignError(500)), { ms: 30_000, kind: 'busy' });
  assert.deepEqual(mintPauseOf(cosignError(0)), { ms: 30_000, kind: 'busy' });
  assert.deepEqual(mintPauseOf(cosignError(503, 'collection-pending', 60_000)), { ms: 60_000, kind: 'busy' });
  // An earlier mint of this fish may still land: the server's retryAfterMs is honoured.
  assert.deepEqual(mintPauseOf(cosignError(409, 'mint-in-flight', 30_000)), { ms: 30_000, kind: 'busy' });
  assert.deepEqual(mintPauseOf(cosignError(409, 'mint-in-flight', 5_000)), { ms: 5_000, kind: 'busy' });
  assert.deepEqual(mintPauseOf(cosignError(409, 'mint-in-flight')), { ms: 30_000, kind: 'busy' });
  // The Solana RPC throttling our own send/confirm (no HTTP status on the error).
  assert.deepEqual(mintPauseOf(new Error('429 Too Many Requests: {"code":429}')), { ms: 30_000, kind: 'busy' });
  assert.deepEqual(mintPauseOf(new Error('Server responded with too many requests')), { ms: 30_000, kind: 'busy' });
  // The market's mint limit: its retryAfterMs, else a minute, never more than an hour.
  assert.deepEqual(mintPauseOf(cosignError(429)), { ms: 60_000, kind: 'limit' });
  assert.deepEqual(mintPauseOf(cosignError(429, 'limit', 120_000)), { ms: 120_000, kind: 'limit' });
  assert.deepEqual(mintPauseOf(cosignError(429, 'limit', 10 * 60 * 60_000)), { ms: 60 * 60_000, kind: 'limit' });
  assert.deepEqual(mintPauseOf(cosignError(503, undefined, -5)), { ms: 30_000, kind: 'busy' }, 'a bad retryAfterMs falls back');
  // Genuine failures still count against the fish's MAX_AUTO_MINT_TRIES.
  assert.equal(mintPauseOf(cosignError(400)), null);
  assert.equal(mintPauseOf(cosignError(403)), null);
  assert.equal(mintPauseOf(cosignError(409, 'already-burned')), null, 'spent fish: handled by isSpentFishError');
  assert.equal(mintPauseOf(Object.assign(new Error('Too Many Requests'), { status: 400 })), null, 'a market 4xx is never read as RPC throttling');
  assert.equal(mintPauseOf(new Error('Transaction simulation failed: custom program error 0x1771')), null);
  assert.equal(mintPauseOf(null), null);
  assert.equal(mintPauseOf(undefined), null);

  assert.equal(isRateLimitError(new Error('HTTP 429')), true);
  assert.equal(isRateLimitError('Too Many Requests'), true);
  assert.equal(isRateLimitError(new Error('blockhash 4290 expired')), false);
});

test('a paused fish keeps its tries; a failed one spends one', () => {
  const f = { ...nftStep(bankEntry(fish()), { type: 'start' }), mintTries: 2 };
  assert.equal(f.nft, 'minting');
  const paused = nftStep(f, { type: 'paused' });
  assert.equal(paused.nft, 'pending');
  assert.equal(paused.mintTries, 2, 'no attempt counted');
  const failed = nftStep(f, { type: 'failed', error: 'bad request', now: 0 });
  assert.equal(failed.nft, 'failed');
  assert.equal(failed.mintTries, 3);
});

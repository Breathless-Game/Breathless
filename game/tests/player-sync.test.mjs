import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { publicKey } from '@metaplex-foundation/umi';

// Pure rules that mirror the on-chain player_state accounts into the game (player-sync.ts), the
// program error reader (player-state-errors.ts) and the price setters the Config feeds.
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
async function transpile(rel, replace = {}) {
  const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [from, to] of Object.entries(replace)) outputText = outputText.replaceAll(`from '${from}'`, `from '${to}'`).replaceAll(`from "${from}"`, `from "${to}"`);
  return dataUrl(outputText);
}
const walletStub = dataUrl("export const storageKey = (name) => 'deepbreath.' + name;");
const umiUrl = import.meta.resolve('@metaplex-foundation/umi');
const psUrl = await transpile('player-state.ts', { '@metaplex-foundation/umi': umiUrl });
const ps = await import(psUrl);
const sync = await import(await transpile('player-sync.ts', { './player-state': psUrl }));
const errors = await import(await transpile('player-state-errors.ts'));
const lampUrl = await transpile('lamp-lighting.ts');
const equipment = await import(await transpile('equipment.ts', { './wallet': walletStub, './lamp-lighting': lampUrl }));
const synthesis = await import(await transpile('synthesis.ts', { './wallet': walletStub }));
const fishFood = await import(await transpile('fish-food.ts'));

const P = ps.GAME_PRICE_TABLE;
const OWNER = publicKey('4uKAMgmbi5dxgmZJWbrUgaEkc5nzrkGqAaFzZCVnnwkE');
const LV1 = { rod: 1, reel: 1, net: 1, fins: 1, tank: 1, lamp: 1, sonar: 1 };
const DEFAULT_PATHS = Object.fromEntries(Object.entries(ps.PATH_IDS).map(([slot, ids]) => [slot, ids[0]]));

function player(over = {}) {
  return {
    version: 1, flags: 0, owner: OWNER, session: null,
    levels: { ...LV1 }, paths: { ...DEFAULT_PATHS },
    materials: { ...P.startingMaterials }, crafted: { bait: 0, composite: 0 }, bestValue: 0n,
    ...over,
  };
}
function entry(id, over = {}) {
  const key = ps.fishKey(id);
  return { key, keyHex: sync.fishKeyHex(id), growthMilli: 0, feedCount: 0, food: 'plankton', lastFed: 0, ...over };
}
const aquarium = (entries) => ({ version: 1, owner: OWNER, entries });
const BOAT_LV1 = { bait: 1, boat: 1, boatSpeed: 1, boatHull: 1, boatDeck: 1 };
const progress = (over = {}) => ({
  version: 1, bump: 254, owner: OWNER, lifetimeValue: 0n, bestValue: 0n, catches: 0, boatLevels: { ...BOAT_LV1 }, ship: 0, ...over,
});

test('v2 Progress: no account is lifetime 0, boat pieces Lv1 and the starter ship; rules become plain numbers', () => {
  assert.deepEqual(sync.progressView(null), { lifetime: 0, best: 0, catches: 0, boatLevels: BOAT_LV1, ship: 0 });
  const v = sync.progressView(progress({ lifetimeValue: 160n, bestValue: 100n, catches: 2, boatLevels: { ...BOAT_LV1, bait: 2 }, ship: 2 }));
  assert.deepEqual(v, { lifetime: 160, best: 100, catches: 2, boatLevels: { ...BOAT_LV1, bait: 2 }, ship: 2 });
  const r = sync.gameProgressRules(ps.GAME_PROGRESS_RULES);
  assert.deepEqual(r.mapThresholds, { fjord: 0, tianchi: 150, ocean: 1000 });
  assert.deepEqual(r.shipThresholds, [0, 50, 150, 500, 1200, 2500]);
  assert.deepEqual(r.boatPrices.boat, [0, 120, 700]);
  assert.deepEqual(sync.mapsOpen(0, r), ['fjord'], 'a new player sees the fjord only');
  assert.deepEqual(sync.mapsOpen(149, r), ['fjord']);
  assert.deepEqual(sync.mapsOpen(150, r), ['fjord', 'tianchi']);
  assert.deepEqual(sync.mapsOpen(1000, r), ['fjord', 'tianchi', 'ocean']);
  assert.equal(sync.shipOpen(49, r, 1), false);
  assert.equal(sync.shipOpen(50, r, 1), true);
  assert.equal(sync.shipOpen(1e9, r, 6), false, 'no such ship');
});

test('v2 boat quotes follow ProgressConfig: the next level only, null at Lv3', () => {
  const R = { ...ps.GAME_PROGRESS_RULES, boatPrices: { ...ps.GAME_PROGRESS_RULES.boatPrices, bait: [0n, 41n, 301n] } };
  assert.deepEqual(sync.boatQuote(R, BOAT_LV1, 'bait', 10), { level: 2, cost: 41, short: 31 });
  assert.deepEqual(sync.boatQuote(R, { ...BOAT_LV1, bait: 2 }, 'bait', 500), { level: 3, cost: 301, short: 0 });
  assert.equal(sync.boatQuote(R, { ...BOAT_LV1, bait: 3 }, 'bait', 500), null);
});

test("v2 a new player: buy_boat creates Progress, then a mint's record_catch grows the same account", () => {
  // As the program leaves it: buy_boat bait Lv2 on a wallet with no Progress (lifetime 0)...
  const afterBoat = progress({ boatLevels: { ...BOAT_LV1, bait: 2 } });
  const boatRec = { what: { v: 1, kind: 'boat', boat: 'bait', level: 2 }, ts: 1_000, lastValid: 500 };
  assert.equal(sync.purchaseVisible(boatRec.what, null, null, null), false, 'no Progress yet: not landed');
  assert.equal(sync.purchaseVisible(boatRec.what, null, null, afterBoat), true);
  // ...then record_catch (value 160) adds to it and keeps the boat level.
  const afterCatch = { ...afterBoat, lifetimeValue: 160n, bestValue: 160n, catches: 1 };
  const v = sync.progressView(afterCatch);
  assert.equal(v.lifetime, 160);
  assert.equal(v.boatLevels.bait, 2);
  assert.deepEqual(sync.mapsOpen(v.lifetime, sync.gameProgressRules(ps.GAME_PROGRESS_RULES)), ['fjord', 'tianchi'], 'Heaven Lake opens without a reload');
  assert.equal(sync.purchaseVisible(boatRec.what, null, null, afterCatch), true);
  // A lost confirmation settles by the re-read Progress only once the blockhash expired.
  assert.equal(sync.settleRecord(boatRec, null, 480, 2_000, null, null, 600_000, afterCatch), 'kept');
  assert.equal(sync.settleRecord(boatRec, null, 501, 2_000, null, null, 600_000, afterCatch), 'delivered');
  assert.equal(sync.settleRecord(boatRec, null, 501, 2_000, null, null, 600_000, progress()), 'dropped');
  const shipRec = { v: 1, kind: 'ship', ship: 2 };
  assert.equal(sync.purchaseVisible(shipRec, null, null, progress({ ship: 2 })), true);
  assert.equal(sync.purchaseVisible(shipRec, null, null, progress({ ship: 1 })), false);
  assert.equal(sync.purchaseVisible(shipRec, null, null, null), false);
});

test('v2 program errors keep their codes after the v1 ones', () => {
  assert.equal(errors.playerStateErrorName({ InstructionError: [0, { Custom: 6020 }] }), 'InvalidBoatSlot');
  assert.equal(errors.playerStateErrorName('custom program error: 0x1785'), 'NotNextLevel');
  assert.equal(errors.playerStateErrorName({ Custom: 6023 }), 'ShipLocked');
  assert.equal(errors.playerStateErrorName({ Custom: 6025 }), 'BadCatchLog');
  assert.equal(errors.playerStateErrorName({ Custom: 6019 }), 'BadClock');
});

test('Config prices become the game tables (whole PEARL numbers)', () => {
  const g = sync.gamePrices(P);
  assert.deepEqual(g.upgrade.net, [0, 300, 1200]);
  assert.deepEqual(g.synthUpgrade.fins, [99, 549]);
  assert.deepEqual(g.recipe, { bait: 38, composite: 128 });
  assert.deepEqual(g.food, { plankton: 8, pellet: 24, krill: 72, shrimp: 216, glowCoral: 648 });
  assert.throws(() => sync.gamePrices({ ...P, recipeCost: { bait: 2n ** 60n, composite: 1n } }), RangeError);
});

test('the price setters put Config prices where the panels and affordability read them', () => {
  const g = sync.gamePrices({ ...P, upgrade: { ...P.upgrade, rod: [0n, 111n, 555n] }, foodPrice: { ...P.foodPrice, krill: 77n } });
  equipment.setUpgradeCosts(g.upgrade);
  assert.equal(equipment.EQUIPMENT_TIERS.rod[1].cost, 111);
  assert.equal(equipment.EQUIPMENT_TIERS.rod[2].cost, 555);
  assert.equal(equipment.EQUIPMENT_TIERS.rod[0].cost, 0, 'Lv1 stays free');
  equipment.setUpgradeCosts({ lamp: [0, -1, Number.NaN] });
  assert.equal(equipment.EQUIPMENT_TIERS.lamp[1].cost, 100, 'invalid prices are ignored');
  fishFood.setFoodPrices(g.food);
  assert.equal(fishFood.fishFood('krill').price, 77);
  synthesis.setSynthesisCosts({ net: [90, 500] }, { bait: 40 });
  assert.deepEqual([...synthesis.SYNTHESIS_UPGRADE_COSTS.net], [90, 500]);
  assert.equal(synthesis.SYNTHESIS_RECIPE_COSTS.bait, 40);
  assert.equal(synthesis.synthesisUpgradeCost('net', 2), 500);
});

test('affordability quotes follow the Config, not hard-coded prices', () => {
  const prices = { ...P, upgrade: { ...P.upgrade, net: [0n, 350n, 1300n] } };
  assert.deepEqual(sync.upgradeQuote(prices, LV1, 'net', 100), { level: 2, cost: 350, short: 250 });
  assert.deepEqual(sync.upgradeQuote(prices, { ...LV1, net: 2 }, 'net', 2000), { level: 3, cost: 1300, short: 0 });
  assert.equal(sync.upgradeQuote(prices, { ...LV1, net: 3 }, 'net', 9999), null);

  assert.deepEqual(sync.synthQuote(P, LV1, { bait: 0, composite: 0 }, 'tank', 999), { blocked: 'no-composite' });
  assert.deepEqual(sync.synthQuote(P, { ...LV1, tank: 3 }, { bait: 0, composite: 1 }, 'tank', 999), { blocked: 'max' });
  assert.deepEqual(sync.synthQuote(P, { ...LV1, tank: 2 }, { bait: 0, composite: 1 }, 'tank', 100), { level: 3, cost: 699, short: 599 });

  assert.equal(sync.craftQuote(P, { scale: 1, fiber: 1, scrap: 0, crystal: 0 }, 'bait', 999), null, 'materials short');
  assert.deepEqual(sync.craftQuote(P, P.startingMaterials, 'composite', 100), { cost: 128, short: 28 });
});

test('equipment comes from the PlayerState; Lv1 and default paths before it exists or after an unsettled bite', () => {
  const current = { rodLevel: 3, netLevel: 3, rodGearLevel: 3, reelLevel: 2, finsLevel: 2, tankLevel: 2, lampLevel: 2, sonarLevel: 3, pearls: 42, legacyPearls: 7, paths: { ...DEFAULT_PATHS, rod: 'fast' } };
  const fresh = sync.equipmentFromChain(current, null);
  assert.deepEqual(
    [fresh.netLevel, fresh.rodLevel, fresh.rodGearLevel, fresh.reelLevel, fresh.finsLevel, fresh.tankLevel, fresh.lampLevel, fresh.sonarLevel],
    [1, 1, 1, 1, 1, 1, 1, 1],
    'everyone starts from zero on chain',
  );
  assert.deepEqual(fresh.paths, equipment.DEFAULT_EQUIPMENT_PATHS);
  assert.equal(fresh.pearls, 42, 'the PEARL cache is the token balance, kept');

  const p = player({ levels: { ...LV1, net: 3, rod: 2, sonar: 2 }, paths: { ...DEFAULT_PATHS, rod: 'fast' } });
  const mirrored = sync.equipmentFromChain(current, p);
  assert.equal(mirrored.netLevel, 3);
  assert.equal(mirrored.rodLevel, 3, 'rodLevel is the legacy alias of the net');
  assert.equal(mirrored.rodGearLevel, 2);
  assert.equal(mirrored.reelLevel, 1, 'a local level the chain does not have is dropped');
  assert.equal(mirrored.sonarLevel, 2);
  assert.equal(mirrored.paths.rod, 'fast');

  const bitten = sync.equipmentFromChain(current, p, true);
  assert.equal(bitten.netLevel, 1);
  assert.equal(bitten.paths.rod, 'far');

  assert.deepEqual(sync.chainLevels(null), LV1);
  assert.deepEqual(sync.synthesisFromChain(null, P), { materials: P.startingMaterials, crafted: { bait: 0, composite: 0 } });
  assert.deepEqual(sync.synthesisFromChain(player({ crafted: { bait: 2, composite: 1 } }), P).crafted, { bait: 2, composite: 1 });
});

test('a shark bite is settled once the chain shows nothing left to reset', () => {
  assert.equal(sync.biteSettled(null), true);
  assert.equal(sync.biteSettled(player()), true);
  assert.equal(sync.biteSettled(player({ levels: { ...LV1, fins: 2 } })), false);
  assert.equal(sync.biteSettled(player({ paths: { ...DEFAULT_PATHS, lamp: 'wideLamp' } })), false);
});

test('aquarium growth is keyed by fishKey(fish.id) and mirrors the account', () => {
  const growth = sync.growthByFishId(aquarium([entry('00c0ffee', { growthMilli: 1400, feedCount: 2, food: 'shrimp', lastFed: 1_700_000_000 })]), ['00c0ffee', 'deadbeef', 'not-hex']);
  assert.deepEqual(Object.keys(growth), ['00c0ffee'], 'never-fed and non-hex fish have no entry');
  assert.deepEqual(growth['00c0ffee'], { feedCount: 2, lastFedAt: 1_700_000_000_000, growthUnits: 1.4, food: 'shrimp' });
  assert.equal(sync.fishKeyHex('c0ffee'), '0000000000c0ffee');
  assert.equal(sync.fishKeyHex('xyz'), null);
});

test('feeding follows feed_one: fully grown first, then the last food\'s cooldown', () => {
  const now = 1_700_000_100;
  assert.equal(sync.feedBlock(undefined, now, P), null, 'a fish never fed can eat');
  assert.equal(sync.feedBlock(entry('a1', { growthMilli: 5000, lastFed: 1 }), now, P), 'max');
  // pellet: 15 s * 1.000 cooldown, plus the 2 s clock margin.
  assert.equal(sync.feedBlock(entry('a1', { food: 'pellet', lastFed: now - 16, feedCount: 1 }), now, P), 'cooldown');
  assert.equal(sync.feedBlock(entry('a1', { food: 'pellet', lastFed: now - 18, feedCount: 1 }), now, P), null);
  // glow coral leaves a shorter cooldown (0.65): 9.75 s.
  assert.equal(sync.feedBlock(entry('a1', { food: 'glowCoral', lastFed: now - 12, feedCount: 1 }), now, P), null);

  const aq = aquarium([
    entry('0a', { growthMilli: 5000, feedCount: 9, lastFed: now - 999 }),
    entry('0b', { food: 'plankton', lastFed: now - 3, feedCount: 4 }),
    entry('0c', { food: 'plankton', lastFed: now - 600, feedCount: 2 }),
  ]);
  const plan = sync.planFeed(aq, ['0a', '0b', '0c', '0d', '0C', 'zz'], now, P);
  assert.deepEqual(plan.ids, ['0c', '0d'], 'grown and full fish skipped, duplicates (same key) and non-hex ids dropped');
  assert.deepEqual(plan.keysHex, ['000000000000000c', '000000000000000d']);
  assert.equal(plan.feedsBefore, 2);
  assert.equal(plan.blocked, null);
  assert.deepEqual(sync.planFeed(aq, ['0a'], now, P).blocked, 'max');
  assert.deepEqual(sync.planFeed(aq, ['0b'], now, P).blocked, 'cooldown');
  assert.equal(sync.planFeed(null, ['01', '02', '03'], now, P, 2).ids.length, 2, 'at most MAX_FISH_PER_CALL per pour');
});

test('a lost confirmation is settled by the re-read accounts only on evidence it landed', () => {
  const v = sync.purchaseVisible;
  assert.equal(v({ v: 1, kind: 'upgrade', slot: 'net', level: 2 }, player({ levels: { ...LV1, net: 2 } }), null), true);
  assert.equal(v({ v: 1, kind: 'upgrade', slot: 'net', level: 2 }, player(), null), false);
  assert.equal(v({ v: 1, kind: 'upgrade', slot: 'net', level: 2 }, null, null), false, 'no account: init_player never landed');
  assert.equal(v({ v: 1, kind: 'synth-upgrade', slot: 'fins', level: 2, composite: 1 }, player({ crafted: { bait: 0, composite: 0 } }), null), true);
  assert.equal(v({ v: 1, kind: 'synth-upgrade', slot: 'fins', level: 2, composite: 1 }, player({ crafted: { bait: 0, composite: 1 } }), null), false);
  assert.equal(v({ v: 1, kind: 'craft', recipe: 'bait', crafted: 0 }, player({ crafted: { bait: 1, composite: 0 } }), null), true);
  assert.equal(v({ v: 1, kind: 'craft', recipe: 'bait', crafted: 1 }, player({ crafted: { bait: 1, composite: 0 } }), null), false);
  const keys = [sync.fishKeyHex('0c')];
  assert.equal(v({ v: 1, kind: 'food', food: 'krill', keys, feeds: 2 }, player(), aquarium([entry('0c', { feedCount: 3, lastFed: 5 })])), true);
  assert.equal(v({ v: 1, kind: 'food', food: 'krill', keys, feeds: 2 }, player(), aquarium([entry('0c', { feedCount: 2, lastFed: 5 })])), false);
  assert.equal(v({ v: 1, kind: 'food', food: 'krill', keys, feeds: 0 }, player(), null), false);
  assert.equal(v({ v: 1, kind: 'path', slot: 'rod', path: 'fast' }, player({ paths: { ...DEFAULT_PATHS, rod: 'fast' } }), null), true);

  assert.equal(sync.isChainPurchase({ kind: 'upgrade', slot: 'net', level: 2 }), false, 'pre-player_state record');
});

test('M1: a journaled payment settles by its signature first; the state only after its blockhash expired', () => {
  const S = sync.settleRecord;
  const MAX = 600_000;
  const up = { what: { v: 1, kind: 'upgrade', slot: 'rod', level: 3 }, ts: 1_000, lastValid: 500 };
  const reached = player({ levels: { ...LV1, rod: 3 } }); // another device got rod to Lv3 meanwhile
  // Not found yet, blockhash still valid: kept (purchases stay locked) even though the state "shows" it.
  assert.equal(S(up, null, 480, 2_000, reached, null, MAX), 'kept');
  assert.equal(S(up, null, undefined, 2_000, reached, null, MAX), 'kept', 'unknown height is not expiry');
  // N2: block height unreadable for good: past maxAge it can no longer land either.
  assert.equal(S(up, null, undefined, 1_000 + MAX, player(), null, MAX), 'kept');
  assert.equal(S(up, null, undefined, 1_001 + MAX, player(), null, MAX), 'dropped');
  assert.equal(S(up, null, undefined, 1_001 + MAX, reached, null, MAX), 'delivered');
  // Confirmed status decides, whatever the state shows.
  assert.equal(S(up, { error: null, commitment: 'confirmed' }, 480, 2_000, player(), null, MAX), 'delivered');
  assert.equal(S(up, { error: { InstructionError: [0, { Custom: 6009 }] }, commitment: 'confirmed' }, 480, 2_000, reached, null, MAX), 'dropped');
  assert.equal(S(up, { error: null, commitment: 'processed' }, 600, 2_000, reached, null, MAX), 'kept', 'processed is not final');
  // Expired and not found: it can no longer land; only now the state breaks the tie.
  assert.equal(S(up, null, 501, 2_000, reached, null, MAX), 'delivered');
  assert.equal(S(up, null, 501, 2_000, player(), null, MAX), 'dropped');
  // A record carrying a shark bite, a setup, or one from before player_state is never "visible".
  assert.equal(S({ ...up, what: { ...up.what, bite: true } }, null, 501, 2_000, reached, null, MAX), 'dropped');
  assert.equal(S({ ...up, what: { v: 1, kind: 'setup' } }, null, 501, 2_000, reached, null, MAX), 'dropped');
  assert.equal(S({ ...up, what: { kind: 'upgrade', slot: 'rod', level: 3 } }, null, 501, 2_000, reached, null, MAX), 'dropped');
  // Without a stored blockhash expiry, age decides.
  const legacy = { what: up.what, ts: 1_000 };
  assert.equal(S(legacy, null, 999, 1_000 + MAX, reached, null, MAX), 'kept');
  assert.equal(S(legacy, null, 999, 1_001 + MAX, reached, null, MAX), 'delivered');
});

test('program errors are recognised in every shape a failed send or confirmation takes', () => {
  const name = errors.playerStateErrorName;
  assert.equal(name({ InstructionError: [1, { Custom: 6009 }] }), 'InsufficientPearl');
  assert.equal(name({ err: { InstructionError: [0, { Custom: 6018 }] } }), 'FeedCooldown');
  assert.equal(name(new Error('Transaction failed: {"InstructionError":[0,{"Custom":6017}]}')), 'FullyGrown');
  assert.equal(name({ cause: { logs: ['Program log: x', 'Program EUzJ failed: custom program error: 0x1775'] } }), 'MaxLevel');
  assert.equal(name({ logs: ['Program log: AnchorError occurred. Error Code: PathLocked. Error Number: 6004.'] }), 'PathLocked');
  assert.equal(name({ InstructionError: [0, { Custom: 1 }] }), null, 'not ours (an SPL token error)');
  // What sendTracked throws for a transaction that failed on chain (payment-safety.ts TxFailedError: .err).
  const failed = Object.assign(new Error('Upgrade failed on-chain'), { name: 'TxFailedError', label: 'Upgrade', err: { InstructionError: [1, { Custom: 6009 }] } });
  assert.equal(name(failed), 'InsufficientPearl');
  assert.equal(name(new Error('User rejected the request')), null);
  assert.equal(errors.PLAYER_STATE_ERRORS.length, 26, 'v1 (20) + v2 (6), lib.rs PlayerStateError order');
});

test('L2: a session-signed set_path the program refused does not fall back to a wallet prompt', () => {
  const final = errors.sessionFailureFinal;
  // Preflight refusal: a plain Error with the simulation logs (neverBroadcast), not a TxFailedError.
  assert.equal(final(Object.assign(new Error('Simulation failed'), { logs: ['Program log: AnchorError thrown. Error Code: PathLocked. Error Number: 6004.'] })), true);
  assert.equal(final(Object.assign(new Error('x'), { name: 'TxFailedError', err: { InstructionError: [0, { Custom: 6004 }] } })), true);
  assert.equal(final(Object.assign(new Error('x'), { name: 'PaymentPendingError' })), true, 'may still land');
  assert.equal(final(Object.assign(new Error('x'), { name: 'PaymentInProgressError' })), true);
  // The session key could not pay, or the RPC was down: the owner's wallet may still do it.
  assert.equal(final(Object.assign(new Error('Attempt to debit an account but found no record of a prior credit.'), { logs: [] })), false);
  assert.equal(final(new Error('fetch failed')), false);
});

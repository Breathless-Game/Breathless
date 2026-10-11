import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js';
import { publicKey, publicKeyBytes } from '@metaplex-foundation/umi';

const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
async function transpile(rel, replace = {}) {
  const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [from, to] of Object.entries(replace)) outputText = outputText.replaceAll(`from '${from}'`, `from '${to}'`).replaceAll(`from "${from}"`, `from "${to}"`);
  return dataUrl(outputText);
}
const walletStub = dataUrl("export const storageKey = (name) => 'deepbreath.' + name;");

// player-state.ts imports umi by bare specifier; a data: module cannot resolve those, so point it at the installed file.
const ps = await import(await transpile('player-state.ts', { '@metaplex-foundation/umi': import.meta.resolve('@metaplex-foundation/umi') }));
const lampUrl = await transpile('lamp-lighting.ts');
const equipment = await import(await transpile('equipment.ts', { './wallet': walletStub, './lamp-lighting': lampUrl }));
const synthesis = await import(await transpile('synthesis.ts', { './wallet': walletStub }));
const foodUrl = await transpile('fish-food.ts');
const fishFood = await import(foodUrl);
const aquariumState = await import(await transpile('aquarium-state.ts', { './fish-food': foodUrl }));
const idl = JSON.parse(await readFile(new URL('../src/idl/player_state.json', import.meta.url), 'utf8'));

const eddsa = createWeb3JsEddsa();
const ctx = { eddsa };
// The e2e player wallet from contracts/DEPLOYED.md; the PDAs below come from @solana/web3.js
// findProgramAddressSync (an independent implementation) for the default program id.
const OWNER = publicKey('4uKAMgmbi5dxgmZJWbrUgaEkc5nzrkGqAaFzZCVnnwkE');

test('program id defaults to the generated key and PDAs match web3.js', () => {
  assert.equal(ps.playerStateProgramId(), 'EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ');
  assert.equal(idl.address, ps.DEFAULT_PLAYER_STATE_PROGRAM_ID);
  assert.deepEqual([...ps.findPlayerStatePda(ctx, OWNER)], ['GjfYA9riPyZ5UZFeF83T1rgr1Z8JqDbyLQMZKJhdnSEf', 253]);
  assert.deepEqual([...ps.findAquariumPda(ctx, OWNER)], ['EoiKgrF2Cv6ha6DmG2kccL66xb7wUYKYyGoxSKEbQemN', 255]);
  assert.deepEqual([...ps.findConfigPda(ctx)], ['3xrnDesVHmrpYZi6R52ux7FmoxaWL5ege53iFN44DtMj', 255]);
});

test('discriminators and account sizes agree with the IDL', () => {
  for (const acc of idl.accounts) assert.deepEqual(acc.discriminator, [...ps.ACCOUNT_DISCRIMINATORS[acc.name]], acc.name);
  for (const ix of idl.instructions) assert.deepEqual(ix.discriminator, [...ps.INSTRUCTION_DISCRIMINATORS[ix.name]], ix.name);
  assert.equal(Object.keys(ps.INSTRUCTION_DISCRIMINATORS).length, idl.instructions.length);
  const types = new Map(idl.types.map((t) => [t.name, t]));
  const PRIM = { u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, pubkey: 32 };
  const size = (t) => {
    if (typeof t === 'string') return PRIM[t];
    if (t.array) return size(t.array[0]) * t.array[1];
    if (t.vec) return 4; // empty
    if (t.defined) return types.get(t.defined.name).type.fields.reduce((n, f) => n + size(f.type), 0);
    throw new Error(JSON.stringify(t));
  };
  assert.equal(8 + size({ defined: { name: 'PlayerState' } }), ps.PLAYER_STATE_SIZE);
  assert.equal(8 + size({ defined: { name: 'Config' } }), ps.CONFIG_SIZE);
  assert.equal(8 + size({ defined: { name: 'Aquarium' } }), ps.AQUARIUM_BASE_SIZE);
  assert.equal(size({ defined: { name: 'FishGrowth' } }), ps.FISH_ENTRY_SIZE);
  // Field order the decoder assumes.
  assert.deepEqual(types.get('PlayerState').type.fields.map((f) => f.name),
    ['version', 'bump', 'flags', 'owner', 'session', 'levels', 'paths', 'materials', 'crafted', 'best_value', 'reserved']);
  assert.deepEqual(types.get('FishGrowth').type.fields.map((f) => f.name), ['key', 'growth_milli', 'feed_count', 'food', 'last_fed']);
});

/** A PlayerState account as the program serializes it (Borsh, little-endian). */
function playerFixture() {
  const b = Buffer.alloc(ps.PLAYER_STATE_SIZE);
  let o = 0;
  b.set(ps.ACCOUNT_DISCRIMINATORS.PlayerState, o); o += 8;
  b[o++] = 1; // version
  b[o++] = 253; // bump
  b.writeUInt16LE(0, o); o += 2; // flags
  b.set(publicKeyBytes(OWNER), o); o += 32;
  o += 32; // session: the default pubkey (all zero) = none
  b.set([2, 1, 3, 1, 1, 2, 3], o); o += 7; // rod reel net fins tank lamp sonar
  b.set([1, 0, 0, 1, 0, 0], o); o += 6; // rod: fast, fins: silent
  for (const m of [6, 7, 10, 3]) { b.writeUInt32LE(m, o); o += 4; }
  for (const c of [1, 2]) { b.writeUInt32LE(c, o); o += 4; }
  b.writeBigUInt64LE(12345n, o); o += 8;
  assert.equal(o + 128, b.length);
  return new Uint8Array(b);
}

test('decodes PlayerState into the game equipment and synthesis shapes', () => {
  const p = ps.decodePlayerState(playerFixture());
  assert.equal(p.owner, OWNER);
  assert.equal(p.session, null);
  assert.deepEqual(p.levels, { rod: 2, reel: 1, net: 3, fins: 1, tank: 1, lamp: 2, sonar: 3 });
  assert.deepEqual(p.paths, { rod: 'fast', reel: 'fastReel', net: 'wide', fins: 'silent', tank: 'long', lamp: 'focus' });
  assert.equal(p.bestValue, 12345n);
  assert.deepEqual(ps.toEquipmentState(p), {
    rodLevel: 3, netLevel: 3, rodGearLevel: 2, reelLevel: 1, finsLevel: 1, tankLevel: 1, lampLevel: 2, sonarLevel: 3,
    paths: { rod: 'fast', reel: 'fastReel', net: 'wide', fins: 'silent', tank: 'long', lamp: 'focus' },
  });
  const synth = ps.toSynthesisState(p);
  assert.deepEqual(synth, { materials: { scale: 6, fiber: 7, scrap: 10, crystal: 3 }, crafted: { bait: 1, composite: 2 } });
  assert.deepEqual(synthesis.normalizeSynthesis(synth), synth);
  // A path the slot decodes to is one the game accepts.
  for (const [slot, path] of Object.entries(p.paths)) assert.ok(equipment.EQUIPMENT_PATHS[slot].some((d) => d.id === path));
  const wrong = playerFixture(); wrong[0] ^= 1;
  assert.throws(() => ps.decodePlayerState(wrong), /Not a PlayerState/);
});

test('decodes the aquarium growth table into AquariumGrowth records', () => {
  const b = Buffer.alloc(ps.AQUARIUM_BASE_SIZE + 2 * ps.FISH_ENTRY_SIZE);
  b.set(ps.ACCOUNT_DISCRIMINATORS.Aquarium, 0);
  b[8] = 1; b[9] = 255;
  b.set(publicKeyBytes(OWNER), 10);
  b.writeUInt32LE(2, 58);
  const entry = (o, key, growth, count, food, last) => {
    b.set(key, o); b.writeUInt16LE(growth, o + 8); b[o + 10] = count; b[o + 11] = food; b.writeUInt32LE(last, o + 12);
  };
  entry(62, ps.fishKey('0000beef'), 1900, 1, 4, 1_760_000_000);
  entry(78, ps.fishKey('a1b2c3d4'), 5000, 4, 0, 1_760_000_100);
  const aq = ps.decodeAquarium(new Uint8Array(b));
  assert.equal(aq.owner, OWNER);
  assert.deepEqual(aq.entries.map((e) => e.keyHex), ['000000000000beef', '00000000a1b2c3d4']);
  assert.deepEqual(ps.toAquariumGrowth(aq.entries[0]), { feedCount: 1, lastFedAt: 1_760_000_000_000, growthUnits: 1.9, food: 'glowCoral' });
  const full = ps.toAquariumGrowth(aq.entries[1]);
  assert.equal(aquariumState.growthScaleForGrowth(full), 1 + aquariumState.MAX_GROWTH_UNITS * aquariumState.GROWTH_PER_FEED);
  assert.equal(aquariumState.feedFish(full, 'pellet', 1_760_000_200_000).reason, 'max');
  assert.deepEqual([...ps.fishKey('0000beef')], [0, 0, 0, 0, 0, 0, 0xbe, 0xef]);
  assert.throws(() => ps.fishKey('not-hex'));
});

test('Config round-trips through the price-table encoder', () => {
  const table = ps.encodePriceTable(ps.GAME_PRICE_TABLE);
  assert.equal(table.length, ps.CONFIG_SIZE - 8 - 2 - 4 * 32 - 64);
  const b = Buffer.alloc(ps.CONFIG_SIZE);
  b.set(ps.ACCOUNT_DISCRIMINATORS.Config, 0);
  b[8] = 1; b[9] = 255;
  const keys = [OWNER, publicKey('12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd'), publicKey('3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp'), publicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')];
  keys.forEach((k, i) => b.set(publicKeyBytes(k), 10 + 32 * i));
  b.set(table, 138);
  const cfg = ps.decodeConfig(new Uint8Array(b));
  assert.deepEqual([cfg.admin, cfg.oracle, cfg.pearlMint, cfg.tokenProgram], keys);
  assert.deepEqual(cfg.prices, ps.GAME_PRICE_TABLE);
});

test('GAME_PRICE_TABLE and the index orders mirror the game tables', () => {
  const t = ps.GAME_PRICE_TABLE;
  assert.deepEqual([...ps.SLOT_ORDER], [...equipment.DIVE_GEAR_SLOTS]);
  for (const slot of ps.SLOT_ORDER) {
    assert.deepEqual(t.upgrade[slot].map(Number), equipment.EQUIPMENT_TIERS[slot].map((tier) => tier.cost), slot);
    assert.deepEqual(t.synthUpgrade[slot].map(Number), [...synthesis.SYNTHESIS_UPGRADE_COSTS[slot]], slot);
  }
  for (const slot of ps.PATH_SLOT_ORDER) {
    assert.equal(ps.PATH_IDS[slot][0], equipment.DEFAULT_EQUIPMENT_PATHS[slot]);
    assert.deepEqual(new Set(ps.PATH_IDS[slot]), new Set(equipment.EQUIPMENT_PATHS[slot].map((p) => p.id)));
  }
  assert.deepEqual([...ps.MATERIAL_ORDER], synthesis.MATERIALS.map((m) => m.id));
  assert.deepEqual([...ps.RECIPE_ORDER], synthesis.RECIPES.map((r) => r.id));
  for (const r of synthesis.RECIPES) {
    assert.equal(Number(t.recipeCost[r.id]), synthesis.SYNTHESIS_RECIPE_COSTS[r.id]);
    for (const m of ps.MATERIAL_ORDER) assert.equal(t.recipeNeeds[r.id][m], r.needs[m] ?? 0);
  }
  assert.deepEqual(t.startingMaterials, { ...synthesis.DEFAULT_SYNTHESIS.materials });
  assert.deepEqual([...ps.FOOD_ORDER], [...fishFood.FISH_FOOD_KINDS]);
  for (const f of fishFood.FISH_FOODS) {
    assert.equal(Number(t.foodPrice[f.id]), f.price);
    assert.equal(t.foodGrowthMilli[f.id], Math.round(f.growthMultiplier * 1000));
    assert.equal(t.foodCooldownMilli[f.id], Math.round(f.feedCooldownMultiplier * 1000));
  }
  assert.equal(t.feedCooldownMs, aquariumState.FEED_COOLDOWN_MS);
  assert.equal(t.maxGrowthMilli, aquariumState.MAX_GROWTH_UNITS * 1000);
});

test('instruction builders lay out accounts and data like the program', () => {
  const signer = (pk) => ({ publicKey: publicKey(pk), signMessage: async () => new Uint8Array(), signTransaction: async (x) => x, signAllTransactions: async (x) => x });
  const owner = signer(OWNER);
  const pearl = { pearlMint: publicKey('3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp'), tokenProgram: publicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
  const [buy] = ps.buyUpgrade(ctx, { owner, slot: 'net', ...pearl }).getInstructions();
  assert.deepEqual([...buy.data], [...ps.INSTRUCTION_DISCRIMINATORS.buy_upgrade, 2]);
  assert.deepEqual(buy.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), [
    [OWNER, true, false],
    ['3xrnDesVHmrpYZi6R52ux7FmoxaWL5ege53iFN44DtMj', false, false],
    ['GjfYA9riPyZ5UZFeF83T1rgr1Z8JqDbyLQMZKJhdnSEf', false, true],
    [pearl.pearlMint, false, true],
    [ps.findPearlAta(ctx, OWNER, pearl.pearlMint, pearl.tokenProgram)[0], false, true],
    [pearl.tokenProgram, false, false],
  ]);
  const idlIx = (name) => idl.instructions.find((i) => i.name === name);
  assert.deepEqual(idlIx('buy_upgrade').accounts.map((a) => a.name), ['owner', 'config', 'player', 'pearl_mint', 'owner_pearl', 'token_program']);

  const [path] = ps.setPath(ctx, { authority: owner, owner: OWNER, slot: 'fins', path: 'silent' }).getInstructions();
  assert.deepEqual([...path.data], [...ps.INSTRUCTION_DISCRIMINATORS.set_path, 3, 1]);

  const fish = [ps.fishKey('0000beef'), ps.fishKey('a1b2c3d4')];
  const [fed] = ps.feed(ctx, { owner, food: 'krill', fish, ...pearl }).getInstructions();
  assert.deepEqual([...fed.data], [...ps.INSTRUCTION_DISCRIMINATORS.feed, 2, 2, 0, 0, 0, ...fish[0], ...fish[1]]);
  assert.equal(fed.keys.length, idlIx('feed').accounts.length);
  assert.equal(fed.keys[2].pubkey, 'EoiKgrF2Cv6ha6DmG2kccL66xb7wUYKYyGoxSKEbQemN');
  assert.throws(() => ps.feed(ctx, { owner, food: 'krill', fish: Array.from({ length: 65 }, () => fish[0]), ...pearl }));

  const [init] = ps.initPlayer(ctx, { owner }).getInstructions();
  assert.equal(init.data.length, 8 + 32);
  assert.equal(init.keys.length, idlIx('init_player').accounts.length);
  const [cfg] = ps.initializeConfig(ctx, { admin: owner, oracle: publicKey('12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd'), ...pearl }).getInstructions();
  assert.equal(cfg.data.length, 8 + 32 + ps.encodePriceTable(ps.GAME_PRICE_TABLE).length);
  assert.equal(cfg.keys.length, idlIx('initialize_config').accounts.length);
});

// Real account bytes from the program on a local validator (contracts: PLAYER_STATE_WRITE_FIXTURES=1 npm run test:player-state).
const real = JSON.parse(await readFile(new URL('./fixtures/player-state-accounts.json', import.meta.url), 'utf8'));
const bytes = (snap) => new Uint8Array(Buffer.from(snap.data, 'base64'));

test('decodes real program accounts', () => {
  assert.equal(real.programId, ps.DEFAULT_PLAYER_STATE_PROGRAM_ID);
  const cfgBytes = bytes(real.config);
  assert.equal(cfgBytes.length, ps.CONFIG_SIZE);
  const cfg = ps.decodeConfig(cfgBytes);
  assert.equal(cfg.admin, real.config.admin);
  assert.equal(cfg.oracle, '12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd');
  assert.equal(cfg.pearlMint, real.config.pearlMint);
  assert.equal(cfg.tokenProgram, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  assert.deepEqual(cfg.prices, ps.GAME_PRICE_TABLE);
  // The encoder writes exactly the bytes the program stored.
  const table = ps.encodePriceTable(ps.GAME_PRICE_TABLE);
  assert.deepEqual([...cfgBytes.slice(138, 138 + table.length)], [...table]);

  const playerBytes = bytes(real.player);
  assert.equal(playerBytes.length, ps.PLAYER_STATE_SIZE);
  const p = ps.decodePlayerState(playerBytes);
  assert.equal(p.owner, real.player.owner);
  assert.equal(p.session, null);
  assert.deepEqual(p.levels, { rod: 2, reel: 1, net: 1, fins: 1, tank: 1, lamp: 1, sonar: 3 });
  assert.deepEqual(p.materials, { scale: 6, fiber: 1, scrap: 1, crystal: 0 });
  assert.deepEqual(p.crafted, { bait: 1, composite: 0 });
  assert.equal(p.bestValue, 0n);

  const aq = ps.decodeAquarium(bytes(real.aquarium));
  assert.equal(aq.owner, real.aquarium.owner);
  assert.deepEqual(Object.fromEntries(aq.entries.map((e) => [e.keyHex, e.growthMilli])), real.aquarium.growth);
  assert.deepEqual(aq.entries.map((e) => e.keyHex), Object.keys(real.aquarium.growth).sort());
  for (const e of aq.entries) assert.ok(e.lastFed > 1_700_000_000 && e.feedCount === 1);
});

// ---- v2: Progress ----------------------------------------------------------------

test('v2 account sizes, field order and builders agree with the IDL', () => {
  const types = new Map(idl.types.map((t) => [t.name, t]));
  const PRIM = { u8: 1, u16: 2, u32: 4, u64: 8, pubkey: 32 };
  const size = (t) => (typeof t === 'string' ? PRIM[t] : t.array ? size(t.array[0]) * t.array[1]
    : types.get(t.defined.name).type.fields.reduce((n, f) => n + size(f.type), 0));
  assert.equal(8 + size({ defined: { name: 'Progress' } }), ps.PROGRESS_HEADER_SIZE);
  assert.equal(8 + size({ defined: { name: 'ProgressConfig' } }), ps.PROGRESS_CONFIG_SIZE);
  assert.deepEqual(types.get('Progress').type.fields.map((f) => f.name),
    ['version', 'bump', 'owner', 'lifetime_value', 'best_value', 'catches', 'boat_levels', 'ship', 'reserved']);
  assert.deepEqual(types.get('ProgressRules').type.fields.map((f) => f.name), ['boat_prices', 'ship_thresholds', 'map_thresholds']);

  const signer = (pk) => ({ publicKey: publicKey(pk), signMessage: async () => new Uint8Array(), signTransaction: async (x) => x, signAllTransactions: async (x) => x });
  const MARKET = '12b3GY2Pbh4HnNaLqL7GszmeFrcrfiULwfLz5HcF7gRd';
  const SESSION = 'EA77L4HGz15Urk1Ycohju77Ufb1hJCa4g5z4Xfdwz9To';
  const idlIx = (name) => idl.instructions.find((i) => i.name === name);
  const progress = ps.findProgressPda(ctx, OWNER)[0];

  const [rec] = ps.recordCatch(ctx, { oracle: signer(MARKET), payer: signer(SESSION), owner: OWNER, fish: ps.fishSeedKey('0badf00d'), value: 60 }).getInstructions();
  assert.deepEqual([...rec.data], [...ps.INSTRUCTION_DISCRIMINATORS.record_catch, 0x0d, 0xf0, 0xad, 0x0b, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rec.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), [
    [MARKET, true, false],
    [SESSION, true, true],
    ['3xrnDesVHmrpYZi6R52ux7FmoxaWL5ege53iFN44DtMj', false, false],
    [OWNER, false, false],
    [progress, false, true],
    ['11111111111111111111111111111111', false, false],
  ]);
  assert.deepEqual(idlIx('record_catch').accounts.map((a) => a.name), ['oracle', 'payer', 'config', 'owner', 'progress', 'system_program']);

  const pearl = { pearlMint: publicKey('3aX1muNxajg9VuxfigrVk2f7dGdCedJ67kUsAqCc9drp'), tokenProgram: publicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
  const [boat] = ps.buyBoat(ctx, { owner: signer(OWNER), boat: 'boatHull', level: 2, ...pearl }).getInstructions();
  assert.deepEqual([...boat.data], [...ps.INSTRUCTION_DISCRIMINATORS.buy_boat, 3, 2]);
  assert.deepEqual(boat.keys.map((k) => k.pubkey), [OWNER, '3xrnDesVHmrpYZi6R52ux7FmoxaWL5ege53iFN44DtMj', ps.findProgressConfigPda(ctx)[0], progress,
    pearl.pearlMint, ps.findPearlAta(ctx, OWNER, pearl.pearlMint, pearl.tokenProgram)[0], pearl.tokenProgram, '11111111111111111111111111111111']);
  assert.deepEqual(idlIx('buy_boat').accounts.map((a) => a.name),
    ['owner', 'config', 'progress_config', 'progress', 'pearl_mint', 'owner_pearl', 'token_program', 'system_program']);
  assert.deepEqual(idlIx('set_ship').accounts.map((a) => a.name), ['owner', 'progress_config', 'progress']);
  assert.deepEqual(idlIx('init_progress_config').accounts.map((a) => a.name), ['admin', 'config', 'progress_config', 'system_program']);
  assert.deepEqual(idlIx('set_progress_config').accounts.map((a) => a.name), ['admin', 'config', 'progress_config']);
});

test('decodes Progress, its catch log and ProgressConfig; unlocks follow the thresholds', () => {
  const b = Buffer.alloc(ps.PROGRESS_HEADER_SIZE + 2 * 8);
  let o = 0;
  b.set(ps.ACCOUNT_DISCRIMINATORS.Progress, o); o += 8;
  b[o++] = 1; b[o++] = 254;
  b.set(publicKeyBytes(OWNER), o); o += 32;
  b.writeBigUInt64LE(160n, o); o += 8;
  b.writeBigUInt64LE(100n, o); o += 8;
  b.writeUInt32LE(2, o); o += 4;
  b.set([2, 1, 3, 1, 1], o); o += 5;
  b[o++] = 2;
  b.writeBigUInt64LE(7n, ps.PROGRESS_HEADER_SIZE);
  b.writeBigUInt64LE(0x0badf00dn, ps.PROGRESS_HEADER_SIZE + 8);
  const p = ps.decodeProgress(b);
  assert.equal(p.owner, OWNER);
  assert.equal(p.lifetimeValue, 160n);
  assert.equal(p.bestValue, 100n);
  assert.equal(p.catches, 2);
  assert.deepEqual(p.boatLevels, { bait: 2, boat: 1, boatSpeed: 3, boatHull: 1, boatDeck: 1 });
  assert.equal(p.ship, 2);
  assert.deepEqual(ps.decodeCatchLog(b), [7n, 0x0badf00dn]);
  assert.throws(() => ps.decodeProgress(Buffer.alloc(100)), /Not a Progress/);

  const rules = ps.encodeProgressRules(ps.GAME_PROGRESS_RULES);
  const c = Buffer.alloc(ps.PROGRESS_CONFIG_SIZE);
  c.set(ps.ACCOUNT_DISCRIMINATORS.ProgressConfig, 0); c[8] = 1; c[9] = 255; c.set(rules, 10);
  assert.deepEqual(ps.decodeProgressConfig(c).rules, ps.GAME_PROGRESS_RULES);
  assert.equal(rules.length, (15 + 6 + 3) * 8);

  const r = ps.GAME_PROGRESS_RULES;
  assert.deepEqual(ps.unlockedMaps(149n, r), ['fjord']);
  assert.deepEqual(ps.unlockedMaps(150n, r), ['fjord', 'tianchi']);
  assert.deepEqual(ps.unlockedMaps(1000n, r), ['fjord', 'tianchi', 'ocean']);
  assert.deepEqual(ps.unlockedShips(160n, r), [0, 1, 2]);
  assert.equal(ps.fishSeedKey('ffffffff'), 0xffffffffn);
  assert.throws(() => ps.fishSeedKey('xyz'));
});

test('GAME_PROGRESS_RULES mirror upgrades.ts boat prices and ships.ts thresholds', async () => {
  const upgrades = await readFile(new URL('../src/upgrades.ts', import.meta.url), 'utf8');
  for (const id of ps.BOAT_ORDER) {
    const m = new RegExp(`id: '${id}', group: 'boat'.*prices: \\[(\\d+), (\\d+), (\\d+)\\]`).exec(upgrades);
    assert.ok(m, id);
    assert.deepEqual(ps.GAME_PROGRESS_RULES.boatPrices[id], m.slice(1).map(BigInt), id);
  }
  const ships = await readFile(new URL('../src/ships.ts', import.meta.url), 'utf8');
  assert.deepEqual(ps.GAME_PROGRESS_RULES.shipThresholds, [...ships.matchAll(/threshold: (\d+)/g)].map((m) => BigInt(m[1])));
  // maps.ts defaults (until the first read) are the deployed map thresholds, and a map opens only
  // on a chain-read lifetime value, never on the cached one.
  const maps = await readFile(new URL('../src/maps.ts', import.meta.url), 'utf8');
  assert.deepEqual([...maps.matchAll(/unlockValue: (\d+),/g)].map((m) => BigInt(m[1])), ps.MAP_ORDER.map((id) => ps.GAME_PROGRESS_RULES.mapThresholds[id]));
  assert.match(maps, /map\.unlockValue <= 0 \|\| \(progress\.verified && progress\.bestValue >= map\.unlockValue\)/);
  assert.doesNotMatch(maps, /unlockAll/, 'no local switch opens every map');
});

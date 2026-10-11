import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// The pure halves of a shark bite on the Open Ocean: which upgrades reset (equipment.ts
// resetDiveGear) and which banked fish a bite may take back (market.ts biteForfeit).

// Stand-in for wallet.ts: equipment.ts only needs storageKey, and the real one pulls in Umi and wallets.
const WALLET_STUB = `data:text/javascript;base64,${Buffer.from("export const storageKey = (name) => (name.startsWith('deepbreath.') ? name : 'deepbreath.' + name);").toString('base64')}`;

async function load(file) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const code = outputText.replace(/from ['"]\.\/wallet['"]/g, `from '${WALLET_STUB}'`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

// upgrades.ts imports the Three.js model builders: load it as CommonJS, as upgrade-models.test.mjs does.
const require = createRequire(import.meta.url);
const THREE = require('three');
const mergeUtils = await import('three/addons/utils/BufferGeometryUtils.js');
const cache = new Map();
function loadCjs(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const localRequire = (specifier) =>
    specifier === './wallet'
      ? { storageKey: (key) => key }
      : specifier.startsWith('.')
        ? loadCjs(path.resolve(path.dirname(file), `${specifier}.ts`))
        : specifier === 'three/addons/utils/BufferGeometryUtils.js'
          ? mergeUtils
          : specifier === 'three'
            ? THREE
            : require(specifier);
  new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
  return module.exports;
}

const { DIVE_GEAR_SLOTS, DEFAULT_EQUIPMENT_PATHS, deriveStats, ownedLevel, activePath, resetDiveGear } = await load('../src/equipment.ts');
const { bankEntry, biteForfeit, unsettled, nftStep } = await load('../src/market.ts');
const { UPGRADES } = loadCjs(fileURLToPath(new URL('../src/upgrades.ts', import.meta.url)));

const maxed = () => ({
  rodLevel: 3,
  netLevel: 3,
  rodGearLevel: 3,
  reelLevel: 2,
  finsLevel: 3,
  tankLevel: 2,
  lampLevel: 3,
  sonarLevel: 3,
  pearls: 420,
  legacyPearls: 15,
  paths: { rod: 'fast', net: 'fine', fins: 'silent', tank: 'light', lamp: 'wideLamp', reel: 'silentReel' },
});

const base = () => ({ ...maxed(), rodLevel: 1, netLevel: 1, rodGearLevel: 1, reelLevel: 1, finsLevel: 1, tankLevel: 1, lampLevel: 1, sonarLevel: 1, paths: { ...DEFAULT_EQUIPMENT_PATHS } });

test('the reset list is exactly the dive group of upgrades.ts; the boat group is not in it', () => {
  const dive = UPGRADES.filter((u) => u.group === 'dive').map((u) => u.id).sort();
  assert.deepEqual([...DIVE_GEAR_SLOTS].sort(), dive);
  assert.deepEqual(dive, ['fins', 'lamp', 'net', 'reel', 'rod', 'sonar', 'tank']);
  const boat = UPGRADES.filter((u) => u.group === 'boat').map((u) => u.id).sort();
  assert.deepEqual(boat, ['bait', 'boat', 'boatDeck', 'boatHull', 'boatSpeed']);
  for (const id of boat) assert.ok(!DIVE_GEAR_SLOTS.includes(id), `${id} must be kept`);
});

test('resetDiveGear drops every dive slot to level 1 and reports what it had', () => {
  const { state, dropped } = resetDiveGear(maxed());
  for (const slot of DIVE_GEAR_SLOTS) assert.equal(ownedLevel(state, slot), 1, slot);
  assert.equal(state.rodLevel, 1, 'the legacy rodLevel follows the net');
  assert.deepEqual(
    dropped,
    [
      { slot: 'rod', from: 3 },
      { slot: 'reel', from: 2 },
      { slot: 'net', from: 3 },
      { slot: 'fins', from: 3 },
      { slot: 'tank', from: 2 },
      { slot: 'lamp', from: 3 },
      { slot: 'sonar', from: 3 },
    ],
  );
});

test('resetDiveGear keeps both Pearl balances: nothing is refunded, nothing is charged', () => {
  const { state } = resetDiveGear(maxed());
  assert.equal(state.pearls, 420);
  assert.equal(state.legacyPearls, 15);
});

test('after a reset the stats are the starting ones: base net capacity and no path bonus', () => {
  const before = deriveStats(maxed());
  assert.ok(before.netCapacity > 6, 'the maxed net carries more than the base');
  const { state } = resetDiveGear(maxed());
  assert.deepEqual(deriveStats(state), deriveStats(base()));
  assert.equal(deriveStats(state).netCapacity, 6);
  assert.deepEqual(state.paths, DEFAULT_EQUIPMENT_PATHS);
  for (const slot of ['rod', 'net', 'fins', 'tank', 'lamp', 'reel']) assert.equal(activePath(state, slot), DEFAULT_EQUIPMENT_PATHS[slot]);
  // With every packed slot too: a loadout cannot bring a level back.
  assert.deepEqual(deriveStats(state, ['net', 'rod', 'reel', 'fins', 'tank', 'lamp']), deriveStats(base()));
});

test('resetDiveGear on starting gear changes nothing and drops nothing', () => {
  const { state, dropped } = resetDiveGear(base());
  assert.deepEqual(dropped, []);
  assert.deepEqual(state, base());
});

test('resetDiveGear is pure: the state passed in is untouched', () => {
  const s = maxed();
  resetDiveGear(s);
  assert.deepEqual(s, maxed());
});

// ---- Which banked fish a bite takes back ------------------------------------

const fish = (id, extra = {}) => ({ ...bankEntry({ id, species: 'Test', rarity: 'common', hue: 0, sat: 0, light: 0, seed: 1, depthM: 5 }), ...extra });

test('unsettled: only a queued fish that never started minting and is in no sale', () => {
  assert.equal(unsettled(fish('a')), true);
  assert.equal(unsettled(fish('a', { serial: 42 })), true, 'a number from the server is not a mint');
  assert.equal(unsettled(nftStep(fish('a'), { type: 'start' })), false, 'minting');
  assert.equal(unsettled(fish('a', { nft: 'minted', assetId: 'X', mintTx: 'T' })), false, 'minted');
  assert.equal(unsettled(fish('a', { nft: 'failed', mintTries: 1 })), false, 'a failed mint attempt was sent');
  assert.equal(unsettled(fish('a', { mintTries: 1 })), false, 'tried before, back in the queue');
  assert.equal(unsettled(fish('a', { sellQueued: true })), false, 'sale pending');
  assert.equal(unsettled({ ...fish('a'), nft: undefined, legacy: true }), false, 'legacy');
});

test('biteForfeit takes only this dive\'s unsettled fish', () => {
  const earlierPending = fish('earlier-pending');
  const earlierMinted = fish('earlier-minted', { nft: 'minted', assetId: 'A1', mintTx: 'T1' });
  const pending = fish('pending');
  const pending2 = fish('pending-2', { serial: 7 });
  const minting = fish('minting', { nft: 'minting' });
  const minted = fish('minted', { nft: 'minted', assetId: 'A2', mintTx: 'T2' });
  const failed = fish('failed', { nft: 'failed', mintTries: 2, retryAt: 1 });
  const forSale = fish('for-sale', { sellQueued: true });
  const mintedForSale = fish('minted-for-sale', { nft: 'minted', assetId: 'A3', sellQueued: true });
  const bank = [earlierPending, earlierMinted, pending, minting, pending2, minted, failed, forSale, mintedForSale];
  const thisDive = new Set([pending, minting, pending2, minted, failed, forSale, mintedForSale]);

  assert.deepEqual(biteForfeit(bank, thisDive), [pending, pending2]);
  // Earlier dives are never touched, even if still queued.
  assert.ok(!biteForfeit(bank, thisDive).includes(earlierPending));
});

test('biteForfeit leaves a fish the NFT queue holds right now (in flight), even if it still reads pending', () => {
  const a = fish('a');
  const b = fish('b');
  const held = new Set([b]);
  assert.deepEqual(biteForfeit([a, b], new Set([a, b]), (f) => held.has(f)), [a]);
});

test('biteForfeit with nothing banked this dive takes nothing', () => {
  const bank = [fish('a'), fish('b')];
  assert.deepEqual(biteForfeit(bank, new Set()), []);
});

test('biteForfeit never mutates the bank (the NFT queue removes what it returns)', () => {
  const a = fish('a');
  const bank = [a];
  biteForfeit(bank, new Set([a]));
  assert.deepEqual(bank, [a]);
});

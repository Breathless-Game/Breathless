import assert from 'node:assert/strict';
import test from 'node:test';
import { CURRENT_GENERATOR, GENERATORS, GENERATOR_V2, GENERATOR_V3, RARITY_BY_DEPTH } from '../fish-gen.mjs';
import { checkFish, rarityInterval } from '../fish-trust.mjs';

// Generator v3: legendary and mythic halved at every depth, the freed weight moved to rare and
// epic, same 35-species roster as v2. Fish rolled with v2 are on-chain and must keep verifying.

const EPS = 1e-9;
const LEG = 4;
const MYTH = 5;

// depth-odds.ts from PR #102 until v3. Pinned so the port's copy is never "updated" by mistake.
const V2_TABLE = [
  [0, [92, 8, 0, 0, 0, 0]],
  [18, [75, 25, 0, 0, 0, 0]],
  [40, [55, 32, 13, 0, 0, 0]],
  [50, [48, 33, 16, 3, 0, 0]],
  [80, [35, 34, 24, 7, 0, 0]],
  [120, [9, 27, 30, 17, 12, 5]],
  [150, [3, 24, 33, 20.6, 14, 5.4]],
  [200, [0, 17, 34, 26, 17, 6]],
  [350, [0, 6, 30, 31, 23, 10]],
];

const facts = (f) => ({ id: f.id, rarity: f.rarity, species: f.species, depth: f.depthM, value: f.value });

test('v3 is today\'s generator, tried first; v2 and v1 are kept', () => {
  assert.equal(CURRENT_GENERATOR, GENERATOR_V3);
  assert.equal(GENERATOR_V3.version, 3);
  assert.deepEqual(GENERATORS.map((g) => g.version), [3, 2, 1]);
  assert.equal(RARITY_BY_DEPTH, GENERATOR_V3.RARITY_BY_DEPTH);
  assert.deepEqual(GENERATOR_V2.RARITY_BY_DEPTH, V2_TABLE);
  // v3 kept the 35-species roster; the parity test checks it against game/src/fish.ts.
  assert.equal(GENERATOR_V3.SPECIES_BY_RARITY, GENERATOR_V2.SPECIES_BY_RARITY);
  assert.equal(Object.values(GENERATOR_V3.SPECIES_BY_RARITY).flat().length, 35);
});

test('v3 rows sum to 100 at the same anchor depths as v2', () => {
  assert.deepEqual(GENERATOR_V3.RARITY_BY_DEPTH.map(([d]) => d), V2_TABLE.map(([d]) => d));
  for (const [depth, row] of GENERATOR_V3.RARITY_BY_DEPTH) {
    assert.equal(row.length, 6);
    assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 100) < EPS, `row at ${depth} m sums to 100`);
  }
});

test('v3 halves legendary and mythic at 120 / 150 / 200 / 350 m and gives the rest to rare and epic', () => {
  for (const [i, [depth, v3]] of GENERATOR_V3.RARITY_BY_DEPTH.entries()) {
    const v2 = V2_TABLE[i][1];
    if (depth < 120) {
      assert.deepEqual(v3, v2, `${depth} m unchanged`);
      continue;
    }
    assert.ok(Math.abs(v3[LEG] - v2[LEG] / 2) < EPS, `legendary halved at ${depth} m`);
    assert.ok(Math.abs(v3[MYTH] - v2[MYTH] / 2) < EPS, `mythic halved at ${depth} m`);
    assert.deepEqual(v3.slice(0, 2), v2.slice(0, 2), `common and uncommon unchanged at ${depth} m`);
    assert.ok(v3[2] > v2[2] && v3[3] > v2[3], `rare and epic grew at ${depth} m`);
    const freed = (v2[LEG] + v2[MYTH]) / 2;
    assert.ok(Math.abs(v3[2] - v2[2] + (v3[3] - v2[3]) - freed) < EPS, `freed weight goes to rare + epic at ${depth} m`);
  }
  // Interpolated depths are halved too (both tables are linear between the same anchors).
  for (const depth of [81, 100, 135, 175.5, 275, 349, 500]) {
    const tail = (gen) => gen.rarityOdds(depth).filter(([r]) => r === 'legendary' || r === 'mythic').reduce((a, [, w]) => a + w, 0);
    assert.ok(Math.abs(tail(GENERATOR_V3) - tail(GENERATOR_V2) / 2) < EPS, `legendary + mythic halved at ${depth} m`);
  }
});

test('every version still reaches a mythic below 235 m, so the top value a forger can claim is unchanged', () => {
  for (const gen of GENERATORS) {
    for (const depth of [234, 235, 300, 1000]) {
      assert.ok(gen.rarityOdds(depth).some(([r]) => r === 'mythic'), `v${gen.version} mythic at ${depth} m`);
    }
  }
});

test('a fish rolled with v3 odds verifies, as v3', () => {
  let legendaryOrBetter = 0;
  for (let s = 11; s < 11 + 400 * 104729; s += 104729) {
    const spawn = 81 + (s % 400);
    const f = { ...GENERATOR_V3.rollFish(s, spawn), depthM: Math.round(spawn) };
    const r = checkFish(facts(f));
    assert.ok(r.ok, `v3 seed ${s} at ${spawn} m: ${r.reason}`);
    assert.equal(r.version, 3);
    assert.deepEqual(r.fish, GENERATOR_V3.fishOf(s, f.rarity));
    if (f.rarity === 'legendary' || f.rarity === 'mythic') legendaryOrBetter++;
  }
  assert.ok(legendaryOrBetter > 0);
});

test('a v2-minted mythic that v3 could never have rolled there still verifies, as v2', () => {
  const spawn = 130;
  let seed = 1;
  while (!(GENERATOR_V2.rarityAt(seed, spawn) === 'mythic' && rarityInterval(seed, 'mythic', 0, 260, GENERATOR_V3) === null)) seed++;
  const f = { ...GENERATOR_V2.rollFish(seed, spawn), depthM: spawn };
  assert.equal(f.rarity, 'mythic');
  assert.notEqual(GENERATOR_V3.rarityAt(seed, spawn), 'mythic');
  const r = checkFish(facts(f));
  assert.ok(r.ok, r.reason);
  assert.equal(r.version, 2);
  assert.deepEqual(r.fish, GENERATOR_V2.fishOf(seed, 'mythic'));
});

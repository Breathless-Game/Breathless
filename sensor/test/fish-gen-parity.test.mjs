import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { GENERATORS, GENERATOR_V1, RARITY_BY_DEPTH, fishLook, rarityOdds, recordedDepth, rollFish } from '../fish-gen.mjs';

// The market re-derives every fish it co-signs or buys with fish-gen.mjs, a port of the game's
// generator. This runs the game's own TypeScript (fish.ts and every module it imports, plus
// nft-uri.ts) next to the port and requires identical fish for many seeds and depths. The
// TypeScript compiler comes from game/node_modules (npm --prefix game install); three.js is stubbed
// (the generator never touches it). game/tests/fish-cosign.test.mjs runs the same check in CI.

const GAME = new URL('../../game/', import.meta.url);
const TS = new URL('node_modules/typescript/lib/typescript.js', GAME);

/**
 * Transpile `entries` (game/src module names) and every module they import, found by following the
 * relative imports left in the transpiled output (type-only imports are erased), into a temp dir as
 * .mjs. Returns the loaded entry modules by name.
 */
export async function loadGameModules(entries) {
  const ts = (await import(TS.href)).default;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-gen-parity-'));
  try {
    writeFileSync(path.join(dir, 'three.mjs'), 'export {};\n');
    const todo = [...entries];
    const done = new Set();
    while (todo.length) {
      const name = todo.pop();
      if (done.has(name)) continue;
      done.add(name);
      const src = readFileSync(new URL(`src/${name}.ts`, GAME), 'utf8');
      let js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
      for (const [, dep] of js.matchAll(/from '\.\/([\w-]+)'/g)) todo.push(dep);
      js = js.replace(/from 'three'/g, "from './three.mjs'").replace(/from '\.\/([\w-]+)'/g, "from './$1.mjs'");
      writeFileSync(path.join(dir, `${name}.mjs`), js);
    }
    const mods = await Promise.all(entries.map((n) => import(pathToFileURL(path.join(dir, `${n}.mjs`)).href)));
    return Object.fromEntries(entries.map((n, i) => [n, mods[i]]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The game's current generator: { fish, odds, uri }. */
export async function loadGameGenerator() {
  const m = await loadGameModules(['fish', 'depth-odds', 'nft-uri']);
  return { fish: m.fish, odds: m['depth-odds'], uri: m['nft-uri'] };
}

const DEPTHS = [0, 0.3, 7.25, 14.999, 15, 17.9, 18, 25.5, 37.99, 38, 49.5, 50, 59.99, 60, 64.2, 80, 110.7, 120, 199.9, 234.9, 235, 300, 350, 512.25, 999.6, 1000, 1500];

test('fish-gen.mjs grows exactly the game\'s fish (rollFish, odds, recorded depth, NFT look)', { skip: !existsSync(TS) && 'game/node_modules not installed' }, async () => {
  const game = await loadGameGenerator();
  assert.deepEqual(RARITY_BY_DEPTH, game.odds.RARITY_BY_DEPTH);
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    // Spread seeds over the whole 32-bit range, plus the edge cases.
    const seed = i < 3 ? [0, 1, 0xffffffff][i] : Math.imul(i, 2654435761) >>> 0;
    for (const depth of i % 10 === 0 ? DEPTHS : [DEPTHS[i % DEPTHS.length], (i * 0.37) % 400]) {
      const want = game.fish.rollFish(seed, depth);
      const got = rollFish(seed, depth);
      assert.deepEqual(got, want, `seed ${seed} at ${depth} m`);
      assert.equal(fishLook(got), game.uri.fishLook(want));
      n++;
    }
  }
  for (const d of DEPTHS) {
    assert.deepEqual(rarityOdds(d), game.odds.rarityOdds(d), `odds at ${d} m`);
    assert.equal(recordedDepth(d), game.fish.recordedDepth(d));
  }
  // Forced odds (how the market re-derives a fish of a given rarity).
  for (const r of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
    assert.deepEqual(rollFish(12345, 40, [[r, 1]]), game.fish.rollFish(12345, 40, [[r, 1]]));
  }
  assert.ok(n > 9000);
  // The current generator is the first one the market tries.
  assert.equal(GENERATORS[0].rollFish, rollFish);
});

// The first rarity-by-depth table (depth-odds.ts before PR #102, a84c64d). Fish rolled with it are
// on-chain; this pins the port's copy so it is never "updated" by mistake.
const V1_TABLE = [
  [0, [90, 9.5, 0.5, 0, 0, 0]],
  [15, [80, 17, 3, 0, 0, 0]],
  [30, [68, 24, 7, 1, 0, 0]],
  [50, [58, 28, 10.5, 3, 0.5, 0]],
  [80, [48, 31, 14, 5.5, 1.3, 0.2]],
  [120, [39, 32, 18, 8, 2.4, 0.6]],
  [200, [30, 30, 22, 12, 4.5, 1.5]],
  [350, [22, 26, 25, 16.5, 7.5, 3]],
];

const TITLE_LEGACY = new URL('src/title-fish-legacy.ts', GAME);

test('fish-gen.mjs v1 grows exactly the fish the game minted before the 35-species roster', { skip: (!existsSync(TS) || !existsSync(TITLE_LEGACY)) && 'game/node_modules or title-fish-legacy.ts missing' }, async () => {
  assert.deepEqual(GENERATOR_V1.RARITY_BY_DEPTH, V1_TABLE);
  // title-fish-legacy.ts keeps the pre-#102 fish.ts (17-species roster) for the title screen. Its
  // default odds are today's table, so the v1 odds are passed in: roster, look, size and value must
  // match field for field.
  const { 'title-fish-legacy': legacy, 'nft-uri': uri } = await loadGameModules(['title-fish-legacy', 'nft-uri']);
  let n = 0;
  for (let i = 0; i < 3000; i++) {
    const seed = i < 3 ? [0, 1, 0xffffffff][i] : Math.imul(i, 2654435761) >>> 0;
    for (const depth of i % 10 === 0 ? DEPTHS : [DEPTHS[i % DEPTHS.length], (i * 0.37) % 400]) {
      const odds = GENERATOR_V1.rarityOdds(depth);
      const want = legacy.rollFish(seed, depth, odds);
      assert.deepEqual(GENERATOR_V1.rollFish(seed, depth), want, `v1 seed ${seed} at ${depth} m`);
      assert.equal(fishLook(want), uri.fishLook(want));
      n++;
    }
  }
  for (const r of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
    for (const seed of [7, 12345, 0xdeadbeef]) assert.deepEqual(GENERATOR_V1.fishOf(seed, r), legacy.rollFish(seed, 0, [[r, 1]]));
  }
  for (const z of GENERATOR_V1.legacyZones) assert.deepEqual(GENERATOR_V1.rollFish(99, 20, z.odds), legacy.rollFish(99, 20, z.odds));
  assert.ok(n > 6000);
});

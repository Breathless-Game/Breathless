import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { RARITY_BY_DEPTH, fishLook, rarityOdds, recordedDepth, rollFish } from '../fish-gen.mjs';

// The market re-derives every fish it co-signs or buys with fish-gen.mjs, a port of the game's
// generator. This runs the game's own TypeScript (rng.ts, depth-odds.ts, fish.ts, nft-uri.ts) next
// to the port and requires identical fish for many seeds and depths. The TypeScript compiler comes
// from game/node_modules (npm --prefix game install); fish.ts's three.js import is stubbed (the
// generator never touches it). game/tests/fish-gen-parity.test.mjs runs the same check in CI.

const GAME = new URL('../../game/', import.meta.url);
const TS = new URL('node_modules/typescript/lib/typescript.js', GAME);

/** Transpile the game modules into a temp dir as .mjs with relative imports fixed up. */
export async function loadGameGenerator() {
  const ts = (await import(TS.href)).default;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-gen-parity-'));
  writeFileSync(path.join(dir, 'three.mjs'), 'export {};\n');
  for (const name of ['rng', 'depth-odds', 'fish', 'nft-uri']) {
    const src = readFileSync(new URL(`src/${name}.ts`, GAME), 'utf8');
    const js = ts
      .transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
      .outputText.replace(/from 'three'/g, "from './three.mjs'")
      .replace(/from '\.\/([\w-]+)'/g, "from './$1.mjs'");
    writeFileSync(path.join(dir, `${name}.mjs`), js);
  }
  const load = (n) => import(pathToFileURL(path.join(dir, `${n}.mjs`)).href);
  const [fish, odds, uri] = await Promise.all([load('fish'), load('depth-odds'), load('nft-uri')]);
  rmSync(dir, { recursive: true, force: true });
  return { fish, odds, uri };
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
});

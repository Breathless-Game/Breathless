import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// The game's side of the market's fish collection (src/fish-cosign.ts, src/market.ts), and the
// server's port of the fish generator (sensor/fish-gen.mjs) checked against the game's own: the
// market co-signs and buys a fish only if the port re-derives it, so the two must never drift.

const transpile = (source) =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;

async function load(file) {
  const code = transpile(await readFile(new URL(file, import.meta.url), 'utf8'));
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const cosign = await load('../src/fish-cosign.ts');
const market = await load('../src/market.ts');

const SESSION = 'Sess1on1111111111111111111111111111111111';
const MARKET = 'Market11111111111111111111111111111111111';
const ASSET = 'Asset11111111111111111111111111111111111111';
const OWNER = 'Owner111111111111111111111111111111111111';
const COLLECTION = 'Co11ection111111111111111111111111111111111';

test('mint route: co-signed with a collection, wait while it is being created, the old way on older markets', () => {
  assert.equal(cosign.mintRoute({ mode: 'server', market: MARKET, cosign: true, fishCollection: COLLECTION }), 'cosign');
  assert.equal(cosign.mintRoute({ mode: 'server', market: MARKET, cosign: true, fishCollection: null }), 'wait');
  assert.equal(cosign.mintRoute({ mode: 'server', market: MARKET }), 'legacy');
  assert.equal(cosign.mintRoute({ mode: 'program', market: null }), 'legacy');
});

test('a co-signed transaction is signed only if it is what we asked for', () => {
  const ok = { accounts: [SESSION, ASSET, MARKET, OWNER, cosign.CORE_PROGRAM], header: { numRequiredSignatures: 3 }, instructions: [{ programIndex: 4 }] };
  const expect = { payer: SESSION, signers: [SESSION, ASSET, MARKET] };
  assert.equal(cosign.cosignedTxProblem(ok, expect), null);
  assert.match(cosign.cosignedTxProblem({ ...ok, accounts: [MARKET, ASSET, SESSION, OWNER, cosign.CORE_PROGRAM] }, expect), /fee payer/);
  assert.match(cosign.cosignedTxProblem({ ...ok, header: { numRequiredSignatures: 4 } }, expect), /unexpected signatures/);
  assert.match(cosign.cosignedTxProblem({ ...ok, instructions: [{ programIndex: 4 }, { programIndex: 3 }] }, expect), /other than Metaplex Core/);
  assert.match(cosign.cosignedTxProblem({ ...ok, instructions: [] }, expect), /other than Metaplex Core/);
});

test('minted fish: in the collection, migratable by this device, or blocked with a reason', () => {
  const ctx = { owner: OWNER, session: SESSION, collection: COLLECTION };
  const fish = (updateAuthority, owner = OWNER) => ({ owner, updateAuthority });
  assert.deepEqual(cosign.classifyFish(fish({ type: 'Collection', address: COLLECTION }), ctx), { state: 'trusted' });
  assert.deepEqual(cosign.classifyFish(fish({ type: 'Address', address: SESSION }), ctx), { state: 'migrate' });
  assert.equal(cosign.classifyFish(fish({ type: 'Address', address: 'An0ther1111111111111111111111111111111111' }), ctx).reason, cosign.OTHER_DEVICE);
  assert.match(cosign.classifyFish(fish({ type: 'Collection', address: 'Gear111111111111111111111111111111111111111' }), ctx).reason, /Not a Breathless fish/);
  assert.match(cosign.classifyFish(fish({ type: 'Address', address: SESSION }, 'Someone'), ctx).reason, /no longer in your wallet/);
});

test('the mint request carries only what goes on-chain', () => {
  const body = cosign.mintRequest(
    { id: '00c0ffee', rarity: 'rare', species: 'Azure Tang', depth: 41, value: 25, hue: 3 },
    { owner: OWNER, payer: SESSION, asset: ASSET, name: 'Royal Azure Tang #0042', uri: 'https://x/api/nft/meta/v2/42/x.json' },
  );
  assert.deepEqual(body.fish, { id: '00c0ffee', rarity: 'rare', species: 'Azure Tang', depth: 41, value: 25 });
  assert.equal(body.payer, SESSION);
});

test('a fish the market can never buy is not sellable, not bulk-sold, and keeps a paused mint queued', () => {
  const f = { ...market.bankEntry({ id: 'a', rarity: 'common', value: 1 }), nft: 'minted', assetId: ASSET, sellBlock: cosign.OTHER_DEVICE };
  assert.deepEqual(market.sellQuote(f, () => 1), { ok: false, reason: 'blocked' });
  assert.equal(market.nftStep(f, { type: 'sell' }), f);
  assert.deepEqual(market.bulkSellable([f], 'common'), []);
  const minting = { ...market.bankEntry({ id: 'b', rarity: 'common' }), nft: 'minting' };
  assert.equal(market.nftStep(minting, { type: 'paused' }).nft, 'pending');
  assert.equal(market.nftStep(minting, { type: 'paused' }).mintTries, undefined, 'a limit costs no attempt');
});

/**
 * Transpile `entries` (src module names) and every module they import, found by following the
 * relative imports left in the transpiled output (type-only ones are erased), into `dir` as .mjs,
 * with three.js stubbed (the generator never touches it).
 */
function transpileTree(entries, dir) {
  writeFileSync(path.join(dir, 'three.mjs'), 'export {};\n');
  const todo = [...entries];
  const done = new Set();
  while (todo.length) {
    const name = todo.pop();
    if (done.has(name)) continue;
    done.add(name);
    let js = transpile(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'));
    for (const [, dep] of js.matchAll(/from '\.\/([\w-]+)'/g)) todo.push(dep);
    js = js.replace(/from 'three'/g, "from './three.mjs'").replace(/from '\.\/([\w-]+)'/g, "from './$1.mjs'");
    writeFileSync(path.join(dir, `${name}.mjs`), js);
  }
}

test('sensor/fish-gen.mjs (the market\'s generator) grows exactly the game\'s fish', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-parity-'));
  try {
    transpileTree(['fish', 'depth-odds', 'nft-uri'], dir);
    const game = await import(pathToFileURL(path.join(dir, 'fish.mjs')).href);
    const odds = await import(pathToFileURL(path.join(dir, 'depth-odds.mjs')).href);
    const uri = await import(pathToFileURL(path.join(dir, 'nft-uri.mjs')).href);
    const port = await import(new URL('../../sensor/fish-gen.mjs', import.meta.url).href);
    assert.deepEqual(port.RARITY_BY_DEPTH, odds.RARITY_BY_DEPTH);
    for (let i = 0; i < 3000; i++) {
      const seed = Math.imul(i + 1, 2654435761) >>> 0;
      for (const depth of [(i * 0.731) % 70, 60 + ((i * 3.17) % 400), [0, 18, 50, 235, 1000][i % 5]]) {
        const want = game.rollFish(seed, depth);
        assert.deepEqual(port.rollFish(seed, depth), want, `seed ${seed} at ${depth} m`);
        assert.equal(port.fishLook(want), uri.fishLook(want));
      }
    }
    for (const r of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
      for (let seed = 1; seed < 400; seed++) assert.deepEqual(port.fishOf(seed, r), game.rollFish(seed, 0, [[r, 1]]), `${r} seed ${seed}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

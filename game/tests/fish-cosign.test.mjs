import assert from 'node:assert/strict';
import { createPublicKey, verify as ed25519Verify } from 'node:crypto';
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
  assert.match(cosign.cosignedTxProblem(ok, expect), /neither our mint nor our migration/, 'nothing to check its Core call against');
  assert.match(cosign.cosignedTxProblem({ ...ok, accounts: [MARKET, ASSET, SESSION, OWNER, cosign.CORE_PROGRAM] }, expect), /fee payer/);
  assert.match(cosign.cosignedTxProblem({ ...ok, header: { numRequiredSignatures: 4 } }, expect), /unexpected signatures/);
  assert.match(cosign.cosignedTxProblem({ ...ok, instructions: [{ programIndex: 4 }, { programIndex: 3 }] }, expect), /other than Metaplex Core/);
  assert.match(cosign.cosignedTxProblem({ ...ok, instructions: [] }, expect), /no Core call/);
});

// A co-signed mint as sensor/fish-collection.mjs buildMintTx builds it: Core create, then record_catch.
const PS = 'EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ';
const CONFIG = 'Config1111111111111111111111111111111111111';
const PROGRESS = 'Progress11111111111111111111111111111111111';
const OTHER = 'An0ther1111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
function catchData(fish = 0xc0ffeen, value = 25n, disc = cosign.RECORD_CATCH_DISCRIMINATOR) {
  const d = new Uint8Array(24);
  d.set(disc);
  const v = new DataView(d.buffer);
  v.setBigUint64(8, fish, true);
  v.setBigUint64(16, value, true);
  return d;
}
//              0        1      2       3      4         5       6       7                    8   9      10
const KEYS = [SESSION, ASSET, MARKET, OWNER, PROGRESS, CONFIG, SYSTEM, cosign.CORE_PROGRAM, PS, OTHER, COLLECTION];
// mpl-core 1.10.0 createV2: asset, collection, authority, payer, owner, updateAuthority (unset), system, logWrapper (unset).
const CREATE_ACCOUNTS = [1, 10, 2, 0, 3, 7, 6, 7];
const CORE_IX = { programIndex: 7, accountIndexes: CREATE_ACCOUNTS, data: new Uint8Array([cosign.CORE_CREATE_V2_DISCRIMINATOR, 0]) };
const CATCH_IX = { programIndex: 8, accountIndexes: [2, 0, 5, 3, 4, 6], data: catchData() };
const mintMsg = (instructions, accounts = KEYS) => ({ accounts, header: { numRequiredSignatures: 3 }, instructions });
const MINT_EXPECT = {
  payer: SESSION,
  signers: [SESSION, ASSET, MARKET],
  create: { asset: ASSET, collection: COLLECTION, authority: MARKET, payer: SESSION, owner: OWNER },
  recordCatch: { program: PS, oracle: MARKET, payer: SESSION, config: CONFIG, owner: OWNER, progress: PROGRESS, fish: 0xc0ffeen, value: 25 },
};

test('a co-signed mint may carry exactly one record_catch, and only the one we expect', () => {
  const p = (instructions, expect = MINT_EXPECT, accounts) => cosign.cosignedTxProblem(mintMsg(instructions, accounts), expect);
  assert.equal(p([CORE_IX, CATCH_IX]), null, 'Core create + our record_catch');
  assert.match(p([CORE_IX]), /does not record the catch/, 'a mint without record_catch is refused');
  assert.ok(cosign.staleProtocol(p([CORE_IX])), 'a market older than the game: refresh, not "unexpected"');
  const idl = JSON.parse(readFileSync(new URL('../src/idl/player_state.json', import.meta.url), 'utf8'));
  assert.deepEqual([...cosign.RECORD_CATCH_DISCRIMINATOR], idl.instructions.find((i) => i.name === 'record_catch').discriminator);

  assert.match(p([CORE_IX, CATCH_IX, CATCH_IX]), /more than once/);
  assert.match(p([CATCH_IX]), /no Core call/, 'no Core create at all');
  assert.match(p([CORE_IX, { ...CATCH_IX, data: catchData(0xc0ffeen, 25n, [93, 58, 72, 158, 252, 114, 249, 96]) }]), /other than record_catch/, 'shark_bite');
  assert.match(p([CORE_IX, { ...CATCH_IX, data: catchData().slice(0, 16) }]), /other than record_catch/, 'short data');
  assert.match(p([CORE_IX, { ...CATCH_IX, data: undefined }]), /other than record_catch/);
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [2, 0, 5, 9, 4, 6] }]), /another player/, 'another owner');
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [2, 0, 5, 3, 9, 6] }]), /another player/, 'another Progress');
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [9, 0, 5, 3, 4, 6] }]), /oracle is not the market/);
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [1, 0, 5, 3, 4, 6] }]), /oracle is not the market/, 'the asset as oracle');
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [2, 1, 5, 3, 4, 6] }]), /payer is not the game wallet/);
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [2, 0, 9, 3, 4, 6] }]), /unexpected accounts/, 'another Config');
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [2, 0, 5, 3, 4, 9] }]), /unexpected accounts/, 'not the system program');
  assert.match(p([CORE_IX, { ...CATCH_IX, accountIndexes: [2, 0, 5, 3, 4, 6, 9] }]), /unexpected accounts/, 'an extra account');
  assert.match(p([CORE_IX, { ...CATCH_IX, data: catchData(0xbadn) }]), /another fish/);
  assert.match(p([CORE_IX, { ...CATCH_IX, data: catchData(0xc0ffeen, 30000n) }]), /another fish or value/);
  assert.match(p([CORE_IX, { ...CATCH_IX, programIndex: 9 }]), /other than Metaplex Core/, 'a look-alike from another program');
  // Without a record_catch expectation (the migrate flow, or a game older than the market) nothing
  // but Core passes, and that is the stale-protocol case too.
  const migrate = p([CORE_IX, CATCH_IX], { payer: SESSION, signers: [SESSION, ASSET, MARKET] });
  assert.match(migrate, /other than Metaplex Core/);
  assert.ok(cosign.staleProtocol(migrate));
  assert.ok(!cosign.staleProtocol(p([CORE_IX, CATCH_IX, CATCH_IX])), 'a real anomaly is not a version mismatch');
  // The market as payer, or an extra signer, is still refused first.
  assert.match(p([CORE_IX, CATCH_IX], MINT_EXPECT, [MARKET, ASSET, SESSION, ...KEYS.slice(3)]), /fee payer/);
});

test('a co-signed mint carries exactly one Core call: the create of our asset, for this owner, in the Breathless collection', () => {
  const p = (core, expect = MINT_EXPECT) => cosign.cosignedTxProblem(mintMsg([...core, CATCH_IX]), expect);
  const create = (accountIndexes = CREATE_ACCOUNTS, data = CORE_IX.data) => ({ programIndex: 7, accountIndexes, data });
  const swap = (at, key) => CREATE_ACCOUNTS.map((k, i) => (i === at ? key : k));
  assert.equal(p([create()]), null);
  assert.match(p([create(), create()]), /more than one Core call/, 'a second Core instruction');
  assert.match(p([create(), { programIndex: 7, accountIndexes: [1, 3], data: new Uint8Array([3]) }]), /more than one Core call/, 'a Core transfer after the create');
  assert.match(p([create(swap(4, 9))]), /another owner/, 'the fish created for someone else');
  assert.match(p([create(swap(4, 2))]), /another owner/, 'the market as owner');
  assert.match(p([create(swap(1, 9))]), /outside the Breathless collection/, 'another collection');
  assert.match(p([create(swap(1, 7))]), /outside the Breathless collection/, 'no collection');
  assert.match(p([create(swap(0, 9))]), /another asset/);
  assert.match(p([create(swap(2, 9))]), /authority is not the market/);
  assert.match(p([create(swap(3, 2))]), /payer is not the game wallet/, 'the market pays');
  assert.match(p([create(swap(5, 9))]), /unexpected accounts/, 'an update authority inside a collection');
  assert.match(p([create(swap(6, 9))]), /unexpected accounts/, 'not the system program');
  assert.match(p([create([...CREATE_ACCOUNTS, 9])]), /unexpected accounts/, 'an extra account');
  assert.match(p([create(CREATE_ACCOUNTS.slice(0, 7))]), /unexpected accounts/, 'a missing account');
  assert.match(p([create(undefined, new Uint8Array([0]))]), /not a create/, 'createV1');
  assert.match(p([create(undefined, new Uint8Array([3]))]), /not a create/, 'transferV1');
  assert.match(p([create(undefined, new Uint8Array([]))]), /not a create/);
});

// A migration as sensor/fish-collection.mjs cosignMigrate builds it: per fish, two Core updateV2s,
// the session key handing its update authority to the market, then the market moving it into the collection.
const FISH2 = 'Fish2111111111111111111111111111111111111111';
const GEAR = 'Gear111111111111111111111111111111111111111';
const MARKET_BYTES = new Uint8Array(32).fill(0x4d);
const COLLECTION_BYTES = new Uint8Array(32).fill(0xc0);
//                0        1       2      3      4                    5           6      7
const MKEYS = [SESSION, MARKET, ASSET, FISH2, cosign.CORE_PROGRAM, COLLECTION, SYSTEM, GEAR];
// mpl-core 1.10.0 updateV2: asset, collection (unset: not in one yet), payer, authority, newCollection, system, logWrapper (unset).
const HAND_ACCOUNTS = (a) => [a, 4, 0, 0, 4, 6, 4];
const MOVE_ACCOUNTS = (a) => [a, 4, 0, 1, 5, 6, 4];
const updateData = (kind, to, { name = false } = {}) =>
  new Uint8Array([cosign.CORE_UPDATE_V2_DISCRIMINATOR, ...(name ? [1, 1, 0, 0, 0, 0x78] : [0]), 0, 1, kind, ...to]);
const hand = (a, accountIndexes = HAND_ACCOUNTS(a), data = updateData(1, MARKET_BYTES)) => ({ programIndex: 4, accountIndexes, data });
const move = (a, accountIndexes = MOVE_ACCOUNTS(a), data = updateData(2, COLLECTION_BYTES)) => ({ programIndex: 4, accountIndexes, data });
const migrateMsg = (instructions) => ({ accounts: MKEYS, header: { numRequiredSignatures: 2 }, instructions });
const migrateExpect = (assetIds = [ASSET, FISH2], requested = [ASSET, FISH2]) =>
  cosign.migrateExpectation((k) => ({ [MARKET]: MARKET_BYTES, [COLLECTION]: COLLECTION_BYTES })[k], { session: SESSION, market: MARKET, collection: COLLECTION, requested, assetIds });

test('a migration moves exactly the fish we asked for: hand-over to the market, then into the Breathless collection', () => {
  const p = (instructions, expect = migrateExpect()) => cosign.cosignedTxProblem(migrateMsg(instructions), expect);
  const both = [hand(2), move(2), hand(3), move(3)];
  assert.equal(p(both), null);
  assert.equal(p([hand(2), move(2)], migrateExpect([ASSET])), null, 'one fish of the request per transaction');
  // Anything besides the requested fish's two updates.
  assert.match(p([...both, { programIndex: 4, accountIndexes: [7, 4, 0, 0, 4, 6, 4], data: new Uint8Array([15, 0, 0]) }]), /more Core calls/, 'an updateV1 on a gear NFT');
  assert.match(p([...both, hand(7), move(7)]), /more Core calls/, 'a gear NFT tacked on');
  assert.match(p([hand(7), move(7), hand(3), move(3)]), /another asset/, 'a gear NFT in place of a fish');
  assert.match(p([hand(2), move(2)]), /exactly the fish we asked/, 'a fish left out');
  assert.match(p([move(2), hand(2), hand(3), move(3)]), /hands the fish to someone other than the market/, 'out of order');
  assert.match(p([...both, { ...CORE_IX, programIndex: 4 }]), /more Core calls/, 'a Core create paid by the session key');
  assert.match(p([{ programIndex: 4, accountIndexes: CREATE_ACCOUNTS, data: new Uint8Array([cosign.CORE_CREATE_V2_DISCRIMINATOR, 0]) }, move(2), hand(3), move(3)]), /not a fish update/, 'a create in place of the hand-over');
  assert.match(p([hand(2, undefined, new Uint8Array([15, 0, 0, 1, 1, ...MARKET_BYTES])), move(2), hand(3), move(3)]), /not a fish update/, 'updateV1');
  assert.match(p([...both, { programIndex: 6, accountIndexes: [0, 1], data: new Uint8Array([2, 0, 0, 0]) }]), /other than Metaplex Core/, 'a SOL transfer');
  // The server's answer names the fish too: only ones we sent count.
  assert.match(p([hand(7), move(7)], migrateExpect([GEAR], [ASSET, FISH2])), /a fish we did not ask to move/, 'the server lists a gear NFT');
  assert.match(p(both, migrateExpect([ASSET, ASSET])), /a fish we did not ask to move/, 'one fish listed twice');
  assert.match(p([], migrateExpect([])), /moves no fish/);
  // Wrong new authority or collection.
  const other = new Uint8Array(32).fill(0x07);
  assert.match(p([hand(2, undefined, updateData(1, other)), move(2), hand(3), move(3)]), /someone other than the market/, 'another new authority');
  assert.match(p([hand(2, undefined, updateData(2, COLLECTION_BYTES)), move(2), hand(3), move(3)]), /someone other than the market/, 'straight into a collection');
  assert.match(p([hand(2), move(2, undefined, updateData(2, other)), hand(3), move(3)]), /outside the Breathless collection/, 'another collection');
  assert.match(p([hand(2), move(2, undefined, updateData(1, MARKET_BYTES)), hand(3), move(3)]), /outside the Breathless collection/, 'left on the market as an address');
  assert.match(p([hand(2), move(2, [2, 4, 0, 1, 7, 6, 4]), hand(3), move(3)]), /outside the Breathless collection/, 'newCollection is a gear collection');
  assert.match(p([hand(2), move(2, undefined, new Uint8Array([cosign.CORE_UPDATE_V2_DISCRIMINATOR, 0, 0, 0])), hand(3), move(3)]), /outside the Breathless collection/, 'no new authority');
  assert.match(p([hand(2, undefined, updateData(1, MARKET_BYTES, { name: true })), move(2), hand(3), move(3)]), /renames the fish or changes its URI/);
  // Wrong accounts.
  assert.match(p([hand(2, [2, 4, 0, 1, 4, 6, 4]), move(2), hand(3), move(3)]), /unexpected accounts/, 'the hand-over signed by the market');
  assert.match(p([hand(2, [2, 4, 1, 0, 4, 6, 4]), move(2), hand(3), move(3)]), /unexpected accounts/, 'the market pays');
  assert.match(p([hand(2), move(2, [2, 4, 0, 0, 5, 6, 4]), hand(3), move(3)]), /unexpected accounts/, 'the move signed by the session key');
  assert.match(p([hand(2), move(2, [2, 5, 0, 1, 5, 6, 4]), hand(3), move(3)]), /unexpected accounts/, 'a current collection');
  assert.match(p([hand(2, [...HAND_ACCOUNTS(2), 7]), move(2), hand(3), move(3)]), /unexpected accounts/, 'a remaining account');
  assert.match(p([hand(2), move(3), hand(3), move(3)]), /another asset/, 'the move of another fish');
  // A mint expectation is not loosened by any of this: the update is not a create.
  assert.match(cosign.cosignedTxProblem(mintMsg([{ ...hand(1), programIndex: 7 }, CATCH_IX]), MINT_EXPECT), /not a create/);
});

test('mpl-core update() still builds updateV2 with the layout the game checks', async () => {
  const js = await readFile(new URL('../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/instructions/updateV2.js', import.meta.url), 'utf8');
  assert.match(js, /discriminator: 30\b/);
  const order = [...js.matchAll(/(\w+): \{\s*index: (\d+),/g)].map((m) => [Number(m[2]), m[1]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  assert.deepEqual(order, ['asset', 'collection', 'payer', 'authority', 'newCollection', 'systemProgram', 'logWrapper']);
  assert.match(js, /\['newName', .*\],\s*\['newUri', .*\],\s*\['newUpdateAuthority', .*getBaseUpdateAuthoritySerializer/);
  const update = await readFile(new URL('../node_modules/@metaplex-foundation/mpl-core/dist/src/instructions/update.js', import.meta.url), 'utf8');
  assert.match(update, /generated_1\.updateV2\)\(context/);
  const ua = await readFile(new URL('../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/baseUpdateAuthority.js', import.meta.url), 'utf8');
  assert.match(ua, /\['None',[\s\S]*'Address',[\s\S]*'Collection',/);
});

test('mpl-core create() still builds createV2 with the account order the game checks', async () => {
  const js = await readFile(new URL('../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/instructions/createV2.js', import.meta.url), 'utf8');
  assert.match(js, /discriminator: 20\b/);
  const order = [...js.matchAll(/(\w+): \{\s*index: (\d+),/g)].map((m) => [Number(m[2]), m[1]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  assert.deepEqual(order, ['asset', 'collection', 'authority', 'payer', 'owner', 'updateAuthority', 'systemProgram', 'logWrapper']);
  const create = await readFile(new URL('../node_modules/@metaplex-foundation/mpl-core/dist/src/instructions/create.js', import.meta.url), 'utf8');
  assert.match(create, /generated_1\.createV2\)\(context/);
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

// ---- Signed co-sign requests: the market charges its quotas per game wallet, so the session key
// signs every request. The string and the signature must be exactly what sensor/fish-trust.mjs
// checks: both suites assert the same vector (sensor/test/fixtures/cosign-request-vector.json).
const VECTOR = JSON.parse(readFileSync(new URL('../../sensor/test/fixtures/cosign-request-vector.json', import.meta.url), 'utf8'));

async function vectorSigner() {
  const { createSignerFromKeypair } = await import('@metaplex-foundation/umi');
  const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
  const u = createUmi('http://127.0.0.1:1'); // never contacted
  return createSignerFromKeypair(u, u.eddsa.createKeypairFromSeed(Uint8Array.from(Buffer.from(VECTOR.seedHex, 'hex'))));
}

test("the signed request strings are the market's, byte for byte (shared vector)", () => {
  assert.equal(cosign.cosignMintMessage(VECTOR.mint.request), VECTOR.mint.message);
  assert.equal(cosign.cosignMigrateMessage(VECTOR.migrate.request), VECTOR.migrate.message);
  const r = VECTOR.mint.request;
  const m = (name, species) => cosign.cosignMintMessage({ ...r, name, fish: { ...r.fish, species } });
  assert.notEqual(m('a|b', 'c'), m('a', 'b|c'), 'a | in a field cannot shift the fields');
  assert.notEqual(m('a\\', '|c'), m('a\\|', 'c'));
  assert.ok(VECTOR.mint.message.startsWith(`${cosign.COSIGN_MINT_DOMAIN}|`));
  assert.ok(VECTOR.migrate.message.startsWith(`${cosign.COSIGN_MIGRATE_DOMAIN}|`));
});

test("the session key (umi signer) signs the request: the vector's signature, which the market verifies", async () => {
  const { publicKeyBytes } = await import('@metaplex-foundation/umi');
  const signer = await vectorSigner();
  assert.equal(signer.publicKey.toString(), VECTOR.payer);
  const mint = await cosign.signMintRequest(signer, VECTOR.mint.request);
  assert.equal(mint.signature, VECTOR.mint.signature);
  const { signature, ...rest } = mint;
  assert.deepEqual(rest, VECTOR.mint.request, 'every field of the request goes along unchanged');
  const migrate = await cosign.signMigrateRequest(signer, VECTOR.migrate.request);
  assert.equal(migrate.signature, VECTOR.migrate.signature);
  assert.deepEqual(migrate.assetIds, VECTOR.migrate.request.assetIds);
  // Checked with another ed25519 implementation (node:crypto, as the market does).
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyBytes(VECTOR.payer)).toString('base64url') }, format: 'jwk' });
  assert.ok(ed25519Verify(null, Buffer.from(VECTOR.mint.message), key, Buffer.from(signature, 'base64')));
  assert.ok(!ed25519Verify(null, Buffer.from(VECTOR.migrate.message), key, Buffer.from(signature, 'base64')), 'a mint signature is no migration one');
  // The body mintRequest builds, signed, is what /cosign-mint gets.
  const { fish, ...a } = VECTOR.mint.request;
  const body = await cosign.signMintRequest(signer, cosign.mintRequest({ ...fish, hue: 3 }, a));
  assert.equal(body.signature, VECTOR.mint.signature);
  assert.equal(body.fish.hue, undefined);
  await assert.rejects(cosign.signMintRequest(signer, { ...VECTOR.mint.request, payer: OWNER }), /signed by its payer/, 'never signs for another payer');
});

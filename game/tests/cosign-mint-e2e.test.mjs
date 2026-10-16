import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

// End to end across the two packages: the transaction the market really builds for a co-signed
// mint (sensor/fish-collection.mjs buildMintTx + sensor/player-state-ix.mjs) goes through the
// game's real derivation (src/fish-cosign.ts mintExpectation over src/player-state.ts, exactly as
// cosignMint does) and cosignedTxProblem must accept it. A PDA seed, program id, account order or
// argument that drifts on either side fails here instead of in a player's mint.

// sensor/*.mjs import umi and mpl-core by bare name, and CI installs only game/: resolve those
// from here (both packages pin the same umi 1.6.0 and mpl-core 1.10.0).
const SENSOR = new URL('../../sensor/', import.meta.url).href;
const HOOKS = `
const SENSOR = ${JSON.stringify(SENSOR)};
const HERE = ${JSON.stringify(import.meta.url)};
export async function resolve(specifier, context, next) {
  const bare = !/^(\\.|\\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);
  if (bare && context.parentURL && context.parentURL.startsWith(SENSOR)) return next(specifier, { ...context, parentURL: HERE });
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
async function transpile(rel, replace = {}) {
  const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [from, to] of Object.entries(replace)) outputText = outputText.replaceAll(`from '${from}'`, `from '${to}'`).replaceAll(`from "${from}"`, `from "${to}"`);
  return dataUrl(outputText);
}

const { createNoopSigner, generateSigner, publicKey, publicKeyBytes, signerIdentity, transactionBuilder } = await import('@metaplex-foundation/umi');
const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
const { mplCore, update, updateAuthority } = await import('@metaplex-foundation/mpl-core');
const { buildMintTx } = await import(new URL('fish-collection.mjs', SENSOR).href);
const ps = await import(await transpile('player-state.ts', { '@metaplex-foundation/umi': import.meta.resolve('@metaplex-foundation/umi') }));
const cosign = await import(await transpile('fish-cosign.ts'));

// Nothing here talks to an RPC: the URL is never contacted.
const offline = () => createUmi('http://127.0.0.1:1').use(mplCore());
const keyOf = (u) => generateSigner(u).publicKey.toString();

const server = offline();
const market = generateSigner(server);
server.use(signerIdentity(createNoopSigner(market.publicKey)));
const client = offline();

const owner = keyOf(client);
const session = keyOf(client);
const asset = keyOf(client);
const collectionKey = keyOf(client);
const blockhash = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 };
const fish = { id: '00c0ffee', value: 375 };

/** What the market builds for this request (cosignMint's /cosign-mint body), as bytes on the wire. */
function serverTx({ collection = collectionKey, mintOwner = owner } = {}) {
  const m = {
    owner: mintOwner,
    payer: session,
    asset,
    name: 'Giant Pacific Octopus #0042',
    uri: 'https://breathless.gotclass.xyz/api/nft/meta/v2/42/00c0ffee/legendary/abyss/x.json',
    fishId: fish.id,
    value: fish.value,
    attributeList: [
      { key: 'rarity', value: 'legendary' },
      { key: 'species', value: 'Giant Pacific Octopus' },
      { key: 'depth', value: '120' },
      { key: 'value', value: String(fish.value) },
      { key: 'seed', value: fish.id },
    ],
  };
  const tx = buildMintTx(server, { m, collection: { publicKey: publicKey(collection), oracles: [], lifecycleHooks: [] }, blockhash });
  return client.transactions.deserialize(server.transactions.serialize(tx)).message;
}

/** What the game expects, derived exactly as cosignMint derives it. */
const expectation = (over = {}) =>
  cosign.mintExpectation(ps, client, {
    market: market.publicKey.toString(),
    collection: collectionKey,
    owner: publicKey(owner),
    payer: session,
    asset,
    fish,
    ...over,
  });

test('the game signs the mint the market really builds: Core create + record_catch, same PDAs and program ids', () => {
  assert.equal(process.env.PLAYER_STATE_PROGRAM_ID ?? '', '', 'both sides on their default program id');
  assert.equal(cosign.cosignedTxProblem(serverTx(), expectation()), null);
});

test("the game refuses the market's real mint when it is not for this player, collection or fish", () => {
  const other = keyOf(client);
  assert.match(cosign.cosignedTxProblem(serverTx({ collection: other }), expectation()), /outside the Breathless collection/);
  assert.match(cosign.cosignedTxProblem(serverTx({ mintOwner: other }), expectation()), /another owner/);
  assert.match(cosign.cosignedTxProblem(serverTx(), expectation({ fish: { id: fish.id, value: fish.value + 1 } })), /another fish or value/);
  assert.match(cosign.cosignedTxProblem(serverTx(), expectation({ fish: { id: '00c0ffef', value: fish.value } })), /another fish/);
});

// The migration (POST /cosign-migrate). Its builder lives inside cosignMigrate, behind RPC reads, so
// this replays its two update() calls per fish with exactly its arguments (sensor/fish-collection.mjs
// cosignMigrate, "Pack the fish..."): a gear NFT, a create, or another collection must not get through.
const fishA = keyOf(client);
const fishB = keyOf(client);
const gear = keyOf(client);

function serverMigrateTx(ids, { extra = [], newAuthority = server.identity.publicKey, collection = collectionKey } = {}) {
  const sessionPayer = createNoopSigner(publicKey(session));
  let b = transactionBuilder().setFeePayer(sessionPayer).setBlockhash(blockhash).useLegacyVersion();
  for (const id of ids) {
    const asset = { publicKey: publicKey(id), owner: publicKey(owner) };
    b = b
      .add(update(server, { asset, newUpdateAuthority: updateAuthority('Address', [newAuthority]), authority: sessionPayer, payer: sessionPayer }))
      .add(
        update(server, {
          asset,
          newCollection: publicKey(collection),
          newUpdateAuthority: updateAuthority('Collection', [publicKey(collection)]),
          authority: server.identity,
          payer: sessionPayer,
        }),
      );
  }
  for (const ix of extra) b = b.add(ix);
  return client.transactions.deserialize(server.transactions.serialize(b.build(server))).message;
}

/** What the game expects for one of the market's transactions, derived as makeSellable derives it. */
const migrateExpect = (assetIds, requested = [fishA, fishB]) =>
  cosign.migrateExpectation(publicKeyBytes, { session, market: market.publicKey.toString(), collection: collectionKey, requested, assetIds });

test('the game signs the migration the market really builds: per fish, hand-over to the market then into the collection', () => {
  assert.equal(cosign.cosignedTxProblem(serverMigrateTx([fishA, fishB]), migrateExpect([fishA, fishB])), null);
  assert.equal(cosign.cosignedTxProblem(serverMigrateTx([fishB]), migrateExpect([fishB])), null);
});

test('the game refuses a migration that touches anything but the fish it asked to move', () => {
  const sessionPayer = createNoopSigner(publicKey(session));
  const gearAsset = { publicKey: publicKey(gear), owner: publicKey(owner) };
  // The Boat / Dive Kit NFT: the session key is its update authority too.
  const gearUpdate = update(server, { asset: gearAsset, name: 'x', uri: 'https://evil', authority: sessionPayer, payer: sessionPayer });
  assert.match(cosign.cosignedTxProblem(serverMigrateTx([fishA, fishB], { extra: [gearUpdate] }), migrateExpect([fishA, fishB])), /more Core calls/);
  assert.match(cosign.cosignedTxProblem(serverMigrateTx([fishA, gear]), migrateExpect([fishA, gear])), /a fish we did not ask to move/, 'the market lists the gear NFT');
  assert.match(cosign.cosignedTxProblem(serverMigrateTx([fishA, gear]), migrateExpect([fishA, fishB])), /another asset/, 'the gear NFT in place of a fish');
  assert.match(cosign.cosignedTxProblem(serverMigrateTx([fishA], { newAuthority: publicKey(gear) }), migrateExpect([fishA])), /someone other than the market/);
  assert.match(cosign.cosignedTxProblem(serverMigrateTx([fishA], { collection: gear }), migrateExpect([fishA])), /outside the Breathless collection/);
});

// ---- The requests the real flows send (cosignMint, makeSellable), checked by the market's real
// verifier (sensor/fish-trust.mjs assertSignedByPayer): the session key signs exactly what the
// market rebuilds. And a 401 (a tab from before signatures) never costs a fish.
const trust = await import(new URL('fish-trust.mjs', SENSOR).href);
const rules = await import(await transpile('market.ts'));
const flows = await (async () => {
  const source = await readFile(new URL('../src/fish-cosign.ts', import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const s of ['@metaplex-foundation/umi', '@metaplex-foundation/umi/serializers', '@metaplex-foundation/mpl-core']) outputText = outputText.replaceAll(`import('${s}')`, `import('${import.meta.resolve(s)}')`);
  return import(dataUrl(outputText));
})();
const { createSignerFromKeypair } = await import('@metaplex-foundation/umi');
const { string } = await import('@metaplex-foundation/umi/serializers');
const { getBaseUpdateAuthoritySerializer } = await import('@metaplex-foundation/mpl-core');

/**
 * Stand in for the market: `fetch` answers each POST as `answer(route, body)` says, after checking
 * its signature with the market's own code (`strip`: as if the tab sent none, a bundle from before).
 */
async function againstMarket(fn, { strip = false } = {}) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const route = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    seen.push({ route, body });
    const { signature, ...fields } = body;
    const message = route === 'cosign-mint' ? trust.cosignMintMessage(fields) : trust.cosignMigrateMessage(fields);
    try {
      trust.assertSignedByPayer(message, fields.payer, strip ? undefined : signature);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, ...e.extra }), { status: e.status });
    }
    return new Response(JSON.stringify({ error: 'signature accepted; the test stops here', code: 'test-stop' }), { status: 503 });
  };
  try {
    return { seen, error: await fn().then(() => null, (e) => e) };
  } finally {
    globalThis.fetch = real;
  }
}

const sessionSigner = createSignerFromKeypair(client, client.eddsa.generateKeypair());
const info = { mode: 'server', market: market.publicKey.toString(), cosign: true, fishCollection: collectionKey };
const mintArgs = {
  info,
  owner,
  session: sessionSigner,
  fish: { id: '00c0ffee', rarity: 'legendary', species: 'Giant Pacific Octopus', depth: 120, value: fish.value },
  name: 'Giant | Pacific Octopus #0042',
  uri: 'https://breathless.gotclass.xyz/api/nft/meta/v2/42/00c0ffee/legendary/abyss/x.json',
};

test('cosignMint sends a request signed by the session key, and the market accepts that signature', async () => {
  const { seen, error } = await againstMarket(() => flows.cosignMint(client, mintArgs));
  assert.equal(seen.length, 1);
  const { route, body } = seen[0];
  assert.equal(route, 'cosign-mint');
  assert.equal(body.payer, sessionSigner.publicKey.toString());
  assert.match(body.signature, /^[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual(body.fish, mintArgs.fish);
  assert.equal(error.status, 503, `past the signature check: ${error.message}`);
  assert.equal(error.code, 'test-stop');
});

test('an unsigned request (a tab from before signatures) gets 401 and its fish stays queued, now and after a reload', async () => {
  const { error } = await againstMarket(() => flows.cosignMint(client, mintArgs), { strip: true });
  assert.ok(error instanceof flows.CosignError);
  assert.equal(error.status, 401);
  assert.equal(error.code, trust.BAD_SIGNATURE_CODE);
  // This game: a pause, no attempt spent, the fish back to pending.
  assert.deepEqual(rules.mintPauseOf(error), { ms: 30_000, kind: 'busy' });
  const minting = { ...rules.bankEntry({ id: 'a', rarity: 'legendary', value: fish.value }), nft: 'minting' };
  assert.equal(rules.nftStep(minting, { type: 'paused' }).nft, 'pending');
  // An old tab counted it as failed attempts, saving the market's message: this game requeues those.
  const now = Date.now();
  let f = rules.bankEntry({ id: 'b', rarity: 'legendary', value: fish.value });
  for (let i = 0; i < rules.MAX_AUTO_MINT_TRIES; i++) f = rules.nftStep(rules.nftStep(f, { type: 'start' }), { type: 'failed', error: error.message.slice(0, 200), now });
  assert.equal(f.nft, 'failed');
  const { bank } = rules.migrateBank(JSON.parse(JSON.stringify([f])));
  assert.equal(bank[0].nft, 'pending');
  assert.equal(bank[0].mintTries, undefined);
  assert.equal(rules.nextToMint(bank, now), bank[0]);
});

/** A bare Core AssetV1 account (no plugins) owned by `owner`, its update authority the session key. */
function legacyAccount(address) {
  const data = new Uint8Array([
    1, // Key::AssetV1
    ...publicKeyBytes(owner),
    ...getBaseUpdateAuthoritySerializer().serialize({ __kind: 'Address', fields: [sessionSigner.publicKey] }),
    ...string().serialize('Fish'),
    ...string().serialize('https://x/y.json'),
    0, // seq: None
  ]);
  return { exists: true, publicKey: publicKey(address), owner: publicKey(cosign.CORE_PROGRAM), lamports: { basisPoints: 1n }, executable: false, data };
}

test('makeSellable sends a signed migration; a 401 leaves the fish to retry (error), never blocked', async () => {
  const u = offline();
  u.rpc = { ...client.rpc, getAccount: async (address) => legacyAccount(address) };
  const ids = [fishA, fishB];
  const args = { info, owner, session: sessionSigner, assetIds: ids };
  let out = null;
  const signed = await againstMarket(async () => (out = await flows.makeSellable(u, args)));
  assert.equal(signed.error, null);
  assert.equal(signed.seen.length, 1);
  assert.equal(signed.seen[0].route, 'cosign-migrate');
  assert.deepEqual(signed.seen[0].body.assetIds, ids);
  assert.equal(signed.seen[0].body.payer, sessionSigner.publicKey.toString());
  assert.match(signed.seen[0].body.signature, /^[A-Za-z0-9+/]{86}==$/);
  for (const id of ids) assert.match(out.get(id).reason, /signature accepted/, 'the market took the signature (then the test stopped it)');

  const unsigned = await againstMarket(async () => (out = await flows.makeSellable(u, args)), { strip: true });
  assert.equal(unsigned.error, null);
  for (const id of ids) {
    assert.equal(out.get(id).state, 'error', 'temporary: tried again on the next sync, not blocked');
    assert.match(out.get(id).reason, /not signed by its game wallet/);
  }
});

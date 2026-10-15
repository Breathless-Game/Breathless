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

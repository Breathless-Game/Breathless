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

const { createNoopSigner, generateSigner, publicKey, signerIdentity } = await import('@metaplex-foundation/umi');
const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
const { mplCore } = await import('@metaplex-foundation/mpl-core');
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

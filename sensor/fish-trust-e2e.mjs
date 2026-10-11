// End-to-end check of the market's fish collection (fish-collection.mjs) on a LOCAL validator:
// starts a server-mode market in this process (its own throwaway dir and wallet), and drives the
// game's real game/src/fish-cosign.ts and game/src/pearl.ts against it from Node.
//
//   1. a forged mythic fish (minted by the session key, attributes made up) is refused at quote and
//      at sale, and the co-sign route refuses to mint one;
//   2. a co-signed mint lands in the Breathless Fish collection and sells for its catch value; a
//      retry of the same fish adopts the minted asset instead of minting it twice;
//   3. a fish minted before the collection existed migrates into it and then sells; a forged old fish
//      and one created after the collection are refused;
//   4. the per-wallet mint limit and daily PEARL cap answer 429 with their codes.
//
//   solana-test-validator --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
//     --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s --url https://api.devnet.solana.com
//   SOLANA_RPC=http://127.0.0.1:8899 node fish-trust-e2e.mjs        (in sensor/)
//
// Env: SOLANA_RPC (required: a local validator; devnet works too but airdrops are rate limited),
// E2E_DIR (OS temp dir; the market's throwaway keypair and state live there, never in the repo).
// Player keys exist only in memory.

import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSignerFromKeypair, generateSigner, keypairIdentity, publicKey, sol } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { create, fetchAsset, mplCore } from '@metaplex-foundation/mpl-core';
import { GENERATORS, Rng, recordedDepth, rollFish } from './fish-gen.mjs';
import { createMarket } from './market.mjs';

const RPC = process.env.SOLANA_RPC;
if (!RPC) {
  console.log('Set SOLANA_RPC to a local validator (see the header of this file)');
  process.exit(2);
}
const ROOT = process.env.E2E_DIR ?? os.tmpdir();
mkdirSync(ROOT, { recursive: true });
const DIR = mkdtempSync(path.join(ROOT, 'fish-trust-e2e-'));

let passed = 0;
let failed = 0;
const check = (ok, msg) => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${msg}`);
};
const step = (s) => console.log(`\n== ${s}`);

// ---- Players: a session key (pays, mints) and the player's wallet (owns the fish, signs sales).
const u = createUmi(RPC, 'confirmed').use(mplCore());
u.use(keypairIdentity(u.eddsa.generateKeypair()));
const session = u.identity;
const ownerSigner = createSignerFromKeypair(u, u.eddsa.generateKeypair());
const owner = ownerSigner.publicKey.toString();
for (const k of [session.publicKey, ownerSigner.publicKey]) await u.rpc.airdrop(k, sol(2), { commitment: 'confirmed' });
console.log(`session ${session.publicKey}\nowner   ${owner}\nmarket dir ${DIR}`);

// ---- Fish: real catches from the game's generator, and seeds that could never be mythic.
/**
 * A seed whose first draw is so low that no generator version ever rolls it mythic: not at 1000 m
 * (rarity never drops with depth, so nowhere above either) and not with the first day's zone odds.
 */
function neverMythicSeed(from) {
  const never = (s) => GENERATORS.every((g) => g.rarityAt(s, 1000) !== 'mythic' && g.legacyZones.every((z) => new Rng(s).weighted(z.odds) !== 'mythic'));
  for (let s = from; ; s++) if (new Rng(s).next() < 0.5 && never(s)) return s >>> 0;
}
/** A real catch: rolled at its spawn depth, recorded where it was hooked. */
function catchAt(seed, spawnM, hookedM = spawnM + 3) {
  return { ...rollFish(seed, spawnM), depthM: recordedDepth(hookedM) };
}

// ---- The game's modules, transpiled, with wallet.ts / chain.ts swapped for these keys.
let BASE = '';
const ts = (await import(new URL('../game/node_modules/typescript/lib/typescript.js', import.meta.url).href)).default;
const transpile = (f) =>
  ts.transpileModule(readFileSync(new URL(`../game/src/${f}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
globalThis.__e2e = { u, owner, ownerSigner };
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] };
const walletStub = dataUrl(`
  export const storageKey = (n) => 'e2e.' + n;
  export const ownerAddress = () => globalThis.__e2e.owner;
  export const ownerSigner = () => globalThis.__e2e.ownerSigner;
  export const walletState = () => ({ owner: globalThis.__e2e.owner, session: null, connected: true, wallet: null });`);
const local = { './chain': dataUrl('export const getUmi = () => globalThis.__e2e.u;'), './wallet': walletStub };
const fixImports = (code) =>
  code
    .replace(/from (['"])\.\/wallet\1/g, `from '${walletStub}'`)
    .replace(/from (['"])\.\/market\1/g, `from '${dataUrl(transpile('market.ts'))}'`)
    .replace(/from (['"])\.\/payment-safety\1/g, () => `from '${dataUrl(transpile('payment-safety.ts'))}'`)
    // PEARL balances come from the market's GET /balance (in this process), like the game in a browser.
    .replace(/from (['"])\.\/balance-api\1/g, () => `from '${dataUrl(transpile('balance-api.ts').replace('fetch(`/api/market/balance', `fetch(\`${BASE}/api/market/balance`))}'`)
    .replace(/import\((['"])([^'"]+)\1\)/g, (_, q, spec) => `import('${local[spec] ?? import.meta.resolve(spec)}')`);
const nftUri = await import(dataUrl(transpile('nft-uri.ts')));

/** Name and hosted metadata URI exactly as chain.ts builds them (the origin is never fetched here). */
function nftOf(spec, serial) {
  const s = { ...spec, serial };
  return { name: nftUri.nftName(s), uri: nftUri.DEFAULT_NFT_ORIGIN + nftUri.fishMetaPath(s, { depthM: s.depthM, value: s.value, zone: 'The Shallows' }) };
}
const attributes = (f) => [
  { key: 'rarity', value: f.rarity },
  { key: 'species', value: f.species },
  { key: 'depth', value: String(f.depthM) },
  { key: 'value', value: String(f.value) },
  { key: 'seed', value: f.id },
];
/** Mint a fish the way the game did before the collection: the session key is its update authority. */
async function mintBySession(f) {
  const asset = generateSigner(u);
  const { name, uri } = nftOf(f);
  await create(u, {
    asset,
    owner: ownerSigner.publicKey,
    payer: session,
    authority: session,
    updateAuthority: session.publicKey,
    name,
    uri,
    plugins: [{ type: 'Attributes', attributeList: attributes(f) }],
  }).sendAndConfirm(u);
  return asset.publicKey.toString();
}

// The forged mythic: a seed no generator can ever make mythic, written up as a 600-PEARL mythic.
const forgedSeed = neverMythicSeed(0x10000);
const forged = {
  ...catchAt(forgedSeed, 400),
  rarity: 'mythic',
  species: 'Moonfin Leviathan',
  name: 'Eternal Moonfin Leviathan',
  value: 600,
};

step('before the market exists: two fish minted the old way (a real catch and a forged one)');
const legacyFish = catchAt(0x00c0ffee, 42);
const legacyAsset = await mintBySession(legacyFish);
const legacyForged = await mintBySession({ ...forged, id: neverMythicSeed(0x20000).toString(16).padStart(8, '0') });
console.log(`  legacy ${legacyFish.rarity} ${legacyFish.name} (${legacyFish.value}) ${legacyAsset}\n  forged legacy mythic ${legacyForged}`);

step('market start (server mode, fresh wallet): PEARL mint and fish collection created once');
const cosignedFish = catchAt(0x0badf00d, 60, 64);
const cappedFish = catchAt(0x00fade42, 20);
const DAILY = legacyFish.value + cosignedFish.value; // the third sale goes over it
const market = await createMarket({
  rpc: RPC,
  dir: DIR,
  log: (m) => console.log(`  ${m}`),
  fishOptions: { legacyGraceSlots: 0, limits: { mintsPerHour: 3, dailyPearls: DAILY } },
});
const server = http.createServer(async (req, res) => {
  if (!(await market.handle(req, res))) res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
BASE = `http://127.0.0.1:${server.address().port}`;
await market.ready;
let info;
for (let i = 0; i < 60; i++) {
  info = await (await fetch(`${BASE}/api/market/info`)).json();
  if (info.pearlMint && info.fishCollection) break;
  await new Promise((r) => setTimeout(r, 2000));
}
check(!!info.pearlMint && !!info.fishCollection, `info: pearlMint ${info.pearlMint}, fishCollection ${info.fishCollection}, cosign ${info.cosign}`);
const state = JSON.parse(readFileSync(path.join(DIR, '.market-state.json'), 'utf8'));
check(state.fishCollection === info.fishCollection && Number.isInteger(state.fishCollectionSlot), 'the collection is saved with the PEARL state');

const cosign = await import(dataUrl(fixImports(transpile('fish-cosign.ts').replace("const API = '/api/market';", `const API = '${BASE}/api/market';`))));
const pearl = await import(dataUrl(fixImports(transpile('pearl.ts').replace("const API = '/api/market';", `const API = '${BASE}/api/market';`))));
const post = async (route, body) => {
  const res = await fetch(`${BASE}/api/market/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const pearlNow = () => pearl.pearlBalance();
// pearlBalance() reads GET /balance (cached a few seconds); each sale must invalidate it.
const bal = await (await fetch(`${BASE}/api/market/balance?owner=${owner}&session=${session.publicKey}`)).json();
check(bal.raw === '0' && bal.decimals === 0 && typeof bal.sessionSol === 'number', `GET /balance answers: ${JSON.stringify(bal)}`);
const sell = async (ids) => pearl.sellManyToMarket(ids, () => {});

step('1. a forged mythic is refused');
const forgedAsset = await mintBySession({ ...forged, id: forgedSeed.toString(16).padStart(8, '0') });
let q = await post('quote', { seller: owner, assetId: forgedAsset });
check(q.status === 422 && q.body.code === 'not-in-collection', `quote of the forged mythic: ${q.status} ${q.body.code} "${q.body.error}"`);
q = await post('quote-batch', { seller: owner, assetIds: [forgedAsset] });
check(q.status === 200 && !q.body.quotes?.[0]?.pearls, `quote-batch prices it at nothing: ${JSON.stringify(q.body).slice(0, 160)}`);
let before = await pearlNow();
let out = await sell([forgedAsset]);
check(!out[0].result && /collection/i.test(out[0].error ?? ''), `selling it fails: "${out[0].error}"`);
check((await pearlNow()) === before, 'no PEARL paid');
const mintReq = (f, serial) => cosign.mintRequest({ id: f.id, rarity: f.rarity, species: f.species, depth: f.depthM, value: f.value }, { owner, payer: session.publicKey.toString(), asset: generateSigner(u).publicKey.toString(), ...nftOf(f, serial) });
q = await post('cosign-mint', mintReq({ ...forged, id: forgedSeed.toString(16).padStart(8, '0') }));
check(q.status === 422 && q.body.code === 'invalid-fish', `co-sign of the forged mythic refused: ${q.status} "${q.body.error}"`);
q = await post('cosign-mint', mintReq({ ...cosignedFish, value: cosignedFish.value * 10 }));
check(q.status === 422, `co-sign of a real seed with its value inflated x10 refused: ${q.status} "${q.body.error}"`);

step('2. a co-signed mint lands in the collection and sells');
const facts = { id: cosignedFish.id, rarity: cosignedFish.rarity, species: cosignedFish.species, depth: cosignedFish.depthM, value: cosignedFish.value };
const minted = await cosign.cosignMint(u, { info, owner, session, fish: facts, ...nftOf(cosignedFish, 42) });
const a = await fetchAsset(u, publicKey(minted.asset));
check(a.updateAuthority.type === 'Collection' && String(a.updateAuthority.address) === info.fishCollection, `${minted.asset} is in the collection (${a.name})`);
check(String(a.owner) === owner, 'owned by the player');
const again = await cosign.cosignMint(u, { info, owner, session, fish: facts, ...nftOf(cosignedFish, 42) });
check(again.asset === minted.asset && again.signature === '', 'minting the same fish again adopts the asset already minted');
before = await pearlNow();
out = await sell([minted.asset]);
check(out[0].result?.pearls === cosignedFish.value, `sold for ${out[0].result?.pearls ?? out[0].error} PEARL (catch value ${cosignedFish.value})`);
check((await pearlNow()) - before === cosignedFish.value, 'PEARL balance went up by the catch value');

step('3. legacy fish: migrate, then sell; forged and late ones refused');
const lateAsset = await mintBySession(catchAt(0x0000beef, 10));
const trust = await cosign.makeSellable(u, { info, owner, session, assetIds: [legacyAsset, legacyForged, lateAsset, minted.asset] });
const t = (id) => trust.get(id);
check(t(legacyAsset)?.state === 'trusted', `the real old fish migrated: ${JSON.stringify(t(legacyAsset))}`);
check(t(legacyForged)?.state === 'blocked', `the forged old fish stays unsellable: ${t(legacyForged)?.reason}`);
check(t(lateAsset)?.state === 'blocked', `a fish created by the session key after the collection is refused: ${t(lateAsset)?.reason}`);
const la = await fetchAsset(u, publicKey(legacyAsset));
check(la.updateAuthority.type === 'Collection' && String(la.updateAuthority.address) === info.fishCollection && String(la.owner) === owner, 'on-chain: in the collection, still the player\'s');
before = await pearlNow();
out = await sell([legacyAsset, legacyForged]);
const byId = Object.fromEntries(out.map((o) => [o.assetId, o]));
check(byId[legacyAsset].result?.pearls === legacyFish.value, `the migrated fish sold for ${byId[legacyAsset].result?.pearls ?? byId[legacyAsset].error} (value ${legacyFish.value})`);
check(!byId[legacyForged].result, `the forged old fish did not sell: "${byId[legacyForged].error}"`);
check((await pearlNow()) - before === legacyFish.value, 'PEARL went up by the migrated fish only');

step('4. limits: mints per hour and PEARL per day');
const capped = await cosign.cosignMint(u, {
  info,
  owner,
  session,
  fish: { id: cappedFish.id, rarity: cappedFish.rarity, species: cappedFish.species, depth: cappedFish.depthM, value: cappedFish.value },
  ...nftOf(cappedFish),
});
check(!!capped.signature, `a second fish minted (${capped.asset})`);
q = await post('cosign-mint', mintReq(catchAt(0x0a11ce00, 5)));
check(q.status === 200, `the third mint this hour is co-signed (${q.status})`);
q = await post('cosign-mint', mintReq(catchAt(0x0a11ce01, 5)));
check(q.status === 429 && q.body.code === 'mint-limit' && q.body.retryAfterMs > 0, `the fourth is refused: ${q.status} ${q.body.code} "${q.body.error}"`);
q = await post('quote-batch', { seller: owner, assetIds: [capped.asset] });
check(!q.body.quotes?.[0]?.pearls, `over the daily cap (${DAILY}), quote-batch refuses: ${JSON.stringify(q.body).slice(0, 200)}`);
before = await pearlNow();
out = await sell([capped.asset]);
check(!out[0].result && /PEARL|day|limit/i.test(out[0].error ?? ''), `selling it is refused: "${out[0].error}"`);
check((await pearlNow()) === before, 'no PEARL paid over the cap');
const still = await fetchAsset(u, publicKey(capped.asset));
check(String(still.owner) === owner || String(still.owner) === info.market, `the capped fish is ${String(still.owner) === owner ? 'still the player\'s' : 'held by the market, sale resumable'}`);

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

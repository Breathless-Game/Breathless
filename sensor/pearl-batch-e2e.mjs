// End-to-end check of selling many fish with ONE wallet approval (server mode), driving the
// game's real game/src/pearl.ts from Node against a running market:
//   a throwaway player mints FISH test fish (Core + Attributes, as chain.ts), sells them all with
//   sellManyToMarket, and the script checks the wallet was asked once (one signAllTransactions
//   call), every fish went to the market in the shared transfer, each was paid its own value in
//   PEARL and burned, and that replaying the batch pays nothing more.
//
//   npm run market                      (another terminal; or a local market, see below)
//   node pearl-batch-e2e.mjs            (in sensor/)
//
// Crash safety, in two runs (the first exits on purpose part-way):
//   node pearl-batch-e2e.mjs --crash=before-send   then   node pearl-batch-e2e.mjs --resume
//   node pearl-batch-e2e.mjs --crash=after-send    then   node pearl-batch-e2e.mjs --resume
//
//   node pearl-batch-e2e.mjs --old-market   (a market without the batch routes: one prompt, then /sell per fish)
//
// Env: MARKET_PORT (8795), SOLANA_RPC (devnet), FISH (5), E2E_DIR (OS temp dir: the throwaway
// player keypair, the fake browser storage and the crash state live there, never in the repo),
// MARKET_DIR (a local market's dir: its wallet lends the player SOL if the faucet refuses).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSigner, keypairIdentity, publicKey, sol } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { create, fetchAsset, mplCore } from '@metaplex-foundation/mpl-core';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
import { base58 } from '@metaplex-foundation/umi/serializers';

const BASE = `http://127.0.0.1:${process.env.MARKET_PORT ?? 8795}`;
const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const DIR = process.env.E2E_DIR ?? path.join(os.tmpdir(), 'pearl-batch-e2e');
const FISH = Number(process.env.FISH ?? 5);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`))?.split('=')[1] ?? (process.argv.includes(`--${name}`) ? true : null);
const CRASH = arg('crash');
const RESUME = arg('resume');
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const file = (name) => path.join(DIR, name);
const stop = (msg) => {
  console.log(`\nSTOPPED: ${msg}`);
  process.exit(2);
};
const check = (ok, msg) => {
  if (!ok) throw new Error(`CHECK FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
};

// ---- Browser storage, kept in a file so a crashed run's pending sales survive to the next run.
const STORE = file('localStorage.json');
const store = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
    writeFileSync(STORE, JSON.stringify(store));
  },
  removeItem: (k) => {
    delete store[k];
    writeFileSync(STORE, JSON.stringify(store));
  },
};

// --old-market: pretend the market predates /quote-batch and /sell-batch (the live server until it is
// redeployed). The client still hands every fish over with one prompt, then uses /quote and /sell per fish.
if (arg('old-market')) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/-batch$/.test(String(url))) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    const res = await realFetch(url, init);
    if (!String(url).endsWith('/info')) return res;
    const { batch, ...old } = await res.json();
    return new Response(JSON.stringify(old), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  console.log('pretending the market has no batch routes');
}

// ---- The market.
let info;
try {
  info = await (await fetch(`${BASE}/api/market/info`)).json();
} catch {
  stop(`no market at ${BASE}`);
}
console.log('market info', info);
if (info.mode !== 'server') stop('this check is for server mode');
const OLD = !!arg('old-market');
if (!info.pearlMint) stop(`market has no PEARL mint yet (fund ${info.market})`);

// ---- Throwaway player.
const u = createUmi(RPC, 'confirmed').use(mplCore());
const KEYFILE = file('player-keypair.json');
const secret = existsSync(KEYFILE) ? Uint8Array.from(JSON.parse(readFileSync(KEYFILE, 'utf8'))) : u.eddsa.generateKeypair().secretKey;
if (!existsSync(KEYFILE)) writeFileSync(KEYFILE, JSON.stringify(Array.from(secret)), { mode: 0o600 });
u.use(keypairIdentity(u.eddsa.createKeypairFromSecretKey(secret)));
const player = u.identity.publicKey.toString();
console.log(`player ${player}`);

const balance = async (k = u.identity.publicKey) => Number((await u.rpc.getBalance(k)).basisPoints) / 1e9;
if ((await balance()) < 0.05) {
  try {
    await u.rpc.airdrop(u.identity.publicKey, sol(1), { commitment: 'confirmed' });
    console.log('airdrop ok');
  } catch (e) {
    console.log(`airdrop refused (${String(e.message).slice(0, 80)})`);
    const marketFile = process.env.MARKET_DIR && path.join(process.env.MARKET_DIR, '.market-keypair.json');
    if (marketFile && existsSync(marketFile)) {
      const m = createUmi(RPC, 'confirmed');
      m.use(keypairIdentity(m.eddsa.createKeypairFromSecretKey(Uint8Array.from(JSON.parse(readFileSync(marketFile, 'utf8'))))));
      await transferSol(m, { destination: u.identity.publicKey, amount: sol(0.2) }).sendAndConfirm(m);
      console.log('borrowed 0.2 SOL from the local market wallet');
    }
  }
}
if ((await balance()) < 0.02) stop(`player ${player} has no SOL`);

// ---- The game's pearl.ts, with wallet.ts swapped for this keypair behind a signer that counts prompts.
const prompts = { signAll: 0, signOne: 0 };
const signer = {
  publicKey: u.identity.publicKey,
  signMessage: (m) => u.identity.signMessage(m),
  async signTransaction(tx) {
    prompts.signOne++;
    return u.identity.signTransaction(tx);
  },
  async signAllTransactions(txs) {
    prompts.signAll++;
    return u.identity.signAllTransactions(txs);
  },
};
globalThis.__e2e = { u, player, signer };
const ts = (await import(new URL('../game/node_modules/typescript/lib/typescript.js', import.meta.url).href)).default;
const transpile = (f) =>
  ts.transpileModule(readFileSync(new URL(`../game/src/${f}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const walletStub = dataUrl(`
  export const storageKey = (n) => 'e2e.' + n;
  export const ownerAddress = () => globalThis.__e2e.player;
  export const ownerSigner = () => globalThis.__e2e.signer;`);
const local = { './chain': dataUrl('export const getUmi = () => globalThis.__e2e.u;'), './wallet': walletStub };
const pearlSrc = transpile('pearl.ts')
  .replace("const API = '/api/market';", `const API = '${BASE}/api/market';`)
  .replace(/from (['"])\.\/wallet\1/g, `from '${walletStub}'`)
  .replace(/from (['"])\.\/market\1/g, `from '${dataUrl(transpile('market.ts'))}'`)
  .replace(/import\((['"])([^'"]+)\1\)/g, (_, q, spec) => `import('${local[spec] ?? import.meta.resolve(spec)}')`);
const pearl = await import(dataUrl(pearlSrc));

// ---- Test fish, minted as chain.ts mints them (on-chain Attributes; value = the catch value).
async function mintFish(n, label) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const asset = generateSigner(u);
    const rarity = i % 3 === 2 ? 'uncommon' : 'common';
    const value = rarity === 'uncommon' ? 3 : 1;
    await create(u, {
      asset,
      name: `E2E ${label} ${i + 1}`,
      uri: '',
      plugins: [
        {
          type: 'Attributes',
          attributeList: [
            { key: 'rarity', value: rarity },
            { key: 'species', value: 'Azure Tang' },
            { key: 'depth', value: '5' },
            { key: 'value', value: String(value) },
            { key: 'seed', value: `e2e${i}` },
          ],
        },
      ],
    }).sendAndConfirm(u);
    ids.push({ id: asset.publicKey.toString(), value });
  }
  console.log(`minted ${n} fish: ${ids.map((f) => `${f.id} (${f.value})`).join(', ')}`);
  return ids;
}

const progress = (p) => console.log(`  progress: ${p.step} · ${p.fish} fish${p.txs ? ` · ${p.txs} tx` : ''}`);

/** Every fish: gone (burned by the market) after a transfer to the market that the player signed, and paid its value by its own pay tx. */
async function checkOnChain(fish, outcomes) {
  const transfers = new Set(outcomes.map((o) => o.result.extra[0]));
  const movedToMarket = new Set();
  for (const sig of transfers) {
    const tx = await u.rpc.getTransaction(base58.serialize(sig), { commitment: 'confirmed' });
    const keys = tx.message.accounts.map(String);
    const moved = tx.message.instructions.filter((ix) => ix.data[0] === 14 && keys[ix.accountIndexes[4]] === info.market).map((ix) => keys[ix.accountIndexes[0]]);
    console.log(`  transfer ${sig}: ${moved.length} Core transfers to the market, ${tx.meta.computeUnitsConsumed ?? '?'} CU, signer ${keys[0]}`);
    check(keys[0] === player, 'the player signed and paid the transfer');
    moved.forEach((id) => movedToMarket.add(id));
  }
  for (const f of fish) {
    const o = outcomes.find((x) => x.assetId === f.id);
    check(movedToMarket.has(f.id), `${f.id.slice(0, 6)}… was moved to the market wallet by the shared transfer`);
    check(o?.result?.pearls === f.value, `${f.id.slice(0, 6)}… paid ${f.value} PEARL (server says ${o?.result?.pearls})`);
    const pay = await u.rpc.getTransaction(base58.serialize(o.result.tx), { commitment: 'confirmed' });
    // umi's token balances: { owner, mint, amount: { basisPoints } }; no "pre" entry when this tx created the account.
    const mine = (list) => list?.find((b) => String(b.owner) === player && String(b.mint) === info.pearlMint);
    const amountOf = (b) => Number(b?.amount?.basisPoints ?? 0n);
    const delta = amountOf(mine(pay.meta.postTokenBalances)) - amountOf(mine(pay.meta.preTokenBalances));
    check(delta === f.value, `${f.id.slice(0, 6)}… pay tx ${o.result.tx.slice(0, 8)}… minted exactly ${f.value} PEARL to the player on-chain`);
    const payKeys = pay.message.accounts.map(String);
    const memo = pay.message.instructions.find((ix) => payKeys[ix.programIndex].startsWith('Memo'));
    check(memo && Buffer.from(memo.data).toString('utf8').includes(f.id), `${f.id.slice(0, 6)}… pay tx memo names the fish`);
    const asset = await fetchAsset(u, publicKey(f.id)).catch(() => null);
    if (asset) check(asset.owner.toString() === info.market, `${f.id.slice(0, 6)}… is owned by the market (burn pending)`);
    else check(!!o.result.extra[1], `${f.id.slice(0, 6)}… went to the market and was burned (${o.result.extra[1].slice(0, 8)}…)`);
  }
}

const statePath = file('crash-state.json');

if (RESUME) {
  // ---- The run after a crash: the pending sale finishes (or restarts) without losing or double-paying a fish.
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  console.log(`resuming after a crash ${state.crash}; pending:`, JSON.parse(store['e2e.deepbreath.pearl.pending'] ?? '{}'));
  const before = await pearl.pearlBalance();
  const outcomes = await pearl.sellManyToMarket(state.fish.map((f) => f.id), progress);
  console.log('outcomes', outcomes);
  check(outcomes.every((o) => o.result), 'every fish of the interrupted batch sold');
  const after = await pearl.pearlBalance();
  const total = state.fish.reduce((s, f) => s + f.value, 0);
  check(after - before === total, `PEARL ${before} -> ${after}: +${total}, each fish paid once`);
  // A transfer that landed (crash after sending, or the market refused the request) is reused; one that
  // never left expires, and the fish are handed over again with one new prompt.
  if (state.crash === 'before-send') check(prompts.signAll + prompts.signOne === 1, 'the transfer that never left expired, so the fish were handed over again with one new prompt');
  else check(prompts.signAll + prompts.signOne === 0, 'the transfer that landed was reused: no new wallet prompt');
  check(Object.keys(JSON.parse(store['e2e.deepbreath.pearl.pending'] ?? '{}')).length === 0, 'nothing left pending');
  await checkOnChain(state.fish, outcomes);
  console.log('\nOK (resume)');
  process.exit(0);
}

if (CRASH) {
  // ---- Exit on purpose after the wallet signed: before the transfer is sent, or right after.
  const fish = await mintFish(2, 'crash');
  writeFileSync(statePath, JSON.stringify({ crash: CRASH, fish }));
  const send = u.rpc.sendTransaction.bind(u.rpc);
  u.rpc.sendTransaction = async (tx, opts) => {
    if (CRASH === 'before-send') {
      console.log('CRASH: exiting after signing, before sending the transfer');
      process.exit(3);
    }
    const sig = await send(tx, opts);
    await u.rpc.confirmTransaction(sig, { commitment: 'confirmed', strategy: { type: 'blockhash', ...(await u.rpc.getLatestBlockhash()) } }).catch(() => {});
    console.log('CRASH: exiting after the transfer was sent, before the market was told');
    process.exit(3);
  };
  await pearl.sellManyToMarket(fish.map((f) => f.id), progress);
  stop('expected to crash');
}

// ---- The batch: FISH fish, one approval.
const fish = await mintFish(FISH, 'batch');
const before = await pearl.pearlBalance();
console.log(`PEARL before: ${before}`);
const outcomes = await pearl.sellManyToMarket(fish.map((f) => f.id), progress);
console.log('outcomes', JSON.stringify(outcomes, null, 1));
check(outcomes.every((o) => o.result), `all ${FISH} fish sold`);
// One transaction is one signTransaction call; several are one signAllTransactions call. Either way: one prompt.
check(prompts.signAll + prompts.signOne === 1, `the wallet was asked once for ${FISH} fish (signAllTransactions x${prompts.signAll}, signTransaction x${prompts.signOne})`);
if (FISH > 20) check(prompts.signAll === 1, 'more than one transfer transaction, signed together with signAllTransactions');
const after = await pearl.pearlBalance();
const total = fish.reduce((s, f) => s + f.value, 0);
check(after - before === total, `PEARL ${before} -> ${after}: +${total}, the sum of the fish values`);
await checkOnChain(fish, outcomes);

// ---- Replays pay nothing more: the same batch again, and selling the sold fish again.
const replay = { results: [] };
for (let i = 0; i < outcomes.length && !OLD; i += 24) {
  const part = outcomes.slice(i, i + 24); // the market's MAX_BATCH
  const res = await (
    await fetch(`${BASE}/api/market/sell-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seller: player, sales: part.map((o) => ({ assetId: o.assetId, transferTx: o.result.extra[0] })) }),
    })
  ).json();
  if (!res.results) throw new Error(`replay refused: ${JSON.stringify(res)}`);
  replay.results.push(...res.results);
}
check(
  OLD ||
  JSON.stringify(replay.results.map(({ assetId, ...r }) => ({ assetId, result: r }))) === JSON.stringify(outcomes.map(({ assetId, result }) => ({ assetId, result }))),
  'replaying /sell-batch returns the stored results',
);
const again = await pearl.sellManyToMarket(fish.map((f) => f.id), progress);
check(again.every((o) => o.result || o.error), 'selling the same fish again answers per fish');
const afterReplay = await pearl.pearlBalance();
check(afterReplay === after, `PEARL unchanged by the replays (${afterReplay})`);
console.log(`\nPEARL mint ${info.pearlMint}\nOK`);

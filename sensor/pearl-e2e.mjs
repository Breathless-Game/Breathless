// Devnet end-to-end check of the PEARL market, driving the game's real
// game/src/pearl.ts from Node: a throwaway wallet mints a test fish (same Core
// + Attributes shape as chain.ts, no Irys upload), sells it, checks the PEARL
// balance, spends some and checks again. Follows whichever mode the running
// market reports.
//
//   npm run market          (another terminal)
//   npm run market:e2e      (in sensor/)
//
// The throwaway keypair lives in the OS temp dir (or E2E_KEYPAIR) so a wallet
// you fund by hand at https://faucet.solana.com is reused on the next run.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSigner, keypairIdentity, publicKey, sol } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { create, mplCore } from '@metaplex-foundation/mpl-core';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
import { base58 } from '@metaplex-foundation/umi/serializers';

const BASE = `http://127.0.0.1:${process.env.MARKET_PORT ?? 8795}`;
const RPC = process.env.SOLANA_RPC ?? process.env.VITE_SOLANA_RPC ?? 'https://api.devnet.solana.com';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const KEYFILE = process.env.E2E_KEYPAIR ?? path.join(os.tmpdir(), 'pearl-e2e-keypair.json');
const tx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const address = (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const stop = (msg) => {
  console.log(`\nSTOPPED: ${msg}`);
  process.exit(2);
};

// ---- The market must be running.
let info;
try {
  info = await (await fetch(`${BASE}/api/market/info`)).json();
} catch {
  stop(`no market at ${BASE}; start it with \`npm run market\``);
}
console.log('market info', info);
if (info.mode === 'program' && !info.ready) stop('program mode, but fish_market config is not initialized with this oracle');
if (info.cosign) stop('this market only buys fish minted into its collection through /cosign-mint; these test fish are minted directly, so it would refuse them. Use fish-trust-e2e.mjs (co-signed mint, migration, sale), or a market from before the collection');

// ---- Throwaway player wallet.
const u = createUmi(RPC, 'confirmed').use(mplCore());
const secret = existsSync(KEYFILE)
  ? Uint8Array.from(JSON.parse(readFileSync(KEYFILE, 'utf8')))
  : u.eddsa.generateKeypair().secretKey;
if (!existsSync(KEYFILE)) writeFileSync(KEYFILE, JSON.stringify(Array.from(secret)), { mode: 0o600 });
u.use(keypairIdentity(u.eddsa.createKeypairFromSecretKey(secret)));
const player = u.identity.publicKey.toString();
console.log(`player ${player}  (${address(player)})`);

// ---- Load the game's real pearl.ts (and wallet.ts), with chain.ts swapped for this wallet.
const ts = (await import(new URL('../game/node_modules/typescript/lib/typescript.js', import.meta.url).href)).default;
const transpile = (file) =>
  ts.transpileModule(readFileSync(new URL(`../game/src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
globalThis.__pearlE2eUmi = u;
const local = {
  './chain': dataUrl('export const getUmi = () => globalThis.__pearlE2eUmi;'),
  './wallet': dataUrl(transpile('wallet.ts')),
};
const pearlSrc = transpile('pearl.ts')
  .replace("const API = '/api/market';", `const API = '${BASE}/api/market';`)
  .replace(/from (['"])\.\/(wallet|market)\1/g, (_, q, f) => `from '${f === 'wallet' ? local['./wallet'] : dataUrl(transpile('market.ts'))}'`)
  .replace(/from (['"])\.\/payment-safety\1/g, () => `from '${dataUrl(transpile('payment-safety.ts'))}'`)
  .replace(/import\((['"])([^'"]+)\1\)/g, (_, q, spec) => `import('${local[spec] ?? import.meta.resolve(spec)}')`);
const pearl = await import(dataUrl(pearlSrc));
console.log(`pearl.ts loaded; player PEARL balance ${await pearl.pearlBalance()}`);

const balance = async (k = u.identity.publicKey) => Number((await u.rpc.getBalance(k)).basisPoints) / 1e9;
if ((await balance()) < 0.03) {
  try {
    await u.rpc.airdrop(u.identity.publicKey, sol(1), { commitment: 'confirmed' });
    console.log('airdrop ok');
  } catch {
    // Dev convenience: in server mode, borrow a little from the local market wallet.
    const marketFile = path.join(HERE, '.market-keypair.json');
    if (info.mode === 'server' && existsSync(marketFile)) {
      const m = createUmi(RPC, 'confirmed');
      m.use(keypairIdentity(m.eddsa.createKeypairFromSecretKey(Uint8Array.from(JSON.parse(readFileSync(marketFile, 'utf8'))))));
      if (Number((await m.rpc.getBalance(m.identity.publicKey)).basisPoints) / 1e9 > 0.2) {
        await transferSol(m, { destination: u.identity.publicKey, amount: sol(0.05) }).sendAndConfirm(m);
        console.log('funded 0.05 SOL from the market wallet');
      }
    }
  }
}
const have = await balance();
console.log(`player balance ${have} SOL`);
if (have < 0.01) stop(`player wallet has no devnet SOL and the faucet refused. Fund ${player} at https://faucet.solana.com and re-run`);
if (!info.pearlMint) stop(`market has no PEARL mint yet (wallet ${info.market} needs devnet SOL; fund it at https://faucet.solana.com)`);

// ---- A test fish, minted the way chain.ts mints (on-chain Attributes; Irys skipped).
const asset = generateSigner(u);
const { signature: mintSig } = await create(u, {
  asset,
  name: 'E2E Azure Tang',
  uri: '',
  plugins: [
    {
      type: 'Attributes',
      attributeList: [
        { key: 'rarity', value: 'rare' },
        { key: 'species', value: 'Azure Tang' },
        { key: 'depth', value: '25' },
        { key: 'seed', value: 'e2e00001' },
      ],
    },
  ],
}).sendAndConfirm(u);
const assetId = asset.publicKey.toString();
console.log(`minted fish ${assetId}\n  ${tx(base58.deserialize(mintSig)[0])}`);

// ---- Sell, check, spend, check.
const before = await pearl.pearlBalance();
const sale = await pearl.sellToMarket(assetId, (s) => console.log(`  sell step: ${s}`));
console.log('sale', sale);
for (const sig of [sale.tx, ...(sale.extra ?? [])].filter(Boolean)) console.log(`  ${tx(sig)}`);
const afterSale = await pearl.pearlBalance();
console.log(`PEARL ${before} -> ${afterSale}`);
if (afterSale - before !== sale.pearls) throw new Error('balance did not grow by the sale amount');
if (sale.pearls !== 16) throw new Error(`expected 16 PEARL for a rare fish at 25 m, got ${sale.pearls}`);

if (info.mode === 'server') {
  const retry = await (
    await fetch(`${BASE}/api/market/sell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, seller: player, transferTx: sale.extra[0] }),
    })
  ).json();
  if (JSON.stringify(retry) !== JSON.stringify(sale)) throw new Error(`retry was not idempotent: ${JSON.stringify(retry)}`);
  console.log('retrying the same sale returned the stored result (no double pay)');
}
const again = await pearl.sellToMarket(assetId).then(
  () => 'sold twice!',
  (e) => e.message,
);
console.log(`selling the burned fish again: ${again}`);

const spendSig = await pearl.spendPearls(5);
const afterSpend = await pearl.pearlBalance();
console.log(`spent 5 PEARL: ${afterSale} -> ${afterSpend}\n  ${tx(spendSig)}`);
if (afterSpend !== afterSale - 5) throw new Error('spend did not burn 5 PEARL');
const tooMuch = await pearl.spendPearls(afterSpend + 1).then(
  () => 'spent more than held!',
  (e) => `${e.name}: ${e.message}`,
);
console.log(`overspend: ${tooMuch}`);
console.log(`\nPEARL mint ${address(info.pearlMint)}\nOK`);

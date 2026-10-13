import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { mock } from 'node:test';
import ts from 'typescript';

// wallet.ts transpiled in memory with its chain imports stubbed out: only the
// login state machine (connect / restore / adopt) is under test here.
const transpile = (source) =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;

const storageUrl = dataUrl(transpile(await readFile(new URL('../src/wallet-storage.ts', import.meta.url), 'utf8')));
const stubs = {
  './polyfills': '',
  '@metaplex-foundation/umi': 'export const publicKey = (s) => s, createSignerFromKeypair = () => ({}), transactionBuilder = () => ({});',
  '@metaplex-foundation/umi/serializers': 'export const base58 = {};',
  './owner-wallets': `export const findWallet = (n) => globalThis.__wallets[n] ?? null;
    export const waitForWallet = async (n) => globalThis.__wallets[n] ?? null;`,
  './balance-api': 'export const markBalanceStale = () => {}, readBalances = async () => ({});',
  './payment-safety': 'export const assertLanded = () => {};',
  './blockhash-expiry': 'export const expiryOf = () => 0;',
};
let walletJs = transpile(await readFile(new URL('../src/wallet.ts', import.meta.url), 'utf8'));
walletJs = walletJs.replace('import.meta.env.VITE_SOLANA_RPC', 'undefined').replace(`'./wallet-storage'`, `'${storageUrl}'`);
for (const [name, js] of Object.entries(stubs)) walletJs = walletJs.replace(`'${name}'`, `'${dataUrl(js)}'`);

let loads = 0;
/** A fresh copy of wallet.ts (its own owner / queue), over a fresh localStorage. */
async function freshWallet(wallets) {
  globalThis.__wallets = wallets;
  const map = new Map([
    ['deepbreath.OwnerA.session', JSON.stringify(Array(64).fill(1))],
    ['deepbreath.OwnerB.session', JSON.stringify(Array(64).fill(2))],
  ]);
  globalThis.localStorage = {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  return import(dataUrl(`${walletJs}\n// ${++loads}`));
}

function fakeWallet(name, address) {
  return { name, icon: '', connect: async () => address, disconnect: async () => {}, watch: () => () => {}, signer: () => ({}) };
}

test('connecting a different account while one is loaded drops it (main.ts reloads) instead of swapping in place', async () => {
  const W = await freshWallet({ Phantom: fakeWallet('Phantom', 'OwnerA'), Solflare: fakeWallet('Solflare', 'OwnerB') });
  assert.equal((await W.connectWallet('Phantom')).owner, 'OwnerA');
  const seen = [];
  W.onWalletChange((s) => seen.push(s.owner));

  const after = await W.connectWallet('Solflare');
  assert.equal(after.owner, null);
  assert.deepEqual(seen, [null]); // never OwnerB: nothing saves under deepbreath.OwnerB.* before the reload
  assert.throws(() => W.storageKey('bank'));
  // The reload's silent restore reconnects the wallet just picked.
  assert.equal(localStorage.getItem('deepbreath.lastWallet'), 'Solflare');
  assert.equal((await W.restoreWallet()).owner, 'OwnerB');
});

test('the same account through another wallet is still adopted in place', async () => {
  const W = await freshWallet({ Phantom: fakeWallet('Phantom', 'OwnerA'), Solflare: fakeWallet('Solflare', 'OwnerA') });
  await W.connectWallet('Phantom');
  const s = await W.connectWallet('Solflare');
  assert.equal(s.owner, 'OwnerA');
  assert.equal(s.wallet.name, 'Solflare');
});

test('a silent reconnect that never settles gives up, so later logins are not stuck behind it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const hung = { ...fakeWallet('Phantom', 'OwnerA'), connect: () => new Promise(() => {}) };
    const W = await freshWallet({ Phantom: hung, Solflare: fakeWallet('Solflare', 'OwnerB') });
    const restored = W.restoreWallet();
    const login = W.connectWallet('Solflare'); // queued behind the restore
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    mock.timers.tick(10_000);
    assert.equal((await restored).owner, null);
    assert.equal((await login).owner, 'OwnerB');
  } finally {
    mock.timers.reset();
  }
});

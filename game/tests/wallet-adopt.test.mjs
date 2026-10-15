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
const promptUrl = dataUrl(transpile(await readFile(new URL('../src/wallet-prompt.ts', import.meta.url), 'utf8')));
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
walletJs = walletJs.replace('import.meta.env.VITE_SOLANA_RPC', 'undefined').replace(`'./wallet-storage'`, `'${storageUrl}'`).replace(`'./wallet-prompt'`, `'${promptUrl}'`);
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

// ---- Account reports while a wallet prompt is open (wallet-prompt.ts) ------------------------

/** A wallet whose account reports and current accounts the test drives, and whose prompts stay open until answered. */
function promptingWallet(name, address) {
  const w = {
    ...fakeWallet(name, address),
    now: [address],
    emit: null,
    prompts: [],
    watch(cb) {
      w.emit = cb;
      return () => (w.emit = null);
    },
    accounts: () => w.now,
    signer: () => ({
      publicKey: address,
      signMessage: async (m) => m,
      signTransaction: () => new Promise((resolve, reject) => w.prompts.push({ resolve, reject })),
      signAllTransactions: async (txs) => txs,
    }),
  };
  return w;
}
const umi = { eddsa: { createKeypairFromSecretKey: () => ({}) } };
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
};
const Storage = await import(storageUrl);

test('a passing disconnect reported while a sale waits in the wallet neither logs out nor reloads', async () => {
  const phantom = promptingWallet('Phantom', 'OwnerA');
  const W = await freshWallet({ Phantom: phantom });
  await W.connectWallet('Phantom');
  const seen = [];
  W.onWalletChange((s) => seen.push(s.owner));

  const sale = W.ownerSigner(umi).signTransaction('sell');
  phantom.emit([]); // the wallet churns while its popup is up
  await settle();
  assert.equal(W.walletState().owner, 'OwnerA', 'kept while the prompt is open');
  assert.deepEqual(seen, []); // no change: main.ts does not reload

  // The sale is approved and the wallet still has the owner: nothing happens.
  phantom.prompts[0].resolve('signed');
  assert.equal(await sale, 'signed');
  await settle();
  assert.equal(W.walletState().owner, 'OwnerA');
  assert.deepEqual(seen, []);
  assert.notEqual(Storage.restoreTarget(localStorage), null, 'not marked logged out');
});

test('a real disconnect during a sale is handled once the prompt settles', async () => {
  const phantom = promptingWallet('Phantom', 'OwnerA');
  const W = await freshWallet({ Phantom: phantom });
  await W.connectWallet('Phantom');
  const seen = [];
  W.onWalletChange((s) => seen.push(s.owner));

  const sale = W.ownerSigner(umi).signTransaction('sell');
  phantom.now = [];
  phantom.emit([]);
  await settle();
  assert.equal(W.walletState().owner, 'OwnerA');
  phantom.prompts[0].reject(new Error('Wallet disconnected'));
  await assert.rejects(sale);
  await settle();
  assert.equal(W.walletState().owner, null);
  assert.deepEqual(seen, [null]); // main.ts reloads now, as before
  assert.equal(Storage.restoreTarget(localStorage), null, 'logged out: page loads do not reconnect');
});

test('switching to another account during a sale drops the owner after the prompt settles', async () => {
  const phantom = promptingWallet('Phantom', 'OwnerA');
  const W = await freshWallet({ Phantom: phantom });
  await W.connectWallet('Phantom');
  const sale = W.ownerSigner(umi).signTransaction('sell');
  phantom.now = ['OwnerB'];
  phantom.emit(['OwnerB']);
  await settle();
  assert.equal(W.walletState().owner, 'OwnerA');
  phantom.prompts[0].reject(new Error('switched accounts'));
  await assert.rejects(sale);
  await settle();
  assert.equal(W.walletState().owner, null);
  assert.notEqual(Storage.restoreTarget(localStorage), null, 'a switch is not a logout');
});

test('with no prompt open an account report is handled at once, as before', async () => {
  const phantom = promptingWallet('Phantom', 'OwnerA');
  const W = await freshWallet({ Phantom: phantom });
  await W.connectWallet('Phantom');
  phantom.emit(['OwnerA']);
  await settle();
  assert.equal(W.walletState().owner, 'OwnerA');
  phantom.emit([]);
  await settle();
  assert.equal(W.walletState().owner, null);
  assert.equal(Storage.restoreTarget(localStorage), null);
});

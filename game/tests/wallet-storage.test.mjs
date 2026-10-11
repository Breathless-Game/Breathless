import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The module has no imports; transpile it in memory like render-quality.test.mjs.
const source = await readFile(new URL('../src/wallet-storage.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const W = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const OWNER_A = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const OWNER_B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// Keypair.fromSeed(32 × 7) from @solana/web3.js; its address is OWNER_A.
const SECRET = [
  ...Array(32).fill(7),
  234, 74, 108, 99, 226, 156, 82, 10, 190, 245, 80, 123, 19, 46, 197, 249, 149, 71, 118, 174, 190, 190, 123, 146, 66,
  30, 234, 105, 20, 70, 210, 44,
];

/** localStorage stand-in that can be told to fail writes. */
function memoryStore(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    failOn: null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (this.failOn === k) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
  };
}

const LEGACY = {
  'deepbreath.wallet': JSON.stringify(SECRET),
  'deepbreath.bank': '[{"id":"1"}]',
  'deepbreath.equipment': '{"rodLevel":2,"pearls":40}',
  'deepbreath.maps': '{"selected":"tianchi","bestValue":900,"unlockAll":false}',
  'deepbreath.health': '[]',
  'deepbreath.settings': '{"quality":"low"}',
};

test('keys are namespaced per owner, with or without the legacy prefix', () => {
  assert.equal(W.namespacedKey(OWNER_A, 'bank'), `deepbreath.${OWNER_A}.bank`);
  assert.equal(W.namespacedKey(OWNER_A, 'deepbreath.bank'), `deepbreath.${OWNER_A}.bank`);
  assert.notEqual(W.namespacedKey(OWNER_A, 'bank'), W.namespacedKey(OWNER_B, 'bank'));
  assert.equal(W.namespacedKey(OWNER_B, 'session'), `deepbreath.${OWNER_B}.session`);
});

test('a key without an owner, or with a bad owner or name, throws', () => {
  assert.throws(() => W.namespacedKey('', 'bank'), /Connect Phantom/);
  assert.throws(() => W.namespacedKey(null, 'bank'), /Connect Phantom/);
  assert.throws(() => W.namespacedKey('a.b', 'bank'), /Not a wallet address/);
  assert.throws(() => W.namespacedKey(OWNER_A, 'deepbreath.'), /empty/);
});

test('first login copies the burner into the session slot and progress into the namespace', () => {
  const store = memoryStore(LEGACY);
  const steps = W.migrateLegacy(store, OWNER_A);
  assert.deepEqual(
    steps.map((s) => s.from),
    ['deepbreath.wallet', 'deepbreath.bank', 'deepbreath.equipment', 'deepbreath.maps', 'deepbreath.health'],
  );
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.session`), LEGACY['deepbreath.wallet']);
  for (const name of ['bank', 'equipment', 'maps', 'health']) {
    assert.equal(store.getItem(`deepbreath.${OWNER_A}.${name}`), LEGACY[`deepbreath.${name}`]);
  }
  assert.equal(store.getItem(W.MIGRATED_KEY), OWNER_A);
  // Originals are kept; device settings are neither moved nor copied.
  for (const [k, v] of Object.entries(LEGACY)) assert.equal(store.getItem(k), v);
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.settings`), null);
});

test('prototype rod/pearl keys travel too, so equipment.ts can still migrate them', () => {
  const store = memoryStore({ 'deepbreath.rod': '3', 'deepbreath.pearls': '120', 'deepbreath.pearl': '5' });
  W.migrateLegacy(store, OWNER_A);
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.rod`), '3');
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.pearls`), '120');
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.pearl`), '5');
});

test('an unfinished PEARL sale travels too, so pearl.ts can resume it', () => {
  const pending = '{"asset1":{"mode":"server","transferTx":"sig"}}';
  const store = memoryStore({ 'deepbreath.pearl.pending': pending });
  W.migrateLegacy(store, OWNER_A);
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.pearl.pending`), pending);
  assert.equal(W.namespacedKey(OWNER_A, 'deepbreath.pearl.pending'), `deepbreath.${OWNER_A}.pearl.pending`);
});

test('migration happens once: a second wallet starts empty', () => {
  const store = memoryStore(LEGACY);
  W.migrateLegacy(store, OWNER_A);
  assert.equal(W.planMigration(store, OWNER_B), null);
  assert.equal(W.migrateLegacy(store, OWNER_B), null);
  assert.equal(W.migrateLegacy(store, OWNER_A), null);
  assert.ok(![...store.map.keys()].some((k) => k.includes(OWNER_B)));
});

test('a fresh browser has nothing to copy but still marks the migration done', () => {
  const store = memoryStore({ 'deepbreath.settings': '{}' });
  assert.deepEqual(W.planMigration(store, OWNER_A), []);
  assert.deepEqual(W.migrateLegacy(store, OWNER_A), []);
  assert.equal(store.getItem(W.MIGRATED_KEY), OWNER_A);
  assert.equal(W.migrateLegacy(memoryStore(), OWNER_B).length, 0);
});

test('existing per-wallet data is never overwritten by legacy data', () => {
  const store = memoryStore({ ...LEGACY, [`deepbreath.${OWNER_A}.bank`]: '[]' });
  const steps = W.migrateLegacy(store, OWNER_A);
  assert.ok(!steps.some((s) => s.from === 'deepbreath.bank'));
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.bank`), '[]');
});

test('a failed copy leaves the originals and no marker, so the next login retries', () => {
  const store = memoryStore(LEGACY);
  store.failOn = `deepbreath.${OWNER_A}.maps`;
  assert.throws(() => W.migrateLegacy(store, OWNER_A), /Quota/);
  assert.equal(store.getItem(W.MIGRATED_KEY), null);
  for (const [k, v] of Object.entries(LEGACY)) assert.equal(store.getItem(k), v);

  store.failOn = null;
  const retry = W.migrateLegacy(store, OWNER_A);
  assert.deepEqual(retry.map((s) => s.from), ['deepbreath.maps', 'deepbreath.health']);
  assert.equal(store.getItem(`deepbreath.${OWNER_A}.maps`), LEGACY['deepbreath.maps']);
  assert.equal(store.getItem(W.MIGRATED_KEY), OWNER_A);
});

test('session secrets parse only as 64 bytes, and their address is the last 32', () => {
  const secret = W.parseSecretKey(JSON.stringify(SECRET));
  assert.equal(secret.length, 64);
  assert.equal(W.addressOfSecret(secret), OWNER_A);
  assert.equal(W.parseSecretKey(null), null);
  assert.equal(W.parseSecretKey('not json'), null);
  assert.equal(W.parseSecretKey('[1,2,3]'), null);
  assert.equal(W.parseSecretKey(JSON.stringify(SECRET.map((n, i) => (i === 5 ? 256 : n)))), null);
});

test('base58 matches Solana addresses and leading zero bytes', () => {
  const hex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  assert.equal(W.base58(hex('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9')), OWNER_B);
  assert.equal(W.base58(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(W.base58(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(W.base58(hex('0000287fb4cd')), '11233QC4');
  assert.equal(W.shortAddress(OWNER_A), 'GmaD…AEGB');
});

test('declined Phantom prompts are recognised', () => {
  assert.ok(W.isUserRejection({ code: 4001, message: 'User rejected the request.' }));
  assert.ok(W.isUserRejection(new Error('User rejected the request.')));
  assert.ok(!W.isUserRejection(new Error('insufficient funds')));
  assert.ok(!W.isUserRejection(null));
});

/** memoryStore plus removeItem, as localStorage has. */
function removableStore(entries = {}) {
  const store = memoryStore(entries);
  store.removeItem = (k) => store.map.delete(k);
  return store;
}

test('a fresh browser may silently reconnect Phantom, as before the picker', () => {
  assert.equal(W.restoreTarget(removableStore()), 'Phantom');
});

test('an explicit logout sticks across page loads until the player connects again', () => {
  const store = removableStore();
  W.markLoggedIn(store, 'Solflare');
  assert.equal(W.restoreTarget(store), 'Solflare');
  W.markLoggedOut(store);
  assert.equal(W.restoreTarget(store), null);
  assert.equal(W.restoreTarget(store), null, 'a second load is still logged out');
  W.markLoggedIn(store, 'MetaMask');
  assert.equal(W.restoreTarget(store), 'MetaMask');
});

test('the picker offers only Solana wallets that connect and sign without sending', () => {
  const solana = ['solana:mainnet', 'solana:devnet'];
  assert.ok(W.usableWallet({ chains: solana, features: ['standard:connect', 'standard:events', 'solana:signTransaction'] }));
  assert.ok(!W.usableWallet({ chains: solana, features: ['standard:connect', 'solana:signAndSendTransaction'] }), 'sign-and-send only');
  assert.ok(!W.usableWallet({ chains: solana, features: ['solana:signTransaction'] }), 'no connect');
  assert.ok(!W.usableWallet({ chains: ['sui:devnet'], features: ['standard:connect', 'solana:signTransaction'] }), 'not Solana');
});

test('tiles: last used first, then known wallets in order, then the rest, then known ones to install', () => {
  const tiles = W.walletTiles(
    [
      { name: 'Zeta', devnet: true },
      { name: 'Solflare', devnet: true },
      { name: 'MetaMask', devnet: false },
      { name: 'solflare', devnet: true },
    ],
    'MetaMask',
  );
  assert.deepEqual(
    tiles.map((t) => `${t.name}:${t.installed ? 'in' : 'get'}${t.lastUsed ? ':last' : ''}`),
    ['MetaMask:in:last', 'Solflare:in', 'Zeta:in', 'Phantom:get', 'Backpack:get'],
  );
  assert.equal(tiles[0].devnet, false);
  assert.equal(tiles[2].url, null, 'an unknown wallet has no install link');
  assert.match(tiles[3].url, /^https:\/\/phantom\.com\//);
  assert.ok(tiles.filter((t) => !t.installed).every((t) => t.url?.startsWith('https://')));
});

test('with nothing installed every known wallet is offered to install', () => {
  assert.deepEqual(
    W.walletTiles([], null).map((t) => t.name),
    W.KNOWN_WALLETS.map((k) => k.name),
  );
  assert.ok(W.walletTiles([], 'Backpack').find((t) => t.name === 'Backpack').lastUsed);
});

test('devnet hints name the wallet', () => {
  assert.match(W.devnetHint('Phantom'), /Developer Settings/);
  assert.match(W.devnetHint('MetaMask'), /MetaMask.*Devnet/);
});

test('logging out keeps every wallet’s progress and session key', () => {
  const entries = {
    [`deepbreath.${OWNER_A}.session`]: JSON.stringify(SECRET),
    [`deepbreath.${OWNER_A}.bank`]: '[{"id":"1"}]',
    [`deepbreath.${OWNER_B}.bank`]: '[{"id":"2"}]',
  };
  const store = removableStore(entries);
  W.markLoggedIn(store, 'Phantom');
  W.markLoggedOut(store);
  for (const [k, v] of Object.entries(entries)) assert.equal(store.getItem(k), v);
  assert.deepEqual([...store.map.keys()].sort(), [...Object.keys(entries), W.AUTOCONNECT_KEY, W.LAST_WALLET_KEY].sort());
  assert.equal(store.getItem(W.LAST_WALLET_KEY), 'Phantom', 'remembers the wallet name, nothing secret');
});

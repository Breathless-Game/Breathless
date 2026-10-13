import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The module has no imports; transpile it in memory like wallet-storage.test.mjs.
const source = await readFile(new URL('../src/tab-lock.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const L = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const OWNER_A = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const OWNER_B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A lock manager with Web Locks' semantics for one page set: ifAvailable gets null while held;
 * steal rejects the holder's request with AbortError and grants the thief.
 */
function fakeLocks() {
  const held = new Map(); // name -> reject of the holder's request
  const calls = [];
  return {
    calls,
    held,
    request(name, options, cb) {
      calls.push({ name, options });
      if (options.steal && options.ifAvailable) return Promise.reject(Object.assign(new Error('both'), { name: 'NotSupportedError' }));
      return new Promise((resolve, reject) => {
        if (held.has(name) && !options.steal) {
          if (options.ifAvailable) Promise.resolve(cb(null)).then(resolve, reject);
          return; // (queued requests are not used here)
        }
        if (held.has(name)) held.get(name)(Object.assign(new Error('stolen'), { name: 'AbortError' }));
        held.set(name, reject);
        Promise.resolve(cb({ name, mode: 'exclusive' })).then(resolve, reject);
      });
    },
  };
}

test('the lock is named per wallet, like its storage keys', () => {
  assert.equal(L.tabLockName(OWNER_A), `deepbreath.${OWNER_A}.tab`);
  assert.notEqual(L.tabLockName(OWNER_A), L.tabLockName(OWNER_B));
});

test('first tab gets the lock, asking only if it is free', async () => {
  const locks = fakeLocks();
  assert.equal(await L.claimTab(OWNER_A, locks, () => assert.fail('not stolen')), 'granted');
  assert.deepEqual(locks.calls, [{ name: `deepbreath.${OWNER_A}.tab`, options: { ifAvailable: true } }]);
});

test('a second tab on the same wallet is busy; another wallet is not', async () => {
  const locks = fakeLocks();
  assert.equal(await L.claimTab(OWNER_A, locks, () => {}), 'granted');
  assert.equal(await L.claimTab(OWNER_A, locks, () => {}), 'busy');
  assert.equal(await L.claimTab(OWNER_B, locks, () => {}), 'granted');
});

test('no Web Locks, or a request that fails outright: play unguarded as before', async () => {
  assert.equal(await L.claimTab(OWNER_A, undefined, () => {}), 'unsupported');
  assert.equal(await L.claimTab(OWNER_A, {}, () => {}), 'unsupported');
  const throws = { request() { throw new Error('SecurityError'); } };
  assert.equal(await L.claimTab(OWNER_A, throws, () => {}), 'unsupported');
  const rejects = { request: () => Promise.reject(new Error('SecurityError')) };
  assert.equal(await L.claimTab(OWNER_A, rejects, () => assert.fail('never held')), 'unsupported');
});

test('"Play here" steals the lock: the holder hears it once, then the thief reloads', async () => {
  const locks = fakeLocks();
  let stolen = 0;
  assert.equal(await L.claimTab(OWNER_A, locks, () => stolen++), 'granted');
  assert.equal(await L.claimTab(OWNER_A, locks, () => {}), 'busy');
  let reloaded = 0;
  void L.takeOverTab(OWNER_A, locks, () => reloaded++);
  await tick();
  assert.equal(stolen, 1);
  assert.equal(reloaded, 1);
  // steal alone: Web Locks refuses steal together with ifAvailable
  assert.deepEqual(locks.calls.at(-1).options, { steal: true });
  assert.equal(await L.claimTab(OWNER_A, locks, () => {}), 'busy'); // the thief holds it now
});

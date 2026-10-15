import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The module has no imports; transpile it in memory like tab-lock.test.mjs.
const source = await readFile(new URL('../src/wallet-prompt.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const P = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

/** A promise and the functions that settle it. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** A signer whose prompts stay open until the test answers them. */
function fakeSigner() {
  const asks = [];
  const ask = (what) => {
    const d = deferred();
    asks.push({ what, ...d });
    return d.promise;
  };
  return {
    asks,
    signer: {
      publicKey: 'Owner111',
      signMessage: (m) => ask(['message', m]),
      signTransaction: (tx) => ask(['tx', tx]),
      signAllTransactions: (txs) => ask(['all', txs]),
    },
  };
}

test('an owner signature counts as an open wallet prompt until the player answers', async () => {
  const { asks, signer } = fakeSigner();
  const tracked = P.trackPrompts(signer);
  assert.equal(tracked.publicKey, 'Owner111');
  assert.equal(P.walletPromptOpen(), false);

  const sale = tracked.signAllTransactions(['a', 'b']);
  assert.equal(P.walletPromptOpen(), true, 'open while the sale waits in the wallet');
  assert.deepEqual(asks[0].what, ['all', ['a', 'b']]);
  asks[0].resolve(['A', 'B']);
  assert.deepEqual(await sale, ['A', 'B']);
  assert.equal(P.walletPromptOpen(), false);
});

test('a declined or failed prompt closes too', async () => {
  const { asks, signer } = fakeSigner();
  const tracked = P.trackPrompts(signer);
  const one = tracked.signTransaction('t');
  const msg = tracked.signMessage(new Uint8Array([1]));
  assert.equal(P.walletPromptOpen(), true);
  asks[0].reject(Object.assign(new Error('User rejected the request'), { code: 4001 }));
  await assert.rejects(one, /User rejected/);
  assert.equal(P.walletPromptOpen(), true, 'the message prompt is still open');
  asks[1].resolve(new Uint8Array([9]));
  await msg;
  assert.equal(P.walletPromptOpen(), false);
});

test('a hidden tab mid-dive goes aboard, unless the wallet took the window (a sale): then the dive holds', () => {
  // The bug: selling from the Collection mid-dive in the desktop app opens the system browser over
  // the game; the window reads as hidden and the dive used to go aboard to the title's fish.
  assert.equal(P.onTabHidden({ playing: true, paused: false, promptOpen: true }), 'hold');
  // Switching away with no wallet prompt keeps the old behaviour.
  assert.equal(P.onTabHidden({ playing: true, paused: false, promptOpen: false }), 'board');
  // Not in a running dive: nothing to do either way.
  for (const promptOpen of [true, false]) {
    assert.equal(P.onTabHidden({ playing: false, paused: false, promptOpen }), 'none');
    assert.equal(P.onTabHidden({ playing: true, paused: true, promptOpen }), 'none');
  }
});

test('the hidden-tab decision follows the prompt as it opens and closes', async () => {
  const { asks, signer } = fakeSigner();
  const tracked = P.trackPrompts(signer);
  const dive = () => P.onTabHidden({ playing: true, paused: false, promptOpen: P.walletPromptOpen() });
  assert.equal(dive(), 'board');
  const sale = tracked.signTransaction('sell');
  assert.equal(dive(), 'hold');
  asks[0].resolve('signed');
  await sale;
  assert.equal(dive(), 'board');
});

test('a held dive resumes only when the tab shows and the wallet has answered', async () => {
  // Back in the game before approving (reading the desktop app's code): still held.
  assert.equal(P.shouldResume({ held: true, hidden: false, promptOpen: true }), false);
  assert.equal(P.shouldResume({ held: true, hidden: true, promptOpen: false }), false);
  assert.equal(P.shouldResume({ held: true, hidden: false, promptOpen: false }), true);
  // Nothing held here: other pauses are not this one's to lift.
  assert.equal(P.shouldResume({ held: false, hidden: false, promptOpen: false }), false);

  const { asks, signer } = fakeSigner();
  const sale = P.trackPrompts(signer).signTransaction('sell');
  const resume = () => P.shouldResume({ held: true, hidden: false, promptOpen: P.walletPromptOpen() });
  assert.equal(resume(), false, 'visible again, but the sale still waits in the wallet');
  asks[0].resolve('signed');
  await sale;
  assert.equal(resume(), true);
});

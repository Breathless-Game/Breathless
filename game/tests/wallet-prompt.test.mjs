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

test('a dive freezes while a wallet prompt is open, even on a visible tab (no shark bite meanwhile)', () => {
  assert.equal(P.shouldHold({ playing: true, paused: false, held: false, promptOpen: true }), true);
  assert.equal(P.shouldHold({ playing: true, paused: false, held: false, promptOpen: false }), false);
  assert.equal(P.shouldHold({ playing: true, paused: false, held: true, promptOpen: true }), false, 'already held');
  assert.equal(P.shouldHold({ playing: true, paused: true, held: false, promptOpen: true }), false, 'another pause has it');
  assert.equal(P.shouldHold({ playing: false, paused: false, held: false, promptOpen: true }), false, 'not in a dive');
});

test('promptsSettled waits for every open prompt, and resolves at once when none is', async () => {
  await P.promptsSettled();
  const { asks, signer } = fakeSigner();
  const tracked = P.trackPrompts(signer);
  const a = tracked.signTransaction('a');
  const b = tracked.signMessage(new Uint8Array());
  let done = false;
  const settled = P.promptsSettled().then(() => (done = true));
  asks[0].resolve('A');
  await a;
  await new Promise(setImmediate);
  assert.equal(done, false, 'one prompt still open');
  asks[1].reject(new Error('declined'));
  await assert.rejects(b);
  await settled;
  assert.equal(done, true);
});

test('account reports: keep the owner, wait out an open prompt, or drop on a real switch or disconnect', () => {
  const v = (owner, addresses, promptOpen) => P.accountsVerdict({ owner, addresses, promptOpen });
  assert.equal(v('A', ['A'], false), 'keep');
  assert.equal(v('A', ['B', 'A'], true), 'keep');
  assert.equal(v(null, [], false), 'keep', 'nobody logged in');
  // While the wallet shows a prompt (a sale), nothing is dropped and the page does not reload.
  assert.equal(v('A', [], true), 'defer');
  assert.equal(v('A', ['B'], true), 'defer');
  // Asked again after the prompt (or no prompt at all): the existing behaviour.
  assert.equal(v('A', [], false), 'disconnected');
  assert.equal(v('A', ['B'], false), 'switched');
});

/** A clock the test moves by hand, in place of setTimeout for the prompt cap. */
function fakeTimers() {
  let now = 0;
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at > now) continue;
        pending.delete(id);
        t.fn();
      }
    },
  };
}

/** One prompt counted under `timers`, answered when the test says. */
function openPrompt(timers) {
  const d = deferred();
  const done = P.duringWalletPrompt(() => d.promise, timers);
  return { ...d, done };
}

test('a prompt that never answers stops holding the game after the cap', async () => {
  // Phantom can hang with its popup gone: without a cap every later dive was held and the deferred
  // account check never ran.
  assert.equal(P.PROMPT_HOLD_MS, 3 * 60_000);
  const timers = fakeTimers();
  const hung = openPrompt(timers);
  let settled = false;
  const waiting = P.promptsSettled().then(() => (settled = true));
  timers.advance(P.PROMPT_HOLD_MS - 1);
  await new Promise(setImmediate);
  assert.equal(P.walletPromptOpen(), true, 'still within the cap');
  assert.equal(settled, false);
  timers.advance(1);
  assert.equal(P.walletPromptOpen(), false, 'released at the cap');
  await waiting;
  assert.equal(settled, true, 'the deferred account check may run');

  // The prompt itself is not answered for the player: it settles (or fails) only when the wallet does.
  let outcome = 'pending';
  hung.done.then((v) => (outcome = v));
  await new Promise(setImmediate);
  assert.equal(outcome, 'pending');
  hung.resolve('late');
  assert.equal(await hung.done, 'late');
  assert.equal(P.walletPromptOpen(), false);
});

test('a late answer after the cap does not release a newer prompt', async () => {
  const timers = fakeTimers();
  const old = openPrompt(timers);
  timers.advance(P.PROMPT_HOLD_MS);
  assert.equal(P.walletPromptOpen(), false);
  const fresh = openPrompt(timers);
  assert.equal(P.walletPromptOpen(), true);
  old.reject(new Error('gave up'));
  await assert.rejects(old.done, /gave up/);
  assert.equal(P.walletPromptOpen(), true, 'the old prompt was already let go: the new one still counts');
  let settled = false;
  const waiting = P.promptsSettled().then(() => (settled = true));
  await new Promise(setImmediate);
  assert.equal(settled, false);
  fresh.resolve('ok');
  await fresh.done;
  assert.equal(P.walletPromptOpen(), false);
  await waiting;
  // A prompt after all that is counted from zero again (no underflow).
  const again = openPrompt(timers);
  assert.equal(P.walletPromptOpen(), true);
  again.resolve('ok');
  await again.done;
  assert.equal(P.walletPromptOpen(), false);
});

test('a prompt answered in time leaves no cap timer behind', async () => {
  const timers = fakeTimers();
  const sale = openPrompt(timers);
  assert.equal(timers.pending.size, 1);
  sale.resolve('signed');
  await sale.done;
  assert.equal(timers.pending.size, 0);
  timers.advance(P.PROMPT_HOLD_MS);
  assert.equal(P.walletPromptOpen(), false);
});

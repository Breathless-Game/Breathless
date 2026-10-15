import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The wallet hold (main.ts syncWalletHold) shares the one `paused` flag with the field guide, the
// skin picker, the shipyard and the pause menu. A hold released while the player was aboard or
// under the field guide used to leave `paused` true with nobody to clear it: back in the water the
// dive never ran again. main.ts can't load in node, so its facts are checked as source text and the
// sequence is replayed on a model of the same state with the real wallet-prompt.ts.
const source = await readFile(new URL('../src/wallet-prompt.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const P = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

/** The body of a top-level `function name(` in main.ts. */
const fnBody = (name) => {
  const at = main.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  return main.slice(at, main.indexOf('\n}\n', at));
};

test('the wallet hold only lifts the pause it set, and leaving the dive drops it', () => {
  const drop = fnBody('dropWalletHold');
  assert.match(drop, /if \(!heldForWallet\) return;/, 'not held: any pause is somebody else’s');
  assert.match(drop, /heldForWallet = false;[\s\S]*paused = false;/);
  // Going aboard (Esc, F, a hidden tab) and every way back to the title (MAIN MENU, log out, a bite).
  assert.match(fnBody('climbAboard'), /dropWalletHold\(\);/);
  assert.match(fnBody('goToMenu'), /dropWalletHold\(\);/);
  // Esc reaches climbAboard even while paused: it is handled before the paused gate.
  const kd = main.slice(main.indexOf("window.addEventListener('keydown', (e) => {"));
  assert.ok(kd.indexOf("e.key === 'Escape'") < kd.indexOf('if (paused) return;'));
});

test('the field guide does not open over a wallet hold', () => {
  const canOpen = main.match(/fieldGuide = new FieldGuide\(\{\s*(?:\/\/[^\n]*\n\s*)*canOpen: \(\) => ([^\n]*),\n/);
  assert.ok(canOpen, 'field guide canOpen');
  assert.match(canOpen[1], /!heldForWallet/);
});

/** main.ts's state for the hold, as fixed: syncWalletHold, climbAboard, backToWater, goToMenu, the guide. */
function game() {
  const g = { phase: 'play', paused: false, held: false, guide: false, guideWasPaused: false, updates: 0 };
  const dropWalletHold = () => {
    if (!g.held) return;
    g.held = false;
    g.paused = false;
  };
  g.frame = () => {
    const promptOpen = P.walletPromptOpen();
    if (P.shouldHold({ playing: g.phase === 'play', paused: g.paused, held: g.held, promptOpen })) {
      g.paused = true;
      g.held = true;
      return;
    }
    if (P.shouldResume({ held: g.held, hidden: false, promptOpen })) {
      g.held = false;
      if (g.phase === 'play') g.paused = false;
    }
    if (!g.paused) g.updates++;
  };
  g.climbAboard = () => (dropWalletHold(), (g.phase = 'menu'));
  g.backToWater = () => (g.phase = 'play');
  g.goToMenu = () => (dropWalletHold(), (g.paused = false), (g.phase = 'menu'));
  g.toggleGuide = () => {
    if (!g.guide && g.held) return; // canOpen
    g.guide = !g.guide;
    if (g.guide) {
      g.guideWasPaused = g.paused;
      g.paused = true;
    } else g.paused = g.guideWasPaused;
  };
  return g;
}

function prompt() {
  let answer;
  const done = P.duringWalletPrompt(() => new Promise((r) => (answer = r)));
  return { answer: async () => (answer('signed'), await done) };
}

test('Esc aboard while a sale prompt is open: back in the water the dive runs', async () => {
  const g = game();
  const sale = prompt();
  g.frame();
  assert.deepEqual({ paused: g.paused, held: g.held }, { paused: true, held: true });
  g.climbAboard(); // Esc closes the Collection, Esc again: aboard
  assert.deepEqual({ paused: g.paused, held: g.held }, { paused: false, held: false }, 'the boat is not held');
  await sale.answer(); // approve in Phantom
  g.frame();
  g.backToWater();
  g.frame();
  assert.equal(g.paused, false);
  assert.ok(g.updates > 0, 'update() runs again');
});

test('back in the water before the wallet answered: held again, then carries on', async () => {
  const g = game();
  const sale = prompt();
  g.frame();
  g.climbAboard();
  g.backToWater();
  g.frame();
  assert.deepEqual({ paused: g.paused, held: g.held }, { paused: true, held: true }, 're-held on the next frame');
  await sale.answer();
  g.frame();
  assert.deepEqual({ paused: g.paused, held: g.held }, { paused: false, held: false });
  assert.ok(g.updates > 0);
});

test('B while held does nothing; the guide opened before a prompt keeps the dive paused until it closes', async () => {
  const g = game();
  const sale = prompt();
  g.frame();
  g.toggleGuide();
  assert.equal(g.guide, false, 'no guide over the hold');
  await sale.answer();
  g.frame();
  assert.equal(g.paused, false);

  // The guide first, then a prompt (a sale can't start from under the guide, but say one did).
  g.toggleGuide();
  const late = prompt();
  g.frame();
  assert.equal(g.held, false, 'the guide has the pause');
  await late.answer();
  g.frame();
  assert.equal(g.paused, true, 'still under the guide');
  g.toggleGuide();
  g.frame();
  assert.equal(g.paused, false);
});

test('MAIN MENU during a hold, then a new dive while the old prompt is still open: the new dive is held', async () => {
  const g = game();
  const sale = prompt();
  g.frame();
  g.goToMenu();
  assert.equal(g.held, false, 'the trip is over: no hold left behind');
  g.phase = 'play'; // a fresh dive from the chart
  g.frame();
  assert.deepEqual({ paused: g.paused, held: g.held }, { paused: true, held: true });
  await sale.answer();
  g.frame();
  assert.deepEqual({ paused: g.paused, held: g.held }, { paused: false, held: false });
});

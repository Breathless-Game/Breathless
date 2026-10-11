import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/aquarium.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('manage fish: header button with C hint and localized labels', () => {
  assert.match(html, /<button id="aq-manage"[^>]*data-zh-aria-label="管理鱼"[\s\S]*?Manage fish[\s\S]*?<kbd>C<\/kbd>/);
});

test('manage fish: button and C key call the openCollection hook', () => {
  assert.match(src, /openCollection\(\): void/);
  assert.match(src, /\$\('aq-manage'\)\.addEventListener\('click', \(\) => this\.manageFish\(\)\)/);
  assert.match(src, /this\.hooks\.openCollection\(\)/);
  assert.match(src, /this\.manageFish\(\)/);
});

test('manage fish: aquarium sleeps while Collection is open, refreshes after', () => {
  assert.match(src, /this\.root\.inert = true/);
  assert.match(src, /this\.refreshFromBank\(\)/);
  assert.match(css, /#collection\.over-aquarium\s*\{\s*z-index:\s*33/);
});

test('manage fish: main wires the hook; Esc closes Collection before aquarium', () => {
  assert.match(main, /openCollection\(\) \{\s*vault\.toggle\(true\)/);
  assert.ok(main.indexOf('else if (vault.open) vault.toggle(false)') < main.indexOf('else if (aquarium.open) aquarium.close()'));
});

test('manage fish: C closes the Collection over the tank, handled once in the aquarium (no reopen race)', () => {
  assert.match(src, /closeCollection\(\): void/);
  assert.match(main, /closeCollection\(\) \{\s*vault\.toggle\(false\)/);
  // The keydown handler no longer bails out while the Collection is open: it closes it instead.
  assert.doesNotMatch(src, /if \(!this\.open \|\| this\.collectionOpen\(\)\) return;/);
  const handler = src.slice(src.indexOf("window.addEventListener('keydown'"));
  const closeAt = handler.indexOf('this.hooks.closeCollection()');
  const openAt = handler.indexOf('this.manageFish()');
  assert.ok(closeAt > 0 && openAt > closeAt, 'close branch comes first');
  // The close branch returns before the open branch can run for the same event.
  assert.match(handler.slice(closeAt, openAt), /return;/);
  // Key repeat is ignored for both open and close; typing fields are ignored.
  assert.match(handler, /if \(!e\.repeat\) this\.hooks\.closeCollection\(\)/);
  assert.match(handler, /if \(!e\.repeat\) this\.manageFish\(\)/);
  assert.match(handler, /tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'/);
  // main.ts's own C handler only runs during play, so it never double-handles this key.
  assert.ok(main.indexOf("if (phase !== 'play') return;") < main.indexOf("e.key.toLowerCase() === 'c') {\n    vault.toggle();"));
});

test('title screen: aquarium fish is labelled 鱼缸, not 图鉴', () => {
  assert.match(main, /\[1, 'AQUARIUM', '鱼缸'\]/);
  assert.doesNotMatch(main, /'AQUARIUM', '图鉴'/);
});

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

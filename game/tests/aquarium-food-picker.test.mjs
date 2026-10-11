import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Static guards: the fish-food picker is a custom listbox, not the macOS native select.
const src = readFileSync(new URL('../src/aquarium.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('food picker: no native select remains', () => {
  assert.doesNotMatch(html, /<select[^>]*id="aq-food-select"/);
  assert.doesNotMatch(src, /feederSelect|aq-food-select/);
});

test('food picker: markup exposes combobox-style a11y', () => {
  assert.match(html, /id="aq-food-trigger"[^>]*aria-haspopup="listbox"/);
  assert.match(html, /id="aq-food-trigger"[^>]*aria-expanded="false"/);
  assert.match(html, /id="aq-food-list"[^>]*role="listbox"/);
  assert.match(html, /id="aq-food-trigger"[^>]*data-zh-aria-label=/);
});

test('food picker: options are role=option with aria-selected and a short hint', () => {
  assert.match(src, /setAttribute\('role', 'option'\)/);
  assert.match(src, /setAttribute\('aria-selected'/);
  assert.match(src, /classList\.toggle\('short'/);
  assert.match(src, /aria-activedescendant/);
});

test('food picker: re-renders on language and balance changes', () => {
  const lang = src.indexOf('onLangChange(() => {');
  const langBody = src.slice(lang, src.indexOf('});', lang));
  assert.match(langBody, /this\.renderFoodOptions\(\)/);
  assert.match(langBody, /this\.renderFeederText\(\)/);
  assert.match(src, /onPearlBalance\(/);
  const start = src.indexOf('private renderFeederButton(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /this\.renderFoodOptions\(\)/, 'balance re-render refreshes the dimmed options');
});

test('food picker: Esc closes only the picker, not the whole aquarium', () => {
  const start = src.indexOf('private initFoodPicker(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /key === 'Escape'[\s\S]*stopImmediatePropagation\(\)/);
  assert.match(body, /\}, true\);/, 'registered in the capture phase');
  assert.match(body, /pointerdown/, 'outside click closes');
});

test('food picker: closing the aquarium closes the picker', () => {
  const start = src.indexOf('  close(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /setFoodPickerOpen\(false\)/);
});

test('food picker: status text has no stray separator', () => {
  assert.doesNotMatch(src, /\$\{description\} · /);
});

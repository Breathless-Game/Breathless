import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The UI language (src/i18n.ts): one of English / 中文, stored under the key the old
// gear-panel toggle used, defaulting to the browser's language.
const source = await readFile(new URL('../src/i18n.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
let fresh = 0;
/** A new copy of the module (its own state), with these globals in place. */
async function load({ stored = null, navLang = 'en-US' } = {}) {
  const store = new Map(stored === null ? [] : [['deepbreath.language', stored]]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  Object.defineProperty(globalThis, 'navigator', { value: { language: navLang }, configurable: true, writable: true });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(`${outputText}\n// ${fresh++}`).toString('base64')}`);
  return { mod, store };
}

test('the storage key is the one the gear panel already used', async () => {
  const { mod } = await load();
  assert.equal(mod.LANGUAGE_KEY, 'deepbreath.language');
});

test('resolveLang: a stored choice wins, otherwise navigator.language decides', async () => {
  const { mod } = await load();
  assert.equal(mod.resolveLang('en', 'zh-CN'), 'en');
  assert.equal(mod.resolveLang('zh', 'en-US'), 'zh');
  assert.equal(mod.resolveLang(null, 'zh-CN'), 'zh');
  assert.equal(mod.resolveLang(null, 'zh-TW'), 'zh');
  assert.equal(mod.resolveLang(null, 'ZH'), 'zh');
  assert.equal(mod.resolveLang(null, 'en-GB'), 'en');
  assert.equal(mod.resolveLang(null, 'ja'), 'en');
  assert.equal(mod.resolveLang(null, undefined), 'en');
  assert.equal(mod.resolveLang('garbage', 'zh-HK'), 'zh');
});

test('lang() defaults from navigator.language when nothing is stored', async () => {
  assert.equal((await load({ navLang: 'zh-CN' })).mod.lang(), 'zh');
  assert.equal((await load({ navLang: 'fr-FR' })).mod.lang(), 'en');
  assert.equal((await load({ stored: 'en', navLang: 'zh-CN' })).mod.lang(), 'en');
  assert.equal((await load({ stored: 'zh', navLang: 'en-US' })).mod.lang(), 'zh');
});

test('setLang stores the choice, switches t() and pickName(), and notifies listeners', async () => {
  const { mod, store } = await load({ navLang: 'en-US' });
  assert.equal(mod.t('Dive', '下潜'), 'Dive');
  assert.equal(mod.pickName({ name: 'Clownfish', nameZh: '小丑鱼' }), 'Clownfish');
  const seen = [];
  const off = mod.onLangChange((l) => seen.push(l));
  mod.setLang('zh');
  assert.equal(store.get('deepbreath.language'), 'zh');
  assert.equal(mod.lang(), 'zh');
  assert.equal(mod.t('Dive', '下潜'), '下潜');
  assert.equal(mod.pickName({ name: 'Clownfish', nameZh: '小丑鱼' }), '小丑鱼');
  assert.equal(mod.pickName({ name: 'Kelp' }), 'Kelp');
  mod.setLang('zh'); // no change, no call
  mod.setLang('en');
  assert.deepEqual(seen, ['zh', 'en']);
  off();
  mod.setLang('zh');
  assert.deepEqual(seen, ['zh', 'en']);
});

test('a throwing listener does not stop the others', async () => {
  const { mod } = await load();
  const seen = [];
  const err = console.error;
  console.error = () => {};
  mod.onLangChange(() => {
    throw new Error('boom');
  });
  mod.onLangChange((l) => seen.push(l));
  mod.setLang('zh');
  console.error = err;
  assert.deepEqual(seen, ['zh']);
});

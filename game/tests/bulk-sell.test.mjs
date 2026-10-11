import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const WALLET_STUB = `data:text/javascript;base64,${Buffer.from("export const storageKey = (name) => 'deepbreath.' + name;").toString('base64')}`;

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const code = outputText.replace(/from ['"]\.\/wallet['"]/g, `from '${WALLET_STUB}'`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const { bulkSelectBlock, bulkSelectable, pruneSelection, selectionSummary, selectionRange, needsConfirm } = await load('../src/market.ts');
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

let seq = 0;
const fish = (rarity = 'common', extra = {}) => ({ id: `b${++seq}`, rarity, name: `${rarity} fish`, depthM: 5, nft: 'minted', ...extra });
const value = (f) => ({ common: 2, uncommon: 6, rare: 20, epic: 70, legendary: 300, mythic: 1600 })[f.rarity];

test('eligibility matches the per-card Sell button', () => {
  assert.equal(bulkSelectable(fish()), true);
  assert.equal(bulkSelectable(fish('common', { nft: 'pending' })), true, 'unminted fish are minted first');
  assert.equal(bulkSelectBlock(fish('common', { legacy: true })), 'paid-out');
  assert.equal(bulkSelectBlock(fish('common', { sellBlock: 'flagged' })), 'blocked');
  assert.equal(bulkSelectBlock(fish('common', { nft: 'minting' })), 'minting');
  assert.equal(bulkSelectBlock(fish('common', { sellQueued: true })), 'queued');
  const f = fish();
  assert.equal(bulkSelectBlock(f, new Set([f])), 'queued', 'a fish being sold right now');
});

test('pruneSelection drops fish that left the bank or became ineligible, keeps bank order', () => {
  const a = fish();
  const b = fish();
  const c = fish();
  const gone = fish();
  const bank = [a, b, c];
  b.sellQueued = true;
  const kept = pruneSelection(new Set([c, b, gone, a]), bank);
  assert.deepEqual([...kept], [a, c]);
});

test('selectionSummary totals the value and flags epic or rarer', () => {
  const plain = selectionSummary([fish('common'), fish('rare')], value);
  assert.deepEqual(plain, { count: 2, total: 22, needsConfirm: false });
  const big = selectionSummary([fish('common'), fish('epic')], value);
  assert.equal(big.needsConfirm, true);
  assert.equal(big.total, 72);
  assert.equal(selectionSummary([], value).needsConfirm, false);
  assert.equal(needsConfirm('rare'), false);
  assert.equal(needsConfirm('mythic'), true);
});

test('selectionRange covers the span in either direction and skips ineligible items', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  const ok = (x) => x !== 'c';
  assert.deepEqual(selectionRange(order, 'a', 'd', ok), ['a', 'b', 'd']);
  assert.deepEqual(selectionRange(order, 'e', 'b', ok), ['b', 'd', 'e']);
  assert.deepEqual(selectionRange(order, 'zz', 'b', ok), ['b']);
});

test('vault wires the bulk-sell controls with real checkboxes and bilingual labels', async () => {
  const src = await read('../src/vault.ts');
  assert.match(src, /type = 'checkbox'/);
  assert.match(src, /setAttribute\('aria-label', t\(`Select \$\{f\.name\} to sell`/);
  assert.match(src, /this\.queue\.sellMany\(list\)/);
  for (const [en, zh] of [['Select all sellable', '全选可出售'], ['Clear', '清除'], ['Select fish to sell', '勾选要出售的鱼']]) {
    assert.ok(src.includes(`'${en}', '${zh}'`), en);
  }
  assert.ok(src.includes('Sell selected (${sum.count})') && src.includes('出售所选 (${sum.count})'));
  assert.match(src, /parts\.push\(this\.selectionBar\(\)\)/, 'selection toolbar space is always reserved');
  assert.match(src, /e\.stopPropagation\(\)/, 'a tick never reaches the card');
});

test('confirms reuse the action slot instead of adding a row', async () => {
  const src = await read('../src/vault.ts');
  assert.match(src, /cancel-x/);
  assert.match(src, /el\('span', 'sell-confirm'/);
  assert.match(src, /el\('div', 'card-note/);
  assert.match(src, /tabIndex = 0/);
});

test('collection layout is fixed: panel, grid, cards, rows and wallet cards', async () => {
  const css = await read('../src/style.css');
  const rule = (sel) => {
    const i = css.indexOf(`${sel} {`);
    assert.ok(i >= 0, `missing ${sel}`);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.match(rule('#collection'), /height: min\(/);
  assert.match(rule('#collection'), /width: min\(/);
  assert.match(rule('#collection'), /overflow: hidden/);
  assert.match(rule('#collection-grid'), /scrollbar-gutter: stable/);
  assert.match(rule('#collection-grid'), /overflow-y: auto/);
  assert.match(rule('#collection-grid figure'), /height: \d+px/);
  assert.match(rule('.card-actions'), /height: \d+px/);
  assert.match(rule('.card-note'), /height: \d+px/);
  assert.match(rule('.wallet-card'), /height: \d+px/);
  assert.match(rule('#collection-notice'), /height: \d+px/);
  assert.match(rule('#market-bar'), /height: \d+px/);
  assert.doesNotMatch(css, /#collection-notice:empty/, 'an empty notice still keeps its height');
});

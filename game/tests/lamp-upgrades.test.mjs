import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function moduleUrl(file, imports = {}) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [specifier, url] of Object.entries(imports)) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const lighting = await moduleUrl('lamp-lighting');
const { lampPath, lampUpgradeSteps, lampEffect } = await import(await moduleUrl('lamp-upgrades', { './lamp-lighting': lighting }));

test('headlamp progression quotes live prices and never makes a skipped tier purchasable', () => {
  const prices = Object.freeze([0, 125, 650]);
  const starter = lampUpgradeSteps(1, 1000, prices, 'focus');
  assert.deepEqual(starter.map(step => step.status), ['owned', 'next', 'locked']);
  assert.deepEqual(starter.map(step => step.affordable), [false, true, false]);
  const next = lampUpgradeSteps(2, 600, prices, 'wideLamp')[2];
  assert.equal(next.price, 650);
  assert.equal(next.shortfall, 50);
  assert.equal(next.affordable, false);
  assert.ok(lampUpgradeSteps(3, 9999, prices, 'wideLamp').every(step => !step.affordable));
});

test('missing quotes and non-finite balances cannot enable a headlamp upgrade', () => {
  assert.equal(lampUpgradeSteps(1, 999, [0], 'focus')[1].price, null);
  assert.equal(lampUpgradeSteps(1, 999, [0], 'focus')[1].affordable, false);
  assert.equal(lampUpgradeSteps(NaN, Infinity, [0, 100, 500], 'focus')[1].affordable, false);
});

test('starter optics are shared while wide tiers exchange range for greater coverage', () => {
  assert.equal(lampPath(1, 'wideLamp'), 'focus');
  assert.equal(lampPath(2, 'wideLamp'), 'wideLamp');
  assert.equal(lampPath(3, 'unknown'), 'focus');
  const focus = lampUpgradeSteps(1, 0, [0, 100, 500], 'focus');
  const wide = lampUpgradeSteps(1, 0, [0, 100, 500], 'wideLamp');
  assert.deepEqual(focus[0].optics, wide[0].optics);
  for (const index of [1, 2]) {
    assert.ok(focus[index].optics.distance > wide[index].optics.distance);
    assert.ok(wide[index].coverage > focus[index].coverage);
  }
  assert.match(lampEffect(3, 'wideLamp', false), /32 m.*74 cd.*143°/);
  assert.match(lampEffect(3, 'focus', true), /48 m.*102 cd.*49°/);
});

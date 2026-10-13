import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/touch-only.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source.replace("import { t } from './i18n';", 'const t = (a) => a;'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { isTouchOnly } = await import(`data:text/javascript,${encodeURIComponent(outputText)}`);

const mm = (coarse, anyFine) => (q) => ({
  matches: q === '(pointer: coarse)' ? coarse : q === '(any-pointer: fine)' ? anyFine : false,
});

test('phone: coarse primary pointer, no fine pointer', () => assert.equal(isTouchOnly(mm(true, false)), true));
test('touchscreen laptop with a trackpad is not touch-only', () => assert.equal(isTouchOnly(mm(true, true)), false));
test('desktop mouse is not touch-only', () => assert.equal(isTouchOnly(mm(false, true)), false));
test('throwing matchMedia is treated as not touch-only', () =>
  assert.equal(isTouchOnly(() => { throw new Error('x'); }), false));

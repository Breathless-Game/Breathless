import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The zh and en field-guide chapter tables must stay in lockstep: a length mismatch once
// crashed renderChrome (undefined chapter) and left English browsers on the loading screen.
const source = await readFile(new URL('../src/field-guide.ts', import.meta.url), 'utf8');
const start = source.indexOf('export const CHAPTERS:');
const end = source.indexOf('/** Current-language chapters');
assert.ok(start >= 0 && end > start, 'chapter tables not found');
const body = source.slice(start, end).replaceAll('export const', 'const');
const js = ts.transpileModule(`${body}\nglobalThis.__guide = { CHAPTERS, CHAPTERS_EN };`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function(js)();
const { CHAPTERS, CHAPTERS_EN } = globalThis.__guide;

test('zh and en chapter tables have the same length and id order', () => {
  assert.equal(CHAPTERS_EN.length, CHAPTERS.length);
  assert.deepEqual(CHAPTERS_EN.map(c => c.id), CHAPTERS.map(c => c.id));
  assert.equal(new Set(CHAPTERS.map(c => c.id)).size, CHAPTERS.length);
});

test('paired chapters share art and have sequential subtitles', () => {
  CHAPTERS.forEach((c, i) => {
    assert.equal(CHAPTERS_EN[i].art, c.art, c.id);
    const n = String(i + 1).padStart(2, '0');
    assert.ok(c.subtitle.startsWith(`${n} /`), `zh ${c.id} subtitle ${c.subtitle}`);
    assert.ok(CHAPTERS_EN[i].subtitle.startsWith(`${n} /`), `en ${c.id} subtitle ${CHAPTERS_EN[i].subtitle}`);
  });
});

test('every chapter text field is non-empty in both languages', () => {
  for (const [name, list] of [['zh', CHAPTERS], ['en', CHAPTERS_EN]]) {
    for (const c of list) {
      for (const k of ['tab', 'title', 'subtitle', 'caption', 'note']) assert.ok(c[k].trim(), `${name} ${c.id}.${k}`);
      assert.ok(c.steps.length > 0, `${name} ${c.id} steps`);
      for (const [h, b] of c.steps) assert.ok(h.trim() && b.trim(), `${name} ${c.id} step`);
    }
  }
  CHAPTERS.forEach((c, i) => assert.equal(CHAPTERS_EN[i].steps.length, c.steps.length, `${c.id} step count`));
});

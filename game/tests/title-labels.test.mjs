import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('title: every TITLE_LABELS index refers to an existing title fish', () => {
  const ctor = src.slice(src.indexOf('new TitleScreen('));
  const fishList = ctor.slice(0, ctor.indexOf('\n]);'));
  const fish = (fishList.match(/^\s*\{ seed:/gm) ?? []).length;
  assert.ok(fish > 0, 'found the title fish');
  const block = src.match(/const TITLE_LABELS[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(block, 'TITLE_LABELS exists');
  const indexes = [...block[1].matchAll(/\[(\d+),/g)].map((m) => Number(m[1]));
  assert.ok(indexes.length > 0);
  for (const i of indexes) assert.ok(i < fish, `label index ${i} must be < ${fish} title fish`);
});

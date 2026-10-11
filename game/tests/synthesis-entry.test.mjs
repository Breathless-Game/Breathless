import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/workbench.ts', import.meta.url), 'utf8');

/** Body of `private name() { ... }` up to the next method at the same indent. */
function body(name) {
  const start = src.indexOf(`private ${name}(`);
  assert.ok(start >= 0, `${name}() exists`);
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, `${name}() has a body`);
  return src.slice(start, end);
}

test('synthesis case opens the real synthesis panel', () => {
  assert.match(body('openSynthesis'), /hooks\.synthesisOpen\?*\.?\(/);
});

test('synthesis case closes the real synthesis panel', () => {
  assert.match(body('closeSynthesis'), /hooks\.synthesisClose\?*\.?\(/);
});

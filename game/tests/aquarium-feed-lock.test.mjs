import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Aquarium needs a DOM and three.js, so this guards the ordering in feed() at the source level.
const src = readFileSync(new URL('../src/aquarium.ts', import.meta.url), 'utf8');

test('aquarium: Feed is not rendered locked after a paid feed', () => {
  // pick() renders the Feed button disabled while a payment is in flight...
  assert.match(src, /feed\.disabled = !affordable \|\| this\.feeding;/);
  const start = src.indexOf('private async feed(');
  assert.ok(start > 0, 'feed() exists');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const repick = body.indexOf('this.pick(swimmer)');
  assert.ok(repick > 0, 'the success path re-renders the card');
  // ...so the lock must be cleared before the success path re-renders the card (nothing re-renders it later).
  const unlock = body.lastIndexOf('this.feeding = false', repick);
  const lock = body.indexOf('this.feeding = true');
  assert.ok(lock > 0 && unlock > lock, 'feeding is cleared before the success-path pick(swimmer)');
});

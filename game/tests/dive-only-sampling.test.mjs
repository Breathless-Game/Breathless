import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const body = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return src.slice(start, src.indexOf('\n}\n', start));
};

test('auto render quality samples only frames of a running, visible dive', () => {
  // Title, workbench and aquarium run their own renderers: a slow frame there must not
  // drop (and remember for 7 days) the dive's quality tier.
  const calls = [...src.matchAll(/renderQuality\.observeFrame\(elapsed, ([^)]*)\)/g)];
  assert.equal(calls.length, 1);
  const visible = calls[0][1];
  assert.match(visible, /phase === 'play'/);
  assert.match(visible, /!paused/);
  assert.match(visible, /!document\.hidden/);
});

test('fish spawned for an opened map edge are removed when the bounds shrink back', () => {
  // Otherwise every dive that reaches the edge adds another strip of fish for good.
  assert.match(body('extendFishCoverage'), /edgeFish\.add\(/);
  const reset = body('resetWorldBounds');
  assert.match(reset, /for \(const f of \[\.\.\.edgeFish\]\) removeFish\(f\)/);
  assert.ok(reset.indexOf('edgeFish') < reset.indexOf('fishCoverageLeft ='), 'remove before resetting coverage');
  // removeFish splices by indexOf: a stale edge fish would remove an unrelated one.
  assert.match(body('removeFish'), /edgeFish\.delete\(fish\)/);
  const populate = body('populate');
  assert.match(populate, /fishCoverageLeft = worldBounds\.left/);
  assert.match(populate, /fishCoverageRight = worldBounds\.right/);
});

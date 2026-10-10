import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Pure module (type-only imports); transpile it in memory like render-quality.
const source = await readFile(new URL('../src/depth-odds.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { RARITY_BY_DEPTH, rarityOdds, zoneName } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

const ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const EPS = 1e-9;

function weights(depth) {
  const odds = new Map(rarityOdds(depth));
  return ORDER.map((r) => odds.get(r) ?? 0);
}

function probs(depth) {
  const w = weights(depth);
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
}

test('anchors are sorted, sum to 100, and are returned exactly at their depths', () => {
  for (let i = 0; i < RARITY_BY_DEPTH.length; i++) {
    const [depth, row] = RARITY_BY_DEPTH[i];
    if (i > 0) assert.ok(depth > RARITY_BY_DEPTH[i - 1][0]);
    assert.equal(row.length, 6);
    assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 100) < EPS);
    assert.deepEqual(weights(depth), row);
  }
});

test('odds are ordered common..mythic with positive weights and a positive total everywhere', () => {
  for (const depth of [-10, 0, 0.5, 7, 15, 22.2, 30, 49.9, 50, 65, 80, 100, 120, 199, 200, 350, 1000, 1e6, Infinity, NaN]) {
    const odds = rarityOdds(depth);
    assert.ok(odds.length > 0);
    assert.ok(odds.every(([, w]) => w > 0), `no zero or negative weights at ${depth} m`);
    const idx = odds.map(([r]) => ORDER.indexOf(r));
    assert.ok(idx.every((k, i) => k >= 0 && (i === 0 || k > idx[i - 1])), `order at ${depth} m`);
    assert.ok(weights(depth).reduce((a, b) => a + b, 0) > 0);
  }
});

test('P(rarity >= k) never decreases with depth, for every k', () => {
  let prev = probs(0);
  for (let depth = 1; depth <= 500; depth++) {
    const p = probs(depth);
    for (let k = 1; k < ORDER.length; k++) {
      const tail = p.slice(k).reduce((a, b) => a + b, 0);
      const prevTail = prev.slice(k).reduce((a, b) => a + b, 0);
      assert.ok(tail >= prevTail - EPS, `P(>= ${ORDER[k]}) dropped at ${depth} m`);
    }
    prev = p;
  }
});

test('epic, legendary and mythic are gated behind 15, 30 and 50 m', () => {
  for (let depth = -5; depth <= 60; depth += 0.25) {
    const [, , , epic, legendary, mythic] = weights(depth);
    if (depth <= 15) assert.equal(epic, 0, `epic at ${depth} m`);
    else assert.ok(epic > 0, `epic missing at ${depth} m`);
    if (depth <= 30) assert.equal(legendary, 0, `legendary at ${depth} m`);
    else assert.ok(legendary > 0, `legendary missing at ${depth} m`);
    if (depth <= 50) assert.equal(mythic, 0, `mythic at ${depth} m`);
    else assert.ok(mythic > 0, `mythic missing at ${depth} m`);
  }
});

test('odds stay at the deepest anchor beyond it and clamp to the surface above 0', () => {
  const [lastDepth, lastRow] = RARITY_BY_DEPTH[RARITY_BY_DEPTH.length - 1];
  assert.equal(lastDepth, 350);
  for (const depth of [350, 351, 500, 2000, Infinity]) assert.deepEqual(weights(depth), lastRow);
  assert.deepEqual(weights(-20), weights(0));
});

test('weights interpolate linearly between anchors', () => {
  const w50 = weights(50);
  const w80 = weights(80);
  const w65 = weights(65);
  for (let k = 0; k < ORDER.length; k++) {
    assert.ok(Math.abs(w65[k] - (w50[k] + w80[k]) / 2) < EPS, `${ORDER[k]} at 65 m`);
  }
  assert.ok(Math.abs(weights(275)[5] - 2.25) < EPS);
});

test('zone names follow the depth bands, with no bottom below the Trench', () => {
  assert.equal(zoneName(0), 'Shallows');
  assert.equal(zoneName(17.9), 'Shallows');
  assert.equal(zoneName(18), 'Coral Reef');
  assert.equal(zoneName(37.9), 'Coral Reef');
  assert.equal(zoneName(38), 'The Abyss');
  assert.equal(zoneName(59.9), 'The Abyss');
  assert.equal(zoneName(60), 'The Trench');
  assert.equal(zoneName(5000), 'The Trench');
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

async function moduleUrl(file, imports = {}) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [name, url] of Object.entries({ three: import.meta.resolve('three'), ...imports })) {
    outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url));
  }
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const { Rng } = await import(await moduleUrl('rng'));
const lowpoly = await moduleUrl('lowpoly', {
  'three/examples/jsm/utils/BufferGeometryUtils.js': import.meta.resolve('three/examples/jsm/utils/BufferGeometryUtils.js'),
});
const { rockGeometry, mossCoverage, paintRock } = await import(await moduleUrl('rock-surface', { './lowpoly': lowpoly }));

test('rock geometry matches placement bounds after jitter and rotation, without torn facets', () => {
  for (const detail of [0, 1]) for (let seed = 1; seed <= 30; seed++) {
    const r = 0.2 + seed * 0.27, squash = 0.45 + seed * 0.01;
    const geo = rockGeometry(new Rng(seed), r, detail, squash);
    for (const axis of ['x', 'y', 'z']) {
      const half = axis === 'y' ? r * squash : r;
      assert.ok(Math.abs(geo.boundingBox.min[axis] + half) < 1e-5);
      assert.ok(Math.abs(geo.boundingBox.max[axis] - half) < 1e-5);
    }
    const p = geo.attributes.position;
    const edges = new Map();
    const point = i => [p.getX(i), p.getY(i), p.getZ(i)].map(v => v.toFixed(5)).join(',');
    for (let i = 0; i < p.count; i += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const key = [point(i + a), point(i + b)].sort().join('|');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    for (const count of edges.values()) assert.equal(count, 2, 'every edge belongs to two faces');
    geo.dispose();
  }
});

test('moss fades with depth and only coats upper, upward-facing facets in coherent patches', () => {
  let patches = 0, bare = 0;
  for (let x = -20; x <= 20; x += 0.25) {
    const shallow = mossCoverage(12, 1, 1, x, 1, 17);
    assert.ok(shallow >= 0 && shallow <= 1);
    assert.ok(mossCoverage(45, 1, 1, x, 1, 17) <= shallow);
    assert.equal(mossCoverage(90, 1, 1, x, 1, 17), 0);
    assert.equal(mossCoverage(12, -1, 1, x, 1, 17), 0);
    assert.equal(mossCoverage(12, 1, 0.2, x, 1, 17), 0);
    assert.ok(Math.abs(shallow - mossCoverage(12, 1, 1, x + 1e-5, 1, 17)) < 1e-4);
    if (shallow > 0.5) patches++;
    if (shallow < 0.05) bare++;
  }
  assert.ok(patches > 10 && bare > 10, 'separate patches and exposed stone');
});

test('rock colours are deterministic, finite and shared across each facet', () => {
  const geo = rockGeometry(new Rng(8), 5, 1, 0.7);
  const base = new THREE.Color('#5b6b78'), moss = new THREE.Color('#486d47');
  const origin = { x: 7, y: -30, z: -15 };
  paintRock(geo, base, moss, origin, 8);
  const initial = geo.attributes.color.array.slice();
  assert.equal(initial.length, geo.attributes.position.count * 3);
  for (let i = 0; i < initial.length; i += 9) {
    for (const value of initial.subarray(i, i + 9)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    assert.deepEqual(initial.subarray(i, i + 3), initial.subarray(i + 3, i + 6));
    assert.deepEqual(initial.subarray(i, i + 3), initial.subarray(i + 6, i + 9));
  }
  paintRock(geo, base, moss, origin, 8);
  assert.deepEqual(geo.attributes.color.array, initial);
  geo.dispose();
});

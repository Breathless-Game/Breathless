import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function sourceUrl(file, imports = {}) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [name, url] of Object.entries(imports)) outputText = outputText.replace(`from '${name}'`, `from '${url}'`);
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}

const { Rng } = await import(await sourceUrl('../src/rng.ts'));
const { rockGeometry } = await import(await sourceUrl('../src/rock-geometry.ts', { three: import.meta.resolve('three') }));

for (const detail of [0, 1]) {
  test(`rock detail ${detail} forms closed outward-facing solids with valid bounds`, () => {
    for (let seed = 1; seed <= 48; seed++) {
      const radius = 0.3 + seed * 0.2;
      const geometry = rockGeometry(new Rng(seed), radius, detail, 0.55 + seed % 7 * 0.1);
      const p = geometry.attributes.position;
      const edges = new Map();
      let volume = 0;
      assert.ok(p.count / 3 >= 20 && p.count / 3 <= (detail ? 140 : 60), 'bounded static geometry budget');
      const point = i => [p.getX(i), p.getY(i), p.getZ(i)];
      const key = v => v.join(',');
      for (let i = 0; i < p.count; i += 3) {
        const points = [point(i), point(i + 1), point(i + 2)];
        const [a, b, c] = points;
        const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
        const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const area2 = Math.hypot(...normal);
        assert.ok(area2 > radius * radius * 1e-9, 'no collapsed triangles');
        assert.ok(a.reduce((dot, v, j) => dot + v * normal[j], 0) > 0, 'face points away from the interior');
        volume += a.reduce((dot, v, j) => dot + v * normal[j], 0) / 6;
        for (let j = 0; j < 3; j++) {
          const left = key(points[j]), right = key(points[(j + 1) % 3]);
          const sorted = [left, right].sort();
          const edge = sorted.join(':');
          const state = edges.get(edge) ?? { count: 0, balance: 0 };
          state.count++;
          state.balance += left === sorted[0] ? 1 : -1;
          edges.set(edge, state);
          const v = points[j];
          for (let axis = 0; axis < 3; axis++) {
            assert.ok(Number.isFinite(v[axis]));
            assert.ok(v[axis] >= geometry.boundingBox.min.getComponent(axis));
            assert.ok(v[axis] <= geometry.boundingBox.max.getComponent(axis));
          }
        }
      }
      for (const edge of edges.values()) {
        assert.equal(edge.count, 2, 'each edge has exactly two neighboring faces, including chip caps');
        assert.equal(edge.balance, 0, 'shared edges have opposite winding');
      }
      assert.ok(volume > radius ** 3 * 0.2 && volume < radius ** 3 * 12, 'sensible nonzero solid volume');
      geometry.dispose();
    }
  });
}

test('rock seeds reproduce shape and bounds, while different seeds change the silhouette', () => {
  const a = rockGeometry(new Rng(724), 3, 1, 0.8);
  const b = rockGeometry(new Rng(724), 3, 1, 0.8);
  const c = rockGeometry(new Rng(725), 3, 1, 0.8);
  assert.deepEqual(a.attributes.position.array, b.attributes.position.array);
  assert.deepEqual(a.boundingBox, b.boundingBox);
  assert.notDeepEqual(a.attributes.position.array, c.attributes.position.array);
  a.dispose(); b.dispose(); c.dispose();
});

test('extra rock detail chips corners without changing the bed or overall proportions', () => {
  for (const seed of [18, 63, 742, 10291]) {
    const coarse = rockGeometry(new Rng(seed), 2, 0, 0.7);
    const fine = rockGeometry(new Rng(seed), 2, 1, 0.7);
    assert.ok(fine.attributes.position.count > coarse.attributes.position.count);
    for (const side of ['min', 'max']) {
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(fine.boundingBox[side].getComponent(axis) - coarse.boundingBox[side].getComponent(axis)) < 0.3,
          'the small chips retain a recognizable coarse silhouette');
      }
    }
    coarse.dispose(); fine.dispose();
  }
});

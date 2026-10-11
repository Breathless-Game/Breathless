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
const rng = await sourceUrl('../src/rng.ts');
const { waterGeometry } = await import(await sourceUrl('../src/water-geometry.ts', {
  three: import.meta.resolve('three'), './rng': rng,
}));
const { RENDER_QUALITY } = await import(await sourceUrl('../src/render-quality.ts'));

for (const [tier, quality] of Object.entries(RENDER_QUALITY)) {
  test(`${tier} water facets form one watertight upward-facing surface within its triangle budget`, () => {
    const geometry = waterGeometry(300, 120, quality.surfaceSegments);
    const p = geometry.attributes.position;
    const facets = geometry.attributes.aWaterFacet;
    const patches = geometry.attributes.aWaterPatch;
    assert.equal(geometry.index, null);
    assert.equal(p.count / 3, quality.surfaceSegments[0] * quality.surfaceSegments[1] * 2);
    const edges = new Map();
    let totalArea = 0;
    for (let i = 0; i < p.count; i += 3) {
      const points = [0, 1, 2].map(j => [p.getX(i + j), p.getZ(i + j)]);
      const [a, b, c] = points;
      const twiceArea = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
      assert.ok(twiceArea > 0, 'no inverted or collapsed triangles after jitter');
      totalArea += twiceArea / 2;
      for (let j = 0; j < 3; j++) {
        const left = points[j], right = points[(j + 1) % 3];
        const keys = [left.join(','), right.join(',')].sort();
        const key = keys.join(':');
        const entry = edges.get(key) ?? { count: 0, balance: 0, points: [left, right] };
        entry.count++;
        entry.balance += left.join(',') === keys[0] ? 1 : -1;
        edges.set(key, entry);
        const index = i + j;
        assert.equal(patches.getX(index) + patches.getY(index) + patches.getZ(index), 1);
        assert.ok(patches.getW(index) >= 0 && patches.getW(index) <= 1);
        for (let component = 0; component < 4; component++) {
          const value = facets.array[index * 4 + component];
          assert.ok(Number.isFinite(value));
          assert.equal(value, facets.array[i * 4 + component], 'face colors must not interpolate into smooth stripes');
        }
      }
    }
    assert.ok(Math.abs(totalArea - 36000) < 0.05, 'facets cover the full water plane');
    for (const { count, balance, points: [a, b] } of edges.values()) {
      const boundary = (Math.abs(a[0]) === 150 && a[0] === b[0]) || (Math.abs(a[1]) === 60 && a[1] === b[1]);
      assert.equal(count, boundary ? 1 : 2, 'only the perimeter may have an open edge');
      if (!boundary) assert.equal(balance, 0, 'neighboring triangles share opposite directed edges');
    }
    const repeated = waterGeometry(300, 120, quality.surfaceSegments);
    for (const key of ['position', 'aWaterFacet', 'aWaterPatch']) assert.deepEqual(repeated.attributes[key].array, geometry.attributes[key].array);
    geometry.dispose();
    repeated.dispose();
  });
}

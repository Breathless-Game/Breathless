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
  test(`${tier} water triangles cover one watertight surface without slivers within their budget`, () => {
    const geometry = waterGeometry(300, 120, quality.surfaceSegments);
    const p = geometry.attributes.position;
    const indices = geometry.index;
    assert.ok(indices, 'neighboring facets must reuse vertex shader work');
    assert.equal(indices.count / 3, quality.surfaceSegments[0] * quality.surfaceSegments[1] * 2);
    assert.equal(p.count, (quality.surfaceSegments[0] + 1) * (quality.surfaceSegments[1] + 1));
    const edges = new Map();
    const visibleAreas = [];
    let totalArea = 0;
    for (let i = 0; i < indices.count; i += 3) {
      const corners = [0, 1, 2].map(j => indices.getX(i + j));
      for (const index of corners) assert.ok(Number.isInteger(index) && index >= 0 && index < p.count);
      const points = corners.map(index => [p.getX(index), p.getZ(index)]);
      const [a, b, c] = points;
      const twiceArea = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
      assert.ok(twiceArea > 0, 'no inverted or collapsed triangles after jitter');
      const squaredEdges = points.reduce((sum, point, j) => {
        const next = points[(j + 1) % 3];
        return sum + (point[0] - next[0]) ** 2 + (point[1] - next[1]) ** 2;
      }, 0);
      const shapeQuality = 2 * Math.sqrt(3) * twiceArea / squaredEdges;
      assert.ok(shapeQuality > 0.45, 'avoid long thin facets that produce needle-shaped highlights');
      totalArea += twiceArea / 2;
      const centerX = (a[0] + b[0] + c[0]) / 3;
      const centerZ = (a[1] + b[1] + c[1]) / 3;
      if (Math.abs(centerX) < 25 && centerZ > 10 && centerZ < 55) visibleAreas.push(twiceArea / 2);
      for (let j = 0; j < 3; j++) {
        const left = points[j], right = points[(j + 1) % 3];
        const keys = [left.join(','), right.join(',')].sort();
        const key = keys.join(':');
        const entry = edges.get(key) ?? { count: 0, balance: 0, points: [left, right] };
        entry.count++;
        entry.balance += left.join(',') === keys[0] ? 1 : -1;
        edges.set(key, entry);
        const index = corners[j];
        assert.equal(p.getY(index), 0);
        assert.ok(Math.abs(p.getX(index)) <= 150 && Math.abs(p.getZ(index)) <= 60);
        assert.ok(Number.isFinite(p.getX(index)) && Number.isFinite(p.getZ(index)));
      }
    }
    assert.ok(Math.abs(totalArea - 36000) < 0.05, 'facets cover the full water plane');
    visibleAreas.sort((a, b) => a - b);
    assert.ok(visibleAreas[Math.floor(visibleAreas.length * 0.9)]
      / visibleAreas[Math.floor(visibleAreas.length * 0.1)] > 1.5,
    'the visible wave field needs a mixture of broad and small facets at every quality');
    for (const { count, balance, points: [a, b] } of edges.values()) {
      const boundary = (Math.abs(a[0]) === 150 && a[0] === b[0]) || (Math.abs(a[1]) === 60 && a[1] === b[1]);
      assert.equal(count, boundary ? 1 : 2, 'only the perimeter may have an open edge');
      if (!boundary) assert.equal(balance, 0, 'neighboring triangles share opposite directed edges');
    }
    const repeated = waterGeometry(300, 120, quality.surfaceSegments);
    assert.deepEqual(repeated.attributes.position.array, geometry.attributes.position.array,
      'rebuilding a quality tier must preserve the surface');
    assert.deepEqual(repeated.index.array, indices.array,
      'rebuilding a quality tier must preserve the triangle connections');
    geometry.dispose();
    repeated.dispose();
  });
}

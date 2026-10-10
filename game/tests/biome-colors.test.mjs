import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

const source = await readFile(new URL('../src/biome-colors.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const code = outputText.replace("from 'three'", `from '${import.meta.resolve('three')}'`);
const { paintBiomeFaces } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const palette = ['#708d99', '#537c85', '#8b9b9e', '#536677'];

function sheet() {
  const indexed = new THREE.PlaneGeometry(20, 20, 5, 5);
  indexed.rotateX(-Math.PI / 2);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  return geometry;
}

test('coplanar seabed triangles retain distinct solid colours without changing their geometry', () => {
  const geometry = sheet();
  const positions = geometry.attributes.position.array.slice();
  const normals = geometry.attributes.normal.array.slice();
  const uv = geometry.attributes.uv.array.slice();
  paintBiomeFaces(geometry, palette, { seed: 31 });
  const colours = geometry.attributes.color.array;
  const unique = new Set();
  for (let i = 0; i < colours.length; i += 9) {
    assert.deepEqual(colours.slice(i, i + 3), colours.slice(i + 3, i + 6));
    assert.deepEqual(colours.slice(i, i + 3), colours.slice(i + 6, i + 9));
    unique.add(colours.slice(i, i + 3).join(','));
  }
  assert.ok(unique.size > 40, 'a flat sheet must still show a broad variety of polygon colours');
  assert.deepEqual(geometry.attributes.position.array, positions);
  assert.deepEqual(geometry.attributes.normal.array, normals);
  assert.deepEqual(geometry.attributes.uv.array, uv);
  geometry.dispose();
});

test('face colours survive rebuilds and triangle reordering, while seed changes produce variants', () => {
  const a = sheet(), b = sheet(), c = sheet();
  paintBiomeFaces(a, palette, { seed: 456 });
  paintBiomeFaces(b, palette, { seed: 456 });
  paintBiomeFaces(c, palette, { seed: 457 });
  assert.deepEqual(a.attributes.color.array, b.attributes.color.array);
  assert.notDeepEqual(a.attributes.color.array, c.attributes.color.array);

  const p = b.attributes.position.array;
  const firstFace = p.slice(0, 9);
  p.copyWithin(0, 9, 18);
  p.set(firstFace, 9);
  paintBiomeFaces(b, palette, { seed: 456 });
  assert.deepEqual(b.attributes.color.array.slice(0, 9), a.attributes.color.array.slice(9, 18));
  assert.deepEqual(b.attributes.color.array.slice(9, 18), a.attributes.color.array.slice(0, 9));
  a.dispose(); b.dispose(); c.dispose();
});

test('depth fades mineral colours progressively while contrast zero removes random patches', () => {
  const geometry = sheet();
  const brightness = depth => {
    paintBiomeFaces(geometry, palette, { depth });
    return geometry.attributes.color.array.reduce((a, b) => a + b, 0);
  };
  const shallow = brightness(10), shelf = brightness(60), trench = brightness(300), abyss = brightness(10000);
  assert.ok(shallow > shelf && shelf > trench && trench > abyss && abyss > 0);
  assert.ok(geometry.attributes.color.array.every(Number.isFinite));
  paintBiomeFaces(geometry, palette, { contrast: 0 });
  const colour = geometry.attributes.color.array;
  for (let i = 0; i < colour.length; i += 3) assert.deepEqual(colour.slice(i, i + 3), colour.slice(0, 3));
  geometry.dispose();
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

async function load(file) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText.replace("from 'three'", `from '${import.meta.resolve('three')}'`)).toString('base64')}`);
}
const { ViewVisibility, PreviewFrameCache, previewSize } = await load('scene-budget');
const { LruCache } = await load('lru-cache');

test('coarse visibility follows both cameras and keeps a margin for animated silhouettes', () => {
  const camera = new THREE.PerspectiveCamera(48, 1.6, 0.1, 400);
  camera.position.set(0, 0, 22); camera.lookAt(0, 0, 0);
  const preview = camera.clone(); preview.position.x = 200; preview.lookAt(200, 0, 0);
  const view = new ViewVisibility(), point = new THREE.Vector3(0, 0, 0);
  view.update(camera);
  assert.equal(view.intersects(point, 1), true);
  assert.equal(view.intersects(point.set(200, 0, 0), 1), false);
  assert.equal(view.intersects(point.set(0, 0, 30), 1), false);
  assert.equal(view.intersects(point.set(17, 0, 0), 0), true, 'padding prevents edge popping');
  assert.equal(view.intersects(point.set(30, 0, 0), 0), false);
  assert.equal(view.intersects(point.set(0, 20, 0), 0), false);
  assert.equal(view.intersects(point, 12), true, 'large models are not culled by their centre alone');
  view.update(camera, preview);
  assert.equal(view.intersects(point.set(200, 0, 0), 1), true);
  view.update(camera);
  assert.equal(view.intersects(point, 1), false, 'closing preview drops its visibility region');
});

test('cached previews cap render frequency and invalidate on resize, quality, reopen and time reset', () => {
  for (const detail of [1, 2, 3]) {
    const cache = new PreviewFrameCache();
    let renders = 0;
    for (let tick = 0; tick < 120; tick++) renders += Number(cache.needsFrame(tick * 1000 / 120, 1920, 1080, detail));
    assert.ok(renders <= [10, 15, 20][detail - 1]);
    assert.ok(renders >= [9, 14, 19][detail - 1]);
    assert.equal(cache.needsFrame(1000, 1920, 1080, detail, true), true);
    assert.equal(cache.needsFrame(1001, 1920, 1080, detail), false);
    assert.equal(cache.needsFrame(1002, 1000, 1080, detail), true);
    assert.equal(cache.needsFrame(1003, 1000, 1080, detail === 1 ? 2 : 1), true);
    cache.invalidate();
    assert.equal(cache.needsFrame(1004, 1000, 1080, detail), true);
    assert.equal(cache.needsFrame(0, 1000, 1080, detail), true);
  }
});

test('preview buffers preserve aspect and bound wide, portrait and tiny displays', () => {
  for (const detail of [1, 2, 3]) for (const [w, h] of [[3840, 2160], [900, 1600], [320, 180]]) {
    const [width, height] = previewSize(w, h, detail);
    assert.ok(width <= [480, 640, 960][detail - 1] && height <= 720);
    assert.ok(width <= w && height <= h);
    assert.ok(Math.abs(width / height - w / h) < 0.01);
  }
});

test('LRU evicts by recent use and byte weight, not just insertion count', () => {
  const cache = new LruCache(3, 10, value => value.length);
  cache.set('a', 'aaa'); cache.set('b', 'bbb'); cache.set('c', 'ccc');
  assert.equal(cache.get('a'), 'aaa');
  cache.set('d', 'ddd');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.size, 3);
  cache.set('e', 'eeeeeee');
  assert.equal(cache.size, 2);
  assert.equal(cache.totalWeight, 10);
  cache.set('e', 'e');
  assert.equal(cache.totalWeight, 4);
  cache.set('huge', 'x'.repeat(11));
  assert.equal(cache.get('huge'), undefined);
  assert.equal(cache.totalWeight, 4);
  cache.clear();
  assert.equal(cache.size, 0); assert.equal(cache.totalWeight, 0);
});

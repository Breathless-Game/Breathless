import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

const source = await readFile(new URL('../src/underwater-haze.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
outputText = outputText.replace("from 'three'", `from '${import.meta.resolve('three')}'`);
const { UnderwaterHaze, hazeFade, underwaterHazeRange, boundaryHaze } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('the fade is bounded, monotonic and meets each endpoint with no abrupt slope', () => {
  assert.equal(hazeFade(-100, 12, 70), 0);
  assert.equal(hazeFade(100, 12, 70), 1);
  assert.equal(hazeFade(41, 12, 70), 0.5);
  let last = 0;
  for (let d = 0; d <= 100; d += 0.1) {
    const fade = hazeFade(d, 12, 70);
    assert.ok(fade >= last - 1e-12 && fade >= 0 && fade <= 1);
    last = fade;
  }
  assert.ok(hazeFade(12.01, 12, 70) < 1e-9);
  assert.ok(1 - hazeFade(69.99, 12, 70) < 1e-9);
});

test('lateral haze is symmetric, leaves the entire playable corridor clear, and hides the mesh edge', () => {
  const { uWaterEdgeStart: start, uWaterEdgeEnd: end } = new UnderwaterHaze().uniforms;
  for (let x = -200; x <= 200; x += 1) assert.equal(boundaryHaze(x, start.value, end.value), 0);
  for (let x = 200; x <= 290; x += 0.5) {
    assert.equal(boundaryHaze(-x, start.value, end.value), boundaryHaze(x, start.value, end.value));
  }
  assert.equal(boundaryHaze(290, start.value, end.value), 1);
  assert.equal(boundaryHaze(264, start.value, end.value), 1);
  assert.ok(boundaryHaze(240, start.value, end.value) > 0.5);
});

test('finite maps do not regain trench visibility below their floors, while the ocean retains readable walls', () => {
  let lastFar = Infinity;
  for (let depth = 0; depth <= 1000; depth += 1) {
    const [near, far] = underwaterHazeRange(depth, 60, false);
    assert.ok(near > 0 && far > near + 30);
    assert.ok(far <= lastFar + 1e-10);
    lastFar = far;
    assert.deepEqual(underwaterHazeRange(depth, 100, false), [near, far], 'floor depth cannot activate a phantom trench');
    if (depth >= 80) assert.ok(underwaterHazeRange(depth, 62, true)[1] >= 54);
  }
  for (const edge of [0, 60, 62, 78, 100, 160]) {
    const before = underwaterHazeRange(edge - 0.001, 62, true);
    const after = underwaterHazeRange(edge + 0.001, 62, true);
    assert.ok(Math.abs(before[1] - after[1]) < 0.01);
  }
});

test('shader binding composes with existing hooks, supports moved/instanced geometry and reuses uniforms', () => {
  const haze = new UnderwaterHaze();
  const material = new THREE.MeshStandardMaterial();
  let calls = 0;
  material.onBeforeCompile = shader => { calls++; shader.uniforms.original = { value: 7 }; };
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), material), new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 2));
  haze.apply(root);
  const compile = material.onBeforeCompile;
  haze.apply(root);
  assert.equal(material.onBeforeCompile, compile, 'shared material is patched once');
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  material.onBeforeCompile(shader, {});
  assert.equal(calls, 1);
  assert.equal(shader.uniforms.original.value, 7);
  assert.equal(shader.uniforms.uWaterHazeFar, haze.uniforms.uWaterHazeFar);
  assert.match(shader.vertexShader, /vWaterHazeView = mvPosition.xyz/);
  assert.match(shader.vertexShader, /hazePosition = instanceMatrix \* hazePosition/);
  assert.match(shader.fragmentShader, /length\(vWaterHazeView\)/);
  assert.match(shader.fragmentShader, /abs\(vWaterHazeWorld.x\)/);
  haze.update(-1, 100, false);
  assert.equal(shader.uniforms.uUnderwaterHaze.value, 0);
  haze.update(1.5, 100, false);
  assert.equal(shader.uniforms.uUnderwaterHaze.value, 0.5);
  haze.update(100, 100, false);
  assert.equal(shader.uniforms.uUnderwaterHaze.value, 1);
  assert.ok(shader.uniforms.uWaterHazeFar.value > 46 && shader.uniforms.uWaterHazeFar.value < 78);
});

test('custom atmospheric shaders and fog-free glow are preserved', () => {
  const custom = new THREE.ShaderMaterial(), glow = new THREE.MeshBasicMaterial({ fog: false });
  const callbacks = [custom.onBeforeCompile, glow.onBeforeCompile];
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), custom), new THREE.Mesh(new THREE.BoxGeometry(), glow));
  new UnderwaterHaze().apply(root);
  assert.equal(custom.onBeforeCompile, callbacks[0]);
  assert.equal(glow.onBeforeCompile, callbacks[1]);
});

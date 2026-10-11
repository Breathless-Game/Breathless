import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// These model builders use Three.js but no DOM/WebGL. Keep the Node 20 workflow.
const require = createRequire(import.meta.url);
const THREE = require('three');
const mergeUtils = await import('three/addons/utils/BufferGeometryUtils.js');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const localRequire = (specifier) => specifier.startsWith('.')
    ? load(path.resolve(path.dirname(file), `${specifier}.ts`))
    : specifier === 'three/addons/utils/BufferGeometryUtils.js' ? mergeUtils : require(specifier);
  new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
  return module.exports;
}
const { UPGRADES, buildUpgradeModel } = load(fileURLToPath(new URL('../src/upgrades.ts', import.meta.url)));

function surfaces(model) {
  const result = new Set();
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) (Array.isArray(object.material) ? object.material : [object.material]).forEach((surface) => result.add(surface));
  });
  return result;
}
function count(model, name) {
  let found = 0;
  model.traverse((object) => { if (object.name === name) found++; });
  return found;
}

test('all 27 display models are centred, finite, and fit the two-unit workbench API', () => {
  assert.equal(UPGRADES.length, 10);
  for (const definition of UPGRADES) {
    for (const level of [1, 2, 3]) {
      const model = buildUpgradeModel(definition.id, level);
      const bounds = new THREE.Box3().setFromObject(model);
      const centre = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const context = `${definition.id} Lv${level}`;
      assert.ok(centre.length() < 1e-6, `${context} must be centred`);
      assert.ok(Math.abs(Math.max(size.x, size.y, size.z) - 2) < 1e-6, `${context} must fit`);
      let meshes = 0;
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        for (const name of ['position', 'normal']) {
          const attribute = object.geometry.getAttribute(name);
          assert.ok(attribute?.count > 0, `${context}: ${name}`);
          assert.ok(Array.from(attribute.array).every(Number.isFinite), `${context}: finite ${name}`);
        }
      });
      assert.ok(meshes > 0, `${context} is not empty`);
      for (const surface of surfaces(model)) assert.equal(surface.flatShading, true, `${context} keeps faceted materials`);
      assert.doesNotThrow(() => JSON.stringify(model.userData));
    }
  }
});

test('separate previews own their materials, so disposal cannot affect a live workbench model', () => {
  for (const definition of UPGRADES) {
    const live = surfaces(buildUpgradeModel(definition.id, 1));
    const preview = surfaces(buildUpgradeModel(definition.id, 1));
    for (const surface of preview) assert.equal(live.has(surface), false, definition.id);
  }
});

test('tank and boat upgrades show the actual structural progression', () => {
  assert.equal(count(buildUpgradeModel('tank', 1), 'faceted-pressure-vessel'), 0, 'Lv1 has no reserve air');
  assert.equal(count(buildUpgradeModel('tank', 2), 'faceted-pressure-vessel'), 1);
  assert.equal(count(buildUpgradeModel('tank', 3), 'faceted-pressure-vessel'), 2);
  assert.equal(count(buildUpgradeModel('boatSpeed', 1), 'three-blade-pitched-propeller'), 0);
  assert.equal(count(buildUpgradeModel('boatSpeed', 2), 'three-blade-pitched-propeller'), 1);
  assert.equal(count(buildUpgradeModel('boatSpeed', 3), 'three-blade-pitched-propeller'), 2);
  for (const level of [1, 2, 3]) assert.equal(count(buildUpgradeModel('boatDeck', level), 'open-ended-rod-sleeve'), level);
});

test('landing nets and unlit headlamps have no self-illuminating surfaces', () => {
  for (const id of ['net', 'lamp']) {
    for (const level of [1, 2, 3]) {
      for (const surface of surfaces(buildUpgradeModel(id, level))) {
        assert.equal(surface.emissive?.getHex() ?? 0, 0, `${id} Lv${level} is shown unlit`);
      }
    }
  }
});

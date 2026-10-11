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
  // equipment.ts (ROD_TIERS) only needs storageKey from wallet.ts, which drags in Solana + import.meta.env; stub it.
  const localRequire = (specifier) => specifier === './wallet' ? { storageKey: (key) => key }
    : specifier.startsWith('.')
    ? load(path.resolve(path.dirname(file), `${specifier}.ts`))
    : specifier === 'three/addons/utils/BufferGeometryUtils.js' ? mergeUtils : require(specifier);
  new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
  return module.exports;
}
const { UPGRADES, WORKBENCH_GEAR_SIZE, buildUpgradeModel } = load(fileURLToPath(new URL('../src/upgrades.ts', import.meta.url)));
// The net is an assembly rather than three unrelated workbench pieces.  Keep
// this contract in the model tests: the shaft, bag, torch and recovery reel
// are all reusable by the runtime diver and by the table preview.
const { buildNetAssembly, buildNetRecoveryReel, buildNetShaft, buildNetTorch } = load(fileURLToPath(new URL('../src/fishing-net.ts', import.meta.url)));

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

test('all 36 display models are centred, finite, and fit the two-unit workbench API', () => {
  assert.equal(UPGRADES.length, 12); // 11 gear pieces and the whole boat (workbench.ts)
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
  for (const level of [1, 2, 3]) assert.equal(count(buildUpgradeModel('boatDeck', level), 'open-octagonal-rod-sleeve'), level);
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

function objectBounds(object) {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

test('the fishing net has a broad open mouth, a hanging bag, and an in-bag catch point', () => {
  for (const level of [1, 2, 3]) {
    const { group, mouth, tip } = buildNetAssembly({ netLevel: level });
    const shaft = buildNetShaft(level);
    const all = objectBounds(group);
    const mouthBounds = objectBounds(mouth);
    const shaftBounds = objectBounds(shaft);
    const mouthSize = mouthBounds.getSize(new THREE.Vector3());
    const shaftSize = shaftBounds.getSize(new THREE.Vector3());
    const web = group.getObjectByName('Deep_Diamond_Nylon_Bag');
    assert.ok(web, `Lv${level} has a woven bag`);
    const webBounds = objectBounds(web);
    assert.ok(mouthSize.z / shaftSize.x > 0.22, `Lv${level} mouth is wide enough to catch equipment`);
    assert.ok(webBounds.getSize(new THREE.Vector3()).y > mouthSize.z * 0.32, `Lv${level} bag hangs below its opening`);
    assert.ok(tip.parent === mouth, `Lv${level} catch point follows the mouth`);
    assert.ok(tip.position.y < -0.05, `Lv${level} catch point sits inside the bag`);
    assert.ok(all.min.toArray().every(Number.isFinite) && all.max.toArray().every(Number.isFinite), `Lv${level} finite bounds`);
    assert.ok(mouth.scale.x === 1, `Lv${level} keeps the shaft axis unscaled`);
    if (level > 1) {
      const previous = buildNetAssembly({ netLevel: level - 1 });
      const previousMouth = objectBounds(previous.mouth).getSize(new THREE.Vector3());
      assert.ok(mouthSize.z > previousMouth.z, `Lv${level} opening grows with the net tier`);
      assert.ok(mouthSize.y > previousMouth.y, `Lv${level} bag depth grows with the net tier`);
    }
  }
});

test('the net assembly exposes real equipment mounts and keeps optional gear hidden until equipped', () => {
  const empty = buildNetAssembly({ netLevel: 1 });
  const names = new Set();
  empty.group.traverse((object) => names.add(object.name));
  for (const name of ['Fishing_Net_Assembly', 'Net_Mouth', 'Net_Lamp_Mount', 'Catch_Centre']) {
    assert.ok(names.has(name), `assembly exposes ${name}`);
  }
  assert.equal(empty.lamp.name, 'Net_Torch');
  assert.equal(empty.reel.name, 'Net_Recovery_Reel');
  assert.ok(names.has('Rigid_Net_Shaft'), 'assembly exposes the rigid shaft');
  assert.equal(empty.group.getObjectByName('Net_Lamp_Mount'), empty.lampMount);
  assert.equal(empty.lamp.visible, false, 'lamp is absent when its loadout slot is empty');
  assert.equal(empty.reel.visible, false, 'reel is absent when its loadout slot is empty');

  const equipped = buildNetAssembly({ netLevel: 2, shaftLevel: 2, reelLevel: 2, lampLevel: 2 });
  assert.equal(equipped.lamp.visible, true, 'lamp appears when packed');
  assert.equal(equipped.reel.visible, true, 'reel appears when packed');
  assert.equal(equipped.lamp.parent, equipped.lampMount, 'lamp is attached to the net mount');
  assert.ok(equipped.reel.parent, 'reel remains attached to the shaft assembly');
  for (const piece of [equipped.group, equipped.lamp, equipped.reel]) {
    const bounds = objectBounds(piece);
    assert.ok(bounds.getSize(new THREE.Vector3()).toArray().every((value) => value > 0 && Number.isFinite(value)));
  }
  const standaloneReel = buildNetRecoveryReel(2);
  const standaloneTorch = buildNetTorch(2);
  assert.ok(objectBounds(standaloneReel).getSize(new THREE.Vector3()).x > 0);
  assert.ok(objectBounds(standaloneTorch).getSize(new THREE.Vector3()).x > 0);
});

test('workbench display targets preserve useful net proportions', () => {
  const ids = new Set(UPGRADES.map(({ id }) => id));
  assert.deepEqual(Object.keys(WORKBENCH_GEAR_SIZE).sort(), [...ids].sort());
  for (const [id, size] of Object.entries(WORKBENCH_GEAR_SIZE)) {
    assert.ok(Number.isFinite(size) && size > 0, `${id} has a positive display target`);
  }
  assert.ok(WORKBENCH_GEAR_SIZE.net >= WORKBENCH_GEAR_SIZE.rod * 1.25, 'the net is visibly broader than its shaft');
  assert.ok(WORKBENCH_GEAR_SIZE.net >= WORKBENCH_GEAR_SIZE.lamp * 2.5, 'a torch remains a small attachment');
  assert.ok(WORKBENCH_GEAR_SIZE.reel < WORKBENCH_GEAR_SIZE.net * 0.5, 'a reel remains smaller than the net bag');
});

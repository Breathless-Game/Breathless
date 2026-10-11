import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

async function sourceUrl(file, imports = {}) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [name, url] of Object.entries(imports)) {
    outputText = outputText.replace(new RegExp(`from ['"]${name}['"]`, 'g'), `from '${url}'`);
  }
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}

const threeUrl = import.meta.resolve('three');
const accessoriesModule = await import(
  await sourceUrl('../src/accessories.ts', {
    three: threeUrl,
  })
);

const { ACCESSORIES, getAccessoryDef, buildAccessoryModel, normalizeModel } = accessoriesModule;

function displayBounds(model) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  return { center: box.getCenter(new THREE.Vector3()), size, maxDimension: Math.max(size.x, size.y, size.z) };
}

test('ACCESSORIES registry contains all 13 specified items', () => {
  assert.equal(ACCESSORIES.length, 13, 'should contain exactly 13 accessories');
  const ids = new Set(ACCESSORIES.map((a) => a.id));
  assert.equal(ids.size, 13, 'all accessory IDs must be unique');

  const expectedIds = [
    'streamlined-fins',
    'split-flow-vanes',
    'silent-fins',
    'searchlight-core',
    'telephoto-reflector',
    'wide-angle-diffuser',
    'red-light-filter',
    'emergency-tank',
    'streamlined-wetsuit',
    'weight-balance-belt',
    'anti-slip-gloves',
    'polarized-mask',
    'echo-sonar',
  ];

  for (const id of expectedIds) {
    assert.ok(ids.has(id), `expected ID ${id} in ACCESSORIES registry`);
  }
});

test('All 13 accessories have complete bilingual metadata and valid slots', () => {
  const validSlots = new Set([
    'fins',
    'finPlugin',
    'lampCore',
    'lampAttachment',
    'tank',
    'suit',
    'belt',
    'gloves',
    'mask',
    'chestPlugin',
  ]);

  for (const item of ACCESSORIES) {
    assert.ok(item.id.length > 0, 'id must not be empty');
    assert.ok(item.name.length > 0, 'name must not be empty');
    assert.ok(item.nameZh.length > 0, 'nameZh must not be empty');
    assert.ok(validSlots.has(item.slot), `slot ${item.slot} must be a known slot`);
    assert.ok(item.slotZh.length > 0, 'slotZh must not be empty');
    assert.ok(item.stage === 1 || item.stage === 2, 'stage must be 1 or 2');
    assert.ok(item.effect.length > 0, 'effect must not be empty');
    assert.ok(item.effectZh.length > 0, 'effectZh must not be empty');
    assert.ok(item.status.length > 0, 'status must not be empty');
    assert.ok(item.statusZh.length > 0, 'statusZh must not be empty');
    assert.ok(item.descriptionZh.length > 0, 'descriptionZh must not be empty');
    assert.equal(typeof item.build, 'function', 'build must be a builder function');
  }
});

for (const item of ACCESSORIES) {
  test(`${item.nameZh} (${item.id}) builds valid 3D models across tiers 1, 2, and 3`, () => {
    for (const level of [1, 2, 3]) {
      const model = item.build(level);
      assert.ok(model instanceof THREE.Group, 'model must be a THREE.Group');
      assert.ok(model.children.length > 0, 'model must contain children objects');

      let meshCount = 0;
      let totalTriangles = 0;

      model.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          meshCount++;
          const geo = obj.geometry;
          assert.ok(geo.attributes.position, 'mesh geometry must have position attribute');
          const pos = geo.attributes.position;
          assert.ok(pos.count >= 3, 'mesh must have at least one triangle');

          // Ensure no NaNs or infinities in vertex positions
          for (let i = 0; i < pos.count; i++) {
            assert.ok(Number.isFinite(pos.getX(i)), 'vertex X must be finite');
            assert.ok(Number.isFinite(pos.getY(i)), 'vertex Y must be finite');
            assert.ok(Number.isFinite(pos.getZ(i)), 'vertex Z must be finite');
          }

          if (geo.index) {
            totalTriangles += geo.index.count / 3;
          } else {
            totalTriangles += pos.count / 3;
          }
        }
      });

      assert.ok(meshCount >= 1, `tier ${level} must contain at least 1 mesh`);
      assert.ok(totalTriangles >= 4, `tier ${level} must have reasonable polygon count`);

      // Bounding box validation
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      assert.ok(!box.isEmpty(), 'bounding box must not be empty');

      const size = box.getSize(new THREE.Vector3());
      assert.ok(size.x > 0.01, 'bounding width X must be positive');
      assert.ok(size.y > 0.01, 'bounding height Y must be positive');
      assert.ok(size.z > 0.01, 'bounding depth Z must be positive');
    }
  });
}

test('normalizeModel scales groups to the requested target size', () => {
  const raw = new THREE.Group();
  const source = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 2), new THREE.MeshBasicMaterial());
  // Use an offset source so centering must happen in the same scale space as
  // the normalization. A mesh at the origin would hide a translation bug.
  source.position.set(7, 2, -3);
  raw.add(source);
  normalizeModel(raw, 2.0);

  raw.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(raw);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  assert.ok(Math.abs(maxDim - 2.0) < 1e-4, 'maximum dimension should match target size 2.0');
  assert.ok(box.getCenter(new THREE.Vector3()).length() < 1e-4, 'normalized groups must be centered after scaling');
});

test('buildAccessoryModel builds and normalizes any accessory by ID', () => {
  for (const item of ACCESSORIES) {
    const model = buildAccessoryModel(item.id, 2, 2.0);
    assert.ok(model instanceof THREE.Group);

    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    assert.ok(Math.abs(maxDim - 2.0) < 1e-3, 'normalized max dimension should be approximately 2.0');
  }
});

test('tier-relative accessory previews remain centered and bounded, without shrinking on upgrade', () => {
  const targetSize = 1.8; // The accessory preview's shared display frame.
  for (const item of ACCESSORIES) {
    let previousDimension = 0;
    for (const level of [1, 2, 3]) {
      const model = buildAccessoryModel(item.id, level, targetSize, { preserveTierScale: true });
      const { center, size, maxDimension } = displayBounds(model);
      const context = `${item.id} Lv${level}`;
      assert.ok(center.length() < 1e-6, `${context} must be centered in the shared display frame`);
      assert.ok(size.toArray().every((dimension) => Number.isFinite(dimension) && dimension > 0), `${context} must have finite positive bounds`);
      assert.ok(maxDimension <= targetSize + 1e-6, `${context} must stay within the display frame`);
      assert.ok(maxDimension + 1e-6 >= previousDimension, `${context} must not appear smaller than the preceding tier`);
      assert.equal(model.userData.preserveTierScale, true, `${context} must record the tier-relative mode`);
      assert.ok(model.userData.tierScale > 0 && model.userData.tierScale <= 1, `${context} must expose a bounded tier scale`);
      assert.ok(Math.abs(maxDimension - targetSize * model.userData.tierScale) < 1e-6, `${context} display size must match its tier scale`);
      previousDimension = maxDimension;
    }
    assert.ok(Math.abs(previousDimension - targetSize) < 1e-6, `${item.id} highest tier must fill the shared frame`);
  }
});

test('tier-relative previews preserve visible authored growth for fins, reflectors, and air tanks', () => {
  const targetSize = 1.8;
  for (const id of ['streamlined-fins', 'telephoto-reflector', 'emergency-tank']) {
    const definition = getAccessoryDef(id);
    const rawDimensions = [1, 2, 3].map((level) => displayBounds(definition.build(level)).maxDimension);
    const displayDimensions = [1, 2, 3].map((level) => displayBounds(buildAccessoryModel(id, level, targetSize, { preserveTierScale: true })).maxDimension);
    const familyMax = Math.max(...rawDimensions);
    for (let index = 0; index < rawDimensions.length; index++) {
      const expectedDimension = targetSize * rawDimensions[index] / familyMax;
      assert.ok(Math.abs(displayDimensions[index] - expectedDimension) < 1e-6, `${id} Lv${index + 1} must use its family's shared scale`);
      if (index > 0) assert.ok(displayDimensions[index] > displayDimensions[index - 1] * 1.05, `${id} Lv${index + 1} authored growth must remain visible after fitting`);
    }
    assert.ok(displayDimensions[2] > displayDimensions[0] * 1.15, `${id} Lv3 must look larger than Lv1`);
  }
});

test('getAccessoryDef retrieves definitions and safely handles unknown IDs', () => {
  const fins = getAccessoryDef('streamlined-fins');
  assert.ok(fins);
  assert.equal(fins.nameZh, '流线脚蹼 / 竞速脚蹼');

  const unknown = getAccessoryDef('unknown-gear-id');
  assert.equal(unknown, undefined);
});

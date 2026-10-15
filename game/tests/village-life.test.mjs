import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

async function moduleUrl(file, imports = {}) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [name, url] of Object.entries({ three: import.meta.resolve('three'), ...imports })) {
    outputText = outputText.replaceAll(`from '${name}'`, `from '${url}'`);
  }
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const rng = await moduleUrl('rng');
const life = await moduleUrl('village-life', { './rng': rng });
const lowpoly = await moduleUrl('lowpoly', { 'three/examples/jsm/utils/BufferGeometryUtils.js': import.meta.resolve('three/examples/jsm/utils/BufferGeometryUtils.js') });
const aurora = await moduleUrl('aurora');
const { buildScenery } = await import(await moduleUrl('scenery', { './rng': rng, './lowpoly': lowpoly, './aurora': aurora, './village-life': life,
  'three/examples/jsm/utils/BufferGeometryUtils.js': import.meta.resolve('three/examples/jsm/utils/BufferGeometryUtils.js') }));
const { villageHomes, hearthActivity, windowActivity, villageNight } = await import(life);
const { sampleLighting } = await import(await moduleUrl('daylight'));
const { disposeTree } = await import(lowpoly);

test('village quality levels retain the same homes and leave the central channel open', () => {
  const high = villageHomes(3);
  assert.equal(high.length, 12);
  assert.deepEqual(villageHomes(1), high.slice(0, 4));
  assert.deepEqual(villageHomes(2), high.slice(0, 8));
  for (const home of high) {
    assert.ok(Math.abs(home.x) - home.w / 2 > 24);
    for (const other of high) {
      if (other === home) continue;
      assert.ok(Math.abs(home.x - other.x) > (home.w + other.w) / 2 || Math.abs(home.z - other.z) > (home.d + other.d) / 2);
    }
  }
});

test('hearth activity peaks at sunset and wraps midnight continuously', () => {
  assert.equal(hearthActivity(12), 0);
  assert.equal(hearthActivity(18), 1);
  assert.ok(hearthActivity(22) < hearthActivity(18));
  assert.ok(hearthActivity(2) < 0.12);
  assert.ok(Math.abs(hearthActivity(23.999) - hearthActivity(0.001)) < 0.001);
});

test('household windows are sparse, independent, deterministic and change gently', () => {
  let dark = 0, lit = 0;
  const patterns = new Set();
  for (let seed = 0; seed < 14; seed++) {
    const pattern = [];
    for (let t = 0; t < 1200; t++) {
      const value = windowActivity(t, seed);
      assert.ok(value >= 0 && value <= 0.78);
      assert.equal(value, windowActivity(t, seed));
      assert.ok(Math.abs(value - windowActivity(t + 0.1, seed)) < 0.01);
      if (value === 0) dark++;
      if (value > 0.3) lit++;
      if (t % 60 === 0) pattern.push(value.toFixed(2));
    }
    patterns.add(pattern.join(','));
  }
  assert.equal(patterns.size, 14);
  assert.ok(dark > 2000 && lit > 5000);
  assert.equal(villageNight(0), 0);
  assert.equal(villageNight(1), 1);
  assert.ok(villageNight(0.5) > 0 && villageNight(0.5) < 0.5);
});

test('village rendering stays batched and within fixed quality budgets without real lights', () => {
  for (const detail of [1, 2, 3]) {
    const scenery = buildScenery({ id: 'fjord', waves: 0.5 }, detail);
    const windows = scenery.group.getObjectByName('fjord-village-windows');
    const smoke = scenery.group.getObjectByName('fjord-hearth-smoke');
    assert.equal(windows.count, [6, 10, 14][detail - 1]);
    assert.equal(smoke.count, [10, 26, 60][detail - 1]);
    let meshes = 0, triangles = 0;
    const buffers = [];
    scenery.group.traverse(o => {
      assert.ok(!o.isLight, 'windows and hearths add no real lights');
      if (!o.isMesh) return;
      meshes++;
      triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * (o.count ?? 1);
      buffers.push([o.geometry.attributes.position, o.geometry.attributes.position.version]);
    });
    assert.ok(meshes <= 12, `bounded draw count (${meshes})`);
    assert.ok(triangles < 16000, `bounded scenery triangle count (${triangles})`);
    scenery.update(125, false, 0, { lighting: sampleLighting(12) });
    if (detail < 3) {
      assert.equal(smoke.visible, false);
      const version = smoke.instanceMatrix.version;
      scenery.update(126, false, 1, { lighting: sampleLighting(12) });
      assert.equal(smoke.instanceMatrix.version, version, 'dormant daytime smoke does not upload instance matrices');
    }
    const day = windows.instanceColor.array.slice();
    scenery.update(125, true, 1, { lighting: sampleLighting(22) });
    assert.notDeepEqual(windows.instanceColor.array, day);
    scenery.update(126, true, 1, { lighting: sampleLighting(22), lightingEffects: false });
    const dark = windows.instanceColor.array.slice();
    scenery.update(300, true, 1, { lighting: sampleLighting(22), lightingEffects: false });
    assert.deepEqual(windows.instanceColor.array, dark, 'lighting off suppresses changing window lights');
    assert.ok(buffers.every(([attribute, version]) => attribute.version === version), 'animation uploads no static geometry');
    disposeTree(scenery.group);
  }
});

test('sunset smoke stays close to the hearths and never rises across the mountain skyline', () => {
  const scenery = buildScenery({ id: 'fjord', waves: 0.5 }, 3);
  scenery.update(125, true, 0, { lighting: sampleLighting(18.1), weather: { wind: 0.3 } });
  const smoke = scenery.group.getObjectByName('fjord-hearth-smoke');
  assert.ok(smoke.material.opacity <= 0.22);
  assert.ok(smoke.material.emissiveIntensity <= 0.06);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
  for (let i = 0; i < smoke.count; i++) {
    smoke.getMatrixAt(i, matrix);
    matrix.decompose(position, rotation, scale);
    assert.ok(position.y + scale.y < 15, 'smoke remains below the ridges');
    assert.ok(Math.max(scale.x, scale.y, scale.z) < 2);
  }
  // All three curtains, including their maximum +15 m GPU fold, sit behind the far range.
  const curtains = scenery.group.children.filter(o => o.material?.uniforms?.uStrength);
  assert.equal(curtains.length, 3);
  assert.ok(curtains.every(o => o.position.z + 15 < -210));
  assert.ok(curtains.every(o => !o.visible), 'sunset does not bring full-strength aurora');
  disposeTree(scenery.group);
});

test('cabin shelf supports the old footprints and village steps follow local ground', () => {
  const scenery = buildScenery({ id: 'fjord', waves: 0.5 }, 3);
  scenery.group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
  for (const [x, z, w, d] of [[-37, -46, 5, 4], [-28.5, -49, 3.6, 3]]) {
    const points = [-1, 1].flatMap(sx => [-1, 1].map(sz => [x + sx * w / 2, z + sz * d / 2]));
    points.push([x - w * 0.25, z + d / 2 + 0.3]);
    for (const [px, pz] of points) {
      ray.set(new THREE.Vector3(px, 1.25, pz), down);
      assert.ok(ray.intersectObject(scenery.group, true).some(hit => Math.abs(hit.point.y - 1.1) < 0.001), 'footprints and steps stand on the connected shelf');
    }
  }
  const windows = scenery.group.getObjectByName('fjord-village-windows');
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), vertices = [];
  scenery.group.traverse(o => {
    if (o.isMesh && !o.isInstancedMesh && o.material.vertexColors) vertices.push(o.geometry.attributes.position);
  });
  for (const [i, home] of villageHomes(3).entries()) {
    windows.getMatrixAt(i + 2, matrix);
    position.setFromMatrixPosition(matrix);
    const floor = position.y - home.h * 0.56;
    const stepX = home.x - home.w * 0.25 - 0.65;
    const stepZ = home.z + home.d / 2 + 0.575;
    for (const y of [floor, floor - 0.4]) {
      assert.ok(vertices.some(attr => {
        for (let j = 0; j < attr.count; j++) {
          if (Math.abs(attr.getX(j) - stepX) < 0.001 && Math.abs(attr.getY(j) - y) < 0.001 && Math.abs(attr.getZ(j) - stepZ) < 0.001) return true;
        }
        return false;
      }), 'each step spans its local ground-to-floor height');
    }
  }
  disposeTree(scenery.group);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

async function moduleUrl(file, dependencies = {}, transform = source => source) {
  const source = transform(await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8'));
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [name, url] of Object.entries({ three: import.meta.resolve('three'), ...dependencies })) {
    for (const quote of ["'", '"']) outputText = outputText.replaceAll(`${quote}${name}${quote}`, JSON.stringify(url));
  }
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const marineUrl = await moduleUrl('marine');
const { buildMarineCreature } = await import(marineUrl);
// Keep the real modelling and pigment code, omitting only the final batching operation.
const { buildMarineCreature: unbatchedMarine } = await import(await moduleUrl('marine', {}, source => {
  assert.equal(source.split('batchMarineMeshes(group);').length, 2);
  return source.replace('batchMarineMeshes(group);', 'void 0;');
}));
const { Fish, rollFish, buildFishMesh, disposeFishMesh } = await import(await moduleUrl('fish', {
  './marine': marineUrl, './rng': await moduleUrl('rng'), './depth-odds': await moduleUrl('depth-odds'), './i18n': await moduleUrl('i18n'),
}));
const specimens = new Map();
for (const rarity of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
  for (let seed = 1; seed <= 300; seed++) {
    const spec = rollFish(Math.imul(seed, 2654435761) >>> 0, 25, [[rarity, 1]]);
    if (!specimens.has(spec.species)) specimens.set(spec.species, spec);
  }
}
const specimen = name => { const spec = specimens.get(name); assert.ok(spec, name); return spec; };
const meshes = fish => { const result = []; fish.group.traverse(o => { if (o.isMesh) result.push(o); }); return result; };
const positions = fish => meshes(fish).flatMap(mesh => [...mesh.geometry.getAttribute('position').array]);
const maxDelta = (a, b) => a.reduce((max, value, i) => Math.max(max, Math.abs(value - b[i])), 0);

for (const name of ['Sand Minnow', 'Grey Perch', 'Azure Tang', 'Striped Wrasse']) {
  test(`${name} has attached eye pairs, gills and solid fin edges with deterministic geometry`, () => {
    const fish = buildFishMesh(specimen(name)), copy = buildFishMesh(specimen(name));
    const surfaces = meshes(fish);
    assert.ok(surfaces.length <= 12, `${surfaces.length} draw calls`);
    assert.equal(surfaces.filter(mesh => mesh.name === 'fish-eye').length, 2);
    assert.equal(surfaces.filter(mesh => mesh.name === 'fish-eye-rim').length, 2);
    const gillGeometry = fish.group.getObjectByName('fish-gills').geometry;
    assert.equal(gillGeometry.getAttribute('position').count, 18);
    const normals = gillGeometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) assert.ok(normals.getZ(i) * (i < 9 ? -1 : 1) > 0, 'gills face outward on both flanks');
    for (const part of ['fish-fins', 'fish-tail']) {
      const geometry = fish.group.getObjectByName(part).geometry;
      geometry.computeBoundingBox();
      assert.ok(geometry.boundingBox.max.z - geometry.boundingBox.min.z >= 0.012, 'fins have physical thickness');
    }
    assert.ok(positions(fish).every(Number.isFinite));
    assert.deepEqual(positions(fish), positions(copy));
    assert.deepEqual(surfaces.filter(mesh => mesh.name === 'fish-eye').map(mesh => mesh.position.z).sort((a,b) => a-b),
      surfaces.filter(mesh => mesh.name === 'fish-eye').map(mesh => -mesh.position.z).sort((a,b) => a-b));
    disposeFishMesh(fish); disposeFishMesh(copy);
  });
}

for (const name of ['Bluefin Tuna', 'Reef Octopus', 'Whale Shark', 'Green Sea Turtle']) {
  test(`${name} batching preserves the full silhouette, pigmentation and flipper pivots`, () => {
    const spec = specimen(name), fish = buildMarineCreature(spec, 0), reference = unbatchedMarine(spec, 0);
    const before = meshes(reference), after = meshes(fish);
    assert.ok(after.length < before.length / 2, `${before.length} → ${after.length} draw calls`);
    assert.ok(after.length <= 32, `${after.length} draw calls`);
    const vertices = model => {
      model.group.updateMatrixWorld(true);
      const xyz = [[], [], []], colors = [];
      for (const mesh of meshes(model)) {
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
        const p = g.getAttribute('position'), c = g.getAttribute('color'), point = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          point.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
          for (let axis = 0; axis < 3; axis++) xyz[axis].push(point.getComponent(axis));
          if (c) colors.push(c.getX(i), c.getY(i), c.getZ(i));
        }
        if (g !== mesh.geometry) g.dispose();
      }
      return { xyz: xyz.map(values => values.sort((a,b) => a-b)), colors: colors.sort((a,b) => a-b) };
    };
    const actual = vertices(fish), expected = vertices(reference);
    for (let axis = 0; axis < 3; axis++) {
      assert.equal(actual.xyz[axis].length, expected.xyz[axis].length, 'no triangles lost');
      assert.ok(maxDelta(actual.xyz[axis], expected.xyz[axis]) < 2e-6, 'bind-space vertices retained');
    }
    assert.deepEqual(actual.colors, expected.colors, 'all seeded pigments retained');
    const pivots = model => { const result = []; model.group.traverse(o => { if (o.isGroup) result.push(o); }); return result; };
    assert.equal(pivots(fish).length, pivots(reference).length);
    assert.ok(meshes(fish).some(mesh => mesh.material === fish.material), 'highlight material belongs to a visible surface');
    console.log(`${name}: ${before.length} → ${after.length} meshes`);
    disposeFishMesh(fish); disposeFishMesh(reference);
  });
}

for (const name of ['Grey Perch', 'Bluefin Tuna', 'Ribbon Moray', 'Manta Ray', 'Moon Jellyfish', 'Reef Octopus', 'Green Sea Turtle']) {
  test(`${name} strokes stay continuous when accelerating at a late timestamp or restarting the clock`, () => {
    const fish = buildFishMesh(specimen(name));
    const snapshot = () => [...positions(fish), ...meshes(fish).flatMap(mesh => mesh.parent.rotation.toArray().slice(0, 3))];
    const before = snapshot();
    fish.animate(1200, 0.2);
    const first = snapshot();
    fish.animate(1200 + 1/25, 3);
    const accelerated = snapshot();
    assert.ok(maxDelta(first, accelerated) > 0, 'animation advances');
    const diagonal = new THREE.Box3().setFromObject(fish.group).getSize(new THREE.Vector3()).length() / fish.group.scale.x;
    assert.ok(maxDelta(first, accelerated) < diagonal * 0.18, 'acceleration does not reset phase');
    fish.animate(0, 0.2); fish.animate(1/25, 0.2);
    assert.ok(maxDelta(snapshot(), accelerated) > 0, 'a reset timestamp does not freeze the rig');
    fish.animate(NaN, Infinity); fish.animate(2/25, NaN);
    assert.ok(snapshot().every(Number.isFinite));
    assert.ok(maxDelta(before, snapshot()) > 0, 'the species rig actually moves');
    disposeFishMesh(fish);
  });
}

test('body waves cross repeated stroke boundaries without a half-frequency jump', () => {
  const fish = buildFishMesh({ ...specimen('Grey Perch'), seed: 0 });
  fish.animate(0, 0);
  let previous = positions(fish);
  for (let frame = 1; frame <= 360; frame++) {
    fish.animate(frame / 30, 0);
    const current = positions(fish);
    assert.ok(maxDelta(previous, current) < 0.055, `continuous frame ${frame}`);
    previous = current;
  }
  disposeFishMesh(fish);
});

test('schoolmates have reproducible, distinct strokes', () => {
  const a = buildFishMesh({ ...specimen('Grey Perch'), seed: 1 });
  const b = buildFishMesh({ ...specimen('Grey Perch'), seed: 2 });
  a.animate(100, 1); b.animate(100, 1);
  assert.ok(maxDelta(positions(a), positions(b)) > 0.02);
  disposeFishMesh(a); disposeFishMesh(b);
});

test('heading follows depth travel and banking settles on a straight course', () => {
  for (const dz of [-1, 1]) {
    const fish = new Fish(specimen('Grey Perch'), { top: 5, bottom: 55 }, 0, -25, 140);
    fish.pos.z = 0;
    const direction = new THREE.Vector3(1, 0.25, dz).normalize();
    fish.target.copy(fish.pos).addScaledVector(direction, 80);
    const diver = new THREE.Vector3(500, 0, 0);
    for (let frame = 0; frame < 240; frame++) fish.update(1/60, frame/60, diver);
    fish.mesh.group.updateMatrixWorld(true);
    const nose = new THREE.Vector3(1,0,0).transformDirection(fish.mesh.group.matrixWorld);
    assert.ok(nose.dot(fish.vel.clone().normalize()) > 0.995);
    assert.ok(Math.abs(fish.mesh.group.rotation.x) < 0.015, 'bank fades after a turn');
    disposeFishMesh(fish.mesh);
  }
});

test('disposing a fish frees each geometry and material once, including eye rims and gills', () => {
  for (const name of ['Grey Perch', 'Reef Octopus', 'Lantern Angler']) {
    const fish = buildFishMesh(specimen(name)), resources = new Set([fish.material]);
    for (const mesh of meshes(fish)) {
      resources.add(mesh.geometry);
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) resources.add(mat);
    }
    const counts = new Map([...resources].map(resource => [resource, 0]));
    for (const resource of resources) resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
    disposeFishMesh(fish);
    assert.ok([...counts.values()].every(count => count === 1));
  }
});

test('hidden fish keep identical behaviour without deforming or uploading their surfaces', () => {
  const visible = new Fish(specimen('Grey Perch'), { top: 5, bottom: 55 }, 0, -25, 140);
  const hidden = new Fish(specimen('Grey Perch'), { top: 5, bottom: 55 }, 0, -25, 140);
  const buffers = meshes(hidden.mesh).map(mesh => [mesh.geometry.attributes.position, mesh.geometry.attributes.position.version]);
  hidden.updateVisual(0, false);
  const diver = new THREE.Vector3(1, -25, 0);
  for (let frame = 0; frame < 120; frame++) {
    visible.update(1 / 60, frame / 60, diver);
    hidden.update(1 / 60, frame / 60, diver, false);
    assert.deepEqual(hidden.pos, visible.pos);
    assert.deepEqual(hidden.vel, visible.vel);
    assert.deepEqual(hidden.target, visible.target);
  }
  assert.ok(buffers.every(([attribute, version]) => attribute.version === version));
  assert.ok(Number.isFinite(hidden.visualRadius) && hidden.visualRadius > 0);
  hidden.updateVisual(2, true);
  assert.equal(hidden.mesh.group.visible, true);
  assert.ok(buffers.some(([attribute, version]) => attribute.version > version));
  assert.ok(positions(hidden.mesh).every(Number.isFinite));
  disposeFishMesh(visible.mesh); disposeFishMesh(hidden.mesh);
});

test('flat-shaded fish reuse normals while smooth materials retain normal rebuilding', () => {
  const fish = buildFishMesh(specimen('Grey Perch'));
  const normals = meshes(fish).map(mesh => [mesh.geometry.attributes.normal, mesh.geometry.attributes.normal.version]);
  const rest = positions(fish);
  fish.animate(0, 1); fish.animate(0.1, 1);
  assert.ok(maxDelta(rest, positions(fish)) > 0);
  assert.ok(normals.every(([attribute, version]) => attribute.version === version), 'flat normals are derived in the fragment shader');
  assert.ok(meshes(fish).every(mesh => mesh.geometry.attributes.position.usage === THREE.DynamicDrawUsage));
  const normal = fish.body.geometry.attributes.normal;
  fish.material.flatShading = false;
  fish.animate(0.2, 1);
  assert.ok(normal.version > 0, 'smooth shading still gets deformed normals');
  disposeFishMesh(fish);
});

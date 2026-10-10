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
  for (const [name, url] of Object.entries(imports)) outputText = outputText.replace(`from '${name}'`, `from '${url}'`);
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const { createHabitat, habitatHeight, SHELF_EDGE } = await import(await sourceUrl('../src/seabed-layout.ts', {
  './rng': await sourceUrl('../src/rng.ts'),
}));

const maps = [
  { name: 'fjord', seed: 0xf10d5ea, bed: -20, plants: 55 },
  { name: 'tianchi', seed: 0x71a2c41, bed: -40, plants: 26 },
  { name: 'ocean', seed: 20261010, bed: -62, plants: 55 },
];

// Raycast actual PlaneGeometry triangles. This independently checks the ground
// sampler instead of repeating its barycentric interpolation implementation.
const floors = new Map();
function renderedFloorHeight(x, z, bed) {
  if (!floors.has(bed)) {
    const meshes = [];
    const sideWidth = 130 - SHELF_EDGE;
    const tiles = [
      [sideWidth, 90, -SHELF_EDGE - sideWidth / 2, -25],
      [sideWidth, 90, SHELF_EDGE + sideWidth / 2, -25],
      [SHELF_EDGE * 2, 54, 0, -43],
    ];
    for (const [width, depth, cx, cz] of tiles) {
      const geometry = new THREE.PlaneGeometry(width, depth, Math.ceil(width / 3), Math.ceil(depth / 3));
      geometry.rotateX(-Math.PI / 2);
      const position = geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        position.setY(i, habitatHeight(position.getX(i) + cx, position.getZ(i) + cz, bed) - bed);
      }
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      mesh.position.set(cx, bed, cz);
      mesh.updateMatrixWorld(true);
      meshes.push(mesh);
    }
    floors.set(bed, meshes);
  }
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0));
  const hits = ray.intersectObjects(floors.get(bed), false);
  assert.ok(hits.length, 'each plant has rendered terrain below it');
  return hits[0].point.y;
}

test('habitats rebuild deterministically and retain the same plants across quality prefixes', () => {
  for (const map of maps) {
    const full = createHabitat(map.seed, map.bed, map.plants);
    assert.deepEqual(full, createHabitat(map.seed, map.bed, map.plants));
    assert.equal(full.plants.length, map.plants, `${map.name} supports the requested vegetation budget`);
    assert.notDeepEqual(full.rocks, createHabitat(map.seed + 1, map.bed, map.plants).rocks);
    for (const count of [0, 12, Math.min(30, map.plants)]) {
      const low = createHabitat(map.seed, map.bed, count);
      assert.deepEqual(low.rocks, full.rocks, 'plant budgets cannot move the outcrops');
      assert.deepEqual(low.patches, full.patches);
      assert.deepEqual(low.plants, full.plants.slice(0, count), 'lower budgets preserve root positions, height and identity');
      if (count) assert.ok(new Set(low.plants.map(plant => plant.patch)).size >= 4,
        'the low tier distributes plants across the habitat instead of one corner');
    }
  }
});

test('outcrops have separated anchors and keep their main forms at every quality tier', () => {
  for (const map of maps) {
    const { patches, rocks } = createHabitat(map.seed, map.bed, map.plants);
    assert.ok(patches.length >= 8 && patches.length <= 14);
    for (const [i, p] of patches.entries()) {
      for (const q of patches.slice(i + 1)) {
        assert.ok(Math.hypot(p.x - q.x, p.z - q.z) >= p.radius + q.radius + 8,
          'anchor clusters leave open sand channels');
      }
      const anchor = rocks.find(rock => rock.patch === i && rock.detail === 1);
      assert.ok(anchor, 'every patch has a persistent anchor at low quality');
      assert.equal(anchor.x, p.x);
      assert.equal(anchor.z, p.z);
      assert.ok(rocks.some(rock => rock.patch === i && rock.detail > 1), 'higher tiers fill in nearby talus');
    }
    for (const rock of rocks) {
      assert.ok([rock.x, rock.z, rock.radius, rock.squash, rock.seed].every(Number.isFinite));
      assert.ok(rock.radius > 0 && rock.squash > 0);
      assert.ok(Math.abs(rock.x) < 82 && rock.z > -52 && rock.z < 10);
      assert.ok(Math.abs(rock.x) >= SHELF_EDGE + rock.radius * 1.2 || rock.z < -26 - rock.radius,
        'rocks remain on the shelf or rear reef, clear of the central dive lane');
    }
  }
});

test('kelp roots touch the rendered substrate and tips stay submerged', () => {
  for (const map of maps) {
    for (const plant of createHabitat(map.seed, map.bed, map.plants).plants) {
      const ground = renderedFloorHeight(plant.x, plant.z, map.bed);
      assert.ok(plant.y <= ground + 0.02, `${map.name} root floats ${(plant.y - ground).toFixed(3)}m above its terrain triangle`);
      assert.ok(plant.y >= ground - 0.8, 'roots are only slightly buried, leaving visible stems');
      assert.ok(plant.height > 0 && plant.y + plant.height <= -3.5,
        'even the tallest primary frond stays below the water surface');
      assert.ok(Math.abs(plant.x) >= SHELF_EDGE + 3 || plant.z < -29,
        'root clusters leave the playable trench clear');
    }
  }
});

test('vegetation grows around outcrops with separated roots instead of overlapping repeated rows', () => {
  for (const map of maps) {
    const { plants, rocks, patches } = createHabitat(map.seed, map.bed, map.plants);
    for (const [i, p] of plants.entries()) {
      assert.ok([p.x, p.y, p.z, p.height, p.seed].every(Number.isFinite));
      const patch = patches[p.patch];
      assert.ok(Math.hypot(p.x - patch.x, p.z - patch.z) <= patch.radius + 4.8,
        'each plant belongs to an outcrop habitat');
      for (const q of plants.slice(i + 1)) assert.ok(Math.hypot(p.x - q.x, p.z - q.z) >= 1.3);
      for (const rock of rocks) assert.ok(Math.hypot(p.x - rock.x, p.z - rock.z) >= rock.radius * 0.85 + 0.4,
        'roots are planted beside stones rather than inside them');
    }
  }
});

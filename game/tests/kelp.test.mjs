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

const three = import.meta.resolve('three');
const motionUrl = await sourceUrl('../src/kelp-motion.ts');
const { kelpDisplacement } = await import(motionUrl);
const { KelpField, buildKelpGeometry, kelpTypeForSeed } = await import(await sourceUrl('../src/kelp.ts', {
  three, './rng': await sourceUrl('../src/rng.ts'), './kelp-motion': motionUrl,
}));
const { SceneColorGrade } = await import(await sourceUrl('../src/color-grade.ts', { three }));
const plants = [
  { x: -22, y: -43, z: -5, height: 18, seed: 12, type: 'ribbon' },
  { x: 15, y: -41, z: -9, height: 20, seed: 931, type: 'legacy' },
  { x: 38, y: -39, z: -11, height: 16, seed: 528, type: 'frond' },
];
const hue = [0.26, 0.43];

for (const detail of [1, 2, 3]) {
  test(`kelp detail ${detail} has finite sculpted leaves, attached branches and a bounded mesh budget`, () => {
    const geometry = buildKelpGeometry(plants, hue, detail);
    const positions = geometry.attributes.position;
    const motion = geometry.attributes.aKelpMotion;
    assert.ok(geometry.index);
    assert.ok(positions.count < plants.length * [180, 300, 450][detail - 1]);
    assert.equal(positions.count, motion.count);
    let attachments = 0;
    const locations = new Map();
    for (let i = 0; i < positions.count; i++) {
      const position = [positions.getX(i), positions.getY(i), positions.getZ(i)];
      assert.ok(position.every(Number.isFinite));
      const key = position.join(',');
      const parameters = [motion.getX(i), motion.getY(i), motion.getZ(i), motion.getW(i)];
      if (locations.has(key)) {
        assert.deepEqual(parameters, locations.get(key), 'branch junctions share exactly the same motion');
        attachments++;
      }
      locations.set(key, parameters);
      for (const time of [0, 19.3, 731, 86400]) {
        const delta = kelpDisplacement(parameters[0], parameters[1], parameters[2], time, 1, parameters[3]);
        const point = position.map((value, j) => value + delta[j]);
        assert.ok(point.every((value, axis) => value >= geometry.boundingBox.min.getComponent(axis) - 1e-5
          && value <= geometry.boundingBox.max.getComponent(axis) + 1e-5), 'animated geometry stays within its culling bounds');
      }
    }
    assert.equal(attachments, 22, 'three tuft roots, all legacy leaf edges, and every broad frond stay welded at every tier');
    for (let i = 0; i < geometry.index.count; i += 3) {
      const [a, b, c] = [0, 1, 2].map(j => {
        const id = geometry.index.getX(i + j);
        assert.ok(id >= 0 && id < positions.count);
        return [positions.getX(id), positions.getY(id), positions.getZ(id)];
      });
      const ab = b.map((value, axis) => value - a[axis]);
      const ac = c.map((value, axis) => value - a[axis]);
      const area = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
      assert.ok(area > 1e-6, 'tapered roots and tips contain no collapsed triangles');
    }
    const repeated = buildKelpGeometry(plants, hue, detail);
    assert.deepEqual(repeated.attributes.position.array, positions.array);
    assert.deepEqual(repeated.attributes.color.array, geometry.attributes.color.array);
    geometry.dispose(); repeated.dispose();
  });
}

test('kelp current fixes roots, bends tips smoothly and remains bounded through a full day', () => {
  for (const time of [0, 0.3, 23, 87, 1301, 86400]) {
    for (const phase of [-12, -1, 0, 4, 19]) {
      for (const wind of [0, 0.5, 1]) {
        assert.ok(kelpDisplacement(24, 0, phase, time, wind, 0).every(value => value === 0));
        for (let h = 0; h <= 1; h += 0.025) {
          const value = kelpDisplacement(24, h, phase, time, wind, 0.5);
          assert.ok(Math.abs(value[0]) < 24 * 0.22);
          assert.ok(Math.abs(value[1]) < 24 * 0.03);
          assert.ok(Math.abs(value[2]) < 24 * 0.055);
          const next = kelpDisplacement(24, h, phase, time + 1 / 60, wind, 0.5);
          assert.ok(Math.hypot(...next.map((v, i) => v - value[i])) < 0.06, 'no jitter or abrupt hinge motion between frames');
        }
      }
    }
  }
});

test('seeded beds contain all three stable forms with mostly narrow blades', () => {
  const totals = { ribbon: 0, legacy: 0, frond: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const type = kelpTypeForSeed(seed);
    assert.equal(type, kelpTypeForSeed(seed));
    totals[type]++;
  }
  assert.ok(totals.ribbon > 120 && totals.ribbon < 200);
  assert.ok(totals.legacy > 55 && totals.legacy < 120);
  assert.ok(totals.frond > 25 && totals.frond < 75);
});

test('quality changes preserve plant forms, tips, branch joins and seeded traits', () => {
  const junctions = geometry => {
    const count = new Map();
    const p = geometry.attributes.position;
    const motion = geometry.attributes.aKelpMotion;
    for (let i = 0; i < p.count; i++) {
      const key = [p.getX(i), p.getY(i), p.getZ(i), motion.getZ(i)].join(',');
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    return [...count.entries()].filter(([, n]) => n > 1).sort();
  };
  const tips = geometry => {
    const p = geometry.attributes.position, m = geometry.attributes.aKelpMotion;
    return Array.from({ length: p.count }, (_, i) => i).filter(i => m.getY(i) === 1)
      .map(i => [p.getX(i), p.getY(i), p.getZ(i), m.getZ(i)]).sort();
  };
  for (const plant of plants) {
    const low = buildKelpGeometry([plant], hue, 1);
    const high = buildKelpGeometry([plant], hue, 3);
    assert.deepEqual(junctions(low), junctions(high), plant.type);
    assert.deepEqual(tips(low), tips(high), plant.type);
    const otherSeed = buildKelpGeometry([{ ...plant, seed: plant.seed + 20 }], hue, 1);
    assert.notDeepEqual(otherSeed.attributes.position.array, low.attributes.position.array);
    low.dispose(); high.dispose(); otherSeed.dispose();
  }
});

test('biome palettes change pigment while preserving geometry and motion', () => {
  const palettes = [
    ['#77aa43', '#aed65f', '#3eaf88'],
    ['#bb804d', '#d6aa57', '#5aaf87'],
    ['#6ba475', '#9eb64e', '#417d88'],
  ];
  const geometries = palettes.map(palette => buildKelpGeometry(plants, hue, 2, palette));
  for (let i = 1; i < geometries.length; i++) {
    assert.deepEqual(geometries[0].attributes.position.array, geometries[i].attributes.position.array);
    assert.deepEqual(geometries[0].attributes.aKelpMotion.array, geometries[i].attributes.aKelpMotion.array);
    assert.notDeepEqual(geometries[0].attributes.color.array, geometries[i].attributes.color.array);
  }
  for (const geometry of geometries) {
    const colors = geometry.attributes.color.array;
    assert.ok(colors.every(Number.isFinite));
    assert.ok(Math.max(...colors) - Math.min(...colors) > 0.2, 'facets keep visible pigment contrast');
    geometry.dispose();
  }
});

test('kelp animation composes with scene grading without uploading vertices or adding draw calls', () => {
  const field = new KelpField({ plants, hue, detail: 3 });
  assert.equal(field.group.children.length, 1);
  const mesh = field.group.children[0];
  const position = mesh.geometry.attributes.position;
  const version = position.version;
  const original = position.array.slice();
  const grade = new SceneColorGrade();
  grade.apply(field.group);
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <colorspace_fragment>' };
  mesh.material.onBeforeCompile(shader, null);
  field.update(31.2, 0.75);
  assert.equal(shader.uniforms.uKelpTime.value, 31.2);
  assert.equal(shader.uniforms.uKelpWind.value, 0.75);
  assert.equal(shader.uniforms.uGradeSaturation, grade.uniforms.uGradeSaturation);
  assert.ok(shader.vertexShader.includes('transformed += kelpDisplacement'));
  assert.ok(shader.fragmentShader.includes('gradeBalance'));
  assert.equal(mesh.material.flatShading, true);
  assert.equal(position.version, version);
  assert.deepEqual(position.array, original);
  let geometryDisposed = 0, materialDisposed = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposed++);
  mesh.material.addEventListener('dispose', () => materialDisposed++);
  field.dispose();
  assert.equal(geometryDisposed, 1);
  assert.equal(materialDisposed, 1);
  assert.equal(field.group.children.length, 0);
});

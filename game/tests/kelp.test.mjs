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
const { KelpField, buildKelpGeometry } = await import(await sourceUrl('../src/kelp.ts', {
  three, './rng': await sourceUrl('../src/rng.ts'), './kelp-motion': motionUrl,
}));
const { SceneColorGrade } = await import(await sourceUrl('../src/color-grade.ts', { three }));
const plants = [
  { x: -22, y: -43, z: -5, height: 12, seed: 12 },
  { x: 15, y: -41, z: -9, height: 20, seed: 931 },
];
const hue = [0.26, 0.43];

for (const detail of [1, 2, 3]) {
  test(`kelp detail ${detail} has finite sculpted leaves, attached branches and a bounded mesh budget`, () => {
    const geometry = buildKelpGeometry(plants, hue, detail);
    const positions = geometry.attributes.position;
    const motion = geometry.attributes.aKelpMotion;
    assert.ok(geometry.index);
    assert.ok(positions.count < plants.length * [140, 220, 360][detail - 1]);
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
    assert.ok(attachments >= plants.length * (detail === 3 ? 8 : detail === 2 ? 5 : 4));
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
          assert.ok(Math.abs(value[0]) < 24 * 0.17);
          assert.ok(Math.abs(value[1]) < 24 * 0.02);
          assert.ok(Math.abs(value[2]) < 24 * 0.04);
          const next = kelpDisplacement(24, h, phase, time + 1 / 60, wind, 0.5);
          assert.ok(Math.hypot(...next.map((v, i) => v - value[i])) < 0.06, 'no jitter or abrupt hinge motion between frames');
        }
      }
    }
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

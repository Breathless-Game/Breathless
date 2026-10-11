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
const sonarUrl = await sourceUrl('../src/deep-sonar.ts', { three });
const { DeepSonar, DEEP_SONAR_LENGTH_TIERS, normalizeDeepSonarCustomization } = await import(sonarUrl);

test('deep sonar has bounded low-poly geometry, upgradeable reach and stable node count', () => {
  const sonar = new DeepSonar({ color: '#24d8c2', lengthLevel: 2, detail: 2 });
  assert.equal(sonar.mode, 'carried');
  assert.equal(sonar.length, DEEP_SONAR_LENGTH_TIERS[1].length);
  assert.equal(sonar.group.children.length, 4, 'buoy, cable, node group and anchor');
  const nodeGroup = sonar.group.children[2];
  assert.equal(nodeGroup.children.length, DEEP_SONAR_LENGTH_TIERS[1].nodes * 2);
  let triangles = 0;
  sonar.group.traverse(object => {
    if (object.isMesh) {
      const position = object.geometry.attributes.position;
      triangles += position.count / 3;
      for (const value of position.array) assert.ok(Number.isFinite(value));
      if (object.material.isMeshStandardMaterial) assert.equal(object.material.flatShading, true, 'solid pieces keep the faceted style');
    }
  });
  assert.ok(triangles < 700, 'sonar stays cheap enough for low detail');
  sonar.setLengthLevel(3);
  assert.equal(sonar.length, DEEP_SONAR_LENGTH_TIERS[2].length);
  assert.equal(sonar.group.children[2].children.length, DEEP_SONAR_LENGTH_TIERS[2].nodes * 2);
  sonar.dispose();
  assert.equal(sonar.group.children.length, 0);
  const low = new DeepSonar({ lengthLevel: 3, detail: 1 });
  assert.equal(low.nodeCount, 4, 'low detail keeps a readable signal with one fewer glow');
  low.dispose();
});

test('deep sonar lowers once and remains vertically anchored', () => {
  const sonar = new DeepSonar({ deploySeconds: 1, startsCarried: true });
  sonar.setCarried({ x: 3, y: 1, z: -2 });
  sonar.deploy({ x: 3, y: 0, z: -2 });
  sonar.update(0, 0.5);
  assert.equal(sonar.mode, 'deploying');
  assert.equal(sonar.group.position.x, 3);
  assert.equal(sonar.group.position.z, -2);
  assert.ok(sonar.group.position.y < 1 && sonar.group.position.y > 0);
  sonar.update(1, 0.5);
  assert.equal(sonar.mode, 'anchored');
  assert.equal(sonar.group.position.y, 0);
  const before = sonar.group.position.clone();
  sonar.update(4, 10);
  assert.deepEqual(sonar.group.position.toArray(), before.toArray(), 'anchored sonar stays fixed');
  sonar.dispose();
});

test('preparation customization clamps invalid values and supports lighting toggle', () => {
  const options = normalizeDeepSonarCustomization({ color: 'not-a-colour', lengthLevel: 99, lighting: false });
  assert.equal(options.color, '#42e8d2');
  assert.equal(options.lengthLevel, 3);
  assert.equal(options.lighting, false);
  const sonar = new DeepSonar(options);
  sonar.setColor('#ff6a45');
  assert.equal(sonar.customization.color, '#ff6a45');
  sonar.setLightingEnabled(true);
  assert.equal(sonar.customization.lighting, true);
  sonar.dispose();
});

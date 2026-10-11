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
const walletStub = `data:text/javascript;base64,${Buffer.from("export const storageKey = (name) => 'deepbreath.test.' + name;").toString('base64')}`;
const lampLightingCode = 'export const lampProfile=(level,path)=>{const tier=Math.max(1,Math.min(3,Math.floor(Number(level)||1)));const wide=path==="wideLamp";const profiles=wide?[[18,48,.65,2,.55,.12,.03],[24,60,1.03,2,.8,.2,.045],[32,74,1.25,2,.9,.24,.05]]:[[18,48,.65,2,.55,.12,.03],[33,74,.52,2,.3,.09,.018],[48,102,.43,2,.24,.075,.014]];const p=profiles[tier-1];return {distance:p[0],intensity:p[1],angle:p[2],decay:p[3],penumbra:p[4],scatter:p[5],extinction:p[6]};};';
const lampLightingStub = `data:text/javascript;base64,${Buffer.from(lampLightingCode).toString('base64')}`;
const { EQUIPMENT_TIERS } = await import(await sourceUrl('../src/equipment.ts', { './wallet': walletStub, './lamp-lighting': lampLightingStub }));

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

test('sonar mesh tiers match the Pearl tiers sold in the gear panel', () => {
  assert.equal(EQUIPMENT_TIERS.sonar.length, DEEP_SONAR_LENGTH_TIERS.length);
  DEEP_SONAR_LENGTH_TIERS.forEach((tier, i) => {
    const sold = EQUIPMENT_TIERS.sonar[i];
    assert.equal(sold.level, tier.level);
    assert.equal(sold.cost, tier.upgradeCost);
    assert.ok(sold.effect.startsWith(`${tier.length} m cable · ${tier.nodes} `), sold.effect);
  });
});

test('pulse nodes share geometry that is disposed once, and only on rebuild', () => {
  const sonar = new DeepSonar({ lengthLevel: 2, detail: 2 });
  const nodeGroup = sonar.group.children[2];
  const shared = new Set(nodeGroup.children.map((mesh) => mesh.geometry));
  assert.equal(shared.size, 2, 'one node shape and one glow shape');
  const disposed = new Map();
  const all = new Set();
  sonar.group.traverse((object) => object.isMesh && all.add(object.geometry));
  for (const geometry of all) geometry.addEventListener('dispose', () => disposed.set(geometry, (disposed.get(geometry) ?? 0) + 1));
  sonar.setColor('#42e8d2'); // unchanged: no rebuild
  sonar.setLengthLevel(2);
  sonar.setDetail(2);
  assert.equal(disposed.size, 0, 'nothing is torn down while still on screen');
  assert.equal(sonar.group.children[2], nodeGroup);
  sonar.setColor('#ff6a45');
  for (const geometry of all) assert.equal(disposed.get(geometry), 1, 'every old geometry, shared ones included, disposed exactly once');
  for (const mesh of sonar.group.children[2].children) assert.ok(!shared.has(mesh.geometry), 'the rebuilt nodes use fresh geometry');
  sonar.setDetail(1);
  assert.equal(sonar.nodeCount, DEEP_SONAR_LENGTH_TIERS[1].nodes - 1, 'low quality drops one node');
  sonar.dispose();
});

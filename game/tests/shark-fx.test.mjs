import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

async function moduleUrl(file, imports = {}) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  outputText = outputText.replace("from 'three'", `from '${import.meta.resolve('three')}'`);
  for (const [name, url] of Object.entries(imports)) outputText = outputText.replace(`from '${name}'`, `from '${url}'`);
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const { SharkFx } = await import(await moduleUrl('../src/shark-fx.ts'));
const haze = await moduleUrl('../src/underwater-haze.ts');
const { SceneColorGrade } = await import(await moduleUrl('../src/color-grade.ts', { './underwater-haze': haze }));
const shark = (mode = 'patrol', x = 0) => ({ mode, x, y: -25, vx: 5, vy: 0 });
const body = root => root.children[0].children[0];

test('only the charging shark opens its jaw and warms its skin; cues ease after the chase', () => {
  const fx = new SharkFx(new THREE.Scene());
  const hunters = [shark('charge'), shark('patrol', 10)];
  fx.update(1 / 60, hunters, 0, 1, true);
  const [a, b] = fx.group.children;
  assert.notEqual(body(a).material, body(b).material, 'attack state is per shark');
  assert.ok(body(a).material.emissive.r > body(b).material.emissive.r);
  assert.ok(a.children[0].children[2].rotation.z < b.children[0].children[2].rotation.z);
  for (let i = 0; i < 180; i++) fx.update(1 / 60, hunters, 0, 1, true);
  const hot = body(a).material.emissive.r;
  hunters[0].mode = 'patrol';
  fx.update(1 / 60, hunters, 0, 1, true);
  assert.ok(body(a).material.emissive.r < hot);
  assert.ok(body(a).material.emissive.r > body(b).material.emissive.r, 'cooling is gradual');
  fx.update(1 / 60, hunters, 0, 0, false);
  assert.equal(fx.uniforms.uSharkEffects.value, 0);
  assert.equal(fx.uniforms.uSharkNight.value, 0);
});

test('lighting composes with the scene color grade and keeps fog and standard lighting', () => {
  const fx = new SharkFx(new THREE.Scene());
  new SceneColorGrade().apply(fx.group);
  const material = body(fx.group.children[0]).material;
  const shader = {
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    uniforms: {},
  };
  material.onBeforeCompile(shader, {});
  assert.ok(shader.fragmentShader.includes('sharkCaustic'));
  assert.ok(shader.fragmentShader.includes('uGradeShadows'));
  assert.ok(shader.fragmentShader.includes('float fogFactor = mix(baseFog, waterBlend'));
  assert.ok(shader.fragmentShader.includes('#include <lights_fragment_begin>'));
  assert.ok(shader.vertexShader.includes('vSharkWorld = (modelMatrix'));
  assert.equal(shader.uniforms.uSharkTime, fx.uniforms.uSharkTime);
  assert.match(material.customProgramCacheKey(), /shark-water-light-v1\|underwater-haze-v1\|day-color-grade-v1/);
});

test('a reused render slot starts at its new shark instead of the old depth and attack pose', () => {
  const fx = new SharkFx(new THREE.Scene());
  fx.update(1, [shark('charge')], 1, 1, true);
  fx.clear();
  assert.ok(fx.group.children.every(root => !root.visible));
  const replacement = shark('patrol', 30);
  fx.update(1 / 60, [replacement], 0, 0, true);
  const root = fx.group.children[0];
  assert.equal(root.position.x, 30);
  assert.equal(root.position.z, -1.5);
  assert.equal(root.scale.x, 1);
  assert.equal(root.children[0].children[2].rotation.z, -0.04);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

async function load(file) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  outputText = outputText.replace("from 'three'", `from '${import.meta.resolve('three')}'`);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const { SurfaceTextures } = await load('surface-textures');
const { RENDER_QUALITY } = await load('render-quality');

test('high-only textures switch existing and new materials together without recompiling or loading images', () => {
  const textures = new SurfaceTextures();
  const materials = ['rock', 'sand'].map(kind => textures.material(kind, '#ffffff', { vertexColors: true }));
  const shaders = materials.map(material => {
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
    material.onBeforeCompile(shader, {});
    return shader;
  });
  const versions = materials.map(material => material.version);
  for (const [quality, enabled] of [['high', 1], ['medium', 0], ['low', 0], ['high', 1]]) {
    textures.setQuality(RENDER_QUALITY[quality]);
    for (const shader of shaders) assert.equal(shader.uniforms.uSurfaceTextures.value, enabled);
    assert.deepEqual(materials.map(material => material.version), versions);
  }
  for (const material of materials) {
    assert.equal(material.map, null);
    assert.equal(material.flatShading, true);
    assert.equal(material.vertexColors, true);
  }
});

test('UV-free rock and sand shaders have distinct detail, distance filtering and shared quality state', () => {
  const textures = new SurfaceTextures();
  const shaders = ['rock', 'sand'].map(kind => {
    const material = textures.material(kind, '#808080');
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
    material.onBeforeCompile(shader, {});
    assert.equal(shader.uniforms.uSurfaceTextures, textures.uniforms.uSurfaceTextures);
    assert.match(shader.vertexShader, /modelMatrix \* texturePosition/);
    assert.match(shader.fragmentShader, /fwidth\(p\)/);
    assert.match(shader.fragmentShader, /roughnessFactor = clamp/);
    assert.ok(!shader.fragmentShader.includes('texture2D'));
    return shader;
  });
  assert.match(shaders[0].fragmentShader, /float strata/);
  assert.match(shaders[1].fragmentShader, /float ripple/);
});

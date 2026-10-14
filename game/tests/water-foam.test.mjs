import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

async function moduleUrl(file, imports = {}) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [name, url] of Object.entries({ three: import.meta.resolve('three'), ...imports })) outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const foam = await moduleUrl('water-foam'), storm = await moduleUrl('storm');
const rng = await moduleUrl('rng'), odds = await moduleUrl('depth-odds'), marine = await moduleUrl('marine'), i18n = await moduleUrl('i18n');
const fish = await moduleUrl('fish', { './rng': rng, './depth-odds': odds, './marine': marine, './i18n': i18n });
const fx = await moduleUrl('fx');
const lowpoly = await moduleUrl('lowpoly', { 'three/examples/jsm/utils/BufferGeometryUtils.js': import.meta.resolve('three/examples/jsm/utils/BufferGeometryUtils.js') });
const { StormFx } = await import(await moduleUrl('storm-fx', { './fish': fish, './fx': fx, './lowpoly': lowpoly, './storm': storm, './water-foam': foam }));
const { WaterSurfaceMaterial } = await import(await moduleUrl('water', { './storm': storm, './water-foam': foam }));
const { whitecapStrength, foamEnvelope, foamGeometry } = await import(foam);
const { DayCycle } = await import(await moduleUrl('daylight'));
const { RENDER_QUALITY } = await import(await moduleUrl('render-quality'));

const matrix = new THREE.Matrix4();
function live(mesh) {
  const output = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    matrix.decompose(p, q, s);
    if (s.x > 1e-6) output.push({ i, p, q, s });
  }
  return output;
}

test('whitecaps stay sparse on calm lakes and strengthen smoothly with wind and swell', () => {
  assert.equal(whitecapStrength(0.3, 0.15), 0);
  assert.ok(whitecapStrength(0.5, 0.15) < whitecapStrength(1, 0.15));
  let previous = 0;
  for (let wind = 0; wind <= 1; wind += 0.01) {
    const value = whitecapStrength(1, wind);
    assert.ok(value >= previous && value <= 1);
    previous = value;
  }
  assert.equal(whitecapStrength(2, 1), 1);
});

test('foam rises gently, holds briefly and dissolves to zero without a hard lifetime cutoff', () => {
  assert.equal(foamEnvelope(0, 4), 0);
  assert.ok(foamEnvelope(0.2, 4) > 0 && foamEnvelope(0.2, 4) < 1);
  assert.equal(foamEnvelope(1, 4), 1);
  assert.ok(foamEnvelope(3, 4) > 0 && foamEnvelope(3, 4) < 0.5);
  assert.ok(foamEnvelope(3.999, 4) < 1e-6);
  assert.equal(foamEnvelope(4, 4), 0);
  assert.equal(foamEnvelope(6, 4), 0);
});

test('the foam patch is a flat surface with per-instance opacity, not a floating solid', () => {
  const opacity = new Float32Array(48);
  const geometry = foamGeometry(opacity);
  for (let i = 0; i < geometry.attributes.position.count; i++) assert.ok(Math.abs(geometry.attributes.position.getY(i)) < 1e-6);
  assert.equal(geometry.attributes.aFoamOpacity.array, opacity);
  assert.ok(geometry.attributes.aFoamOpacity.isInstancedBufferAttribute);
  geometry.dispose();
});

test('boat foam drifts, follows the water tangent and expands while it fades', () => {
  const scene = new THREE.Scene(), effects = new StormFx(scene);
  const water = (x, z) => 0.4 + x * 0.22 - z * 0.15;
  effects.boatWake(0.1, 0, 0, 0.5, 0, 0.1, water);
  effects.update(0.35, 0.35, null, 1, 0, water);
  const mesh = scene.getObjectByName('surface-foam-trail');
  const before = live(mesh)[0];
  assert.ok(before);
  assert.ok(Math.abs(before.p.y - water(before.p.x, before.p.z) - 0.045) < 1e-5);
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(before.q);
  assert.ok(normal.distanceTo(new THREE.Vector3(-0.22, 1, 0.15).normalize()) < 1e-5);
  const initialOpacity = mesh.geometry.attributes.aFoamOpacity.getX(before.i);
  effects.update(1.4, 1.75, null, 1, 0, water);
  const after = live(mesh).find(p => p.i === before.i);
  assert.ok(after.s.x > before.s.x, 'the patch spreads');
  assert.ok(after.p.distanceTo(before.p) > 0.1, 'it drifts with the wake');
  assert.ok(mesh.geometry.attributes.aFoamOpacity.getX(after.i) < initialOpacity, 'opacity dissolves separately from size');
  effects.update(8, 9.75, null, 1, 0, water);
  assert.equal(mesh.visible, false);
  assert.equal(live(mesh).length, 0);
});

test('rogue-wave foam rides the crest instead of tumbling, and spray stretches along its trajectory', () => {
  const scene = new THREE.Scene(), effects = new StormFx(scene);
  const water = (x, z) => Math.sin(x * 0.15) * 0.5 + Math.cos(z * 0.2) * 0.3;
  effects.burst(0, 1, 0, 12, 2, 4);
  effects.update(0.1, 0.1, 0, 1, 3.2, water);
  const crest = scene.getObjectByName('wave-crest-foam'), drops = scene.getObjectByName('wave-spray');
  assert.equal(crest.visible, true);
  for (const piece of live(crest)) assert.ok(Math.abs(piece.p.y - water(piece.p.x, piece.p.z) - 0.045) < 1e-5);
  assert.ok(live(drops).length >= 12);
  for (const piece of live(drops)) assert.ok(piece.s.y > piece.s.x * 2.6);
  assert.equal(crest.renderOrder, 2, 'foam draws above the transparent water');
  assert.equal(crest.material.depthWrite, false);
});

test('foam pools stay bounded, clear all state and dim their emission at night', () => {
  const scene = new THREE.Scene(), effects = new StormFx(scene), water = () => 0;
  const count = effects.group.children.length;
  for (let i = 0; i < 600; i++) {
    effects.boatWake(1 / 30, i / 30, Math.sin(i * 0.3), Math.cos(i * 0.4), 0, 0.1, water);
    effects.update(1 / 30, i / 30, 0, 1, 3.2, water);
  }
  assert.equal(effects.group.children.length, count);
  assert.ok(effects.livePatches <= 48 && effects.liveDrops <= 320);
  const crest = scene.getObjectByName('wave-crest-foam');
  const day = crest.material.emissiveIntensity;
  effects.update(1 / 30, 21, 0, 1, 3.2, water, 1);
  assert.ok(crest.material.emissiveIntensity < day / 3);
  effects.clear();
  for (const name of ['wave-crest-foam', 'wave-spray', 'surface-foam-trail']) {
    const mesh = scene.getObjectByName(name);
    assert.equal(mesh.visible, false);
    assert.equal(live(mesh).length, 0);
    if (mesh.geometry.attributes.aFoamOpacity) assert.ok(mesh.geometry.attributes.aFoamOpacity.array.every(v => v === 0));
  }
  assert.equal(effects.emit, 0);
});

test('surface foam uses the displacement coordinates and follows wave strength, daylight and effect settings', () => {
  const material = new WaterSurfaceMaterial();
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  material.onBeforeCompile(shader, {});
  const day = new DayCycle(180, 12).state;
  material.update(5, day, 3, RENDER_QUALITY.high, { wind: 0.15, cloud: 0 }, 0.3);
  assert.equal(shader.uniforms.uWaterFoamStrength.value, 0);
  const daylight = shader.uniforms.uWaterFoamLight.value;
  material.update(5, new DayCycle(180, 0).state, 3, RENDER_QUALITY.low, { wind: 1, cloud: 1 }, 2);
  assert.equal(shader.uniforms.uWaterFoamStrength.value, 1);
  assert.ok(shader.uniforms.uWaterFoamLight.value < daylight * 0.45, 'clouded nighttime foam stays subdued');
  material.setEffectsEnabled(false);
  assert.equal(shader.uniforms.uWaterEffects.value, 0);
  material.update(5, day, -5, RENDER_QUALITY.high);
  assert.equal(shader.uniforms.uWaterAbove.value, 0, 'surface foam fades out from below');
  assert.match(shader.vertexShader, /vWaterSurface = transformed/);
  assert.match(shader.fragmentShader, /sin\(vWaterSurface.x \* 0.15/);
});

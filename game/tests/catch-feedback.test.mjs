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
const fxUrl = await moduleUrl('../src/fx.ts');
const { CatchFeedback, catchTarget } = await import(await moduleUrl('../src/catch-feedback.ts', { './fx': fxUrl }));
const point = new THREE.Vector3(3, -12, 0);
const fish = (x, y, z = 0) => ({ pos: new THREE.Vector3(x, y, z) });

test('the target is exactly the fish a planar net throw catches, with a strict reach boundary', () => {
  const near = fish(3.2, -12, 8);
  const far = fish(3.7, -12);
  const outside = fish(4, -12);
  const school = [far, near, outside];
  assert.equal(catchTarget(school, point, 1), near, 'visual depth does not change existing 2.5D catch rules');
  assert.equal(catchTarget([outside], point, 1), null);
  assert.equal(catchTarget([outside], point, 1.01), outside, 'upgraded reach is also used by the marker');
  assert.equal(catchTarget([near], point, 0), null);
  assert.equal(catchTarget([], point, 2), null);
  assert.deepEqual(school, [far, near, outside], 'targeting does not reorder the school');
  const equal = fish(3.7, -12);
  assert.equal(catchTarget([equal, far], point, 1), equal, 'ties retain the original throw order');
});

test('a target disappears immediately when it moves outside reach or the net is unavailable', () => {
  const feedback = new CatchFeedback(new THREE.Scene());
  const target = fish(3.2, -12);
  feedback.aim(catchTarget([target], point, 1)?.pos ?? null, '#4aa8ff');
  feedback.update(0.1, true, 2);
  assert.equal(feedback.rings.visible, true);
  target.pos.x = 5;
  feedback.aim(catchTarget([target], point, 1)?.pos ?? null);
  feedback.update(0.1, true, 2);
  assert.equal(feedback.rings.visible, false);
  feedback.aim(point);
  feedback.update(0, true, 2);
  feedback.aim(null); // Full net / cooldown / leaving a dive.
  feedback.update(0, true, 2);
  assert.equal(feedback.rings.visible, false);
  feedback.dispose();
});

test('catch and banking pulses expire, pause with simulation time, and release their particles', () => {
  const scene = new THREE.Scene();
  const feedback = new CatchFeedback(scene);
  feedback.burst('catch', point, '#b46cff', 2);
  feedback.update(0.1, true, 2);
  assert.ok(feedback.sparks.count > 0);
  const count = feedback.sparks.count;
  feedback.update(0, true, 2);
  assert.equal(feedback.sparks.count, count, 'pause does not advance effects');
  feedback.update(1, true, 2);
  assert.equal(feedback.rings.visible, false);
  assert.equal(feedback.sparks.count, 0);
  feedback.burst('bank', point, '#ffb340', 3);
  feedback.update(0.1, true, 2);
  assert.ok(feedback.rings.visible && feedback.sparks.count > count);
  feedback.clear();
  assert.equal(feedback.rings.visible, false);
  assert.equal(feedback.sparks.count, 0);
  feedback.update(0, true, 2);
  assert.equal(feedback.rings.visible, false, 'a new dive never revives an old pulse');
  feedback.aim(point);
  feedback.update(0, true, 2);
  const timing = feedback.rings.geometry.attributes.aTiming;
  const targetSlots = Array.from({ length: timing.count }, (_, i) => timing.getZ(i)).filter(kind => kind === 0);
  assert.equal(targetSlots.length, 1, 'acquiring a new fish cannot show markers at previous catch positions');
  feedback.dispose();
  assert.equal(scene.children.length, 0);
});

test('lighting and reduced-motion settings suppress decorative pulses but retain the static reach cue', () => {
  for (const [effects, reduced] of [[false, false], [true, true]]) {
    const feedback = new CatchFeedback(new THREE.Scene());
    feedback.burst('bank', point, '#ffb340');
    feedback.aim(point);
    feedback.update(0.1, effects, 1, reduced);
    assert.equal(feedback.rings.visible, true);
    assert.equal(feedback.rings.material.uniforms.uMotion.value, 0);
    assert.equal(feedback.sparks.count, 0);
    feedback.burst('catch', point, '#4aa8ff');
    feedback.aim(null);
    feedback.update(0.01, true, 1, false);
    assert.equal(feedback.rings.visible, false, 'suppressed pulses do not reappear when effects are re-enabled');
    feedback.dispose();
  }
});

test('repeated throws reuse bounded pools and an empty or full net does not emit reward sparks', () => {
  const feedback = new CatchFeedback(new THREE.Scene());
  feedback.burst('miss', point, '#8fbfc9');
  feedback.burst('full', point, '#ffb340');
  feedback.update(0.1, true, 1);
  assert.ok(feedback.rings.visible);
  assert.equal(feedback.sparks.count, 0);
  const geometry = feedback.rings.geometry;
  const rings = feedback.rings.count;
  for (let i = 0; i < 1000; i++) feedback.burst('catch', point, '#5fd38d', 3);
  assert.equal(feedback.rings.geometry, geometry);
  assert.equal(feedback.rings.count, rings);
  assert.equal(feedback.group.children.length, 2);
  assert.ok(feedback.sparks.count <= 64);
  feedback.update(2, true, 1);
  assert.equal(feedback.sparks.count, 0);
  assert.equal(feedback.rings.visible, false);
  feedback.dispose();
});

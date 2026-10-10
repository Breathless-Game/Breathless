import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

// Load the real Three.js scene objects without needing WebGL or a browser.
// Resolve imports before using data URLs, as in the other pure TypeScript tests.
async function moduleUrl(file, dependencies = {}) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [specifier, url] of Object.entries({ three: import.meta.resolve('three'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url));
    outputText = outputText.replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}

const gearUrl = await moduleUrl('gear');
const { Diver } = await import(await moduleUrl('diver', { './gear': gearUrl }));
const { RENDER_QUALITY } = await import(await moduleUrl('render-quality'));
const rngUrl = await moduleUrl('rng');
const { Fish, ZONES, rollFish } = await import(await moduleUrl('fish', { './rng': rngUrl }));

function createDiver(quality = RENDER_QUALITY.high, y = -20) {
  const scene = new THREE.Scene();
  const diver = new Diver(scene);
  diver.pos.set(3, y, 1);
  diver.setQuality(quality);
  return { scene, diver };
}

function bubbles(scene) {
  // Bubbles are world-space particles; the entire diver model is in its group.
  return scene.children.filter(child => child.isMesh);
}

function withFixedRandom(run) {
  const original = Math.random;
  Math.random = () => 0.5;
  try {
    return run();
  } finally {
    Math.random = original;
  }
}

function simulate(diver, seconds, fps = 120, startTime = 0) {
  for (let frame = 1; frame <= Math.round(seconds * fps); frame++) {
    diver.update(1 / fps, startTime + frame / fps, -diver.pos.y);
  }
}

test('quality budgets limit emitted particles and repeated bursts cannot exceed the cap', () => {
  const burstCounts = [];
  for (const quality of Object.values(RENDER_QUALITY)) {
    const { scene, diver } = createDiver(quality);
    diver.exhale(8);
    const emitted = bubbles(scene).length;
    burstCounts.push(emitted);
    assert.ok(emitted > 0 && emitted <= 8);
    diver.exhale(1000);
    assert.equal(bubbles(scene).length, quality.bubbleLimit);
    diver.exhale(1000);
    assert.equal(bubbles(scene).length, quality.bubbleLimit);
  }
  assert.ok(burstCounts[0] < burstCounts[1] && burstCounts[1] < burstCounts[2]);
});

test('changing quality rebinds live meshes before disposing shared geometry and trims old particles', () => {
  const { scene, diver } = createDiver();
  diver.exhale(1000);
  const before = bubbles(scene);
  const highGeometry = before[0].geometry;
  let highDisposals = 0;
  highGeometry.addEventListener('dispose', () => {
    highDisposals++;
    assert.ok(bubbles(scene).every(mesh => mesh.geometry !== highGeometry));
  });

  diver.setQuality(RENDER_QUALITY.low);
  const after = bubbles(scene);
  assert.equal(after.length, RENDER_QUALITY.low.bubbleLimit);
  assert.equal(highDisposals, 1);
  assert.deepEqual(after, before.slice(-after.length), 'oldest particles leave the scene first');
  assert.ok(before.slice(0, -after.length).every(mesh => mesh.parent === null));
  const lowGeometry = after[0].geometry;
  assert.ok(after.every(mesh => mesh.geometry === lowGeometry));
  assert.ok(lowGeometry.attributes.position.count < highGeometry.attributes.position.count);

  let lowDisposals = 0;
  lowGeometry.addEventListener('dispose', () => lowDisposals++);
  diver.setQuality(RENDER_QUALITY.medium);
  assert.equal(lowDisposals, 0, 'equal detail levels reuse the shared geometry');
  diver.setQuality(RENDER_QUALITY.high);
  assert.equal(lowDisposals, 1);
  assert.ok(after.every(mesh => mesh.geometry !== lowGeometry && mesh.parent === scene));
});

test('a zero particle budget removes the existing plume and prevents future emissions', () => {
  const { scene, diver } = createDiver();
  diver.exhale();
  const before = bubbles(scene);
  assert.ok(before.length > 0);
  diver.setQuality({ ...RENDER_QUALITY.low, bubbleLimit: 0 });
  assert.equal(bubbles(scene).length, 0);
  assert.ok(before.every(mesh => mesh.parent === null));
  diver.exhale(100);
  assert.equal(bubbles(scene).length, 0);
});

test('an exhale follows the current position and rotated breath anchor before the next frame', () => {
  withFixedRandom(() => {
    const { scene, diver } = createDiver();
    const body = diver.group.children.find(child => child.isGroup);
    diver.group.rotation.y = Math.PI;
    body.rotation.z = -0.4;
    diver.pos.set(-7, -12, 4);
    // Read the transformed anchor independently at the requested physics position.
    diver.group.position.copy(diver.pos);
    diver.group.updateMatrixWorld(true);
    const expected = diver.breathPoint.getWorldPosition(new THREE.Vector3());
    diver.group.position.set(0, 0, 0); // Simulate a stale render transform.

    diver.exhale(1);
    const [particle] = bubbles(scene);
    assert.ok(particle);
    assert.ok(particle.position.distanceTo(expected) < 1e-9);
    assert.ok(particle.position.x < diver.pos.x, 'the plume follows the left-facing head');
  });
});

test('breathing above water does not create underwater particles', () => {
  const { scene, diver } = createDiver(RENDER_QUALITY.high, 2);
  diver.exhale(100);
  assert.equal(bubbles(scene).length, 0);
});

test('buoyancy moves bubbles upward with increasing speed and expired bubbles leave the scene', () => {
  withFixedRandom(() => {
    const { scene, diver } = createDiver();
    diver.exhale(1);
    const [particle] = bubbles(scene);
    const startY = particle.position.y;
    simulate(diver, 0.5);
    const firstRise = particle.position.y - startY;
    const middleY = particle.position.y;
    simulate(diver, 0.5, 120, 0.5);
    const secondRise = particle.position.y - middleY;
    assert.ok(firstRise > 0);
    assert.ok(secondRise > firstRise, 'buoyancy accelerates the rising particle');
    assert.equal(particle.parent, scene);
    simulate(diver, 4, 120, 1);
    assert.equal(bubbles(scene).length, 0);
    assert.equal(particle.parent, null);
  });
});

test('a bubble reaching the surface is removed before its deep-water lifetime ends', () => {
  withFixedRandom(() => {
    const { scene, diver } = createDiver(RENDER_QUALITY.high, -1);
    diver.exhale(1);
    const [particle] = bubbles(scene);
    assert.ok(particle.position.y < 0);
    simulate(diver, 1);
    assert.equal(bubbles(scene).length, 0);
    assert.equal(particle.parent, null);
  });
});

test('lower particle update rates preserve buoyant travel over the same elapsed time', () => {
  withFixedRandom(() => {
    const particles = [];
    for (const quality of Object.values(RENDER_QUALITY)) {
      const { scene, diver } = createDiver(quality);
      diver.exhale(2);
      const [particle] = bubbles(scene);
      simulate(diver, 1);
      assert.equal(particle.parent, scene);
      particles.push(particle.position.clone());
    }
    for (const position of particles) {
      assert.ok(Math.abs(position.y - particles[2].y) < 0.02);
    }
  });
});

test('head direction follows ascent and descent when swimming either left or right', () => {
  for (const horizontal of [-3, 3]) {
    for (const vertical of [-2, 2]) {
      const { diver } = createDiver();
      diver.vel.set(horizontal, vertical, 0);
      simulate(diver, 3);
      diver.group.updateMatrixWorld(true);
      const body = diver.group.children.find(child => child.isGroup);
      const heading = new THREE.Vector3(1, 0, 0).transformDirection(body.matrixWorld);
      assert.ok(heading.x * horizontal > 0, `head faces the horizontal travel direction ${horizontal}`);
      assert.ok(heading.y * vertical > 0, `head follows vertical travel ${vertical}, facing ${horizontal}`);
    }
  }
});

test('stroke animation stays continuous when speed changes late in a session', () => {
  const { diver } = createDiver();
  diver.vel.set(2, 0, 0);
  simulate(diver, 0.5, 120, 1000);
  const before = diver.legL.rotation.z;
  diver.vel.set(2.1, 0, 0);
  diver.update(1 / 120, 1000.5 + 1 / 120, 20);
  assert.ok(Math.abs(diver.legL.rotation.z - before) < 0.05);
});

test('the headlamp remains attached to the rotating head in deep water', () => {
  const { diver } = createDiver(RENDER_QUALITY.high, -40);
  diver.vel.set(-3, -2, 0);
  simulate(diver, 2);
  diver.group.updateMatrixWorld(true);
  const light = diver.headlamp.getWorldPosition(new THREE.Vector3());
  const breath = diver.breathPoint.getWorldPosition(new THREE.Vector3());
  assert.ok(light.distanceTo(breath) < 0.5);
  assert.ok(diver.headlamp.intensity > 0);
});

function createFish(seed = 42, zone = ZONES[1]) {
  const y = -(zone.top + zone.bottom) / 2;
  const fish = new Fish(rollFish(seed, zone, -y), zone, 0, y, 140);
  fish.pos.z = 0;
  return fish;
}

test('a fish overlapping the diver flees in its existing direction instead of stopping', () => {
  for (const facing of [-1, 0, 1]) {
    const fish = createFish();
    fish.facing = facing;
    const overlap = fish.pos.clone();
    fish.update(1 / 60, 0, overlap);
    assert.ok(fish.pos.distanceTo(overlap) > 0);
    assert.ok(fish.vel.x * (facing || 1) > 0, 'an overlap retains the escape direction');
    assert.ok(fish.pos.x * (facing || 1) > 0);
  }
});

test('fish transforms stay finite while wandering, fleeing, and repeatedly overlapping the diver', () => {
  for (const [index, zone] of ZONES.entries()) {
    const fish = createFish(42 + index, zone);
    const diverPos = new THREE.Vector3();
    for (let frame = 0; frame < 360; frame++) {
      if (frame % 20 === 0) {
        diverPos.copy(fish.pos);
      } else if (frame % 20 < 10) {
        diverPos.copy(fish.pos).add(new THREE.Vector3(0.01, 0.01, 0));
      } else {
        diverPos.set(500, 0, 0);
      }
      fish.update(1 / 60, frame / 60, diverPos);
      assert.ok([...fish.pos, ...fish.vel].every(Number.isFinite));
      fish.mesh.group.updateMatrixWorld(true);
      fish.mesh.group.traverse(object => {
        assert.ok(object.matrixWorld.elements.every(Number.isFinite), `finite ${object.type} transform`);
      });
    }
  }
});

test('fish head direction follows upward and downward swimming while facing left or right', () => {
  const distantDiver = new THREE.Vector3(500, 0, 0);
  for (const horizontal of [-3, 3]) {
    for (const vertical of [-2, 2]) {
      const fish = createFish();
      fish.target.copy(fish.pos).add(new THREE.Vector3(horizontal * 10, vertical * 10, 0));
      for (let frame = 0; frame < 180; frame++) fish.update(1 / 60, frame / 60, distantDiver);
      assert.ok(fish.vel.x * horizontal > 0 && fish.vel.y * vertical > 0);
      fish.mesh.group.updateMatrixWorld(true);
      const heading = new THREE.Vector3(1, 0, 0).transformDirection(fish.mesh.group.matrixWorld);
      assert.ok(heading.x * horizontal > 0, `fish faces horizontal travel ${horizontal}`);
      assert.ok(heading.y * vertical > 0, `fish follows vertical travel ${vertical}, facing ${horizontal}`);
    }
  }
});

test('fish stay inside the expanded ±140 corridor at both new map edges', () => {
  for (const edge of [-1, 1]) {
    const fish = createFish(100 + edge);
    fish.pos.x = edge * 141;
    fish.target.set(edge * 1000, fish.pos.y, fish.pos.z);
    fish.update(1 / 60, 0, new THREE.Vector3(500 * edge, 0, 0));
    assert.ok(Math.abs(fish.pos.x) <= 140);
    assert.ok(Number.isFinite(fish.mesh.group.position.x));
  }
});

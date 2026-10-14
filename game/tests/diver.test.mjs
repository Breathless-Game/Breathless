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

const fxUrl = await moduleUrl('fx');
const lampLightingUrl = await moduleUrl('lamp-lighting');
const lampUpgradesUrl = await moduleUrl('lamp-upgrades', { './lamp-lighting': lampLightingUrl });
const conceptUrl = await moduleUrl('diver-designs');
const commonUrl = await moduleUrl('upgrade-models/common');
const netUrl = await moduleUrl('upgrade-models/net', { './common': commonUrl, 'three/addons/utils/BufferGeometryUtils.js': import.meta.resolve('three/addons/utils/BufferGeometryUtils.js') });
const gearUrl = await moduleUrl('gear', { './upgrade-models/net': netUrl, 'three/addons/utils/BufferGeometryUtils.js': import.meta.resolve('three/addons/utils/BufferGeometryUtils.js') });
const { buildMountedNetHead } = await import(gearUrl);
const { buildNetHead } = await import(netUrl);
const divingUrl = await moduleUrl('upgrade-models/diving', { './common': commonUrl });
const headlampUrl = await moduleUrl('headlamp-model', { './upgrade-models/diving': divingUrl, 'three/addons/utils/BufferGeometryUtils.js': import.meta.resolve('three/addons/utils/BufferGeometryUtils.js') });
const { buildHeadlamp } = await import(headlampUrl);
const { buildLamp } = await import(divingUrl);
const { Diver } = await import(await moduleUrl('diver', { './gear': gearUrl, './fx': fxUrl, './lamp-lighting': lampLightingUrl, './lamp-upgrades': lampUpgradesUrl, './diver-designs': conceptUrl, './headlamp-model': headlampUrl }));
const { RENDER_QUALITY } = await import(await moduleUrl('render-quality'));
const rngUrl = await moduleUrl('rng');
const depthOddsUrl = await moduleUrl('depth-odds');
const marineUrl = await moduleUrl('marine');
const i18nUrl = await moduleUrl('i18n');
const { Fish, ZONES, rollFish } = await import(await moduleUrl('fish', { './rng': rngUrl, './depth-odds': depthOddsUrl, './marine': marineUrl, './i18n': i18nUrl }));

function createDiver(quality = RENDER_QUALITY.high, y = -20) {
  const scene = new THREE.Scene();
  const diver = new Diver(scene);
  diver.pos.set(3, y, 1);
  diver.setQuality(quality);
  return { scene, diver };
}

function bubbles(scene) {
  // Bubbles are world-space particles; the entire diver model is in its group,
  // and the white water it throws is one instanced mesh.
  return scene.children.filter(child => child.isMesh && !child.isInstancedMesh);
}

/** Where every live piece of white water (droplet or foam chip) is right now. */
function whiteWater(scene) {
  const mesh = scene.getObjectByName('diver-water-splash');
  const matrix = new THREE.Matrix4();
  const live = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    if (matrix.elements[0] !== 0 || matrix.elements[1] !== 0 || matrix.elements[2] !== 0) {
      live.push(new THREE.Vector3().setFromMatrixPosition(matrix));
    }
  }
  return live;
}

/** Swim straight up or down at `speed` m/s (negative dives), as the game loop would move the diver. */
function swim(diver, speed, seconds, fps = 60) {
  diver.vel.set(0, speed, 0);
  for (let frame = 0; frame < Math.round(seconds * fps); frame++) {
    diver.pos.y = Math.min(-0.05, diver.pos.y + speed / fps);
    diver.update(1 / fps, frame / fps, -diver.pos.y);
  }
}

/** A diver that has floated at the surface long enough to settle. */
function createFloatingDiver(quality = RENDER_QUALITY.high) {
  const created = createDiver(quality, -0.05);
  simulate(created.diver, 1);
  return created;
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

test('mounted net heads preserve catalogue geometry with at most five frame and pocket meshes', () => {
  for (const level of [1, 2, 3]) {
    const raw = buildNetHead(level);
    raw.rotation.z = -Math.PI / 2;
    raw.position.y = raw.userData.socketOffset * raw.scale.x;
    const mounted = buildMountedNetHead(level);
    const expected = new THREE.Box3().setFromObject(raw, true);
    const actual = new THREE.Box3().setFromObject(mounted, true);
    assert.ok(actual.min.distanceTo(expected.min) < 1e-6);
    assert.ok(actual.max.distanceTo(expected.max) < 1e-6);
    let meshes = 0;
    mounted.traverse(object => {
      if (object.isMesh) {
        meshes++;
        assert.equal(object.material.emissive.getHex(), 0);
      }
      assert.equal(Boolean(object.isLineSegments), false, 'the pocket is lit nylon geometry');
    });
    assert.ok(meshes <= 5);
    assert.ok(mounted.getObjectByName('Nylon_Diamond_Web').isMesh);
    assert.ok(mounted.getObjectByName('Catch_Centre'));
    assert.ok(mounted.position.y < 0, 'the shaft attaches above the bag');
  }
});

test('net upgrades preserve the grip and reel, release replaced heads and resist shaft distortion', () => {
  const { diver } = createDiver();
  const arm = diver.netArm;
  const reel = diver.reelGroup;
  const old = diver.netMouth.children[0];
  const resources = new Set();
  old.traverse(object => { if (object.isMesh) { resources.add(object.geometry); resources.add(object.material); } });
  let freed = 0;
  resources.forEach(resource => resource.addEventListener('dispose', () => freed++));
  diver.setNetLevel(3);
  const head = diver.netMouth.children[0];
  assert.notEqual(head, old);
  assert.equal(head.userData.level, 3);
  assert.equal(diver.netArm.userData.level, 3);
  assert.equal(diver.netArm, arm);
  assert.equal(diver.reelGroup, reel);
  assert.equal(freed, resources.size);
  diver.setNetLevel(3);
  assert.equal(diver.netMouth.children[0], head);
  diver.setRodRange(1.2);
  diver.group.updateMatrixWorld(true);
  const before = new THREE.Box3().setFromObject(diver.netMouth).getSize(new THREE.Vector3());
  const tipBefore = diver.netPoint();
  diver.setRodRange(2.1);
  diver.group.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(diver.netMouth).getSize(new THREE.Vector3());
  assert.ok(before.distanceTo(after) < 1e-6, 'extending the shaft cannot flatten the net head');
  assert.ok(diver.netPoint().distanceTo(tipBefore) > 0.1);
  diver.setNetLevel(NaN);
  assert.equal(diver.netMouth.children[0].userData.level, 1);
  assert.ok(diver.netPoint().toArray().every(Number.isFinite));
});

test('the net pocket follows a swing and settles without moving its catch marker relative to the head', () => {
  const { diver } = createDiver();
  diver.setNetLevel(3);
  const marker = diver.netTip;
  const local = marker.position.clone();
  diver.swing();
  simulate(diver, 0.08);
  assert.ok(Math.abs(diver.netWeb.rotation.z) > 0.005);
  assert.deepEqual(marker.position, local);
  simulate(diver, 1);
  assert.equal(diver.netWeb.rotation.z, 0);
  assert.equal(diver.swinging, false);
});

test('late-created bubbles pass through the scene material binder', () => {
  const { diver } = createDiver();
  let bound = 0;
  diver.setMaterialBinder((root) => {
    bound++;
    assert.equal(root.type, 'Mesh');
  });
  diver.exhale(3);
  assert.equal(bound, 3);
});

test('floating at the surface and swimming deep show no white water, and no ring', () => {
  for (const y of [-0.05, -4]) {
    const { scene, diver } = createDiver(RENDER_QUALITY.high, y);
    simulate(diver, 2);
    const splash = scene.getObjectByName('diver-water-splash');
    assert.equal(splash.visible, false);
    assert.equal(whiteWater(scene).length, 0);
    assert.equal(diver.group.getObjectByName('diver-water-contact-ripple'), undefined);
  }
});

test('diving in throws a crown above the water, drags air under, and both clear', () => {
  const { scene, diver } = createFloatingDiver();
  const splash = scene.getObjectByName('diver-water-splash');
  swim(diver, -4.5, 0.2);
  assert.equal(splash.visible, true);
  const crown = whiteWater(scene);
  assert.ok(crown.length >= 12, `a visible burst, got ${crown.length}`);
  assert.ok(crown.every(position => position.y > 0 && Math.abs(position.x - diver.pos.x) < 3));
  assert.ok(crown.some(position => position.y > 0.3), 'droplets rise off the surface');
  const trail = bubbles(scene);
  assert.ok(trail.length > 0, 'the plunge drags air under');
  assert.ok(trail.every(bubble => bubble.position.y < 0));

  swim(diver, -4.5, 3);
  assert.equal(whiteWater(scene).length, 0);
  assert.equal(splash.visible, false, 'the pool hides once every droplet has fallen back');
  assert.equal(bubbles(scene).length, 0);
});

test('surfacing fast punches white water up at the head; drifting up does not', () => {
  for (const [speed, splashes] of [[7, true], [1, false]]) {
    const { scene, diver } = createDiver(RENDER_QUALITY.high, -4);
    diver.vel.set(1, speed, 0);
    simulate(diver, 0.5); // settle facing +x, pitched to the climb
    swim(diver, speed, 4.2 / speed);
    const burst = whiteWater(scene);
    assert.equal(burst.length > 0, splashes, `climbing at ${speed} m/s`);
    if (!splashes) continue;
    const middle = burst.reduce((sum, position) => sum + position.x, 0) / burst.length;
    const suitScale=diver.group.children[0].scale.x;
    const headX=diver.pos.x+0.9*suitScale*Math.cos(diver.group.children[0].rotation.z);
    const finsX=diver.pos.x-2*suitScale;
    assert.ok(Math.abs(middle-headX)<Math.abs(middle-finsX), 'the burst is nearer the scaled head than the fins');
    assert.ok(burst.some(position => position.y > 0.3));
  }
});

test('a faster crossing throws more, and lower quality throws less', () => {
  const thrown = (quality, speed) => withFixedRandom(() => {
    const { scene, diver } = createFloatingDiver(quality);
    swim(diver, -speed, 0.5 / speed);
    return whiteWater(scene).length + bubbles(scene).length;
  });
  assert.ok(thrown(RENDER_QUALITY.high, 1.6) < thrown(RENDER_QUALITY.high, 5));
  assert.ok(thrown(RENDER_QUALITY.low, 5) < thrown(RENDER_QUALITY.high, 5));
});

test('white water follows the waves: a swell is not a dive, and a dive splashes at its height', () => {
  const { scene, diver } = createFloatingDiver();
  let level = 0;
  diver.setWaterSurface(() => level);
  // A crest rolls over the floating diver and away again.
  for (let frame = 0; frame < 240; frame++) {
    level = 0.6 * Math.sin((frame / 240) * Math.PI);
    diver.update(1 / 60, frame / 60, -diver.pos.y);
  }
  assert.equal(whiteWater(scene).length, 0);

  level = 0.5;
  swim(diver, -4.5, 0.1);
  const crown = whiteWater(scene);
  assert.ok(crown.length > 0, 'the plunge still splashes after the swell');
  assert.ok(crown.every(position => position.y > 0.5), 'on the raised water, not at y = 0');
});

test('a swimmer heaved by heavy seas splashes where the picture is, not where the physics is', () => {
  const { scene, diver } = createFloatingDiver();
  let level = 0;
  diver.setWaterSurface(() => level);
  // The swell lifts the water and the drawn diver together by more than a head's depth.
  for (let frame = 0; frame < 240; frame++) {
    level = 1.5 * Math.sin((frame / 240) * Math.PI * 0.5);
    diver.update(1 / 60, frame / 60, -diver.pos.y, level);
  }
  assert.equal(whiteWater(scene).length, 0);
  assert.ok(level > 1.4 && Math.abs(diver.group.position.y - (diver.pos.y + level)) < 1e-9, 'the picture rides the crest');

  diver.vel.set(0, -4.5, 0);
  for (let frame = 0; frame < 6; frame++) {
    diver.pos.y -= 4.5 / 60;
    diver.update(1 / 60, 4 + frame / 60, -diver.pos.y, level);
  }
  const crown = whiteWater(scene);
  assert.ok(crown.length > 0, 'diving off the crest splashes at once');
  assert.ok(crown.every(position => position.y > level));
});

test('a respawn just under the surface floats up without a splash', () => {
  for (const level of [-0.25, 0, 0.25]) {
    const { scene, diver } = createFloatingDiver();
    diver.setWaterSurface(() => level);
    diver.pos.set(0, -0.4, 0);
    diver.vel.set(0, 0, 0);
    // The game loop's buoyancy and drag near the surface (see update() in main.ts).
    for (let frame = 0; frame < 120; frame++) {
      diver.vel.y = (diver.vel.y + 6 / 60) * Math.exp(-2.4 / 60);
      diver.pos.y = Math.min(-0.05, diver.pos.y + diver.vel.y / 60);
      diver.update(1 / 60, frame / 60, -diver.pos.y);
      assert.equal(whiteWater(scene).length, 0, `water at ${level}`);
    }
    assert.equal(bubbles(scene).length, 0);
  }
});

test('bubbles pop at the waves, not at y = 0', () => {
  withFixedRandom(() => {
    const { scene, diver } = createDiver(RENDER_QUALITY.high, -1);
    diver.setWaterSurface(() => -0.6);
    diver.exhale(1);
    const [particle] = bubbles(scene);
    simulate(diver, 0.5);
    assert.equal(particle.parent, null, 'a trough ends the bubble early');
    assert.ok(particle.position.y < 0);
  });
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

test('headlamp illuminates surfaces and the diver without beam geometry', () => {
  const { diver } = createDiver(RENDER_QUALITY.high, -24);
  diver.setLampStats(48, 102, 0.43, 0.075, 2, 0.24, 0.014);
  diver.setLampEnvironment(0, true);
  diver.update(1 / 60, 0, 24);
  const fill = diver.group.getObjectByName('diver-lamp-fill');
  assert.ok(fill.isPointLight);
  assert.ok(diver.headlamp.intensity > 0);
  assert.ok(fill.intensity > 0);
  assert.equal(diver.group.getObjectByName('diver-lamp-scatter'), undefined);
  assert.equal(diver.headlamp.decay, 2);
});

test('mounted lamps preserve catalogue geometry while batching hardware into at most twelve meshes', () => {
  for (const path of ['focus', 'wideLamp']) for (const level of [1, 2, 3]) {
    const { group, origin, emitters } = buildHeadlamp(level, path);
    const reference = new THREE.Box3().setFromObject(buildLamp(level, path));
    const bounds = new THREE.Box3().setFromObject(group);
    assert.ok(bounds.min.distanceTo(reference.min) < 1e-6);
    assert.ok(bounds.max.distanceTo(reference.max) < 1e-6);
    assert.ok(group.children.length <= 12, `Lv${level} draw-call budget`);
    assert.equal(emitters.length, level === 3 && path === 'wideLamp' ? 2 : 1);
    assert.ok(origin.z > 0.5 && origin.x === 0);
  }
});

test('skin changes move the existing lamp, net and breath anchor without disposing their resources', () => {
  const { diver } = createDiver();
  diver.setLampLevel(3, 'wideLamp');
  const lamp = diver.group.getObjectByName('diver-headlamp-hardware');
  let disposals = 0;
  lamp.traverse(object => {
    if (object.isMesh) {
      object.geometry.addEventListener('dispose', () => disposals++);
      object.material.addEventListener('dispose', () => disposals++);
    }
  });
  const netMaterial = diver.netArm.getObjectByProperty('isMesh', true).material;
  netMaterial.addEventListener('dispose', () => disposals++);
  for (const index of [1, 2, 0]) {
    diver.setSkin(index);
    const head = diver.group.getObjectByName('diver-head-frame');
    assert.equal(lamp.parent, head);
    assert.equal(diver.breathPoint.parent, head);
    assert.equal(diver.headlamp.parent.parent, head);
    assert.equal(diver.group.getObjectByName('diver-headlamp-hardware'), lamp);
    assert.equal(disposals, 0);
    diver.update(1 / 60, index, 20);
    diver.group.updateMatrixWorld(true);
    assert.ok(diver.headlamp.getWorldPosition(new THREE.Vector3()).distanceTo(diver.breathPoint.getWorldPosition(new THREE.Vector3())) < 0.5);
  }
});

test('same-tier specialisation changes replace hardware and optics only once', () => {
  const { diver } = createDiver();
  diver.setLampLevel(3, 'focus');
  const focused = diver.group.getObjectByName('diver-headlamp-hardware').children[0];
  const geometries = new Set();
  const materials = new Set();
  focused.traverse(object => {
    if (object.isMesh) { geometries.add(object.geometry); materials.add(object.material); }
  });
  let freed = 0;
  [...geometries, ...materials].forEach(resource => resource.addEventListener('dispose', () => freed++));
  diver.setLampLevel(3, 'wideLamp');
  const wide = diver.group.getObjectByName('diver-headlamp-hardware').children[0];
  assert.notEqual(wide, focused);
  assert.equal(wide.userData.lampPath, 'wideLamp');
  assert.equal(freed, geometries.size + materials.size);
  assert.equal(diver.headlamp.distance, 32);
  assert.equal(diver.headlamp.angle, 1.25);
  diver.setLampLevel(3, 'wideLamp');
  assert.equal(diver.group.getObjectByName('diver-headlamp-hardware').children[0], wide);
  diver.setLampLevel(1, 'wideLamp');
  assert.equal(diver.group.getObjectByName('diver-headlamp-hardware').children[0].userData.lampPath, 'focus');
  assert.equal(diver.headlamp.distance, 18);
});

test('lamp upgrades improve actual lighting and unequipped lamps emit no light', () => {
  const { diver } = createDiver();
  let range = 0, brightness = 0;
  for (const level of [1, 2, 3]) {
    diver.setLampLevel(level);
    diver.update(1 / 60, level, 50);
    assert.ok(diver.headlamp.distance > range);
    assert.ok(diver.headlamp.intensity > brightness);
    range = diver.headlamp.distance;
    brightness = diver.headlamp.intensity;
  }
  diver.setWorn({ fins: true, tank: false, lamp: false, net: true });
  diver.update(1 / 60, 4, 50);
  assert.equal(diver.headlamp.intensity, 0);
  assert.equal(diver.group.getObjectByName('diver-lamp-fill').intensity, 0);
  const anchor = diver.group.getObjectByName('diver-headlamp-origin');
  assert.ok(anchor.children.every(child => !child.isMesh));
});

test('headlamp replacement frees each owned resource once and leaves the selected skin intact', () => {
  const { diver } = createDiver();
  const lamp = diver.group.getObjectByName('diver-headlamp-hardware');
  const resources = new Set();
  const disposals = new Map();
  lamp.traverse(object => { if (object.isMesh) { resources.add(object.geometry); resources.add(object.material); } });
  for (const resource of resources) resource.addEventListener('dispose', () => disposals.set(resource, (disposals.get(resource) ?? 0) + 1));
  let skinDisposals = 0;
  diver.playtestModel.group.traverse(object => {
    if (object.isMesh && !lamp.getObjectById(object.id)) object.geometry.addEventListener('dispose', () => skinDisposals++);
  });
  diver.setLampLevel(2);
  for (const resource of resources) assert.equal(disposals.get(resource), 1);
  assert.equal(skinDisposals, 0);
  assert.equal(lamp.children[0].name, 'headlamp-level-2');
});

function createFish(seed = 42, zone = ZONES[1]) {
  const y = -(zone.top + zone.bottom) / 2;
  const fish = new Fish(rollFish(seed, -y), zone, 0, y, 140);
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

test('cephalopods swim mantle-first, arms trailing, while facing left or right', () => {
  const distantDiver = new THREE.Vector3(500, 0, 0);
  for (const species of ['Reef Octopus', 'Vampire Squid', 'Chambered Nautilus']) {
    let spec;
    for (let seed = 1; !spec && seed < 5000; seed++) {
      for (const rarity of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
        const rolled = rollFish(seed, 20, [[rarity, 1]]);
        if (rolled.species === species) { spec = rolled; break; }
      }
    }
    assert.ok(spec, `a seed rolls ${species}`);
    for (const horizontal of [-3, 3]) {
      for (const vertical of [-2, 2]) {
        const zone = ZONES[1];
        const fish = new Fish(spec, zone, 0, -(zone.top + zone.bottom) / 2, 140);
        fish.pos.z = 0;
        fish.target.copy(fish.pos).add(new THREE.Vector3(horizontal * 10, vertical * 10, 0));
        for (let frame = 0; frame < 180; frame++) fish.update(1 / 60, frame / 60, distantDiver);
        assert.ok(fish.vel.x * horizontal > 0 && fish.vel.y * vertical > 0);
        fish.mesh.group.updateMatrixWorld(true);
        // The model is built arms toward +x, so its mantle (−x) must lead.
        const mantle = new THREE.Vector3(-1, 0, 0).transformDirection(fish.mesh.group.matrixWorld);
        assert.ok(mantle.x * horizontal > 0, `${species} leads with its mantle, travelling ${horizontal}`);
        assert.ok(mantle.y * vertical > 0, `${species} mantle follows vertical travel ${vertical}, facing ${horizontal}`);
      }
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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function load(file) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const { SHARK, Shark, SharkPack, PulseEstimate, RestingPulse, biteFish, sharkCount, sharkIntensity } = await load('../src/shark.ts');

function dice(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
const DT = 1 / 30;

test('a faster heart means more worked-up sharks, and more of them', () => {
  assert.equal(sharkIntensity(SHARK.rest, SHARK.rest), 0);
  assert.equal(sharkIntensity(SHARK.rest + SHARK.calm, SHARK.rest), 0, 'a few beats above rest go unnoticed');
  assert.equal(sharkIntensity(SHARK.rest + SHARK.frenzy, SHARK.rest), 1);
  assert.equal(sharkIntensity(200, SHARK.rest), 1);
  assert.equal(sharkIntensity(40, SHARK.rest), 0);
  assert.equal(sharkIntensity(NaN, SHARK.rest), 0);
  let last = 0;
  for (let bpm = 60; bpm <= 130; bpm++) {
    const level = sharkIntensity(bpm, 64);
    assert.ok(level >= last);
    last = level;
  }
  // The same pulse is calmer for someone whose resting pulse is higher.
  assert.ok(sharkIntensity(95, 80) < sharkIntensity(95, 60));
  assert.deepEqual([0, 0.44, 0.45, 0.79, 0.8, 1].map(sharkCount), [1, 1, 2, 2, 3, 3]);
});

test('a bite takes one fish at a calm pulse and up to three in a frenzy, never more than the net holds', () => {
  for (let seed = 1; seed < 40; seed++) {
    for (const [intensity, most] of [[0, 1], [0.3, 2], [0.6, 2], [1, 3]]) {
      for (let fish = 0; fish <= 6; fish++) {
        const taken = biteFish(fish, intensity, dice(seed));
        assert.equal(taken.length, Math.min(fish, most));
        assert.equal(new Set(taken).size, taken.length);
        assert.deepEqual(taken, [...taken].sort((a, b) => b - a));
        for (const i of taken) assert.ok(i >= 0 && i < fish);
      }
    }
  }
});

test('without a sensor the pulse follows how hard the diver swims', () => {
  const pulse = new PulseEstimate();
  assert.equal(pulse.bpm, SHARK.rest);
  for (let t = 0; t < 20; t += DT) pulse.tick(DT, 1);
  const sprint = pulse.bpm;
  assert.ok(sprint > SHARK.rest + SHARK.frenzy, 'flat out is a frenzy');
  for (let t = 0; t < 6; t += DT) pulse.tick(DT, 0);
  assert.ok(pulse.bpm < sprint - 10 && pulse.bpm > SHARK.rest + 5, 'it calms down slower than it rose');
  for (let t = 0; t < 60; t += DT) pulse.tick(DT, 0.25);
  assert.ok(sharkIntensity(pulse.bpm) < SHARK.second, 'drifting slowly keeps it to one shark');
});

test('the resting pulse is learned at the surface only', () => {
  const rest = new RestingPulse();
  rest.tick(1, null, true);
  rest.tick(1, 140, false);
  assert.equal(rest.bpm, SHARK.rest, 'not from a missing reading, not from a dive');
  rest.tick(1, 58, true);
  assert.equal(rest.bpm, 58, 'the first reading is taken as it is');
  for (let t = 0; t < 120; t++) rest.tick(1, 62, true);
  assert.ok(Math.abs(rest.bpm - 62) < 0.5);
  rest.tick(1, 500, true);
  assert.ok(rest.bpm < 63, 'nonsense readings are ignored');
});

/** A diver fleeing a charging shark in a straight line at `speed` m/s for `seconds`. Returns whether they were bitten. */
function chase(intensity, speed, seconds = 12, depth = 30) {
  const shark = new Shark(-8, -depth, dice(3));
  shark.wait = 0;
  const prey = { x: 0, y: -depth };
  let charged = false;
  for (let t = 0; t < seconds; t += DT) {
    prey.x += speed * DT;
    const event = shark.step(DT, prey, intensity, -Infinity);
    if (event === 'charge') charged = true;
    if (event === 'bite') return { bitten: true, charged, shark };
  }
  return { bitten: false, charged, shark };
}

test('a calm diver outswims a shark; a frightened one does not', () => {
  // Eight seconds: the six of the charge, and two more to see it has given up.
  const calm = chase(0, 7.5, 8);
  assert.equal(calm.charged, true, 'it does try');
  assert.equal(calm.bitten, false);
  assert.equal(calm.shark.mode, 'patrol', 'and gives up');
  assert.ok(calm.shark.wait > 0);
  assert.equal(chase(1, 7.5).bitten, true);
  assert.equal(chase(1, 0).bitten, true);
  // After the bite it clears off before it circles back.
  const after = chase(1, 0).shark;
  assert.equal(after.mode, 'flee');
});

test('sharks keep clear of the surface and of the seabed, and do not bite a diver who has reached the top', () => {
  const shark = new Shark(-6, -8, dice(5));
  shark.wait = 0;
  const prey = { x: 0, y: -SHARK.safeDepth + 0.5 };
  for (let t = 0; t < 30; t += DT) {
    assert.notEqual(shark.step(DT, prey, 1, -40), 'bite');
    assert.ok(shark.y <= -SHARK.ceiling + 1e-9);
  }
  assert.notEqual(shark.mode, 'charge');
  const low = new Shark(0, -39, dice(6));
  for (let t = 0; t < 20; t += DT) {
    low.step(DT, { x: 3, y: -39.5 }, 0.5, -40);
    assert.ok(low.y >= -40 + 1.5 - 1e-9);
  }
});

test('a calm pulse is only noticed close up; a racing one from far off', () => {
  const noticed = (intensity, distance) => {
    const shark = new Shark(-distance, -30, dice(9));
    shark.wait = 0;
    // One short step: the shark has not moved far from where it was put.
    return shark.step(0.001, { x: 0, y: -30 }, intensity, -Infinity) === 'charge';
  };
  assert.equal(noticed(0, SHARK.sense - 1), true);
  assert.equal(noticed(0, SHARK.sense + 2), false);
  assert.equal(noticed(1, SHARK.sense + SHARK.senseGain - 1), true);
  assert.equal(noticed(1, SHARK.sense + SHARK.senseGain + 2), false);
});

test('the pack comes at night, grows with the pulse, thins when it calms and leaves at dawn', () => {
  const pack = new SharkPack(dice(11));
  const prey = { x: 0, y: -25 };
  const events = [];
  const seen = [];
  const run = (seconds, intensity, out) => {
    for (let t = 0; t < seconds; t += DT) {
      pack.tick(DT, prey, intensity, out, -62, events);
      seen.push(...events);
    }
  };
  run(30, 1, false);
  assert.equal(pack.sharks.length, 0, 'none by day, or with the mode off');
  run(8, 0, true);
  assert.equal(pack.sharks.length, 1);
  assert.equal(seen.filter((e) => e === 'arrive').length, 1, 'announced once');
  const first = pack.sharks[0];
  assert.ok(Math.abs(first.x) < SHARK.arrive[1] + 1, 'it arrives from out of sight');
  run(40, 1, true);
  assert.equal(pack.sharks.filter((s) => s.mode !== 'leave').length, 3);
  assert.ok(seen.includes('charge') && seen.includes('bite'));
  assert.equal(seen.filter((e) => e === 'arrive').length, 1);
  run(4, 0, true);
  assert.equal(pack.sharks.filter((s) => s.mode !== 'leave').length, 1, 'two lose interest');
  run(40, 0, true);
  assert.equal(pack.sharks.length, 1, 'and are gone');
  run(40, 0, false);
  assert.equal(pack.sharks.length, 0, 'dawn');
  pack.tick(DT, prey, 1, true, -62, events);
  pack.reset();
  assert.equal(pack.sharks.length, 0);
});

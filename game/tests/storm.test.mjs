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
const { ROGUE, RogueWaves, canRight, capsizeLoss, rogueProfile } = await load('../src/storm.ts');
const { WeatherCycle } = await load('../src/weather.ts');

/** A repeatable random source. */
function dice(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** Run the sea for `seconds` at 30 fps and collect what happens. */
function run(sea, seconds, storm, live = true) {
  const events = [];
  for (let t = 0; t < seconds; t += 1 / 30) {
    const e = sea.tick(1 / 30, storm, live);
    if (e) events.push(e);
  }
  return events;
}

test('no rogue wave forms in calm weather, outside a dive, or on a calm map', () => {
  const sea = new RogueWaves(dice());
  assert.deepEqual(run(sea, 600, ROGUE.minStorm - 0.01), []);
  assert.deepEqual(run(sea, 600, 1, false), []);
  assert.equal(sea.x, null);
  assert.equal(sea.height, 0);
  assert.equal(sea.capsized, false);
});

test('in a storm a wave sets out, crosses to the boat and turns it over', () => {
  const sea = new RogueWaves(dice());
  let seconds = 0;
  while (sea.tick(1 / 30, 1, true) !== 'wave') {
    seconds += 1 / 30;
    assert.ok(seconds < ROGUE.first[1] + 1, 'the first wave comes within the stated wait');
  }
  assert.ok(seconds >= ROGUE.first[0] - 1);
  assert.equal(Math.abs(sea.x), ROGUE.from, 'it starts far to one side');
  assert.ok(sea.x * sea.dir < 0, 'and heads for the boat');
  assert.ok(sea.height < 0.2, 'rising out of the swell, not popping up');

  let peak = 0, toBoat = 0;
  while (sea.tick(1 / 30, 1, true) !== 'capsize') {
    toBoat += 1 / 30;
    peak = Math.max(peak, sea.height);
    assert.ok(toBoat < 30);
  }
  assert.ok(toBoat > 10 && toBoat < 16, `the player has time to see it coming (${toBoat} s)`);
  assert.equal(peak, ROGUE.height);
  // The steep face strikes first: the boat starts over just before the crest arrives.
  assert.ok(sea.x * sea.dir < 0 && Math.abs(sea.x) <= ROGUE.strike + 1e-9 && Math.abs(sea.x) > ROGUE.strike - ROGUE.speed / 30 - 1e-9);
  assert.equal(sea.capsized, true);
  for (const part of Object.values(sea.pose)) assert.equal(Math.abs(part), 0, 'still upright at the instant it is struck');

  // It is flung past keel-up, the wave carries it along, and it rocks to rest.
  const dir = sea.dir;
  let furthest = 0;
  for (let t = 0; t < ROGUE.rollSeconds + 0.1; t += 1 / 30) {
    sea.tick(1 / 30, 1, true);
    furthest = Math.max(furthest, sea.pose.roll);
    assert.ok(sea.pose.surge * dir >= 0 && Math.abs(sea.pose.surge) <= ROGUE.carry + 1e-9);
  }
  assert.equal(sea.roll, 1);
  assert.ok(furthest > Math.PI * 1.05 && furthest < Math.PI * 1.2, 'it overshoots, then comes back');
  assert.ok(Math.abs(sea.pose.surge - dir * ROGUE.carry) < 1e-9);
  const rocking = [];
  for (let t = 0; t < 12; t += 1 / 30) {
    sea.tick(1 / 30, 0, true);
    rocking.push(Math.abs(sea.pose.roll - Math.PI));
  }
  assert.ok(Math.max(...rocking.slice(0, 60)) > 0.05, 'it rocks at first');
  assert.ok(Math.max(...rocking.slice(-30)) < 0.01, 'and lies still in the end');
  run(sea, 30, 0);
  assert.equal(sea.roll, 1, 'it does not right itself when the storm passes');
  assert.equal(sea.capsized, true);
  assert.ok(Math.abs(sea.boatX - dir * ROGUE.carry) < 1e-9);
});

test('the wave is steep in front and long behind', () => {
  assert.equal(rogueProfile(0), 1);
  for (const d of [1, 3, 6, 10]) {
    assert.ok(rogueProfile(d) < rogueProfile(-d), 'lower the same distance ahead of the crest than behind it');
    assert.ok(rogueProfile(d) < rogueProfile(d - 1) && rogueProfile(-d) < rogueProfile(-d + 1));
  }
  assert.ok(rogueProfile(ROGUE.width) < 0.02, 'the face is gone a half-width ahead');
  assert.ok(rogueProfile(-ROGUE.width) > 0.5, 'the back still stands a half-width behind');
});

test('the wave passes on and fades; the next ones leave a capsized boat as it is', () => {
  const sea = new RogueWaves(dice(3));
  const events = run(sea, 400, 1);
  assert.equal(events.filter((e) => e === 'capsize').length, 1);
  assert.ok(events.filter((e) => e === 'wave').length >= 4, 'waves keep coming through the storm');
  // Gaps between waves: the crossing takes 27 s, then the stated wait.
  const sea2 = new RogueWaves(dice(5));
  let last = null, t = 0;
  const gaps = [];
  for (; t < 600; t += 1 / 30) if (sea2.tick(1 / 30, 1, true) === 'wave') { if (last !== null) gaps.push(t - last); last = t; }
  const crossing = (ROGUE.from * 2) / ROGUE.speed;
  for (const gap of gaps) assert.ok(gap > crossing + ROGUE.gap[0] - 1 && gap < crossing + ROGUE.gap[1] + 1);
});

test('righting takes a moment, and then the boat can bank and be capsized again', () => {
  const sea = new RogueWaves(dice());
  assert.equal(sea.right(), false, 'nothing to right on an upright boat');
  sea.x = -ROGUE.strike - 1;
  sea.dir = 1;
  assert.equal(sea.tick(0.2, 1, true), 'capsize');
  run(sea, 2, 0);
  assert.equal(sea.right(), true);
  assert.equal(sea.right(), false, 'already coming back');
  const events = run(sea, ROGUE.rightSeconds + 0.1, 0);
  assert.deepEqual(events, ['righted']);
  assert.equal(sea.capsized, false);
  assert.equal(sea.roll, 0);
  assert.equal(sea.boatX, 0, 'back where it was moored');
  for (const part of Object.values(sea.pose)) assert.equal(Math.abs(part), 0);
  sea.x = -ROGUE.strike - 1;
  assert.equal(sea.tick(0.2, 1, true), 'capsize');
  sea.reset();
  assert.deepEqual([sea.x, sea.capsized, sea.roll], [null, false, 0]);
});

test('the boat is righted from the surface beside it', () => {
  assert.equal(canRight(0, 0.4), true);
  assert.equal(canRight(-ROGUE.reach, ROGUE.depth), true);
  assert.equal(canRight(ROGUE.reach + 0.1, 0.4), false);
  assert.equal(canRight(0, ROGUE.depth + 0.1), false);
});

test('a capsize costs a third of the net and one piece of packed gear, never the net itself', () => {
  const packed = ['net', 'rod', 'reel', 'fins', 'tank', 'lamp'];
  for (let seed = 1; seed < 60; seed++) {
    for (let fish = 0; fish <= 9; fish++) {
      const loss = capsizeLoss(fish, packed, dice(seed));
      assert.equal(loss.fish.length, Math.ceil(fish / 3));
      assert.equal(new Set(loss.fish).size, loss.fish.length);
      assert.deepEqual(loss.fish, [...loss.fish].sort((a, b) => b - a), 'highest index first, to splice in order');
      for (const i of loss.fish) assert.ok(i >= 0 && i < fish);
      assert.ok(packed.includes(loss.gear) && loss.gear !== 'net');
    }
  }
  assert.deepEqual(capsizeLoss(0, ['net']), { fish: [], gear: null });
  assert.deepEqual(capsizeLoss(0, []), { fish: [], gear: null });
  // Every loose piece can go.
  const gone = new Set();
  for (let seed = 1; seed < 200; seed++) gone.add(capsizeLoss(1, packed, dice(seed)).gear);
  assert.equal(gone.size, 5);
});

test('the stormy climate spends about a third of its time in a storm, the temperate one little', () => {
  const stormShare = (climate) => {
    const weather = new WeatherCycle();
    weather.setClimate(climate);
    weather.advance(10); // past the 5 s blend into the new climate
    let storm = 0, calm = 0, previous = weather.state;
    for (let s = 0; s < 540; s++) {
      const now = weather.advance(1);
      if (now.storm >= 0.55) storm++;
      if (now.kind === 'clear') calm++;
      for (const key of ['cloud', 'rain', 'wind', 'storm']) assert.ok(Math.abs(now[key] - previous[key]) < 0.06, 'the front moves smoothly');
      previous = now;
    }
    return [storm / 540, calm / 540];
  };
  const [temperate, temperateCalm] = stormShare('temperate');
  const [stormy, stormyCalm] = stormShare('stormy');
  assert.ok(temperate < 0.12, `temperate ${temperate}`);
  assert.ok(stormy > 0.28 && stormy < 0.4, `stormy ${stormy}`);
  assert.ok(stormyCalm > 0.05 && stormyCalm < temperateCalm, 'the ocean still has calm spells, just shorter');
  const weather = new WeatherCycle();
  assert.equal(weather.climate, 'temperate');
  weather.setClimate('nonsense');
  assert.equal(weather.climate, 'temperate');
});

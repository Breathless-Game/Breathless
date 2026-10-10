import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The scheduler has no runtime imports; transpile it in memory like render-quality.test.mjs.
const source = await readFile(new URL('../src/event-schedule.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { EventSchedule, EVENT_DEFS, EVENT_GAP, FIRST_DELAY, UNDERWATER_DEPTH, eligible, eventsForMap, pickEvent } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

const MAPS = ['fjord', 'tianchi', 'ocean'];
const byId = Object.fromEntries(EVENT_DEFS.map((d) => [d.id, d]));

/** Deterministic rng (mulberry32) so failures reproduce. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ctx = (depth, extra = {}) => ({ depth, night: false, shelfDepth: 30, ...extra });

/**
 * Drive a schedule in 0.1 s ticks. Each event runs `duration` seconds and then
 * ends. Returns the [start, end, id] of every event.
 */
function run(schedule, seconds, contextAt, duration = 12) {
  const log = [];
  let endAt = null;
  for (let i = 0; i <= seconds * 10; i++) {
    const now = i / 10;
    if (endAt !== null && now >= endAt) {
      schedule.end(now);
      log[log.length - 1][1] = now;
      endAt = null;
    }
    const started = schedule.tick(now, contextAt(now));
    if (started) {
      assert.equal(endAt, null, `${started.id} started at ${now} while another was running`);
      log.push([now, null, started.id]);
      endAt = now + duration;
    }
  }
  return log;
}

test('the first event waits 20-40 s, later ones 45-100 s after the previous one ends', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const map = MAPS[seed % 3];
    const log = run(new EventSchedule(map, { rng: seeded(seed) }), 2000, () => ctx(0), 12);
    assert.ok(log.length > 10, 'events keep coming');
    assert.ok(log[0][0] >= FIRST_DELAY[0] && log[0][0] <= FIRST_DELAY[1] + 0.1, `first at ${log[0][0]}`);
    for (let i = 1; i < log.length; i++) {
      const gap = log[i][0] - log[i - 1][1];
      assert.ok(gap >= EVENT_GAP[0] - 1e-9 && gap <= EVENT_GAP[1] + 0.1, `gap ${gap} on ${map}`);
    }
  }
});

test('events never overlap, even with long events and a diver moving up and down', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const schedule = new EventSchedule(MAPS[seed % 3], { rng: seeded(seed), first: [1, 2], gap: [0.5, 1] });
    // Depth swings between the surface and 40 m every minute.
    const log = run(schedule, 1500, (now) => ctx(20 + 20 * Math.sin(now / 10)), 30);
    assert.ok(log.length > 20);
    for (let i = 1; i < log.length; i++) assert.ok(log[i][0] >= log[i - 1][1], 'starts after the previous end');
    // While one runs, tick never starts another.
    schedule.force('vent');
    for (let t = 0; t < 50; t++) assert.equal(schedule.tick(2000 + t, ctx(30)), null);
  }
});

test('underwater events are picked only when the diver is deep; surface ones only near the surface', () => {
  for (const map of MAPS) {
    const defs = eventsForMap(map);
    const rng = seeded(7);
    for (let i = 0; i < 300; i++) {
      const shallow = pickEvent(defs, ctx(rng() * 2.5), rng);
      assert.equal(shallow.underwater, false, `${shallow.id} at the surface`);
      const deep = pickEvent(defs, ctx(UNDERWATER_DEPTH + 0.1 + rng() * 50), rng);
      assert.equal(deep.underwater, true, `${deep.id} in the deep`);
    }
    // Just under the surface only the calved iceberg (seen from below) qualifies.
    const between = eligible(defs, ctx(4)).map((d) => d.id);
    assert.deepEqual(between, map === 'fjord' ? ['calving'] : []);
  }
});

test('with nothing visible the schedule waits, then fires as soon as something is', () => {
  const schedule = new EventSchedule('ocean', { rng: seeded(3) });
  assert.equal(schedule.tick(0, ctx(4)), null);
  const due = schedule.dueAt;
  for (let now = due; now < due + 60; now += 0.5) assert.equal(schedule.tick(now, ctx(4)), null);
  const fired = schedule.tick(due + 60, ctx(0));
  assert.ok(fired && !fired.underwater && fired.map === 'ocean');
});

test('each map only plays its own events plus the shared underwater ones', () => {
  for (const map of MAPS) {
    const own = eventsForMap(map);
    assert.ok(own.every((d) => d.map === map || d.map === 'any'));
    assert.equal(own.filter((d) => d.map === map).length, 3, `${map} has three surface events`);
    assert.equal(own.filter((d) => d.underwater).length, 3);
    const seen = new Set();
    const schedule = new EventSchedule(map, { rng: seeded(11), first: [1, 1], gap: [1, 1] });
    run(schedule, 4000, (now) => ctx(Math.floor(now / 60) % 2 ? 20 : 0, { night: Math.floor(now / 120) % 2 === 1 }), 5).forEach(([, , id]) => seen.add(id));
    for (const id of seen) assert.ok(byId[id].map === map || byId[id].map === 'any', `${id} on ${map}`);
    assert.equal(seen.size, own.length, `every ${map} event shows up eventually`);
    assert.equal(schedule.force('nonexistent'), null);
    const foreign = EVENT_DEFS.find((d) => d.map !== map && d.map !== 'any');
    assert.equal(schedule.force(foreign.id), null, 'cannot force another map’s event');
  }
});

test('night-only and day-only events respect the clock', () => {
  const defs = eventsForMap('fjord');
  const rng = seeded(5);
  for (let i = 0; i < 300; i++) assert.notEqual(pickEvent(defs, ctx(0), rng).id, 'aurora');
  const lake = eventsForMap('tianchi');
  for (let i = 0; i < 300; i++) assert.notEqual(pickEvent(lake, ctx(0, { night: true }), rng).id, 'cranes');
});

test('the jelly bloom is favoured below the shelf', () => {
  const defs = eventsForMap('ocean');
  const rng = seeded(9);
  const count = (depth) => {
    let jellies = 0;
    for (let i = 0; i < 3000; i++) if (pickEvent(defs, ctx(depth), rng).id === 'jellies') jellies++;
    return jellies / 3000;
  };
  const shelf = count(20);
  const trench = count(45);
  assert.ok(shelf > 0.25 && shelf < 0.42, `about a third on the shelf (${shelf})`);
  assert.ok(trench > 0.6, `most picks in the trench (${trench})`);
});

test('the same event does not play twice in a row when there is a choice', () => {
  const schedule = new EventSchedule('tianchi', { rng: seeded(13), first: [1, 1], gap: [1, 1] });
  const log = run(schedule, 2000, () => ctx(0), 3);
  for (let i = 1; i < log.length; i++) assert.notEqual(log[i][2], log[i - 1][2]);
});

test('forcing an event replaces the running one, and the next gap counts from its end', () => {
  const schedule = new EventSchedule('ocean', { rng: seeded(17) });
  assert.equal(schedule.tick(0, ctx(0)), null);
  assert.equal(schedule.force('whale').id, 'whale');
  assert.equal(schedule.running.id, 'whale');
  assert.equal(schedule.force('lightning').id, 'lightning');
  assert.equal(schedule.running.id, 'lightning');
  schedule.end(100);
  assert.equal(schedule.running, null);
  assert.ok(schedule.dueAt >= 100 + EVENT_GAP[0] && schedule.dueAt <= 100 + EVENT_GAP[1]);
  // A new map resets to the first-event delay.
  schedule.setMap('fjord');
  schedule.tick(500, ctx(0));
  assert.ok(schedule.dueAt >= 500 + FIRST_DELAY[0] && schedule.dueAt <= 500 + FIRST_DELAY[1]);
});

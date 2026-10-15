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
const rng = await sourceUrl('../src/rng.ts');
const { FLORA, understorySpecies, depthTint } = await import(await sourceUrl('../src/flora.ts'));
const { Shelf, layoutSeabed, plantHeight } = await import(await sourceUrl('../src/seabed-layout.ts', { './rng': rng }));

// The shelf world.ts builds: sand out to 290 m, the diver's widest corridor 200 m, and
// kelp counted per 140 m of shelf (55 / 26 / 55 on the three maps).
const BOUNDS = { trench: 14, outer: 290, zMin: -115, zMax: 65 };
const REACH = 200;
const SCALE = (REACH * 2) / 140;
const MAPS = { fjord: [0xf10d5ea, 120, 55], tianchi: [0x71a2c41, 200, 26], ocean: [20261010, 300, 55] };

function build(id) {
  const [seed, depth, perSpan] = MAPS[id];
  const canopy = Math.round(perSpan * SCALE);
  const shelf = new Shelf(seed, { ...BOUNDS, trench: id === 'ocean' ? BOUNDS.trench : 0 }, 3.5);
  const flora = FLORA[id];
  const understory = Array.from({ length: Math.round(canopy * flora.undergrowth) }, (_, i) => understorySpecies(flora, i));
  return { shelf, depth, canopy, understory, layout: layoutSeabed(shelf, { seed: seed ^ 0x5eabed, depth, reach: REACH, canopy, understory }) };
}

test('heightAt reads back the triangles the sand is drawn with', () => {
  const shelf = new Shelf(7, BOUNDS);
  for (const side of [0, 1]) {
    const p = shelf.triangles(side);
    assert.equal(p.length, shelf.columns * shelf.rows * 18);
    for (let i = 0; i < p.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = p.subarray(i, i + 9);
      // Facing up, and never reaching into the trench.
      assert.ok((bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0);
      assert.ok(Math.min(Math.abs(ax), Math.abs(bx), Math.abs(cx)) >= BOUNDS.trench - 1e-6);
      const inside = shelf.heightAt((ax + bx + cx) / 3, (az + bz + cz) / 3);
      assert.ok(Math.abs(inside - (ay + by + cy) / 3) < 1e-4, 'a point inside a triangle lies on it');
    }
  }
});

for (const id of Object.keys(MAPS)) {
  test(`${id}: every rock rests on sand or on the rock below it`, () => {
    const { shelf, depth, layout } = build(id);
    assert.ok(layout.outcrops.length > 90 && layout.stacks.length > 70);
    for (const rock of [...layout.outcrops, ...layout.stacks]) assert.ok(Math.abs(rock.x) + rock.r <= BOUNDS.outer, 'on the sand');
    for (const rock of layout.outcrops) {
      const ground = shelf.heightAt(rock.x, rock.z);
      assert.ok(rock.y - rock.r * rock.squash < ground - 0.05, 'part-buried');
      assert.ok(rock.y + rock.r * rock.squash > ground, 'not swallowed by the sand');
      assert.ok(Math.abs(rock.x) > shelf.bounds.trench, 'not over the trench');
      // The diver's lane (z from -5 to 3) stays clear of boulders.
      if (rock.r >= 1.6 && rock.tier === 1 && rock.z > -5 && rock.z < 3) assert.fail(`boulder in the lane at z=${rock.z}`);
    }
    layout.stacks.forEach((rock, i) => {
      const bottom = rock.y - rock.r * rock.squash;
      const onSand = bottom < shelf.heightAt(rock.x, rock.z);
      const below = layout.stacks[i - 1];
      const onRock = below && Math.hypot(below.x - rock.x, below.z - rock.z) < below.r && bottom < below.y + below.r * below.squash;
      assert.ok(onSand || onRock, 'no rock hangs in open water');
      assert.ok(rock.y + rock.r * rock.squash < depth - 1, 'below the surface');
    });
  });

  test(`${id}: plants root on the sand, apart from each other and clear of the trench`, () => {
    const { shelf, canopy, understory, layout } = build(id);
    assert.equal(layout.canopy.length, canopy);
    assert.ok(layout.understory.length >= understory.length * 0.9);
    for (const list of [layout.canopy, layout.understory]) {
      list.forEach((plant, i) => {
        const ground = shelf.heightAt(plant.x, plant.z);
        assert.ok(plant.y <= ground && plant.y > ground - 0.3, 'rooted just under the surface of the sand');
        assert.ok(Math.abs(plant.x) >= shelf.bounds.trench + 3 && Math.abs(plant.x) <= BOUNDS.outer - 3);
        for (let j = 0; j < i; j++) assert.ok(Math.hypot(list[j].x - plant.x, list[j].z - plant.z) >= 0.74);
      });
    }
    // The lowest quality shows the first 12 per 140 m: they must not all stand in one corner.
    const first = layout.canopy.slice(0, Math.round(12 * SCALE));
    assert.ok(first.some((p) => p.x < 0) && first.some((p) => p.x > 0));
    assert.ok(new Set(first.map((p) => Math.round(p.x / 12))).size >= 16);
    // And the forest reaches the far ends of the widest corridor.
    assert.ok(Math.max(...layout.canopy.map((p) => Math.abs(p.x))) > REACH - 25);
    // Seagrass keeps to its meadows; the understory is dealt in the order asked for.
    layout.understory.forEach((plant) => assert.ok(['ribbon', 'broadleaf', 'feather'].includes(plant.species)));
  });

  test(`${id}: the same seed lays out the same shelf`, () => {
    assert.deepEqual(build(id).layout, build(id).layout);
  });
}

test('finite seabeds meet at the centre with no crack and agree with sampled floor heights', () => {
  for (const id of ['fjord', 'tianchi']) {
    const { shelf } = build(id);
    assert.equal(shelf.bounds.trench, 0);
    const seam = side => {
      const p = shelf.triangles(side);
      const vertices = new Map();
      for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i]) < 1e-5) vertices.set(p[i + 2], p[i + 1]);
      return vertices;
    };
    const left = seam(0), right = seam(1);
    assert.ok(left.size > 20, 'the sand spans the centre throughout its depth');
    assert.deepEqual(left, right);
    for (const [z, y] of left) assert.ok(Math.abs(shelf.heightAt(0, z) - y) < 1e-5);
    for (let z = -60; z < 20; z += 1.25) {
      assert.ok(Math.abs(shelf.heightAt(-1e-5, z) - shelf.heightAt(1e-5, z)) < 1e-4);
    }
  }
});

test('kelp stops short of the surface and low plants stay low', () => {
  // Cover legacy shallows as well as the expanded 120 / 200 / 300 m seabeds.
  for (const depth of [20, 40, 60, 120, 200, 300]) {
    for (const vigor of [0, 0.3, 1]) {
      const giant = plantHeight('giant', vigor, depth);
      assert.ok(giant >= 6 && giant <= depth - 5 && giant <= 48);
      for (const species of ['ribbon', 'broadleaf', 'feather']) {
        const h = plantHeight(species, vigor, depth);
        assert.ok(h >= 2 && h <= 6.5);
      }
    }
    // The tallest kelp fills most of the water column: that is the forest you swim through.
    assert.ok(plantHeight('giant', 1, depth) >= Math.min(48, depth * 0.75));
  }
});

test('each map has its own flora, and growth dims and cools with depth', () => {
  for (const flora of Object.values(FLORA)) {
    const shares = Object.values(flora.understory).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(shares - 1) < 1e-9);
    const dealt = { ribbon: 0, broadleaf: 0, feather: 0 };
    for (let i = 0; i < 400; i++) dealt[understorySpecies(flora, i)]++;
    for (const [species, share] of Object.entries(flora.understory)) assert.ok(Math.abs(dealt[species] / 400 - share) < 0.03);
    // Any prefix keeps the mix, so thinning for quality does not drop a species.
    assert.equal(new Set(Array.from({ length: 8 }, (_, i) => understorySpecies(flora, i))).size, 3);
    for (const pigments of Object.values(flora.pigments)) pigments.forEach((c) => assert.match(c, /^#[0-9a-f]{6}$/));
  }
  assert.notDeepEqual(FLORA.fjord.pigments, FLORA.ocean.pigments);
  let [bright, blue] = depthTint(0);
  for (let depth = 5; depth <= 60; depth += 5) {
    const [b, s] = depthTint(depth);
    assert.ok(b <= bright && s >= blue);
    [bright, blue] = [b, s];
  }
  assert.ok(bright < 0.8 && blue > 0.25);
});

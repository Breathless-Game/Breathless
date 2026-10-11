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
const flora = await sourceUrl('../src/flora.ts');
const motion = await sourceUrl('../src/kelp-motion.ts');
const { FLORA } = await import(flora);
const { kelpOffset, KELP_MOTION_GLSL } = await import(motion);
const { buildKelpGeometry } = await import(await sourceUrl('../src/kelp.ts', {
  three: import.meta.resolve('three'), './rng': rng, './kelp-motion': motion, './flora': flora,
}));

const SPECIES = ['giant', 'ribbon', 'broadleaf', 'feather'];
const HEIGHT = { giant: 30, ribbon: 5, broadleaf: 4, feather: 5 };
const plant = (species, seed = 11, x = 20, y = -40, z = -8) => ({ x, y, z, seed, species, height: HEIGHT[species] });
const flow = (time, extra = {}) => ({
  time, dirX: Math.cos(0.3), dirZ: Math.sin(0.3), strength: 0.5, waveTime: time * 1.2, surge: 0.5,
  diver: [0, 100, 0], wake: [0, 0, 0], ...extra,
});

function triangles(geometry) {
  const p = geometry.attributes.position, c = geometry.attributes.color;
  const root = geometry.attributes.aKelpRoot, shape = geometry.attributes.aKelpShape;
  assert.equal(geometry.index, null);
  assert.equal(p.count % 3, 0);
  return { p, c, root, shape, count: p.count / 3 };
}

for (const species of SPECIES) {
  test(`${species}: flat one-colour facets that stand on their root`, () => {
    for (const detail of [1, 2, 3]) {
      const one = plant(species);
      const { p, c, root, shape, count } = triangles(buildKelpGeometry([one], FLORA.ocean, detail));
      assert.ok(count >= 8, 'enough faces to read as a plant');
      assert.ok(count <= 120, 'and few enough to stay low-poly');
      let top = -Infinity;
      for (let i = 0; i < p.count; i++) {
        const face = i - (i % 3);
        for (const k of [0, 1, 2]) {
          assert.equal(c.array[i * 3 + k], c.array[face * 3 + k], 'one colour per triangle, no gradients');
          assert.ok(c.array[i * 3 + k] >= 0 && c.array[i * 3 + k] <= 1);
        }
        assert.deepEqual([root.getX(i), root.getY(i), root.getZ(i)], [one.x, one.y, one.z]);
        assert.equal(shape.getX(i), one.height);
        // Roots sit 15 cm under the sand; a blade's base corner may dip a few cm below that.
        assert.ok(p.getY(i) >= one.y - 0.08, 'nothing grows down into the sand');
        assert.ok(Math.hypot(p.getX(i) - one.x, p.getZ(i) - one.z) < one.height * 0.9 + 1);
        top = Math.max(top, p.getY(i) - one.y);
      }
      assert.ok(top > one.height * 0.6 && top < one.height * 1.1, 'about as tall as asked');
      // Every face has an area: no slivers that flicker.
      for (let i = 0; i < p.count; i += 3) {
        const a = [p.getX(i), p.getY(i), p.getZ(i)];
        const u = [p.getX(i + 1) - a[0], p.getY(i + 1) - a[1], p.getZ(i + 1) - a[2]];
        const v = [p.getX(i + 2) - a[0], p.getY(i + 2) - a[1], p.getZ(i + 2) - a[2]];
        const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
        assert.ok(area > 1e-4);
      }
    }
  });

  test(`${species}: quality only thins it`, () => {
    const one = plant(species, 97);
    const [low, mid, high] = [1, 2, 3].map((detail) => buildKelpGeometry([one], FLORA.fjord, detail));
    assert.ok(low.attributes.position.count <= mid.attributes.position.count);
    assert.ok(mid.attributes.position.count <= high.attributes.position.count);
    // The sway phase is the plant's, whatever the tier.
    assert.equal(low.attributes.aKelpShape.getZ(0), high.attributes.aKelpShape.getZ(0));
    const again = buildKelpGeometry([one], FLORA.fjord, 3);
    assert.deepEqual([...again.attributes.position.array], [...high.attributes.position.array]);
  });
}

test('the giant kelp keeps its stalk when quality drops', () => {
  const one = plant('giant', 5);
  const stalk = (detail) => {
    const { p, shape } = triangles(buildKelpGeometry([one], FLORA.ocean, detail));
    // Leaf tips are the only vertices far from the stem.
    const points = [];
    for (let i = 0; i < p.count; i++) if (Math.abs(shape.getY(i)) < 0.4) points.push(p.getX(i), p.getY(i), p.getZ(i));
    return points;
  };
  const low = stalk(1), high = stalk(3);
  // Every stalk corner of the low tier is a corner of the high tier too.
  const key = (a, i) => `${a[i].toFixed(4)},${a[i + 1].toFixed(4)},${a[i + 2].toFixed(4)}`;
  const corners = new Set();
  for (let i = 0; i < high.length; i += 3) corners.add(key(high, i));
  let shared = 0;
  for (let i = 0; i < low.length; i += 3) if (corners.has(key(low, i))) shared++;
  assert.ok(shared / (low.length / 3) > 0.9);
});

test('biomes colour the same plant differently, and deep growth is dimmer', () => {
  const colour = (map, y) => {
    const c = buildKelpGeometry([plant('giant', 3, 20, y)], FLORA[map], 2).attributes.color.array;
    return [c[0], c[1], c[2]];
  };
  assert.notDeepEqual(colour('fjord', -20), colour('tianchi', -20));
  assert.notDeepEqual(colour('tianchi', -20), colour('ocean', -20));
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  assert.ok(luma(colour('ocean', -58)) < luma(colour('ocean', -12)) * 0.85);
});

test('roots never move and stems never stretch', () => {
  for (const height of [3, 12, 30, 48]) {
    for (let step = 0; step < 60; step++) {
      const time = step * 0.37;
      for (const strength of [0, 1]) {
        const at = flow(time, { strength, diver: [21, -39, 0], wake: [7, -3, 1] });
        for (const moved of kelpOffset(20, -40, -8, 20, -40, -8, height, 0, 1.3, 1, at)) assert.equal(Math.abs(moved), 0);
        const calm = flow(time, { strength });
        for (const u of [0.1, 0.35, 0.7, 1]) {
          const s = height * u;
          const [ox, oy, oz] = kelpOffset(20, -40 + s, -8, 20, -40, -8, height, 0, 1.3, 1, calm);
          const length = Math.hypot(ox, s + oy, oz);
          assert.ok(length > s * 0.88 && length < s * 1.06 + 0.05, `a stem keeps its length (${length} vs ${s})`);
          assert.ok(Math.hypot(ox, oz) < 0.24 * height + 1.2, 'and sways, it does not lie down');
        }
      }
    }
  }
});

test('tips travel farther than stems, and the diver pushes plants aside', () => {
  let low = 0, high = 0;
  for (let step = 0; step < 200; step++) {
    const at = flow(step * 0.11);
    low = Math.max(low, Math.hypot(...kelpOffset(0, -30, 0, 0, -40, 0, 30, 0, 0, 1, at)));
    high = Math.max(high, Math.hypot(...kelpOffset(0, -10, 0, 0, -40, 0, 30, 0, 0, 1, at)));
  }
  assert.ok(high > low * 2.5 && high > 1 && high < 9);

  const still = { ...flow(0), strength: 0, surge: 0 };
  const rest = kelpOffset(1, -36, 0, 1, -40, 0, 30, 0, 0, 1, still);
  const pushed = kelpOffset(1, -36, 0, 1, -40, 0, 30, 0, 0, 1, { ...still, diver: [0, -36, 0], wake: [0, 0, 1] });
  assert.ok(pushed[0] - rest[0] > 0.5, 'away from a diver on its left');
  const far = kelpOffset(1, -36, 0, 1, -40, 0, 30, 0, 0, 1, { ...still, diver: [-9, -36, 0], wake: [0, 0, 1] });
  assert.deepEqual(far, rest);
});

test('the shader runs the same motion with the same numbers', () => {
  for (const term of ['uKelpTime', 'uKelpFlow', 'uKelpSurge', 'uKelpDiver', 'uKelpWake', 'vec3 kelpOffset(vec3 p, vec3 root, vec4 shape)']) {
    assert.ok(KELP_MOTION_GLSL.includes(term), term);
  }
  // No JS number formatting leaks into GLSL: every literal is a float.
  assert.doesNotMatch(KELP_MOTION_GLSL, /\$\{|NaN|undefined/);
  assert.doesNotMatch(KELP_MOTION_GLSL.replace(/vec[234]|\/\/.*$/gm, ''), /[^\w.]\d+(?![\d.])(?!\))/);
});

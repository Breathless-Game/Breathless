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

const { waterHeight, waterSlope } = await import(await sourceUrl('../src/water-waves.ts'));
const { RENDER_QUALITY } = await import(await sourceUrl('../src/render-quality.ts'));
const { waterGeometry } = await import(await sourceUrl('../src/water-geometry.ts', {
  three: import.meta.resolve('three'), './rng': await sourceUrl('../src/rng.ts'),
}));

function* samples() {
  for (const time of [0, 1 / 60, 0.5, 3, 27, 91, 600, 3600, 86400]) {
    for (let x = -150; x <= 150; x += 12.5) {
      for (let z = -60; z <= 60; z += 10) yield [x, z, time];
    }
  }
}

const state = (x, z, time, detail) => [waterHeight(x, z, time, detail),
  waterSlope(x, z, time, detail, 'x'), waterSlope(x, z, time, detail, 'z')];

for (const [tier, quality] of Object.entries(RENDER_QUALITY)) {
  test(`${tier} waves stay finite, gently sloped, and bounded over the full surface and long sessions`, () => {
    let minimum = Infinity, maximum = -Infinity;
    for (const [x, z, time] of samples()) {
      const [height, dx, dz] = state(x, z, time, quality.waterDetail);
      assert.ok([height, dx, dz].every(Number.isFinite));
      // Visual limits before the map/weather swell: floating scenery must not
      // jump metres or roll over when crossing a wave or changing quality.
      assert.ok(Math.abs(height) < 0.6, 'base wave height stays within 60 cm');
      assert.ok(Math.hypot(dx, dz) < 0.2, 'the calm surface has no near-vertical slopes');
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
    }
    assert.ok(maximum - minimum > 0.5, 'the bounded field still has visible crests and troughs');
  });
}

test('floating scenery slopes agree with numerical derivatives of the wave height', () => {
  const step = 0.001;
  for (const { waterDetail } of Object.values(RENDER_QUALITY)) {
    for (const [x, z, time] of samples()) {
      for (const axis of ['x', 'z']) {
        const dx = axis === 'x' ? step : 0;
        const dz = axis === 'z' ? step : 0;
        const numerical = (waterHeight(x + dx, z + dz, time, waterDetail)
          - waterHeight(x - dx, z - dz, time, waterDetail)) / (2 * step);
        assert.ok(Math.abs(waterSlope(x, z, time, waterDetail, axis) - numerical) < 2e-7,
          `the ${axis} tilt must follow the same surface as the float height`);
      }
    }
  }
});

test('higher quality adds bounded fine motion without replacing the broad wave field', () => {
  let mediumEnergy = 0, highEnergy = 0, count = 0;
  for (const [x, z, time] of samples()) {
    const low = state(x, z, time, RENDER_QUALITY.low.waterDetail);
    const medium = state(x, z, time, RENDER_QUALITY.medium.waterDetail);
    const high = state(x, z, time, RENDER_QUALITY.high.waterDetail);
    assert.ok(Math.abs(medium[0] - low[0]) < 0.08);
    assert.ok(Math.abs(high[0] - medium[0]) < 0.04);
    assert.ok(Math.abs(high[0] - low[0]) < 0.1, 'quality switches preserve the broad crest height');
    assert.ok(Math.hypot(high[1] - low[1], high[2] - low[2]) < 0.06,
      'fine waves do not sharply change floating scenery tilt');
    mediumEnergy += (medium[0] - low[0]) ** 2;
    highEnergy += (high[0] - medium[0]) ** 2;
    count++;
  }
  assert.ok(Math.sqrt(mediumEnergy / count) > 0.01, 'medium contributes visible fine motion');
  assert.ok(Math.sqrt(highEnergy / count) > 0.005, 'high contributes additional fine motion');
});

test('shared triangle corners move together and a held wave time survives other frame samples', () => {
  for (const quality of Object.values(RENDER_QUALITY)) {
    const geometry = waterGeometry(300, 120, quality.surfaceSegments);
    const positions = geometry.attributes.position;
    const indices = geometry.index;
    const corners = new Map();
    const pausedTime = 19.375;
    let repeatedCorners = 0;
    try {
      assert.ok(indices, 'exercise shared indexed mesh corners');
      for (let i = 0; i < indices.count; i++) {
        const index = indices.getX(i);
        const x = positions.getX(index), z = positions.getZ(index);
        const key = `${x},${z}`;
        const held = state(x, z, pausedTime, quality.waterDetail);
        if (corners.has(key)) {
          assert.deepEqual(held, corners.get(key), 'adjacent triangles cannot separate at their shared corner');
          repeatedCorners++;
        } else corners.set(key, held);
        // Evaluating other positions/times must not advance hidden state.
        state(x + 3, z - 7, pausedTime + 100, quality.waterDetail);
        state(x, z, 0, quality.waterDetail);
        assert.deepEqual(state(x, z, pausedTime, quality.waterDetail), held);
      }
      assert.ok(repeatedCorners > indices.count / 2, 'exercise shared mesh corners, not isolated samples');
    } finally {
      geometry.dispose();
    }
  }
});

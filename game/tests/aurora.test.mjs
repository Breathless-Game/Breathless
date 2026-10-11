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
const { AuroraCurtain, auroraActivity, auroraGlow } = await import(await sourceUrl('../src/aurora.ts', { three: import.meta.resolve('three') }));

test('the aurora comes in displays with dark spells between them', () => {
  // Four hours of game time, a second at a time.
  const SPAN = 14400;
  let lit = 0, dark = 0, longestDark = 0, darkRun = 0, displays = 0, was = false;
  for (let t = 0; t < SPAN; t++) {
    const a = auroraActivity(t);
    assert.ok(a >= 0 && a <= 1);
    assert.ok(Math.abs(a - auroraActivity(t + 1)) < 0.12, 'it fades in and out over seconds, never pops');
    const on = a > 0.5;
    if (on) lit++;
    if (a === 0) { dark++; darkRun++; longestDark = Math.max(longestDark, darkRun); } else darkRun = 0;
    if (on && !was) displays++;
    was = on;
  }
  assert.ok(lit / SPAN > 0.1 && lit / SPAN < 0.35, `out about a fifth of the time (${lit / SPAN})`);
  assert.ok(dark / SPAN > 0.5, 'and fully dark more often than not');
  assert.ok(longestDark < 480, `nobody waits more than a few minutes for the next display (${longestDark} s)`);
  assert.ok(displays >= 30, 'it keeps coming back');
});

test('some nights have no aurora at all, most do', () => {
  // The clock starts at 09:00 and a day lasts 720 s: night (20:00 to 05:00) is seconds 330 to 600 of each day.
  let without = 0;
  const nights = 80;
  for (let day = 0; day < nights; day++) {
    let best = 0;
    for (let t = day * 720 + 330; t < day * 720 + 600; t++) best = Math.max(best, auroraActivity(t));
    if (best < 0.3) without++;
  }
  assert.ok(without >= 6 && without <= 24, `${without} of ${nights} nights stay dark`);
});

test('curtain animation keeps geometry static and reuses one material', () => {
  const curtain = new AuroraCurtain({ width: 300, height: 30, columns: 48 });
  const { geometry, material } = curtain.mesh;
  const p = geometry.attributes.position, uv = geometry.attributes.uv;
  const original = p.array.slice(), originalUv = uv.array.slice();
  curtain.update(12, 0);
  assert.equal(curtain.mesh.visible, false, 'no strength, nothing drawn');
  curtain.update(12, 1);
  assert.equal(curtain.mesh.visible, true);
  const uniforms = material.uniforms;
  assert.equal(uniforms.uTime.value, 12);
  assert.equal(uniforms.uStrength.value, 1);
  assert.equal(uniforms.uFlare.value, 0);
  curtain.update(12, 1, 1);
  assert.equal(uniforms.uFlare.value, 1);
  curtain.phase = 2.5;
  curtain.update(1000, 0.6, 0.5);
  assert.equal(uniforms.uPhase.value, 2.5, 'events can choose a new phase without rebuilding');
  assert.equal(uniforms.uTime.value, 1000);
  assert.equal(uniforms.uStrength.value, 0.6);
  assert.deepEqual(p.array, original, 'no per-frame position uploads');
  assert.deepEqual(uv.array, originalUv);
  assert.equal(p.version, 0);
  assert.equal(uv.version, 0);
  assert.equal(curtain.mesh.material, material);
  assert.equal(material.depthWrite, false);
  assert.equal(material.depthTest, true, 'peaks occlude the ribbons');
  assert.equal(material.forceSinglePass, true);
  curtain.update(0, -1, 2);
  assert.equal(curtain.mesh.visible, false);
  assert.equal(uniforms.uStrength.value, 0);
  assert.equal(uniforms.uFlare.value, 1);
  assert.deepEqual([auroraGlow.ambient, auroraGlow.surge], [0, 0]);
  curtain.dispose();
});

test('all detail levels retain continuous UVs and valid ribbon triangles', () => {
  for (const columns of [28, 36, 48, 60, 72, 96]) {
    const curtain = new AuroraCurtain({ width: 340, height: 46, columns });
    const { geometry } = curtain.mesh;
    const p = geometry.attributes.position, uv = geometry.attributes.uv;
    const rows = p.count / (columns + 1);
    assert.ok(p.count < 700, 'detail remains bounded per curtain');
    assert.equal(uv.count, p.count);
    for (let c = 0; c <= columns; c++) {
      assert.equal(uv.getY(c * rows), 0);
      assert.equal(uv.getY(c * rows + rows - 1), 1);
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        assert.ok(Math.abs(uv.getX(i) - c / columns) < 1e-6);
        assert.ok(Number.isFinite(p.getX(i)) && Number.isFinite(p.getY(i)));
        if (r) assert.ok(p.getY(i) > p.getY(i - 1));
      }
    }
    const indices = geometry.index.array;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.slice(i, i + 3);
      assert.ok(a < p.count && b < p.count && c < p.count);
      const area = (p.getX(b) - p.getX(a)) * (p.getY(c) - p.getY(a))
        - (p.getY(b) - p.getY(a)) * (p.getX(c) - p.getX(a));
      assert.ok(area > 0, 'no degenerate or flipped faces');
    }
    curtain.dispose();
  }
});

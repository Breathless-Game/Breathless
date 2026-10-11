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

test('a curtain is brightest along its foot, dark at its top and has no visible ends', () => {
  const curtain = new AuroraCurtain({ width: 300, height: 30, columns: 48 });
  curtain.update(12, 0);
  assert.equal(curtain.mesh.visible, false, 'no strength, nothing drawn');
  curtain.update(12, 1);
  assert.equal(curtain.mesh.visible, true);
  const p = curtain.mesh.geometry.attributes.position, c = curtain.mesh.geometry.attributes.color;
  assert.equal(p.count, 49 * 4);
  const luma = (i) => c.getX(i) + c.getY(i) + c.getZ(i);
  let brightest = 0;
  for (let column = 0; column <= 48; column++) {
    const foot = column * 4;
    assert.equal(luma(foot + 3), 0, 'the top edge fades to nothing');
    for (let row = 0; row < 3; row++) {
      assert.ok(luma(foot + row) >= luma(foot + row + 1), 'each ray dims upward');
      assert.ok(p.getY(foot + row + 1) > p.getY(foot + row), 'and stands upright');
    }
    brightest = Math.max(brightest, luma(foot));
  }
  assert.equal(luma(0), 0);
  assert.equal(luma(48 * 4), 0);
  assert.ok(brightest > 0.5);
  // Mostly green low down, violet only where it fades.
  const mid = 24 * 4;
  assert.ok(c.getY(mid) > c.getX(mid) && c.getY(mid) > c.getZ(mid));
  assert.ok(c.getZ(mid + 2) > c.getY(mid + 2) * 0.6);

  // A flare makes the same curtain taller and brighter.
  const tall = p.getY(mid + 3) - p.getY(mid), glow = luma(mid);
  curtain.update(12, 1, 1);
  assert.ok(p.getY(mid + 3) - p.getY(mid) > tall * 1.2);
  assert.ok(Math.max(...Array.from({ length: 49 }, (_, i) => luma(i * 4))) > brightest);
  assert.ok(glow >= 0);
  assert.deepEqual([auroraGlow.ambient, auroraGlow.surge], [0, 0]);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Presage (camera breath detection) is off unless the build sets VITE_PRESAGE_ENABLED=1
// (src/features.ts). Off: keyboard only, the camera is never asked for, and the Presage
// UI stays in the page, hidden. On: everything is as it was.

const src = (file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');

/** features.ts, with import.meta.env replaced the way Vite does at build time (undefined: no Vite). */
async function loadFeatures(env) {
  let source = await src('features.ts');
  if (env) source = source.replaceAll('import.meta.env', `(${JSON.stringify(env)})`);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

test('VITE_PRESAGE_ENABLED: on only for 1 / true, off by default', async () => {
  const f = await loadFeatures();
  for (const v of ['1', 'true', 'TRUE', ' 1 ']) assert.equal(f.flagOn(v), true, v);
  for (const v of [undefined, null, '', '0', 'false', 'yes', 'on']) assert.equal(f.flagOn(v), false, String(v));
  assert.equal(f.PRESAGE_ENABLED, false, 'no env at all (outside Vite): off');
  assert.equal((await loadFeatures({})).PRESAGE_ENABLED, false, 'unset: off');
  assert.equal((await loadFeatures({ VITE_PRESAGE_ENABLED: '0' })).PRESAGE_ENABLED, false);
  assert.equal((await loadFeatures({ VITE_PRESAGE_ENABLED: '1' })).PRESAGE_ENABLED, true);
  assert.equal((await loadFeatures({ VITE_PRESAGE_ENABLED: 'true' })).PRESAGE_ENABLED, true);
});

test('breath modes: keyboard only with Presage off (the simulator too in dev)', async () => {
  const { breathModeList } = await loadFeatures();
  for (const camera of [false, true]) {
    assert.deepEqual(breathModeList({ presage: false, camera, dev: false }), ['keyboard'], `camera ${camera}`);
    assert.deepEqual(breathModeList({ presage: false, camera, dev: true }), ['sim', 'keyboard'], `dev, camera ${camera}`);
  }
});

test('breath modes: Presage on lists the camera once there is a stream, as before', async () => {
  const { breathModeList } = await loadFeatures();
  for (const dev of [false, true]) {
    assert.deepEqual(breathModeList({ presage: true, camera: true, dev }), ['presage', 'sim', 'keyboard']);
    assert.deepEqual(breathModeList({ presage: true, camera: false, dev }), ['sim', 'keyboard']);
  }
});

// breath.ts and main.ts need a browser; these pin the wiring at the source level.
test('breath.ts: startLive refuses before the worker or the camera when Presage is off', async () => {
  const breath = await src('breath.ts');
  const start = breath.slice(breath.indexOf('  async startLive()'), breath.indexOf('  private sendSeed('));
  const guard = start.indexOf('if (!PRESAGE_ENABLED) throw');
  assert.ok(guard > 0, 'startLive has the guard');
  assert.ok(guard < start.indexOf('this.startEncoder()') && guard < start.indexOf('this.openCamera()'), 'before the worker and getUserMedia');
  // getUserMedia only in openCamera, which only startLive (and a live camera's recovery) reach.
  assert.equal(breath.match(/\.getUserMedia\(/g).length, 1);
  assert.match(breath, /if \(PRESAGE_ENABLED\) setInterval\(\(\) => this\.watchdog\(\), 1000\)/, 'no stall checks while off');
  assert.match(breath, /if \(msg\.reason === 'off'\) return this\.giveUpCamera\(offMessage\(\)\)/, "a server with Presage off sends the game to the keyboard");
});

test('main.ts: the mode list, the start button and the hidden Presage UI follow the flag', async () => {
  const main = await src('main.ts');
  assert.match(main, /breathModeList\(\{ presage: PRESAGE_ENABLED, camera, dev: import\.meta\.env\.DEV \}\)/);
  const live = main.slice(main.indexOf("getElementById('start-live')!.addEventListener"), main.indexOf("getElementById('start-keys')!.addEventListener"));
  assert.ok(live.indexOf('if (!PRESAGE_ENABLED)') < live.indexOf('breath.startLive()'), 'START skips the camera and calibration');
  assert.match(main, /el\.classList\.toggle\('hidden', \(el\.dataset\.presage === 'on'\) !== PRESAGE_ENABLED\)/);
});

test('index.html: Presage-only UI is tagged, kept, and has a keyboard counterpart in both languages', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="start-live"[^>]*data-presage="on"/);
  assert.match(html, /<p [^>]*data-presage="on"[^>]*>Breath detection by Presage SmartSpectra/);
  assert.match(html, /<label [^>]*data-presage="on"[^>]*><span[^>]*>Camera preview/);
  const off = html.match(/<p class="[^"]*\bhidden\b[^"]*" data-presage="off" data-zh-html="([^"]*)">([^<]*<b>Shift<\/b>[^<]*)<\/p>/);
  assert.ok(off, 'a keyboard hint, hidden until main.ts shows it');
  assert.match(off[1], /Shift/);
});

test('report.ts: both disclaimers are kept, picked by the flag', async () => {
  const report = await src('report.ts');
  const fn = report.slice(report.indexOf('export function wellnessDisclaimer()'), report.indexOf('export class Report'));
  assert.match(fn, /if \(!PRESAGE_ENABLED\)/);
  assert.match(fn, /Presage SmartSpectra estimates/, 'the camera wording stays for when it comes back');
  assert.match(fn, /how long you held the dive key/);
  assert.match(report, /id="report-delete"/, 'deleting health data still works');
});

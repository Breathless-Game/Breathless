import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('synthesis station is switched off', () => {
  assert.match(read('src/synthesis.ts'), /export const SYNTHESIS_ENABLED = false;/);
});

test('workbench gates the rig and openSynthesis on the flag', () => {
  const src = read('src/workbench.ts');
  assert.match(src, /import \{ SYNTHESIS_ENABLED \} from '\.\/synthesis'/);
  assert.match(src, /this\.synthesisRig\.visible = SYNTHESIS_ENABLED;/);
  assert.match(src, /private openSynthesis\(\) \{\s*if \(!SYNTHESIS_ENABLED \|\| this\.state !== 'idle'\) return;/);
  assert.doesNotMatch(src, /synthesisRig\.visible = true/);
});

test('workbench hint no longer mentions the station', () => {
  const html = read('index.html');
  const hint = html.match(/<div id="wb-hint"[^>]*>[^<]*<\/div>/)?.[0] ?? '';
  assert.ok(hint, 'wb-hint present');
  assert.doesNotMatch(hint, /synthes|green station|合成|绿色工作站/i);
  assert.match(hint, /click the map to dive/);
  assert.match(hint, /点击海图下潜/);
});

test('field guide drops the synthesis chapter when the flag is off', () => {
  const src = read('src/field-guide.ts');
  assert.match(src, /import \{ SYNTHESIS_ENABLED \} from '\.\/synthesis'/);
  assert.match(src, /CHAPTERS\.filter\(c => SYNTHESIS_ENABLED \|\| c\.id !== 'synthesis'\)/);
  // tabs and pages both come from the filtered list
  assert.match(src, /shownChapters\(\)\.map\(\(_, i\) => `<button/);
  assert.match(src, /return shownChapters\(\)\.map\(/);
  assert.doesNotMatch(src, /\$\{CHAPTERS\.map/);
});

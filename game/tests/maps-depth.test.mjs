import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function moduleUrl(file, imports = {}) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const [name, url] of Object.entries(imports)) outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const rng = await moduleUrl('rng'), depthOdds = await moduleUrl('depth-odds'), marine = await moduleUrl('marine', { three: import.meta.resolve('three') });
const i18n = await moduleUrl('i18n');
const fish = await moduleUrl('fish', { three: import.meta.resolve('three'), './rng': rng, './depth-odds': depthOdds, './marine': marine, './i18n': i18n });
const wallet = `data:text/javascript;base64,${Buffer.from('export const storageKey = key => key;').toString('base64')}`;
const { MAPS, mapDepth, mapZones } = await import(await moduleUrl('maps', { './fish': fish, './wallet': wallet, './i18n': i18n }));

test('finite maps reach 120 m and 200 m while the ocean opens a trench below its 300 m shelf', () => {
  for (const [id, depth, trench] of [['fjord', 120, false], ['tianchi', 200, false], ['ocean', 300, true]]) {
    const map = MAPS[id], zones = mapZones(map);
    assert.equal(mapDepth(map), depth);
    assert.equal(map.hasTrench, trench);
    assert.equal(zones.length, map.zoneLabels.length);
    assert.equal(zones[0].top, 0);
    assert.equal(zones.at(-1).bottom, depth - 2, 'fish bands reach the expanded floor');
    zones.forEach((zone, i) => {
      assert.ok(zone.bottom > zone.top);
      if (i) assert.equal(zones[i - 1].bottom, zone.top, 'no unstocked depth gap');
    });
  }
});

test('floor depth and the last named zone can expand without adding zones or mutating shared rarity bands', async () => {
  const { ZONES } = await import(fish);
  const before = structuredClone(ZONES);
  const map = { ...MAPS.tianchi, seabedDepth: 140 };
  const zones = mapZones(map);
  assert.equal(zones.length, 3);
  assert.equal(zones[2].top, 38);
  assert.equal(zones[2].bottom, 138);
  assert.equal(mapDepth(map), 140);
  assert.deepEqual(ZONES, before, 'absolute-depth rarity and ocean reference bands are preserved');
});

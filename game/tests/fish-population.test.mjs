import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/fish-population.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { buildShelfFishBands, shelfFishWindow } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const zonesFor = (bottom, twoZones = false) => twoZones
  ? [{ top: 0, bottom: 18 }, { top: 18, bottom: bottom - 2 }]
  : [{ top: 0, bottom: 18 }, { top: 18, bottom: 38 }, { top: 38, bottom: bottom - 2 }];

test('every depth down to each expanded floor is covered without gaps or changes to the input zones', () => {
  for (const [depth, twoZones] of [[138, true], [269, false], [300, false]]) {
    const zones = zonesFor(depth, twoZones), before = structuredClone(zones), stock = buildShelfFishBands(zones);
    assert.deepEqual(zones, before);
    assert.equal(stock[0].band.top, 0);
    assert.equal(stock.at(-1).band.bottom, depth - 2);
    assert.equal(new Set(stock.map(slice => slice.key)).size, stock.length);
    stock.forEach(({ band, count }, i) => {
      assert.ok(band.bottom - band.top >= 4);
      assert.ok(count > 0 && count <= 36);
      if (i) assert.equal(stock[i-1].band.bottom, band.top);
    });
    // Densities retain the original depth-independent reference populations.
    assert.equal(stock[0].count, 32);
    assert.equal(stock[1].count, 32);
  }
});

test('a short final slice is joined to its neighbour rather than creating an invalid roam band', () => {
  const stock = buildShelfFishBands([{ top: 0, bottom: 42 }]);
  assert.deepEqual(stock.map(slice => slice.band), [{ top: 0, bottom: 20 }, { top: 20, bottom: 42 }]);
});

test('descent and ascent keep the visible water stocked with a bounded population', () => {
  for (const floor of [138, 269, 300, 2000]) {
    const stock = buildShelfFishBands(zonesFor(floor)), live = new Map();
    const traverse = depth => {
      const { load, keep } = shelfFishWindow(stock, depth);
      for (const key of live.keys()) if (!keep.has(key)) live.delete(key);
      for (const slice of load) if (!live.has(slice.key)) live.set(slice.key, slice);
      assert.ok([...live.values()].reduce((sum, slice) => sum + slice.count, 0) <= 240, `bounded at ${floor}/${depth}`);
      for (const slice of stock) {
        const visible = slice.band.top <= depth + 14 && slice.band.bottom >= depth - 14;
        if (visible) assert.ok(live.has(slice.key), `no empty visible slice at ${depth}`);
      }
    };
    for (let depth = 0; depth <= floor; depth++) traverse(depth);
    for (let depth = floor; depth >= 0; depth--) traverse(depth);
    assert.ok([...live.values()].every(slice => slice.band.top < 80), 'deep fish released after returning');
  }
});

test('new slices enter and old slices leave beyond the camera, with retention across small reversals', () => {
  const stock = buildShelfFishBands(zonesFor(300));
  let previous = shelfFishWindow(stock, 0);
  for (let depth = 1; depth <= 300; depth++) {
    const current = shelfFishWindow(stock, depth);
    for (const slice of current.load) if (!previous.load.some(old => old.key === slice.key)) {
      assert.ok(slice.band.top - depth > 14, 'spawn is below the visible frame');
    }
    for (const key of previous.keep) if (!current.keep.has(key)) {
      const slice = stock.find(slice => slice.key === key);
      assert.ok(depth - slice.band.bottom > 14, 'eviction is above the visible frame');
    }
    previous = current;
  }
  const loaded = shelfFishWindow(stock, 100).load;
  for (const depth of [95, 100, 105, 95, 100]) {
    const { keep } = shelfFishWindow(stock, depth);
    assert.ok(loaded.every(slice => keep.has(slice.key)), 'no churn during a short reversal');
  }
});

test('non-finite and negative depths produce a safe surface window', () => {
  const stock = buildShelfFishBands(zonesFor(300));
  for (const depth of [-1, NaN, Infinity]) assert.deepEqual(shelfFishWindow(stock, depth), shelfFishWindow(stock, 0));
});

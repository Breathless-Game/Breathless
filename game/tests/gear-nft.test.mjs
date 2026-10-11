import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { gearStem, parseGearPath, SHIP_NAMES as SERVER_SHIPS, BRANCHES as SERVER_BRANCHES } from '../../sensor/nft-gear.mjs';

// The Boat and Dive Kit NFT layout (src/gear-nft.ts): level <-> attributes <-> URI, the sync rules,
// and the grammar shared with the server (sensor/nft-gear.mjs).
const src = (file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(await src('gear-nft.ts'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const G = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const levels = (boat = {}, kit = {}) => ({
  boat: G.normalizeBoat({ ship: 0, ...boat }),
  kit: G.normalizeKit({ ...kit }),
});

test('ids, branches and ships match the game and the server', async () => {
  const upgrades = await src('upgrades.ts');
  const groups = Object.fromEntries([...upgrades.matchAll(/id: '(\w+)',\s*group: '(\w+)'/g)].map((m) => [m[1], m[2]]));
  // upgrades.ts writes some defs over several lines: id and group on their own lines.
  for (const m of upgrades.matchAll(/id: '(\w+)',\n\s*group: '(\w+)'/g)) groups[m[1]] = m[2];
  assert.deepEqual(Object.keys(groups).filter((id) => groups[id] === 'boat').sort(), [...G.BOAT_IDS].sort());
  assert.deepEqual(Object.keys(groups).filter((id) => groups[id] === 'dive').sort(), [...G.KIT_IDS].sort());

  const equipment = await src('equipment.ts');
  for (const slot of G.BRANCH_SLOTS) {
    const ids = [...equipment.matchAll(new RegExp(`pathDef\\('${slot}', '(\\w+)'`, 'g'))].map((m) => m[1]);
    assert.deepEqual(ids, [...G.BRANCHES[slot]], slot);
    assert.match(equipment, new RegExp(`${slot}: '${G.BRANCHES[slot][0]}'`), `${slot} default branch`);
  }
  const ships = [...(await src('ships.ts')).matchAll(/en: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ships, [...G.SHIP_NAMES]);
  assert.deepEqual([...G.SHIP_NAMES], SERVER_SHIPS);
  assert.deepEqual(JSON.parse(JSON.stringify(G.BRANCHES)), SERVER_BRANCHES);
});

test('levels encode into the meta path the server parses back exactly', () => {
  const l = levels({ ship: 4, bait: 2, boatDeck: 3 }, { rod: 2, net: 3, sonar: 2, fins: 1, branches: { rod: 'fast', net: 'fine', fins: 'silent' } });
  const boat = G.gearMetaPath('boat', l);
  const kit = G.gearMetaPath('kit', l);
  assert.equal(boat, '/api/nft/gear/v1/boat/4/2-1-1-1-3.json');
  // fins is Lv1, so its branch is the default whatever was stored.
  assert.equal(kit, '/api/nft/gear/v1/kit/2-1-3-1-1-1-2/fast-fine-sprint-long-focus-fastReel.json');
  for (const path of [boat, kit, G.gearImagePath('boat', l), G.gearImagePath('kit', l)]) {
    const parsed = parseGearPath(path);
    assert.ok(parsed, path);
    assert.equal(gearStem(parsed) + path.slice(path.lastIndexOf('.')), path);
  }
  assert.equal(G.gearPathOfUri(`https://breathless.gotclass.xyz${kit}`), kit);
  assert.equal(G.gearPathOfUri('https://elsewhere/api/nft/meta/v1/x.json'), null);
});

test('attributes carry absolute levels and decode back', () => {
  const l = levels({ ship: 2, boatHull: 3 }, { net: 3, lamp: 2, branches: { net: 'fine', lamp: 'wideLamp' } });
  const boat = G.gearAttributes('boat', l);
  assert.deepEqual(boat.slice(0, 4), [
    { key: 'kind', value: 'boat' },
    { key: 'schema', value: '1' },
    { key: 'ship', value: '2' },
    { key: 'shipName', value: 'Twin Cast' },
  ]);
  assert.deepEqual(boat.find((a) => a.key === 'boatHull'), { key: 'boatHull', value: '3' });
  const kit = G.gearAttributes('kit', l);
  assert.deepEqual(kit.find((a) => a.key === 'net'), { key: 'net', value: '3' });
  assert.deepEqual(kit.find((a) => a.key === 'netBranch'), { key: 'netBranch', value: 'fine' });
  assert.ok(kit.every((a) => typeof a.value === 'string'));
  assert.deepEqual(G.levelsFromAttributes('boat', boat), l.boat);
  assert.deepEqual(G.levelsFromAttributes('kit', kit), l.kit);
  assert.equal(G.levelsFromAttributes('kit', boat), null);
  // A reset to Lv1 (e.g. a penalty) is written as Lv1 with the default branch, never as a delta.
  const reset = G.gearAttributes('kit', levels({}, { net: 1, branches: { net: 'fine' } }));
  assert.deepEqual(reset.find((a) => a.key === 'netBranch'), { key: 'netBranch', value: 'wide' });
});

test('normalising clamps junk instead of throwing', () => {
  assert.deepEqual(G.normalizeBoat({ ship: 99, bait: 7, boat: -1, boatSpeed: 'x' }), { ship: 5, bait: 3, boat: 1, boatSpeed: 1, boatHull: 1, boatDeck: 1 });
  const k = G.normalizeKit({ net: '2', branches: { net: 'nope', rod: 'fast' } });
  assert.equal(k.net, 2);
  assert.equal(k.branches.net, 'wide');
  assert.equal(k.branches.rod, 'far'); // rod is Lv1
});

test('gearJob: mint, update, in step, backoff, pause, and another device', () => {
  const S = 'Sess1111111111111111111111111111111111111111';
  const A = 'Asset111111111111111111111111111111111111111';
  const P1 = '/api/nft/gear/v1/boat/0/1-1-1-1-1.json';
  const P2 = '/api/nft/gear/v1/boat/1/1-1-1-1-1.json';
  assert.equal(G.gearJob({}, P1, S, 0), 'mint');
  assert.equal(G.gearJob({ asset: A, authority: S, synced: P1 }, P1, S, 0), null);
  assert.equal(G.gearJob({ asset: A, authority: S, synced: P1 }, P2, S, 0), 'update');
  assert.equal(G.gearJob({ asset: A, authority: S, synced: P1, retryAt: 100 }, P2, S, 50), 'wait');
  assert.equal(G.gearJob({ asset: A, authority: S, synced: P1, retryAt: 100 }, P2, S, 150), 'update');
  assert.equal(G.gearJob({ asset: A, authority: S, synced: P1, fails: G.MAX_GEAR_FAILS }, P2, S, 0), 'paused');
  // Minted by another session key: this browser cannot update it, so it mints its own.
  assert.equal(G.gearJob({ asset: A, authority: 'Xther111111111111111111111111111111111111111', synced: P1 }, P1, S, 0), 'mint');
});

test('retry delay doubles to a 10 minute cap; debounce waits for quiet but not forever', () => {
  assert.deepEqual([1, 2, 3, 4].map(G.gearRetryDelay), [5000, 10000, 20000, 40000]);
  assert.equal(G.gearRetryDelay(20), 600000);
  assert.equal(G.gearDebounceDue(0, 1000, 2500, 15000), 3500);
  assert.equal(G.gearDebounceDue(0, 14000, 2500, 15000), 15000);
});

test('gearState: what the workbench card says', () => {
  const S = 'Sess1111111111111111111111111111111111111111';
  const A = 'Asset111111111111111111111111111111111111111';
  const P = '/api/nft/gear/v1/boat/0/1-1-1-1-1.json';
  const base = { rec: {}, desired: P, session: S, funds: 'ok', active: false, pending: false, now: 0 };
  assert.equal(G.gearState({ ...base, desired: null }), 'off');
  assert.equal(G.gearState(base), 'syncing');
  assert.equal(G.gearState({ ...base, funds: 'needs-sol' }), 'needs-sol');
  assert.equal(G.gearState({ ...base, funds: 'offline' }), 'offline');
  const synced = { asset: A, authority: S, synced: P };
  assert.equal(G.gearState({ ...base, rec: synced }), 'synced');
  assert.equal(G.gearState({ ...base, rec: synced, pending: true }), 'synced', 'a refresh that moved no level does not flash syncing');
  assert.equal(G.gearState({ ...base, rec: synced, desired: P.replace('/0/', '/1/'), pending: true }), 'syncing');
  assert.equal(G.gearState({ ...base, rec: synced, active: true }), 'syncing');
  assert.equal(G.gearState({ ...base, rec: { fails: 5 } }), 'paused');
  assert.equal(G.gearState({ ...base, rec: { fails: 1, retryAt: 10 } }), 'retrying');
  assert.equal(G.GEAR_STATE_LABELS.synced, 'On-chain ✓');
  assert.equal(G.GEAR_STATE_LABELS.syncing, 'Syncing to chain…');
  assert.equal(G.GEAR_STATE_LABELS['needs-sol'], 'Waiting for SOL');
});

test('parseGearRecord keeps good fields and drops junk', () => {
  const A = 'Asset111111111111111111111111111111111111111';
  const rec = G.parseGearRecord(
    JSON.stringify({
      boat: { asset: A, synced: '/api/nft/gear/v1/boat/0/1-1-1-1-1.json', fails: 2, retryAt: 5, pendingKey: Array(64).fill(7), evil: 1 },
      kit: { asset: 'not an address', synced: '/elsewhere', pendingKey: [1, 2], orphaned: [A, 5, 'x'] },
    }),
  );
  assert.deepEqual(rec.boat, { asset: A, synced: '/api/nft/gear/v1/boat/0/1-1-1-1-1.json', fails: 2, retryAt: 5, pendingKey: Array(64).fill(7) });
  assert.deepEqual(rec.kit, { orphaned: [A] });
  assert.deepEqual(G.parseGearRecord('{oops'), { boat: {}, kit: {} });
  assert.deepEqual(G.parseGearRecord(null), { boat: {}, kit: {} });
});

test('the level-change hook is wired where levels are saved', async () => {
  // main.ts refreshEquipment() is the one path that saves equipment levels (purchases, branch
  // switches, a shark bite's reset); ships.ts announces an equipped ship. Both must fire the hook.
  const main = await src('main.ts');
  const at = main.indexOf('function refreshEquipment() {');
  const refresh = main.slice(at, main.indexOf('\n}\n', at));
  assert.match(refresh, /gearLevelsChanged\(\)/);
  assert.match(refresh, /saveEquipment\(equipment\)/);
  assert.match(main, /onGearLevelsChanged\(\(\) => gearSync\.levelsChanged\(\)\)/);
  assert.match(await src('ships.ts'), /localStorage\.setItem\(storageKey\('ship-v2'\)[^\n]*gearLevelsChanged\(\)/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The shark-bite penalty (equipment.ts resetDiveGear, applied by main.ts resetDiveGearAfterBite and
// finished by refreshEquipment(), which saves and calls gearLevelsChanged()) reaches the on-chain
// Dive Kit like a purchase: GearSync coalesces, ONE update puts every dive level back to 1, and the
// Boat is not touched. Skipped until resetDiveGear exists on this branch.
const transpile = async (file) =>
  ts.transpileModule(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
const url = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const WALLET = url("export const storageKey = (name) => 'deepbreath.Owner.' + name.replace(/^deepbreath\\./, '');");
const LEVELS = url(await transpile('gear-levels.ts'));
const NFT = url(await transpile('gear-nft.ts'));
const E = await import(url((await transpile('equipment.ts')).replace(/from ['"]\.\/wallet['"]/, `from '${WALLET}'`)));
const { gearLevelsChanged, onGearLevelsChanged } = await import(LEVELS);
const G = await import(NFT);
const { GearSync, GEAR_QUIET_MS } = await import(url((await transpile('gear-sync.ts')).replace(/from ['"]\.\/gear-nft['"]/, `from '${NFT}'`)));

const SESSION = 'Sess1111111111111111111111111111111111111111';

test('a shark bite reset syncs the Dive Kit back to Lv1 in one update; the Boat is unchanged', { skip: !E.resetDiveGear && 'resetDiveGear is not on this branch yet' }, async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  let now = 0;
  const timers = new Map();
  let id = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => (timers.set(++id, { at: now + ms, fn }), id),
    clearTimeout: (i) => timers.delete(i),
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      await settle();
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
    await settle();
  };
  const calls = [];
  let n = 0;
  const chain = {
    balanceSol: async () => 1,
    airdrop: async () => {},
    newGearKey: () => Uint8Array.from({ length: 64 }, (_, i) => (i + ++n) % 256),
    mintGear: async (r) => (calls.push({ op: 'mint', ...r }), { asset: `Asset${n}`.padEnd(44, '1'), signature: 'S'.padEnd(64, '1'), uri: r.path }),
    updateGear: async (r) => (calls.push({ op: 'update', ...r }), { status: 'updated', signature: 'U'.padEnd(64, '1') }),
  };
  // The player's equipment, as main.ts holds it: upgraded dive gear with branches, on ship 4.
  let equipment = { ...E.loadEquipment(), netLevel: 3, rodLevel: 3, finsLevel: 2, tankLevel: 3, sonarLevel: 2, paths: { ...E.DEFAULT_EQUIPMENT_PATHS, net: 'fine', fins: 'silent' } };
  const snapshot = () => ({
    boat: G.normalizeBoat({ ship: 4 }),
    kit: G.normalizeKit({
      ...Object.fromEntries(G.KIT_IDS.map((k) => [k, E.ownedLevel(equipment, k)])),
      branches: Object.fromEntries(G.BRANCH_SLOTS.map((s) => [s, E.activePath(equipment, s)])),
    }),
  });
  const store = new Map();
  const sync = new GearSync({
    key: () => 'deepbreath.Owner.gear-nft',
    store: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    session: () => SESSION,
    snapshot,
    loadChain: async () => chain,
    isFundsError: () => false,
    timers: clock,
    changed: () => {},
  });
  const off = onGearLevelsChanged(() => sync.levelsChanged());
  sync.start(0);
  await advance(10);
  assert.deepEqual(calls.map((c) => c.kind), ['boat', 'kit']);
  assert.equal(calls[1].attributes.find((a) => a.key === 'net').value, '3');
  calls.length = 0;

  // main.ts resetDiveGearAfterBite: Object.assign(equipment, resetDiveGear(equipment).state); refreshEquipment(),
  // which saves (saveEquipment) and announces the change (gearLevelsChanged).
  equipment = { ...equipment, ...E.resetDiveGear(equipment).state };
  E.saveEquipment(equipment);
  gearLevelsChanged();
  await advance(GEAR_QUIET_MS + 10);

  assert.equal(calls.length, 1, 'one coalesced update');
  assert.equal(calls[0].op, 'update');
  assert.equal(calls[0].path, '/api/nft/gear/v1/kit/1-1-1-1-1-1-1/far-wide-sprint-long-focus-fastReel.json');
  for (const k of G.KIT_IDS) assert.equal(calls[0].attributes.find((a) => a.key === k).value, '1', k);
  assert.equal(calls[0].attributes.find((a) => a.key === 'netBranch').value, 'wide');
  assert.equal(sync.status('boat').state, 'synced');
  assert.equal(sync.status('kit').state, 'synced');
  off();
  sync.stop();
  delete globalThis.localStorage;
});

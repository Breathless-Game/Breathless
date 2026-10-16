import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Rebuilding the bank from the wallet's fish NFTs (src/chain-fish.ts): an NFT becomes the entry it
// was minted from, only the game's own fish are taken (no gear, nothing from other collections),
// and the merge only ever adds: by assetId, never twice, never deleting a local fish.

const transpile = (source) =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const load = async (file) =>
  import(`data:text/javascript;base64,${Buffer.from(transpile(await readFile(new URL(file, import.meta.url), 'utf8'))).toString('base64')}`);

const C = await load('../src/chain-fish.ts');
const market = await load('../src/market.ts');
// The market's port of the game's generator (fish-cosign.test.mjs checks it grows exactly fish.ts's fish).
const gen = await import(new URL('../../sensor/fish-gen.mjs', import.meta.url).href);

const COLLECTION = 'AB2Wss9G1w246PoTWc6CQQ4pKnxQKeY1vC6MmyCYvkx5';
const OWNER = '3bEJ1111111111111111111111111111111111TFfX';
const SESSION = 'Sess1on1111111111111111111111111111111111';
const MAPS = { fjord: { zoneLabels: ['Shallows'] }, tianchi: { zoneLabels: ['Shallows', 'Sunken Forest'] }, ocean: { zoneLabels: ['Shallows', 'Reef', 'Abyss'] } };
const grow = (seed, rarity) => gen.GENERATOR_V2.fishOf(seed, rarity);
const deps = { grow, legacyLook: gen.legacyLook, fishLook: gen.fishLook };
let n = 0;
const assetId = () => `Asset${String(++n).padStart(38, '1')}`;

/** A fish as the game rolled and banked it at a whole-metre depth. */
const caught = (seed, depth = 130) => gen.rollFish(seed, depth);

/** The Core asset the co-signed mint creates for it (chain.ts mintFish). */
function mintedAsset(fish, { serial = 42, ua = { type: 'Collection', address: COLLECTION }, zone = 'Reef', extra = {} } = {}) {
  const look = gen.fishLook(fish);
  const name = `${fish.name} #${String(serial).padStart(4, '0')}`;
  return {
    publicKey: assetId(),
    owner: OWNER,
    updateAuthority: ua,
    name,
    uri: `https://breathless.gotclass.xyz/api/nft/meta/v2/${serial}/${fish.id}/${fish.rarity}/${fish.depthM}-${fish.value}-${fish.lengthCm}-${fish.weightKg}/${look}/${encodeURIComponent(zone)}/${encodeURIComponent(fish.name)}.json`,
    attributes: {
      authority: { type: 'UpdateAuthority' },
      attributeList: [
        { key: 'rarity', value: fish.rarity },
        { key: 'species', value: fish.species },
        { key: 'depth', value: String(fish.depthM) },
        { key: 'value', value: String(fish.value) },
        { key: 'seed', value: fish.id },
      ],
    },
    ...extra,
  };
}

const rebuild = (asset) => {
  const owned = C.entryFromAsset(asset, { collection: COLLECTION, ...deps });
  return owned && C.bankedFromChain({ ...owned, trusted: owned.trust === 'collection' }, MAPS);
};

test('a minted fish rebuilds into the entry it was banked as', () => {
  for (const seed of [0x00c0ffee, 0x12345678, 0xdeadbeef, 7, 0xa5a5a5a5]) {
    const fish = caught(seed);
    const asset = mintedAsset(fish, { zone: 'Sunken Forest' });
    // What the bank held after the queue minted it (nft-queue.ts runMints), minus what the chain cannot know.
    const original = { ...market.bankEntry({ ...fish, map: 'tianchi' }), nft: 'minted', assetId: asset.publicKey, serial: 42, metaFixed: true, nameFixed: true, trusted: true };
    assert.deepEqual(rebuild(asset), original, `seed ${seed}`);
  }
});

test('the colours come from the NFT URI: random for a new fish, legacy for an old one, legacy for anything else', () => {
  const colours = (f) => ({ hue: f.hue, sat: f.sat, light: f.light, accentHue: f.accentHue, stripes: f.stripes });
  for (const seed of [0x00c0ffee, 0x12345678, 0xdeadbeef, 7]) {
    const fish = caught(seed);
    const old = gen.withLegacyLook(fish); // banked before random colours: what the bank (and its URI) holds
    assert.notEqual(gen.fishLook(old), gen.fishLook(fish));
    assert.deepEqual(colours(rebuild(mintedAsset(fish))), colours(fish), `new fish ${seed}`);
    const legacyAsset = mintedAsset(old);
    const original = { ...market.bankEntry({ ...old, map: 'ocean' }), nft: 'minted', assetId: legacyAsset.publicKey, serial: 42, metaFixed: true, nameFixed: true, trusted: true };
    assert.deepEqual(rebuild(legacyAsset), original, `old fish ${seed} rebuilds exactly as banked`);
    for (const uri of ['https://arweave.net/abc', 'garbage', '', gen.fishLook(fish)]) {
      assert.deepEqual(colours(rebuild({ ...mintedAsset(fish), uri })), colours(old), `${seed}: ${uri || '(empty)'}`);
    }
    // A look that is neither this seed's new nor its legacy look.
    const other = mintedAsset({ ...fish, hue: (fish.hue + 90) % 360 });
    assert.deepEqual(colours(rebuild(other)), colours(old), `${seed}: foreign look`);
  }
  assert.equal(C.lookSegmentOf('https://x.test/api/nft/meta/v1/0000beef/common/1-1-1-1/perch-40-20-50-220-3/Reef/Plain%20Grey%20Perch.json'), 'perch-40-20-50-220-3');
  assert.equal(C.lookSegmentOf('https://x.test/api/nft/meta/v2/42/0000beef/x.json'), null);
});

test('rebuild details: number from the name or the URI, the map only when the zone names one, a missing value stays missing', () => {
  const fish = caught(0x0badf00d, 30);
  const shallows = rebuild(mintedAsset(fish, { zone: 'Shallows' }));
  assert.equal(shallows.map, undefined); // three maps have Shallows
  assert.equal(rebuild(mintedAsset(fish, { zone: 'Abyss' })).map, 'ocean');

  const spec = { ...grow(fish.seed, fish.rarity), depthM: 30 };
  delete spec.value;
  const unnumbered = C.bankedFromChain({ assetId: 'A1', name: fish.name, uri: 'https://x/api/nft/meta/v1/x.json', spec, trusted: false });
  assert.equal(unnumbered.serial, undefined);
  assert.equal(unnumbered.nameFixed, undefined);
  assert.equal(unnumbered.metaFixed, true);
  assert.equal(unnumbered.trusted, undefined); // an older fish: the queue moves it into the collection
  assert.equal('value' in unnumbered, false); // fishValue() falls back to the rarity value, like an old save
  assert.equal(unnumbered.legacy, undefined);

  const irys = C.bankedFromChain({ assetId: 'A2', name: fish.name, uri: 'https://devnet.irys.xyz/abc', spec, trusted: false });
  assert.equal(irys.metaFixed, undefined); // the queue re-points it, as it would have
  assert.equal(C.serialOf('Plain Mud Goby', 'https://h/api/nft/meta/v2/77/00c0ffee/common/1-2-3-4/x/y/z.json'), 77);
  assert.equal(C.zoneOf('https://h/api/nft/meta/v1/00c0ffee/common/1-2-3-4/slim-1-2-3-4-0/The%20Trench/Plain%20Mud%20Goby.json'), 'The Trench');

  for (const bad of [null, { ...spec, rarity: 'shiny' }, { ...spec, seed: 1 }, { ...spec, depthM: 1.5 }, { ...spec, hue: NaN }, { ...spec, value: 0 }]) {
    assert.equal(C.bankedFromChain({ assetId: 'A3', name: '', uri: '', spec: bad, trusted: true }), null);
  }
  assert.equal(C.bankedFromChain({ assetId: '', name: '', uri: '', spec, trusted: true }), null);
});

test('the fallback takes only fish in the market collection that the generator grows', () => {
  const fish = caught(0x00c0ffee);
  assert.ok(rebuild(mintedAsset(fish)));
  // Boat / Dive Kit gear: session-key update authority, kind/schema/levels attributes, no seed.
  const gear = {
    publicKey: assetId(),
    owner: OWNER,
    updateAuthority: { type: 'Address', address: SESSION },
    name: 'Boat',
    uri: 'https://breathless.gotclass.xyz/api/nft/gear/boat.json',
    attributes: { authority: { type: 'UpdateAuthority' }, attributeList: [{ key: 'kind', value: 'boat' }, { key: 'schema', value: '1' }] },
  };
  assert.equal(C.entryFromAsset(gear, { collection: COLLECTION, ...deps }), null);
  // Gear dressed up with a seed is still not in the collection.
  assert.equal(C.entryFromAsset({ ...mintedAsset(fish), updateAuthority: { type: 'Address', address: SESSION } }, { collection: COLLECTION, ...deps }), null);
  // Another collection's NFT that copies a fish's attributes.
  assert.equal(C.entryFromAsset(mintedAsset(fish, { ua: { type: 'Collection', address: 'Other1111111111111111111111111111111111111' } }), { collection: COLLECTION, ...deps }), null);
  // No collection known (the market has not made it, or /info failed): nothing.
  assert.equal(C.entryFromAsset(mintedAsset(fish), { collection: null, ...deps }), null);
  // Attributes the generator cannot grow from that seed.
  const forged = mintedAsset(fish);
  forged.attributes.attributeList[1] = { key: 'species', value: 'Whale Shark' };
  assert.equal(C.entryFromAsset(forged, { collection: COLLECTION, ...deps }), null);
  // A plugin a game fish never has, or Attributes someone else controls.
  assert.equal(C.entryFromAsset(mintedAsset(fish, { extra: { permanentTransferDelegate: { authority: { type: 'Owner' } } } }), { collection: COLLECTION, ...deps }), null);
  const owned = mintedAsset(fish);
  owned.attributes.authority = { type: 'Owner' };
  assert.equal(C.entryFromAsset(owned, { collection: COLLECTION, ...deps }), null);
  // Out-of-range facts.
  const deep = mintedAsset(fish);
  deep.attributes.attributeList[2] = { key: 'depth', value: '5000' };
  assert.equal(C.entryFromAsset(deep, { collection: COLLECTION, ...deps }), null);
});

test('merge adds what the bank lacks, by assetId, and running it again changes nothing', () => {
  const a = rebuild(mintedAsset(caught(0x11111111)));
  const b = rebuild(mintedAsset(caught(0x22222222)));
  const local = { ...market.bankEntry(caught(0x33333333)), nft: 'minted', assetId: 'LocalAsset' };
  const bank = [local, { ...a }];
  const res = C.mergeChainFish(bank, [a, b, b]);
  assert.equal(res.added.length, 1);
  assert.equal(res.added[0], b);
  assert.deepEqual(res.adopted, []);
  assert.deepEqual(bank.map((f) => f.assetId), ['LocalAsset', a.assetId, b.assetId]);
  // Never deletes: the local fish the chain did not list is only reported.
  assert.deepEqual(res.missing, ['LocalAsset']);
  const again = C.mergeChainFish(bank, [a, b]);
  assert.equal(again.added.length + again.adopted.length, 0);
  assert.equal(bank.length, 3);
  // An empty answer (or a failed read handled by the caller) leaves the bank as it was.
  assert.equal(C.mergeChainFish(bank, []).added.length, 0);
  assert.equal(bank.length, 3);
});

test('merge adopts a local fish still waiting to mint instead of duplicating it, unless the queue holds it', () => {
  const fish = caught(0x44444444);
  const chainFish = rebuild(mintedAsset(fish));
  const pending = { ...market.bankEntry(fish), nft: 'failed', mintTries: 2, mintError: 'x', retryAt: 5 };
  const bank = [pending];
  const res = C.mergeChainFish(bank, [chainFish]);
  assert.equal(bank.length, 1);
  assert.equal(res.adopted[0], pending);
  assert.equal(pending.assetId, chainFish.assetId);
  assert.equal(pending.nft, 'minted');
  assert.equal(pending.trusted, true);
  assert.equal(pending.serial, 42);
  assert.equal(pending.mintTries, undefined);
  assert.equal(pending.retryAt, undefined);

  // Mid-mint: left to the queue (its mint adopts the same asset), and not added either.
  const minting = { ...market.bankEntry(fish), nft: 'minting' };
  const bank2 = [minting];
  assert.equal(C.mergeChainFish(bank2, [chainFish]).adopted.length, 0);
  assert.deepEqual(bank2, [minting]);
  const held = market.bankEntry(fish);
  const bank3 = [held];
  assert.equal(C.mergeChainFish(bank3, [chainFish], { busy: (f) => f === held }).added.length, 0);
  assert.equal(bank3.length, 1);
  assert.equal(held.assetId, undefined);

  // A legacy (paid-out) fish keeps its flag: adopting it never makes it sellable.
  const old = { ...fish, legacy: true };
  const bank4 = [old];
  C.mergeChainFish(bank4, [chainFish]);
  assert.equal(old.legacy, true);
  assert.equal(market.nftStep(old, { type: 'sell' }), old);
});

test('merge never brings back a fish this page just sold', () => {
  const a = rebuild(mintedAsset(caught(0x55555555)));
  const bank = [];
  const res = C.mergeChainFish(bank, [a], { skip: (id) => id === a.assetId });
  assert.equal(res.added.length, 0);
  assert.equal(bank.length, 0);
});

test('a rebuilt bank survives a reload unchanged (migrateBank)', () => {
  const bank = [];
  C.mergeChainFish(bank, [rebuild(mintedAsset(caught(0x66666666))), rebuild(mintedAsset(caught(0x77777777)))]);
  const { bank: loaded, changed } = market.migrateBank(JSON.parse(JSON.stringify(bank)));
  assert.equal(changed, false);
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(bank)));
});

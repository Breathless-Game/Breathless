import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { bundleFishCard, OUTFILE } from '../scripts/build-fish-card.mjs';
import { GENERATORS } from '../../sensor/fish-gen.mjs';
import { parseImagePath } from '../../sensor/nft-meta.mjs';
import { cardSpecFor, renderFishPng } from '../../sensor/fish-png.mjs';
import * as card from '../../sensor/fish-card.gen.mjs';

// The NFT image (sensor/fish-png.mjs) and the in-game card (src/portrait.ts fishCard) draw the fish
// from one code path, src/fish-card-geometry.ts, which the server gets as the committed bundle
// sensor/fish-card.gen.mjs. These tests keep the bundle current and the inputs identical: when the
// game's fish code changes (a species, a shape, a colour), the server's images change with it.

test('sensor/fish-card.gen.mjs is the current build of the game fish code (npm run build:fish-card)', async () => {
  const committed = await readFile(OUTFILE, 'utf8');
  const fresh = await bundleFishCard();
  assert.ok(
    committed === fresh,
    'sensor/fish-card.gen.mjs is stale: the NFT images would not match the game. Run `npm --prefix game run build:fish-card` and commit it.',
  );
});

test('portrait.ts draws the card through the shared pose, lights and spec', async () => {
  const src = await readFile(new URL('../src/portrait.ts', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/fish-card-geometry'/);
  assert.match(src, /poseCardFish\(fish, camera\)/);
  assert.match(src, /renderFish\(cardSpec\(spec\), CARD_FISH\.size\)/);
  assert.match(src, /CARD_LIGHTS\.dirs/);
  assert.doesNotMatch(src, /rotation\.set\(0, -0\.55/, 'the pose lives in fish-card-geometry.ts only');
});

const source = await readFile(new URL('../src/nft-uri.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { fishImagePath } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

/** One fish of every species of every generator (v1 legacy and v2), with fractional colours. */
function everySpecies() {
  const seen = new Map();
  for (const gen of GENERATORS) {
    for (const rarity of Object.keys(gen.SPECIES_BY_RARITY)) {
      for (let seed = 1; seed < 4000; seed++) {
        const f = gen.rollFish((seed * 2654435761) >>> 0, 0, [[rarity, 1]]);
        if (!seen.has(`${f.species}/${f.rarity}`)) seen.set(`${f.species}/${f.rarity}`, { ...f, serial: 1 + (seed % 900) });
      }
    }
  }
  return [...seen.values()];
}

test('the server draws each fish from the same spec the game card does', () => {
  const fish = everySpecies();
  assert.ok(fish.length >= 35, `only ${fish.length} species`);
  const species = new Set(fish.map((f) => f.species));
  for (const s of ['Hammerhead Shark', 'Reef Octopus', 'Lantern Angler', 'Whale Shark', 'Azure Tang', 'Ember Triggerfish']) assert.ok(species.has(s), s);
  for (const f of fish) {
    const parsed = parseImagePath(fishImagePath(f));
    assert.ok(parsed, f.name);
    const server = cardSpecFor(parsed);
    const game = card.cardSpec(f);
    assert.deepEqual(server, game, f.name);
    assert.equal(server.seed, f.seed, `${f.name}: seed from the id`);
  }
});

test('marine species are drawn as their own creatures, not the generic fish body', () => {
  const fish = everySpecies();
  const faces = (name) => card.cardGeometry(card.cardSpec(fish.find((f) => f.species === name))).length;
  // The generic body is ~100 triangles; a shark, an octopus or an angler is far more.
  const generic = faces('Grey Perch');
  for (const s of ['Hammerhead Shark', 'Reef Octopus', 'Lantern Angler', 'Whale Shark']) assert.ok(faces(s) > generic * 3, s);
});

test('the user-reported fish render to 512x512 PNGs, deterministically', () => {
  // Venomous Hammerhead Shark #0026, the image path minted on chain.
  const parsed = parseImagePath('/api/nft/img/v2/26/43d2622c/epic/bulky-292-82-56-121-0/Hammerhead%20Shark.png');
  const a = renderFishPng(parsed);
  const b = renderFishPng(parsed);
  assert.deepEqual([...a.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(a.readUInt32BE(16), 512);
  assert.equal(a.readUInt32BE(20), 512);
  assert.ok(a.equals(b));
});

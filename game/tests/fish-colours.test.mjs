import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseImagePath } from '../../sensor/nft-meta.mjs';
import { cardSpecFor } from '../../sensor/fish-png.mjs';

// Random fish colours (src/fish.ts lookOf): every new catch draws its colours from a stream of its
// own, so no two fish look alike; rarity still shows through the colour bands. The NFT card is drawn
// from the URI's look, so it shows exactly the game fish's colours. The field guide keeps each
// species' standard look (legacyLook), and the title screen's fish (title-fish-legacy.ts) are frozen.

const transpile = (source) =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;

/** src modules `entries` and everything they import, transpiled into a temp dir with three.js stubbed. */
async function load(entries) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-colours-'));
  try {
    writeFileSync(path.join(dir, 'three.mjs'), 'export {};\n');
    const todo = [...entries];
    const done = new Set();
    while (todo.length) {
      const name = todo.pop();
      if (done.has(name)) continue;
      done.add(name);
      let js = transpile(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'));
      for (const [, dep] of js.matchAll(/from '\.\/([\w-]+)'/g)) todo.push(dep);
      js = js.replace(/from 'three'/g, "from './three.mjs'").replace(/from '\.\/([\w-]+)'/g, "from './$1.mjs'");
      writeFileSync(path.join(dir, `${name}.mjs`), js);
    }
    const mods = await Promise.all(entries.map((n) => import(pathToFileURL(path.join(dir, `${n}.mjs`)).href)));
    return Object.fromEntries(entries.map((n, i) => [n, mods[i]]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { fish: F, 'nft-uri': U, 'depth-odds': D } = await load(['fish', 'nft-uri', 'depth-odds']);
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const PALETTE = {
  common: { hues: [20, 60], sat: [0.08, 0.25], light: [0.45, 0.6] },
  uncommon: { hues: [90, 170], sat: [0.35, 0.55], light: [0.45, 0.55] },
  rare: { hues: [185, 225], sat: [0.65, 0.85], light: [0.5, 0.6] },
  epic: { hues: [265, 330], sat: [0.6, 0.85], light: [0.5, 0.6] },
  legendary: { hues: [30, 48], sat: [0.85, 1], light: [0.52, 0.6] },
  mythic: { hues: [0, 360], sat: [0.8, 1], light: [0.6, 0.7] },
};
const seedAt = (i) => Math.imul(i + 1, 2654435761) >>> 0;
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test('1,000 fish of one species all get different colours', () => {
  const hues = new Set();
  const looks = new Set();
  let n = 0;
  for (let i = 0; n < 1000; i++) {
    const f = F.rollFish(seedAt(i), 0, [['uncommon', 1]]);
    if (f.species !== 'Striped Wrasse') continue;
    hues.add(f.hue);
    looks.add(U.fishLook(f));
    n++;
  }
  assert.equal(hues.size, 1000, 'every fish its own hue');
  // The URI rounds to whole degrees and percent, so a few rounded looks may coincide (a later variant settles those).
  assert.ok(looks.size >= 990, `${looks.size} distinct NFT looks`);
  // And the hues cover the whole wheel, not one band.
  const sextants = new Set([...hues].map((h) => Math.floor(h / 60)));
  assert.equal(sextants.size, 6);
});

test('colours keep the rarity readable: sat and light stay in the rarity band, the accent follows the rules', () => {
  for (const rarity of RARITIES) {
    const pal = PALETTE[rarity];
    const anchor = (pal.hues[0] + pal.hues[1]) / 2;
    let striped = 0;
    for (let i = 0; i < 2000; i++) {
      const seed = seedAt(i);
      const f = F.rollFish(seed, 0, [[rarity, 1]]);
      assert.deepEqual({ hue: f.hue, sat: f.sat, light: f.light, accentHue: f.accentHue, stripes: f.stripes }, F.lookOf(seed, rarity));
      assert.ok(f.hue >= 0 && f.hue < 360);
      assert.ok(f.sat >= pal.sat[0] && f.sat <= pal.sat[1], `${rarity} sat ${f.sat}`);
      assert.ok(f.light >= pal.light[0] && f.light <= pal.light[1], `${rarity} light ${f.light}`);
      assert.ok(f.accentHue >= 0 && f.accentHue < 360, `${rarity} accent ${f.accentHue}`);
      if (rarity === 'rare' || rarity === 'epic' || rarity === 'legendary') assert.ok(hueGap(f.accentHue, anchor) <= 30 + 1e-9, `${rarity} accent ${f.accentHue} near ${anchor}`);
      if (rarity === 'mythic') assert.ok(hueGap(f.accentHue, f.hue) >= 140 - 1e-9, `mythic accent opposite its body`);
      assert.ok(f.stripes === 0 || (f.stripes >= 2 && f.stripes <= 5));
      if (f.stripes) striped++;
    }
    assert.ok(striped > 2000 * 0.5 && striped < 2000 * 0.6, `${rarity}: ${striped} of 2000 striped (55%)`);
  }
  // Commons are free to take any hue, but stay muted.
  const commonHues = new Set(Array.from({ length: 600 }, (_, i) => Math.floor(F.rollFish(seedAt(i), 0, [['common', 1]]).hue / 60)));
  assert.equal(commonHues.size, 6);
});

test('only the colours changed: every other field is drawn as before, and legacyLook is the old colours', () => {
  // The main stream of rollFish before random colours, written out (fish.ts until this change).
  const shapes = { slim: { len: 1.5, height: 0.42 }, perch: { len: 1.3, height: 0.62 }, disc: { len: 1.0, height: 1.05 }, long: { len: 2.3, height: 0.4 }, bulky: { len: 1.8, height: 1.1 } };
  for (let i = 0; i < 3000; i++) {
    const seed = seedAt(i);
    const depth = (i * 1.37) % 500;
    const f = F.rollFish(seed, depth);
    const old = F.legacyLook(seed, f.rarity);
    // The old rollFish's draws: rarity, species, hue, scale, weight, epithet, sat, light, accent, stripes.
    const values = [];
    let s = seed >>> 0 || 0x9e3779b9;
    const next = () => {
      let t = (s = (s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let k = 0; k < 11; k++) values.push(next());
    const pal = PALETTE[f.rarity];
    const hue = pal.hues[0] + (pal.hues[1] - pal.hues[0]) * values[2];
    assert.equal(old.hue, hue);
    assert.equal(old.sat, pal.sat[0] + (pal.sat[1] - pal.sat[0]) * values[6]);
    assert.equal(old.light, pal.light[0] + (pal.light[1] - pal.light[0]) * values[7]);
    assert.equal(old.accentHue, (hue + 140 + 80 * values[8]) % 360);
    assert.equal(old.stripes, values[9] < 0.55 ? Math.floor(2 + 4 * values[10]) : 0);
    const scale = (0.85 + 0.4 * values[3]) * (1 + RARITIES.indexOf(f.rarity) * 0.12);
    assert.equal(f.scale, scale);
    assert.equal(f.lengthCm, Math.round(shapes[f.archetype].len * scale * 28));
    assert.equal(f.weightKg, +(Math.pow(f.lengthCm / 30, 3) * shapes[f.archetype].height * (0.7 + 0.4 * values[4])).toFixed(2));
    assert.equal(f.rarity, (() => {
      const odds = D.rarityOdds(depth);
      let r = values[0] * odds.reduce((a, [, w]) => a + w, 0);
      for (const [v, w] of odds) if ((r -= w) <= 0) return v;
      return odds[odds.length - 1][0];
    })());
  }
});

test('the NFT card gets exactly the game fish\'s colours from the URI, and only identity from the seed', () => {
  const marine = readFileSync(new URL('../src/marine.ts', import.meta.url), 'utf8');
  const table = marine.slice(marine.indexOf('const ARCHITECTURES'), marine.indexOf('};', marine.indexOf('const ARCHITECTURES')));
  const marineSpecies = new Set([...table.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]));
  assert.ok(marineSpecies.has('Hammerhead Shark') && marineSpecies.size >= 20);
  const deg = (x) => Math.round(((x % 360) + 360) % 360) % 360;
  const pct = (x) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
  let generic = 0;
  const species = new Set();
  for (let i = 0; generic < 200; i++) {
    const f = { ...F.rollFish(seedAt(i), 0, [[RARITIES[i % 6], 1]]), serial: 1 + i };
    if (marineSpecies.has(f.species)) continue;
    generic++;
    species.add(f.species);
    const parsed = parseImagePath(U.fishImagePath(f));
    assert.ok(parsed, f.name);
    const card = cardSpecFor(parsed);
    // Colours and shape: the fish's own, as the URL rounds them.
    assert.deepEqual(
      { archetype: card.archetype, hue: card.hue, sat: card.sat, light: card.light, accentHue: card.accentHue, stripes: card.stripes },
      { archetype: f.archetype, hue: deg(f.hue), sat: pct(f.sat), light: pct(f.light), accentHue: deg(f.accentHue), stripes: f.stripes },
      f.name,
    );
    // Identity: the species and rarity, and the seed from the id (the card's shards and grain).
    assert.deepEqual([card.species, card.rarity, card.seed], [f.species, f.rarity, f.seed]);
    // The URI's rounding is all that separates the card's fish from the aquarium's.
    assert.ok(hueGap(card.hue, f.hue) <= 0.5 && hueGap(card.accentHue, f.accentHue) <= 0.5 && Math.abs(card.sat - f.sat) <= 0.005 && Math.abs(card.light - f.light) <= 0.005);
  }
  assert.ok(species.size >= 10, `${species.size} generic-body species`);
});

test('the field guide keeps each species\' standard look (asset-library.ts specimens)', () => {
  // Every specimen as fish.ts rolled it before random colours (origin/main f098130).
  const pinned = JSON.parse(readFileSync(new URL('./fixtures/field-guide-specimens.json', import.meta.url), 'utf8'));
  const sampleDepth = D.RARITY_BY_DEPTH[D.RARITY_BY_DEPTH.length - 1][0];
  assert.equal(sampleDepth, pinned.sampleDepth);
  // findSpecimens(), as asset-library.ts runs it.
  const found = {};
  for (let seed = 1; seed <= 4000; seed++) {
    const rolled = F.rollFish(seed, sampleDepth);
    const spec = { ...rolled, ...F.legacyLook(seed, rolled.rarity) };
    if (found[spec.species]) continue;
    if (F.speciesProfile(spec).pattern === 'stripes' && spec.stripes === 0) continue;
    found[spec.species] = { seed, rarity: spec.rarity, look: U.fishLook(spec), hue: spec.hue, sat: spec.sat, light: spec.light, accentHue: spec.accentHue, stripes: spec.stripes };
  }
  assert.deepEqual(found, pinned.specimens);
  const src = readFileSync(new URL('../src/asset-library.ts', import.meta.url), 'utf8');
  assert.match(src, /const rolled = rollFish\(seed, SAMPLE_DEPTH\);\s+const spec: FishSpec = \{ \.\.\.rolled, \.\.\.legacyLook\(seed, rolled\.rarity\) \};/);
});

test('the title screen\'s fish come from the frozen legacy generator', () => {
  const title = readFileSync(new URL('../src/title.ts', import.meta.url), 'utf8');
  assert.match(title, /import \{[^}]*\brollFish\b[^}]*\} from '\.\/title-fish-legacy'/);
  const legacy = readFileSync(new URL('../src/title-fish-legacy.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(legacy, /lookOf|LOOK_SALT/);
});

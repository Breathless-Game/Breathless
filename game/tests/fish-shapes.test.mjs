import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';
import * as gen from '../../sensor/fish-gen.mjs';
import { parseImagePath, parseMetaPath } from '../../sensor/nft-meta.mjs';
import { cardSpecFor, renderFishPng } from '../../sensor/fish-png.mjs';
import * as card from '../../sensor/fish-card.gen.mjs';

// Random fish shapes (src/fish.ts geneOf / geneMultipliers / marineGene): every new catch carries a
// 64-bit shape gene from the end of its look stream. The generic body's eight knobs and a marine
// creature's proportions, limbs, taper and colours (within the species' palette) follow it; no gene (older
// fish, the field guide, a six-field URI) is exactly the species' standard shape. The gene rides in
// the NFT URI, so the card and the game draw the same fish.

async function moduleUrl(file, dependencies = {}) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  for (const [name, url] of Object.entries({ three: import.meta.resolve('three'), ...dependencies })) {
    for (const quote of ["'", '"']) outputText = outputText.replaceAll(`${quote}${name}${quote}`, JSON.stringify(url));
  }
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
const F = await import(await moduleUrl('fish', {
  './marine': await moduleUrl('marine'), './rng': await moduleUrl('rng'), './depth-odds': await moduleUrl('depth-odds'), './i18n': await moduleUrl('i18n'),
}));
const U = await import(await moduleUrl('nft-uri'));
const C = await import(await moduleUrl('chain-fish'));

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const seedAt = (i) => Math.imul(i + 1, 2654435761) >>> 0;
/** The first fish of a species, as the game rolls it today (with its gene). */
function specimen(species) {
  for (let i = 0; i < 20000; i++) for (const r of RARITIES) {
    const f = F.rollFish(seedAt(i), 0, [[r, 1]]);
    if (f.species === species) return f;
  }
  throw new Error(species);
}
const meshes = (fish) => { const out = []; fish.group.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };
const attr = (fish, name) => meshes(fish).flatMap((m) => [...(m.geometry.getAttribute(name)?.array ?? [])]);
const localBox = (fish) => {
  fish.group.scale.setScalar(1);
  fish.group.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(fish.group, true);
};

test('every new fish has a canonical gene, drawn after the colours (which are unchanged)', () => {
  const genes = new Set();
  for (let i = 0; i < 3000; i++) {
    const seed = seedAt(i);
    const r = RARITIES[i % 6];
    const f = F.rollFish(seed, 0, [[r, 1]]);
    assert.match(f.gene, /^[0-9a-f]{16}$/);
    assert.ok(F.isGene(f.gene));
    genes.add(f.gene);
    // The look stream's first six draws are PR #223's colours, exactly (the gene comes after them).
    let s = F.mix32(seed, F.LOOK_SALT, 0) >>> 0;
    const draws = [];
    const next = () => {
      let t = (s = (s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    if (s === 0) { s = -0x6d2b79f5 >>> 0; next(); }
    for (let k = 0; k < 8; k++) draws.push(next());
    assert.equal(f.hue, (draws[0] / 2 ** 32) * 360, `seed ${seed} hue`);
    assert.equal(f.gene, draws[6].toString(16).padStart(8, '0') + draws[7].toString(16).padStart(8, '0'), `seed ${seed} gene`);
    assert.deepEqual(F.lookOf(seed, r), gen.lookOf(seed, r), 'the market port agrees');
  }
  assert.equal(genes.size, 3000, 'no two alike');
  for (const bad of [undefined, null, '', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0', '0123456789abcdeg', 42]) assert.equal(F.isGene(bad), false, String(bad));
});

test('no gene means neutral: multipliers exactly 1, and the very same mesh', () => {
  assert.deepEqual(F.geneMultipliers(undefined), { tailTaper: 1, headVolume: 1, bodyWidth: 1, dorsal: 1, pectoral: 1, tailSpread: 1, height: 1, hump: 1 });
  assert.deepEqual(F.geneMultipliers('NOT-A-GENE'), F.geneMultipliers(null));
  for (const species of ['Grey Perch', 'Azure Tang', 'Golden Koi Dragon', 'Reef Octopus', 'Green Sea Turtle', 'Moon Jellyfish', 'Hammerhead Shark', 'Atlantic Salmon']) {
    const f = specimen(species);
    const plain = F.withoutGene(f);
    assert.equal('gene' in plain, false);
    const a = F.buildFishMesh(plain);
    const b = F.buildFishMesh({ ...plain, gene: undefined });
    const c = F.buildFishMesh({ ...plain, gene: 'xyz' }); // malformed: ignored, as fishLook leaves it out
    for (const name of ['position', 'color']) {
      assert.deepEqual(attr(b, name), attr(a, name), `${species} ${name}`);
      assert.deepEqual(attr(c, name), attr(a, name), `${species} ${name} (malformed gene)`);
    }
    // And a gene changes it.
    const g = F.buildFishMesh(f);
    assert.notDeepEqual(attr(g, 'position'), attr(a, 'position'), `${species}: the gene shows`);
    for (const m of [a, b, c, g]) F.disposeFishMesh(m);
  }
});

test('the generic body\'s eight knobs move within their bounds', () => {
  const range = { tailTaper: 0.3, headVolume: 0.3, bodyWidth: 0.3, dorsal: 0.5, pectoral: 0.45, tailSpread: 0.45, height: 0.3, hump: 0.35 };
  assert.deepEqual({ ...F.SHAPE_RANGE }, range);
  const lo = {}, hi = {};
  for (let i = 0; i < 4000; i++) {
    const m = F.geneMultipliers(F.lookOf(seedAt(i), 'common').gene);
    for (const [k, r] of Object.entries(range)) {
      assert.ok(m[k] >= 1 - r - 1e-12 && m[k] <= 1 + r + 1e-12, `${k} ${m[k]}`);
      lo[k] = Math.min(lo[k] ?? 9, m[k]);
      hi[k] = Math.max(hi[k] ?? 0, m[k]);
    }
  }
  for (const [k, r] of Object.entries(range)) assert.ok(lo[k] < 1 - r * 0.9 && hi[k] > 1 + r * 0.9, `${k} spans its range`);
  assert.equal(F.geneMultipliers('00ff000000000000').headVolume, 1.3);
  assert.equal(F.geneMultipliers('ff00000000000000').tailTaper, 1.3);
  assert.equal(F.geneMultipliers('000000000000ff00').height, 1.3);
  assert.equal(F.geneMultipliers('00000000000000ff').hump, 1.35);
});

test('the generic body\'s height gene: deeper or slimmer at the same length', () => {
  const f = F.withoutGene(specimen('Grey Perch'));
  const body = (gene) => {
    const mesh = F.buildFishMesh(gene ? { ...f, gene } : f);
    mesh.body.geometry.computeBoundingBox();
    return mesh.body.geometry.boundingBox.getSize(new THREE.Vector3());
  };
  // Only byte 6 (height) away from the middle; the other knobs at 0x80 (+0.4% of their range).
  const plain = body(), deep = body('808080808080ff80'), slim = body('8080808080800080');
  assert.ok(deep.y > plain.y * 1.25 && slim.y < plain.y * 0.75, `height ${slim.y} < ${plain.y} < ${deep.y}`);
  assert.ok(Math.abs(deep.x - plain.x) < 1e-6 && Math.abs(slim.x - plain.x) < 1e-6, 'length kept');
});

test('marine creatures: the gene rescales the body (baked into the geometry) and limbs', () => {
  // Byte 0 at its maximum (length +25%), the rest at the middle (0x80: ~+0.4% of their range; the
  // last byte's two hex digits 8: accent and taper +6.7% of theirs, so height and girth ±1.7% at the tips).
  const longer = 'ff80808080808088';
  for (const species of ['Atlantic Salmon', 'Hammerhead Shark', 'Whale Shark', 'Manta Ray', 'Green Sea Turtle']) {
    const f = F.withoutGene(specimen(species));
    const base = localBox(F.buildFishMesh(f)).getSize(new THREE.Vector3());
    const mesh = F.buildFishMesh({ ...f, gene: longer });
    const size = localBox(mesh).getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x / base.x - 1.25) < 0.015, `${species}: length ×${(size.x / base.x).toFixed(3)}`);
    assert.ok(Math.abs(size.y / base.y - 1) < 0.03 && Math.abs(size.z / base.z - 1) < 0.03, `${species}: height and girth kept ${size.y / base.y} ${size.z / base.z}`);
    // Not on group.scale (the card pose resets it): the card sees the longer fish too.
    assert.equal(mesh.group.scale.x, mesh.group.scale.y);
  }
  // Limbs: an octopus's arms (the tail rig) grow about their root.
  const octo = F.withoutGene(specimen('Reef Octopus'));
  const arms = (gene) => localBox(F.buildFishMesh(gene ? { ...octo, gene } : octo)).max.x;
  assert.ok(arms('808080ff80808088') > arms(undefined) + 0.25, 'longer arms');
  assert.ok(arms('8080800080808088') < arms(undefined) - 0.25, 'shorter arms');
  const m = F.marineGene('00ff00ff00ff00ff', [90, 170]);
  assert.deepEqual([m.length, m.height, m.girth, m.limbs, m.accentShift, m.taper], [0.75, 1.25, 0.75, 1.3, 0.08, 0.25]);
  // A band species' hue: around the band's middle, by up to 0.9 × its width (byte 4).
  assert.equal(m.bandHue, 58);
  assert.equal(F.marineGene('00000000ff000000', [90, 170]).bandHue, 202);
  assert.ok(Math.abs(F.marineGene('0000000000000000', [30, 48]).bandHue - 22.8) < 1e-9, 'legendary gold stays gold');
});

test('marine creatures: the taper makes one end heavier; a jellyfish (radial) ignores it', () => {
  // Same gene but the taper digit (the last): 0 → −25%, f → +25%.
  const heavy = (species, digit) => {
    const f = F.withoutGene(specimen(species));
    const mesh = F.buildFishMesh({ ...f, gene: `808080808080808${digit}` });
    mesh.group.scale.setScalar(1);
    mesh.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh.group, true);
    const mid = (box.min.x + box.max.x) / 2;
    // The tallest point on each half.
    let front = 0, back = 0;
    const p = new THREE.Vector3();
    for (const o of meshes(mesh)) {
      const pos = o.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (p.x > mid) front = Math.max(front, Math.abs(p.y)); else back = Math.max(back, Math.abs(p.y));
      }
    }
    return { front, back, positions: attr(mesh, 'position') };
  };
  for (const species of ['Atlantic Salmon', 'Bluefin Tuna', 'Whale Shark', 'Ribbon Moray']) {
    const a = heavy(species, '0'), b = heavy(species, 'f');
    assert.ok(b.front / b.back > (a.front / a.back) * 1.15, `${species}: f is front-heavier than 0 (${a.front / a.back} → ${b.front / b.back})`);
  }
  assert.deepEqual(heavy('Moon Jellyfish', '0').positions, heavy('Moon Jellyfish', 'f').positions);
});

test('marine creatures: colours stay within the species\' palette', () => {
  const hueOf = (r, g, b) => new THREE.Color(r, g, b).getHSL({}).h;
  const gap = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
  for (const species of ['Atlantic Salmon', 'Bluefin Tuna', 'Whale Shark', 'Sawshark', 'Green Sea Turtle', 'Chambered Nautilus', 'Manta Ray', 'Ribbon Moray', 'Lantern Angler']) {
    // Fixed-colour species: every face moves by at most the gene's hue shift (±36°), plus the
    // accent's own offset (±29°) on accent faces.
    const f = F.withoutGene(specimen(species));
    for (let i = 0; i < 8; i++) {
      const gene = F.lookOf(seedAt(i), f.rarity).gene;
      const g = F.marineGene(gene, [0, 0]);
      assert.ok(Math.abs(g.hueShift) <= 0.1 + 1e-12 && Math.abs(g.accentShift) <= 0.08 + 1e-12);
      const shift = Math.max(Math.abs(g.hueShift), Math.abs(g.hueShift + g.accentShift));
      const a = attr(F.buildFishMesh(f), 'color');
      const b = attr(F.buildFishMesh({ ...f, gene }), 'color');
      assert.equal(a.length, b.length);
      for (let k = 0; k < a.length; k += 3) {
        const sa = new THREE.Color(a[k], a[k + 1], a[k + 2]).getHSL({}).s;
        const sb = new THREE.Color(b[k], b[k + 1], b[k + 2]).getHSL({}).s;
        if (sa < 0.05 || sb < 0.05 || Math.max(a[k], a[k + 1], a[k + 2], b[k], b[k + 1], b[k + 2]) < 0.02) continue; // greys (before or after) have no hue to keep
        assert.ok(gap(hueOf(a[k], a[k + 1], a[k + 2]), hueOf(b[k], b[k + 1], b[k + 2])) <= shift + 0.01, `${species} face ${k / 3} ${[a[k], a[k + 1], a[k + 2]]} -> ${[b[k], b[k + 1], b[k + 2]]} shift ${shift}`);
      }
    }
  }
  // Species that took the fish's free hue now take one around their rarity's old band: the free hue
  // no longer shows, the hue stays near the band, and different genes spread across it.
  const bands = { uncommon: [90, 170], epic: [265, 330], legendary: [30, 48] };
  for (const species of ['Reef Octopus', 'Hammerhead Shark', 'Moon Jellyfish', 'Golden Sea Turtle']) {
    const f = specimen(species);
    const a = attr(F.buildFishMesh({ ...f, hue: 0 }), 'color');
    const b = attr(F.buildFishMesh({ ...f, hue: 200 }), 'color');
    assert.deepEqual(a, b, `the free hue does not reach a ${species} with a gene`);
    const [lo, hi] = bands[f.rarity];
    const hues = Array.from({ length: 400 }, (_, i) => F.marineGene(F.lookOf(seedAt(i), f.rarity).gene, [lo, hi]).bandHue);
    for (const h of hues) assert.ok(Math.abs(h - (lo + hi) / 2) <= 0.9 * (hi - lo) + 1e-9, `${species} ${h}`);
    assert.ok(Math.max(...hues) - Math.min(...hues) > 1.6 * (hi - lo), `${species}: genes spread across the band`);
    // Without a gene the free hue still shows, exactly as before (fish banked since random colours).
    const plain = F.withoutGene(f);
    assert.notDeepEqual(attr(F.buildFishMesh({ ...plain, hue: 0 }), 'color'), attr(F.buildFishMesh({ ...plain, hue: 200 }), 'color'), species);
  }
});

test('the NFT URI carries the gene: seven fields, and the card draws the same gene', () => {
  for (let i = 0; i < 300; i++) {
    const f = { ...F.rollFish(seedAt(i), 0, [[RARITIES[i % 6], 1]]), serial: 1 + i };
    const look = U.fishLook(f);
    assert.equal(look.split('-').length, 7);
    assert.equal(look.split('-')[6], f.gene);
    assert.equal(gen.fishLook(f), look, 'the market port writes the same look');
    const parsed = parseImagePath(U.fishImagePath(f));
    assert.equal(parsed.look.gene, f.gene);
    const server = cardSpecFor(parsed);
    assert.deepEqual(server, card.cardSpec(f));
    assert.equal(server.gene, f.gene);
    assert.equal(U.fishLook(F.withoutGene(f)).split('-').length, 6);
    assert.equal('gene' in card.cardSpec(F.withoutGene(f)), false);
  }
});

test('a gene changes the card; a six-field URI renders as before', () => {
  const p6 = '/api/nft/img/v2/26/43d2622c/epic/bulky-292-82-56-121-0/Hammerhead%20Shark.png';
  const gene = gen.fishOf(0x43d2622c, 'epic').gene;
  const p7 = p6.replace('-121-0/', `-121-0-${gene}/`);
  const six = parseImagePath(p6);
  const seven = parseImagePath(p7);
  assert.equal('gene' in six.look, false);
  assert.equal(seven.look.gene, gene);
  const a = renderFishPng(six);
  const b = renderFishPng(seven);
  assert.ok(!a.equals(b), 'the shape gene shows on the card');
  assert.ok(b.equals(renderFishPng(parseImagePath(p7))), 'deterministically');
  // The game's card faces for the same facts match the server's.
  assert.deepEqual(card.cardGeometry(cardSpecFor(seven)), card.cardGeometry(card.cardSpec({ ...seven, ...seven.look })));
});

test('the longest URI the game mints still fits the market\'s limit (MAX_URI 300)', () => {
  let longest = '';
  for (const [rarity, list] of Object.entries(gen.SPECIES_BY_RARITY)) {
    for (const [species, archetype] of list) {
      for (const epithet of ['Prismatic', 'Sunforged', 'Glimmering', 'Venomous', 'Speckled']) {
        const f = { ...F.rollFish(0xffffffff, 1000, [[rarity, 1]]), species, archetype, name: `${epithet} ${species}`, serial: 999_999_999, lengthCm: 99_999, weightKg: 99_999.99, hue: 359, accentHue: 359, sat: 1, light: 1, stripes: 5 };
        for (const zone of ['Sunken Forest', 'The Trench', 'Kelp Forest', 'Deep Basin']) {
          const uri = U.DEFAULT_NFT_ORIGIN + U.fishMetaPath(f, { depthM: 1000, value: 1_000_000, zone });
          if (uri.length > longest.length) longest = uri;
        }
      }
    }
  }
  assert.ok(parseMetaPath(new URL(longest).pathname), longest);
  assert.ok(longest.length <= 300, `${longest.length} chars: ${longest}`);
});

test('chain rebuild takes the gene from the URI: seven fields with this fish\'s gene, else none', () => {
  for (const seed of [0x00c0ffee, 0x12345678, 0xdeadbeef, 7]) {
    const grown = gen.GENERATOR_V3.fishOf(seed, 'rare');
    const uri = (f) => `https://breathless.gotclass.xyz/api/nft/meta/v2/1/${f.id}/${f.rarity}/1-1-1-1/${gen.fishLook(f)}/Reef/X.json`;
    const legacy = gen.legacyLook(seed, 'rare');
    const look = (f) => C.coloursFromUri(uri(f), grown, legacy, gen.fishLook);
    const colours = (f) => ({ hue: f.hue, sat: f.sat, light: f.light, accentHue: f.accentHue, stripes: f.stripes });
    assert.deepEqual(look(grown), { ...colours(grown), gene: grown.gene }, 'caught since random shapes');
    assert.deepEqual(look(gen.withoutGene(grown)), colours(grown), 'banked between random colours and random shapes: no gene key');
    assert.deepEqual(look(gen.withLegacyLook(grown)), legacy, 'banked before random colours');
    assert.deepEqual(look({ ...grown, gene: gen.lookOf(seed + 1, 'rare').gene }), legacy, 'another fish\'s gene');
    assert.deepEqual(look({ ...gen.withLegacyLook(grown), gene: grown.gene }), legacy, 'a gene on the legacy colours');
    // validSpec takes a canonical gene or none.
    assert.ok(C.validSpec(grown) && C.validSpec(gen.withoutGene(grown)));
    assert.equal(C.validSpec({ ...grown, gene: 'ABCDEF0123456789' }), false);
  }
});

// The game's fish generator, ported so the server can re-derive a fish from its seed: the same
// seed always grows the same fish. Mirrors game/src/rng.ts (mulberry32), game/src/depth-odds.ts
// (rarity by depth) and rollFish() in game/src/fish.ts, field for field, for every version of the
// generator that has minted fish (GENERATORS). Pure, no imports beyond market-rules.mjs, so
// `node --test` covers it.
//
// game/tests/fish-cosign.test.mjs and sensor/test/fish-gen-parity.test.mjs run the game's
// TypeScript next to this file over many seeds and depths and fail on any difference. When the game
// changes its generator, add a new version here (keep the old ones: their fish are still on-chain)
// and point CURRENT_GENERATOR at it.

import { RARITY_VALUE, rewardMultiplierAt } from './market-rules.mjs';

export const RARITY_ORDER = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);

/** mulberry32, exactly as game/src/rng.ts. */
export class Rng {
  constructor(seed) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }

  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  weighted(entries) {
    const total = entries.reduce((a, [, w]) => a + w, 0);
    let r = this.next() * total;
    for (const [v, w] of entries) {
      r -= w;
      if (r <= 0) return v;
    }
    return entries[entries.length - 1][0];
  }
}

// ---- Generator versions -----------------------------------------------------------------------
//
// The game changed its generator twice since fish went on-chain, and fish from all three are out
// there:
//   v1  17 species, the first rarity-by-depth table (plus, on the very first day, LEGACY_ZONES).
//       Every fish minted before PR #102 ("35-species marine roster ... depth balance", a84c64d).
//   v2  35 species and the table PR #102 rebalanced. Every fish minted after #102 and before v3.
//   v3  The same 35-species roster; legendary and mythic halved at every depth, the freed weight
//       moved to rare and epic (the "rarer legendary and mythic" PR). game/src/fish.ts and
//       depth-odds.ts today.
// Nothing on-chain says which one rolled a fish (the attributes are rarity / species / depth /
// value / seed), so the market accepts a fish that any generator grows from its seed
// (fish-trust.mjs checkFish). Each version is frozen: a later change to the game adds a v4 here.
// The gates are the same in v2 and v3 (legendary and mythic below 80 m) and v1's are shallower,
// so the top value a forger can claim is unchanged: every version reaches a mythic below 235 m.

/** depth-odds.ts RARITY_BY_DEPTH before PR #102 (v1). */
const RARITY_BY_DEPTH_V1 = Object.freeze([
  [0, [90, 9.5, 0.5, 0, 0, 0]],
  [15, [80, 17, 3, 0, 0, 0]],
  [30, [68, 24, 7, 1, 0, 0]],
  [50, [58, 28, 10.5, 3, 0.5, 0]],
  [80, [48, 31, 14, 5.5, 1.3, 0.2]],
  [120, [39, 32, 18, 8, 2.4, 0.6]],
  [200, [30, 30, 22, 12, 4.5, 1.5]],
  [350, [22, 26, 25, 16.5, 7.5, 3]],
]);

/** depth-odds.ts RARITY_BY_DEPTH from PR #102 until v3 (v2). */
const RARITY_BY_DEPTH_V2 = Object.freeze([
  [0, [92, 8, 0, 0, 0, 0]],
  [18, [75, 25, 0, 0, 0, 0]],
  [40, [55, 32, 13, 0, 0, 0]],
  [50, [48, 33, 16, 3, 0, 0]],
  [80, [35, 34, 24, 7, 0, 0]],
  [120, [9, 27, 30, 17, 12, 5]],
  [150, [3, 24, 33, 20.6, 14, 5.4]],
  [200, [0, 17, 34, 26, 17, 6]],
  [350, [0, 6, 30, 31, 23, 10]],
]);

/** depth-odds.ts RARITY_BY_DEPTH today (v3): v2 with legendary and mythic halved at every depth. */
const RARITY_BY_DEPTH_V3 = Object.freeze([
  [0, [92, 8, 0, 0, 0, 0]],
  [18, [75, 25, 0, 0, 0, 0]],
  [40, [55, 32, 13, 0, 0, 0]],
  [50, [48, 33, 16, 3, 0, 0]],
  [80, [35, 34, 24, 7, 0, 0]],
  [120, [9, 27, 35, 20.5, 6, 2.5]],
  [150, [3, 24, 38.5, 24.8, 7, 2.7]],
  [200, [0, 17, 40, 31.5, 8.5, 3]],
  [350, [0, 6, 38, 39.5, 11.5, 5]],
]);

/** weightsAt() in depth-odds.ts: linear between anchors, constant past the last, clamped at 0 m. */
function weightsAt(table, depthM) {
  const d = depthM > 0 ? depthM : 0;
  const last = table[table.length - 1];
  if (d >= last[0]) return last[1];
  let i = 0;
  while (table[i + 1][0] <= d) i++;
  const [d0, a] = table[i];
  const [d1, b] = table[i + 1];
  const t = (d - d0) / (d1 - d0);
  return a.map((w, k) => w + (b[k] - w) * t);
}

/** rarityOdds() in depth-odds.ts: `[rarity, weight]` pairs for Rng.weighted; zero weights left out. */
function oddsFrom(table, depthM) {
  const w = weightsAt(table, depthM);
  const odds = [];
  RARITY_ORDER.forEach((rarity, k) => {
    if (w[k] > 0) odds.push([rarity, w[k]]);
  });
  return odds;
}

/**
 * The fixed per-zone odds the game rolled with before rarity came from depth (fish.ts until
 * 6e4a0fe, 10 Oct 2026). Some fish minted that day were rolled with these (and the v1 roster); the
 * legacy migration and sales accept them. Zones: [top, bottom) metres and the catch multiplier the zone paid.
 */
export const LEGACY_ZONES = Object.freeze([
  { top: 0, bottom: 18, rewardMultiplier: 1, odds: [['common', 70], ['uncommon', 25], ['rare', 5]] },
  { top: 18, bottom: 38, rewardMultiplier: 1.6, odds: [['common', 20], ['uncommon', 35], ['rare', 30], ['epic', 13], ['legendary', 2]] },
  { top: 38, bottom: 58, rewardMultiplier: 2.5, odds: [['uncommon', 10], ['rare', 30], ['epic', 35], ['legendary', 19], ['mythic', 6]] },
]);

// ---- rollFish (game/src/fish.ts): only what decides the fish's identity and numbers ----------

/** Body length and height per archetype (SHAPES in fish.ts); the rest of the shape is for the mesh. */
const SHAPES = Object.freeze({
  slim: { len: 1.5, height: 0.42 },
  perch: { len: 1.3, height: 0.62 },
  disc: { len: 1.0, height: 1.05 },
  long: { len: 2.3, height: 0.4 },
  bulky: { len: 1.8, height: 1.1 },
});

const freezeRoster = (r) => Object.freeze(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Object.freeze(v.map((e) => Object.freeze(e)))])));

/** v1 SPECIES_BY_RARITY: [species, archetype], in the game's order (the RNG picks by index). */
const SPECIES_V1 = freezeRoster({
  common: [['Sand Minnow', 'slim'], ['Grey Perch', 'perch'], ['Mud Goby', 'slim']],
  uncommon: [['Striped Wrasse', 'slim'], ['Coral Chromis', 'perch'], ['Silver Snapper', 'perch']],
  rare: [['Azure Tang', 'disc'], ['Neon Cardinal', 'slim'], ['Spotted Grouper', 'bulky']],
  epic: [['Violet Lionfish', 'perch'], ['Ember Triggerfish', 'disc'], ['Ghost Angelfish', 'disc']],
  legendary: [['Golden Koi Dragon', 'long'], ['Abyssal Sunfish', 'bulky'], ['Crowned Sailfish', 'long']],
  mythic: [['Moonfin Leviathan', 'long'], ['Prism Coelacanth', 'bulky']],
});

/**
 * v2 and v3 SPECIES_BY_RARITY (fish.ts today; v3 kept the roster), in its order, including the
 * three species fish.ts appends after the literal (a copy of another species' profile under a new name, so its archetype).
 */
const SPECIES_V2 = freezeRoster({
  common: [['Sand Minnow', 'slim'], ['Grey Perch', 'perch'], ['Mud Goby', 'slim']],
  uncommon: [
    ['Atlantic Salmon', 'disc'], ['Bluefin Tuna', 'long'], ['Reef Octopus', 'perch'],
    ['Striped Wrasse', 'slim'], ['Coral Chromis', 'perch'], ['Silver Snapper', 'perch'],
  ],
  rare: [
    ['Manta Ray', 'disc'], ['Lantern Angler', 'bulky'], ['Ribbon Moray', 'slim'],
    ['Azure Tang', 'disc'], ['Neon Cardinal', 'slim'], ['Green Sea Turtle', 'bulky'],
    ['Jade Shell Turtle', 'long'], // appended: Coralback Titan Turtle's profile
  ],
  epic: [
    ['Hammerhead Shark', 'bulky'], ['Moon Jellyfish', 'long'], ['Chambered Nautilus', 'disc'],
    ['Violet Lionfish', 'perch'], ['Ember Triggerfish', 'disc'], ['Ghost Angelfish', 'disc'],
    ['Amethyst Cardinal', 'slim'], // appended: Neon Cardinal's profile
  ],
  legendary: [
    ['Lionmane Jellyfish', 'long'], ['Sawshark', 'long'], ['Golden Sea Turtle', 'disc'],
    ['Golden Koi Dragon', 'long'], ['Whale Shark', 'bulky'], ['Crowned Sailfish', 'long'],
    ['Suncrest Spearfish', 'bulky'], // appended: Hammerhead Shark's profile
  ],
  mythic: [
    ['Starcoil Eel', 'long'], ['Vampire Squid', 'bulky'], ['Coralback Titan Turtle', 'long'],
    ['Abyssal Giant Octopus', 'long'], ['Prism Crown Jellyfish', 'bulky'],
  ],
});

const EPITHETS = Object.freeze({
  common: ['Plain', 'Dusty', 'Little', 'Shy'],
  uncommon: ['Banded', 'Lively', 'Bright', 'Speckled'],
  rare: ['Glimmering', 'Deepwater', 'Royal', 'Twilight'],
  epic: ['Phantom', 'Venomous', 'Storm', 'Midnight'],
  legendary: ['Sunforged', 'Ancient', 'Crowned', 'Gilded'],
  mythic: ['Prismatic', 'Eternal', 'Starborn'],
});

const PALETTE = Object.freeze({
  common: { hues: [20, 60], sat: [0.08, 0.25], light: [0.45, 0.6] },
  uncommon: { hues: [90, 170], sat: [0.35, 0.55], light: [0.45, 0.55] },
  rare: { hues: [185, 225], sat: [0.65, 0.85], light: [0.5, 0.6] },
  epic: { hues: [265, 330], sat: [0.6, 0.85], light: [0.5, 0.6] },
  legendary: { hues: [30, 48], sat: [0.85, 1], light: [0.52, 0.6] },
  mythic: { hues: [0, 360], sat: [0.8, 1], light: [0.6, 0.7] },
});

/** MAX_RECORDED_DEPTH_M in fish.ts (MAX_DEPTH_M in market-rules.mjs). */
const MAX_RECORDED_DEPTH_M = 1000;

/** recordedDepth() in fish.ts: whole metres, 0..1000. */
export function recordedDepth(depthM) {
  return Math.min(MAX_RECORDED_DEPTH_M, Math.max(0, Math.round(depthM)));
}

/** rollFish(seed, depthM, odds) from fish.ts, with a given roster. */
function roll(species, seed, depthM, odds) {
  const rng = new Rng(seed);
  const rarity = rng.weighted(odds);
  const [name, archetype] = rng.pick(species[rarity]);
  const pal = PALETTE[rarity];
  const hue = rng.range(...pal.hues);
  const rarityIdx = RARITY_ORDER.indexOf(rarity);
  const scale = rng.range(0.85, 1.25) * (1 + rarityIdx * 0.12);
  const lengthCm = Math.round(SHAPES[archetype].len * scale * 28);
  const weightKg = +(Math.pow(lengthCm / 30, 3) * SHAPES[archetype].height * rng.range(0.7, 1.1)).toFixed(2);
  return {
    id: seed.toString(16).padStart(8, '0'),
    seed,
    rarity,
    species: name,
    name: `${rng.pick(EPITHETS[rarity])} ${name}`,
    archetype,
    lengthCm,
    weightKg,
    depthM: recordedDepth(depthM),
    hue,
    sat: rng.range(...pal.sat),
    light: rng.range(...pal.light),
    accentHue: (hue + rng.range(140, 220)) % 360,
    stripes: rng.next() < 0.55 ? rng.int(2, 5) : 0,
    scale,
    value: Math.round(RARITY_VALUE[rarity] * rewardMultiplierAt(depthM)),
  };
}

/** One frozen version of the game's generator. */
function generator(version, species, rarityByDepth, legacyZones = []) {
  const rarityOdds = (depthM) => oddsFrom(rarityByDepth, depthM);
  const rollFish = (seed, depthM, odds = rarityOdds(depthM)) => roll(species, seed, depthM, odds);
  return Object.freeze({
    version,
    SPECIES_BY_RARITY: species,
    RARITY_BY_DEPTH: rarityByDepth,
    /** Fixed zone odds this version also rolled with (v1's first day); [] for none. */
    legacyZones,
    rarityOdds,
    rollFish,
    /** Everything about a fish except where it was caught follows from its seed and rarity. */
    fishOf: (seed, rarity, depthM = 0) => rollFish(seed, depthM, [[rarity, 1]]),
    /** The rarity a seed rolls at a (spawn) depth with this version's odds. */
    rarityAt: (seed, depthM) => new Rng(seed).weighted(rarityOdds(depthM)),
  });
}

export const GENERATOR_V1 = generator(1, SPECIES_V1, RARITY_BY_DEPTH_V1, LEGACY_ZONES);
export const GENERATOR_V2 = generator(2, SPECIES_V2, RARITY_BY_DEPTH_V2);
export const GENERATOR_V3 = generator(3, SPECIES_V2, RARITY_BY_DEPTH_V3);

/** The generator the game runs today. */
export const CURRENT_GENERATOR = GENERATOR_V3;

/** Every generator a fish on-chain may have come from, newest first. */
export const GENERATORS = Object.freeze([GENERATOR_V3, GENERATOR_V2, GENERATOR_V1]);

// The current generator under the names the rest of the market (and the parity tests) use.
export const RARITY_BY_DEPTH = CURRENT_GENERATOR.RARITY_BY_DEPTH;
export const SPECIES_BY_RARITY = CURRENT_GENERATOR.SPECIES_BY_RARITY;
export const { rarityOdds, rollFish, fishOf, rarityAt } = CURRENT_GENERATOR;

/** A fish id is its seed in hex, eight digits (rollFish); the seed is read back from the last eight. */
export function seedOfId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id)) return null;
  return Number.parseInt(id, 16) >>> 0;
}

// ---- The NFT look path segment (game/src/nft-uri.ts fishLook) --------------------------------

const deg = (x) => Math.round(((x % 360) + 360) % 360) % 360;
const pct = (x) => Math.round(Math.min(1, Math.max(0, x)) * 100);
const nat = (x, max) => Math.min(max, Math.max(0, Math.round(Number(x) || 0)));

/** fishLook() in nft-uri.ts: "<archetype>-<hue>-<sat%>-<light%>-<accentHue>-<stripes>". */
export function fishLook(spec) {
  return [spec.archetype, deg(spec.hue), pct(spec.sat), pct(spec.light), deg(spec.accentHue), nat(spec.stripes, 9)].join('-');
}

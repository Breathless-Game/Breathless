import * as THREE from 'three';
import { rarityOdds } from './depth-odds';
import { Rng } from './rng';
import { buildMarineCreature, swimmingAnimation } from './marine';
import { lang } from './i18n';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

export const RARITY: Record<
  Rarity,
  { label: string; color: string; speed: number; flee: number; emissive: number; value: number }
> = {
  common: { label: 'Common', color: '#b8c4cc', speed: 2.2, flee: 3.0, emissive: 0, value: 1 },
  uncommon: { label: 'Uncommon', color: '#5fd38d', speed: 2.8, flee: 3.6, emissive: 0, value: 3 },
  rare: { label: 'Rare', color: '#4aa8ff', speed: 3.4, flee: 4.4, emissive: 0.05, value: 10 },
  epic: { label: 'Epic', color: '#b46cff', speed: 4.2, flee: 5.2, emissive: 0.15, value: 35 },
  legendary: { label: 'Legendary', color: '#ffb340', speed: 5.0, flee: 6.0, emissive: 0.45, value: 150 },
  mythic: { label: 'Mythic', color: '#ff5fd2', speed: 5.8, flee: 7.0, emissive: 0.7, value: 800 },
};

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

// Named depth bands near the surface. Rarity no longer comes from the band:
// it is a smooth function of depth (see depth-odds.ts). Below the shelf the
// sea keeps going as The Trench with no bottom. Deeper fish are also worth
// more: a fish's catch value is its rarity value times rewardMultiplierAt(depth).
export const ZONES = [
  { name: 'Shallows', rewardMultiplier: 1, top: 0, bottom: 18 },
  { name: 'Coral Reef', rewardMultiplier: 1.6, top: 18, bottom: 38 },
  { name: 'The Abyss', rewardMultiplier: 2.5, top: 38, bottom: 60 },
] as const;

export type Zone = (typeof ZONES)[number];

/** A vertical strip a fish lives in; depths in metres, positive down. */
export interface Band {
  top: number;
  bottom: number;
}

export type Archetype = 'slim' | 'perch' | 'disc' | 'long' | 'bulky';

const SHAPES: Record<Archetype, { len: number; height: number; width: number; tail: number; dorsal: number }> = {
  slim: { len: 1.5, height: 0.42, width: 0.28, tail: 0.45, dorsal: 0.25 },
  perch: { len: 1.3, height: 0.62, width: 0.34, tail: 0.5, dorsal: 0.35 },
  disc: { len: 1.0, height: 1.05, width: 0.24, tail: 0.45, dorsal: 0.45 },
  long: { len: 2.3, height: 0.4, width: 0.3, tail: 0.6, dorsal: 0.5 },
  bulky: { len: 1.8, height: 1.1, width: 0.6, tail: 0.75, dorsal: 0.4 },
};

export type FishPattern = 'solid' | 'stripes' | 'spots' | 'mask' | 'glow';

/**
 * Species-level traits are deliberately data, rather than branches in the
 * mesh builder. This keeps new species cheap to add and makes every fish
 * visually and behaviourally distinct while preserving seed determinism.
 */
export interface SpeciesProfile {
  /** Species-specific silhouette; absent for the original 17 species. */
  ornament?: string;
  species: string;
  archetype: Archetype;
  /** Multipliers applied to the archetype body at the tail and head. */
  tailTaper: number;
  headVolume: number;
  bodyWidth: number;
  dorsal: number;
  pectoral: number;
  tailSpread: number;
  pattern: FishPattern;
  /** Movement multipliers relative to rarity defaults. */
  swimSpeed: number;
  turnRate: number;
  fleeRadius: number;
}

const SPECIES_BY_RARITY: Record<Rarity, SpeciesProfile[]> = {
  common: [
    { species: 'Sand Minnow', archetype: 'slim', tailTaper: 0.58, headVolume: 0.82, bodyWidth: 0.82, dorsal: 0.7, pectoral: 0.75, tailSpread: 0.9, pattern: 'solid', swimSpeed: 1.18, turnRate: 3.4, fleeRadius: 0.95 },
    { species: 'Grey Perch', archetype: 'perch', tailTaper: 0.72, headVolume: 1.08, bodyWidth: 1.0, dorsal: 1.1, pectoral: 1.0, tailSpread: 1.0, pattern: 'stripes', swimSpeed: 0.94, turnRate: 2.5, fleeRadius: 1.0 },
    { species: 'Mud Goby', archetype: 'slim', tailTaper: 0.8, headVolume: 1.2, bodyWidth: 1.15, dorsal: 0.5, pectoral: 1.3, tailSpread: 0.8, pattern: 'spots', swimSpeed: 0.78, turnRate: 2.1, fleeRadius: 0.9 },
  ],
  uncommon: [
    { species: 'Atlantic Salmon', archetype: 'disc', ornament: 'ribbon', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.3, pectoral: 1.1, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Bluefin Tuna', archetype: 'long', ornament: 'spear', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 0.6, pectoral: 0.7, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Reef Octopus', archetype: 'perch', ornament: 'fan', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.5, pectoral: 1.5, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Striped Wrasse', archetype: 'slim', tailTaper: 0.62, headVolume: 0.98, bodyWidth: 0.9, dorsal: 1.2, pectoral: 0.9, tailSpread: 1.05, pattern: 'stripes', swimSpeed: 1.12, turnRate: 3.2, fleeRadius: 1.05 },
    { species: 'Coral Chromis', archetype: 'perch', tailTaper: 0.7, headVolume: 0.92, bodyWidth: 0.86, dorsal: 1.0, pectoral: 0.85, tailSpread: 1.1, pattern: 'glow', swimSpeed: 1.08, turnRate: 3.0, fleeRadius: 1.1 },
    { species: 'Silver Snapper', archetype: 'perch', tailTaper: 0.65, headVolume: 1.14, bodyWidth: 1.05, dorsal: 0.85, pectoral: 1.05, tailSpread: 0.95, pattern: 'mask', swimSpeed: 0.98, turnRate: 2.7, fleeRadius: 1.02 },
  ],
  rare: [
    { species: 'Manta Ray', archetype: 'disc', ornament: 'ray', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 0.5, pectoral: 2.4, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Lantern Angler', archetype: 'bulky', ornament: 'lantern', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 0.8, pectoral: 0.8, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Ribbon Moray', archetype: 'slim', ornament: 'crescent', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.8, pectoral: 1.2, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Azure Tang', archetype: 'disc', tailTaper: 0.7, headVolume: 0.9, bodyWidth: 1.0, dorsal: 1.2, pectoral: 0.85, tailSpread: 1.2, pattern: 'mask', swimSpeed: 1.06, turnRate: 2.8, fleeRadius: 1.05 },
    { species: 'Neon Cardinal', archetype: 'slim', tailTaper: 0.56, headVolume: 0.85, bodyWidth: 0.78, dorsal: 0.8, pectoral: 0.8, tailSpread: 1.25, pattern: 'stripes', swimSpeed: 1.25, turnRate: 3.7, fleeRadius: 1.14 },
    { species: 'Green Sea Turtle', archetype: 'bulky', tailTaper: 0.82, headVolume: 1.22, bodyWidth: 1.08, dorsal: 0.8, pectoral: 1.1, tailSpread: 0.85, pattern: 'spots', swimSpeed: 0.82, turnRate: 2.0, fleeRadius: 0.96 },
  ],
  epic: [
    { species: 'Hammerhead Shark', archetype: 'bulky', ornament: 'thorns', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.5, pectoral: 1.1, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Moon Jellyfish', archetype: 'long', ornament: 'veil', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.2, pectoral: 1.8, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Chambered Nautilus', archetype: 'disc', ornament: 'shell', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 0.5, pectoral: 1, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Violet Lionfish', archetype: 'perch', tailTaper: 0.72, headVolume: 0.96, bodyWidth: 0.95, dorsal: 1.9, pectoral: 1.45, tailSpread: 1.0, pattern: 'stripes', swimSpeed: 0.9, turnRate: 2.4, fleeRadius: 1.15 },
    { species: 'Ember Triggerfish', archetype: 'disc', tailTaper: 0.74, headVolume: 1.18, bodyWidth: 1.12, dorsal: 1.0, pectoral: 0.9, tailSpread: 0.9, pattern: 'mask', swimSpeed: 0.88, turnRate: 2.2, fleeRadius: 1.1 },
    { species: 'Ghost Angelfish', archetype: 'disc', tailTaper: 0.64, headVolume: 0.88, bodyWidth: 0.92, dorsal: 1.45, pectoral: 1.25, tailSpread: 1.08, pattern: 'glow', swimSpeed: 1.0, turnRate: 2.6, fleeRadius: 1.2 },
  ],
  legendary: [
    { species: 'Lionmane Jellyfish', archetype: 'long', ornament: 'phoenix', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.8, pectoral: 2.2, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Sawshark', archetype: 'long', ornament: 'trident', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.3, pectoral: 1.3, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Golden Sea Turtle', archetype: 'disc', ornament: 'crownray', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 0.7, pectoral: 2.8, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Golden Koi Dragon', archetype: 'long', tailTaper: 0.5, headVolume: 1.14, bodyWidth: 0.9, dorsal: 0.7, pectoral: 1.1, tailSpread: 1.35, pattern: 'stripes', swimSpeed: 0.94, turnRate: 2.0, fleeRadius: 1.12 },
    { species: 'Whale Shark', archetype: 'bulky', tailTaper: 0.9, headVolume: 1.28, bodyWidth: 1.2, dorsal: 0.65, pectoral: 0.8, tailSpread: 0.72, pattern: 'glow', swimSpeed: 0.7, turnRate: 1.6, fleeRadius: 1.25 },
    { species: 'Crowned Sailfish', archetype: 'long', tailTaper: 0.46, headVolume: 0.82, bodyWidth: 0.72, dorsal: 2.1, pectoral: 0.85, tailSpread: 1.5, pattern: 'mask', swimSpeed: 1.2, turnRate: 2.3, fleeRadius: 1.3 },
  ],
  mythic: [
    { species: 'Starcoil Eel', archetype: 'long', ornament: 'orbit', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.1, pectoral: 1.5, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Vampire Squid', archetype: 'bulky', ornament: 'cathedral', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 2, pectoral: 1.8, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Coralback Titan Turtle', archetype: 'long', ornament: 'worldtree', tailTaper: 0.55, headVolume: 1.05, bodyWidth: 0.95, dorsal: 1.5, pectoral: 2, tailSpread: 1.2, pattern: 'glow', swimSpeed: 0.95, turnRate: 2.6, fleeRadius: 1.15 },
    { species: 'Abyssal Giant Octopus', archetype: 'long', tailTaper: 0.42, headVolume: 1.2, bodyWidth: 0.88, dorsal: 1.35, pectoral: 1.2, tailSpread: 1.55, pattern: 'glow', swimSpeed: 0.88, turnRate: 1.8, fleeRadius: 1.35 },
    { species: 'Prism Crown Jellyfish', archetype: 'bulky', tailTaper: 0.78, headVolume: 1.12, bodyWidth: 1.08, dorsal: 1.15, pectoral: 1.35, tailSpread: 1.05, pattern: 'spots', swimSpeed: 0.76, turnRate: 1.9, fleeRadius: 1.3 },
  ],
};

// Keep the three incidental menu designs as independent, catchable species.
for (const [rarity,source,name] of [
  ['legendary','Hammerhead Shark','Suncrest Spearfish'],
  ['rare','Coralback Titan Turtle','Jade Shell Turtle'],
  ['epic','Neon Cardinal','Amethyst Cardinal'],
] as [Rarity,string,string][]) {
  const profile=Object.values(SPECIES_BY_RARITY).flat().find(p=>p.species===source)!;
  SPECIES_BY_RARITY[rarity].push({...profile,species:name});
}

const SPECIES_BY_NAME = new Map(
  Object.values(SPECIES_BY_RARITY).flat().map((profile) => [profile.species, profile]),
);

/** Resolve old saved fish that only contain the original species/archetype fields. */
export function speciesProfile(spec: Pick<FishSpec, 'species' | 'archetype'>): SpeciesProfile {
  return SPECIES_BY_NAME.get(spec.species) ?? {
    species: spec.species,
    archetype: spec.archetype,
    tailTaper: 0.7,
    headVolume: 1,
    bodyWidth: 1,
    dorsal: 1,
    pectoral: 1,
    tailSpread: 1,
    pattern: 'solid',
    swimSpeed: 1,
    turnRate: 2.5,
    fleeRadius: 1,
  };
}

const EPITHETS: Record<Rarity, string[]> = {
  common: ['Plain', 'Dusty', 'Little', 'Shy'],
  uncommon: ['Banded', 'Lively', 'Bright', 'Speckled'],
  rare: ['Glimmering', 'Deepwater', 'Royal', 'Twilight'],
  epic: ['Phantom', 'Venomous', 'Storm', 'Midnight'],
  legendary: ['Sunforged', 'Ancient', 'Crowned', 'Gilded'],
  mythic: ['Prismatic', 'Eternal', 'Starborn'],
};

// Hue ranges per rarity: dull greys up top, saturated neon down deep.
const PALETTE: Record<Rarity, { hues: [number, number]; sat: [number, number]; light: [number, number] }> = {
  common: { hues: [20, 60], sat: [0.08, 0.25], light: [0.45, 0.6] },
  uncommon: { hues: [90, 170], sat: [0.35, 0.55], light: [0.45, 0.55] },
  rare: { hues: [185, 225], sat: [0.65, 0.85], light: [0.5, 0.6] },
  epic: { hues: [265, 330], sat: [0.6, 0.85], light: [0.5, 0.6] },
  legendary: { hues: [30, 48], sat: [0.85, 1], light: [0.52, 0.6] },
  mythic: { hues: [0, 360], sat: [0.8, 1], light: [0.6, 0.7] },
};

export interface FishSpec {
  id: string;
  seed: number;
  rarity: Rarity;
  species: string;
  name: string;
  archetype: Archetype;
  lengthCm: number;
  weightKg: number;
  depthM: number;
  hue: number;
  sat: number;
  light: number;
  accentHue: number;
  stripes: number;
  scale: number;
  /** Catch value: rarity value × rewardMultiplierAt(depth). Fish banked before this field existed have none; read it with fishValue(). */
  value?: number;
  /** The map the fish was caught on (a MapId from maps.ts). Missing on fish banked before maps. */
  map?: string;
  /** Metaplex Core asset address once minted on devnet. */
  assetId?: string;
}

/** A fish's colours: everything fishLook() writes into the NFT URI besides the archetype. */
export type FishColours = Pick<FishSpec, 'hue' | 'sat' | 'light' | 'accentHue' | 'stripes'>;

// ---- The look stream --------------------------------------------------------------------------
//
// Since random colours, a fish's colours come from their own RNG stream, seeded by mixing the fish
// seed with LOOK_SALT (and a variant, 0 for now), so the main stream (rarity, species, size, weight,
// name) is untouched and every fish already caught or minted keeps its numbers. Fish caught before
// this kept the colours the main stream gave them (legacyLook): banked fish store them, and their
// NFT URIs carry them. sensor/fish-gen.mjs mirrors lookOf and legacyLook exactly.

/** Salt of the look stream. Not 0xabcdef: Fish's behaviour stream uses that (seed ^ 0xabcdef). */
export const LOOK_SALT = 0xc0105eed;

/** murmur3's 32-bit finaliser: a bijection on 32-bit integers. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The look stream's starting state for (seed, salt, variant). For a fixed salt and variant it is a
 * bijection of the seed (xor, fmix32, add, fmix32), so two seeds never share a look stream; for a
 * fixed seed, different variants give different states.
 */
export function mix32(seed: number, salt: number, variant = 0): number {
  return fmix32((fmix32((seed ^ salt) >>> 0) + Math.imul(variant >>> 0, 0x9e3779b1)) >>> 0);
}

/**
 * An Rng that starts at exactly `state`, 0 included. new Rng(0) would fall back to 0x9e3779b9 and
 * share that state's stream; instead start one step before 0 (mulberry32 adds 0x6d2b79f5 per draw)
 * and spend that step.
 */
function rngAtState(state: number): Rng {
  if (state >>> 0 !== 0) return new Rng(state);
  const rng = new Rng(-0x6d2b79f5 >>> 0);
  rng.next();
  return rng;
}

/** Where a rare-and-up fish's accent hue sits: the middle of its old PALETTE hue band, ±30°. */
const accentAnchor = (rarity: Rarity) => (PALETTE[rarity].hues[0] + PALETTE[rarity].hues[1]) / 2;

/**
 * A fish's random colours, from the look stream. Draws, in order (always six, whatever the rarity):
 *   hue        0..360, any colour
 *   sat        the rarity's PALETTE band (commons muted, deep fish vivid)
 *   light      the rarity's PALETTE band
 *   accentHue  common, uncommon: 0..360. rare, epic, legendary: the PALETTE band's middle ±30°.
 *              mythic: hue + 140..220 (opposite the body, as before)
 *   striped    stripes on 55% of fish
 *   count      2..5 stripes (drawn even when unstriped, so later draws never shift)
 * A later look field (a shape gene) goes after these, so these never change.
 */
export function lookOf(seed: number, rarity: Rarity, variant = 0): FishColours {
  const rng = rngAtState(mix32(seed, LOOK_SALT, variant));
  const pal = PALETTE[rarity];
  const hue = rng.range(0, 360);
  const sat = rng.range(...pal.sat);
  const light = rng.range(...pal.light);
  const a = rng.next();
  const accentHue =
    rarity === 'common' || rarity === 'uncommon'
      ? a * 360
      : rarity === 'mythic'
        ? (hue + 140 + 80 * a) % 360
        : (accentAnchor(rarity) - 30 + 60 * a + 360) % 360;
  const striped = rng.next() < 0.55;
  const count = rng.int(2, 5);
  return { hue, sat, light, accentHue, stripes: striped ? count : 0 };
}

/**
 * The colours rollFish gave a fish before random colours: drawn from its main stream, which for
 * every generator version runs rarity, species, hue, scale, weight, epithet, sat, light, accent,
 * stripes (weighted() and pick() each take one draw). Fish banked or minted before then carry these.
 */
export function legacyLook(seed: number, rarity: Rarity): FishColours {
  const rng = new Rng(seed);
  const pal = PALETTE[rarity];
  rng.next(); // rarity
  rng.next(); // species
  const hue = rng.range(...pal.hues);
  rng.next(); // scale
  rng.next(); // weight
  rng.next(); // epithet
  const sat = rng.range(...pal.sat);
  const light = rng.range(...pal.light);
  const accentHue = (hue + rng.range(140, 220)) % 360;
  const stripes = rng.next() < 0.55 ? rng.int(2, 5) : 0;
  return { hue, sat, light, accentHue, stripes };
}

export function rollFish(seed: number, depthM: number, odds = rarityOdds(depthM)): FishSpec {
  const rng = new Rng(seed);
  const rarity = rng.weighted(odds);
  const profile = rng.pick(SPECIES_BY_RARITY[rarity]);
  const { species, archetype } = profile;
  rng.next(); // the old hue (legacyLook): still drawn, so scale, weight and name stay where they were
  const rarityIdx = RARITY_ORDER.indexOf(rarity);
  const scale = rng.range(0.85, 1.25) * (1 + rarityIdx * 0.12);
  const lengthCm = Math.round(SHAPES[archetype].len * scale * 28);
  const weightKg = +(Math.pow(lengthCm / 30, 3) * SHAPES[archetype].height * rng.range(0.7, 1.1)).toFixed(2);
  const name = `${rng.pick(EPITHETS[rarity])} ${species}`;
  // The main stream's remaining draws were the old sat, light, accent and stripes; nothing after
  // them, so they are no longer drawn. The colours come from the look stream.
  const look = lookOf(seed, rarity);
  return {
    id: seed.toString(16).padStart(8, '0'),
    seed,
    rarity,
    species,
    name,
    archetype,
    lengthCm,
    weightKg,
    depthM: recordedDepth(depthM),
    hue: look.hue,
    sat: look.sat,
    light: look.light,
    accentHue: look.accentHue,
    stripes: look.stripes,
    scale,
    value: Math.round(RARITY[rarity].value * rewardMultiplierAt(depthM)),
  };
}

/** Catch value of a fish, falling back to the plain rarity value for old saves. */
export function fishValue(fish: FishSpec): number {
  return fish.value ?? RARITY[fish.rarity].value;
}

// In the trench the multiplier keeps climbing past the Abyss's 2.5: +1 every 50 m, up to 6.
// sensor/market-rules.mjs mirrors these (MAX_MULTIPLIER, TRENCH_STEP_M) to price a sale.
const TRENCH_TOP = ZONES[ZONES.length - 1].bottom;
export const MAX_REWARD_MULTIPLIER = 6;
const TRENCH_STEP_M = 50;

/**
 * The sea has no bottom, but the depth recorded on a caught fish (and written on-chain)
 * stops here. Odds and value stop changing far above it (350 m and 235 m), so nothing is
 * lost; the HUD still shows the real depth. The market rejects deeper fish:
 * MAX_DEPTH_M in sensor/market-rules.mjs must stay equal (its tests check).
 */
export const MAX_RECORDED_DEPTH_M = 1000;

/** Catch value multiplier for a fish caught at this depth. */
export function rewardMultiplierAt(depthM: number): number {
  if (depthM < TRENCH_TOP) return zoneForDepth(depthM).rewardMultiplier;
  return Math.min(MAX_REWARD_MULTIPLIER, ZONES[ZONES.length - 1].rewardMultiplier + (depthM - TRENCH_TOP) / TRENCH_STEP_M);
}

/** The depth to record for a fish caught `depthM` metres down: whole metres, at most MAX_RECORDED_DEPTH_M. */
export function recordedDepth(depthM: number): number {
  return Math.min(MAX_RECORDED_DEPTH_M, Math.max(0, Math.round(depthM)));
}

/** The depth zone a depth falls in, so callers do not repeat the cutoffs. */
export function zoneForDepth(depthM: number): Zone {
  return ZONES.find((zone) => depthM >= zone.top && depthM < zone.bottom) ?? ZONES[ZONES.length - 1];
}

// ---- Display names -------------------------------------------------------
// The stored English `name` / `species` never change (they are saved and go into NFT
// metadata); these helpers only translate what the player reads.
const SPECIES_ZH: Record<string, string> = {
  'Sand Minnow': '沙鲦', 'Grey Perch': '灰鲈', 'Mud Goby': '泥虾虎',
  'Atlantic Salmon': '大西洋鲑', 'Bluefin Tuna': '蓝鳍金枪鱼', 'Reef Octopus': '礁章鱼',
  'Striped Wrasse': '条纹隆头鱼', 'Coral Chromis': '珊瑚雀鲷', 'Silver Snapper': '银鲷',
  'Manta Ray': '蝠鲼', 'Lantern Angler': '灯笼鮟鱇', 'Ribbon Moray': '带纹海鳗',
  'Azure Tang': '蓝倒吊', 'Neon Cardinal': '霓虹天竺鲷', 'Green Sea Turtle': '绿海龟',
  'Hammerhead Shark': '双髻鲨', 'Moon Jellyfish': '海月水母', 'Chambered Nautilus': '鹦鹉螺',
  'Violet Lionfish': '紫狮子鱼', 'Ember Triggerfish': '炽炭鳞鲀', 'Ghost Angelfish': '幽灵神仙鱼',
  'Lionmane Jellyfish': '狮鬃水母', 'Sawshark': '锯鲨', 'Golden Sea Turtle': '金海龟',
  'Golden Koi Dragon': '金锦鲤龙', 'Whale Shark': '鲸鲨', 'Crowned Sailfish': '冠旗鱼',
  'Starcoil Eel': '星环鳗', 'Vampire Squid': '吸血鬼乌贼', 'Coralback Titan Turtle': '珊瑚背巨龟',
  'Abyssal Giant Octopus': '深渊巨章鱼', 'Prism Crown Jellyfish': '棱冠水母',
  'Suncrest Spearfish': '日冠枪鱼', 'Jade Shell Turtle': '玉甲龟', 'Amethyst Cardinal': '紫晶天竺鲷',
};
const EPITHET_ZH: Record<string, string> = {
  Plain: '素色', Dusty: '尘灰', Little: '小', Shy: '怕羞',
  Banded: '条纹', Lively: '活泼', Bright: '明亮', Speckled: '斑点',
  Glimmering: '微光', Deepwater: '深水', Royal: '皇家', Twilight: '暮色',
  Phantom: '幻影', Venomous: '毒刺', Storm: '风暴', Midnight: '子夜',
  Sunforged: '日铸', Ancient: '远古', Crowned: '加冕', Gilded: '鎏金',
  Prismatic: '棱彩', Eternal: '永恒', Starborn: '星生',
};
const ZONE_ZH: Record<string, string> = { Shallows: '浅滩', 'Coral Reef': '珊瑚礁', 'The Abyss': '深渊' };
const RARITY_ZH: Record<Rarity, string> = {
  common: '普通', uncommon: '少见', rare: '稀有', epic: '史诗', legendary: '传说', mythic: '神话',
};

/** Zone name in the player's language. */
export function zoneName(zone: { name: string }): string {
  return lang() === 'zh' ? ZONE_ZH[zone.name] ?? zone.name : zone.name;
}
/** Rarity label in the player's language (RARITY[r].label stays English). */
export function rarityLabel(r: Rarity): string {
  return lang() === 'zh' ? RARITY_ZH[r] : RARITY[r].label;
}
/** Species name in the player's language. */
export function speciesName(species: string): string {
  return lang() === 'zh' ? SPECIES_ZH[species] ?? species : species;
}
/** A generated fish's name in the player's language; 中文 is epithet + species with no space. */
export function fishDisplayName(fish: { name: string; species: string }): string {
  if (lang() !== 'zh') return fish.name;
  const suffix = ` ${fish.species}`;
  if (!fish.name.endsWith(suffix)) return SPECIES_ZH[fish.name] ?? fish.name;
  const epithet = EPITHET_ZH[fish.name.slice(0, -suffix.length)];
  const sp = SPECIES_ZH[fish.species];
  return epithet && sp ? epithet + sp : sp ?? fish.name;
}

// ---- Mesh ---------------------------------------------------------------

function hsl(h: number, s: number, l: number): THREE.Color {
  return new THREE.Color().setHSL(((h % 360) + 360) % 360 / 360, s, l);
}

/** Flat-shaded triangle soup with one colour per face: the low-poly look. */
class FaceBuilder {
  pos: number[] = [];
  col: number[] = [];

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const grain = Math.sin((a.x+b.x+c.x)*61+(a.y+b.y+c.y)*93+(a.z+b.z+c.z)*37)*43758.5453;
    const shade = 0.86+(grain-Math.floor(grain))*0.2;
    for (let i = 0; i < 3; i++) this.col.push(color.r*shade, color.g*shade, color.b*shade);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** A closed, thin fin membrane with faceted rays, rather than two coincident triangles. */
function finWeb(faces: FaceBuilder, outline: THREE.Vector3[], color: THREE.Color, thickness: THREE.Vector3) {
  for (let i = 1; i < outline.length - 1; i++) {
    const tint = color.clone().multiplyScalar(i % 2 ? 1 : 0.82);
    faces.tri(outline[0].clone().add(thickness), outline[i].clone().add(thickness), outline[i + 1].clone().add(thickness), tint);
    faces.tri(outline[0].clone().sub(thickness), outline[i + 1].clone().sub(thickness), outline[i].clone().sub(thickness), tint);
  }
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    faces.tri(a.clone().add(thickness), a.clone().sub(thickness), b.clone().add(thickness), color);
    faces.tri(b.clone().add(thickness), a.clone().sub(thickness), b.clone().sub(thickness), color);
  }
}

export interface FishMesh {
  animate?: (time: number, speed: number) => void;
  group: THREE.Group;
  tail: THREE.Object3D;
  material: THREE.MeshStandardMaterial;
  /** The body alone (no fins, tail or eyes), e.g. to carve into; and its unscaled proportions. */
  body: THREE.Mesh;
  size: { len: number; height: number; width: number };
  /** Extra yaw while swimming, for a model built leading with −x (an octopus jets mantle-first, arms trailing). Static renders ignore it. */
  swimYaw?: number;
}

/** A fish owns its surfaces; shared eyes and batched skins are released once each. */
export function disposeFishMesh(fish: FishMesh): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>([fish.material]);
  fish.group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

/** How finely the body is built. The game's fish are hexagonal, 6 rings long; more gives a smoother flank (e.g. to carve a name into). */
export interface FishDetail {
  rings: number;
  sides: number;
}

export const LOW_POLY: FishDetail = { rings: 6, sides: 6 };

export function buildFishMesh(spec: FishSpec, detail: FishDetail = LOW_POLY): FishMesh {
  const marine = buildMarineCreature(spec, RARITY[spec.rarity].emissive);
  if (marine) return marine;

  const shape = SHAPES[spec.archetype];
  const profile = speciesProfile(spec);
  const L = shape.len;
  const body = hsl(spec.hue, spec.sat * 0.65, spec.light * 0.9);
  const back = hsl(spec.hue, spec.sat * 0.65, spec.light * 0.63);
  const belly = hsl(spec.hue, spec.sat * 0.5, Math.min(0.92, spec.light * 1.45));
  const accent = hsl(spec.accentHue, Math.min(0.7, spec.sat * 0.8), 0.48);
  const fin = hsl(spec.hue + 15, spec.sat * 0.65, spec.light * 0.75);

  // Body: rings (hexagonal at the default detail) from tail root (t=0) to nose (t=1).
  const RINGS = THREE.MathUtils.clamp(Math.floor(detail.rings) || LOW_POLY.rings, 3, 32);
  const SIDES = THREE.MathUtils.clamp(Math.floor(detail.sides) || LOW_POLY.sides, 6, 32);
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const x = -L / 2 + t * L;
    const baseProfile = Math.sin(Math.PI * Math.pow(t, 0.78)) * 0.88 + 0.12;
    const tailTaper = THREE.MathUtils.lerp(profile.tailTaper, 1, Math.min(1, t / 0.35));
    const headVolume = t < 0.58 ? 1 : THREE.MathUtils.lerp(1, profile.headVolume, (t - 0.58) / 0.42);
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < SIDES; j++) {
      const a = (j / SIDES) * Math.PI * 2 + Math.PI / 2;
      ring.push(new THREE.Vector3(
        x,
        Math.sin(a) * shape.height * 0.5 * baseProfile * tailTaper * headVolume,
        Math.cos(a) * shape.width * profile.bodyWidth * 0.5 * baseProfile * tailTaper * headVolume,
      ));
    }
    rings.push(ring);
  }
  const fb = new FaceBuilder();
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = rings[i][j];
      const b = rings[i][(j + 1) % SIDES];
      const c = rings[i + 1][(j + 1) % SIDES];
      const d = rings[i + 1][j];
      const midY = (a.y + b.y + c.y + d.y) / 4;
      let color = midY > shape.height * 0.12 ? back : midY < -shape.height * 0.12 ? belly : body;
      const t = (i + 0.5) / RINGS;
      const upperBody = midY > -shape.height * 0.2;
      // Patterns are laid out on the 6 × 6 grid, so a finer body keeps the same markings.
      const pi = Math.floor((i * LOW_POLY.rings) / RINGS);
      const pj = Math.floor((j * LOW_POLY.sides) / SIDES);
      const patterned = (() => {
        switch (profile.pattern) {
          case 'stripes':
            return spec.stripes > 0 && pi > 0 && pi < LOW_POLY.rings - 1 && pi % 2 === (spec.stripes % 2);
          case 'spots':
            return upperBody && ((pi * 7 + pj * 3 + Math.floor(spec.hue)) % 11 < 3);
          case 'mask':
            return upperBody && t > 0.64;
          case 'glow':
            return upperBody && (pi + pj) % 3 === 0;
          default:
            return false;
        }
      })();
      if (patterned) color = accent;
      fb.tri(a, c, b, color);
      fb.tri(a, d, c, color);
    }
  }
  // Cap the nose and tail root.
  const nose = new THREE.Vector3(L / 2 + 0.06, 0, 0);
  const root = new THREE.Vector3(-L / 2, 0, 0);
  for (let j = 0; j < SIDES; j++) {
    fb.tri(rings[RINGS][j], rings[RINGS][(j + 1) % SIDES], nose, body);
    fb.tri(rings[0][(j + 1) % SIDES], rings[0][j], root, back);
  }
  // Sample the actual polygonal flank so eyes and fin roots sit on the skin.
  const section = (x: number) => {
    const station = THREE.MathUtils.clamp((x / L + 0.5) * RINGS, 0, RINGS);
    const index = Math.min(RINGS - 1, Math.floor(station));
    return rings[index].map((point, i) => point.clone().lerp(rings[index + 1][i], station - index));
  };
  const flank = (x: number, y: number) => {
    const cross = section(x); let width = 0;
    for (let i = 0; i < cross.length; i++) {
      const a = cross[i], b = cross[(i + 1) % cross.length];
      if (Math.abs(b.y - a.y) < 1e-8 || y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) continue;
      width = Math.max(width, THREE.MathUtils.lerp(a.z, b.z, (y - a.y) / (b.y - a.y)));
    }
    return width;
  };
  const roof = (x: number) => Math.max(...section(x).map(point => point.y));
  const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
  const finFaces = new FaceBuilder();
  const dorsalHeight = shape.dorsal * profile.dorsal;
  const dorsal = [-0.32, -0.2, -0.08, 0.08, 0.22].map((x, i) =>
    v(L * x, roof(L * x) - 0.008 + [0, 0.65, 1, 0.6, 0][i] * dorsalHeight));
  finWeb(finFaces, dorsal, profile.pattern === 'stripes' ? accent : fin, v(0, 0, 0.007));
  // Anal fin balances the dorsal silhouette; paired pectorals have a swept trailing edge.
  finWeb(finFaces, [v(-L * 0.25, -roof(-L * 0.25)), v(L * 0.08, -roof(L * 0.08)),
    v(-L * 0.12, -roof(-L * 0.12) - dorsalHeight * 0.42)], fin, v(0, 0, 0.006));
  for (const side of [-1, 1]) {
    const width = flank(L * 0.12, -shape.height * 0.1);
    finWeb(finFaces, [v(L * 0.18, -shape.height * 0.08, side * flank(L * 0.18, -shape.height * 0.08)),
      v(L * 0.02, -shape.height * 0.18, side * flank(L * 0.02, -shape.height * 0.18)),
      v(-L * 0.14, -shape.height * 0.24, side * (width + 0.2 * profile.pectoral)),
      v(-L * 0.03, -shape.height * 0.32, side * (width + 0.26 * profile.pectoral))], fin, v(0, 0.005, 0));
  }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true,
    roughness: 0.92, metalness: 0, emissive: hsl(spec.hue, 1, 0.5), emissiveIntensity: 0, side: THREE.DoubleSide });
  const bodyMesh = new THREE.Mesh(fb.build(), material); bodyMesh.name = 'fish-body';
  const fins = new THREE.Mesh(finFaces.build(), material); fins.name = 'fish-fins';
  const tb = new FaceBuilder();
  const tl = shape.tail * profile.tailSpread;
  const tailColor = profile.pattern === 'stripes' || profile.pattern === 'mask' ? accent : fin;
  finWeb(tb, [v(0, 0), v(-tl * 0.68, tl * 0.25), v(-tl, tl * 0.78),
    v(-tl * 0.56, 0), v(-tl, -tl * 0.78), v(-tl * 0.68, -tl * 0.25)], tailColor, v(0, 0, 0.008));
  const tail = new THREE.Mesh(tb.build(), material); tail.name = 'fish-tail';
  tail.position.x = -L / 2 + 0.02;
  const group = new THREE.Group(); group.name = spec.species;
  group.userData.swimPhase = ((Math.imul(spec.seed >>> 0, 0x9e3779b1) >>> 0) / 0x100000000) * Math.PI * 2;
  const eyeRadius = THREE.MathUtils.clamp(shape.height * 0.075, 0.032, 0.085);
  const eyeGeo = new THREE.IcosahedronGeometry(eyeRadius, 1);
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#10141b', flatShading: true, roughness: 0.55 });
  const irisGeo = new THREE.RingGeometry(eyeRadius * 0.65, eyeRadius * 1.12, 8);
  const irisMat = new THREE.MeshStandardMaterial({ color: belly, flatShading: true, roughness: 0.85, side: THREE.DoubleSide });
  const gills = new FaceBuilder();
  for (const side of [-1, 1]) {
    const x = L * 0.29, y = shape.height * 0.11, width = flank(x, y);
    const eye = new THREE.Mesh(eyeGeo, eyeMat); eye.name = 'fish-eye';
    eye.scale.set(1, 0.95, 0.45); eye.position.set(x, y, side * (width + eyeRadius * 0.2));
    const iris = new THREE.Mesh(irisGeo, irisMat); iris.name = 'fish-eye-rim';
    iris.position.set(x, y, side * (width + eyeRadius * 0.45));
    group.add(eye, iris);
    for (let i = 0; i < 3; i++) {
      const y0 = shape.height * (0.19 - i * 0.14), y1 = y0 - shape.height * 0.14;
      const x0 = L * (0.17 - i * 0.02), x1 = x0 - L * 0.025;
      const a = v(x0, y0, side * (flank(x0, y0) + 0.006));
      const b = v(x1, y1, side * (flank(x1, y1) + 0.006));
      gills.tri(side > 0 ? a : b, side > 0 ? b : a, v(b.x + 0.012, b.y, b.z), body);
    }
  }
  const gillMesh = new THREE.Mesh(gills.build(), eyeMat); gillMesh.name = 'fish-gills';
  group.add(bodyMesh, fins, tail, gillMesh);
  addSpeciesSilhouette(group, profile, shape, material, accent);
  group.scale.setScalar(spec.scale * 0.9 * 0.92);
  return { group, tail, material, animate: swimmingAnimation(group, tail, 'fish'), body: bodyMesh, size: { len: L, height: shape.height, width: shape.width * profile.bodyWidth } };

}

// ---- Behaviour ----------------------------------------------------------

/** Faceted structures, not palette swaps. All attachments share the body pivot. */
function addSpeciesSilhouette(
  group: THREE.Group,
  profile: SpeciesProfile,
  shape: { len: number; height: number; width: number },
  material: THREE.MeshStandardMaterial,
  accent: THREE.Color,
): void {
  const kind = profile.ornament;
  if (!kind) return;
  const L = shape.len;
  const H = shape.height;
  const fb = new FaceBuilder();
  const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => fb.tri(a, b, c, accent);
  const blade = (x: number, y: number, dx: number, dy: number, z = 0) =>
    tri(v(x - 0.1, y, z), v(x + 0.1, y, z), v(x + dx, y + dy, z));
  const branch = (a: THREE.Vector3, b: THREE.Vector3, radius = 0.035) => {
    const direction = b.clone().sub(a);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.4, radius, direction.length(), 5), material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(v(0, 1), direction.normalize());
    group.add(mesh);
  };
  const jewel = (position: THREE.Vector3, radius: number) => {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 0), material);
    mesh.position.copy(position); group.add(mesh);
  };
  const ribbon = (x: number, y: number, direction: number, length: number, z = 0) => {
    for (let i = 0; i < 6; i++) {
      const t = i / 6, n = (i + 1) / 6;
      const a = v(x - t * length, y + direction * (0.35 * t + Math.sin(t * 5) * 0.12), z);
      const b = v(x - n * length, y + direction * (0.35 * n + Math.sin(n * 5) * 0.12), z);
      tri(a, b, b.clone().add(v(0, direction * 0.09 * (1 - n), 0)));
    }
  };
  switch (kind) {
    case 'ribbon':
      ribbon(0, H * 0.45, 1, L * 0.75);
      ribbon(0, -H * 0.4, -1, L * 0.6);
      break;
    case 'spear':
      tri(v(L * 0.4, 0.08), v(L * 0.9, 0), v(L * 0.4, -0.08));
      break;
    case 'fan':
      for (let i = 0; i < 7; i++) blade(-L * 0.3 + i * L * 0.09, H * 0.25, -0.16, 0.3 + Math.sin(i / 6 * Math.PI) * 0.35);
      break;
    case 'ray':
    case 'crownray':
      for (const side of [-1, 1]) {
        tri(v(L * 0.35, 0, side * 0.08), v(-L * 0.4, -0.08, side * 0.1), v(-L * 0.2, 0.2, side * 1.1));
        // Visible wing tips in the game's side-on view as well as in 3D.
        blade(-0.1, side * H * 0.3, -0.2, side * H * 0.55, side * 0.5);
      }
      branch(v(-L * 0.4, 0), v(-L * 1.4, -0.15), 0.025);
      if (kind === 'crownray') for (let i = 0; i < 5; i++) {
        const x = (i - 2) * 0.16, y = H * 0.45;
        branch(v(x, y), v(x, y + 0.35 + (2 - Math.abs(i - 2)) * 0.12));
        jewel(v(x, y + 0.35 + (2 - Math.abs(i - 2)) * 0.12), 0.09);
      }
      break;
    case 'lantern':
      branch(v(L * 0.25, H * 0.3), v(L * 0.35, H * 0.85));
      branch(v(L * 0.35, H * 0.85), v(L * 0.65, H * 0.65));
      jewel(v(L * 0.65, H * 0.65), 0.14);
      break;
    case 'crescent':
      for (const side of [-1, 1]) {
        tri(v(-L * 0.1, 0), v(-L * 0.6, side * H * 0.4), v(-L * 0.35, side * H * 1.6));
      }
      break;
    case 'thorns':
      for (let i = 0; i < 8; i++) for (const side of [-1, 1])
        blade(-L * 0.35 + i * L * 0.1, side * H * 0.3, -0.12, side * (0.3 + (i % 3) * 0.12));
      break;
    case 'veil':
      for (let i = 0; i < 5; i++) for (const side of [-1, 1])
        ribbon(L * 0.15 - i * 0.12, side * H * 0.3, side, L * (0.65 + i * 0.12), (i - 2) * 0.08);
      break;
    case 'shell':
      for (let i = 0; i < 13; i++) {
        const a = i * 0.58, r = 0.06 + i * 0.035;
        jewel(v(Math.cos(a) * r, Math.sin(a) * r, shape.width * 0.65), 0.09 + i * 0.004);
      }
      for (let i = 0; i < 4; i++) ribbon(L * 0.4, -i * 0.1, -1, -L * 0.65);
      break;
    case 'phoenix':
      for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
        blade(L * 0.1 - i * 0.14, side * H * 0.2, -0.35 - i * 0.05, side * (0.9 - i * 0.08), side * 0.2);
        ribbon(-L * 0.4, side * 0.12, side, L * 0.7, i * 0.05);
      }
      break;
    case 'trident':
      for (let i = -1; i <= 1; i++)
        tri(v(L * 0.4, i * 0.1), v(L * 0.95, i * 0.24), v(L * 0.4, i * 0.1 + 0.06));
      for (let i = 0; i < 5; i++) jewel(v(-L * 0.25 + i * 0.22, H * 0.4), 0.12);
      break;
    case 'orbit':
      for (let i = 0; i < 3; i++) {
        const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.48 + i * 0.09, 0.035, 4, 12), material);
        mesh.position.x = -L * 0.3 + i * L * 0.3;
        mesh.rotation.y = 0.55 + i * 0.3; group.add(mesh);
        jewel(v(mesh.position.x, 0.65, 0), 0.08);
      }
      ribbon(-L * 0.4, 0, 1, L);
      break;
    case 'cathedral':
      for (const side of [-1, 1]) for (let i = 0; i < 5; i++) {
        const x = -L * 0.3 + i * L * 0.15, height = 0.55 + Math.sin(i / 4 * Math.PI) * 0.55;
        branch(v(x, side * H * 0.25), v(x, side * (H * 0.25 + height)), 0.065);
        blade(x, side * (H * 0.25 + height), 0, side * 0.22);
        if (i < 4) branch(v(x, side * (H * 0.25 + height * 0.75)), v(x + L * 0.15, side * (H * 0.25 + height * 0.75)), 0.035);
      }
      break;
    case 'worldtree':
      for (let i = 0; i < 5; i++) {
        const x = -L * 0.3 + i * L * 0.15, height = 0.45 + Math.sin(i / 4 * Math.PI) * 0.55;
        const tip = v(x, H * 0.3 + height);
        branch(v(x, H * 0.2), tip);
        for (const side of [-1, 1]) {
          const end = tip.clone().add(v(side * 0.25, 0.18));
          branch(tip.clone().add(v(0, -0.18)), end);
          jewel(end, 0.12);
          ribbon(x, -H * 0.25, -1, 0.6 + i * 0.15);
        }
      }
      break;
  }
  group.add(new THREE.Mesh(fb.build(), material));
}

export class Fish {
  spec: FishSpec;
  mesh: FishMesh;
  pos: THREE.Vector3;
  vel = new THREE.Vector3();
  target = new THREE.Vector3();
  band: Band;
  facing = 1;
  phase: number;
  readonly visualRadius: number;
  private rng: Rng;

  constructor(spec: FishSpec, band: Band, x: number, y: number, worldHalfWidth: number) {
    this.spec = spec;
    this.profile = speciesProfile(spec);
    this.band = band;
    this.mesh = buildFishMesh(spec);
    const visualBounds = new THREE.Box3().setFromObject(this.mesh.group).getBoundingSphere(new THREE.Sphere());
    this.visualRadius = visualBounds.radius * 1.25 + visualBounds.center.length() + 0.2;
    this.rng = new Rng(spec.seed ^ 0xabcdef);
    this.pos = new THREE.Vector3(x, y, this.rng.range(-4, 2));
    this.phase = this.rng.range(0, Math.PI * 2);
    this.leftBound = -Math.max(0, Number.isFinite(worldHalfWidth) ? worldHalfWidth : 0);
    this.rightBound = -this.leftBound;
    this.pickTarget();
    this.mesh.group.position.copy(this.pos);
  }

  private leftBound: number;
  private rightBound: number;
  private readonly profile: SpeciesProfile;
  private readonly toDiver = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  /** Update the fish corridor when the player opens a new side of the map. */
  setWorldBounds(left: number, right: number): void {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return;
    this.leftBound = Math.min(left, right);
    this.rightBound = Math.max(left, right);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, this.leftBound, this.rightBound);
    this.target.x = THREE.MathUtils.clamp(this.target.x, this.leftBound, this.rightBound);
  }

  private pickTarget() {
    const span = 18;
    this.target.set(
      THREE.MathUtils.clamp(this.pos.x + this.rng.range(-span, span), this.leftBound, this.rightBound),
      -this.rng.range(this.band.top + 1.5, this.band.bottom - 0.5),
      this.rng.range(-4, 2),
    );
  }

  update(dt: number, time: number, diverPos: THREE.Vector3, animate = true) {
    const r = RARITY[this.spec.rarity];
    const toDiver = this.toDiver.copy(this.pos).sub(diverPos);
    toDiver.z = 0;
    const dist = toDiver.length();
    const fleeRadius = r.flee * this.profile.fleeRadius;
    const speed = r.speed * this.profile.swimSpeed;
    const desired = this.desired;
    if (dist < fleeRadius) {
      // Flee, harder the closer the diver gets.
      // Avoid normalising a zero vector when the diver overlaps the fish.
      if (dist < 1e-4) {
        desired.set(this.facing || 1, 0, 0);
      } else {
        desired.copy(toDiver).multiplyScalar(1 / dist);
      }
      desired.multiplyScalar(speed * (1.6 + (fleeRadius - dist) / fleeRadius));
    } else {
      const toTarget = this.toTarget.copy(this.target).sub(this.pos);
      if (toTarget.length() < 1.5) {
        this.pickTarget();
        toTarget.copy(this.target).sub(this.pos);
      }
      desired.copy(toTarget.normalize()).multiplyScalar(speed * 0.55);
    }
    this.vel.lerp(desired, Math.min(1, dt * this.profile.turnRate));
    this.pos.addScaledVector(this.vel, dt);
    // Stay inside the band (fish can be chased a little out of it).
    const top = -(this.band.top + 0.5);
    const bottom = -(this.band.bottom + 3);
    this.pos.y = THREE.MathUtils.clamp(this.pos.y, bottom, top);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, this.leftBound, this.rightBound);

    if (Math.abs(this.vel.x) > 0.15) this.facing = this.vel.x > 0 ? 1 : -1;
    const g = this.mesh.group;
    const bob = Math.sin(time * (1.25 + speed * 0.12) + this.phase) * Math.min(0.11, 0.035 + speed * 0.008);
    g.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    const lead = this.mesh.swimYaw ?? 0;
    const horizontal = Math.hypot(this.vel.x, this.vel.z);
    const targetYaw = (horizontal > 0.05 ? Math.atan2(-this.vel.z, this.vel.x) : this.facing > 0 ? 0 : Math.PI) + lead;
    const yawDelta = THREE.MathUtils.euclideanModulo(targetYaw - g.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    const turn = 1 - Math.exp(-dt * 6);
    g.rotation.order = 'YXZ';
    g.rotation.y += yawDelta * turn;
    const pitch = THREE.MathUtils.clamp(Math.atan2(this.vel.y, Math.max(0.05, horizontal)), -0.5, 0.5) * Math.cos(lead);
    g.rotation.z += (pitch - g.rotation.z) * (1 - Math.exp(-dt * 5));
    const bank = THREE.MathUtils.clamp(-yawDelta * 0.22, -0.24, 0.24);
    g.rotation.x += (bank - g.rotation.x) * (1 - Math.exp(-dt * 4));
    if (animate) this.updateVisual(time, true);
  }

  /** Behaviour always runs; vertex deformation and drawing only run for visible fish. */
  updateVisual(time: number, visible: boolean): void {
    this.mesh.group.visible = visible;
    if (!visible) return;
    if (this.mesh.animate) this.mesh.animate(time + this.phase, this.vel.length());
    else this.mesh.tail.rotation.y = Math.sin(time * 6 + this.phase) * 0.3;
    if (this.spec.rarity === 'mythic') {
      this.mesh.material.emissive.setHSL((time * 0.15 + this.phase) % 1, 1, 0.5);
    }
  }
}

/**
 * Client for the on-chain `player_state` program (contracts/programs/player_state).
 *
 * The program keeps a player's dive-gear levels and paths, synthesis materials
 * and crafted items (PlayerState PDA `["player", owner]`) and the aquarium's
 * feeding growth (Aquarium PDA `["aquarium", owner]`). Every purchase burns
 * PEARL and changes the state in one instruction. Prices live in the Config
 * PDA (`["config"]`): read them with decodeConfig, never hard-code them.
 *
 * This module is dependency-light on purpose: PDA derivation, account decoding
 * into the game's own shapes, and umi instruction builders. It is not wired
 * into gameplay yet. Only type imports come from the game modules.
 */
import { publicKey, publicKeyBytes, transactionBuilder } from '@metaplex-foundation/umi';
import type { Context, Pda, PublicKey, Signer, TransactionBuilder, WrappedInstruction } from '@metaplex-foundation/umi';
import type { EquipmentLevel, EquipmentPathId, EquipmentPaths, EquipmentSlot, EquipmentState, UpgradeSlot } from './equipment';
import type { MaterialId, RecipeDef, SynthesisState } from './synthesis';
import type { FishFoodId } from './fish-food';
import type { AquariumGrowth } from './aquarium-state';
import type { BoatId } from './gear-nft';
import type { MapId } from './maps';

/** The program id generated for player_state (public, not a secret). */
export const DEFAULT_PLAYER_STATE_PROGRAM_ID = 'EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ';

export function playerStateProgramId(): PublicKey {
  const fromEnv = (import.meta.env?.VITE_PLAYER_STATE_PROGRAM_ID as string | undefined)?.trim();
  return publicKey(fromEnv || DEFAULT_PLAYER_STATE_PROGRAM_ID);
}

const ASSOCIATED_TOKEN_PROGRAM_ID = publicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = publicKey('11111111111111111111111111111111');
const BPF_LOADER_UPGRADEABLE_ID = publicKey('BPFLoaderUpgradeab1e11111111111111111111111');

// ---- Index orders shared with the program (lib.rs constants) -------------------

/** Slot order on chain = DIVE_GEAR_SLOTS (equipment.ts). The first six have paths. */
export const SLOT_ORDER: readonly UpgradeSlot[] = Object.freeze(['rod', 'reel', 'net', 'fins', 'tank', 'lamp', 'sonar'] as const);
export const PATH_SLOT_ORDER: readonly EquipmentSlot[] = Object.freeze(['rod', 'reel', 'net', 'fins', 'tank', 'lamp'] as const);
/** Path 0 is the game's default (DEFAULT_EQUIPMENT_PATHS), path 1 the alternative. */
export const PATH_IDS: Readonly<{ [S in EquipmentSlot]: readonly [EquipmentPaths[S], EquipmentPaths[S]] }> = Object.freeze({
  rod: ['far', 'fast'],
  reel: ['fastReel', 'silentReel'],
  net: ['wide', 'fine'],
  fins: ['sprint', 'silent'],
  tank: ['long', 'light'],
  lamp: ['focus', 'wideLamp'],
});
export const MATERIAL_ORDER: readonly MaterialId[] = Object.freeze(['scale', 'fiber', 'scrap', 'crystal'] as const);
export const RECIPE_ORDER: readonly RecipeDef['id'][] = Object.freeze(['bait', 'composite'] as const);
export const FOOD_ORDER: readonly FishFoodId[] = Object.freeze(['plankton', 'pellet', 'krill', 'shrimp', 'glowCoral'] as const);

const SLOT_COUNT = 7;
const PATH_SLOT_COUNT = 6;
const MATERIAL_COUNT = 4;
const RECIPE_COUNT = 2;
const FOOD_COUNT = 5;
/** Most fish one feed / forget_fish call takes (a tank holds 50). */
export const MAX_FISH_PER_CALL = 64;

// ---- Discriminators (game/src/idl/player_state.json) ---------------------------

export const ACCOUNT_DISCRIMINATORS = Object.freeze({
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  PlayerState: [56, 3, 60, 86, 174, 16, 244, 195],
  Aquarium: [83, 39, 33, 207, 228, 184, 2, 132],
  // v2
  Progress: [125, 4, 195, 102, 134, 179, 253, 6],
  ProgressConfig: [127, 198, 232, 142, 103, 192, 144, 50],
} as const);

export const INSTRUCTION_DISCRIMINATORS = Object.freeze({
  initialize_config: [208, 127, 21, 1, 194, 190, 196, 70],
  update_prices: [62, 161, 234, 136, 106, 26, 18, 160],
  set_oracle: [186, 128, 81, 104, 74, 79, 18, 224],
  init_player: [114, 27, 219, 144, 50, 15, 228, 66],
  set_session: [156, 135, 126, 111, 184, 206, 194, 141],
  buy_upgrade: [136, 43, 33, 208, 15, 32, 65, 61],
  set_path: [63, 93, 91, 67, 201, 6, 195, 189],
  craft: [161, 233, 177, 214, 243, 109, 161, 224],
  synth_upgrade: [54, 192, 10, 15, 127, 69, 156, 46],
  shark_bite: [93, 58, 72, 158, 252, 114, 249, 96],
  feed: [46, 213, 237, 176, 190, 113, 182, 94],
  forget_fish: [89, 97, 234, 13, 207, 58, 15, 203],
  // v2
  init_progress_config: [93, 241, 94, 134, 156, 57, 157, 173],
  set_progress_config: [62, 238, 29, 56, 116, 142, 192, 215],
  buy_boat: [92, 118, 219, 59, 116, 176, 51, 179],
  set_ship: [105, 250, 223, 187, 254, 147, 224, 137],
  record_catch: [36, 14, 58, 242, 96, 105, 45, 233],
} as const);

/** Account sizes (discriminator included). Aquarium grows by FISH_ENTRY_SIZE per fish. */
export const CONFIG_SIZE = 612;
export const PLAYER_STATE_SIZE = 249;
export const AQUARIUM_BASE_SIZE = 62;
export const FISH_ENTRY_SIZE = 16;
const ACCOUNT_HEADER_SIZE = 128; // what rent charges per account on top of its data

// ---- PDAs ------------------------------------------------------------------------

type PdaContext = Pick<Context, 'eddsa'>;
const utf8 = (s: string) => new TextEncoder().encode(s);

export function findConfigPda(context: PdaContext, programId = playerStateProgramId()): Pda {
  return context.eddsa.findPda(programId, [utf8('config')]);
}

export function findPlayerStatePda(context: PdaContext, owner: PublicKey, programId = playerStateProgramId()): Pda {
  return context.eddsa.findPda(programId, [utf8('player'), publicKeyBytes(owner)]);
}

export function findAquariumPda(context: PdaContext, owner: PublicKey, programId = playerStateProgramId()): Pda {
  return context.eddsa.findPda(programId, [utf8('aquarium'), publicKeyBytes(owner)]);
}

/** The owner's associated token account for the PEARL mint. */
export function findPearlAta(context: PdaContext, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): Pda {
  return context.eddsa.findPda(ASSOCIATED_TOKEN_PROGRAM_ID, [publicKeyBytes(owner), publicKeyBytes(tokenProgram), publicKeyBytes(mint)]);
}

// ---- Byte helpers ----------------------------------------------------------------

class Reader {
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array, public offset = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8() { return this.view.getUint8(this.offset++); }
  u16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  u64() { const v = this.view.getBigUint64(this.offset, true); this.offset += 8; return v; }
  bytes(n: number) { const v = this.data.slice(this.offset, this.offset + n); this.offset += n; return v; }
  pubkey() { return publicKey(this.bytes(32)); }
  many<T>(n: number, read: () => T): T[] { return Array.from({ length: n }, read); }
}

class Writer {
  private readonly parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >>> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  u64(v: bigint | number) {
    let n = BigInt(v);
    if (n < 0n || n >= 1n << 64n) throw new RangeError(`u64 out of range: ${v}`);
    for (let i = 0; i < 8; i++) { this.u8(Number(n & 0xffn)); n >>= 8n; }
    return this;
  }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.u8(b[i]); return this; }
  pubkey(p: PublicKey) { return this.bytes(publicKeyBytes(p)); }
  done() { return Uint8Array.from(this.parts); }
}

function checkDiscriminator(data: Uint8Array, expected: readonly number[], name: string): void {
  if (data.length < 8 || expected.some((b, i) => data[i] !== b)) throw new Error(`Not a ${name} account`);
}

const DEFAULT_PUBKEY = '11111111111111111111111111111111';

// ---- Config / prices -------------------------------------------------------------

/** Every price and rule number the program reads (lib.rs PriceTable). PEARL amounts are whole PEARL. */
export interface PriceTable {
  /** Per slot (SLOT_ORDER): price of [Lv1 (always 0), Lv2, Lv3]. */
  upgrade: Record<UpgradeSlot, readonly [bigint, bigint, bigint]>;
  /** Per slot: the synthesis station's fee for [Lv1->2, Lv2->3]. */
  synthUpgrade: Record<UpgradeSlot, readonly [bigint, bigint]>;
  recipeCost: Record<RecipeDef['id'], bigint>;
  recipeNeeds: Record<RecipeDef['id'], Record<MaterialId, number>>;
  startingMaterials: Record<MaterialId, number>;
  foodPrice: Record<FishFoodId, bigint>;
  /** Growth units per feed x1000. */
  foodGrowthMilli: Record<FishFoodId, number>;
  /** Cooldown multiplier of the last food x1000. */
  foodCooldownMilli: Record<FishFoodId, number>;
  feedCooldownMs: number;
  /** Growth cap x1000. */
  maxGrowthMilli: number;
}

export interface PlayerStateConfig {
  version: number;
  admin: PublicKey;
  oracle: PublicKey;
  pearlMint: PublicKey;
  tokenProgram: PublicKey;
  prices: PriceTable;
}

const record = <K extends string, V>(keys: readonly K[], values: readonly V[]) =>
  Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Record<K, V>;

function readPrices(r: Reader): PriceTable {
  const upgrade = r.many(SLOT_COUNT, () => r.many(3, () => r.u64()) as unknown as readonly [bigint, bigint, bigint]);
  const synthUpgrade = r.many(SLOT_COUNT, () => r.many(2, () => r.u64()) as unknown as readonly [bigint, bigint]);
  const recipeCost = r.many(RECIPE_COUNT, () => r.u64());
  const recipeNeeds = r.many(RECIPE_COUNT, () => record(MATERIAL_ORDER, r.many(MATERIAL_COUNT, () => r.u32())));
  const startingMaterials = record(MATERIAL_ORDER, r.many(MATERIAL_COUNT, () => r.u32()));
  const foodPrice = r.many(FOOD_COUNT, () => r.u64());
  const foodGrowthMilli = r.many(FOOD_COUNT, () => r.u16());
  const foodCooldownMilli = r.many(FOOD_COUNT, () => r.u16());
  return {
    upgrade: record(SLOT_ORDER, upgrade),
    synthUpgrade: record(SLOT_ORDER, synthUpgrade),
    recipeCost: record(RECIPE_ORDER, recipeCost),
    recipeNeeds: record(RECIPE_ORDER, recipeNeeds),
    startingMaterials,
    foodPrice: record(FOOD_ORDER, foodPrice),
    foodGrowthMilli: record(FOOD_ORDER, foodGrowthMilli),
    foodCooldownMilli: record(FOOD_ORDER, foodCooldownMilli),
    feedCooldownMs: r.u32(),
    maxGrowthMilli: r.u16(),
  };
}

function writePrices(w: Writer, p: PriceTable): Writer {
  for (const s of SLOT_ORDER) p.upgrade[s].forEach((v) => w.u64(v));
  for (const s of SLOT_ORDER) p.synthUpgrade[s].forEach((v) => w.u64(v));
  for (const id of RECIPE_ORDER) w.u64(p.recipeCost[id]);
  for (const id of RECIPE_ORDER) for (const m of MATERIAL_ORDER) w.u32(p.recipeNeeds[id][m]);
  for (const m of MATERIAL_ORDER) w.u32(p.startingMaterials[m]);
  for (const f of FOOD_ORDER) w.u64(p.foodPrice[f]);
  for (const f of FOOD_ORDER) w.u16(p.foodGrowthMilli[f]);
  for (const f of FOOD_ORDER) w.u16(p.foodCooldownMilli[f]);
  return w.u32(p.feedCooldownMs).u16(p.maxGrowthMilli);
}

export function encodePriceTable(prices: PriceTable): Uint8Array {
  return writePrices(new Writer(), prices).done();
}

export function decodeConfig(data: Uint8Array): PlayerStateConfig {
  checkDiscriminator(data, ACCOUNT_DISCRIMINATORS.Config, 'Config');
  const r = new Reader(data, 8);
  const version = r.u8();
  r.u8(); // bump
  return { version, admin: r.pubkey(), oracle: r.pubkey(), pearlMint: r.pubkey(), tokenProgram: r.pubkey(), prices: readPrices(r) };
}

/**
 * The game's current tables (equipment.ts EQUIPMENT_TIERS, synthesis.ts, fish-food.ts,
 * aquarium-state.ts), as initialize_config takes them. tests/player-state.test.mjs checks parity.
 */
export const GAME_PRICE_TABLE: PriceTable = {
  upgrade: {
    rod: [0n, 100n, 500n], reel: [0n, 120n, 600n], net: [0n, 300n, 1200n], fins: [0n, 150n, 750n],
    tank: [0n, 180n, 900n], lamp: [0n, 100n, 500n], sonar: [0n, 300n, 1200n],
  },
  synthUpgrade: {
    rod: [68n, 329n], reel: [78n, 389n], net: [89n, 499n], fins: [99n, 549n],
    tank: [119n, 699n], lamp: [58n, 299n], sonar: [149n, 899n],
  },
  recipeCost: { bait: 38n, composite: 128n },
  recipeNeeds: {
    bait: { scale: 2, fiber: 1, scrap: 0, crystal: 0 },
    composite: { scale: 0, fiber: 2, scrap: 3, crystal: 1 },
  },
  startingMaterials: { scale: 8, fiber: 8, scrap: 10, crystal: 3 },
  foodPrice: { plankton: 8n, pellet: 24n, krill: 72n, shrimp: 216n, glowCoral: 648n },
  foodGrowthMilli: { plankton: 400, pellet: 700, krill: 1050, shrimp: 1400, glowCoral: 1900 },
  foodCooldownMilli: { plankton: 1150, pellet: 1000, krill: 900, shrimp: 780, glowCoral: 650 },
  feedCooldownMs: 15_000,
  maxGrowthMilli: 5000,
};

// ---- PlayerState -----------------------------------------------------------------

export interface PlayerStateAccount {
  version: number;
  flags: number;
  owner: PublicKey;
  /** The session key allowed to sign non-paying events, or null. */
  session: PublicKey | null;
  levels: Record<UpgradeSlot, EquipmentLevel>;
  paths: EquipmentPaths;
  materials: Record<MaterialId, number>;
  crafted: SynthesisState['crafted'];
  bestValue: bigint;
}

const level = (v: number): EquipmentLevel => (v >= 1 && v <= 3 ? v : 1) as EquipmentLevel;

export function decodePlayerState(data: Uint8Array): PlayerStateAccount {
  checkDiscriminator(data, ACCOUNT_DISCRIMINATORS.PlayerState, 'PlayerState');
  if (data.length < PLAYER_STATE_SIZE) throw new Error('PlayerState account is too short');
  const r = new Reader(data, 8);
  const version = r.u8();
  r.u8(); // bump
  const flags = r.u16();
  const owner = r.pubkey();
  const session = r.pubkey();
  const levels = record(SLOT_ORDER, r.many(SLOT_COUNT, () => level(r.u8())));
  const pathBytes = r.many(PATH_SLOT_COUNT, () => r.u8());
  const paths = Object.fromEntries(
    PATH_SLOT_ORDER.map((slot, i) => [slot, PATH_IDS[slot][pathBytes[i] === 1 ? 1 : 0]]),
  ) as unknown as EquipmentPaths;
  const materials = record(MATERIAL_ORDER, r.many(MATERIAL_COUNT, () => r.u32()));
  const [bait, composite] = r.many(RECIPE_COUNT, () => r.u32());
  return {
    version, flags, owner,
    session: session === DEFAULT_PUBKEY ? null : session,
    levels, paths, materials,
    crafted: { bait, composite },
    bestValue: r.u64(),
  };
}

/** The equipment fields of the game's EquipmentState (PEARL is the token balance, not here). */
export type ChainEquipment = Pick<EquipmentState,
  'rodLevel' | 'netLevel' | 'rodGearLevel' | 'reelLevel' | 'finsLevel' | 'tankLevel' | 'lampLevel' | 'sonarLevel' | 'paths'>;

export function toEquipmentState(p: PlayerStateAccount): ChainEquipment {
  return {
    // rodLevel is the legacy alias of netLevel (equipment.ts withSlotLevel).
    rodLevel: p.levels.net,
    netLevel: p.levels.net,
    rodGearLevel: p.levels.rod,
    reelLevel: p.levels.reel,
    finsLevel: p.levels.fins,
    tankLevel: p.levels.tank,
    lampLevel: p.levels.lamp,
    sonarLevel: p.levels.sonar,
    paths: { ...p.paths },
  };
}

export function toSynthesisState(p: PlayerStateAccount): SynthesisState {
  return { materials: { ...p.materials }, crafted: { ...p.crafted } };
}

// ---- Aquarium --------------------------------------------------------------------

export interface FishGrowthEntry {
  key: Uint8Array;
  keyHex: string;
  /** Growth units x1000 (the game's growthUnits * 1000). */
  growthMilli: number;
  feedCount: number;
  food: FishFoodId;
  /** Unix seconds of the last accepted feed. */
  lastFed: number;
}

export interface AquariumAccount {
  version: number;
  owner: PublicKey;
  /** Sorted by key. */
  entries: FishGrowthEntry[];
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function decodeAquarium(data: Uint8Array): AquariumAccount {
  checkDiscriminator(data, ACCOUNT_DISCRIMINATORS.Aquarium, 'Aquarium');
  const r = new Reader(data, 8);
  const version = r.u8();
  r.u8(); // bump
  const owner = r.pubkey();
  r.bytes(16); // reserved
  const count = r.u32();
  if (data.length < AQUARIUM_BASE_SIZE + count * FISH_ENTRY_SIZE) throw new Error('Aquarium account is too short');
  const entries = r.many(count, () => {
    const key = r.bytes(8);
    const growthMilli = r.u16();
    const feedCount = r.u8();
    const food = FOOD_ORDER[r.u8()] ?? 'plankton';
    return { key, keyHex: toHex(key), growthMilli, feedCount, food, lastFed: r.u32() };
  });
  return { version, owner, entries };
}

/** One entry as the aquarium's own growth record (aquarium-state.ts AquariumGrowth). */
export function toAquariumGrowth(e: FishGrowthEntry): AquariumGrowth {
  return { feedCount: e.feedCount, lastFedAt: e.lastFed ? e.lastFed * 1000 : null, growthUnits: e.growthMilli / 1000, food: e.food };
}

/** The 8-byte key of a fish from its game id (fish.ts: the 32-bit seed as 8 hex digits), big-endian, zero-padded. */
export function fishKey(id: string): Uint8Array {
  if (!/^[0-9a-f]{1,16}$/i.test(id)) throw new Error(`fishKey: not a hex fish id: ${id}`);
  let n = BigInt(`0x${id}`);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/** The 8-byte key of a minted fish from its Core asset id (the first 8 bytes). */
export function fishKeyFromAsset(asset: PublicKey): Uint8Array {
  return publicKeyBytes(asset).slice(0, 8);
}

/** Rent the owner pays per growth entry, in lamports (16 bytes at 6960 lamports/byte). */
export const RENT_PER_FISH_LAMPORTS = FISH_ENTRY_SIZE * 6960;

// ---- Instruction builders --------------------------------------------------------

type Meta = [PublicKey, boolean]; // [pubkey, writable]

function ix(
  programId: PublicKey,
  name: keyof typeof INSTRUCTION_DISCRIMINATORS,
  keys: Meta[],
  args: Writer,
  signers: Signer[],
  bytesCreatedOnChain = 0,
): TransactionBuilder {
  const signerKeys = new Set(signers.map((s) => s.publicKey.toString()));
  const data = new Uint8Array([...INSTRUCTION_DISCRIMINATORS[name], ...args.done()]);
  const wrapped: WrappedInstruction = {
    instruction: {
      programId,
      keys: keys.map(([pubkey, isWritable]) => ({ pubkey, isWritable, isSigner: signerKeys.has(pubkey.toString()) })),
      data,
    },
    signers,
    bytesCreatedOnChain,
  };
  return transactionBuilder([wrapped]);
}

export interface PearlAccounts {
  /** From decodeConfig: the mint and its token program. */
  pearlMint: PublicKey;
  tokenProgram: PublicKey;
  /** Defaults to the owner's associated token account. */
  ownerPearl?: PublicKey;
}

interface Common { programId?: PublicKey }

function spendKeys(context: PdaContext, owner: PublicKey, pearl: PearlAccounts, programId: PublicKey, state: PublicKey): Meta[] {
  const ata = pearl.ownerPearl ?? findPearlAta(context, owner, pearl.pearlMint, pearl.tokenProgram)[0];
  return [
    [owner, false],
    [findConfigPda(context, programId)[0], false],
    [state, true],
    [pearl.pearlMint, true],
    [ata, true],
    [pearl.tokenProgram, false],
  ];
}

const slotIndex = (slot: UpgradeSlot) => {
  const i = SLOT_ORDER.indexOf(slot);
  if (i < 0) throw new Error(`Unknown slot ${slot}`);
  return i;
};

function fishArgs(fish: readonly Uint8Array[]): Writer {
  if (!fish.length || fish.length > MAX_FISH_PER_CALL) throw new Error(`Pass 1 to ${MAX_FISH_PER_CALL} fish keys`);
  const w = new Writer().u32(fish.length);
  for (const key of fish) {
    if (key.length !== 8) throw new Error('A fish key is 8 bytes');
    w.bytes(key);
  }
  return w;
}

/** Admin (the program's upgrade authority): creates the Config. */
export function initializeConfig(
  context: PdaContext,
  input: Common & { admin: Signer; oracle: PublicKey; pearlMint: PublicKey; tokenProgram: PublicKey; prices?: PriceTable },
): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const programData = context.eddsa.findPda(BPF_LOADER_UPGRADEABLE_ID, [publicKeyBytes(programId)])[0];
  return ix(programId, 'initialize_config', [
    [input.admin.publicKey, true],
    [findConfigPda(context, programId)[0], true],
    [input.pearlMint, false],
    [input.tokenProgram, false],
    [programId, false],
    [programData, false],
    [SYSTEM_PROGRAM_ID, false],
  ], writePrices(new Writer().pubkey(input.oracle), input.prices ?? GAME_PRICE_TABLE), [input.admin], CONFIG_SIZE + ACCOUNT_HEADER_SIZE);
}

/** Admin: replaces every price table. */
export function updatePrices(context: PdaContext, input: Common & { admin: Signer; prices: PriceTable }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  return ix(programId, 'update_prices', [[input.admin.publicKey, false], [findConfigPda(context, programId)[0], true]],
    writePrices(new Writer(), input.prices), [input.admin]);
}

/** Admin: replaces the oracle. */
export function setOracle(context: PdaContext, input: Common & { admin: Signer; oracle: PublicKey }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  return ix(programId, 'set_oracle', [[input.admin.publicKey, false], [findConfigPda(context, programId)[0], true]],
    new Writer().pubkey(input.oracle), [input.admin]);
}

/** Owner signs and pays rent for the PlayerState and the (empty) Aquarium. */
export function initPlayer(context: PdaContext, input: Common & { owner: Signer; session?: PublicKey | null }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  return ix(programId, 'init_player', [
    [owner, true],
    [findConfigPda(context, programId)[0], false],
    [findPlayerStatePda(context, owner, programId)[0], true],
    [findAquariumPda(context, owner, programId)[0], true],
    [SYSTEM_PROGRAM_ID, false],
  ], new Writer().pubkey(input.session ?? publicKey(DEFAULT_PUBKEY)), [input.owner],
  PLAYER_STATE_SIZE + AQUARIUM_BASE_SIZE + 2 * ACCOUNT_HEADER_SIZE);
}

/** Owner only: sets the session key, or clears it with null. */
export function setSession(context: PdaContext, input: Common & { owner: Signer; session: PublicKey | null }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  return ix(programId, 'set_session', [[owner, false], [findPlayerStatePda(context, owner, programId)[0], true]],
    new Writer().pubkey(input.session ?? publicKey(DEFAULT_PUBKEY)), [input.owner]);
}

/** Owner signs: burns the Config price of the next level and raises it. */
export function buyUpgrade(context: PdaContext, input: Common & PearlAccounts & { owner: Signer; slot: UpgradeSlot }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  return ix(programId, 'buy_upgrade', spendKeys(context, owner, input, programId, findPlayerStatePda(context, owner, programId)[0]),
    new Writer().u8(slotIndex(input.slot)), [input.owner]);
}

/** Owner or session key signs: free path switch on a Lv2+ slot. */
export function setPath<S extends EquipmentSlot>(
  context: PdaContext,
  input: Common & { authority: Signer; owner: PublicKey; slot: S; path: EquipmentPaths[S] & EquipmentPathId },
): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const path = (PATH_IDS[input.slot] as readonly string[]).indexOf(input.path);
  if (path < 0) throw new Error(`Path ${input.path} does not belong to ${input.slot}`);
  return ix(programId, 'set_path', [[input.authority.publicKey, false], [findPlayerStatePda(context, input.owner, programId)[0], true]],
    new Writer().u8(slotIndex(input.slot)).u8(path), [input.authority]);
}

/** Owner signs: burns the recipe cost, consumes its materials. */
export function craft(context: PdaContext, input: Common & PearlAccounts & { owner: Signer; recipe: RecipeDef['id'] }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  return ix(programId, 'craft', spendKeys(context, owner, input, programId, findPlayerStatePda(context, owner, programId)[0]),
    new Writer().u8(RECIPE_ORDER.indexOf(input.recipe)), [input.owner]);
}

/** Owner signs: one composite plate plus the station fee raises the slot a level. */
export function synthUpgrade(context: PdaContext, input: Common & PearlAccounts & { owner: Signer; slot: UpgradeSlot }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  return ix(programId, 'synth_upgrade', spendKeys(context, owner, input, programId, findPlayerStatePda(context, owner, programId)[0]),
    new Writer().u8(slotIndex(input.slot)), [input.owner]);
}

/** Owner or session key signs: every dive slot back to Lv1, default paths. */
export function sharkBite(context: PdaContext, input: Common & { authority: Signer; owner: PublicKey }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  return ix(programId, 'shark_bite', [[input.authority.publicKey, false], [findPlayerStatePda(context, input.owner, programId)[0], true]],
    new Writer(), [input.authority]);
}

/** Owner signs: one pour over up to 64 fish; burns the food price once, fails (no burn) if none can eat. */
export function feed(
  context: PdaContext,
  input: Common & PearlAccounts & { owner: Signer; food: FishFoodId; fish: readonly Uint8Array[] },
): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  const food = FOOD_ORDER.indexOf(input.food);
  if (food < 0) throw new Error(`Unknown food ${input.food}`);
  const ata = input.ownerPearl ?? findPearlAta(context, owner, input.pearlMint, input.tokenProgram)[0];
  return ix(programId, 'feed', [
    [owner, true],
    [findConfigPda(context, programId)[0], false],
    [findAquariumPda(context, owner, programId)[0], true],
    [input.pearlMint, true],
    [ata, true],
    [input.tokenProgram, false],
    [SYSTEM_PROGRAM_ID, false],
  ], (() => { const w = new Writer().u8(food); w.bytes(fishArgs(input.fish).done()); return w; })(), [input.owner],
  input.fish.length * FISH_ENTRY_SIZE);
}

/** Owner signs: drops growth entries for fish that are gone and refunds their rent. */
export function forgetFish(context: PdaContext, input: Common & { owner: Signer; fish: readonly Uint8Array[] }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  return ix(programId, 'forget_fish', [[owner, true], [findAquariumPda(context, owner, programId)[0], true]],
    fishArgs(input.fish), [input.owner]);
}

// ==== v2: Progress (boats, ships, lifetime banked value) =========================
//
// Additive to v1: nothing above changes. One Progress PDA per wallet (["progress", owner])
// and one admin-set ProgressConfig (["progress_config"]) with the boat prices and the ship /
// map unlock thresholds.
//
// Wiring record_catch into the fish mint (server, sensor/fish-collection.mjs cosignMint):
// append recordCatch(...) to the same Core `create` transaction builder, with
//   oracle = u.identity (the market wallet, already a signer there as collection authority),
//   payer  = the request's `payer` (the game's session key, already the fee payer),
//   owner  = m.owner, fish = fishSeedKey(m.fishId), value = the validated fish value,
// before .setFeePayer/.build. No new signer: the session key signs as before and also funds
// the Progress rent (first catch) plus 8 bytes per new fish. A retried mint of the same fish
// is a no-op on chain. The game's cosignedTxProblem (fish-cosign.ts) must then accept this
// program id next to Metaplex Core, and nft-queue.ts MIN_MINT_SOL should cover the extra rent.

/** Boat pieces in program order = BOAT_IDS (gear-nft.ts). */
export const BOAT_ORDER: readonly BoatId[] = Object.freeze(['bait', 'boat', 'boatSpeed', 'boatHull', 'boatDeck'] as const);
/** Maps in program order (maps.ts MAPS). */
export const MAP_ORDER: readonly MapId[] = Object.freeze(['fjord', 'tianchi', 'ocean'] as const);
const BOAT_SLOT_COUNT = 5;
const SHIP_COUNT = 6;
const MAP_COUNT = 3;

/** Progress header size (discriminator included); the catch log of u64 keys follows it. */
export const PROGRESS_HEADER_SIZE = 100;
export const CATCH_KEY_SIZE = 8;
export const PROGRESS_CONFIG_SIZE = 266;

export function findProgressPda(context: PdaContext, owner: PublicKey, programId = playerStateProgramId()): Pda {
  return context.eddsa.findPda(programId, [utf8('progress'), publicKeyBytes(owner)]);
}

export function findProgressConfigPda(context: PdaContext, programId = playerStateProgramId()): Pda {
  return context.eddsa.findPda(programId, [utf8('progress_config')]);
}

export interface ProgressRules {
  /** PEARL per boat level (index 0 = Lv1 = 0). */
  boatPrices: Record<BoatId, [bigint, bigint, bigint]>;
  /** Lifetime banked value that unlocks each ship (ships.ts SHIPS order). */
  shipThresholds: bigint[];
  /** Lifetime banked value that unlocks each map. */
  mapThresholds: Record<MapId, bigint>;
}

/** upgrades.ts boat-group prices, ships.ts thresholds, and the map unlocks 150 / 1000. */
export const GAME_PROGRESS_RULES: ProgressRules = {
  boatPrices: {
    bait: [0n, 40n, 300n],
    boat: [0n, 120n, 700n],
    boatSpeed: [0n, 80n, 500n],
    boatHull: [0n, 80n, 500n],
    boatDeck: [0n, 80n, 500n],
  },
  shipThresholds: [0n, 50n, 150n, 500n, 1200n, 2500n],
  mapThresholds: { fjord: 0n, tianchi: 150n, ocean: 1000n },
};

function writeRules(w: Writer, r: ProgressRules): Writer {
  for (const id of BOAT_ORDER) for (const p of r.boatPrices[id]) w.u64(p);
  if (r.shipThresholds.length !== SHIP_COUNT) throw new Error(`Need ${SHIP_COUNT} ship thresholds`);
  for (const t of r.shipThresholds) w.u64(t);
  for (const id of MAP_ORDER) w.u64(r.mapThresholds[id]);
  return w;
}

function readRules(r: Reader): ProgressRules {
  const boat = r.many(BOAT_SLOT_COUNT, () => r.many(3, () => r.u64()) as [bigint, bigint, bigint]);
  const ships = r.many(SHIP_COUNT, () => r.u64());
  const maps = r.many(MAP_COUNT, () => r.u64());
  return { boatPrices: record(BOAT_ORDER, boat), shipThresholds: ships, mapThresholds: record(MAP_ORDER, maps) };
}

/** Encodes ProgressRules exactly as the instructions take them (for tests and scripts). */
export function encodeProgressRules(rules: ProgressRules): Uint8Array {
  return writeRules(new Writer(), rules).done();
}

export interface ProgressConfigAccount { version: number; bump: number; rules: ProgressRules }

export function decodeProgressConfig(data: Uint8Array): ProgressConfigAccount {
  checkDiscriminator(data, ACCOUNT_DISCRIMINATORS.ProgressConfig, 'ProgressConfig');
  const r = new Reader(data, 8);
  return { version: r.u8(), bump: r.u8(), rules: readRules(r) };
}

export interface ProgressAccount {
  version: number;
  bump: number;
  owner: PublicKey;
  /** Value of every fish ever banked; never decreases. */
  lifetimeValue: bigint;
  /** The most valuable single fish recorded. */
  bestValue: bigint;
  catches: number;
  boatLevels: Record<BoatId, EquipmentLevel>;
  /** SHIPS index sailed. */
  ship: number;
}

export function decodeProgress(data: Uint8Array): ProgressAccount {
  checkDiscriminator(data, ACCOUNT_DISCRIMINATORS.Progress, 'Progress');
  const r = new Reader(data, 8);
  const version = r.u8(), bump = r.u8(), owner = r.pubkey();
  const lifetimeValue = r.u64(), bestValue = r.u64(), catches = r.u32();
  const boatLevels = record(BOAT_ORDER, r.many(BOAT_SLOT_COUNT, () => level(r.u8())));
  return { version, bump, owner, lifetimeValue, bestValue, catches, boatLevels, ship: r.u8() };
}

/** The recorded fish keys (sorted ascending) after the Progress header. */
export function decodeCatchLog(data: Uint8Array): bigint[] {
  const p = decodeProgress(data);
  const r = new Reader(data, PROGRESS_HEADER_SIZE);
  return r.many(Math.min(p.catches, Math.floor((data.length - PROGRESS_HEADER_SIZE) / CATCH_KEY_SIZE)), () => r.u64());
}

/** A fish's catch-log key: its 8-hex seed id (sensor/fish-gen.mjs seedOfId) as a u64. */
export function fishSeedKey(id: string): bigint {
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`Bad fish id ${id}`);
  return BigInt(`0x${id}`);
}

/** Maps open at this lifetime banked value. */
export function unlockedMaps(lifetimeValue: bigint, rules: ProgressRules): MapId[] {
  return MAP_ORDER.filter((id) => lifetimeValue >= rules.mapThresholds[id]);
}

/** SHIPS indexes that may be sailed at this lifetime banked value. */
export function unlockedShips(lifetimeValue: bigint, rules: ProgressRules): number[] {
  return rules.shipThresholds.flatMap((t, i) => (lifetimeValue >= t ? [i] : []));
}

const boatIndex = (id: BoatId) => {
  const i = BOAT_ORDER.indexOf(id);
  if (i < 0) throw new Error(`Unknown boat piece ${id}`);
  return i;
};

/** Config admin: creates the ProgressConfig. */
export function initProgressConfig(context: PdaContext, input: Common & { admin: Signer; rules?: ProgressRules }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  return ix(programId, 'init_progress_config', [
    [input.admin.publicKey, true],
    [findConfigPda(context, programId)[0], false],
    [findProgressConfigPda(context, programId)[0], true],
    [SYSTEM_PROGRAM_ID, false],
  ], writeRules(new Writer(), input.rules ?? GAME_PROGRESS_RULES), [input.admin], PROGRESS_CONFIG_SIZE + ACCOUNT_HEADER_SIZE);
}

/** Config admin: replaces the boat prices and unlock thresholds. */
export function setProgressConfig(context: PdaContext, input: Common & { admin: Signer; rules: ProgressRules }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  return ix(programId, 'set_progress_config', [
    [input.admin.publicKey, false],
    [findConfigPda(context, programId)[0], false],
    [findProgressConfigPda(context, programId)[0], true],
  ], writeRules(new Writer(), input.rules), [input.admin]);
}

/**
 * Owner signs: burns the ProgressConfig price of `level` (must be the current level + 1) of a
 * boat piece. Creates the owner's Progress on first use (pass `createsProgress` so the fee
 * estimate includes its rent).
 */
export function buyBoat(
  context: PdaContext,
  input: Common & PearlAccounts & { owner: Signer; boat: BoatId; level: 2 | 3; createsProgress?: boolean },
): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  const ata = input.ownerPearl ?? findPearlAta(context, owner, input.pearlMint, input.tokenProgram)[0];
  return ix(programId, 'buy_boat', [
    [owner, true],
    [findConfigPda(context, programId)[0], false],
    [findProgressConfigPda(context, programId)[0], false],
    [findProgressPda(context, owner, programId)[0], true],
    [input.pearlMint, true],
    [ata, true],
    [input.tokenProgram, false],
    [SYSTEM_PROGRAM_ID, false],
  ], new Writer().u8(boatIndex(input.boat)).u8(input.level), [input.owner],
  input.createsProgress ? PROGRESS_HEADER_SIZE + ACCOUNT_HEADER_SIZE : 0);
}

/** Owner signs: sails an unlocked ship (SHIPS index). */
export function setShip(context: PdaContext, input: Common & { owner: Signer; ship: number }): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  const owner = input.owner.publicKey;
  return ix(programId, 'set_ship', [
    [owner, false],
    [findProgressConfigPda(context, programId)[0], false],
    [findProgressPda(context, owner, programId)[0], true],
  ], new Writer().u8(input.ship), [input.owner]);
}

/**
 * Oracle (Config.oracle, the market wallet) signs: adds one banked fish's value to the owner's
 * lifetime value, once per fish key. `payer` (any signer, e.g. the mint tx's fee payer) funds
 * the Progress rent and the 8 bytes per new fish. See the wiring note at the top of this section.
 */
export function recordCatch(
  context: PdaContext,
  input: Common & { oracle: Signer; payer: Signer; owner: PublicKey; fish: bigint; value: bigint | number; createsProgress?: boolean },
): TransactionBuilder {
  const programId = input.programId ?? playerStateProgramId();
  return ix(programId, 'record_catch', [
    [input.oracle.publicKey, false],
    [input.payer.publicKey, true],
    [findConfigPda(context, programId)[0], false],
    [input.owner, false],
    [findProgressPda(context, input.owner, programId)[0], true],
    [SYSTEM_PROGRAM_ID, false],
  ], new Writer().u64(input.fish).u64(input.value), [input.oracle, input.payer],
  CATCH_KEY_SIZE + (input.createsProgress ? PROGRESS_HEADER_SIZE + ACCOUNT_HEADER_SIZE : 0));
}

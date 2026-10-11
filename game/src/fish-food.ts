/**
 * Fish food is kept as data so the aquarium and the future boat-fishing UI can
 * share one progression curve.  A feed is deliberately a small, reversible
 * buff: the fish's species and rarity still do the heavy lifting, while the
 * food only nudges growth, feeding cadence, swim energy, and glow.
 */

export type FishFoodId = 'plankton' | 'pellet' | 'krill' | 'shrimp' | 'glowCoral';

export interface FishFoodDef {
  readonly id: FishFoodId;
  readonly tier: number;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  /** Growth contribution relative to the aquarium's base feed amount. */
  readonly growthMultiplier: number;
  /** Cooldown between feeds; below 1 means the fish can eat again sooner. */
  readonly feedCooldownMultiplier: number;
  /** Temporary swim-speed multiplier while the food buff is active. */
  readonly swimSpeedMultiplier: number;
  /** Additive 0..1 glow strength for the food's visual/buff indicator. */
  readonly glowIntensity: number;
  /** Pearls per unit. Prices are intentionally exponential by tier. */
  readonly price: number;
  /** Name used by the Three.js model builder. */
  readonly modelKey: string;
}

export const FISH_FOOD_PRICE_BASE = 8;
export const FISH_FOOD_PRICE_RATIO = 3;

/**
 * Five deliberately different foods.  Plankton and the basic pellet are
 * entry-level supplies: their growth is intentionally weaker than a neutral
 * one-feed amount, so buying up the ladder is meaningful instead of cosmetic.
 */
export const FISH_FOODS: readonly FishFoodDef[] = Object.freeze([
  Object.freeze({
    id: 'plankton' as const,
    tier: 0,
    name: 'Plankton dust',
    nameZh: '浮游生物粉',
    description: 'Cheap maintenance feed; a small growth pulse with no glow.',
    descriptionZh: '便宜的维持饲料，成长脉冲较弱，不发光。',
    growthMultiplier: 0.4,
    feedCooldownMultiplier: 1.15,
    swimSpeedMultiplier: 0.98,
    glowIntensity: 0,
    price: 8,
    modelKey: 'plankton',
  }),
  Object.freeze({
    id: 'pellet' as const,
    tier: 1,
    name: 'Balanced pellets',
    nameZh: '均衡颗粒',
    description: 'A steady everyday ration for predictable growth.',
    descriptionZh: '稳定的日常口粮，成长均衡可控。',
    growthMultiplier: 0.7,
    feedCooldownMultiplier: 1,
    swimSpeedMultiplier: 1,
    glowIntensity: 0.03,
    price: 24,
    modelKey: 'pellet',
  }),
  Object.freeze({
    id: 'krill' as const,
    tier: 2,
    name: 'Krill clusters',
    nameZh: '磷虾团',
    description: 'Protein-rich clusters that grow fish faster and keep them lively.',
    descriptionZh: '富含蛋白质，提升成长速度和活力。',
    growthMultiplier: 1.05,
    feedCooldownMultiplier: 0.9,
    swimSpeedMultiplier: 1.05,
    glowIntensity: 0.1,
    price: 72,
    modelKey: 'krill',
  }),
  Object.freeze({
    id: 'shrimp' as const,
    tier: 3,
    name: 'Reef shrimp',
    nameZh: '礁虾',
    description: 'Fresh shrimp gives a strong growth burst and a short speed boost.',
    descriptionZh: '新鲜礁虾带来明显成长，并短暂提升游速。',
    growthMultiplier: 1.4,
    feedCooldownMultiplier: 0.78,
    swimSpeedMultiplier: 1.12,
    glowIntensity: 0.2,
    price: 216,
    modelKey: 'shrimp',
  }),
  Object.freeze({
    id: 'glowCoral' as const,
    tier: 4,
    name: 'Glow coral bites',
    nameZh: '荧光珊瑚粒',
    description: 'Rare coral bites produce the largest growth pulse and a visible glow.',
    descriptionZh: '稀有珊瑚颗粒提供最大成长脉冲，并产生明显荧光。',
    growthMultiplier: 1.9,
    feedCooldownMultiplier: 0.65,
    swimSpeedMultiplier: 1.2,
    glowIntensity: 0.55,
    price: 648,
    modelKey: 'glowCoral',
  }),
]);

export const FISH_FOOD_KINDS: readonly FishFoodId[] = Object.freeze(FISH_FOODS.map((food) => food.id));
export const FOOD_CATALOG = FISH_FOODS;

const BY_ID = new Map(FISH_FOODS.map((food) => [food.id, food]));

/** Return a food definition without exposing a mutable object. */
export function fishFood(id: FishFoodId): FishFoodDef {
  return BY_ID.get(id) ?? FISH_FOODS[0];
}

/** Resolve a user or save-file value safely, returning null for unknown IDs. */
/** Alias used by UI/catalog callers. */
export const foodById = fishFood;

export function parseFishFood(id: unknown): FishFoodDef | null {
  return typeof id === 'string' && BY_ID.has(id as FishFoodId) ? BY_ID.get(id as FishFoodId)! : null;
}

/** Exponential price curve shared by UI and purchase code. */
export function fishFoodPrice(tier: number): number {
  const safeTier = Number.isFinite(tier) ? Math.max(0, Math.floor(tier)) : 0;
  return FISH_FOOD_PRICE_BASE * FISH_FOOD_PRICE_RATIO ** safeTier;
}

/** Growth from one or more feeds, relative to the caller's base growth unit. */
export function fishFoodGrowth(food: FishFoodDef | FishFoodId, baseGrowth = 1, feeds = 1): number {
  const def = typeof food === 'string' ? fishFood(food) : food;
  const base = Number.isFinite(baseGrowth) ? Math.max(0, baseGrowth) : 0;
  const count = Number.isFinite(feeds) ? Math.max(0, feeds) : 0;
  return base * def.growthMultiplier * count;
}

/**
 * Apply the non-growth effects in one place.  Keeping this pure makes it safe
 * for a preview tooltip and for the aquarium's eventual persisted feed log.
 */
export function fishFoodEffects(food: FishFoodDef | FishFoodId, feeds = 1) {
  const def = typeof food === 'string' ? fishFood(food) : food;
  const count = Number.isFinite(feeds) ? Math.max(0, feeds) : 0;
  return {
    growth: fishFoodGrowth(def, 1, count),
    cooldownMultiplier: def.feedCooldownMultiplier ** count,
    swimSpeedMultiplier: 1 + (def.swimSpeedMultiplier - 1) * Math.min(1, count),
    glowIntensity: Math.min(1, def.glowIntensity * Math.max(0, count)),
  };
}

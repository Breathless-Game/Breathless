import type { Rarity } from './fish';
import type { BankedFish } from './market';

/** Materials produced by the notebook's fish-to-bait recipes. */
export type CraftingMaterial = 'bait1' | 'bait2' | 'bait3';

export type CraftingInventory = Record<CraftingMaterial, number>;

export interface CraftRecipe {
  id: string;
  output: CraftingMaterial;
  outputQty: number;
  /** One minted fish is burned by each recipe. */
  fishRarities: readonly Rarity[];
  requires: Partial<Record<CraftingMaterial, number>>;
  nameZh: string;
  nameEn: string;
  resultZh: string;
  resultEn: string;
  materialZh: string;
  materialEn: string;
}

export const CRAFTING_MATERIALS: readonly CraftingMaterial[] = ['bait1', 'bait2', 'bait3'];

/**
 * The first playable recipe set. The design document only defines fish as the NFT sink and
 * Pearl costs for bait levels; these ratios make that rule usable without changing equipment
 * upgrades. Each recipe burns exactly one eligible fish, then stores the resulting bait locally.
 */
export const CRAFT_RECIPES: readonly CraftRecipe[] = [
  {
    id: 'bait-basic',
    output: 'bait1',
    outputQty: 1,
    fishRarities: ['common', 'uncommon'],
    requires: {},
    nameZh: '基础鱼饵',
    nameEn: 'Basic bait',
    resultZh: '基础鱼饵 Lv1 ×1',
    resultEn: 'Basic bait Lv1 ×1',
    materialZh: '普通或非凡鱼 NFT ×1',
    materialEn: 'Common or uncommon fish NFT ×1',
  },
  {
    id: 'bait-deep',
    output: 'bait2',
    outputQty: 1,
    fishRarities: ['rare', 'epic', 'legendary', 'mythic'],
    requires: { bait1: 1 },
    nameZh: '深潜鱼饵',
    nameEn: 'Deep bait',
    resultZh: '深潜鱼饵 Lv2 ×1',
    resultEn: 'Deep bait Lv2 ×1',
    materialZh: '稀有及以上鱼 NFT ×1 + 基础鱼饵 ×1',
    materialEn: 'Rare+ fish NFT ×1 + Basic bait ×1',
  },
  {
    id: 'bait-abyss',
    output: 'bait3',
    outputQty: 1,
    fishRarities: ['epic', 'legendary', 'mythic'],
    requires: { bait2: 1 },
    nameZh: '深渊鱼饵',
    nameEn: 'Abyss bait',
    resultZh: '深渊鱼饵 Lv3 ×1',
    resultEn: 'Abyss bait Lv3 ×1',
    materialZh: '史诗及以上鱼 NFT ×1 + 深潜鱼饵 ×1',
    materialEn: 'Epic+ fish NFT ×1 + Deep bait ×1',
  },
];

export function emptyCraftingInventory(): CraftingInventory {
  return { bait1: 0, bait2: 0, bait3: 0 };
}

/** Keep old or malformed localStorage entries from becoming free materials. */
export function sanitizeCraftingInventory(value: unknown): CraftingInventory {
  const result = emptyCraftingInventory();
  if (!value || typeof value !== 'object') return result;
  const source = value as Record<string, unknown>;
  for (const material of CRAFTING_MATERIALS) {
    const amount = source[material];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
      result[material] = Math.floor(amount);
    }
  }
  return result;
}

/** A fish is eligible only after the NFT exists and before another destructive action owns it. */
export function eligibleFish(bank: readonly BankedFish[], recipe: CraftRecipe): BankedFish[] {
  return bank.filter((fish) =>
    fish.nft === 'minted' &&
    Boolean(fish.assetId) &&
    !fish.legacy &&
    !fish.sellQueued &&
    recipe.fishRarities.includes(fish.rarity),
  );
}

export function canCraft(recipe: CraftRecipe, inventory: CraftingInventory, bank: readonly BankedFish[]): boolean {
  if (!eligibleFish(bank, recipe).length) return false;
  return Object.entries(recipe.requires).every(([material, amount]) => inventory[material as CraftingMaterial] >= (amount ?? 0));
}

export interface CraftPlan {
  recipe: CraftRecipe;
  fish: BankedFish;
}

/** Pure planner: it never mutates the bank or inventory. */
export function planCraft(recipeId: string, inventory: CraftingInventory, bank: readonly BankedFish[]): CraftPlan | null {
  const recipe = CRAFT_RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe || !canCraft(recipe, inventory, bank)) return null;
  const fish = eligibleFish(bank, recipe)[0];
  return fish ? { recipe, fish } : null;
}

export function applyCraft(inventory: CraftingInventory, recipe: CraftRecipe): CraftingInventory {
  const next = sanitizeCraftingInventory(inventory);
  for (const [material, amount] of Object.entries(recipe.requires)) {
    next[material as CraftingMaterial] -= amount ?? 0;
  }
  next[recipe.output] += recipe.outputQty;
  return next;
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const {
  CRAFT_RECIPES,
  applyCraft,
  canCraft,
  emptyCraftingInventory,
  eligibleFish,
  planCraft,
  sanitizeCraftingInventory,
} = await load('../src/crafting.ts');

const fish = (rarity, extra = {}) => ({ id: `${rarity}-${Math.random()}`, rarity, assetId: `${rarity}-asset`, nft: 'minted', ...extra });

test('recipes require minted, non-legacy fish and their listed bait materials', () => {
  const basic = CRAFT_RECIPES.find((recipe) => recipe.id === 'bait-basic');
  assert.equal(eligibleFish([fish('common'), fish('rare'), fish('common', { legacy: true }), fish('common', { sellQueued: true })], basic).length, 1);
  assert.equal(canCraft(basic, emptyCraftingInventory(), [fish('common')]), true);
  assert.equal(canCraft(CRAFT_RECIPES.find((recipe) => recipe.id === 'bait-deep'), emptyCraftingInventory(), [fish('rare')]), false);
});

test('planning is read-only and applying a craft consumes prerequisites then adds output', () => {
  const inventory = { bait1: 2, bait2: 0, bait3: 0 };
  const bank = [fish('rare')];
  const recipe = CRAFT_RECIPES.find((candidate) => candidate.id === 'bait-deep');
  const plan = planCraft(recipe.id, inventory, bank);
  assert.equal(plan.fish, bank[0]);
  assert.deepEqual(inventory, { bait1: 2, bait2: 0, bait3: 0 });
  assert.deepEqual(applyCraft(inventory, recipe), { bait1: 1, bait2: 1, bait3: 0 });
});

test('malformed local inventory is clamped to finite non-negative integers', () => {
  assert.deepEqual(sanitizeCraftingInventory({ bait1: 2.8, bait2: -3, bait3: 'many' }), { bait1: 2, bait2: 0, bait3: 0 });
});

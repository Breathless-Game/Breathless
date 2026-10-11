import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourceFile = fileURLToPath(new URL('../src/fish-food.ts', import.meta.url));
const source = readFileSync(sourceFile, 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
new Function('module', 'exports', outputText)(module, module.exports);
const { FISH_FOODS, fishFood, fishFoodEffects, fishFoodGrowth, fishFoodPrice, parseFishFood } = module.exports;

test('food catalog has five distinct, ascending tiers and exponential prices', () => {
  assert.equal(FISH_FOODS.length, 5);
  assert.equal(new Set(FISH_FOODS.map((food) => food.id)).size, FISH_FOODS.length);
  assert.deepEqual(FISH_FOODS.map((food) => food.price), [8, 24, 72, 216, 648]);
  assert.deepEqual(FISH_FOODS.map((food) => fishFoodPrice(food.tier)), [8, 24, 72, 216, 648]);
  for (let i = 1; i < FISH_FOODS.length; i++) assert.equal(FISH_FOODS[i].price / FISH_FOODS[i - 1].price, 3);
});

test('entry food growth is deliberately weaker than the neutral feed', () => {
  assert.equal(fishFoodGrowth('plankton', 10), 4);
  assert.equal(fishFoodGrowth('pellet', 10), 7);
  assert.ok(fishFoodGrowth('glowCoral', 10) > fishFoodGrowth('krill', 10));
  assert.equal(fishFoodGrowth('krill', 10, 2), 21);
});

test('effects expose cooldown, speed, and glow without mutating definitions', () => {
  const before = JSON.stringify(fishFood('shrimp'));
  const effects = fishFoodEffects('shrimp', 2);
  assert.ok(effects.cooldownMultiplier < 1);
  assert.ok(effects.swimSpeedMultiplier > 1);
  assert.equal(effects.glowIntensity, 0.4);
  assert.equal(JSON.stringify(fishFood('shrimp')), before);
  assert.equal(parseFishFood('unknown'), null);
});

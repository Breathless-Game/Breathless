import { storageKey } from './wallet';
import type { UpgradeSlot } from './equipment';

/** The synthesis station is hidden from players for now; flip to true to bring the workbench rig, hint, and manual chapter back. */
export const SYNTHESIS_ENABLED = false;

export type MaterialId = 'scale' | 'fiber' | 'scrap' | 'crystal';

export interface SynthesisState {
  materials: Record<MaterialId, number>;
  crafted: { bait: number; composite: number };
}

export interface RecipeDef {
  readonly id: 'bait' | 'composite';
  readonly name: string;
  readonly nameZh: string;
  readonly needs: Readonly<Partial<Record<MaterialId, number>>>;
  readonly output: keyof SynthesisState['crafted'];
}

export const MATERIALS: readonly { id: MaterialId; name: string; nameZh: string; color: string }[] = Object.freeze([
  { id: 'scale', name: 'Fish scale', nameZh: '鱼鳞片', color: '#d5a957' },
  { id: 'fiber', name: 'Reef fiber', nameZh: '珊瑚纤维', color: '#55c7b4' },
  { id: 'scrap', name: 'Iron scrap', nameZh: '铁屑', color: '#9ba6a2' },
  { id: 'crystal', name: 'Depth crystal', nameZh: '深度晶体', color: '#7da9ff' },
]);

export const RECIPES: readonly RecipeDef[] = Object.freeze([
  { id: 'bait', name: 'Tide bait', nameZh: '潮汐鱼饵', needs: { scale: 2, fiber: 1 }, output: 'bait' },
  { id: 'composite', name: 'Composite plate', nameZh: '复合护板', needs: { scrap: 3, crystal: 1, fiber: 2 }, output: 'composite' },
]);

/** Synthesis upgrade prices. They deliberately replace the old workshop prices only in this station. */
// Not frozen: setSynthesisCosts() replaces them with the on-chain Config's prices once it is read.
export const SYNTHESIS_UPGRADE_COSTS: Readonly<Record<UpgradeSlot, readonly [number, number]>> = {
  net: [89, 499], rod: [68, 329], reel: [78, 389], fins: [99, 549], tank: [119, 699], lamp: [58, 299], sonar: [149, 899],
};
export const SYNTHESIS_RECIPE_COSTS: Readonly<Record<RecipeDef['id'], number>> = { bait: 38, composite: 128 };

/** Replace the station's fees and recipe costs with the on-chain Config's (player-chain.ts). */
export function setSynthesisCosts(
  upgrade: Partial<Record<UpgradeSlot, readonly [number, number]>>,
  recipes: Partial<Record<RecipeDef['id'], number>>,
): void {
  const ok = (n: number) => Number.isSafeInteger(n) && n > 0;
  const up = SYNTHESIS_UPGRADE_COSTS as Record<UpgradeSlot, readonly [number, number]>;
  for (const [slot, costs] of Object.entries(upgrade) as [UpgradeSlot, readonly [number, number]][]) {
    if (slot in up && costs.every(ok)) up[slot] = [costs[0], costs[1]];
  }
  const rc = SYNTHESIS_RECIPE_COSTS as Record<RecipeDef['id'], number>;
  for (const [id, cost] of Object.entries(recipes) as [RecipeDef['id'], number][]) {
    if (id in rc && ok(cost)) rc[id] = cost;
  }
}

export const SYNTHESIS_STORAGE_KEY = 'deepbreath.synthesis';

export const DEFAULT_SYNTHESIS: SynthesisState = Object.freeze({
  materials: Object.freeze({ scale: 8, fiber: 8, scrap: 10, crystal: 3 }),
  crafted: Object.freeze({ bait: 0, composite: 0 }),
});

const nonNegative = (value: unknown, fallback = 0) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, n);
};
const storedCount = (value: unknown, fallback: number) => value === undefined ? fallback : nonNegative(value);

export function normalizeSynthesis(input: unknown): SynthesisState {
  const raw = input && typeof input === 'object' ? input as Partial<SynthesisState> : {};
  const materials: Partial<SynthesisState['materials']> = raw.materials && typeof raw.materials === 'object' ? raw.materials : {};
  const crafted: Partial<SynthesisState['crafted']> = raw.crafted && typeof raw.crafted === 'object' ? raw.crafted : {};
  return {
    materials: {
      scale: storedCount(materials.scale, DEFAULT_SYNTHESIS.materials.scale),
      fiber: storedCount(materials.fiber, DEFAULT_SYNTHESIS.materials.fiber),
      scrap: storedCount(materials.scrap, DEFAULT_SYNTHESIS.materials.scrap),
      crystal: storedCount(materials.crystal, DEFAULT_SYNTHESIS.materials.crystal),
    },
    crafted: { bait: nonNegative(crafted.bait), composite: nonNegative(crafted.composite) },
  };
}

export function loadSynthesis(): SynthesisState {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(SYNTHESIS_STORAGE_KEY)) ?? 'null');
    const state = normalizeSynthesis(raw ?? DEFAULT_SYNTHESIS);
    saveSynthesis(state);
    return state;
  } catch {
    return normalizeSynthesis(DEFAULT_SYNTHESIS);
  }
}

export function saveSynthesis(state: SynthesisState): void {
  try { localStorage.setItem(storageKey(SYNTHESIS_STORAGE_KEY), JSON.stringify(normalizeSynthesis(state))); } catch { /* wallet not connected or storage unavailable */ }
}

export function recipe(id: RecipeDef['id']): RecipeDef {
  return RECIPES.find((entry) => entry.id === id) ?? RECIPES[0];
}

export function canCraft(state: SynthesisState, id: RecipeDef['id']): boolean {
  const def = recipe(id);
  return Object.entries(def.needs).every(([key, amount]) => state.materials[key as MaterialId] >= (amount ?? 0));
}

/** Consume one recipe atomically and return a new state. */
export function craft(state: SynthesisState, id: RecipeDef['id']): SynthesisState | null {
  if (!canCraft(state, id)) return null;
  const def = recipe(id);
  const next = normalizeSynthesis(state);
  for (const [key, amount] of Object.entries(def.needs)) next.materials[key as MaterialId] -= amount ?? 0;
  next.crafted[def.output] += 1;
  return next;
}

export function synthesisUpgradeCost(slot: UpgradeSlot, currentLevel: number): number | null {
  const costs = SYNTHESIS_UPGRADE_COSTS[slot];
  return currentLevel >= 1 && currentLevel <= 2 ? costs[currentLevel - 1] : null;
}

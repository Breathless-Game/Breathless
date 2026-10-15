/** Bounded ownership of disposable UI data, ordered by actual use rather than insertion. */
export class LruCache<K, V> {
  private entries = new Map<K, { value: V; weight: number }>();
  private weight = 0;

  constructor(private maxEntries: number, private maxWeight: number, private weigh: (value: V) => number) {}

  get size(): number { return this.entries.size; }
  get totalWeight(): number { return this.weight; }

  get(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    const old = this.entries.get(key);
    if (old) { this.weight -= old.weight; this.entries.delete(key); }
    const weight = Math.max(0, this.weigh(value));
    if (!Number.isFinite(weight) || weight > this.maxWeight || this.maxEntries <= 0) return;
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
      const key = this.entries.keys().next().value as K;
      this.weight -= this.entries.get(key)!.weight;
      this.entries.delete(key);
    }
  }

  clear(): void { this.entries.clear(); this.weight = 0; }
}

/** Small ambient lift at depth; sunlight, fog and the dark water palette retain their falloff. */
export function underwaterAmbientLift(depth: number): number {
  if (!Number.isFinite(depth)) return 0;
  const t = Math.max(0, Math.min(1, (depth - 12) / 43));
  return 0.06 * t * t * (3 - 2 * t);
}

/** A contextual ascent cue, rather than an always-on exploration overlay. */
export function needsSurfaceGuide(depth: number, caught: number, capacity: number, outOfAir: boolean): boolean {
  if (!Number.isFinite(depth) || depth < 3) return false;
  return outOfAir || (Number.isFinite(caught) && Number.isFinite(capacity) && capacity > 0 && caught >= Math.ceil(capacity * 0.8));
}

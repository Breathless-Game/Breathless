/** Only the open ocean has an open slot beneath its shelf. */
export const TRENCH_HALF_WIDTH = 14;
/** Clearance for the diver's body inside the ocean's slot. */
export const TRENCH_SWIM_HALF_WIDTH = TRENCH_HALF_WIDTH - 1.2;

export function terrainFloorY(hasTrench: boolean, x: number, sandY: number): number {
  return hasTrench && Math.abs(x) <= TRENCH_SWIM_HALF_WIDTH ? -Infinity : sandY;
}

/** Use the previous position for walls, so descending beside the mouth cannot pull a diver into it. */
export function insideTrench(hasTrench: boolean, x: number, y: number, sandY: number): boolean {
  return hasTrench && Math.abs(x) <= TRENCH_SWIM_HALF_WIDTH && y < sandY + 1.2;
}

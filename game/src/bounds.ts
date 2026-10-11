/** Clamp a horizontal world coordinate to the playable corridor. */
export function clampWorldX(x: number, halfWidth: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(halfWidth) || halfWidth < 0) return 0;
  return Math.min(Math.max(x, -halfWidth), halfWidth);
}

/** A horizontal corridor whose two sides can be expanded independently. */
export interface WorldBounds {
  /** Negative x coordinate of the active left edge. */
  left: number;
  /** Positive x coordinate of the active right edge. */
  right: number;
  /** The corridor used before the player swims into an edge. */
  readonly baseHalfWidth: number;
  /** Hard cap imposed by the generated terrain and surface meshes. */
  readonly maxHalfWidth: number;
}

export interface DynamicBoundsTuning {
  /** Start opening an edge when the player enters this many metres from it. */
  edgeDistance: number;
  /** Outward speed required before an edge starts opening. */
  outwardSpeed: number;
  /** Metres per second at which an edge opens. */
  expandSpeed: number;
  /** Metres per second at which an unused edge closes. */
  retractSpeed: number;
  /** Keep a small amount of space between a closing edge and the player. */
  playerMargin: number;
}

export const DEFAULT_DYNAMIC_BOUNDS_TUNING: Readonly<DynamicBoundsTuning> = {
  edgeDistance: 18,
  outwardSpeed: 0.35,
  expandSpeed: 20,
  retractSpeed: 7,
  playerMargin: 1.5,
};

/**
 * Create an independently expandable corridor. Values are sanitised here so a
 * bad setting cannot put the diver outside the generated world.
 */
export function createWorldBounds(baseHalfWidth = 140, maxHalfWidth = 200): WorldBounds {
  const base = Number.isFinite(baseHalfWidth) && baseHalfWidth >= 0 ? baseHalfWidth : 140;
  const max = Number.isFinite(maxHalfWidth) && maxHalfWidth >= base ? maxHalfWidth : base;
  return { left: -base, right: base, baseHalfWidth: base, maxHalfWidth: max };
}

/** Clamp to an asymmetric corridor. */
export function clampWorldXToBounds(x: number, bounds: Pick<WorldBounds, 'left' | 'right'>): number {
  if (!Number.isFinite(x) || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.right)) return 0;
  const left = Math.min(bounds.left, bounds.right);
  const right = Math.max(bounds.left, bounds.right);
  return Math.min(Math.max(x, left), right);
}

/** Camera look-ahead for an asymmetric corridor. */
export function cameraTargetXToBounds(
  position: number,
  velocity: number,
  bounds: Pick<WorldBounds, 'left' | 'right'>,
  lead = 0.35,
): number {
  return clampWorldXToBounds(position + (Number.isFinite(velocity) ? velocity * lead : 0), bounds);
}

function tuningValue(value: number, fallback: number, minimum = 0): number {
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

/**
 * Advance dynamic map edges by one physics step.
 *
 * An edge only opens while the diver is close to it and moving outwards. When
 * the diver stops or turns around, that edge eases back toward the base width.
 * The player margin guarantees that a retracting edge never crosses the diver.
 * The function mutates and returns `bounds` to keep the frame loop allocation-free.
 */
export function advanceWorldBounds(
  bounds: WorldBounds,
  positionX: number,
  velocityX: number,
  dt: number,
  tuning: Partial<DynamicBoundsTuning> = {},
): WorldBounds {
  if (!bounds || !Number.isFinite(dt) || dt <= 0) return bounds;
  const edgeDistance = tuningValue(tuning.edgeDistance ?? DEFAULT_DYNAMIC_BOUNDS_TUNING.edgeDistance, DEFAULT_DYNAMIC_BOUNDS_TUNING.edgeDistance);
  const outwardSpeed = tuningValue(tuning.outwardSpeed ?? DEFAULT_DYNAMIC_BOUNDS_TUNING.outwardSpeed, DEFAULT_DYNAMIC_BOUNDS_TUNING.outwardSpeed);
  const expandSpeed = tuningValue(tuning.expandSpeed ?? DEFAULT_DYNAMIC_BOUNDS_TUNING.expandSpeed, DEFAULT_DYNAMIC_BOUNDS_TUNING.expandSpeed);
  const retractSpeed = tuningValue(tuning.retractSpeed ?? DEFAULT_DYNAMIC_BOUNDS_TUNING.retractSpeed, DEFAULT_DYNAMIC_BOUNDS_TUNING.retractSpeed);
  const playerMargin = tuningValue(tuning.playerMargin ?? DEFAULT_DYNAMIC_BOUNDS_TUNING.playerMargin, DEFAULT_DYNAMIC_BOUNDS_TUNING.playerMargin);
  const x = Number.isFinite(positionX) ? positionX : 0;
  const vx = Number.isFinite(velocityX) ? velocityX : 0;
  const step = Math.min(dt, 0.25);
  const base = Math.min(bounds.baseHalfWidth, bounds.maxHalfWidth);
  const max = Math.max(base, bounds.maxHalfWidth);

  const openingRight = x >= bounds.right - edgeDistance && vx > outwardSpeed;
  const openingLeft = x <= bounds.left + edgeDistance && vx < -outwardSpeed;
  bounds.right = openingRight
    ? Math.min(max, bounds.right + expandSpeed * step)
    : Math.max(base, bounds.right - retractSpeed * step);
  bounds.left = openingLeft
    ? Math.max(-max, bounds.left - expandSpeed * step)
    : Math.min(-base, bounds.left + retractSpeed * step);

  // A fast turn can leave the diver just beyond the edge for one frame. Keep
  // the active corridor around them while it eases back into its base width.
  if (!openingRight) bounds.right = Math.min(max, Math.max(bounds.right, x + playerMargin));
  if (!openingLeft) bounds.left = Math.max(-max, Math.min(bounds.left, x - playerMargin));
  // Never let a malformed caller leave the sides inverted.
  if (bounds.left > bounds.right) {
    const midpoint = (bounds.left + bounds.right) * 0.5;
    bounds.left = Math.min(bounds.left, midpoint);
    bounds.right = Math.max(bounds.right, midpoint);
  }
  return bounds;
}

/**
 * Add a small look-ahead without letting the camera target leave the map.
 * Keeping the target inside the corridor avoids showing the empty side past
 * the terrain when the diver is pressing into either horizontal boundary.
 */
export function cameraTargetX(position: number, velocity: number, halfWidth: number, lead = 0.35): number {
  return clampWorldX(position + velocity * lead, halfWidth);
}

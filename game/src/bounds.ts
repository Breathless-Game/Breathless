/** Clamp a horizontal world coordinate to the playable corridor. */
export function clampWorldX(x: number, halfWidth: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(halfWidth) || halfWidth < 0) return 0;
  return Math.min(Math.max(x, -halfWidth), halfWidth);
}

/**
 * Add a small look-ahead without letting the camera target leave the map.
 * Keeping the target inside the corridor avoids showing the empty side past
 * the terrain when the diver is pressing into either horizontal boundary.
 */
export function cameraTargetX(position: number, velocity: number, halfWidth: number, lead = 0.35): number {
  return clampWorldX(position + velocity * lead, halfWidth);
}

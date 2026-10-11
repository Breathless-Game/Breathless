/** Pure helpers for the draggable tutorial launcher (no DOM, unit-tested). */
export const DRAG_THRESHOLD_PX = 5;
export const LAUNCHER_POS_KEY = 'deepbreath.tutorialLauncherPos';
export const PANEL_GAP_PX = 10;

export interface FracPos { fx: number; fy: number }
export interface Box { left: number; top: number; width: number; height: number }

/** A pointer gesture counts as a drag only once it travels more than the threshold. */
export function exceedsDragThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/** Keep a w x h box fully inside the viewport (top-left coordinates). */
export function clampPosition(left: number, top: number, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const maxL = Math.max(0, vw - w);
  const maxT = Math.max(0, vh - h);
  return { left: Math.min(Math.max(0, left), maxL), top: Math.min(Math.max(0, top), maxT) };
}

/** Convert a pixel top-left to fractions of the free travel range. */
export function toFraction(left: number, top: number, w: number, h: number, vw: number, vh: number): FracPos {
  const rx = Math.max(1, vw - w), ry = Math.max(1, vh - h);
  return { fx: Math.min(1, Math.max(0, left / rx)), fy: Math.min(1, Math.max(0, top / ry)) };
}

export function fromFraction(p: FracPos, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  return clampPosition(p.fx * Math.max(0, vw - w), p.fy * Math.max(0, vh - h), w, h, vw, vh);
}

/** Parse a stored value; anything malformed or out of range yields null (use the default corner). */
export function parseSavedPos(raw: string | null | undefined): FracPos | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FracPos> | null;
    if (!v || typeof v.fx !== 'number' || typeof v.fy !== 'number') return null;
    if (!Number.isFinite(v.fx) || !Number.isFinite(v.fy)) return null;
    if (v.fx < 0 || v.fx > 1 || v.fy < 0 || v.fy > 1) return null;
    return { fx: v.fx, fy: v.fy };
  } catch { return null; }
}

/**
 * Where a panel anchored to the launcher should go: above it when there is room
 * (else below), right-aligned to the launcher when that fits (else left-aligned),
 * always clamped into the viewport. `bottom` is given for the above case so the
 * panel can grow upward without re-measuring.
 */
export function placePanel(anchor: Box, panelW: number, panelH: number, vw: number, vh: number, gap = PANEL_GAP_PX):
  { left: number; top?: number; bottom?: number } {
  const w = Math.min(panelW, vw);
  let left = anchor.left + anchor.width - w;
  if (left < 0) left = anchor.left;
  left = Math.min(Math.max(0, left), Math.max(0, vw - w));
  const above = anchor.top - gap;
  const below = vh - (anchor.top + anchor.height + gap);
  if (above >= panelH || above >= below) return { left, bottom: Math.max(0, vh - anchor.top + gap) };
  return { left, top: anchor.top + anchor.height + gap };
}

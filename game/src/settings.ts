// Player preferences that survive reloads. Live game state (night, breath input)
// is not stored here: it depends on whether the camera is running this session.

export type Quality = 'high' | 'medium' | 'low';

export interface Settings {
  quality: Quality;
  showCamera: boolean;
  showHelp: boolean;
}

/** Max device pixel ratio per quality level. Low helps slower laptops keep frame rate. */
export const PIXEL_RATIO: Record<Quality, number> = { high: 2, medium: 1, low: 0.6 };

const KEY = 'deepbreath.settings';
const DEFAULTS: Settings = { quality: 'high', showCamera: true, showHelp: true };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

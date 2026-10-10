// Player preferences that survive reloads. Live game state (night, breath input)
// is not stored here: it depends on whether the camera is running this session.

import type { QualityMode } from './render-quality';

export type Quality = QualityMode;

export interface Settings {
  quality: Quality;
  showCamera: boolean;
  showHelp: boolean;
}

const KEY = 'deepbreath.settings';
const DEFAULTS: Settings = { quality: 'auto', showCamera: true, showHelp: true };

export function loadSettings(): Settings {
  try {
    const settings: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    if (!['auto', 'high', 'medium', 'low'].includes(settings.quality)) settings.quality = 'auto';
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

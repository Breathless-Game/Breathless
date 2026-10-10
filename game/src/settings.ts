// Player preferences that survive reloads. Session state such as time of day
// and breath input is managed separately.

import type { QualityMode } from './render-quality';

export type Quality = QualityMode;

export interface Settings {
  quality: Quality;
  lightingEffects: boolean;
  showCamera: boolean;
  showHelp: boolean;
}

const KEY = 'deepbreath.settings';
const DEFAULTS: Settings = { quality: 'auto', lightingEffects: true, showCamera: true, showHelp: true };

export function loadSettings(): Settings {
  try {
    const settings: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    if (!['auto', 'high', 'medium', 'low'].includes(settings.quality)) settings.quality = 'auto';
    if (typeof settings.lightingEffects !== 'boolean') settings.lightingEffects = DEFAULTS.lightingEffects;
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

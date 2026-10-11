// Player preferences that survive reloads. Session state such as time of day
// and breath input is managed separately.

import type { QualityMode } from './render-quality';
import type { WeatherMode } from './weather';

export type Quality = QualityMode;

export interface Settings {
  quality: Quality;
  lightingEffects: boolean;
  weather: WeatherMode;
  showCamera: boolean;
  showHelp: boolean;
}

const KEY = 'deepbreath.settings';
const DEFAULTS: Settings = { quality: 'auto', lightingEffects: true, weather: 'auto', showCamera: true, showHelp: true };

export function loadSettings(): Settings {
  try {
    const settings: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    if (!['auto', 'high', 'medium', 'low'].includes(settings.quality)) settings.quality = 'auto';
    if (typeof settings.lightingEffects !== 'boolean') settings.lightingEffects = DEFAULTS.lightingEffects;
    if (!['auto', 'clear', 'cloudy', 'rain', 'storm'].includes(settings.weather)) settings.weather = 'auto';
    // Older saves have a `sharks` choice ('ask' | 'on' | 'off'). Sharks are no longer optional
    // (they always hunt the Open Ocean), so the field is dropped and the next save leaves it out.
    delete (settings as Settings & { sharks?: unknown }).sharks;
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

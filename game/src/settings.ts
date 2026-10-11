// Player preferences that survive reloads. Session state such as time of day
// and breath input is managed separately.

import type { QualityMode } from './render-quality';
import type { WeatherMode } from './weather';
import type { Lang } from './i18n';

export type Quality = QualityMode;

export interface Settings {
  quality: Quality;
  lightingEffects: boolean;
  weather: WeatherMode;
  showCamera: boolean;
  showHelp: boolean;
  /** Sharks on the Open Ocean (one to two by day, two to four at night): on, off, or ask before the next dive there. */
  sharks: SharkChoice;
  /** The language the game shows its text in (i18n.ts). */
  language: Lang;
}

export type SharkChoice = 'ask' | 'on' | 'off';

const KEY = 'deepbreath.settings';
const DEFAULTS: Settings = {
  quality: 'auto',
  lightingEffects: true,
  weather: 'auto',
  showCamera: true,
  showHelp: true,
  sharks: 'ask',
  language: typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? 'zh' : 'en',
};

export function loadSettings(): Settings {
  try {
    const settings: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    if (!['auto', 'high', 'medium', 'low'].includes(settings.quality)) settings.quality = 'auto';
    if (typeof settings.lightingEffects !== 'boolean') settings.lightingEffects = DEFAULTS.lightingEffects;
    if (!['auto', 'clear', 'cloudy', 'rain', 'storm'].includes(settings.weather)) settings.weather = 'auto';
    if (!['ask', 'on', 'off'].includes(settings.sharks)) settings.sharks = DEFAULTS.sharks;
    if (!['en', 'zh'].includes(settings.language)) settings.language = DEFAULTS.language;
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

import { storageKey } from './wallet';

/** The beam color players choose for the deep sonar buoy in the ready room. */
export const DEFAULT_SONAR_COLOR = '#42e8d2';
export const SONAR_CONFIG_STORAGE_KEY = 'deepbreath.sonar';

export type SonarLengthLevel = 1 | 2 | 3;

export interface SonarConfig {
  color: string;
  /** The deployed cable length. The sonar upgrade system may overwrite this. */
  lengthLevel: SonarLengthLevel;
}

const DEFAULT_CONFIG: SonarConfig = { color: DEFAULT_SONAR_COLOR, lengthLevel: 1 };

function validColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CONFIG.color;
  const color = value.trim();
  // Keep the UI and render path on a compact, CSS-compatible value. Three.js
  // accepts several formats, but hex is portable through localStorage and the
  // native color input on every browser we support.
  return /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_CONFIG.color;
}

function validLength(value: unknown): SonarLengthLevel {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.lengthLevel;
  return Math.min(3, Math.max(1, Math.floor(n))) as SonarLengthLevel;
}

function normalize(value: unknown): SonarConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CONFIG };
  const record = value as Record<string, unknown>;
  return { color: validColor(record.color), lengthLevel: validLength(record.lengthLevel) };
}

/** Load this wallet's chosen beam color and cable tier. */
export function loadSonarConfig(): SonarConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG };
  try {
    const raw = localStorage.getItem(storageKey(SONAR_CONFIG_STORAGE_KEY));
    return raw == null ? { ...DEFAULT_CONFIG } : normalize(JSON.parse(raw) as unknown);
  } catch {
    // The ready room is usable while a wallet is reconnecting and in browsers
    // that disable storage. A transient storage failure must not block a dive.
    return { ...DEFAULT_CONFIG };
  }
}

export function saveSonarConfig(config: SonarConfig): SonarConfig {
  const normalized = normalize(config);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey(SONAR_CONFIG_STORAGE_KEY), JSON.stringify(normalized));
  } catch {
    // Storage is best effort, like the other local equipment preferences.
  }
  return normalized;
}

export function setSonarColor(color: string): SonarConfig {
  return saveSonarConfig({ ...loadSonarConfig(), color });
}

export function sonarLengthMeters(level: SonarLengthLevel): number {
  // Keep the display in lockstep with DeepSonar's purchased tiers.
  return [10, 17, 26][level - 1];
}


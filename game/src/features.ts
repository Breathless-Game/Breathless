// Build-time feature switches. Flags, not secrets: every VITE_* value is bundled into the page.
//
// Presage SmartSpectra (camera breath detection) is switched off for now: its credits ran out.
// Off, the game never asks for the camera, skips calibration and plays on the keyboard (hold
// Shift); the camera code all stays. Turn it back on with VITE_PRESAGE_ENABLED=1 at build time,
// together with PRESAGE_ENABLED=1 on the server (sensor/presage-flag.mjs).

import type { BreathMode } from './breath';

/** True only for '1' / 'true'. */
export function flagOn(raw: unknown): boolean {
  return /^(1|true)$/i.test(String(raw ?? '').trim());
}

// `?.`: tests import this module outside Vite, where import.meta.env doesn't exist.
export const PRESAGE_ENABLED = flagOn(import.meta.env?.VITE_PRESAGE_ENABLED);

/**
 * The breath inputs the K key and the pause menu cycle through. Presage on: the camera
 * (once there is one, or the player wants it back), the simulator and the keyboard. Off:
 * the keyboard only, plus the simulator in a dev build (it needs the sensor: `npm run sensor`).
 */
export function breathModeList(o: { presage: boolean; camera: boolean; dev: boolean }): BreathMode[] {
  if (o.presage) return o.camera ? ['presage', 'sim', 'keyboard'] : ['sim', 'keyboard'];
  return o.dev ? ['sim', 'keyboard'] : ['keyboard'];
}

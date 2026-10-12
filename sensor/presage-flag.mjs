// Presage SmartSpectra (camera breath detection) is switched off for now: its credits ran
// out. One flag turns it back on, PRESAGE_ENABLED=1 (or true) in .env or the environment;
// anything else, unset included, is off. Off, index.mjs never loads the SDK, ignores
// PRESAGE_API_KEY even when .env still holds one, and drops every camera frame. The game's
// own switch is VITE_PRESAGE_ENABLED (game/src/features.ts).

/** True only for PRESAGE_ENABLED=1 / true. */
export function presageEnabled(env = process.env) {
  return /^(1|true)$/i.test(String(env.PRESAGE_ENABLED ?? '').trim());
}

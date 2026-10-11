// The "upgrade levels changed" hook. Whatever changes a level calls gearLevelsChanged(): buying an
// upgrade, switching a branch, equipping a ship, or a penalty that resets gear. main.ts
// refreshEquipment() calls it (the one path that saves equipment levels: purchases, branch
// switches and resetDiveGearAfterBite all end there) and ships.ts calls it when a ship is
// equipped, so code that mutates `equipment` and then calls refreshEquipment() is covered without
// doing anything else. Listeners (gear-sync.ts, the on-chain Boat and Dive Kit) re-read the levels
// themselves and compare them with what they last synced, so calling this too often is harmless.
// No imports: statically loaded code and tests can use it freely.

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to level changes. Returns the unsubscribe function. */
export function onGearLevelsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Announce that some upgrade level (or the ship, or a branch) may have changed. Never throws. */
export function gearLevelsChanged(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (e) {
      console.error(e);
    }
  }
}

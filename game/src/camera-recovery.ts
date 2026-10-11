// When to keep the webcam going mid-dive and when to give it up (breath.ts). No DOM
// here, so the decisions are tested without a camera (tests/camera-recovery.test.mjs).

/**
 * How long a reconnect may hear "busy" before the camera is given up. The sensor
 * drops a dead socket, freeing its Presage slot, within ~20 s (sensor/heartbeat.mjs).
 */
export const BUSY_GRACE_MS = 45_000;
/** While waiting for the slot back, one frame a second keeps claiming it. */
export const BUSY_FRAME_MS = 1000;
/** A camera track muted this long (another app took it, the OS paused it) counts as lost. */
export const MUTE_GRACE_MS = 4000;
/** At most one automatic re-acquire per window: a camera that keeps dying drops to the keyboard. */
export const REACQUIRE_COOLDOWN_MS = 20_000;
/** The sensor broadcasts state every 80 ms; this long without a word means the socket is dead. */
export const SENSOR_SILENT_MS = 5000;
/** No video frame for this long while the camera should be running: restart playback and the pump. */
export const FRAME_STALL_MS = 3000;

/**
 * The sensor said "busy". A first connect falls back to the keyboard at once (the
 * server is full); a reconnect after this game held the slot waits for it to free.
 */
export function onBusy(hadSlot: boolean, busySince: number, now: number): 'fallback' | 'wait' {
  return hadSlot && now - busySince < BUSY_GRACE_MS ? 'wait' : 'fallback';
}

/** Whether a lost camera may be re-acquired automatically now. */
export function canReacquire(lastReacquireAt: number, now: number): boolean {
  return now - lastReacquireAt >= REACQUIRE_COOLDOWN_MS;
}

/** While waiting out "busy": frames go at BUSY_FRAME_MS, only to keep claiming the slot. */
export function busyFrameDue(lastSentAt: number, now: number): boolean {
  return now - lastSentAt >= BUSY_FRAME_MS;
}

/** Whether the camera pipeline has stalled: no frame for FRAME_STALL_MS. */
export function frameStalled(lastFrameAt: number, now: number): boolean {
  return now - lastFrameAt >= FRAME_STALL_MS;
}

/** Whether an open sensor socket has gone silent and should be replaced. */
export function sensorSilent(lastMessageAt: number, now: number): boolean {
  return now - lastMessageAt >= SENSOR_SILENT_MS;
}

/**
 * While the breath signal recovers (camera re-opening, sensor reconnecting, a fresh detector
 * warming up) the last HOLD/BREATHE stands instead of the detector's "not holding", which
 * underwater would read as a breath and black the diver out. Only this long, though: a
 * signal that never comes back must not keep a diver under for good.
 */
export const RECOVERY_HOLD_MAX_MS = 20_000;

export interface RecoveryInput {
  connected: boolean;
  /** The detector says hold detection can fire (`calibrated`, and `warm` when the sensor sends it). */
  ready: boolean;
  /** The camera is being re-opened, or its track is muted/ended. */
  cameraDown: boolean;
  /** Waiting out "busy" on a reconnect. */
  waitingSlot: boolean;
}

/** Whether the live breath signal is unreliable right now. */
export function recovering(i: RecoveryInput): boolean {
  return !i.connected || !i.ready || i.cameraDown || i.waitingSlot;
}

/** Whether the last holding value still stands, `since` being when recovery began (0: not recovering). */
export function holdOver(since: number, now: number): boolean {
  return since > 0 && now - since < RECOVERY_HOLD_MAX_MS;
}

/** Hold detection can fire: `calibrated`, and `warm` unless the sensor doesn't send it. */
export function detectorReady(msg: { calibrated?: unknown; warm?: unknown }): boolean {
  return msg.calibrated === true && msg.warm !== false;
}

/**
 * The breathing baseline this page last saw, sent to a new detector so the player doesn't
 * relearn it (kept in memory only: a refresh relearns). null for anything not a usable number.
 */
export function seedMessage(baseline: number | null): { t: 'seed'; type: 'seed'; baseline: number } | null {
  if (typeof baseline !== 'number' || !Number.isFinite(baseline)) return null;
  return { t: 'seed', type: 'seed', baseline };
}

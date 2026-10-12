// When to keep the webcam going mid-dive and when to give it up (breath.ts). No DOM
// here, so the decisions are tested without a camera (tests/camera-recovery.test.mjs).

/**
 * How long a reconnect may hear "busy" before the camera is given up. The sensor
 * frees a dead socket's Presage slot once it notices the socket is gone (with a pong
 * check on its 10 s ping, within ~20 s).
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

/**
 * Whether camera frames may go to the sensor now. Never from a background tab: Presage bills
 * per measurement, and a hidden player isn't playing. The sensor keeps the baseline across the
 * Presage restart that the gap causes, so coming back costs a short warm-up.
 */
export function canSendFrames(o: { presage: boolean; socketOpen: boolean; cameraLive: boolean; hidden: boolean }): boolean {
  return o.presage && o.socketOpen && o.cameraLive && !o.hidden;
}

/**
 * Whether the watchdog may call the camera stalled. A hidden tab sends nothing on purpose (and
 * presents no video frames), so that is never a dead camera; nor is a re-acquire under way.
 */
export function stallCheckApplies(o: { hidden: boolean; reacquiring: boolean }): boolean {
  return !o.hidden && !o.reacquiring;
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

/** The sensor accepts a seed in this range and silently ignores anything else. */
export const SEED_MIN = 0.001;
export const SEED_MAX = 1000;

/** Whether a reported baseline is worth remembering and sending back as a seed. */
export function usableBaseline(baseline: unknown): baseline is number {
  return typeof baseline === 'number' && Number.isFinite(baseline) && baseline >= SEED_MIN && baseline <= SEED_MAX;
}

/**
 * The breathing baseline this page last saw, sent to a new sensor connection so the player
 * doesn't relearn it (kept in memory only: a refresh relearns). null when there is none.
 */
export function seedMessage(baseline: number | null): { t: 'seed'; baseline: number } | null {
  return usableBaseline(baseline) ? { t: 'seed', baseline } : null;
}

/**
 * Presage mode with no usable signal (socket down, or the detector can't fire a hold yet):
 * underwater that must not count as breathing.
 */
export function sensorNotReady(s: { mode: string; connected: boolean; calibrated: boolean }): boolean {
  return s.mode === 'presage' && (!s.connected || !s.calibrated);
}

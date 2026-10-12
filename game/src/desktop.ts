// The desktop app (desktop/, Electron) loads this same site and adds window.breathlessDesktop
// from its preload (desktop/src/preload.js). In a normal browser it is missing.
// Not wired into the login yet: desktop wallet login (through the system browser) comes later.

export interface BreathlessDesktop {
  platform: 'win32' | 'darwin' | 'linux';
  /** The desktop app's version (not the game's). */
  version: string;
  /** Sent to the app's wallet bridge (desktop/src/wallet-bridge.js). */
  walletRequest(req: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    breathlessDesktop?: BreathlessDesktop;
  }
}

/** The desktop app's bridge, or null in a browser. */
export function breathlessDesktop(): BreathlessDesktop | null {
  return typeof window !== 'undefined' && window.breathlessDesktop ? window.breathlessDesktop : null;
}

export function isDesktop(): boolean {
  return breathlessDesktop() !== null;
}

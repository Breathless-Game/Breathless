// Wallet requests from the game (window.breathlessDesktop.walletRequest → ipc 'wallet:request').
// Browser wallet extensions (Phantom etc.) don't exist inside Electron, so phase B will relay
// owner signatures through the system browser and come back over breathless:// (main.js onDeepLink).
// Until then every request is refused politely.
'use strict';

/**
 * @typedef {object} WalletContext
 * @property {string} origin        the site origin the app is locked to
 * @property {string} senderUrl     URL of the frame that asked (already checked to be on origin)
 * @property {import('electron').BrowserWindow | null} window  the game window
 * @property {(url: string) => void} openExternal  open an https URL in the system browser
 * @property {(...parts: unknown[]) => void} log
 */

/**
 * @param {unknown} req  whatever the game sent; validate before use
 * @param {WalletContext} ctx
 * @returns {Promise<unknown>}
 */
async function handleWalletRequest(req, ctx) {
  void req;
  void ctx;
  return { ok: false, reason: 'unsupported', message: 'Wallet login in the desktop app is coming soon.' };
}

module.exports = { handleWalletRequest };

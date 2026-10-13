// Wallet requests from the game (window.breathlessDesktop.walletRequest → ipc 'wallet:request').
// Browser wallet extensions (Phantom etc.) don't exist inside Electron, so the game relays owner
// signatures through the player's normal browser (game/src/desktop-wallet.ts, the server's
// /api/link): all it needs from the app is to open the site's link page there. Everything else
// (the session, polling, checking the signatures) happens in the game page itself.
//
// One request: { kind: 'openLink', url } -> { ok: true } | { ok: false, reason, message }.
// The URL must be the site's own https link page, /link.html?sid=<id>#t=<token>, and nothing else.
'use strict';

const LINK_PATH = '/link.html';
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_URL = 2048;

/**
 * @typedef {object} WalletContext
 * @property {string} origin        the site origin the app is locked to
 * @property {string} senderUrl     URL of the frame that asked (already checked to be on origin)
 * @property {import('electron').BrowserWindow | null} window  the game window
 * @property {(url: string) => void} openExternal  open an https URL in the system browser
 * @property {(...parts: unknown[]) => void} log
 */

/** The link page URL to open, or null when `raw` is anything but the site's own https /link.html?sid=…#t=…. */
function linkUrl(raw, origin) {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return null;
  if (url.pathname !== LINK_PATH) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'sid' || !ID_RE.test(url.searchParams.get('sid') || '')) return null;
  const hash = new URLSearchParams(url.hash.slice(1));
  if ([...hash.keys()].join() !== 't' || !ID_RE.test(hash.get('t') || '')) return null;
  return url.href;
}

/**
 * @param {unknown} req  whatever the game sent; validate before use
 * @param {WalletContext} ctx
 * @returns {Promise<unknown>}
 */
async function handleWalletRequest(req, ctx) {
  if (!req || typeof req !== 'object' || /** @type {{kind?: unknown}} */ (req).kind !== 'openLink') {
    return { ok: false, reason: 'unsupported', message: 'The app only opens the wallet link page.' };
  }
  const href = linkUrl(/** @type {{url?: unknown}} */ (req).url, ctx.origin);
  if (!href) {
    ctx.log('refused a wallet link that is not this site\'s /link.html');
    return { ok: false, reason: 'forbidden', message: 'Only this site\'s wallet link page can be opened.' };
  }
  ctx.openExternal(href);
  return { ok: true };
}

module.exports = { handleWalletRequest, linkUrl };

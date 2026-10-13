// 屏息 Breathless desktop app: a window onto the live site. The game, its /api/* calls and
// its localStorage all stay on https://breathless.gotclass.xyz, so every deploy of main
// reaches the app with no new download. Nothing here bundles the game or the server.
'use strict';

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { handleWalletRequest } = require('./wallet-bridge');

const DEFAULT_URL = 'https://breathless.gotclass.xyz/';
const PROTOCOL = 'breathless';
const OFFLINE_PAGE = path.join(__dirname, 'offline.html');
// Chromium's net::ERR_ABORTED: a navigation replaced by another one, not a failure.
const ERR_ABORTED = -3;

// Prefer the discrete GPU on dual-GPU laptops (Windows and macOS). Must be set before ready.
app.commandLine.appendSwitch('force_high_performance_gpu');

// ---- Logging --------------------------------------------------------------
// One file in the OS log folder (see README), so a player can tell us which GPU the game got.
let logFile = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    // A read-only or full disk must not take the game down.
  }
}
function openLog() {
  try {
    app.setAppLogsPath();
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'breathless.log');
    // Keep it small: start over once it passes 1 MB.
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.truncateSync(logFile, 0);
  } catch (err) {
    logFile = null;
    console.error('log file unavailable:', err);
  }
}

// ---- Which site ------------------------------------------------------------
// BREATHLESS_URL points the app at a dev server (http://localhost:5173) for testing.
function resolveAppUrl() {
  const override = process.env.BREATHLESS_URL;
  if (!override) return new URL(DEFAULT_URL);
  try {
    const url = new URL(override);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url;
  } catch {
    // fall through
  }
  console.error(`BREATHLESS_URL must be an http(s) URL, ignoring: ${override}`);
  return new URL(DEFAULT_URL);
}
const APP_URL = resolveAppUrl();
const APP_ORIGIN = APP_URL.origin;

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
function isAppUrl(raw) {
  const url = parseUrl(raw);
  return !!url && url.origin === APP_ORIGIN;
}
function isOfflinePage(raw) {
  const url = parseUrl(raw);
  return !!url && url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(OFFLINE_PAGE);
}
// Explorer links, wallet sites: the system browser. Anything that isn't https goes nowhere.
function openOutside(raw) {
  const url = parseUrl(raw);
  if (url && url.protocol === 'https:') {
    shell.openExternal(url.href).catch((err) => log('openExternal failed:', String(err)));
  } else {
    log('blocked navigation:', String(raw).slice(0, 200));
  }
}

// ---- Deep links (breathless://) ---------------------------------------------
// Phase B (wallet login through the system browser) will come back here. For now: log.
function onDeepLink(url) {
  log('deep link:', String(url).slice(0, 500));
}
function deepLinkFromArgv(argv) {
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`));
}

// ---- Single instance -------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  /** @type {BrowserWindow | null} */
  let win = null;
  const pendingLinks = [];

  function deliverDeepLink(url) {
    if (app.isReady()) onDeepLink(url);
    else pendingLinks.push(url);
  }

  function focusWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  app.on('second-instance', (_event, argv) => {
    focusWindow();
    const link = deepLinkFromArgv(argv);
    if (link) deliverDeepLink(link);
  });
  // macOS hands URLs over with this event, possibly before ready.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
    focusWindow();
  });
  // Windows and Linux start a fresh app with the URL on the command line.
  const coldLink = deepLinkFromArgv(process.argv);
  if (coldLink) pendingLinks.push(coldLink);

  if (process.defaultApp && process.argv.length >= 2) {
    // `electron .` in development: register the dev binary plus the app folder.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  // Every webContents (the main window and any same-site popup) gets the same rules.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url) || isOfflinePage(url)) return;
      event.preventDefault();
      openOutside(url);
    });
    contents.on('will-redirect', (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      openOutside(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: secureWebPreferences() } };
      }
      openOutside(url);
      return { action: 'deny' };
    });
  });

  app.whenReady().then(async () => {
    openLog();
    log(`Breathless ${app.getVersion()} (Electron ${process.versions.electron}, Chrome ${process.versions.chrome}) on ${process.platform}-${process.arch}`);
    log('site:', APP_URL.href);
    app.on('child-process-gone', (_event, details) => log('child process gone:', details));

    lockDownPermissions(session.defaultSession);

    ipcMain.handle('wallet:request', (event, req) => {
      const senderUrl = event.senderFrame ? event.senderFrame.url : '';
      if (!isAppUrl(senderUrl)) return { ok: false, reason: 'forbidden', message: 'Wallet requests come only from the game.' };
      return handleWalletRequest(req, { origin: APP_ORIGIN, senderUrl, window: BrowserWindow.fromWebContents(event.sender), openExternal: openOutside, log });
    });

    win = createWindow();
    for (const url of pendingLinks.splice(0)) onDeepLink(url);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function secureWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: '屏息 Breathless',
    backgroundColor: '#030c1e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      ...secureWebPreferences(),
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--breathless-version=${app.getVersion()}`],
    },
  });
  win.once('ready-to-show', () => win.show());
  // The GPU process is up once a page has rendered: only then does the GPU info say which adapter it uses.
  win.webContents.once('did-finish-load', () => logGpu());
  win.webContents.on('did-finish-load', () => log('loaded:', win.webContents.getURL().slice(0, 200)));

  const showOffline = (reason) => {
    win.loadFile(OFFLINE_PAGE, { query: { url: APP_URL.href, reason } }).catch((err) => log('offline page failed:', String(err)));
  };
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED || isOfflinePage(url)) return;
    log(`load failed (${code} ${description}):`, url);
    showOffline(description || String(code));
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log('renderer gone:', details);
    if (details.reason !== 'clean-exit') showOffline(details.reason);
  });

  win.loadURL(APP_URL.href).catch(() => {
    // did-fail-load already showed the offline page.
  });
  return win;
}

// Camera (for Presage, if it comes back) from the site only; every other permission: no.
function lockDownPermissions(ses) {
  const allowed = (permission, url) => permission === 'media' && isAppUrl(url);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || contents.getURL();
    const ok = allowed(permission, url);
    if (!ok) log(`denied permission ${permission} for`, String(url).slice(0, 200));
    callback(ok);
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowed(permission, requestingOrigin));
}

async function logGpu() {
  try {
    const info = await app.getGPUInfo('basic');
    const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
    const active = devices.find((d) => d.active) || devices[0];
    log('GPU active:', active ? describeGpu(active) : 'unknown', `(${devices.length} adapter${devices.length === 1 ? '' : 's'})`);
    log('GPU info (basic):', info);
  } catch (err) {
    log('GPU info unavailable:', String(err));
  }
  try {
    log('GPU feature status:', app.getGPUFeatureStatus());
  } catch (err) {
    log('GPU feature status unavailable:', String(err));
  }
  // The readable adapter name (e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 ...)") is only in the complete info.
  try {
    const aux = (await app.getGPUInfo('complete')).auxAttributes || {};
    log('GPU renderer:', aux.glRenderer || 'unknown', aux.glVendor ? `(${aux.glVendor})` : '');
  } catch (err) {
    log('GPU renderer unavailable:', String(err));
  }
}

const GPU_VENDORS = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x1022: 'AMD', 0x8086: 'Intel', 0x106b: 'Apple', 0x5143: 'Qualcomm' };
function describeGpu(device) {
  const vendor = GPU_VENDORS[device.vendorId] || `vendor 0x${Number(device.vendorId || 0).toString(16)}`;
  const name = device.deviceString || device.driverVendor || '';
  return `${vendor}${name ? ` ${name}` : ''} (device 0x${Number(device.deviceId || 0).toString(16)}${device.driverVersion ? `, driver ${device.driverVersion}` : ''})`;
}

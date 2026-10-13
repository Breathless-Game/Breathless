# 屏息 Breathless · desktop app

An Electron window onto https://breathless.gotclass.xyz for Windows, macOS and Linux. It does not bundle the game or the server: every deploy of `main` reaches the app at once, `/api/*`, localStorage and Solana work exactly as in a browser, and the app needs the internet. When the site can't be reached it shows a local "can't reach the server" page with a Retry button (it also retries by itself when the network comes back).

What it adds over a browser tab:

- **Discrete GPU.** `force_high_performance_gpu` asks for the high-performance GPU on dual-GPU laptops (Windows and macOS), and the game's renderer asks for `powerPreference: 'high-performance'`. The adapter in use is written to a log file; see [Which GPU is it using?](#which-gpu-is-it-using).
- **`window.breathlessDesktop`**, from the preload (types in `game/src/desktop.ts`):
  ```ts
  window.breathlessDesktop = {
    platform: 'win32' | 'darwin' | 'linux',
    version: string,                                // the desktop app's version
    walletRequest(req: unknown): Promise<unknown>,  // → src/wallet-bridge.js
  }
  ```
  `walletRequest` answers `{ ok: false, reason: 'unsupported', … }` for now. Wallet extensions (Phantom etc.) don't exist inside Electron, so desktop wallet login will relay signatures through the system browser and come back over `breathless://` (`onDeepLink` in `src/main.js`, which only logs today).

## Files

| File | What it does |
| --- | --- |
| `src/main.js` | Window, GPU switch and log, single-instance lock, `breathless://` deep links, navigation and permission rules |
| `src/preload.js` | The `window.breathlessDesktop` bridge (sandboxed) |
| `src/wallet-bridge.js` | `handleWalletRequest(req, ctx)`, the `wallet:request` handler |
| `src/offline.html`, `src/offline.js` | The "can't reach the server" page |
| `build/icon.png` | App icon (1024 × 1024), made by `scripts/make-icon.py` from `assets/fish/moonfin-leviathan.png` |
| `scripts/check-package.mjs` | Fails if a packed app holds anything but the files above |

Security: `contextIsolation`, `sandbox`, no `nodeIntegration`. The window only navigates within the site's origin; other `https:` links (explorers, wallet sites) open in the system browser and anything else is blocked, for links and `window.open` alike. The camera (`media`) is allowed for the site only, in case Presage comes back; every other permission is denied.

## Run in development

Node 22.12+ (CI uses 24).

```bash
cd desktop
npm ci
npm start                                          # loads the live site
BREATHLESS_URL=http://localhost:5173 npm start     # or a dev server (npm run dev at the repo root)
```

`BREATHLESS_URL` takes `http:` or `https:` URLs only; the app then stays on that origin. DevTools: View → Toggle Developer Tools (Alt shows the menu bar on Windows and Linux).

## Build locally

```bash
cd desktop
npm run pack              # unpacked app in dist/ (dist/mac-arm64/Breathless.app, dist/win-unpacked/...)
npm run dist              # installers for this OS in dist/
npm run check-package     # what got packed: must print "check-package: OK"
```

Each OS builds its own installers (`npx electron-builder --win|--mac|--linux`):

| OS | Output |
| --- | --- |
| Windows | `Breathless-Setup-<version>-win-x64.exe` (NSIS installer), `Breathless-Portable-<version>-win-x64.exe` |
| macOS | `Breathless-<version>-mac-arm64.dmg` (Apple Silicon), `Breathless-<version>-mac-x64.dmg` (Intel) |
| Linux | `Breathless-<version>-linux-x86_64.AppImage`, `Breathless-<version>-linux-amd64.deb` |

The icon: `python3 desktop/scripts/make-icon.py` rebuilds `build/icon.png` (needs Pillow); electron-builder makes the `.icns`/`.ico` from it.

## Cut a release

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` builds on Windows, macOS and Linux runners, checks every packed app with `scripts/check-package.mjs`, and uploads the installers to a **draft** release for the tag, with `release-notes-template.md` as its text. The tag sets the version (`v0.2.0` builds 0.2.0); use `vMAJOR.MINOR.PATCH`. Then on GitHub: Releases → the draft → edit the notes → **Publish release**. Nothing is public until someone publishes it.

Run the workflow from the Actions tab (Run workflow) to build without a release; the installers are kept as workflow artifacts for 14 days. Tags don't trigger the site deploy (`deploy.yml` runs on pushes to `main` only).

## First launch of an unsigned build

There are no code-signing certificates, so every OS warns the first time.

- **Windows** (SmartScreen, "Windows protected your PC"): click **More info**, then **Run anyway**.
- **macOS** ("Apple could not verify 'Breathless' is free of malware…"): open the dmg, drag Breathless to Applications, then right-click (Control-click) the app → **Open** → **Open**. On macOS 15 and later: try to open it once, then go to **System Settings → Privacy & Security**, scroll down to "Breathless was blocked…" and click **Open Anyway**. If it still won't open (or says it is "damaged"), run this once in Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Breathless.app
  ```
- **Linux**: make the AppImage executable, then run it:
  ```bash
  chmod +x Breathless-*.AppImage
  ./Breathless-*.AppImage
  ```
  Or install the `.deb`: `sudo apt install ./Breathless-*.deb`.

## Which GPU is it using?

Each launch appends to `breathless.log`:

| OS | Log folder |
| --- | --- |
| Windows | `%APPDATA%\Breathless\logs\` |
| macOS | `~/Library/Logs/Breathless/` |
| Linux | `~/.config/Breathless/logs/` |

Look for the lines after the first page load (an example from a Windows laptop):

```
GPU active: NVIDIA (device 0x28a0, driver 31.0.15.5222) (2 adapters)
GPU renderer: ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11) (Google Inc. (NVIDIA))
```

followed by the full `getGPUInfo('basic')` and `getGPUFeatureStatus()`. If a Windows laptop still shows the integrated GPU (Intel, or AMD Radeon integrated graphics), set it by hand: **Settings → System → Display → Graphics**, add `Breathless.exe` and choose **High performance** (or in the NVIDIA Control Panel, Manage 3D settings → Program Settings).

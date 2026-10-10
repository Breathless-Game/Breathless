# HackRU26 · 屏息 Breathless 🫁

**English** · [简体中文](README.zh-CN.md)

> **Hold your real breath to dive and catch fish.** Your webcam, through Presage, detects whether you are holding your breath. The diver can only descend while you hold. The deeper you go, the rarer the fish. The moment you breathe underwater you have to race back to the surface, or you lose everything in your net. Fish you bring up can be minted as Solana NFTs and traded between players. The game also quietly records how long each hold lasted and your heart rate, and builds a health report whenever you ask for one.

Low-poly 2.5D, built with Three.js + TypeScript. Mostly front end, plus a local Node sensor service.

---

## Contents

1. [Overview](#1-overview)
2. [Quick start](#2-quick-start)
3. [Controls](#3-controls)
4. [Architecture](#4-architecture)
5. [Breath-hold detection](#5-breath-hold-detection)
6. [Code tour](#6-code-tour)
7. [Game design parameters](#7-game-design-parameters)
8. [Solana NFT](#8-solana-nft)
9. [Health report](#9-health-report)
10. [Local storage](#10-local-storage)
11. [Debugging tips](#11-debugging-tips)
12. [Status and to-do](#12-status-and-to-do)
13. [Working together](#13-working-together)
14. [Hackathon timeline](#14-hackathon-timeline)

---

## 1. Overview

### Core loop

```
On the surface ──hold breath──▶ dive ──Space: net fish──▶ deeper = rarer
   ▲                                                         │
   │                                          breathe underwater = OUT OF AIR
   │                                                         ▼
Surface = fish banked ◀── reach the surface within 3.2 s ────┤
                                                             └─ too late = BLACKOUT, every fish in the net is lost
```

- **Your breath is the air tank**: the game has no oxygen bar. Your lungs are the bar.
- **Greed against risk**: mythic fish only live in the Abyss (below 38 m), but the farther you are from the surface, the harder it is to get back after you breathe.
- **Night mode** (`N`): every fish rolls its rarity twice and keeps the higher result. The sea-monster risk is still on the to-do list.
- **Collection** (`C`): banked fish are rendered as 512×512 cards, and that card is the NFT image. The card is fully determined by the fish's seed, so anyone can render it again and check it.

### Three maps (designed, not built yet)

The game currently has one sea, which is the base for Map 3. Maps 1 and 2 and the map picker are still on the to-do list. The full design is in [section 6 of the design doc](design/game-design-document.md#6-地图) (in Chinese). Summary:

| | Map 1 · Norway / Iceland fjord | Map 2 · Zhangjiajie / Changbai Mountain Heaven Lake | Map 3 · Open ocean |
| --- | --- | --- | --- |
| Difficulty | Casual | Normal | Hard |
| Setting | A fjord between snowy mountains, with cabins and pine forest on the shore and aurora at night | A mountain lake ringed by stone pillars, with fog at dawn and at night | Open sea, with storm clouds in the distance |
| Time | Daytime 05:00–20:00; creatures appear after dark | Full day-night cycle | Full day-night cycle |
| Diving depth | 0–18 m, shallows only | 0–38 m, adds the second zone | 0–58 m, the only map that reaches the Abyss |
| Night creatures | Deer (only startles you), bear (if your heart is racing when you surface, it steals your most valuable fish) | Bear, giant (its stomp scatters the fish and pushes the diver toward the surface) | Waves, sea monster (patrols the Abyss; if it catches you, you lose your net) |
| Cost of failure | The fish in your net | The fish in your net, plus boat durability | When boat durability reaches zero the boat sinks and all gear is lost for good |
| Unlock | From the start | 150 total banked value | 1000 total banked value |

- **Fishing from the boat** (all three maps): while you are on the boat and not holding your breath, the rod casts by itself. The steadier your heart rate, the faster the bite. No breath-holding needed. It fills the rest time between two dives.
- **Upgrades**: rod, bait and boat (speed / durability / rod slots), plus a set of diving gear. See [section 7 of the design doc](design/game-design-document.md#7-经济与升级) (in Chinese).

### Hackathon positioning

| Item | Details |
| --- | --- |
| Track | Social Good (breath training / lung-health awareness); the final choice is made at submission |
| MLH prize targets | **Best Use of Presage** (breath-hold detection, heart rate) · **Best Use of Solana** (fish NFTs, trading) · possible later: ElevenLabs (sound effects / narration), Tiger Data (market and economy data), a .Tech domain |

### Multiplayer scope (important)

**Many players are online at once, but each one dives in their own separate world. Players only interact through trading.** There is no shared world and no real-time sync. Every "multiplayer" feature lives in the trading layer: wallet identity, listings, purchases, and a live feed of sales.

---

## 2. Quick start

### Requirements

- **Node.js 20+** (the dev machine runs v20.19.5)
- **macOS (Apple Silicon)** or **Windows**: the Presage Node SDK ships runtimes for `darwin-arm64`, `win32-x64` and `linux-x64/arm64`. Windows notes are under [Windows](#windows) below
- **Chrome** and a webcam (not needed for keyboard or simulation mode)

### Install and run

```bash
git clone https://github.com/LucasYanzy/HackRU26.git
cd HackRU26
npm run setup                 # installs dependencies for sensor/ and game/
cp .env.example .env          # then fill in PRESAGE_API_KEY (see below)
```

Open two terminals:

```bash
npm run sensor     # breath sensor service, ws://localhost:8787
```

```bash
npm run game       # the game, http://localhost:5173
```

(Or run `npm run dev` to start both at once. It works on macOS and Windows, and Ctrl+C stops both.)

### Windows

- **x64 machines**: follow the steps above as they are.
- **ARM machines (Snapdragon X and similar)**: the Presage SDK has no `win32-arm64` build, so ARM Node cannot load it. Use **x64 Node** instead; Windows 11 runs it under emulation:
  1. Download the x64 Node zip (for example `node-v24.x.x-win-x64.zip`) and unzip it anywhere.
  2. In every terminal, put it at the front of PATH before you run `npm run setup`, `npm run sensor` or `npm run game`:
     ```powershell
     $env:Path = "C:\path\to\node-v24.x.x-win-x64;$env:Path"
     node -p process.arch   # should print x64
     ```
  3. **Install and run with the same Node**: esbuild and rollup in `game/` are also installed per architecture. If you installed dependencies with ARM Node before, delete `sensor/node_modules` and `game/node_modules` and install again.

Open <http://localhost:5173>:

| Entry | What it does | Needs |
| --- | --- | --- |
| **Start with camera** | Real mode: webcam → Presage → breath-hold detection | The sensor running, and a Presage key |
| **Play with keyboard** | Hold `Shift` to hold your breath | Nothing |
| Simulation mode (press `K` in the game to switch) | The sensor generates a fake breathing waveform and heart rate; hold `Shift` to hold your breath | The sensor running; no key needed |

### Presage API key

- Get one at <https://physiology.presagetech.com/portal/dashboard>.
- Put it in `.env` at the repo root: `PRESAGE_API_KEY=...`
- **`.env` is in `.gitignore`. Never commit it.** Share the key with teammates privately; do not paste it into code, issues or PRs.
- With no key, the sensor switches to simulation mode by itself (`npm run sensor:sim` forces simulation).

### Testing breath detection on a real camera

Click **Start with camera**. Keep your face and chest in frame, in bright light.

1. Breathe normally for about 10 seconds so the detector learns how you breathe.
2. Then hold your breath. The label at the top left should turn green and read **HOLDING**, and the waveform goes flat.
3. As soon as you breathe, it switches back to **BREATHING**.

If it gets this wrong often, tune the constants in `sensor/breath-detector.mjs` (see section 5).

---

## 3. Controls

| Key | Action |
| --- | --- |
| `←` `→` `↑` `↓` / `WASD` | Swim (you cannot dive from the surface unless you are holding your breath) |
| `Space` | Swing the net to catch fish |
| `Shift` (hold) | Hold your breath (keyboard and simulation modes) |
| `C` | Collection and NFT panel |
| `H` | Health report (built only when you press it) |
| `N` | Toggle day / night |
| `K` | Cycle the breath input: presage → sim → keyboard |
| `Esc` | Pause menu: resume, settings, back to the main menu. It closes any open panel first; inside settings it goes back one level; during calibration it goes straight to the main menu |
| `Enter` (main menu) | Same as clicking the START fish |

**Main menu**: when it opens, a rope (both ends off-screen) swings out from the left and hooks onto the right, then a few fish drop from above and hang from the rope on fishing lines. The button names are printed on the fish's bodies. A fish with a long name (4+ characters) hangs level on two lines, at the head and the tail, and the two lines even out like a pulley so the name stays level even where the rope slopes. The golden **START** fish opens the start card (camera / keyboard / breath test), and the purple **SETTINGS** fish opens settings. You can drag and fling the fish and the rope with the mouse, and they are pushed aside when the pointer sweeps past them. The entrance animation is skipped when the system has "reduce motion" turned on.

**Pause details**: the game freezes completely while paused, and switching to another tab pauses it too. If you resume underwater, there is a 3-second countdown first so you can take a breath and hold it again; otherwise the breathing you did while paused would count as "breathing underwater". Going back to the main menu releases the camera and the sensor connection. If there are fish in your net, you are asked to confirm first: the fish are lost, but the hold still goes into your health data.

---

## 4. Architecture

```
┌──────────────────────── Browser (game/, Vite + Three.js) ────────────────────────┐
│                                                                                   │
│  getUserMedia 640×480 ──► BreathSource ──binary WS frames──┐                      │
│                             ▲   (breath.ts)                │                      │
│                             └── state JSON @ ~12.5 Hz ◄────┼──┐                   │
│                                                            │  │                   │
│  main.ts game loop ─► World / Diver / Fish / Hud           │  │                   │
│        │             HealthLog ─► Report (on demand)       │  │                   │
│        └─► Vault (collection) ─lazy import─► chain.ts ─────┼──┼──► Solana devnet  │
│                                                ▲           │  │    (Metaplex Core)│
│  localStorage: bank / health / wallet          └───────────┼──┼──► Irys devnet    │
└────────────────────────────────────────────────────────────┼──┼───(image + JSON)──┘
                                                             ▼  │
                         ┌────────── sensor/ (Node, :8787) ─────┴────┐
                         │  Session per WS connection                 │
                         │  SmartSpectraSDK.useCustomInput()          │
                         │    └─ sendFrame(RGBA) ─► Presage cloud     │
                         │  metrics ─► BreathDetector ─► state        │
                         └────────────────────────────────────────────┘
```

**Why does the browser open the camera, and not Node?** macOS does not grant camera permission to a node process started from an IDE or from Claude, so the SDK's `useCamera` never receives a frame. Instead the browser captures frames and pushes them to the sensor over WebSocket, and the sensor hands them to the SDK with `useCustomInput` + `sendFrame`.

### WebSocket protocol (`ws://<host>:8787`)

**Browser → sensor**

- **Binary frames**: a 12-byte header followed by RGBA pixels, all little-endian.
  | Offset | Type | Meaning |
  | --- | --- | --- |
  | 0 | f64 | Timestamp (ms, must keep increasing; the SDK restarts if the gap is over 2 s) |
  | 8 | u16 | Width (640) |
  | 10 | u16 | Height (480) |
  | 12… | u8[] | RGBA, width × height × 4 |
  - Backpressure: the browser skips frames when `ws.bufferedAmount` gets too large.
- **JSON commands**: `{ "t": "sim", "on": true }` turns simulation on or off; `{ "t": "simHold", "holding": true }` sets the simulated hold.

**Sensor → browser** (every 80 ms)

```jsonc
{
  "t": "state",
  "source": "presage" | "sim",
  "status": "running", "hint": "Move closer…",   // hint translated from the ValidationCode
  "rate":  { "value": 15, "confidence": 90 },     // breathing rate (needs a ~30 s window)
  "pulse": { "value": 72, "confidence": 90 },     // heart rate
  "frames": 1234,
  "holding": true, "holdMs": 8200, "calibrated": true,
  "flatness": 0.93, "apnea": false, "talking": false,
  "trace": [ /* the last 90 chest-movement samples */ ]
}
```

---

## 5. Breath-hold detection

File: `sensor/breath-detector.mjs`. The input is Presage's chest-movement trace, `breathing.upperTrace`.

**What real recordings told us** (2026-10-10, two 2.5-minute breath tests by the same person, 8 holds in total):

- For the first few seconds after Presage starts, the trace swings wildly (about 10 times the amplitude of normal breathing). The old detector used those seconds to learn the "normal breathing amplitude", so it called a hold right at the start and never left it: 44% accuracy, with normal breathing misread as a hold 86% of the time.
- The trace is high-pass filtered. During a hold it first jumps up with the last inhale, then takes about 3 seconds to settle back to flat. It does not stay high.
- Over 15-second holds, Presage's own apnea flag never fired once, so it is off by default.
- The signal itself separates well: the movement within 2 seconds of normal breathing is about 5–20 times the movement during a hold.
- **The trace glitches mid-hold.** In the second test the player stayed completely still and did not breathe, yet the trace jumped twice in the middle of a hold. Once it jumped up by about one breath's size, once it dipped a little. Activity alone can't tell these apart from breathing again, so the activity-only detector (v3) told the diver "you breathed" twice.
- **A real release always starts with an exhale.** All 8 releases begin with the trace dropping 1.55–3.5 × the baseline. The two glitches dropped about 1 × at most. Up is inhale, down is exhale.

**What the detector does now: holds are found by "activity"**, which is the distance the trace travels per second (path length). **Releases are found by the exhale.**

1. **Learn a baseline**: take the activity over the last 30 seconds of normal breathing and use the **median** as the baseline B, so an occasional spike does not affect it. Nothing is learned in the first 8 seconds after start. The first few seconds of a hold are dropped too, so they do not pull the baseline down.
2. **Call a hold**: the activity over the last 2 seconds is below `0.38 × B`.
3. **Call a release, mainly on the exhale**: the detector tracks a "hold level". It follows the slow settling after the inhale, but freezes while the trace jumps around, so a glitch can't drag it along. The hold ends when the trace drops more than `1.1 × B` below that level, and also below the highest point of the last 1.5 seconds, for 0.1 seconds. A jump up of more than `2 × B` also counts; that covers someone who held with empty lungs and breathes in first.
4. **In the first 2 seconds of a hold**, which may just be a pause between breaths, activity alone still ends it: the activity over 0.75 seconds is above `0.5 × B` for 0.2 seconds.
5. **Fallback**: activity over 2 seconds above `0.8 × B` for 4 seconds in a row always ends a hold, so it can never get stuck. Talking for more than 0.5 seconds also counts as a release.
6. **Right after a release**: no new hold is called for 2 seconds.
7. **Debounce on the game side** (`RELEASE_DEBOUNCE_MS` in `main.ts`): "breathing" underwater has to last 0.5 seconds before it counts.

Replaying both recordings:

| | v3 (activity only) | now (exhale) |
| --- | --- | --- |
| "You breathed" while still holding | 2 | **0** |
| Hold recognized (from the prompt) | median 2.9 s | median 2.8 s |
| Release recognized | about 1.0 s | median 1.6 s, worst 2.0 s |
| Normal breathing misread as a hold | 1.2% | 1.2% |

Releases are about 0.6 seconds slower. In return, a diver is never wrongly told they breathed. Any exhale threshold from 1.0 to 1.3 gives zero mid-hold releases; at 0.9 errors start, so 1.1 leaves margin on both sides. `--sweep` prefers 0.9 because it only sees these two recordings, and we don't trust it.

| Option | Default | Effect |
| --- | --- | --- |
| `activityWindowUs` | 2 s | Window for the hold test |
| `holdRatio` | 0.38 | Higher calls a hold more easily and earlier, with more false positives |
| `exhaleRatio` | 1.1 | How far (× B) the trace has to drop to count as an exhale. Lower releases faster, but small glitches mid-hold may count |
| `inhaleRatio` | 2.0 | How far (× B) a jump up has to go to count as breathing in first |
| `exhaleWindowUs` | 1.5 s | The drop has to happen within this window, which rules out the slow settling after a hold starts |
| `exhaleHoldUs` | 0.1 s | How long the exhale has to last |
| `quietRatio` / `levelTauUs` | 0.5 / 1 s | The hold level only follows the trace while it is quiet, and this fast |
| `trustAfterUs` | 2 s | For this long into a hold, activity alone ends it |
| `releaseWindowUs` / `releaseRatio` / `releaseHoldUs` | 0.75 s / 0.5 / 0.2 s | What "activity" means in the line above |
| `sustainedRatio` / `sustainedUs` | 0.8 / 4 s | Fallback: this much breathing for this long always ends a hold |
| `warmupUs` | 8 s | Ignores the seconds when Presage swings wildly at start-up |
| `minBaselineUs` | 6 s | How much normal breathing has to be learned before any hold is called |
| `useApnea` | false | Whether to use Presage's apnea flag |

Note: the thresholds have been checked against one person and two recordings only. **On a new person, run the breath test once to confirm them**, and check especially that "down is exhale" holds on their camera too. `analyze.mjs` prints `release reasons`; normally most should be `exhale`.

### Tuning with real data (record → analyze)

Do not change thresholds by feel. Record data first:

1. **Easiest: click "Breath test (2.5 min) · 憋气测试" on the title screen.** The screen prompts you on a fixed schedule: breathe normally for 30 seconds, then "get ready → hold for 15 seconds → breathe for 15 seconds", 4 rounds. Every second is labeled automatically, with no key to press. At the end it shows how many holds were detected, the average delay, and the share of normal breathing that was misread.
   You can also simply play in camera mode: **hold `Shift` every time you really hold your breath**, and let go when you breathe. The top left of the HUD shows "⏺ marking your hold". That is the ground truth.
2. The sensor writes the whole session to `sensor/recordings/<time>.jsonl`: the raw chest and abdomen traces, apnea, talking, heart rate, frame rate, your Shift labels, and the calibration phase. **This is physiological data. It is gitignored; do not commit it.**
3. Analyze:

```bash
node sensor/analyze.mjs
```

It prints:

- the webcam frame rate, and the interval and latency of the Presage data batches;
- the amplitude ratio between "breathing" and "holding" for the chest and abdomen traces (a larger ratio is easier to separate);
- whether the trace drifts during a hold;
- how the current detector compares with your labels: agreement, false-positive rate, flips per minute, detection delay.

```bash
node sensor/analyze.mjs --sweep
```

Grid-searches `holdRatio` / `exhaleRatio` / `exhaleWindowUs` / `trustAfterUs` and lists the best few combinations. Telling a diver they breathed while still holding costs the most.

```bash
node sensor/analyze.mjs --trace=lo --exhaleRatio=1.3
```

Replays with the abdomen trace, or with a specific set of parameters.

Note: Presage's breathing rate needs a window of about 30 s and is not available while you talk. All metrics are for wellness reference only, not for medical use.

---

## 6. Code tour

```
.
├── package.json            root scripts: setup / sensor / game / dev
├── scripts/dev.mjs         npm run dev: starts sensor and game together (cross-platform)
├── .env.example            PRESAGE_API_KEY, SENSOR_PORT
├── intro/HackRU26.md       hackathon intro and timeline (Chinese and English)
├── design/game-design-document.md  design doc (Chinese): three maps, creatures, upgrades, improvements
├── sensor/                 Node breath sensor service
│   ├── index.mjs           WS server, one Session per connection, Presage SDK, simulator (with fake heart rate)
│   ├── breath-detector.mjs breath-hold detection (section 5)
│   ├── recorder.mjs        records camera sessions as JSONL (sensor/recordings/, gitignored)
│   └── analyze.mjs         replays recordings, compares with the Shift labels, grid-searches thresholds
└── game/                   Vite + TypeScript + Three.js
    ├── index.html          DOM for the HUD, title card, collection panel and report panel
    ├── vite.config.ts      port 5173; Node polyfills (needed by Umi and Irys)
    ├── tests/              node --test: unit tests for automatic render quality
    └── src/
        ├── main.ts         entry: scene, phase machine (menu/calibrating/play/blackout), main loop, input, banking
        ├── breath.ts       BreathSource: captures and pushes camera frames, WS state, keyboard/sim modes
        ├── breathtest.ts   the 2.5-minute breath test on the title screen: prompts holds and breathing, labels them automatically
        ├── world.ts        seabed, rocks, coral, kelp, light rays, snow, water surface, boat; fog and color by depth; day and night
        ├── diver.ts        low-poly diver, kicking, net, headlamp, bubbles
        ├── gear.ts         the net model that stands in for the fishing rod: grip, reel, shaft, hoop and mesh
        ├── fish.ts         rarity table, drop rates per zone, species names, rollFish(seed), fish meshes, swim and flee AI
        ├── rng.ts          mulberry32 seeded random numbers
        ├── portrait.ts     offscreen rendering: fishIcon (192 px) and fishCard (512 px, the NFT card)
        ├── hud.ts          breath panel and waveform, depth gauge, emergency bar, net slots, banked count, toasts
        ├── vault.ts        collection panel, wallet bar, Mint button (lazy-loads chain.ts)
        ├── chain.ts        Umi, throwaway wallet, airdrop, mintFish, burnFish
        ├── polyfills.ts    Buffer and global
        ├── health.ts       HealthLog: hold time, heart rate and recovery time for every dive
        ├── report.ts       health report: metric tiles, two charts, interpretation text, save as PDF, delete data
        ├── pause.ts        Esc pause menu: resume (3-second countdown underwater), settings, back to the main menu
        ├── title.ts        main menu: a Verlet rope with fish hanging on fishing lines, mouse dragging and pushing; the START / SETTINGS fish are the buttons
        ├── settings.ts     player settings (render quality, camera preview, control hints), stored in localStorage
        ├── render-quality.ts  automatic render quality: picks a starting level from the device, steps down on sustained low frame rate
        └── style.css       dark glass-style HUD
```

---

## 7. Game design parameters

### Depth zones and drop rates (`ZONES` in `fish.ts`)

| Zone | Depth | common | uncommon | rare | epic | legendary | mythic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shallows | 0–18 m | 70 | 25 | 5 | – | – | – |
| Coral Reef | 18–38 m | 20 | 35 | 30 | 13 | 2 | – |
| The Abyss | 38–58 m | – | 10 | 30 | 35 | 19 | 6 |

### Rarity (`RARITY`)

| Rarity | Color | value |
| --- | --- | --- |
| common | `#b8c4cc` | 1 |
| uncommon | `#5fd38d` | 3 |
| rare | `#4aa8ff` | 10 |
| epic | `#b46cff` | 35 |
| legendary | `#ffb340` | 150 |
| mythic | `#ff5fd2` | 800 |

The rarer the fish, the faster it swims, the more easily it flees, and the brighter it glows. Mythic fish cycle through colors.

### Main loop constants (`main.ts`)

`SWIM_ACCEL 24` · `DRAG 2.4` · `MAX_SPEED 7.5` · `SURFACE_DEPTH 0.9` · `EMERGENCY_SECONDS 3.2` (time left after you breathe) · `EMERGENCY_LIFT 18` (strength of the emergency ascent) · `NET_CAPACITY 6` · `CATCH_RADIUS 2.4` · `FISH_PER_ZONE [16, 16, 12]`

---

## 8. Solana NFT

**Everything runs on devnet, and all of the code is in the browser (`game/src/chain.ts`).**

- **Wallet**: the first time you open the collection panel, a throwaway keypair is generated and stored in `localStorage['deepbreath.wallet']`. It is a devnet-only test wallet and its private key sits in the browser, so **never put mainnet assets in it**.
- **Funding**: the panel has an "Airdrop 1 SOL" button, but the public devnet faucet often answers with a 429 rate limit. It is more reliable to go to <https://faucet.solana.com> (GitHub login) and request SOL for the address shown in the panel.
- **Mint flow** (`mintFish`):
  1. `fishCard(spec)` renders a PNG, which `umi.uploader.upload` uploads to Irys devnet.
  2. `uploadJson` uploads the metadata: name, symbol `DIVE`, description, image, attributes (Rarity / Species / Zone / Depth / Length / Weight / Seed).
  3. mpl-core's `create` mints a Core asset with an on-chain **Attributes plugin** (rarity / species / depth / seed), so later game logic can read the rarity straight from the chain.
  4. The asset address is written back to `FishSpec.assetId` and saved in the bank. The card shows "✓ On-chain" and links to Solana Explorer.
- **Burn** (NFT sink): `burnFish(assetId)` is written but not connected to the UI yet. It is meant for the gear economy.
- **Optional environment variable**: `VITE_SOLANA_RPC` (defaults to `https://api.devnet.solana.com`). Every `VITE_*` variable is bundled into the front end, so **never put a secret in one**.
- **Why Vite needs polyfills**: Umi and Irys depend on Node's `Buffer`, `stream` and `crypto`, so `vite.config.ts` uses `vite-plugin-node-polyfills`.

---

## 9. Health report

**Data is recorded quietly in the background. The report is built only when the player presses `H` or clicks "♥ Health report". It never opens by itself.**

`HealthLog` (`health.ts`) stores one `DiveRecord` per dive:

| Field | Meaning |
| --- | --- |
| `holdMs` | The longest continuous hold in this dive |
| `durationMs` / `maxDepth` | Time underwater, maximum depth |
| `outcome` / `fish` | `banked` / `surfaced` / `blackout`, and the number of fish |
| `restPulse` / `restRate` | Median heart rate over the 30 s before the dive, and breathing rate |
| `pulse` | Heart-rate curve underwater, `[seconds, bpm]`, about 1 Hz |
| `minPulse` / `peakPulse` | Lowest and highest heart rate underwater |
| `recoveryS` | Time after surfacing until heart rate is back within ±6 bpm of resting and stays there for 5 s |

The report (`report.ts`) contains:

- 8 metric tiles: longest hold, average hold with its trend, resting heart rate, dive reflex (how far heart rate drops during a hold), recovery time, breathing rate, total time underwater, deepest dive.
- Two charts: a bar chart of the hold time of every dive, and the heart-rate curve of the longest dive with the resting baseline, which shows the dive reflex directly.
- Automatically written interpretation text, and a disclaimer.
- "Save PDF" (the print stylesheet outputs the report only) and "Delete my health data".

Privacy: the data stays in the browser on this machine. Disclaimer: for wellness reference only, not medical advice. Do not practice breath-holding in or near water.

> In simulation mode the heart rate is fake: about 72 bpm at rest, dropping to about 58 during a hold, then jumping to about 86 after a release before it settles. It is there to demo the report without a camera.

---

## 10. Local storage

| key | Contents |
| --- | --- |
| `deepbreath.bank` | Banked fish (`FishSpec[]`, with an `assetId` once minted) |
| `deepbreath.health` | Dive records (`DiveRecord[]`, 300 at most) |
| `deepbreath.wallet` | Private key of the devnet throwaway wallet (an array of numbers) |
| `deepbreath.settings` | Player settings: `quality` (auto / high / medium / low), `showCamera`, `showHelp` |

To reset, run `localStorage.clear()` in the browser console.

---

## 11. Debugging tips

- The dev server **does not type-check**. Before opening a PR, run `npm --prefix game run build` (it runs `tsc --noEmit` first).
- These globals are available in the console: `breath`, `diver`, `fishes`, `keys`, `debugStep(seconds)`.
- When the tab is in the background, `requestAnimationFrame` drops to about 2 fps. `debugStep(2)` simulates 2 seconds directly.
- The sensor logs are in the terminal that runs `npm run sensor`. Presage status codes and ValidationCode hints are translated into the yellow hint at the top left of the HUD.
- Presage stuck on `starting`: check the key in `.env`, check that the browser is really sending frames (the frames counter in the HUD), and check that there is enough light.

### Automatic render quality

Settings → Render quality in the pause menu defaults to Auto. You can also pick high, medium or low yourself, and the choice is saved; a level you picked is never lowered automatically. Existing manual settings keep working. Frame rate is not sampled while the game is paused, and toggling the camera preview or the control hints does not reset the level Auto has already dropped to.

The game picks the starting quality from the CPU logical core count and the device-memory hint the browser provides: low at 4 cores or fewer, or 4 GB or less; high with at least 8 cores and a memory hint of 8 GB or more (or no memory hint from the browser); medium otherwise. These hints do not describe GPU performance accurately, so the game also checks the real frame intervals while it runs.

| Setting | Low | Medium | High |
| --- | --- | --- | --- |
| DPR cap | 1 | 1.5 | 2 |
| Render pixel budget | 1280 × 720 | 1920 × 1080 | 3840 × 2160 |
| Kelp / light rays / particles | 12 / 4 / 300 | 30 / 8 / 700 | 55 / 14 / 1400 |
| Water surface segments | 30 × 8 | 60 × 16 | 90 × 24 |
| Decoration animation update cap | 20 Hz | 30 Hz | 60 Hz |

A large screen may use a DPR below 1 to stay within the pixel budget; the HUD still uses the browser's native resolution. After a start-up grace period, two consecutive 3-second windows that average below 45 FPS lower the quality by one level. A drop is followed by a 6-second cooldown, and within one session the quality only goes down, never up. Hidden tabs and isolated long stalls are not counted, but a sustained very low frame rate still triggers a drop.

Antialiasing is off when the game starts at low. A drop during play keeps the antialiasing setting the WebGL context was created with, so the context does not have to be rebuilt in the middle of a game. Throttling the decorations does not change the per-frame updates of the diver, fish, breath and lighting; the headlamp, day and night, fog color and NFT card resolution are kept. Light rays that cannot be seen at night or in deep water are not rendered at all, and hidden kelp is removed from the scene to avoid matrix updates.

- `npm --prefix game test`: tests for the quality levels, pixel budget, sustained stutter, recovery from the background, and the drop cooldown.
- In the console, look at `renderQuality.level` and `renderQuality.settings` to confirm the current level and budget.

---

## 12. Status and to-do

### ✅ Done

- Low-poly 2.5D underwater world, diver, procedurally generated fish (6 rarities, 3 depth zones)
- Diving only while you hold your breath, emergency ascent after breathing underwater, blackout that loses the fish, banking on surfacing
- Presage pipeline: browser captures frames → sensor → SDK → breath-hold detection; keyboard and simulation as fallbacks
- NFT card art (determined by the seed, reproducible), collection panel
- Solana minting: verified end to end on devnet (throwaway wallet → Irys upload of image and metadata → Metaplex Core + on-chain Attributes). Solana Explorer shows the card correctly. [Example asset](https://explorer.solana.com/address/GHBBzZ7UTJPKVXWM5bryTsyM14x4Bv23MoQsfTN5tt13?cluster=devnet)
- Health report (built on demand)

### 🔜 To do (say so in a PR or the group chat when you pick one up)

- [ ] **Test Presage breath detection on real cameras** and tune the thresholds (section 5)
- [ ] **Official game Collection**: every fish is a standalone asset right now, so Explorer shows Verified Collection as None. We need a Collection whose authority is held by a server, and to mint fish into it, so marketplaces can filter by Collection and fakes are prevented
- [ ] **Gear economy**: buy air tanks, fins, a headlamp and a bigger net with SOL or Pearl (an SPL token); gear has durability
- [ ] **NFT sinks**: sell to the market for Pearl, craft bait or items from fish, sacrifice fish to the sea monster, evolve them, redeem complete sets. `burnFish` is already written
- [ ] **Night sea monster**: high-value fish appear at night, together with the sea-monster risk
- [ ] **Three maps**: one config per map (sky and water colors, shoreline models, maximum depth, creature table), and a map picker on the main screen. The design is in section 6 of the design doc
- [ ] **Boat fishing and heart-rate gameplay**: the calm value sets the bite speed and how far away underwater fish notice you; rod, bait and boat upgrades. The design is in sections 4.2, 6.3 and 7 of the design doc
- [ ] **Marketplace (the core of multiplayer)**: listings, purchases, a live feed of sales; players stay in separate worlds and interact only through trading
- [ ] **Backend**: a service for listings and sales, plus a dashboard for economy and fairness data (Tiger Data / Timescale)
- [ ] **Deployment**: the sensor runs one Presage session per connection, so concurrent players need thought; `.tech` domain
- [ ] **ElevenLabs**: voice or sound effects when air runs low and when a rare fish appears
- [ ] **Devpost** copy, screenshots, demo video

---

## 13. Working together

- **Branches**: `feat/xxx`, `fix/xxx`, `docs/xxx`, merged into `main` through PRs. Do not push to `main` directly.
- **Before a PR**: `npm --prefix game run build` must pass (strict TS, with `noUnused` on).
- **Secrets**: `.env`, private keys and API keys never go into the repo. Add new environment variables to `.env.example` as well (names only, no values).
- **Style**: TypeScript strict; low-poly + flat shading; color variables live in `:root` in `style.css`; comments explain only the "why".
- **Changing parameters**: gameplay constants live at the top of `main.ts` and in `RARITY` / `ZONES` in `fish.ts`. Mention any change in the PR.
- **Two READMEs**: `README.md` (English) and `README.zh-CN.md` (中文). When you change one, change the other in the same PR.

---

## 14. Hackathon timeline

Full details are in [`intro/HackRU26.md`](intro/HackRU26.md).

- Hacking: starts Saturday 10/10 at 12:00
- **Submission deadline: go by the Devpost page. Devpost shows Sunday 10:00 AM, which is earlier than the 12:00 on the official site. Use the earlier one.**
- Judging: starts Sunday 10/11 at 13:00. **The whole team has to be there**

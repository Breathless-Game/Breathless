# HackRU26 · Deep Breath 🫁

> **用你真实的憋气来潜水抓鱼。** 摄像头通过 Presage 识别你是否在憋气，憋住气潜水员才能下潜；越深鱼越稀有；在水下一换气就必须马上浮上去，否则网里的鱼全丢。抓到的鱼可以铸造成 Solana NFT，玩家之间交易。游戏还会安静地记录每次憋气的时长和心率，你想看的时候一键生成健康报告。

低多边形（low-poly）2.5D 风格，Three.js + TypeScript，前端为主，加一个本地 Node 传感器服务。

---

## 目录

1. [项目概览](#1-项目概览)
2. [快速开始](#2-快速开始)
3. [操作方式](#3-操作方式)
4. [架构](#4-架构)
5. [憋气检测算法](#5-憋气检测算法)
6. [代码导读](#6-代码导读)
7. [游戏设计参数](#7-游戏设计参数)
8. [Solana NFT](#8-solana-nft)
9. [健康报告](#9-健康报告)
10. [本地存储](#10-本地存储)
11. [调试技巧](#11-调试技巧)
12. [当前状态与待办](#12-当前状态与待办)
13. [协作约定](#13-协作约定)
14. [比赛时间线](#14-比赛时间线)

---

## 1. 项目概览

### 核心循环

```
在水面 ──憋气──▶ 下潜 ──Space 抓鱼──▶ 越深越稀有
   ▲                                      │
   │                       水下换气 = OUT OF AIR
   │                                      ▼
 浮出水面 = 鱼入库 ◀── 3.2 秒内冲上水面 ──┤
                                          └─ 来不及 = BLACKOUT，网里的鱼全部丢失
```

- **憋气就是氧气瓶**：游戏没有氧气条，你的肺就是。
- **贪心与风险**：深渊（38 m 以下）才有神话级鱼，但离水面越远，换气后越难赶回去。
- **夜晚模式**（`N`）：每条鱼稀有度掷两次取高的。海怪风险还在待办里。
- **收藏**（`C`）：入库的鱼会渲染成 512×512 的卡牌图，就是 NFT 的图片。卡图完全由鱼的 seed 决定，任何人都能重新渲染并核对。

### 比赛定位

| 项 | 内容 |
| --- | --- |
| 赛道 | Social Good（呼吸训练 / 肺部健康意识），最终以提交时为准 |
| MLH 奖项目标 | **Best Use of Presage**（憋气检测、心率）· **Best Use of Solana**（鱼 NFT、交易）· 后续可加 ElevenLabs（音效/旁白）、Tiger Data（市场与经济数据）、.Tech 域名 |

### 多人范围（重要）

**多人同时在线，但每个人在自己独立的世界里潜水，玩家之间只通过交易互动。** 不做共享世界，也不做实时同步联机。所有"多人"功能都在交易层：钱包身份、挂单、购买、成交动态。

---

## 2. 快速开始

### 环境要求

- **Node.js 20+**（开发机是 v20.19.5）
- **macOS（Apple Silicon）**：Presage Node SDK 目前只在这个平台上测过
- **Chrome**，以及一个摄像头（用键盘或模拟模式的话不需要）

### 安装与运行

```bash
git clone https://github.com/LucasYanzy/HackRU26.git
cd HackRU26
npm run setup                 # 分别安装 sensor/ 和 game/ 的依赖
cp .env.example .env          # 然后填入 PRESAGE_API_KEY（见下）
```

开两个终端：

```bash
npm run sensor     # 憋气传感器服务，ws://localhost:8787
```

```bash
npm run game       # 游戏，http://localhost:5173
```

（也可以用 `npm run dev` 同时启动两个。）

打开 <http://localhost:5173>：

| 入口 | 说明 | 需要 |
| --- | --- | --- |
| **Start with camera** | 真实模式：摄像头 → Presage → 憋气检测 | sensor 正在运行，并且有 Presage key |
| **Play with keyboard** | 按住 `Shift` 代表憋气 | 什么都不需要 |
| 模拟模式（游戏里按 `K` 切换） | 由 sensor 生成假的呼吸波形和心率，按 `Shift` 代表憋气 | sensor 正在运行，不需要 key |

### Presage API key

- 在 <https://physiology.presagetech.com/portal/dashboard> 申请。
- 填到根目录的 `.env`：`PRESAGE_API_KEY=...`
- **`.env` 已经加进 `.gitignore`，绝对不要提交。** 队友之间请私下传 key，不要贴进代码、issue 或 PR。
- 没有 key 时 sensor 会自动进入模拟模式（`npm run sensor:sim` 是强制模拟）。

### 真机测试憋气

点 **Start with camera**，脸和胸口都要在画面里，光线要亮。

1. 先正常呼吸约 10 秒，让检测器学会你的呼吸幅度。
2. 然后憋气。左上角的标签应该变成绿色 **HOLDING**，波形会变平。
3. 一换气就会变回 **BREATHING**。

如果误判多，去调 `sensor/breath-detector.mjs` 里的常数（见第 5 节）。

---

## 3. 操作方式

| 键 | 作用 |
| --- | --- |
| `←` `→` `↑` `↓` / `WASD` | 游泳（在水面不憋气时不能下潜） |
| `Space` | 挥网抓鱼 |
| `Shift`（按住） | 憋气（键盘模式和模拟模式） |
| `C` | 收藏和 NFT 面板 |
| `H` | 健康报告（只在你按的时候生成） |
| `N` | 切换白天 / 夜晚 |
| `K` | 切换呼吸输入：presage → sim → keyboard |

---

## 4. 架构

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

**为什么摄像头由浏览器打开，而不是 Node？** macOS 不会给从 IDE 或 Claude 启动的 node 进程摄像头权限，SDK 的 `useCamera` 一直收不到帧。所以浏览器抓帧，经 WebSocket 推给 sensor，sensor 再用 `useCustomInput` + `sendFrame` 交给 SDK。

### WebSocket 协议（`ws://<host>:8787`）

**浏览器 → sensor**

- **二进制帧**：12 字节头 + RGBA 像素，全部小端序。
  | 偏移 | 类型 | 含义 |
  | --- | --- | --- |
  | 0 | f64 | 时间戳（ms，必须单调递增；间隔超过 2 s 时 SDK 会重启） |
  | 8 | u16 | 宽（640） |
  | 10 | u16 | 高（480） |
  | 12… | u8[] | RGBA，宽 × 高 × 4 |
  - 背压：浏览器在 `ws.bufferedAmount` 过大时跳过帧。
- **JSON 命令**：`{ "t": "sim", "on": true }` 开关模拟；`{ "t": "simHold", "holding": true }` 设置模拟憋气。

**sensor → 浏览器**（每 80 ms 一次）

```jsonc
{
  "t": "state",
  "source": "presage" | "sim",
  "status": "running", "hint": "Move closer…",   // ValidationCode 翻译后的提示
  "rate":  { "value": 15, "confidence": 90 },     // 呼吸频率（需要约 30 s 窗口）
  "pulse": { "value": 72, "confidence": 90 },     // 心率
  "frames": 1234,
  "holding": true, "holdMs": 8200, "calibrated": true,
  "flatness": 0.93, "apnea": false, "talking": false,
  "trace": [ /* 最近 90 个胸部起伏采样 */ ]
}
```

---

## 5. 憋气检测算法

文件：`sensor/breath-detector.mjs`。数据来自 Presage 的胸部起伏曲线 `breathing.upperTrace`，再配合 `apnea` 和 `face.talking`。

1. **基线幅度**：最近 4 s 窗口的峰峰值（p2p），只在正常呼吸时更新，代表"一口正常呼吸"的幅度。
2. **判定憋气**：最近 1.3 s 窗口的 p2p 小于 `0.22 × 基线`，或者 Presage 报告 apnea，而且没有在说话。
3. **判定恢复呼吸**：曲线偏离憋气开始时的参考值超过 `0.4 × 基线`，或者检测到说话。

| 常数 | 默认值 | 调大 / 调小的效果 |
| --- | --- | --- |
| `HOLD_WINDOW_US` | 1.3 s | 越大越不容易误判为憋气，但进入 HOLDING 越慢 |
| `AMP_WINDOW_US` | 4 s | 学习正常呼吸幅度用的窗口 |
| `FLAT_RATIO` | 0.22 | 越大越容易判为憋气 |
| `RELEASE_RATIO` | 0.4 | 越小越灵敏，稍微一动就判定为换气 |
| `MIN_SAMPLES` | 8 | 窗口内最少需要的采样数 |

注意：Presage 的呼吸频率需要约 30 s 窗口，说话时不可用；所有指标都只用于健康参考（wellness），不是医疗用途。

---

## 6. 代码导读

```
.
├── package.json            根目录脚本：setup / sensor / game / dev
├── .env.example            PRESAGE_API_KEY、SENSOR_PORT
├── intro/HackRU26.md       比赛介绍和时间线（中英双语）
├── sensor/                 Node 憋气传感器服务
│   ├── index.mjs           WS 服务、每个连接一个 Session、Presage SDK、模拟器（含模拟心率）
│   └── breath-detector.mjs 憋气检测（第 5 节）
└── game/                   Vite + TypeScript + Three.js
    ├── index.html          HUD、标题卡、收藏面板、报告面板的 DOM
    ├── vite.config.ts      端口 5173；Node polyfills（Umi 和 Irys 需要）
    └── src/
        ├── main.ts         入口：场景、阶段机（menu/calibrating/play/blackout）、主循环、输入、入库
        ├── breath.ts       BreathSource：摄像头抓帧推送、WS 状态、键盘/模拟模式
        ├── world.ts        海底、礁石、珊瑚、海带、光束、雪、水面、船；按深度变化雾和颜色；昼夜
        ├── diver.ts        低多边形潜水员、踢腿、网、头灯、气泡
        ├── fish.ts         稀有度表、区域掉率、物种名、rollFish(seed)、鱼的网格、游动和逃跑 AI
        ├── rng.ts          mulberry32 种子随机数
        ├── portrait.ts     离屏渲染：fishIcon（192 px）和 fishCard（512 px，NFT 卡图）
        ├── hud.ts          呼吸面板和波形、深度计、紧急条、网格槽、入库数、toast
        ├── vault.ts        收藏面板、钱包栏、Mint 按钮（懒加载 chain.ts）
        ├── chain.ts        Umi、临时钱包、空投、mintFish、burnFish
        ├── polyfills.ts    Buffer 和 global 全局变量
        ├── health.ts       HealthLog：每次潜水记录憋气时长、心率、恢复时间
        ├── report.ts       健康报告：指标卡、两张图、解读文字、存 PDF、删除数据
        └── style.css       深色玻璃风 HUD
```

---

## 7. 游戏设计参数

### 深度分区与掉率（`fish.ts` 中的 `ZONES`）

| 区域 | 深度 | common | uncommon | rare | epic | legendary | mythic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shallows | 0–18 m | 70 | 25 | 5 | – | – | – |
| Coral Reef | 18–38 m | 20 | 35 | 30 | 13 | 2 | – |
| The Abyss | 38–58 m | – | 10 | 30 | 35 | 19 | 6 |

### 稀有度（`RARITY`）

| 稀有度 | 颜色 | value |
| --- | --- | --- |
| common | `#b8c4cc` | 1 |
| uncommon | `#5fd38d` | 3 |
| rare | `#4aa8ff` | 10 |
| epic | `#b46cff` | 35 |
| legendary | `#ffb340` | 150 |
| mythic | `#ff5fd2` | 800 |

稀有度越高，鱼游得越快、越容易逃跑、发光越强。神话鱼会循环变色。

### 主循环常数（`main.ts`）

`SWIM_ACCEL 24` · `DRAG 2.4` · `MAX_SPEED 7.5` · `SURFACE_DEPTH 0.9` · `EMERGENCY_SECONDS 3.2`（换气后的剩余时间）· `EMERGENCY_LIFT 18`（紧急上浮力度）· `NET_CAPACITY 6` · `CATCH_RADIUS 2.4` · `FISH_PER_ZONE [16, 16, 12]`

---

## 8. Solana NFT

**全部跑在 devnet，代码都在浏览器里（`game/src/chain.ts`）。**

- **钱包**：第一次打开收藏面板时，自动生成一个临时 keypair，存在 `localStorage['deepbreath.wallet']`。这是 devnet 专用的测试钱包，私钥就在浏览器里，**不要往里放任何主网资产**。
- **充值**：面板上有 "Airdrop 1 SOL" 按钮，但公共 devnet 水龙头经常 429 限流。更可靠的办法是去 <https://faucet.solana.com>（GitHub 登录）给面板上显示的地址领币。
- **铸造流程**（`mintFish`）：
  1. `fishCard(spec)` 生成 PNG，用 `umi.uploader.upload` 传到 Irys devnet。
  2. 用 `uploadJson` 上传元数据：name、symbol `DIVE`、description、image、attributes（Rarity / Species / Zone / Depth / Length / Weight / Seed）。
  3. 用 mpl-core 的 `create` 铸造 Core asset，同时挂一个链上 **Attributes 插件**（rarity / species / depth / seed），方便以后的游戏逻辑直接在链上读稀有度。
  4. 资产地址写回 `FishSpec.assetId`，持久化到 bank。卡片会显示 "✓ On-chain"，链接到 Solana Explorer。
- **销毁**（NFT 消耗）：`burnFish(assetId)` 已经写好，UI 还没接，会用在装备经济里。
- **可选环境变量**：`VITE_SOLANA_RPC`（默认是 `https://api.devnet.solana.com`）。注意：所有 `VITE_*` 变量都会打包进前端，**不能放密钥**。
- **为什么 Vite 要加 polyfill**：Umi 和 Irys 依赖 Node 的 `Buffer`、`stream`、`crypto`，所以 `vite.config.ts` 用了 `vite-plugin-node-polyfills`。

---

## 9. 健康报告

**数据在后台安静地记录，只有用户按 `H` 或点 "♥ Health report" 时才生成报告，不会自动弹出。**

`HealthLog`（`health.ts`）每次潜水记一条 `DiveRecord`：

| 字段 | 含义 |
| --- | --- |
| `holdMs` | 这次潜水中最长的一段连续憋气 |
| `durationMs` / `maxDepth` | 水下时长、最大深度 |
| `outcome` / `fish` | `banked` / `surfaced` / `blackout`，以及鱼的数量 |
| `restPulse` / `restRate` | 下潜前 30 s 的心率中位数，以及呼吸频率 |
| `pulse` | 水下心率曲线，`[秒, bpm]`，约 1 Hz |
| `minPulse` / `peakPulse` | 水下心率的最低值和最高值 |
| `recoveryS` | 出水后心率回到静息值 ±6 bpm 以内、并稳定 5 s 所用的时间 |

报告（`report.ts`）包括：

- 8 个指标卡：最长憋气、平均憋气及趋势、静息心率、潜水反射（憋气时心率下降多少）、恢复时间、呼吸频率、总水下时间、最深深度。
- 两张图：每次潜水的憋气时长柱状图；最长那次潜水的心率曲线，带静息基线，能直接看出潜水反射。
- 自动生成的解读文字、免责声明。
- "Save PDF"（打印样式只输出报告）和 "Delete my health data"。

隐私：数据只存在本机浏览器里。免责声明：只供健康参考，不是医疗建议；不要在水中或水边练习憋气。

> 模拟模式下的心率是假的：静息约 72 bpm，憋气时降到约 58，换气后先冲到约 86 再回落。用来在没有摄像头时演示报告。

---

## 10. 本地存储

| key | 内容 |
| --- | --- |
| `deepbreath.bank` | 入库的鱼（`FishSpec[]`，铸造后带 `assetId`） |
| `deepbreath.health` | 潜水记录（`DiveRecord[]`，最多 300 条） |
| `deepbreath.wallet` | devnet 临时钱包的私钥（数字数组） |

重置：在浏览器控制台执行 `localStorage.clear()`。

---

## 11. 调试技巧

- 开发服务器**不做类型检查**。提 PR 前请跑：`npm --prefix game run build`（会先执行 `tsc --noEmit`）。
- 控制台能直接用这些全局对象：`breath`、`diver`、`fishes`、`keys`、`debugStep(seconds)`。
- 标签页在后台时 `requestAnimationFrame` 会降到约 2 fps，可以用 `debugStep(2)` 直接模拟 2 秒。
- sensor 的日志直接看运行 `npm run sensor` 的那个终端。Presage 的状态码和 ValidationCode 提示会翻译成 HUD 左上角的黄色 hint。
- Presage 一直卡在 `starting`：检查 `.env` 里的 key，看浏览器是否真的在发帧（HUD 的 frames 计数），以及光线够不够。

---

## 12. 当前状态与待办

### ✅ 已完成

- 低多边形 2.5D 海底世界、潜水员、程序化生成的鱼（6 档稀有度、3 个深度区）
- 憋气才能下潜、水下换气后紧急上浮、黑屏丢鱼、出水入库
- Presage 管线：浏览器抓帧 → sensor → SDK → 憋气检测；键盘和模拟两种兜底
- NFT 卡图（由 seed 决定、可复现）、收藏面板
- Solana 铸造代码（临时钱包、Irys、Metaplex Core + Attributes）
- 健康报告（按需生成）

### 🔜 待办（认领时在 PR 或群里说一声）

- [ ] **真机测试 Presage 憋气检测**，并调阈值（第 5 节）
- [ ] **端到端验证 NFT 铸造**：需要先给钱包充 devnet SOL，再在 Explorer 里确认图片能正常显示（另外要确认 Irys devnet 的 gateway URL 能访问）
- [ ] **装备经济**：用 SOL 或 Pearl（SPL token）购买氧气瓶、脚蹼、头灯、更大的网；装备有耐久度
- [ ] **NFT 消耗（sink）**：卖给市场换 Pearl、用鱼合成鱼饵或道具、献祭给海怪、进化、集齐套装兑换。`burnFish` 已经写好
- [ ] **夜晚海怪**：夜里高价值鱼出现，同时有海怪风险
- [ ] **交易市场（多人的核心）**：挂单、购买、实时成交动态；玩家各自独立世界，只通过交易互动
- [ ] **后端**：挂单和成交服务，以及经济和公平性数据面板（Tiger Data / Timescale）
- [ ] **部署**：sensor 每个连接一个 Presage session，要考虑多人并发；`.tech` 域名
- [ ] **ElevenLabs**：氧气告急、稀有鱼出现时的语音或音效
- [ ] **Devpost** 文案、截图、demo 视频

---

## 13. 协作约定

- **分支**：`feat/xxx`、`fix/xxx`、`docs/xxx`，通过 PR 合进 `main`，不要直接推 `main`。
- **提 PR 前**：`npm --prefix game run build` 必须通过（strict TS，`noUnused` 已开启）。
- **秘密**：`.env`、私钥、任何 API key 都不要进仓库。新的环境变量要同步加到 `.env.example`（只写变量名，不写值）。
- **风格**：TypeScript strict；低多边形 + flat shading；颜色变量在 `style.css` 的 `:root`；注释只解释"为什么"。
- **改参数**：玩法常数集中在 `main.ts` 顶部和 `fish.ts` 的 `RARITY` / `ZONES`，改了请在 PR 里说明。

---

## 14. 比赛时间线

完整内容见 [`intro/HackRU26.md`](intro/HackRU26.md)。

- 开发：10/10（周六）12:00 开始
- **提交截止：以 Devpost 页面为准。Devpost 显示周日 10:00 AM，比官网写的 12:00 早，按早的算。**
- 评审：10/11（周日）13:00 开始，**全员必须到场**

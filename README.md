# HackRU26 · 屏息 Breathless 🫁

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
- **夜晚**：自然循环入夜后，每条新生成的鱼稀有度掷两次取高的。`N` 可以渐变切换晨光 / 夜色。海怪风险还在待办里。
- **收藏**（`C`）：入库的鱼会渲染成 512×512 的卡牌图，就是 NFT 的图片。卡图完全由鱼的 seed 决定，任何人都能重新渲染并核对。

### 三张地图（已设计，尚未实现）

现在游戏里只有一片海，它是图 3 的底子；图 1、图 2 和地图选择还在待办里。完整设计见 [策划案第 6 节](design/game-design-document.md#6-地图)，摘要如下：

| | 图 1 · 挪威 / 冰岛峡湾 | 图 2 · 张家界 / 长白山天池 | 图 3 · 汪洋 |
| --- | --- | --- | --- |
| 难度 | 休闲 | 普通 | 困难 |
| 场景 | 雪山夹着的峡湾，岸边有木屋和松林，夜里有极光 | 石柱峰林环绕的高山湖，清晨和夜里起雾 | 开阔海面，远处有风暴云 |
| 时间 | 白天 05:00–20:00，天黑后小怪出现 | 全天循环 | 全天循环 |
| 可下潜深度 | 0–18 m，只有浅水区 | 0–38 m，加上第二层 | 0–58 m，唯一能下深渊的图 |
| 夜间小怪 | 野鹿（只吓人）、野熊（出水时心跳太快会被它抢走最贵的一条鱼） | 野熊、巨人（踏地时惊散鱼群，把潜水员推向水面） | 海浪、海怪（在深渊巡游，被追上则丢网） |
| 失败代价 | 丢网里的鱼 | 丢网里的鱼，加上船耐久损失 | 船耐久归零即沉船，全部装备永久丢失 |
| 解锁 | 初始 | 累计入库价值 150 | 累计入库价值 1000 |

- **船上垂钓**（三张图通用）：人在船上、没在憋气时鱼竿自动下钩，心率越平稳咬钩越快，不需要憋气。它用来填满两次下潜之间的休息时间。
- **升级**：鱼竿、鱼饵、船（速度 / 耐久 / 鱼台），加上一组潜水装备，见 [策划案第 7 节](design/game-design-document.md#7-经济与升级)。

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
- **macOS（Apple Silicon）** 或 **Windows**：Presage Node SDK 提供 `darwin-arm64`、`win32-x64`、`linux-x64/arm64` 的运行时。Windows 的注意事项见下方 [Windows](#windows)
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

（也可以用 `npm run dev` 同时启动两个，macOS 和 Windows 都可以用，Ctrl+C 会一起停掉。）

### Windows

- **x64 电脑**：直接按上面的步骤操作即可。
- **ARM 电脑（骁龙 Snapdragon X 等）**：Presage SDK 没有 `win32-arm64` 版本，ARM 版 Node 加载不了它。需要用 **x64 版 Node**，Windows 11 会在模拟模式下运行它：
  1. 下载 x64 的 Node 压缩包（例如 `node-v24.x.x-win-x64.zip`），解压到任意目录。
  2. 每个终端先把它放到 PATH 最前面，再执行 `npm run setup`、`npm run sensor`、`npm run game`：
     ```powershell
     $env:Path = "C:\path\to\node-v24.x.x-win-x64;$env:Path"
     node -p process.arch   # 应该输出 x64
     ```
  3. **安装和运行都要用同一个 Node**：`game/` 里的 esbuild 和 rollup 也是按架构安装的。如果之前用 ARM 版 Node 装过依赖，要先删掉 `sensor/node_modules` 和 `game/node_modules` 再重新安装。

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
| `N` | 渐变切换上午 / 夜晚；自然循环与下午可在暂停设置中选择 |
| `K` | 切换呼吸输入：presage → sim → keyboard |
| `Esc` | 暂停菜单：继续、设置、回到主页面。先关闭打开的面板；在设置里按是返回上一层；校准时按直接回主页面 |

**暂停的细节**：暂停时游戏完全冻结，切走标签页也会自动暂停。在水下点"继续"会先倒数 3 秒，让玩家吸一口气再憋住，否则暂停时的换气会被直接判成"水下呼吸"。回到主页面会释放摄像头和 sensor 连接；网里有鱼时会先弹确认，鱼会丢失，但这次憋气仍然记进健康数据。

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

文件：`sensor/breath-detector.mjs`。数据来自 Presage 的胸部起伏曲线 `breathing.upperTrace`。

**真实录制数据告诉我们的事**（2026-10-10，一次 2.5 分钟的憋气测试，4 次憋气）：

- Presage 刚启动的几秒，曲线会剧烈乱跳（幅度是正常呼吸的 10 倍）。旧检测器用这几秒学“正常呼吸幅度”，结果一开场就判成憋气，再也不退出：准确率 44%，正常呼吸有 86% 的时间被误判成憋气。
- 曲线做过高通滤波：憋气时它先随最后一口吸气往上跳，再用约 3 秒慢慢回落到平，不会一直停在高处。
- 憋气 15 秒，Presage 自带的 apnea 标志一次都没触发，所以默认不用它。
- 信号本身很好分：正常呼吸时 2 秒内的起伏大约是憋气时的 20 倍。

**现在的做法：看“活动量”**，也就是曲线每秒走过的路程（path length）。

1. **学习基线**：取最近 30 秒正常呼吸的活动量，用**中位数**当基线 B，不受偶尔乱跳的影响。启动后前 8 秒不学；刚开始憋气的那几秒也会被剔除，免得把基线拉低。
2. **判定憋气**：最近 2 秒的活动量小于 `0.38 × B`。
3. **判定换气**：最近 0.75 秒的活动量大于 `0.5 × B`，并且持续 0.2 秒。说话超过 0.5 秒也算换气。
4. **刚换完气**：2 秒内不会马上又判成憋气。
5. **游戏侧防抖**（`main.ts` 的 `RELEASE_DEBOUNCE_MS`）：水下“换气”必须持续 0.5 秒才算。

用那次录制重放的结果：**准确率 44% → 90%**，正常呼吸被误判成憋气 86% → 4%（剩下的基本是松开后的反应时间）。从提示“憋气”算起，约 2.4–4.3 秒识别出来，其中包含人的反应和吸气；换气约 1 秒内识别。

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `activityWindowUs` | 2 s | 判定憋气用的窗口 |
| `releaseWindowUs` | 0.75 s | 判定换气用的短窗口，越短反应越快 |
| `holdRatio` | 0.38 | 越大越容易、越早判成憋气，误判也会变多 |
| `releaseRatio` | 0.5 | 越小越灵敏，稍微一动就判定为换气 |
| `releaseHoldUs` | 0.2 s | 换气信号要持续多久才算 |
| `warmupUs` | 8 s | 忽略 Presage 启动时乱跳的那几秒 |
| `minBaselineUs` | 6 s | 至少学到这么久的正常呼吸，才开始判定憋气 |
| `useApnea` | false | 是否参考 Presage 的 apnea 标志 |

注意：阈值目前只用一个人、一次录制验证过。多录几个人的数据再确认。

### 用真实数据调参（录制 → 分析）

不要凭感觉改阈值，先录数据：

1. **最简单：标题页点 "Breath test (2.5 min) · 憋气测试"**。屏幕会按节奏提示：先正常呼吸 30 秒，然后"准备 → 憋气 15 秒 → 呼吸 15 秒"，重复 4 轮。每一秒都会自动打上标注，不用按任何键。结束后显示这次检测到了几次憋气、平均延迟多久、正常呼吸时误判的比例。
   也可以直接用摄像头模式玩：**每次真的憋气时同时按住 `Shift`**，换气时松开。HUD 左上会显示 "⏺ marking your hold"，这就是标准答案。
2. sensor 会把整个会话写进 `sensor/recordings/<时间>.jsonl`，内容包括原始胸部和腹部曲线、apnea、说话、心率、帧率、你的 Shift 标注、校准阶段。**这是生理数据，已经 gitignore，不要提交。**
3. 分析：

```bash
node sensor/analyze.mjs
```

它会输出：

- 摄像头帧率、Presage 数据批次间隔和延迟；
- 胸部和腹部曲线在"憋气"和"呼吸"时的幅度比（比值越大越好分）；
- 憋气期间曲线有没有漂移；
- 当前检测器和你标注的一致率、误判率、每分钟跳变次数、检测延迟。

```bash
node sensor/analyze.mjs --sweep
```

网格搜索 `holdWindowUs` / `flatRatio` / `releaseRatio` / `useApnea`，给出最好的几组。

```bash
node sensor/analyze.mjs --trace=lo --flatRatio=0.3
```

改用腹部曲线、或者指定某组参数重放。

注意：Presage 的呼吸频率需要约 30 s 窗口，说话时不可用；所有指标都只用于健康参考（wellness），不是医疗用途。

---

## 6. 代码导读

```
.
├── package.json            根目录脚本：setup / sensor / game / dev
├── scripts/dev.mjs         npm run dev：同时启动 sensor 和 game（跨平台）
├── .env.example            PRESAGE_API_KEY、SENSOR_PORT
├── intro/HackRU26.md       比赛介绍和时间线（中英双语）
├── design/game-design-document.md  策划案：三张地图、小怪、升级、改进点
├── sensor/                 Node 憋气传感器服务
│   ├── index.mjs           WS 服务、每个连接一个 Session、Presage SDK、模拟器（含模拟心率）
│   ├── breath-detector.mjs 憋气检测（第 5 节）
│   ├── recorder.mjs        把摄像头会话录成 JSONL（sensor/recordings/，已 gitignore）
│   └── analyze.mjs         重放录制数据、对比 Shift 标注、网格搜索阈值
└── game/                   Vite + TypeScript + Three.js
    ├── index.html          HUD、标题卡、收藏面板、报告面板的 DOM
    ├── vite.config.ts      端口 5173；Node polyfills（Umi 和 Irys 需要）
    └── src/
        ├── main.ts         入口：场景、阶段机（menu/calibrating/play/blackout）、主循环、输入、入库
        ├── breath.ts       BreathSource：摄像头抓帧推送、WS 状态、键盘/模拟模式
        ├── world.ts        海底、礁石、珊瑚、海带、光束、雪、水面、船；按深度变化雾和颜色；昼夜
        ├── daylight.ts     连续 24 小时光照模型、12 分钟自然循环、上午/下午/夜晚的平滑预览
        ├── water.ts        单次绘制的水面天空反光、随波纹变化的日光/月光高光
        ├── diver.ts        低多边形潜水员、踢腿、网、头灯、气泡
        ├── gear.ts         鱼竿概念对应的渔网模型：握把、线轮、杆身、网圈和网格
        ├── fish.ts         稀有度表、区域掉率、物种名、rollFish(seed)、鱼的网格、游动和逃跑 AI
        ├── rng.ts          mulberry32 种子随机数
        ├── portrait.ts     离屏渲染：fishIcon（192 px）和 fishCard（512 px，NFT 卡图）
        ├── hud.ts          呼吸面板和波形、深度计、紧急条、网格槽、入库数、toast
        ├── vault.ts        收藏面板、钱包栏、Mint 按钮（懒加载 chain.ts）
        ├── chain.ts        Umi、临时钱包、空投、mintFish、burnFish
        ├── polyfills.ts    Buffer 和 global 全局变量
        ├── health.ts       HealthLog：每次潜水记录憋气时长、心率、恢复时间
        ├── report.ts       健康报告：指标卡、两张图、解读文字、存 PDF、删除数据
        ├── pause.ts        Esc 暂停菜单：继续（水下 3 秒倒数）、设置、回到主页面
        ├── settings.ts     玩家设置（画质、摄像头小窗、操作提示），存 localStorage
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
| `deepbreath.settings` | 玩家设置：`quality`（auto / high / medium / low）、`showCamera`、`showHelp` |

重置：在浏览器控制台执行 `localStorage.clear()`。

---

## 11. 调试技巧

- 开发服务器**不做类型检查**。提 PR 前请跑：`npm --prefix game run build`（会先执行 `tsc --noEmit`）。
- 控制台能直接用这些全局对象：`breath`、`diver`、`fishes`、`keys`、`debugStep(seconds)`。
- 标签页在后台时 `requestAnimationFrame` 会降到约 2 fps，可以用 `debugStep(2)` 直接模拟 2 秒。
- sensor 的日志直接看运行 `npm run sensor` 的那个终端。Presage 的状态码和 ValidationCode 提示会翻译成 HUD 左上角的黄色 hint。
- Presage 一直卡在 `starting`：检查 `.env` 里的 key，看浏览器是否真的在发帧（HUD 的 frames 计数），以及光线够不够。

---

### 自动画质

暂停菜单的 Settings → Render quality 默认选 Auto；也可以手动选择高、中、低档并保存，手动档位不会自动降级。已有手动设置继续生效。暂停时不参与帧率采样，切换摄像头预览或操作提示不会重置 Auto 已降到的档位。

游戏根据浏览器提供的 CPU 逻辑核心数和设备内存提示选择初始画质：不超过 4 核或 4 GB 时用低档；至少 8 核且内存提示不低于 8 GB（或浏览器不提供内存提示）时用高档；其他情况用中档。这些提示不能准确代表 GPU 性能，因此运行中还会检查实际帧间隔。

| 参数 | 低 | 中 | 高 |
| --- | --- | --- | --- |
| DPR 上限 | 1 | 1.5 | 2 |
| 渲染像素预算 | 1280 × 720 | 1920 × 1080 | 3840 × 2160 |
| 海带 / 光束 / 粒子 | 12 / 4 / 300 | 30 / 8 / 700 | 55 / 14 / 1400 |
| 水面分段 | 30 × 8 | 60 × 16 | 90 × 24 |
| 装饰动画更新上限 | 20 Hz | 30 Hz | 60 Hz |
| 水面微波纹层数 | 1 | 2 | 3 |
| 天空渐变纹理刷新 | 5 Hz | 10 Hz | 15 Hz |

大屏幕可能使用低于 1 的 DPR 以保持像素预算；HUD 仍使用浏览器原生分辨率。启动宽限期后，连续两个 3 秒窗口平均低于 45 FPS 时降一级；降档后有 6 秒冷却，同一会话只降不升。隐藏标签页和孤立长停顿不参与判断，持续极低帧率仍会触发降档。

低档启动时关闭抗锯齿；运行中降档保留创建 WebGL 上下文时的抗锯齿设置，以免重建上下文中断游戏。装饰节流不改变潜水员、鱼、呼吸和光照的逐帧更新；头灯、昼夜、雾色和 NFT 卡图分辨率保留。夜间与深水里不可见的光束直接停止渲染，隐藏海带移出场景以避免矩阵更新。

- `npm --prefix game test`：画质分级、像素预算、持续卡顿、后台恢复和降档冷却测试。
- 控制台查看 `renderQuality.level` 和 `renderQuality.settings`，确认当前档位与预算。

### 自然昼夜与水面反光

默认从游戏时间 09:00 开始，每 12 分钟完成一轮 24 小时循环。天光、地平线色、主光方向与强度、水下雾色和光束连续变化：上午清爽微暖，下午偏金，傍晚逐渐转暗，夜间为冷蓝月光。HUD 顶部显示当前游戏时间；暂停时自动时间停止，后台恢复后的长帧不补算。

Esc → Settings → Time of day 可选择 Natural cycle、Morning、Afternoon、Night；手动切换约 2 秒渐变，不会瞬间跳灯。暂停时可预览这些光色，恢复 Natural cycle 也会平滑衔接。夜间稀有鱼加成由实际夜色状态决定，随自然入夜自动生效。

Esc → Settings → Lighting effects 可开关太阳/月光、光束和水面反光，默认开启，选择会自动保存。关闭时保留昼夜时间、天空与雾色、基础环境亮度和潜水员头灯；切换画质或时段不会重新开启光照效果。

水面以波纹法线和掠射角反光模拟天空色、日光与月光高光，光带随时间和波纹移动。水下观看时降低反光和不透明度，避免表面像一面墙；水下光束同时柔化边缘。反光直接计算在原水面材质中，保留雾和颜色空间，不增加反射相机或第二次场景渲染；低、中、高档分别计算 1 / 2 / 3 层微波纹。它模拟天空和光源的反光，船与鱼没有实时镜面倒影。

- `npm --prefix game test` 还包含昼夜周期、午夜与色彩关键点连续性、手动渐变、暂停和模式恢复测试。
- 控制台可查看 `world.dayCycle.hour` / `world.dayCycle.mode`，用 `setTimeOfDay('afternoon')` 预览光色。

## 12. 当前状态与待办

### ✅ 已完成

- 低多边形 2.5D 海底世界、潜水员、程序化生成的鱼（6 档稀有度、3 个深度区）
- 憋气才能下潜、水下换气后紧急上浮、黑屏丢鱼、出水入库
- Presage 管线：浏览器抓帧 → sensor → SDK → 憋气检测；键盘和模拟两种兜底
- NFT 卡图（由 seed 决定、可复现）、收藏面板
- Solana 铸造：已在 devnet 端到端验证（临时钱包 → Irys 上传图片和元数据 → Metaplex Core + 链上 Attributes），Solana Explorer 能正常显示卡图。[示例资产](https://explorer.solana.com/address/GHBBzZ7UTJPKVXWM5bryTsyM14x4Bv23MoQsfTN5tt13?cluster=devnet)
- 健康报告（按需生成）

### 🔜 待办（认领时在 PR 或群里说一声）

- [ ] **真机测试 Presage 憋气检测**，并调阈值（第 5 节）
- [ ] **游戏官方 Collection**：现在每条鱼都是独立 asset，Explorer 里 Verified Collection 显示 None。需要一个由服务端持有 authority 的 Collection，把鱼铸进去，市场才能按 Collection 筛选，也能防止伪造
- [ ] **装备经济**：用 SOL 或 Pearl（SPL token）购买氧气瓶、脚蹼、头灯、更大的网；装备有耐久度
- [ ] **NFT 消耗（sink）**：卖给市场换 Pearl、用鱼合成鱼饵或道具、献祭给海怪、进化、集齐套装兑换。`burnFish` 已经写好
- [ ] **夜晚海怪**：夜里高价值鱼出现，同时有海怪风险
- [ ] **三张地图**：每张图一份配置（天空和水色、岸线模型、最大深度、小怪表），主界面加地图选择。设计见策划案第 6 节
- [ ] **船上垂钓和心率玩法**：平静值决定咬钩速度和水下鱼的警觉距离；鱼竿、鱼饵、船的升级。设计见策划案第 4.2、6.3、7 节
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

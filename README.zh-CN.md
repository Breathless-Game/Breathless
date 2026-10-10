# HackRU26 · 屏息 Breathless 🫁

[English](README.md) · **简体中文**

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
- **鱼竿升级**（`G`）：当前鱼竿在游戏里表现为手持渔网。入库鱼换算成 Pearls，用 Pearls 解锁更大的网、更多容量和更远收网范围。

### 三张地图

三张地图都已经做进游戏。下潜前在开始卡片上选图：三张地图卡片排成一行，在 "Start with camera / Play with keyboard" 按钮上方。选中的地图也是标题页背后显示的场景。完整设计见 [策划案第 6 节](design/game-design-document.md#6-地图)，已实现的内容如下：

| | 峡湾 Fjord（挪威 / 冰岛） | 天池 Heaven Lake（张家界 / 长白山） | 汪洋 Open Ocean |
| --- | --- | --- | --- |
| 难度 | 休闲 | 普通 | 困难 |
| 开放深度 | 0–18 m，只有 Shallows（海底在 20 m） | 0–38 m，Shallows + Sunken Forest（海底在 40 m） | 0–58 m，Shallows + Coral Reef + The Abyss（海底在 60 m） |
| 水面以上 | 雪峰、松林岸、两间渔屋和一座栈桥、浮冰；夜里有极光，窗户亮灯 | 石柱、火山口边缘、湖边的亭子、飘动的雾（夜里更浓），夜里有一盏灯笼 | 带片状闪电的风暴锋面、海蚀柱、一座灯塔（夜里灯会转动） |
| 水下 | 冷青色的水，灰色的砾石和岩石，海带，没有珊瑚 | 翡翠绿色的水，沉木和岩架，稀疏的水草 | 原来的珊瑚礁：珊瑚、海带、沙地 |
| 海浪 | 汪洋的一半高 | 最平静 | 完整高度 |
| 解锁 | 一开始就开放 | 累计入库鱼价值 150 | 累计入库鱼价值 1000 |

- **深度区**：Sunken Forest（沉没森林）是天池的第二个深度区。它沿用 Coral Reef 的掉率表，只有外观和深度计上的标签不同。鱼只在地图开放的区域里生成，右侧的深度计也只显示这些区域。
- **解锁**：按入库鱼的累计捕获价值解锁（见第 7 节的“捕获价值”）。游戏会记住达到过的最高累计值，所以之后失去鱼也不会让地图重新上锁。某次下潜入库的鱼够开一张新图时，会有一条提示。
- **演示开关**：地图卡片下面有一个勾选框 "Unlock all maps (demo)"，勾上后所有地图一次全部开放。它是给演示和测试用的。
- **保存的进度**：选中的地图、最高累计价值和演示开关存在 localStorage 里，key 是 `deepbreath.maps`。
- **仍然只是设计，尚未实现**：夜间小怪（峡湾：野鹿、野熊；天池：野熊、巨人；汪洋：海浪、海怪）、游戏内时钟（峡湾白天 05:00–20:00）、由心率驱动的船上垂钓、船耐久，以及汪洋沉船后全部装备永久丢失。
- **升级**：鱼竿、鱼饵、船（速度 / 耐久 / 鱼台），加上一组潜水装备，见 [策划案第 7 节](design/game-design-document.md#7-经济与升级)。升级部件（鱼竿、鱼饵、船的引擎 / 船体 / 鱼台、网、脚蹼、应急氧气瓶、头灯）在 `game/src/upgrades.ts` 里都有低多边形模型，每种三个等级。这些模型还没有在游戏里显示或使用，用 Pearl 购买也还没接上。

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

### 自托管 / Self-hosting

`npm start` 是生产服务器：一个 Node 进程、一个端口，同时提供构建好的游戏和憋气传感器（WebSocket 在 `/sensor`），前面只需要一条隧道或一个反向代理。

```bash
npm run setup      # 一次性：安装 sensor/ 和 game/ 的依赖
npm run build      # 把 game/ 构建到 game/dist
npm start          # http://127.0.0.1:8794，传感器在 ws://127.0.0.1:8794/sensor
```

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PRESAGE_API_KEY` | 空 | **只放在服务器**仓库根目录的 `.env` 里。没有 key 时服务器跑模拟器。 |
| `PORT` | `8794` | HTTP + WebSocket 端口。开发模式（`npm run sensor`）仍用 `SENSOR_PORT`，8787。 |
| `HOST` | `127.0.0.1` | 监听地址。只听本机，因为同机的隧道 / 代理是唯一入口。 |
| `MAX_LIVE_SESSIONS` | `1` | 同时使用 Presage 实时检测的玩家数。SDK 的原生状态是进程全局的，一个进程里跑不了两个会话；设成 `0` 关闭实时检测。超出上限的玩家会看到 "Server busy"，自动改用键盘玩。 |
| `MAX_CONN_PER_IP` | `8` | 每个玩家 IP 可同时打开的传感器连接数（代理在本机时读 `CF-Connecting-IP` / `X-Forwarded-For`）。 |
| `SENSOR_RECORD` | 关 | 设成 `1` 才把实时会话写进 `sensor/recordings/`。serve 模式默认关闭：陌生人的呼吸数据绝不落盘。（开发模式照旧录制。） |

- **摄像头必须走 HTTPS。** 浏览器只在 `https://` 页面（或 `localhost`）上允许 `getUserMedia`，所以要在 `127.0.0.1:8794` 前面放一条隧道（如 Cloudflare Tunnel）或带 TLS 的反向代理。构建出的游戏会自动连 `wss://<同一域名>/sensor`；构建时设置 `VITE_SENSOR_URL` 可以改连别处。
- **团队的 Dell** 在每次 push 到 `main` 后自动部署（GitHub Actions + self-hosted runner + Cloudflare Tunnel）。一次性配置见 [deploy/SETUP.md](deploy/SETUP.md#中文)。
- **带宽。** 实时模式把每一帧 640×480 画面压成 JPEG 上传，30 fps，**每个玩家约 3–6 Mbit/s 上行**（Chrome 质量 0.7：画面简单时每帧 16–20 kB，画面杂乱时 30–35 kB）。Presage 要约 25 fps 以上，低于约 15 fps 波形会变差，所以游戏优先保帧率、牺牲画质：目标每帧 25 kB（30 fps 即 6 Mbit/s），帧偏大或上行太慢导致跳帧时，JPEG 质量在 0.8 到 0.4 之间自动下调。约 5 Mbit/s 的上行在一般画面下能保持 30 fps；更慢就会跳帧。sensor 用 [sharp](https://sharp.pixelplumbing.com/)（libvips）解码：每帧约 2 ms，在独立线程上跑，比原始帧多占约 3% 的单核。键盘和模拟模式不发帧。
  - 开发构建连本机 sensor 时仍默认发原始 RGBA（每帧 1.23 MB，30 fps 约 295 Mbit/s，只在同一台机器上用）。在页面 URL 后加 `?frames=raw` 或 `?frames=jpeg`（或构建时设置 `VITE_FRAME_FORMAT`）可以强制使用其中一种。
  - 不用摄像头检查某个部署的上行链路：在玩家的网络里运行 `node sensor/stream-test.mjs wss://<你的域名>/sensor`，它会连续 20 秒发送合成的 JPEG 帧，打印上行速率、跳过的帧数和 Presage 接收的帧数（可选 `--raw`、`--fps`、`--quality`、`--image face.jpg`）。

---

## 3. 操作方式

| 键 | 作用 |
| --- | --- |
| `←` `→` `↑` `↓` / `WASD` | 游泳（在水面不憋气时不能下潜） |
| `Space` | 挥网抓鱼 |
| `Shift`（按住） | 憋气（键盘模式和模拟模式） |
| `C` | 收藏和 NFT 面板 |
| `G` | 鱼竿 / 渔网升级面板 |
| `H` | 健康报告（只在你按的时候生成） |
| `N` | 切换白天 / 夜晚 |
| `K` | 切换呼吸输入：presage → sim → keyboard |
| `Esc` | 暂停菜单：继续、设置、回到主页面。先关闭打开的面板；在设置里按是返回上一层；校准时按直接回主页面 |
| `Enter`（主页面） | 等于点 START 鱼 |

**主页面**：进入时一根绳子（两端都在屏幕外）从左边荡出、挂到右边，然后几条鱼从上方掉下来，用鱼线挂在绳子上。按钮名字印在鱼身上。名字长（4 个字符以上）的鱼用头、尾两根鱼线横着挂；两根线像滑轮一样自动调长短，所以绳子倾斜的地方鱼和字也保持水平。金色的 **START** 鱼打开开始卡片（摄像头 / 键盘 / 憋气测试），紫色的 **SETTINGS** 鱼打开设置。鱼和绳子都能用鼠标拖、甩，划过时会被推开。系统开了"减少动态效果"时跳过入场动画。

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

### WebSocket 协议（开发时 `ws://<host>:8787`，`npm start` 时同源 `/sensor`）

**浏览器 → sensor**

- **二进制帧**：12 字节头 + 图像，全部小端序。`game/src/frame-codec.ts` 负责写，`sensor/frames.mjs` 负责读；`game/tests/frame-protocol.test.mjs` 把两端放在一起测试。
  | 偏移 | 类型 | 含义 |
  | --- | --- | --- |
  | 0 | f64 | 时间戳（ms，必须单调递增；间隔超过 2 s 时 SDK 会重启） |
  | 8 | u16 | 第 0–11 位：宽（640）。第 12–15 位：格式，`0` = 原始 RGBA，`1` = JPEG |
  | 10 | u16 | 高（480） |
  | 12… | u8[] | 原始：RGBA，宽 × 高 × 4。JPEG：一张宽 × 高的 JPEG 图像 |
  - 格式 0 的宽字段和以前完全一样，所以原始帧与旧协议逐字节相同。sensor 把 JPEG 解码成 RGBA，交给 Presage 的数据和原始帧完全一致。解码一次只做一帧，另外最多有一帧排队；排队时又来新帧就替换掉旧的，所以服务器跟不上时丢帧，而不是无限排队。
  - 背压：`ws.bufferedAmount` 超过 100 kB（JPEG）或 4 帧（原始）时浏览器跳过帧；JPEG 一次只编码一帧。
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

错误以 `{ "t": "error", "message": "…" }` 发送。`"code": "busy"` 表示实时 Presage 名额（`MAX_LIVE_SESSIONS`）已满：游戏停止发帧，改用键盘。`"code": "frames"` 表示 sensor 解不了 JPEG（没装 sharp）：游戏改发原始帧。

---

## 5. 憋气检测算法

文件：`sensor/breath-detector.mjs`。数据来自 Presage 的胸部起伏曲线 `breathing.upperTrace`。

**真实录制数据告诉我们的事**（2026-10-10，同一个人两次 2.5 分钟的憋气测试，共 8 次憋气）：

- Presage 刚启动的几秒，曲线会剧烈乱跳（幅度是正常呼吸的 10 倍）。旧检测器用这几秒学“正常呼吸幅度”，结果一开场就判成憋气，再也不退出：准确率 44%，正常呼吸有 86% 的时间被误判成憋气。
- 曲线做过高通滤波：憋气时它先随最后一口吸气往上跳，再用约 3 秒慢慢回落到平，不会一直停在高处。
- 憋气 15 秒，Presage 自带的 apnea 标志一次都没触发，所以默认不用它。
- 信号本身很好分：正常呼吸时 2 秒内的起伏大约是憋气时的 5–20 倍。
- **憋气中途会有“假动作”**：第二次测试里，测试者完全没动、没换气，曲线却在憋气中途跳了两次。一次往上跳、幅度和一次呼吸差不多，一次往下小抖。光看活动量分不出来，v3 因此在憋气中途误判了 2 次“换气”。
- **真正换气的第一下永远是吐气**：8 次换气全部是曲线往下掉，掉的幅度是基线的 1.55–3.5 倍；那两次假动作往下最多只有约 1 倍。曲线方向：往上是吸气，往下是呼气。

**现在的做法：看“活动量”**，也就是曲线每秒走过的路程（path length）。

1. **学习基线**：取最近 30 秒正常呼吸的活动量，用**中位数**当基线 B，不受偶尔乱跳的影响。启动后前 8 秒不学；刚开始憋气的那几秒也会被剔除，免得把基线拉低。
2. **判定憋气**：最近 2 秒的活动量小于 `0.38 × B`。
3. **判定换气，主要靠吐气**：记住憋气时曲线的“水平线”。它会跟着憋气后的缓慢回落走，但曲线乱跳时冻结，不被假动作带跑。曲线从水平线、同时也从最近 1.5 秒的最高点往下掉超过 `1.1 × B`，并持续 0.1 秒，就算换气。往上跳超过 `2 × B` 也算，对应空着肺憋气、先吸气的人。
4. **刚判成憋气的头 2 秒**：这时可能只是两口气之间的停顿，所以活动量一回来（0.75 秒内大于 `0.5 × B`，持续 0.2 秒）就算换气。
5. **兜底**：2 秒活动量连续 4 秒大于 `0.8 × B`，也算换气，这样永远不会卡死在憋气。说话超过 0.5 秒也算换气。
6. **刚换完气**：2 秒内不会马上又判成憋气。
7. **游戏侧防抖**（`main.ts` 的 `RELEASE_DEBOUNCE_MS`）：水下“换气”必须持续 0.5 秒才算。

两次录制重放的结果：

| | v3（只看活动量） | 现在（看吐气） |
| --- | --- | --- |
| 憋气中途被误判成换气 | 2 次 | **0 次** |
| 识别到憋气（从提示算起） | 中位 2.9 s | 中位 2.8 s |
| 识别到换气 | 约 1.0 s | 中位 1.6 s，最慢 2.0 s |
| 正常呼吸被误判成憋气 | 1.2% | 1.2% |

换气慢了约 0.6 秒，换来的是潜水时不会被冤枉“换气了”。吐气阈值在 1.0–1.3 之间都是零误判，降到 0.9 开始出错，所以取 1.1，两边都留了余量。`--sweep` 会偏向 0.9，因为它只看这两次录制，我们不信它。

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `activityWindowUs` | 2 s | 判定憋气用的窗口 |
| `holdRatio` | 0.38 | 越大越容易、越早判成憋气，误判也会变多 |
| `exhaleRatio` | 1.1 | 吐气要往下掉多少（× B）才算换气。越小换气识别越快，但憋气中的小抖动也可能被当成换气 |
| `inhaleRatio` | 2.0 | 往上跳多少（× B）算先吸气的换气 |
| `exhaleWindowUs` | 1.5 s | 下降要在这么短的时间里发生，用来排除憋气后的缓慢回落 |
| `exhaleHoldUs` | 0.1 s | 吐气信号要持续多久才算 |
| `quietRatio` / `levelTauUs` | 0.5 / 1 s | 水平线只在曲线安静时跟随，跟随速度 |
| `trustAfterUs` | 2 s | 憋气头这么久里，活动量一回来就算换气 |
| `releaseWindowUs` / `releaseRatio` / `releaseHoldUs` | 0.75 s / 0.5 / 0.2 s | 上面那条“活动量回来”的具体标准 |
| `sustainedRatio` / `sustainedUs` | 0.8 / 4 s | 兜底：持续呼吸多久一定结束憋气 |
| `warmupUs` | 8 s | 忽略 Presage 启动时乱跳的那几秒 |
| `minBaselineUs` | 6 s | 至少学到这么久的正常呼吸，才开始判定憋气 |
| `useApnea` | false | 是否参考 Presage 的 apnea 标志 |

注意：阈值目前只用一个人、两次录制验证过。**换个人请跑一次憋气测试再确认**，尤其要确认“往下是吐气”这个方向在别人的摄像头上也成立。`analyze.mjs` 会打印 `release reasons`：正常情况下大部分应该是 `exhale`。

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

网格搜索 `holdRatio` / `exhaleRatio` / `exhaleWindowUs` / `trustAfterUs`，给出最好的几组。“憋气中途被误判成换气”扣分最重。

```bash
node sensor/analyze.mjs --trace=lo --exhaleRatio=1.3
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
├── assets/                 素材库：每个鱼种和鱼竿的图片与参数
├── sensor/                 Node 憋气传感器服务
│   ├── index.mjs           WS 服务、每个连接一个 Session、Presage SDK、模拟器（含模拟心率）
│   ├── breath-detector.mjs 憋气检测（第 5 节）
│   ├── recorder.mjs        把摄像头会话录成 JSONL（sensor/recordings/，已 gitignore）
│   └── analyze.mjs         重放录制数据、对比 Shift 标注、网格搜索阈值
└── game/                   Vite + TypeScript + Three.js
    ├── index.html          HUD、标题卡、收藏面板、报告面板的 DOM
    ├── vite.config.ts      端口 5173；Node polyfills（Umi 和 Irys 需要）
    ├── asset-library.html  素材库的预览页，只在开发服务器上有（src/asset-library.ts）
    ├── tests/              node --test：自动画质的单元测试
    └── src/
        ├── main.ts         入口：场景、阶段机（menu/calibrating/play/blackout）、主循环、输入、入库
        ├── breath.ts       BreathSource：摄像头抓帧推送、WS 状态、键盘/模拟模式
        ├── breathtest.ts   标题页的 2.5 分钟憋气测试：按提示憋气和呼吸，自动打标注
        ├── world.ts        按所选地图生成的水下地形（海底、礁石、珊瑚、海带）、光束、雪、水面、船；按深度变化雾和颜色；昼夜
        ├── maps.ts         三张地图的定义（深度、解锁价值、配色）和保存的地图进度
        ├── scenery.ts      每张地图水面以上的场景
        ├── lowpoly.ts      共用的低多边形工具：flat 材质、顶点抖动、按面上色、把静态部件按材质合并成一个网格的 batcher
        ├── mappicker.ts    开始卡片上的地图卡片
        ├── diver.ts        低多边形潜水员、踢腿、网、头灯、气泡
        ├── gear.ts         鱼竿概念对应的渔网模型：握把、线轮、杆身、网圈和网格
        ├── equipment.ts    鱼竿等级、Pearl 余额、本地存档和升级规则
        ├── gear-panel.ts   鱼竿 / 渔网升级面板
        ├── upgrades.ts     升级表和每个升级等级的低多边形模型（还没有在游戏里显示）
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
        ├── title.ts        主页面：Verlet 绳子 + 鱼线挂鱼，鼠标拖拽和推动，START / SETTINGS 鱼是按钮
        ├── settings.ts     玩家设置（画质、摄像头小窗、操作提示），存 localStorage
        ├── render-quality.ts  自动画质：按设备选初始档位，持续掉帧时降档
        └── style.css       深色玻璃风 HUD
```

---

## 7. 游戏设计参数

17 个鱼种和鱼竿的图片、每个鱼种的参数，见[素材库](assets/README.zh-CN.md)。

### 深度分区与掉率（`fish.ts` 中的 `ZONES`）

| 区域 | 深度 | 奖励倍率 | common | uncommon | rare | epic | legendary | mythic |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shallows | 0–18 m | ×1.0 | 70 | 25 | 5 | – | – | – |
| Coral Reef | 18–38 m | ×1.6 | 20 | 35 | 30 | 13 | 2 | – |
| The Abyss | 38–58 m | ×2.5 | – | 10 | 30 | 35 | 19 | 6 |

**捕获价值** = 稀有度的 `value`（见下表）× 所在区域的奖励倍率（`rewardMultiplier`），四舍五入。同一条 rare 鱼，在浅水区值 10，在珊瑚礁值 16，在深渊值 25。它在提示、HUD 和收藏卡片上显示为 “pts”，收藏按它排序，铸造时写进 NFT 元数据的 `Catch value`，地图解锁也按它累计。这次改动之前入库的鱼没有存这个值，按原来的稀有度 value 计算。

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

`SWIM_ACCEL 24` · `DRAG 2.4` · `MAX_SPEED 7.5` · `SURFACE_DEPTH 0.9` · `EMERGENCY_SECONDS 3.2`（换气后的剩余时间）· `EMERGENCY_LIFT 18`（紧急上浮力度）· `FISH_PER_ZONE [16, 16, 12]`

### 鱼竿 / 渔网升级（`equipment.ts` 中的 `ROD_TIERS`）

鱼竿概念在当前融合版中落地为潜水员手持的渔网。升级只影响装备，不会延长憋气时间。

| 等级 | 名称 | 容量 | 收网范围 | 升级消耗 |
| --- | --- | ---: | ---: | ---: |
| Lv1 | Basic Net | 6 | 2.4 m | 初始 |
| Lv2 | Reinforced Net | 8 | 2.8 m | 300 Pearls |
| Lv3 | Abyssal Net | 10 | 3.2 m | 1200 Pearls |

每条成功入库的鱼按捕获价值奖励 Pearls；黑屏丢网不奖励。升级状态保存在 `deepbreath.equipment`，不会删除或消费收藏鱼。

![Rod and net upgrade preview](game/public/rod-upgrades-preview.png)

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
| `deepbreath.bank` | 入库的鱼（`FishSpec[]`，带捕获价值 `value` 和地图 `map`，铸造后带 `assetId`） |
| `deepbreath.health` | 潜水记录（`DiveRecord[]`，最多 300 条） |
| `deepbreath.wallet` | devnet 临时钱包的私钥（数字数组） |
| `deepbreath.equipment` | 鱼竿等级和 Pearls 余额（`rodLevel`、`pearls`） |
| `deepbreath.settings` | 玩家设置：`quality`（auto / high / medium / low）、`showCamera`、`showHelp` |
| `deepbreath.maps` | 地图进度：选中的地图、最高累计入库价值、演示开关 |

重置：在浏览器控制台执行 `localStorage.clear()`。

---

## 11. 调试技巧

- 开发服务器**不做类型检查**。提 PR 前请跑：`npm --prefix game run build`（会先执行 `tsc --noEmit`）。
- 控制台能直接用这些全局对象：`breath`、`diver`、`fishes`、`keys`、`debugStep(seconds)`。
- 标签页在后台时 `requestAnimationFrame` 会降到约 2 fps，可以用 `debugStep(2)` 直接模拟 2 秒。
- sensor 的日志直接看运行 `npm run sensor` 的那个终端。Presage 的状态码和 ValidationCode 提示会翻译成 HUD 左上角的黄色 hint。
- Presage 一直卡在 `starting`：检查 `.env` 里的 key，看浏览器是否真的在发帧（HUD 的 frames 计数），以及光线够不够。

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

大屏幕可能使用低于 1 的 DPR 以保持像素预算；HUD 仍使用浏览器原生分辨率。启动宽限期后，连续两个 3 秒窗口平均低于 45 FPS 时降一级；降档后有 6 秒冷却，同一会话只降不升。隐藏标签页和孤立长停顿不参与判断，持续极低帧率仍会触发降档。

低档启动时关闭抗锯齿；运行中降档保留创建 WebGL 上下文时的抗锯齿设置，以免重建上下文中断游戏。装饰节流不改变潜水员、鱼、呼吸和光照的逐帧更新；头灯、昼夜、雾色和 NFT 卡图分辨率保留。夜间与深水里不可见的光束直接停止渲染，隐藏海带移出场景以避免矩阵更新。

- `npm --prefix game test`：画质分级、像素预算、持续卡顿、后台恢复和降档冷却测试。
- 控制台查看 `renderQuality.level` 和 `renderQuality.settings`，确认当前档位与预算。

---

## 12. 当前状态与待办

### ✅ 已完成

- 低多边形 2.5D 海底世界、潜水员、程序化生成的鱼（6 档稀有度、3 个深度区）
- 憋气才能下潜、水下换气后紧急上浮、黑屏丢鱼、出水入库
- Presage 管线：浏览器抓帧 → sensor → SDK → 憋气检测；键盘和模拟两种兜底
- NFT 卡图（由 seed 决定、可复现）、收藏面板
- Solana 铸造：已在 devnet 端到端验证（临时钱包 → Irys 上传图片和元数据 → Metaplex Core + 链上 Attributes），Solana Explorer 能正常显示卡图。[示例资产](https://explorer.solana.com/address/GHBBzZ7UTJPKVXWM5bryTsyM14x4Bv23MoQsfTN5tt13?cluster=devnet)
- 健康报告（按需生成）
- 三张地图（峡湾、天池、汪洋）：水面以上的场景、深度上限、开始卡片上的地图选择、按累计入库鱼价值解锁
- 升级部件的低多边形模型（只有代码，还没有进游戏）
- 鱼竿 / 渔网升级 MVP：三档容量和收网范围、Pearl 奖励、可见网圈缩放、本地持久化

### 🔜 待办（认领时在 PR 或群里说一声）

- [ ] **真机测试 Presage 憋气检测**，并调阈值（第 5 节）
- [ ] **游戏官方 Collection**：现在每条鱼都是独立 asset，Explorer 里 Verified Collection 显示 None。需要一个由服务端持有 authority 的 Collection，把鱼铸进去，市场才能按 Collection 筛选，也能防止伪造
- [ ] **完整装备经济**：在鱼竿 / 渔网升级 MVP 之外，用 SOL 或 Pearl（SPL token）购买氧气瓶、脚蹼、头灯；装备有耐久度。低多边形模型已经有了，剩下的是在游戏里显示模型、购买和让效果生效
- [ ] **NFT 消耗（sink）**：卖给市场换 Pearl、用鱼合成鱼饵或道具、献祭给海怪、进化、集齐套装兑换。`burnFish` 已经写好
- [ ] **夜晚海怪**：夜里高价值鱼出现，同时有海怪风险
- [ ] **三张地图的剩余部分**：每张图的夜间小怪、游戏内时钟、汪洋图的船耐久和沉船。设计见策划案第 6 节
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
- **README 有两份**：`README.md`（English）和 `README.zh-CN.md`（中文）。改其中一份时，请在同一个 PR 里把另一份也改了。

---

## 14. 比赛时间线

完整内容见 [`intro/HackRU26.md`](intro/HackRU26.md)。

- 开发：10/10（周六）12:00 开始
- **提交截止：以 Devpost 页面为准。Devpost 显示周日 10:00 AM，比官网写的 12:00 早，按早的算。**
- 评审：10/11（周日）13:00 开始，**全员必须到场**

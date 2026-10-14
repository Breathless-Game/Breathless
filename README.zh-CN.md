# HackRU26 · 屏息 Breathless 🫁

[English](README.md) · **简体中文**

<p align="center"><img src="docs/showcase.gif" alt="屏息 Breathless：极光下的峡湾，潜水员憋着气下潜抓鱼" width="800"></p>

> **用你真实的憋气来潜水抓鱼。** 摄像头通过 Presage 识别你是否在憋气，憋住气潜水员才能下潜；越深鱼越稀有；在水下一换气就必须马上浮上去，否则网里的鱼全丢。抓到的鱼可以铸造成 Solana NFT，玩家之间交易。游戏还会安静地记录每次憋气的时长和心率，你想看的时候一键生成健康报告。

> **Presage 暂时关闭。** 额度用完了（HTTP 402），所以摄像头呼吸检测先关掉，游戏用**键盘模式**：按住 `Shift` 代表憋气、下潜。摄像头相关代码都还在，由两个默认关闭的开关控制，见[重新开启 Presage](#重新开启-presage)。

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
- **贪心与风险**：潜得越深，鱼越稀有、越值钱（神话级只在 50 m 以下出现，而海沟没有底），但离水面越远，换气后越难赶回去。
- **夜晚**：自然循环入夜后，每条新生成的鱼稀有度掷两次取高的。`N` 可以渐变切换晨光 / 夜色。海怪风险还在待办里。
- **收藏**（`C`）：入库的鱼会渲染成 512×512 的卡牌图，就是 NFT 的图片。卡图完全由鱼的 seed 决定，任何人都能重新渲染并核对。每条入库的鱼都会在后台自动铸成 NFT；点 **Sell** 把鱼卖成 Pearls（见第 7 节）。
- **鱼竿升级**（`G`）：当前鱼竿在游戏里表现为手持渔网。卖鱼得到 Pearls，用 Pearls 解锁更大的网、更多容量和更远收网范围。

### 三张地图

三张地图都已经做进游戏。下潜前在开始卡片上选图：三张地图卡片排成一行，在 "Start with camera / Play with keyboard" 按钮上方。选中的地图也是标题页背后显示的场景。完整设计见 [策划案第 6 节](design/game-design-document.md#6-地图)，已实现的内容如下：

| | 峡湾 Fjord（挪威 / 冰岛） | 天池 Heaven Lake（张家界 / 长白山） | 汪洋 Open Ocean |
| --- | --- | --- | --- |
| 难度 | 休闲 | 普通 | 困难 |
| 海底上方的区域 | 0–58 m，浅水区 + 海带林 | 0–98 m，浅水区 + 沉林 + 深水盆地 | 0–60 m，Shallows + Coral Reef + The Abyss |
| 海底 | 约 60 m，完整岩石海底 | 约 100 m，完整湖底 | 62 m 大陆架，往下是无底海沟 |
| 水面以上 | 三排前后错开的雪峰，近山坡上有松林；松林岸、两间渔屋和一座栈桥、浮冰；夜里窗户亮灯，大多数夜晚有光柱帘幕状的极光，水面会映出来 | 石柱、火山口边缘、湖边的亭子、飘动的雾（夜里更浓），夜里有一盏灯笼 | 带片状闪电的风暴锋面、海蚀柱、一座灯塔（夜里灯会转动） |
| 水下 | 冷青色的水，灰色的砾石和岩石，海带，没有珊瑚 | 翡翠绿色的水，沉木和岩架，稀疏的水草 | 原来的珊瑚礁：珊瑚、海带、沙地 |
| 海浪 | 汪洋的一半高 | 最平静 | 完整高度 |
| 天气 | 多数时候晴好，风暴很短 | 多数时候晴好，风暴很短 | 多风暴：三分之一的时间在风暴里，涌浪加倍，巨浪会打翻船 |
| 鲨鱼 | 无 | 无 | 白天 1–2 条，夜晚 2–4 条：循着心率捕猎，同时鱼更稀有 |
| 解锁 | 一开始就开放 | 累计入库鱼价值 150 | 累计入库鱼价值 1000 |

- **海沟**：仅汪洋保留船下的无限海沟。峡湾和天池在整个地图宽度上都有完整海底，分别在约 60 米和 100 米处起伏。潜水员、鱼群、相机和声纳共用绘制海底的实际高度。
- **深度区**：峡湾开放浅水区和海带林；天池开放浅水区、沉林和深水盆地。掉率只看绝对深度。只有汪洋生成跟随潜水员的海沟鱼群，并显示无限海沟区段；有限地图的深度计按海底深度缩放。
- **解锁**（阈值已经定好，但 `player_state` v2 的链上校验是接下来要做的，目前所有地图都是开放的）：按历史上所有入库鱼的累计捕获价值解锁（见第 7 节的“捕获价值”）。卖鱼不会让它减少，所以地图不会重新上锁，进度也不会停滞。解锁天池会开放更深的有限湖底，解锁汪洋则会开放无限海沟。某次下潜入库的鱼够开一张新图时，会有一条提示。
- **演示开关**：地图卡片下面有一个勾选框 "Unlock all maps (demo)"，勾上后所有地图一次全部开放。它是给演示和测试用的。
- **保存的进度**：选中的地图、历史累计入库价值和演示开关存在 localStorage 里，key 是 `deepbreath.maps`。按累计入库价值解锁的判定会随 player_state v2 搬到链上，这是接下来要做的；在那之前所有地图都是开放的。
- **仍然只是设计，尚未实现**：夜间小怪（峡湾：野鹿、野熊；天池：野熊、巨人；汪洋：海浪、海怪）、各地图独立的白昼时段（峡湾白天 05:00–20:00）、由心率驱动的船上垂钓、船耐久，以及汪洋沉船后全部装备永久丢失。
- **鱼卡图**：改了 `fish.ts`、`marine.ts` 或 `fish-card-geometry.ts` 之后，运行 `npm --prefix game run build:fish-card` 并提交结果。否则会有测试失败，CI 会拦住部署。
- **升级**：鱼竿、鱼饵、船（速度 / 耐久 / 鱼台），加上一组潜水装备，见 [策划案第 7 节](design/game-design-document.md#7-经济与升级)。升级部件（鱼竿、鱼饵、船的引擎 / 船体 / 鱼台、网、脚蹼、应急氧气瓶、头灯）在 `game/src/upgrades.ts` 里都有低多边形模型，每种三个等级。工作台已显示这些模型，九类各三档的 PNG / GLB 已归档到[装备素材库](assets/README.zh-CN.md#7-装备升级模型)。其余装备的购买与潜水效果仍待玩法逻辑接入。

### 比赛定位

| 项 | 内容 |
| --- | --- |
| 赛道 | Maverick |
| MLH 奖项目标 | **Best Use of Presage**（憋气检测、心率）· **Best Use of Solana**（鱼 NFT、交易）· 后续可加 ElevenLabs（音效/旁白）、Tiger Data（市场与经济数据）、.Tech 域名 |

### 多人范围（重要）

**多人同时在线，但每个人在自己独立的世界里潜水，玩家之间只通过交易互动。** 不做共享世界，也不做实时同步联机。所有"多人"功能都在交易层：钱包身份、挂单、购买、成交动态。

---

## 2. 快速开始

### 桌面版

只想玩？用浏览器打开 https://breathless.gotclass.xyz ，或者到 [Releases](https://github.com/Breathless-Game/Breathless/releases) 下载 Windows、macOS、Linux 桌面版。它是同一个网站套了一个窗口（所以永远是最新版，也必须联网），在双显卡笔记本上会请求用独立显卡。安装包没有签名，第一次打开会弹警告：[怎样照样打开](desktop/README.md#first-launch-of-an-unsigned-build)。桌面版里的钱包登录还没做好。构建和发版见 [desktop/README.md](desktop/README.md)。

### 环境要求

- **Node.js 20+**（开发机是 v20.19.5）
- **macOS（Apple Silicon）** 或 **Windows**：Presage Node SDK 提供 `darwin-arm64`、`win32-x64`、`linux-x64/arm64` 的运行时。Windows 的注意事项见下方 [Windows](#windows)
- **Chrome**，以及一个摄像头（用键盘或模拟模式的话不需要）

### 安装与运行

```bash
git clone https://github.com/Breathless-Game/Breathless.git
cd Breathless
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

`git pull` 之后照常启动即可。如果拉下来的代码加了新依赖，游戏和 sensor 启动时会发现缺了它，先自动装好再启动。

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
| **Start with camera**（暂时关闭：构建时没设 `VITE_PRESAGE_ENABLED=1` 就不显示） | 真实模式：摄像头 → Presage → 憋气检测 | sensor 以 `PRESAGE_ENABLED=1` 运行，并且有 Presage key |
| **Play with keyboard** | 按住 `Shift` 代表憋气 | 什么都不需要 |
| 模拟模式（游戏里按 `K` 切换；Presage 关闭期间只在开发构建里有） | 由 sensor 生成假的呼吸波形和心率，按 `Shift` 代表憋气 | sensor 正在运行，不需要 key |

### Presage API key

- 在 <https://physiology.presagetech.com/portal/dashboard> 申请。
- 填到根目录的 `.env`：`PRESAGE_API_KEY=...`
- **`.env` 已经加进 `.gitignore`，绝对不要提交。** 队友之间请私下传 key，不要贴进代码、issue 或 PR。
- 没有 key 时 sensor 会自动进入模拟模式（`npm run sensor:sim` 是强制模拟）。

### 重新开启 Presage

Presage **暂时关闭**：服务器和游戏各有一个开关，只有设成 `1`（或 `true`）才开，默认都是关。

- **服务器：`PRESAGE_ENABLED=1`**，写在仓库根目录的 `.env`（或环境变量）里。关闭时 sensor 不加载 SmartSpectra SDK，即使 `.env` 里还有 `PRESAGE_API_KEY` 也忽略，丢弃摄像头帧，只跑模拟器；启动日志会写 `Presage SmartSpectra is disabled`。市场、NFT 元数据等服务器上的其他功能不受影响。
- **游戏：构建时 `VITE_PRESAGE_ENABLED=1`**（写在 `game/.env`，或命令行 `VITE_PRESAGE_ENABLED=1 npm run build`）。关闭时游戏不请求摄像头，隐藏 **Start with camera** 和摄像头画面设置，跳过校准，`K` 只有键盘（开发构建里还有模拟器）。健康报告照常记录憋气时长、深度和结果；心率和呼吸频率需要摄像头，所以没有旧的摄像头数据时这几格不显示。
- **两边都开**，然后重启 sensor、重新构建游戏。生产环境跑在 Vercel 上，没有 `/sensor` WebSocket，所以只能用键盘：要用摄像头实时检测，得自己用 `npm start` 托管并配好 HTTPS（见「自托管」），或者构建游戏时用 `VITE_SENSOR_URL` 指向这样一个 sensor。只开服务器，游戏还是纯键盘；只开游戏，服务器会回「已关闭」，游戏自动退回键盘。

### 真机测试憋气

点 **Start with camera**，脸和胸口都要在画面里，光线要亮。

1. 先正常呼吸约 10 秒，让检测器学会你的呼吸幅度。
2. 然后憋气。左上角的标签应该变成绿色 **HOLDING**，波形会变平。
3. 一换气就会变回 **BREATHING**。

如果误判多，去调 `sensor/breath-detector.mjs` 里的常数（见第 5 节）。

### 自托管 / Self-hosting

线上版本在 <https://breathless.gotclass.xyz>，跑在 Vercel 上，每次 push 到 `main` 都会自动部署（见 deploy/VERCEL.md）。CI 运行游戏和传感器测试，以及游戏的严格 TypeScript 构建；Anchor 合约测试使用独立的本地验证器流程（见 contracts/README.md）。

`npm start` 是自托管用的服务器（2026-10-13 之前生产环境就跑它）：一个 Node 进程、一个端口，同时提供构建好的游戏、憋气传感器（WebSocket 在 `/sensor`）和 PEARL 市场（`/api/market`，见第 8 节），前面只需要一条隧道或一个反向代理。

```bash
npm run setup      # 一次性：安装 sensor/ 和 game/ 的依赖
npm run build      # 把 game/ 构建到 game/dist
npm start          # http://127.0.0.1:8794，传感器在 ws://127.0.0.1:8794/sensor
```

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PRESAGE_ENABLED` | 关 | `1` 开启 Presage 实时检测。**暂时关闭**：不设时服务器忽略 `PRESAGE_API_KEY`，也不加载 SDK（见[重新开启 Presage](#重新开启-presage)）。 |
| `VITE_PRESAGE_ENABLED` | 关 | 游戏构建时用：`1` 恢复摄像头选项。Vercel 上不要设，它提供不了 `/sensor`（见 deploy/VERCEL.md）。 |
| `PRESAGE_API_KEY` | 空 | **只放在服务器**仓库根目录的 `.env` 里。没有 key 时服务器跑模拟器。不设 `PRESAGE_ENABLED=1` 时会被忽略。 |
| `PORT` | `8794` | HTTP + WebSocket 端口。开发模式（`npm run sensor`）仍用 `SENSOR_PORT`，8787。 |
| `HOST` | `127.0.0.1` | 监听地址。只听本机，因为同机的隧道 / 代理是唯一入口。 |
| `MAX_LIVE_SESSIONS` | `1` | 同时使用 Presage 实时检测的玩家数。SDK 的原生状态是进程全局的，一个进程里跑不了两个会话；设成 `0` 关闭实时检测。超出上限的玩家会看到 "Server busy"，自动改用键盘玩。 |
| `MAX_CONN_PER_IP` | `8` | 每个玩家 IP 可同时打开的传感器连接数（代理在本机时读 `CF-Connecting-IP` / `X-Forwarded-For`）。 |
| `SENSOR_RECORD` | 关 | 设成 `1` 才把实时会话写进 `sensor/recordings/`。serve 模式默认关闭：陌生人的呼吸数据绝不落盘。（开发模式照旧录制。） |
| `FISH_MARKET_PROGRAM_ID` | 空 | PEARL 市场模式：空 = 服务端模式，填 program id = 合约模式（第 8 节）。 |
| `MARKET_DIR` | `sensor` | 市场的密钥和状态文件（`.market-*`）放在哪，相对仓库根目录。更新代码时不要覆盖或删除它们；记得备份。市场起不来时，游戏和传感器照常服务，`/api/market` 返回 503。 |
| `SOLANA_RPC` | devnet | 服务器端所有 Solana 调用用的 RPC：市场、鱼合集、付款和销毁（没设就用 `VITE_SOLANA_RPC`，再没有就用 `https://api.devnet.solana.com`）。公共 devnet 节点限流很严，有人批量卖鱼就会返回 HTTP 429，所以线上应换成服务商提供的专用 devnet RPC。这个 URL 通常带 API key：**只**放在服务器的 `.env` 里，不要提交进仓库，也不要放进任何 `VITE_*` 变量（它们会打包进前端）。日志里只打印它的域名。 |
| `SOLANA_RPC_CONCURRENCY` | `3` | 市场同时在途的 RPC 调用数。遇到 429 时所有调用一起退避；只有付费 RPC 套餐才需要调大。 |

- **摄像头必须走 HTTPS。** 浏览器只在 `https://` 页面（或 `localhost`）上允许 `getUserMedia`，所以要在 `127.0.0.1:8794` 前面放一条隧道（如 Cloudflare Tunnel）或带 TLS 的反向代理。构建出的游戏会自动连 `wss://<同一域名>/sensor`；构建时设置 `VITE_SENSOR_URL` 可以改连别处。
- **Solana RPC 抖动不会拖垮服务器。** 市场的所有 RPC 调用都经过同一个限流器（`SOLANA_RPC_CONCURRENCY`），遇到 429 统一退避；交易确认改为 HTTP 轮询（不再开 websocket 订阅）。付款后销毁失败的鱼会在内存里重试；启动时和之后每 10 分钟，市场会按售出账本把已付款、还没销毁的鱼销毁掉：每条鱼只查一次账户，不扫全链，遇到 429 就提前停下等下一轮（日志里是 `[market] sweep: ...`）。偶发的未处理 Promise 拒绝只会记一行 `[process] unhandled rejection (kept running)`，进程不退出；`[process] BUG: ...` 开头的是代码错误，需要看一下。
- **生产环境是 Vercel**（2026-10-13 起）：游戏作为静态文件，所有 `/api` 路由放在一个函数里，市场状态存在 Upstash Redis。Vercel 通过自己的 GitHub 集成在每次 push 到 `main` 时部署，每个 PR 分支都有一个 Preview。没有 `/sensor` WebSocket，只能用键盘模式。配置、环境变量、用测试钱包预览、回滚坏部署见 [deploy/VERCEL.md](deploy/VERCEL.md#中文)。GitHub Actions（`.github/workflows/ci.yml`）只跑测试和构建，不部署任何东西。
- **原来的 Dell 部署已经退役。** 2026-10-13 之前，生产环境在团队的一台机器上跑 `npm start`（systemd + self-hosted GitHub Actions runner + Cloudflare Tunnel）。相关脚本（`deploy/SETUP.md`、`deploy/deploy.sh`、`deploy/bootstrap-dell.sh`、systemd unit 和 sudoers 文件）已从仓库删除；想按老办法自托管，可以在 git 历史里找到它们。
- **带宽。** 实时模式把每一帧 640×480 画面压成 JPEG 上传，30 fps，**每个玩家约 3–6 Mbit/s 上行**（Chrome 质量 0.7：画面简单时每帧 16–20 kB，画面杂乱时 30–35 kB）。Presage 要约 25 fps 以上，低于约 15 fps 波形会变差，所以游戏优先保帧率、牺牲画质：目标每帧 25 kB（30 fps 即 6 Mbit/s），帧偏大或上行太慢导致跳帧时，JPEG 质量在 0.8 到 0.4 之间自动下调。约 5 Mbit/s 的上行在一般画面下能保持 30 fps；更慢就会跳帧。sensor 用 [sharp](https://sharp.pixelplumbing.com/)（libvips）解码：每帧约 2 ms，在独立线程上跑，比原始帧多占约 3% 的单核。键盘和模拟模式不发帧。
  - 开发构建连本机 sensor 时仍默认发原始 RGBA（每帧 1.23 MB，30 fps 约 295 Mbit/s，只在同一台机器上用）。在页面 URL 后加 `?frames=raw` 或 `?frames=jpeg`（或构建时设置 `VITE_FRAME_FORMAT`）可以强制使用其中一种。
  - 不用摄像头检查某个部署的上行链路：在玩家的网络里运行 `node sensor/stream-test.mjs wss://<你的域名>/sensor`，它会连续 20 秒发送合成的 JPEG 帧，打印上行速率、跳过的帧数和 Presage 接收的帧数（可选 `--raw`、`--fps`、`--quality`、`--image face.jpg`）。

---

## 3. 操作方式

所有下潜按键都可以在 **设置 → 操作**（设置桌，或任意一张桌子上）里改键。按键绑定按设备保存（`deepbreath.controls`）。默认值如下：

| 键 | 作用 |
| --- | --- |
| `←` `→` `↑` `↓` / `WASD` | 向左 / 右 / 上 / 下游（在水面不憋气时不能下潜） |
| `Shift`（按住） | 憋气（键盘模式和模拟模式） |
| `Space` | 挥网抓鱼 |
| `Tab` | 把快捷栏翻到鱼袋，再按翻回来 |
| `Q` / `E` | 上一件 / 下一件装备 |
| `1`–`6` | 快速切换装备（固定，不能改键） |
| `V` | 声纳 |
| `F` | 在船边的水面上爬上船；连按可以把翻了的船推正（汪洋风暴） |
| `N` | 渐变切换上午 / 夜晚；自然循环与下午可在设置中选择 |
| `K` | 切换呼吸输入：presage → sim → keyboard（Presage 关闭时只有 keyboard；开发构建里还有 sim） |
| `C` | 收藏和 NFT 面板（可勾选批量卖出） |
| `G` | 鱼竿 / 渔网升级面板 |
| `B` | 插画潜水手册和新手教程 |
| `H` | 健康报告（只在你按的时候生成） |
| `Esc` | 上船 / 返回（固定）。先关闭打开的面板；下潜途中直接回到工作台，没有暂停菜单；在桌子上则退回上一步 |
| `Enter`（主页面） | 等于点 START 鱼 |

按 `B` 打开或合上插画潜水手册和新手教程。手册分成六章：工作台组装、装备打包、下潜、抓鱼、返航和深潜声纳。第一次进入时会询问是否开启全程引导；选择和已完成步骤会保存在本地。打开手册时游戏会暂停，按 `Esc` 或 `B` 合上。

**主页面**：进入时一根绳子（两端都在屏幕外）从左边荡出、挂到右边，然后几条鱼从上方掉下来，用鱼线挂在绳子上。按钮名字印在鱼身上。名字长（4 个字符以上）的鱼用头、尾两根鱼线横着挂；两根线像滑轮一样自动调长短，所以绳子倾斜的地方鱼和字也保持水平。点金色的 **START** 鱼（或按 Enter）：镜头下移到工作台（绳子和鱼升到屏幕顶部，仍然可以拖）；其他的鱼通向各张桌子：**AQUARIUM**（你的鱼缸）、**HEALTH**（你的出海报告）和 **SETTINGS**（设置）。**GUIDE** 和 **TUTORIAL** 挂在它们后面的第二根绳子上。除了标题画面，屏幕上始终有一个可拖动的手册 / 教程入口。鱼和绳子都能用鼠标拖、甩，划过时会被推开。系统开了"减少动态效果"时跳过入场动画。

**工作台**（`workbench.ts`，海图在 `chart.ts`）：斜视角的木桌（2.5D，单独的 Three.js 场景），中间放着一张折起来的海图，右边是准备区（READY）。
- 装备（脚蹼、应急气瓶、头灯、鱼竿、渔网、鱼饵）以 3D 模型从上方掉下来砸在桌上：会弹起、扬起一圈灰、镜头震一下，旁边的东西也会跳起来。物理是手写的：重力、桌面反弹、桌面上的圆形碰撞。
- 鼠标移到装备上显示名字和效果。点一下放进右边的准备区（绿圈）；在准备区里再点一下就扔回桌上。也可以拖动（拖到准备区就算准备好）和甩出去。
- 主页面的绳子在工作台上被拉紧，横在屏幕上方约五分之一高的位置，鱼线收短，鱼紧挨着挂在绳子下面，完全在桌子上方、不挡桌面，在桌面上投下柔和的影子。装备也可以放在海图上；点海图时，上面的东西会跳下来散在旁边。
- 海图是一张模拟的纸（`paper.ts`，高度场）：它"记得"中间的折痕，纸的刚度会把褶皱慢慢抚平。在桌上它四边贴着桌面，只有中间的折痕微微隆起；压在海图上的装备会把那一块压平，旁边有东西砸下来时纸边会弹起再落回桌面。拿在手里时两端会微微卷起。鼠标在纸上移动时，只在鼠标附近压出褶皱，方向和移动方向垂直，停下后褶皱会慢慢抚平。被拿着移动时会因惯性稍微下垂，再恢复，不会像果冻一样抖。
- 点海图：海图被拿起来、展平（两端仍然微微卷着），送到屏幕中央、浮在虚化的桌面上方，像拿在手里一样跟着鼠标轻微倾斜晃动，地点标记贴在纸上跟着动，上面有三个地点，每章一个（I 峡湾、II 天池、III 汪洋；地点的难度就是游戏难度）。每个地点都可以直接选，海图上不用解锁。选中一个地点时，桌子后面的世界会切换到那张地图，右边面板显示从下潜起点渲染的这张地图的预览图、介绍和已准备的装备，然后点 **Dive · 下潜**（或再点一次那个地点、或按 Enter）：预览图从面板扩散到全屏，下面的游戏画面正好是同一个视角，预览图再淡出，做到无缝衔接；接着是开始卡片（摄像头 / 键盘 / 憋气测试）。点海图外面或按 Esc 把它折回桌上。
- 在空桌面上按 Esc，镜头移回主页面。
- 带上的装备会传给游戏（`loadout`），但升级效果还没接进潜水玩法。

**桌子与上船**：没有暂停菜单。切到别的浏览器标签页，或在下潜中按 `Esc` 或 `F`，都会让你上船回到工作台，下潜停在原处；在桌上按 `Esc` 继续下潜。在水下恢复时会先倒数 3 秒，让玩家吸一口气再憋住，否则离开期间的换气会被直接判成“水下呼吸”。AQUARIUM、HEALTH 和 SETTINGS 三张桌子在标题画面和任意一张桌子上都能用，包括下潜途中上船后：3D 玻璃鱼缸、健康桌（最新的出海报告摆在纸上，更早的放在罐子里）和设置桌（语言、操作、时间段、删除我的健康数据）。回到主页面会释放摄像头和 sensor 连接；网里有鱼时会先弹确认，鱼会丢失，但这次憋气仍然记进健康数据。

**HUD**：快捷栏在屏幕底部中央（`Tab` 翻到鱼袋），摄像头预览在左上角，呼吸读数浮在潜水员头顶。没有 BANKED 面板。

**语言**：设置里可以选语言，English 或 中文，一次只显示一种（`deepbreath.language`）。

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

**玩家数据存在链上。** 装备、PEARL、鱼缸和进度都从 Solana 读取（`player-chain.ts`、`player-sync.ts`、`player-state.ts`）；服务器不存任何玩家数据，`localStorage` 只是缓存。健康和呼吸数据是例外：它们永远不离开浏览器（第 9 节）。

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
  - 背压：`ws.bufferedAmount` 超过 100 kB（JPEG）或 4 帧（原始）时浏览器跳过帧；最多每秒发 30 帧；JPEG 最多同时编码两帧，按采集顺序发出（`game/src/frame-pump.ts`）。
  - 采集（`game/src/breath.ts`、`camera-encoder.worker.ts`）：Chrome 和 Edge 把 `MediaStreamTrackProcessor` 交给 worker，由 worker 用 `OffscreenCanvas.convertToBlob` 编码，所以发送帧率跟着摄像头走，不受游戏渲染帧率限制。Safari 和 Firefox 把页面每次呈现的视频帧以 `ImageBitmap` 交给同一个 worker。没有 worker 时页面用 `canvas.toBlob` 编码；Chrome 只在主线程空闲时才执行它，繁忙的 three.js 页面最低只能得到约每秒 1 帧。标签页隐藏时不发任何帧（Presage 按测量计费），回到前台后继续发送。
- **JSON 命令**：`{ "t": "sim", "on": true }` 开关模拟；`{ "t": "simHold", "holding": true }` 设置模拟憋气；`{ "t": "seed", "baseline": 0.8 }`（也接受 `"type": "seed"`）把之前连接 `state` 里的实时基线交回来（模拟模式下 `baseline` 永远是 null）。只有本连接还没有基线、且它是 [0.001, 1000] 内的有限数时才采用，否则忽略。只留在内存里：不打日志、不写盘。`{ "t": "stats", "pipe": "mstp", "camFps": 30, "capFps": 29.9, "rvfcFps": 14.2, "renderFps": 14.1, "sentFps": 29.8, "skippedEncoder": 0, "skippedBackpressure": 2, "encodeMsAvg": 5.1, "quality": 0.7 }` 在实时模式下每 ~10 s 发一次：摄像头管线的性能数字（摄像头自报帧率 `getSettings().frameRate`、采集到的帧、`requestVideoFrameCallback` 和渲染帧率、发出和跳过的帧、编码耗时、JPEG 质量），绝不含呼吸或健康数据。sensor 只保留这些字段，且必须是有限数并截到合理范围（`sensor/client-stats.mjs`），只追加到每分钟一行的 `frames, last 60 s` 日志里，不录制、不另存。

**sensor → 浏览器**（每 80 ms 一次）

```jsonc
{
  "t": "state",
  "source": "presage" | "sim",
  "status": "running", "hint": "Move closer…",   // ValidationCode 翻译后的提示
  "rate":  { "value": 15, "confidence": 90 },     // 呼吸频率（需要约 30 s 窗口）
  "pulse": { "value": 72, "confidence": 90 },     // 心率
  "frames": 1234,
  "holding": true, "holdMs": 8200, "releasing": false,  // releasing：换气待确认
  "calibrated": true,  // 能判定憋气了：基线已知且已过预热（warm）
  "warm": true, "baseline": 0.8,  // baseline：学到或收到 seed 之前为 null；游戏留着它下次当 seed
  "flatness": 0.93, "apnea": false, "talking": false,
  "trace": [ /* 最近 90 个胸部起伏采样 */ ]
}
```

错误以 `{ "t": "error", "message": "…" }` 发送。`"code": "busy"` 表示实时 Presage 名额（`MAX_LIVE_SESSIONS`）已满：游戏停止发帧，改用键盘。Presage 关闭时（没设 `PRESAGE_ENABLED`），请求摄像头的游戏会收到一次同样的 `busy`，附带 `"reason": "off"`，所以任何版本的游戏都会退回键盘。`"code": "frames"` 表示 sensor 解不了 JPEG（没装 sharp）：游戏改发原始帧。

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

1. **只学一次基线**：启动后前 8 秒不学；之后取接下来 6 秒正常呼吸的活动量，用**中位数**当基线 B，不受偶尔乱跳的影响。B 随后**固定不变**，潜水前后的深呼吸、大口喘气都拖不动它，而且**永不重学**：同一连接里 Presage 重启（重开摄像头、卡顿、出错）会沿用它；游戏重连时把它作为 `seed` 发回，所以新一次下潜跳过学习，只等新管线 3 秒。
2. **判定憋气**：最近 2 秒的活动量小于 `0.38 × B`。
3. **判定换气，主要靠吐气**：记住憋气时曲线的“水平线”。它会跟着憋气后的缓慢回落走，但曲线乱跳时冻结，不被假动作带跑。曲线从水平线、同时也从最近 1.5 秒的最高点往下掉超过 `1.1 × B`，并持续 0.1 秒，就算换气。往上跳超过 `2 × B` 也算，对应空着肺憋气、先吸气的人。
4. **刚判成憋气的头 2 秒**：这时可能只是两口气之间的停顿，所以活动量一回来（0.75 秒内大于 `0.5 × B`，持续 0.2 秒）就算换气。
5. **兜底**：2 秒活动量连续 4 秒大于 `0.8 × B`，也算换气，这样永远不会卡死在憋气。说话超过 0.5 秒也算换气。
6. **短暂波动容错**：上面的吐气、吸气、开头活动量这几条只会进入“待确认换气”（state 里 `releasing: true`，`holding` 仍为 true）。如果 0.8 秒内曲线回到憋气水平线 `0.5 × B` 以内、并安静地停住 0.3 秒，就当作一次波动（尖峰、短暂下沉、点头），憋气照旧，开始时间不变；否则确认换气，原因沿用触发它的那条。真正吐气现在约 1.3 秒后结束憋气（以前约 0.5 秒）。说话和 4 秒兜底仍然立刻结束憋气。
7. **刚换完气**：2 秒内不会马上又判成憋气。
8. **游戏侧防抖**（`main.ts` 的 `RELEASE_DEBOUNCE_MS`）：水下“换气”必须持续 0.5 秒才算。

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
| `minBaselineUs` | 6 s | 只学一次的正常呼吸时长，学完才开始判定憋气，之后基线固定 |
| `releaseConfirmUs` / `settleUs` / `settleRatio` | 0.8 s / 0.3 s / 0.5 | 波动容错：触发换气后有 0.8 秒确认，期间曲线回到水平线 0.5 × B 以内并安静 0.3 秒就算波动 |
| `seededWarmupUs` | 3 s | 基线已知时的预热：这时启动乱跳不会被当成憋气，只需一个 2 秒活动窗口加余量 |
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
├── scripts/ensure-deps.mjs 游戏和 sensor 启动前运行：自动安装缺少的依赖
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
    ├── tests/              node --test：画质、昼夜、天气与鱼经济的单元测试
    └── src/
        ├── main.ts         入口：场景、阶段机（menu/calibrating/play/blackout）、主循环、输入、入库
        ├── breath.ts       BreathSource：摄像头抓帧推送、WS 状态、键盘/模拟模式
        ├── breathtest.ts   标题页的 2.5 分钟憋气测试：按提示憋气和呼吸，自动打标注
        ├── world.ts        按所选地图生成的水下地形（前两张地图的完整深水海底、仅汪洋保留的海沟岩壁、礁石、珊瑚、海带）、光束、雪、水面、船；按深度变化雾和颜色；昼夜
        ├── seabed-layout.ts 沙地高度网格，以及每张地图的岩石堆、后方叠石墙、海带林和海草甸的位置
        ├── kelp.ts         四种植物（巨型海带、海草、阔叶海带、海蕨）合成的一个平面着色网格
        ├── kelp-motion.ts  植物怎么动：水流、涌浪、叶尖抖动、潜水员的尾流（着色器和测试共用）
        ├── flora.ts        每张地图长什么、什么颜色；叶色随深度怎么变
        ├── daylight.ts     连续 24 小时光照模型、12 分钟自然循环、上午/下午/夜晚的平滑预览
        ├── sky.ts          大气天空、随时间移动的太阳/月亮与分层云层
        ├── color-grade.ts  场景材质共享的晨间、午后、夜间调色
        ├── sunshafts.ts    单次绘制的柔和水下日光散射
        ├── water.ts        GPU 海浪、折面色彩与折面化的日光/月光光路
        ├── water-geometry.ts 稳定且无裂缝的三角网格及折面反光属性
        ├── shark.ts        汪洋夜晚的鲨鱼：心率怎么决定数量、感知、速度和咬力；怎么游（纯逻辑）
        ├── shark-fx.ts     低多边形鲨鱼模型，以及转身、俯仰和摆尾
        ├── storm.ts        大风大浪的规则：巨浪什么时候来、浪的形状、翻船和船的姿态、损失什么（纯逻辑）
        ├── storm-fx.ts     巨浪的样子：浪头泡沫、水花、撞击时的爆开、落水的货和鱼
        ├── weather.ts      自然天气轮换、晴/云/雨/风暴的平滑过渡
        ├── rain.ts         单次绘制的 GPU 雨丝，按画质限制雨量
        ├── maps.ts         三张地图的定义（开放区域和大陆架深度、解锁价值、配色）和保存的地图进度
        ├── scenery.ts      每张地图水面以上的场景
        ├── aurora.ts       峡湾的极光：光柱帘幕、什么时候出现、水面映出的光
        ├── lowpoly.ts      共用的低多边形工具：flat 材质、顶点抖动、按面上色、把静态部件按材质合并成一个网格的 batcher
        ├── mappicker.ts    开始卡片上的地图卡片
        ├── diver.ts        低多边形潜水员、踢腿、网、头灯、气泡
        ├── gear.ts         鱼竿概念对应的渔网模型：握把、线轮、杆身、网圈和网格
        ├── equipment.ts    鱼竿等级、Pearl 余额、本地存档和升级规则
        ├── gear-panel.ts   鱼竿 / 渔网升级面板
        ├── upgrades.ts     升级定义与工作台模型入口
        ├── fish.ts         稀有度表、区域名、物种名、rollFish(seed, depth)、按深度的捕获价值、鱼的网格、游动和逃跑 AI
        ├── marine.ts        非鱼类物种：鲨鱼、章鱼、灯笼鮟鱇、海龟和水母（与 fish.ts 合计 35 个物种）
        ├── fish-card-geometry.ts 绘制鱼卡；游戏内的卡和 NFT 图片共用这份代码（打包进 sensor/fish-card.gen.mjs）
        ├── depth-odds.ts   按深度的掉率（RARITY_BY_DEPTH）、zoneName(depth)；没有依赖，测试在 tests/depth-odds.test.mjs
        ├── rng.ts          mulberry32 种子随机数
        ├── portrait.ts     离屏渲染：fishIcon（192 px）和 fishCard（512 px，NFT 卡图）
        ├── hud.ts          呼吸面板和波形、深度计、紧急条、网格槽、入库数、toast
        ├── vault.ts        收藏面板：NFT 状态、Sell / Mint & sell、钱包栏
        ├── market.ts       纯经济规则：NFT 状态机、旧存档迁移、卖价、累计解锁价值
        ├── nft-queue.ts    后台铸造和卖鱼队列（懒加载 chain.ts 和 pearl.ts）
        ├── pearl.ts        PEARL 客户端：余额、卖鱼、消费（服务端是 sensor/market.mjs）
        ├── chain.ts        Umi、临时钱包、空投、mintFish、burnFish
        ├── player-chain.ts  链上的玩家操作：装备、制作、合成和喂食在一笔交易里销毁 PEARL
        ├── player-sync.ts   以链为准读取状态；localStorage 只是缓存
        ├── player-state.ts  player_state 程序的客户端（PlayerState 和 Aquarium 账户）
        ├── polyfills.ts    Buffer 和 global 全局变量
        ├── health.ts       HealthLog：每次潜水记录憋气时长、心率、恢复时间
        ├── report.ts       健康报告：指标卡、两张图、解读文字、存 PDF、删除数据
        ├── trip.ts          出海：从第一次下潜到回港的统计，然后生成出海报告
        ├── health-desk.ts   健康桌：最新的出海报告摆在纸上，更早的放在罐子里
        ├── controls.ts      可改键的操作（设置 → 操作），按设备保存
        ├── pause.ts        Esc 暂停菜单：继续（水下 3 秒倒数）、设置、回到主页面
        ├── title.ts        主页面：Verlet 绳子 + 鱼线挂鱼，鼠标拖拽和推动，START / SETTINGS 鱼是按钮
        ├── workbench.ts    工作台：2.5D 桌面场景、装备掉落物理、准备区、展开成三个地点的海图
        ├── table-scene.ts   各张桌子：鱼缸、健康桌和设置桌，任意一张桌子上都能进入
        ├── aquarium-tank.ts 3D 玻璃鱼缸和里面的鱼
        ├── chart.ts        海图绘制（折起的地图贴图和展开后的海图）
        ├── settings.ts     玩家设置（画质、光照效果、天气、摄像头小窗、操作提示），存 localStorage
        ├── render-quality.ts  自动画质：按设备选初始档位，持续掉帧时降档
        ├── showcase.ts     展示页（`/showcase.html`）：README 顶部 GIF 的场景，用的是游戏里的潜水员和鱼模型
        └── style.css       深色玻璃风 HUD
```

---

## 7. 游戏设计参数

17 个鱼种和鱼竿的图片、每个鱼种的参数，见[素材库](assets/README.zh-CN.md)。

### 深度分区与掉率（`depth-odds.ts` 中的 `RARITY_BY_DEPTH`）

峡湾在约 60 米处有完整海底，天池在约 100 米处有完整湖底；只有汪洋在 62 米大陆架下继续无限海沟。有限地图的最后一个区域延伸至名义海底上方 2 米：海带林为 18–58 米，深水盆地为 38–98 米。鱼群数量随深度跨度增加，新增深水区也有鱼可捕。掉率和捕获价值仍只看绝对深度：峡湾海带林里的 30 米和汪洋珊瑚礁的 30 米抽法完全一样。

稀有度是抓到鱼时所在深度的平滑函数：下表是各锚点深度的百分比权重，锚点之间线性插值，350 m 以下保持不变。epic 只在 15 m 以下出现，legendary 在 30 m 以下，mythic 在 50 m 以下。锚点间距按实测游速约 7.75 m/s 设计：憋气 30 秒不抓鱼能下到约 115 m 再回来，60 秒约 230 m。

| 深度 | common | uncommon | rare | epic | legendary | mythic |
| --- | --- | --- | --- | --- | --- | --- |
| 0 m | 90 | 9.5 | 0.5 | – | – | – |
| 15 m | 80 | 17 | 3 | – | – | – |
| 30 m | 68 | 24 | 7 | 1 | – | – |
| 50 m | 58 | 28 | 10.5 | 3 | 0.5 | – |
| 80 m | 48 | 31 | 14 | 5.5 | 1.3 | 0.2 |
| 120 m | 39 | 32 | 18 | 8 | 2.4 | 0.6 |
| 200 m | 30 | 30 | 22 | 12 | 4.5 | 1.5 |
| 350 m+ | 22 | 26 | 25 | 16.5 | 7.5 | 3 |

夜晚每条鱼掷两次稀有度，取更稀有的那次（`main.ts` 中的 `rollFor`）。

按一网 6 条鱼算（Lv1 渔网；白天，期望条数 = 6 × P(legendary 或 mythic)）：80 m 是 6 × 1.5% = 0.09，大约每 11 网出 1 条 legendary 及以上；120 m 是 6 × 3.0% = 0.18，大约每 5.6 网 1 条。

### 捕获价值（`fish.ts` 中的 `rewardMultiplierAt`）

| 深度 | 0–18 m | 18–38 m | 38–60 m | 60 m 以下（The Trench） |
| --- | --- | --- | --- | --- |
| 奖励倍率 | ×1.0 | ×1.6 | ×2.5 | ×2.5，60 m 以下每深 50 m 加 1，最高 ×6（235 m 达到） |

**捕获价值** = 稀有度的 `value`（见下表）× 这条鱼生成时所在深度的奖励倍率，四舍五入。同一条 rare 鱼，在浅水区值 10，在珊瑚礁值 16，在深渊值 25，在 110 m 值 35，235 m 以下值 60。它在提示、HUD 和收藏卡片上显示为 “pts”，收藏按它排序，铸造时写进 NFT 元数据的 `Catch value`，地图解锁也按它累计，卖鱼时也按它支付 Pearls。这次改动之前入库的鱼没有存这个值，按原来的稀有度 value 计算。

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

`SWIM_ACCEL 24` · `DRAG 2.4` · `MAX_SPEED 7.5` · `SURFACE_DEPTH 0.9` · `EMERGENCY_SECONDS 3.2`（换气后的剩余时间）· `EMERGENCY_LIFT 18`（紧急上浮力度）· `FISH_PER_ZONE [32, 32, 24]`（每个区域的鱼数，只放地图在大陆架上开放的区域）· `TRENCH_FISH 12`（海沟里跟着潜水员深度走的一群鱼，每条按它出生的深度抽稀有度）（仅汪洋生成无限海沟）

大陆架上的可游玩海域横向宽度为 280 米（`x = -140…140`）；下到大陆架以下时，海沟两壁把潜水员限制在船下方。潜水员移动和相机预判共用同一边界夹紧逻辑，抵达两侧时不会看到地图外的空白区域。

网的容量和收网范围不再是 `main.ts` 里的常数，而是由下面装备的渔网等级决定。

### 鱼竿 / 渔网升级（`equipment.ts` 中的 `ROD_TIERS`）

鱼竿概念在当前融合版中落地为潜水员手持的渔网。升级只影响装备，不会延长憋气时间。

| 等级 | 名称 | 容量 | 收网范围 | 升级消耗 |
| --- | --- | ---: | ---: | ---: |
| Lv1 | Basic Net | 6 | 2.4 m | 初始 |
| Lv2 | Reinforced Net | 8 | 2.8 m | 300 Pearls |
| Lv3 | Abyssal Net | 10 | 3.2 m | 1200 Pearls |

**经济**：入库不给钱。每条入库的鱼进入 NFT 队列（`pending → minting → minted`，失败则为 `failed`，自动退避重试，也可以手动 Retry）。Pearls 只来自在收藏里**卖鱼**：NFT 被销毁，并按捕获价值支付 PEARL（一种 SPL token，见下文「PEARL coin」）。还没铸造的鱼显示 **Mint & sell**（市场只收 NFT），正在铸造的鱼暂时不能卖，epic 及以上稀有度要二次确认，"Sell all commons" 会逐条卖掉普通鱼。升级消耗（销毁）PEARL。黑屏丢网不奖励。规则在 `game/src/market.ts`，后台队列在 `game/src/nft-queue.ts`。

**卖鱼功能之前的存档**：旧规则下入库的鱼已经在出水时付过 Pearls，所以标记为 legacy：显示 "Paid out"，不能卖，也不会自动铸造（保留手动 Mint 按钮）。已经赚到的 Pearls 变成本地的 legacy 余额，和 PEARL 合并显示，消费时先扣它。升级状态保存在 `deepbreath.equipment`。

![Rod and net upgrade preview](game/public/rod-upgrades-preview.png)

---

## 8. Solana NFT

**全部跑在 devnet，代码都在浏览器里（`game/src/chain.ts`）。**

- **钱包**：第一次打开收藏面板时，自动生成一个临时 keypair，存在 `localStorage['deepbreath.wallet']`。这是 devnet 专用的测试钱包，私钥就在浏览器里，**不要往里放任何主网资产**。
- **充值**：面板上有 "Airdrop 1 SOL" 按钮，但公共 devnet 水龙头经常 429 限流。更可靠的办法是去 <https://faucet.solana.com>（GitHub 登录）给面板上显示的地址领币。
- **铸造队列**（`nft-queue.ts`）：后台一次铸造一条，刷新页面后继续。钱包 SOL 不够时先试一次空投；水龙头拒绝的话，铸造暂停，收藏面板里提示 "needs devnet SOL"，之后每分钟或打开面板时再查一次余额。
- **铸造流程**（`mintFish`）：
  1. `fishCard(spec)` 生成 PNG，用 `umi.uploader.upload` 传到 Irys devnet。
  2. 用 `uploadJson` 上传元数据：name、symbol `DIVE`、description、image、attributes（Rarity / Species / Zone / Map / Depth / Length / Weight / Catch value / Seed）。
  3. 用 mpl-core 的 `create` 铸造 Core asset，同时挂一个链上 **Attributes 插件**（rarity / species / depth / value / seed），方便以后的游戏逻辑直接在链上读稀有度，市场也按收藏里显示的捕获价值付款。记录的深度是抓到鱼时的深度，最多记 1000 m（`fish.ts` 的 `MAX_RECORDED_DEPTH_M`）；HUD 仍显示真实深度。
  4. 资产地址写回 `FishSpec.assetId`，持久化到 bank。卡片会显示 "✓ On-chain"，链接到 Solana Explorer。
- **Metaplex Core 合集**：每条捕获的鱼都是 Breathless 合集里的一个 Metaplex Core NFT，由服务器共同签名铸造。
- **画面一致**：NFT 图片与游戏内的卡由同一份代码绘制（`game/src/fish-card-geometry.ts`，打包进 `sensor/fish-card.gen.mjs`），所以你看到的卡就是你拥有的卡。6 个稀有度共 35 个物种（`fish.ts`、`marine.ts`）。
- **卖鱼**（NFT 消耗）：`pearl.ts` 的 `sellToMarket` 把 NFT 卖给 PEARL 市场，市场销毁它并按捕获价值支付 PEARL（见下文「PEARL coin」）。
- **鱼缸喂食**：给鱼缸里的鱼喂食会在链上销毁 PEARL，鱼会长大。
- **可选环境变量**：`VITE_SOLANA_RPC`（默认是 `https://api.devnet.solana.com`）。注意：所有 `VITE_*` 变量都会打包进前端，**不能放密钥**。
- **为什么 Vite 要加 polyfill**：Umi 和 Irys 依赖 Node 的 `Buffer`、`stream`、`crypto`，所以 `vite.config.ts` 用了 `vite-plugin-node-polyfills`。

### PEARL coin / 珍珠币

游戏货币珍珠是 devnet 上真正的 SPL 代币 **PEARL**（decimals 0）。客户端是 `game/src/pearl.ts`（`pearlBalance`、`sellToMarket`、`spendPearls`），由 `wallet.ts` 里的 owner 钱包签名（现在是临时钱包，以后换成 Phantom）。服务端是 `sensor/market.mjs`，同源挂在 `/api/market/{info,quote,sell}`。市场启动时选定模式：

- **合约模式**（设置了 `FISH_MARKET_PROGRAM_ID`）：PEARL 的 mint 归 Anchor 合约 `fish_market` 所有（PDA `pearl`）。一条 `sell_fish` 指令原子地烧掉鱼并给卖家铸 PEARL，同时强制执行 `config.max_value`。服务端只当**预言机**：`POST /api/market/quote` 检查卖家确实持有这条鱼、价值合理，然后返回一笔它已部分签名的 `sell_fish` 交易。玩家签名、发送，并支付手续费。
- **服务端模式**（兜底）：市场钱包自己创建 PEARL mint 并持有铸币权。玩家把鱼转给市场钱包，`POST /api/market/sell` 在链上核验这笔转账，铸 PEARL，再烧掉鱼。`sensor/.market-state.json` 里的已售集合保证重试安全（不会重复付款）。
- **消费**：两种模式下，`spendPearls` 都是从玩家的代币账户里烧掉 PEARL。
- **定价**：价值取自鱼的链上 Attributes（`value`），所以卖出时付的正好是收藏里显示的「Sell · N Pearls」。没有这个属性的鱼按「稀有度价值 × 深度倍率」重算（`fish.ts` 的 `rewardMultiplierAt`，`sensor/market-rules.mjs` 里有一份镜像：×1 / 1.6 / 2.5，60 m 以下每深 50 m 加 1，最高 ×6）。超过「稀有度价值 × 6」或深于 1000 m（`MAX_DEPTH_M`，与游戏的 `MAX_RECORDED_DEPTH_M` 相等，测试会检查）的直接拒绝。
- **信任模型**：这是 devnet 黑客松版本。鱼由客户端钱包铸造，所以谁都能铸一条「神话」拿来卖。稀有度上限（合约模式下再加 `max_value`）只限制单笔金额，PEARL 没有真实价值。服务端密钥（`sensor/.market-oracle.json` 或 `MARKET_ORACLE_KEYPAIR`，以及 `sensor/.market-keypair.json`）权限 600，已加入 gitignore。它们不打日志，也不放进 `VITE_*`。
- **开发**：
  - 在 `npm run dev` 旁边再跑 `npm run market`（端口 8795，可用 `MARKET_PORT` 改）。Vite 会把 `/api` 代理过去。`npm start` 自己就带市场（第 2 节「自托管」）。
  - 启动时会打印公钥。服务端模式下如果 airdrop 被限流，去 <https://faucet.solana.com> 给它领币。
  - 单元测试：`npm --prefix sensor test`。对着正在运行的市场在 devnet 上跑一遍卖鱼和消费：`npm --prefix sensor run market:e2e`。

### player_state 程序

`player_state` Anchor 程序（devnet `EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ`）把玩家数据存在链上。链是唯一的真相，localStorage 只是缓存。详情见 [contracts/DEPLOYED.md](contracts/DEPLOYED.md) 和 [contracts/README.md](contracts/README.md)。

- **v1，已上线**：装备升级、制作、合成升级和鱼缸喂食都会销毁 PEARL，并在一笔交易里更新 PlayerState / Aquarium 账户。新玩家在第一次购买时批准一次钱包（账户初始化合并在里面）。路径选择和鲨鱼咬合由 session key 处理。
- **v2，已部署到链上，游戏接入随后进行**：船部件（`buy_boat`）、船只（`set_ship`，按终身入库价值 0 / 50 / 150 / 500 / 1200 / 2500 解锁）、由预言机在每次铸鱼时通过 `record_catch` 记录的终身入库价值，以及地图门槛（天池 150，汪洋 1000）。这些目前都还没有在游戏里上线；今天所有地图仍然是开放的。

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

有鲨鱼在水里的那些下潜（见第 11 节"鲨鱼"）会被标记。被追会让心率升高，所以报告里的静息心率、潜水反射、恢复时间和心率曲线都不用这些下潜，并写明排除了几次；它们的憋气时长、深度和渔获照常计入。

出海：统计从第一次下潜到回港，然后在健康桌上用纸张生成一份出海报告（最新的放在桌上，更早的放在罐子里）。健康报告、出海报告和健康桌都带有「仅供健康参考、不是医疗建议」的提示。

隐私：健康和呼吸数据只存在浏览器的 localStorage 里，永远不会上链，也不会发到服务器。「删除我的健康数据」会删掉这台设备上所有的健康和出海数据，对所有钱包都生效。免责声明：只供健康参考，不是医疗建议；不要在水中或水边练习憋气。

> 模拟模式下的心率是假的：静息约 72 bpm，憋气时降到约 58，换气后先冲到约 86 再回落。用来在没有摄像头时演示报告。

---

## 10. 本地存储

| key | 内容 |
| --- | --- |
| `deepbreath.bank` | 入库的鱼（`FishSpec[]`，带捕获价值 `value`、地图 `map`、NFT 状态 `nft`，铸造后带 `assetId`，旧规则下已付过钱的鱼带 `legacy`） |
| `deepbreath.<owner>.<name>` | 按钱包地址分开存的数据，例如 `.trips`（出海报告）和 `.health`（潜水记录，`DiveRecord[]`，最多 300 条）；缓存的玩家状态也这样存 |
| `deepbreath.controls` | 改过的按键（设置 → 操作），按设备保存 |
| `deepbreath.language` | 语言：English 或 中文 |
| `deepbreath.wallet` | devnet 临时钱包的私钥（数字数组） |
| `deepbreath.equipment` | 鱼竿等级、缓存的 PEARL 余额和本地 legacy Pearls（`rodLevel`、`pearls`、`legacyPearls`） |
| `deepbreath.pearl.pending` | 已发出的 PEARL 卖单，超时后重试会接着走，不会从头再来 |
| `deepbreath.settings` | 玩家设置：`quality`（auto / high / medium / low）、`lightingEffects`、`weather`（auto / clear / cloudy / rain / storm）、`showCamera`、`showHelp`、`sharks`（ask / on / off） |
| `deepbreath.maps` | 地图进度：选中的地图、历史累计入库价值（`bestValue`）、演示开关 |

重置：在浏览器控制台执行 `localStorage.clear()`。

---

## 11. 调试技巧

- 开发服务器**不做类型检查**。提 PR 前请跑：`npm --prefix game run build`（会先执行 `tsc --noEmit`）。
- 控制台能直接用这些全局对象：`breath`、`diver`、`fishes`、`keys`、`debugStep(seconds)`。
- 标签页在后台时 `requestAnimationFrame` 会降到约 2 fps，可以用 `debugStep(2)` 直接模拟 2 秒。
- sensor 的日志直接看运行 `npm run sensor` 的那个终端。Presage 的状态码和 ValidationCode 提示会翻译成 HUD 左上角的黄色 hint。
- Presage 一直卡在 `starting`：检查 `.env` 里的 key，看浏览器是否真的在发帧（HUD 的 frames 计数），以及光线够不够。

### 重新录制 README 顶部的 GIF

先启动游戏（`npm run game`），再执行下面的命令。需要本机装有 Chrome 和 ffmpeg。脚本用无头 Chrome 逐帧渲染 `game/showcase.html`，输出到 `docs/showcase.gif`，首尾帧无缝循环。

```bash
npm run showcase:gif
```

### 自动画质

暂停菜单的 Settings → Render quality 默认选 Auto；也可以手动选择高、中、低档并保存，手动档位不会自动降级。已有手动设置继续生效。暂停时不参与帧率采样，切换摄像头预览或操作提示不会重置 Auto 已降到的档位。

游戏根据浏览器提供的 CPU 逻辑核心数和设备内存提示选择初始画质：不超过 4 核或 4 GB 时用低档；至少 8 核且内存提示不低于 8 GB（或浏览器不提供内存提示）时用高档；其他情况用中档。这些提示不能准确代表 GPU 性能，因此运行中还会检查实际帧间隔。

| 参数 | 低 | 中 | 高 |
| --- | --- | --- | --- |
| DPR 上限 | 1 | 1.5 | 2 |
| 渲染像素预算 | 1280 × 720 | 1920 × 1080 | 3840 × 2160 |
| 每 140 米大陆架的高海带 / 光束 / 粒子 | 12 / 4 / 300 | 30 / 8 / 700 | 55 / 14 / 1400 |
| 每株高海带配的矮植物 | 1.5（天池 2） | 同左 | 同左 |
| 水面分段 | 44 × 8 | 88 × 16 | 132 × 24 |
| 装饰动画更新上限 | 20 Hz | 30 Hz | 60 Hz |
| 水面三角形 | 704 | 2816 | 6336 |
| 日月光路 | 同一条光路，折面粗所以略宽一点 | 同一条光路 | 同一条光路，碎片最宽 |
| 日月光晕 | 核心 + 两层光晕 | + 柔和过渡 | + 宽范围晕光 |
| 每个天空像素的云层纹理采样 | 2 | 3 | 4 |
| 天空细节 | 基础云层 | + 高空薄云 / 星点 | + 云边细节 |
| 雨滴数量上限 | 160 | 420 | 800 |
| 潜水员气泡（上限 / 发射比例 / 几何） | 12 / 0.5 / 低模 | 32 / 0.75 / 低模 | 72 / 1 / 高模 |
| 气泡物理更新上限 | 20 Hz | 30 Hz | 60 Hz |

大屏幕可能使用低于 1 的 DPR 以保持像素预算；HUD 仍使用浏览器原生分辨率。启动宽限期后，连续两个 3 秒窗口平均低于 45 FPS 时降一级；降档后有 6 秒冷却，同一会话只降不升。隐藏标签页和孤立长停顿不参与判断，持续极低帧率仍会触发降档。

低档启动时关闭抗锯齿；运行中降档保留创建 WebGL 上下文时的抗锯齿设置，以免重建上下文中断游戏。装饰节流不改变潜水员主体、鱼、呼吸和光照的逐帧更新；气泡物理使用上表对应的画质更新上限。头灯、昼夜、雾色和 NFT 卡图分辨率保留。夜间与深水里不可见的光束直接停止渲染。海底所有植物是同一个网格，在顶点着色器里摆动，降档只是用更少的植物重建这个网格，留下的植物位置和形状不变。

潜水员气泡从面罩与呼吸管锚点生成，受浮力和横向阻力上浮，寿命末段淡出并清理。低、中档使用低模气泡并限制粒子数量，高档使用细分几何和完整发射比例。切换画质时会裁剪超出预算的活跃气泡，并在释放旧共享几何前重新绑定剩余粒子。

潜水员靠近水面时会显示共享水纹，入水或出水会短暂扩散；船上的航行灯和柔和水面补光使用与场景相同的昼夜、云量和光照开关状态，使潜水员下潜后仍能自然看到船体，不会出现割裂的独立光照风格。

- `npm --prefix game test`：画质分级、像素预算、持续卡顿、后台恢复和降档冷却测试。
- 控制台查看 `renderQuality.level` 和 `renderQuality.settings`，确认当前档位与预算。

### 自然昼夜与水面反光

默认从游戏时间 09:00 开始，每 12 分钟完成一轮 24 小时循环。天光、地平线色、主光方向与强度、水下雾色和光束连续变化：上午清爽微暖，下午偏金，傍晚逐渐转暗，夜间为冷蓝月光。可见的太阳和月亮与水面反光共用连续天体方向，在地平线升起、落下；光晕和云层遮挡随时间与天气变化。HUD 顶部显示当前游戏时间；暂停时自动时间停止，后台恢复后的长帧不补算。

Esc → Settings → Time of day 可选择 Natural cycle、Morning、Afternoon、Night；手动切换约 2 秒渐变，不会瞬间跳灯。暂停时可预览这些光色，恢复 Natural cycle 也会平滑衔接。夜间稀有鱼加成由实际夜色状态决定，随自然入夜自动生效。

Esc → Settings → Lighting effects 可开关太阳/月光、场景调色、光束和水面反光，默认开启，选择会自动保存。关闭时保留昼夜时间、天空与雾色、基础环境亮度和潜水员头灯；切换画质或时段不会重新开启光照效果。

海面保持低多边形风格：略不规则的三角形分别具有蓝绿色调与折面法线。日月反光是可见光源正下方的一条光路，由楔形、梯形碎片组成。一个折面的坡度正好能把光反射进镜头时才会亮，而海面坡度服从随风变宽的高斯分布（Cox–Munk）。所以光路中间密实、边缘散成零星碎光，越靠近地平线越亮（掠射角反射更强），颜色跟随太阳或月亮，起风时变宽。每块碎片是一个亮核加一圈同形状的暗边，叠加在折面本身的明暗上。光源较低时，朝镜头倾斜的折面会透出一点绿。各档画质画的是同一条光路。海浪在顶点着色器中计算，无需逐帧上传水面顶点或由 CPU 重算法线，共享顶点保持无裂缝。反光复用原水面绘制，不增加反射相机或第二次场景渲染；船与鱼没有实时镜面倒影。

太阳和月亮使用更醒目的发光圆盘，以及暖金色、冷银蓝色的分层光晕。低画质保留核心与主要光晕，更高画质补充柔和过渡。云层先衰减光源强度再合成，厚重风暴云能够遮住亮核。无需额外全屏 Bloom 或帧缓冲；压缩后的天体高度让放大的圆盘在正午也能完整显示。

水下观看时降低水面反光和不透明度。日光通过柔和、不规则的开口散射，随深度扩散和衰减，红光比蓝光更快被吸收。低 / 中 / 高档的 4 / 8 / 14 束光合并为一次绘制，夜晚、暴风雨、深水和关闭光效时不绘制。

晨间高光偏暖，午后偏金色，夜间转为低饱和蓝色。场景材质共享同一套调色参数；云量降低饱和度，入水后暖色随深度衰减，无需额外的全屏渲染或帧缓冲。关闭光效后，天空和雾色仍保持连续的昼夜变化。

- `npm --prefix game test` 还包含昼夜周期、午夜与色彩关键点连续性、手动渐变、暂停和模式恢复测试。
- 控制台可查看 `world.dayCycle.hour` / `world.dayCycle.mode`，用 `setTimeOfDay('afternoon')` 预览光色。

### 海床、岩石与水草

水下边界使用径向距离雾，渐隐两端平滑过渡。两侧渐隐从可游玩范围 ±200 米之外开始，在沙地模型到达 ±290 米前融入水色；海底前后也留出更大余量。近处的岩石、鱼和水草保持清晰，远景轮廓逐渐虚化，不增加全屏模糊渲染。水面以上的雾效保持原样，只有汪洋会为海沟岩壁放宽可视距离。

岩石模型和排列数据使用相同尺寸，避免随机变形、旋转后悬空。后方岩石采用较宽的层状岩脊，减少尖石垒柱。青苔以连片顶点颜色附着在受光、朝上的棱面，随深度衰减，到 85 米以下消失，不使用悬浮贴片。大陆架上的东西都有支撑。沙地是一张高度网格，岩石和植物按绘制沙地的同一批三角形取高度。近处的岩石成堆：一块半埋的大石，两三块靠着它的石头，周围一圈碎石；石堆之间留出沙地，潜水员游动的那条通道里没有大石。后方是从海底一块叠一块垒起来的石墙，有高有低，但没有石头悬在水里。珊瑚长在石墙和沙地上；天池的岩架从石柱里伸出来。

这里长四种植物，全部由平面四边形和三角形组成，每个面一种颜色，和沙地、岩石一致。巨型海带是森林：一节节带折角的长带，侧面长三角叶，最高约 48 米，距离水面至少留出 5 米。它围着石堆成片生长；十株里有一株长在潜水员的通道里，大约七株里有一株长在通道前面。石堆、海带林和海草甸都按大陆架的长度计数，一直铺到地图能开放的最远边界（左右各 200 米），所以两端和船下一样茂密。海草在开阔沙地上成片；阔叶海带和海蕨贴着岩石。每张地图的搭配和颜色不同（`flora.ts`）：峡湾是暗橄榄色海带配红色海蕨，天池是黄绿色水草，汪洋是翠绿海带配青色扇叶和紫色海蕨。靠近水面的面更亮更暖，深处更暗更蓝。

植物在顶点着色器里摆动。水流像一道慢波扫过整片海床，相邻的植物先后摆动；高海带弯成 S 形，顶端画圈；叶尖抖动；摇晃渔船的涌浪也带着上层的水来回晃；起风时整体更强。潜水员 4.5 米内的植物会被推开，并顺着游动方向被带一下。

- `npm --prefix game test` 检查：每块石头都落在沙地或别的石头上；植物扎根在绘制出的沙地上并避开海沟；任意画质取到的前若干株都分布在整片大陆架上；每个面只有一种颜色；根部不动，茎不被拉长。

### 鲨鱼（汪洋）

汪洋始终有鲨鱼捕猎。第一次在汪洋下潜前，游戏会显示警告，说明被咬的代价。

白天（早上和下午）下潜有 1–2 条鲨鱼，夜晚有 2–4 条。每个昼夜时段开始时抽一次数量，之后保持不变；数量不随心率变化，心率决定捕猎强度：

| 心率比静息高 | 多远发现你 | 冲刺速度 |
| --- | --- | --- |
| 4 次/分以内 | 9 米 | 4.2 米/秒 |
| 约 23 次/分 | 16.5 米 | 5.5 米/秒 |
| 42 次/分以上 | 24 米 | 6.8 米/秒 |

捕猎强度在这些数值之间平滑变化。潜水员全速约 7.5 米/秒，即使鲨鱼狂暴也有机会甩掉。追击 3.5 秒未命中就放弃，随后完整休息 14 秒（狂暴时 8 秒）；转向加速度也已降低。第一次攻击等待 5–8 秒，水面 5 米内不攻击。被咬仍会结束下潜、损失本次未结算渔获并重置潜水装备；本次削弱提高的是逃脱机会。鲨鱼棱面继续响应日光、月光和头灯，冲刺时独立呈现暖红眼睛、张颚和更强尾摆。

- **心率来源**：Presage 测到的心率，和你自己的静息心率比（静息心率在你浮在水面时学习）。键盘模式没有传感器，游戏按你游得多用力估一个心率（显示成 `♥ ~80`）：慢慢漂过鲨鱼身边可以把它压低。
- **好处**：有鲨鱼时，新刷出的每条鱼稀有度掷三次取最高（普通白天一次、夜晚两次）。
- **代价**：这些下潜不计入体检报告的心率指标（第 9 节）。
- `npm --prefix game test` 覆盖心率刻度、鲨鱼数量、咬走几条、高心率下的全速逃脱、未命中后的完整攻击间隔、水面安全区、昼夜转换、快速切换设置和关闭后离开。
- 控制台里 `sharkPack.sharks` 可以看到它们。

### 大风大浪（汪洋）

普通浪峰也有随波移动的破碎白沫，与水面合并渲染。覆盖程度随地图浪高和风力变化：平静天池几乎没有白沫，峡湾较稀疏，暴风汪洋更明显。船尾留下更长的漂移泡沫带。白沫贴合驱动船体的同一水面高度，喷雾与泡沫使用固定容量的实例池。

汪洋有自己的气候：自然天气每九分钟里大约三分钟是强风暴，分两段（另外两张地图只有一段，略短于一分钟）。汪洋的风暴还会在风力抬高的基础上把涌浪再加一倍，浪峰大约 2 米。水面还是同一张低多边形网格，只是浪更高；船会跟着龙骨下方的真实水面起伏和纵摇，水面上的潜水员也随浪升降，水面镜头最多升高 1.35 米以保持在浪峰上方。

潜水进行中且风暴够强（0.55 以上）时，开始 10–22 秒后会出现一道巨浪，之后每道过去 38–70 秒再来一道。巨浪从船的一侧 150 米外升起，是同一片水面上多出来的一道 3.2 米高的浪峰，迎面一侧陡、背面缓，以 11 米/秒横扫过来：从出现到船边大约 13 秒，屏幕上会有预警。破碎白沫贴着浪峰和水面切线漂移，细喷雾随飞行方向拉长。残留泡沫会漂移、扩散并逐渐变淡，夜间降低自发光。船先被浪面抬起、顺着浪面栽下去；浪峰离船 3.5 米时，正着的船被打翻：翻过头再回摆、船头被掀起、船身打横、被浪推出 5 米，然后摇晃着停住。水花在船上炸开，水面留下泡沫，甲板上的货（箱子、木板、桶、救生圈）和丢掉的鱼被抛进海里：货漂走，大约 20 秒后沉没；鱼游走。然后：

- 网里的鱼损失三分之一（向上取整）。
- 这次下潜打包的装备里有一件落水。那个栏位在这次下潜剩下的时间里按基础等级生效，等于没带；你拥有的装备不受影响，下次下潜就回来。渔网不会丢。
- 船底朝天时不能入库，浮上水面鱼也留在网里。

扶正：浮到离船 9 米以内的水面（船在被浪推到的位置）。屏幕正中会出现一个带进度环的大 `F`：连按它。每按一下船被推起 8.5%，船身一晃、拍起一片水，进度环涨一点；停手的话船每秒倒回去 16%。所以每秒按五下大约要按二十下（四秒），每秒不到两下永远推不过去，按住不放没有用。进度环满了船就翻过临界点，0.7 秒内落正、溅起一大片水花，并回到原来的位置。离船远的时候屏幕只提示浮到船边。离开这次下潜或重新开始也会扶正。已经翻了的船不会再翻一次。已经入库的鱼是 NFT，不会被动到。

- `npm --prefix game test` 覆盖巨浪什么时候出现、横扫用时、只翻一次、扶正要按多少下以及停手会倒回去、损失结算和两种气候。
- 控制台里，在汪洋执行 `world.setWeather('storm')` 就会起浪；`stormSea.x = -40` 会让一道巨浪四秒后到船边。

### 天气系统

峡湾的晴朗夜晚，极光由缓慢漂移的细光丝组成，下缘柔和偏绿，顶部逐渐淡成紫色。褶皱和发光由 GPU 动画驱动，无需每帧上传几何数据，也不增加绘制次数。云层会压暗极光；关闭「光照效果」会同时隐藏极光和水面反射。可在 `events-lab.html` 点击 `aurora` 预览极光爆发。

Esc → Settings → Weather 支持 Natural weather、Clear、Cloudy、Rain、Storm，并保存选择。默认自然天气从晴朗开始，每 9 分钟经历晴朗 → 多云 → 下雨 → 风暴 → 下雨 → 多云 → 晴朗；约 5 秒平滑切换手动天气，恢复自然天气时也会平滑衔接。HUD 同时显示实际天气。这里是游戏内天气轮换，不读取现实位置或气象服务。

云量影响天空、太阳/月光强度、水下光束、雾和海面反光；风力影响海浪、船的摇摆与雨丝倾斜，暴风雨增加雨量。雨丝在 GPU 上动画，最多增加一次绘制，晴朗/多云及水下不绘制雨。低、中、高画质分别最多显示 160 / 420 / 800 滴雨。大气天空仅增加一次绘制，复用一次生成的 256 × 256 无缝噪声纹理；低 / 中 / 高档分别使用 2 / 3 / 4 次云层纹理采样，低档省略高空薄云和星点。天空纹理不逐帧重绘或上传；切换天气复用材质和雨滴缓冲区。

暂停和后台冻结自动天气与雨滴动画，暂停设置仍可预览天气渐变。Lighting effects 关闭时依然保留天气，但太阳/月光、光束和水面反光继续保持关闭。天气不改变鱼群、呼吸规则和夜晚稀有鱼加成判定；夜间和阴雨海底保留环境亮度及头灯。汪洋场景中的闪电随风暴强度变化，并受 Lighting effects 开关控制。下雨时，峡湾的雪山、天池的石柱和火山口边缘、汪洋的礁柱会失去折面明暗和积雪，变成雾色的单色剪影，越近的山越深。烟囱和香炉的烟随风倾斜。本版天气系统未加入天气音效。

- `npm --prefix game test` 覆盖天气循环连续性、帧率一致性、暂停、预设切换和恢复自然天气。
- 控制台 `world.weather.state` 查看实际天气，`world.setWeather('storm')` 可临时预览风暴；通过设置菜单选择可保存。

---

## 12. 当前状态与待办

### ✅ 已完成

- 低多边形 2.5D 海底世界、潜水员、程序化生成的鱼（6 档稀有度、掉率按深度、3 个有名字的深度区加一条无底海沟）
- 憋气才能下潜、水下换气后紧急上浮、黑屏丢鱼、出水入库
- Presage 管线：浏览器抓帧 → sensor → SDK → 憋气检测；键盘和模拟两种兜底
- NFT 卡图（由 seed 决定、可复现）、收藏面板
- Solana 铸造：已在 devnet 端到端验证（临时钱包 → Irys 上传图片和元数据 → Metaplex Core + 链上 Attributes），Solana Explorer 能正常显示卡图。[示例资产](https://explorer.solana.com/address/GHBBzZ7UTJPKVXWM5bryTsyM14x4Bv23MoQsfTN5tt13?cluster=devnet)
- 健康报告（按需生成）
- 自然昼夜循环、水面反光、可保存的光照效果开关
- 自然天气与晴 / 云 / 雨 / 风暴预设，云层和雨量按画质调整
- 三张地图（峡湾、天池、汪洋）：水面以上的场景、峡湾与天池的完整深水海底、仅汪洋保留的无底海沟、开始卡片上的地图选择、按累计入库鱼价值解锁
- 九类装备各三档的 PBR 多边体模型，已在工作台显示，带 PNG / GLB 素材和交互式装备预览
- 鱼竿 / 渔网升级 MVP：三档容量和收网范围、可见网圈缩放、本地持久化
- 鱼经济：入库的鱼自动铸成 NFT，卖鱼时销毁 NFT 换 Pearls，地图进度按历史累计价值
- 链上购买：装备升级、制作、合成升级和鱼缸喂食通过 `player_state` 程序（v1）销毁 PEARL
- 3D 鱼缸桌：玻璃鱼缸、健康桌和设置桌，在任何一张桌子上都能进入
- 出海：统计从第一次下潜到回港，然后在纸上生成出海报告
- 可改键的操作（设置 → 操作）和 English / 中文 语言
- 收藏批量卖出：勾选框加全选
- NFT 画面一致：NFT 图片与游戏内的卡由同一份代码绘制
- 由 Vercel 从 `main` 自动部署到 <https://breathless.gotclass.xyz>

### 🔜 待办（认领时在 PR 或群里说一声）

- [ ] **player_state v2 接入**：船部件、船只、链上记录的终身入库价值和地图门槛（程序已部署；游戏接入进行中）
- [ ] **真机测试 Presage 憋气检测**，并调阈值（第 5 节）
- [ ] **完整装备经济**：在鱼竿 / 渔网升级 MVP 之外，用 SOL 或 Pearl（SPL token）购买氧气瓶、脚蹼、头灯；装备有耐久度。低多边形模型已经有了，剩下的是在游戏里显示模型、购买和让效果生效
- [ ] **更多 NFT 消耗（sink）**：卖鱼已完成；还剩用鱼合成鱼饵或道具、献祭给海怪、进化、集齐套装兑换
- [ ] **夜晚海怪**：夜里高价值鱼出现，同时有海怪风险
- [ ] **三张地图的剩余部分**：每张图的夜间小怪和独立白昼时段、汪洋图的船耐久和沉船。设计见策划案第 6 节
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
- **改参数**：玩法常数集中在 `main.ts` 顶部、`fish.ts` 的 `RARITY` / `ZONES`、`depth-odds.ts` 的 `RARITY_BY_DEPTH` 和 `maps.ts` 的 `MAPS`，改了请在 PR 里说明。
- **README 有两份**：`README.md`（English）和 `README.zh-CN.md`（中文）。改其中一份时，请在同一个 PR 里把另一份也改了。

---

## 14. 比赛时间线

完整内容见 [`intro/HackRU26.md`](intro/HackRU26.md)。

- 开发：10/10（周六）12:00 开始
- **提交截止：以 Devpost 页面为准。Devpost 显示周日 10:00 AM，比官网写的 12:00 早，按早的算。**
- 评审：10/11（周日）13:00 开始，**全员必须到场**

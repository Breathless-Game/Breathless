# Vercel 部署 / Vercel deployment

[English](#english) · [中文](#中文)

The Dell (deploy/SETUP.md) keeps working exactly as before. This is a second way to host the
same `main`: the game as static files, and every `/api` route in one Vercel Function with its
state in Upstash Redis.

---

## English

### What runs where

| Piece | Dell (`npm start`) | Vercel |
| --- | --- | --- |
| Game (`game/dist`, 7 HTML entries) | `sensor/static.mjs` | Vercel's CDN. Same headers: `/assets/*` immutable for a year, everything else `no-cache`, `nosniff` everywhere. Unknown paths are a 404 here; the Dell falls back to `index.html`. |
| `/api/market/*`, `/api/nft/*` | `sensor/index.mjs` | `api/index.mjs` → `sensor/vercel-handler.mjs`: the same handlers |
| Market state | files in the market dir | Upstash Redis (`sensor/market-store.mjs`), under `MARKET_STORE_PREFIX` |
| Market wallet | `.market-keypair.json` (created if missing) | `MARKET_SECRET_KEY`, read only. It is never generated, and without it the market answers 503. |
| Burn sweep | at start-up, then every 10 min | daily cron `GET /api/cron/sweep` (04:00 UTC), and after a sale at most every 10 min (`waitUntil`) |
| `/sensor` WebSocket (Presage) | yes | **no**. With Presage off the production game never opens it (keyboard only). |

`vercel.json` describes the whole build, so the dashboard needs no build settings:
- install: `npm ci && npm ci --prefix game`;
- build: `npm --prefix game run build`, output `game/dist`;
- the function and its `maxDuration`, the `/api/*` rewrite, the cron, and the headers.

The root `package.json` now lists the function's runtime dependencies: umi, mpl-core, mpl-toolbox, mpl-token-metadata, `@upstash/redis` and `@vercel/functions`.
- The versions are exact, and `sensor/test/vercel-handler.test.mjs` fails if they drift from `sensor/package-lock.json`.
- The Presage SDK, sharp, dotenv and ws are not among them. The traced function is about 5 MB.
- The Dell never installs them: `deploy.sh` only runs `npm ci` in `sensor/`.

### Limits (checked 2026-10-12)

- **Duration.** Hobby with Fluid compute (on by default): 300 s default and 300 s maximum ([docs](https://vercel.com/docs/functions/configuring-functions/duration)).
  - `vercel.json` sets 300.
  - `/api/market/sell-batch` stops starting new fish after 240 s. Fish it did not reach answer `503 "sell this fish again"`, and the game retries them.
  - A 24-fish batch behind RPC 429 backoff can take longer than 300 s, which is why the deadline exists.
- **Cron.** Hobby allows once a day at most, ±59 min ([usage](https://vercel.com/docs/cron-jobs/usage-and-pricing)). A cron is a GET to the production URL with `Authorization: Bearer $CRON_SECRET` ([manage](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). It may fire twice or be missed; the sweep is idempotent.
- **Redis.** Vercel KV is gone; Redis comes from the Marketplace (Upstash) ([docs](https://vercel.com/docs/redis)).
- **CDN.** `/api/nft/*` 200s carry `Vercel-CDN-Cache-Control: max-age=31536000` ([docs](https://vercel.com/docs/caching/cdn-cache)).
  - Vercel's CDN keeps them for a year and never forwards that header, so browsers and wallets see the Dell's `Cache-Control` and the Dell's bytes.
  - Every deployment starts a fresh cache, so a new card renderer shows after a redeploy.

### One-time setup

1. **Project.** In Settings → Build and Deployment:
   - Framework Preset: Other;
   - no Build/Install/Output overrides (`vercel.json` sets them);
   - Root Directory: the repo root;
   - Node.js 24.x (`engines` in `package.json`).

   Fluid compute stays on.
2. **Redis.** Marketplace → Upstash → Redis → Create, then connect it to the project.
   - Connecting adds the REST URL and token as environment variables. The code reads `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN`, and the `UPSTASH_` pair wins.
   - After connecting, check in Settings → Environment Variables which pair you got.
   - Use **one database for Preview and another for Production**, or at least a different `MARKET_STORE_PREFIX` per environment.
3. **Environment variables.** See below. A change only applies to new deployments, so redeploy after editing.
4. **Domain.** Do this only at cutover (step 7 below).

**Deployment Protection.** This project has Vercel Authentication on `*.vercel.app` (`all_except_custom_domains`):
- Preview and production `*.vercel.app` URLs only open in a browser logged in to Vercel, and plain `curl` gets the login page.
- The custom domain is public.

### Environment variables

Server (runtime). None of these reach the game bundle; only `VITE_*` do.

| Name | Environments | Secret | What |
| --- | --- | --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | all | the token, yes | Added by the Upstash integration. |
| `MARKET_STORE` | all | no | `redis`. Optional, since the credentials select Redis anyway, but it makes a missing database fail loudly. On Vercel the file store refuses to start. |
| `MARKET_STORE_PREFIX` | all | no | Key prefix, default `market:`. Use e.g. `preview:` for Preview and `live:` for Production at cutover. |
| `MARKET_SECRET_KEY` | all | **yes**, mark it Sensitive | The market wallet's 64-byte secret key: the keypair file's JSON array, or base58. **TEST wallet** everywhere until cutover. |
| `CRON_SECRET` | Production | **yes** | Random, at least 16 characters (`openssl rand -hex 32`). Vercel sends it with each cron call; without it `/api/cron/sweep` answers 401 to everyone. |
| `PUBLIC_ORIGIN` | all | no | `https://breathless.gotclass.xyz`, so the NFT JSON points at the real game, byte for byte as the Dell serves it. |
| `SOLANA_RPC` | all | **yes** if the URL holds an API key | The market's RPC. Default: `VITE_SOLANA_RPC`, else public devnet, which answers 429 under a bulk sell. |
| `SOLANA_RPC_CONCURRENCY` | optional | no | Calls in flight, default 3. Raise only on a paid plan. |
| `PLAYER_STATE_PROGRAM_ID` | Preview + Production **until cutover**, then deleted | no | `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`, the TEST player_state (contracts/DEPLOYED.md), whose oracle is the TEST market wallet. Unset = the live program, whose oracle is the live wallet, so a TEST market's fish mints fail with `0x1770` (Unauthorized). Always set together with `VITE_PLAYER_STATE_PROGRAM_ID`. |
| `FISH_MARKET_PROGRAM_ID` | **must be unset** | n/a | Program mode needs the file store; with Redis the market refuses to start. |

`PRESAGE_*`, `PORT`, `HOST`, `MAX_LIVE_SESSIONS`, `MAX_CONN_PER_IP` and `SENSOR_*` are not used on Vercel.
- `MAX_CONN_PER_IP` (`MAX_PER_IP` in index.mjs) caps WebSocket connections, and there is no WebSocket here.
- The per-IP limits that matter are the HTTP ones in `market.mjs`, `nft-serial.mjs` and `nft-meta.mjs`. On Vercel each instance keeps its own (see Known limits).

Game (build time). Vite bundles these into the page, so **never put a secret in a `VITE_*` variable**. Vercel exposes every environment variable to the build, but only `VITE_*` reach the bundle.

| Name | Default when unset | On Vercel |
| --- | --- | --- |
| `VITE_PRESAGE_ENABLED` | off | **Leave unset.** Set to `1`, the game opens a `/sensor` WebSocket that Vercel cannot serve, unless `VITE_SENSOR_URL` points at a sensor elsewhere. |
| `VITE_SENSOR_URL` | `wss://<page host>/sensor` | unset |
| `VITE_FRAME_FORMAT` | JPEG | unset |
| `VITE_NFT_ORIGIN` | the page's origin when public https, else the deployed game | **`https://breathless.gotclass.xyz` in Preview and Production.** Otherwise a fish minted on a `*.vercel.app` URL points at a host that wallets cannot open (Deployment Protection). |
| `VITE_SOLANA_RPC` | public devnet | as on the Dell (unset). Public: never a keyed URL. |
| `VITE_GEAR_NFT` | on | unset |
| `VITE_PLAYER_STATE_PROGRAM_ID` | the live devnet program | **`4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L` in Preview and Production until cutover**, the same value as `PLAYER_STATE_PROGRAM_ID`; deleted at cutover. |

The Dell's build (`.github/workflows/deploy.yml`) only sets `VITE_PRESAGE_ENABLED`, from the repo variable. Everything else uses the defaults above.

### Deploying

The Vercel project is connected to `Breathless-Game/Breathless` through Vercel's GitHub app (installed on the Breathless-Game org). Every push to `main` deploys Production automatically, and every pull request branch gets a Preview deployment (behind Vercel Authentication) that uses the Preview environment variables; until cutover those are the same TEST market wallet and `test:` Redis prefix as Production. To deploy again without a push: dashboard → Deployments → Redeploy. There is still no GitHub Actions workflow for Vercel; `deploy.yml` still deploys the Dell on every push to `main`.

### Preview with a TEST wallet

Until cutover, **both Preview and Production use a TEST market wallet**, with a Redis database (or `MARKET_STORE_PREFIX`) of their own. Never use the live wallet or the live state here. At cutover the live state is imported into a fresh prefix and the live key is set.

1. Make a throwaway devnet wallet on your own machine, e.g. `solana-keygen new --no-bip39-passphrase -o /tmp/test-market.json`, and fund it from https://faucet.solana.com.
2. Paste the file's contents into `MARKET_SECRET_KEY` (Sensitive). Also set:
   - `MARKET_STORE=redis` and `MARKET_STORE_PREFIX=preview:`;
   - `PUBLIC_ORIGIN` and `VITE_NFT_ORIGIN` as above;
   - `SOLANA_RPC`;
   - `PLAYER_STATE_PROGRAM_ID` and `VITE_PLAYER_STATE_PROGRAM_ID`, both `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`.

   Then delete the local file.

   The TEST player_state program is tied to one TEST wallet, `8RJHaqvY2EjsezPU8PX6Cakz6DWPkzjcNTumR7x6tiax` (its Config's oracle), and to that wallet's TEST PEARL mint. A different test wallet needs its own player_state deployment: `set_oracle` (signed by the TEST program's admin, that same wallet) would fix the fish mints, but the Config's PEARL mint is fixed at `initialize_config`, so PEARL spends would still burn the old test PEARL.

   Set the two program ids **together**, with the same value. If only one is set (or they differ), the market's record_catch goes to one program and the game expects the other, so the game refuses to sign every fish mint ("The game and the market are on different versions … nothing was signed"), and a reload does not help.

   `VITE_*` values are baked in at build time, so after adding, changing or deleting one, **redeploy** (a new build, not a promote of an old one).
3. Deploy, and open the deployment URL in a browser logged in to Vercel.
   - `/api/market/info` shows the test wallet. On the first use the market creates a test PEARL mint and fish collection; a Redis lock makes sure only one instance does.
   - Check an NFT URL, e.g. `/api/nft/img/v1/c61cd89c/uncommon/slim-130-45-50-310-3/Striped%20Wrasse.png`.
   - Play: catch, mint, sell. Test fish and test PEARL are worthless and separate from live.
4. To start over, delete the `preview:*` keys in the Upstash console (Data Browser), or switch to a new prefix.

### Cutover (Dell → Vercel)

Run steps 1-6 within one window. The Dell's market must be stopped before you copy its state, and must never run again while Vercel serves: two markets with one wallet and two ledgers could pay for the same fish twice.

1. **Freeze the Dell.**
   - In GitHub, disable the Dell deploy: Actions → deploy → Disable workflow. Otherwise the next push restarts the Dell.
   - On the Dell, run `sudo systemctl stop breathless`. The game is offline from here to step 7.
2. **Copy the state.**
   - Copy `.market-state.json`, `.market-fish.jsonl` and `.market-serial.json` from the Dell's market dir (default `/srv/breathless/app/sensor/`) to your machine.
   - **Not** `.market-keypair.json` through anything but your own secure channel. The import never reads it.
3. **Dry run.** With the Production database's credentials in your shell:
   ```bash
   MARKET_STORE_PREFIX=live: UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
     node sensor/scripts/import-to-redis.mjs <dir with the three files> --dry-run
   ```
   This prints counts only and connects to nothing. Check them against the files.

   Use a prefix the Production environment has never used (`live:`), so no test data is mixed in.
4. **Import.** Run the same command without `--dry-run`, then run it once more. The second run must report `0 written`, with everything `already there`.
5. **Set Production's variables.**
   - `MARKET_SECRET_KEY` = the Dell's `.market-keypair.json` contents (Sensitive);
   - `MARKET_STORE_PREFIX=live:`;
   - `CRON_SECRET`, `PUBLIC_ORIGIN` and `SOLANA_RPC` (the Dell's);
   - **delete** `PLAYER_STATE_PROGRAM_ID` and `VITE_PLAYER_STATE_PROGRAM_ID` from Production, so the server and the game both fall back to the live program `EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ`, whose oracle is the live wallet. Leaving them set with the live key would break every fish mint (`0x1770`), and PEARL spends would point at the TEST PEARL mint.
6. **Redeploy Production and verify** (a fresh build, since the `VITE_` variable changed) on its `*.vercel.app` URL, in a logged-in browser:
   - `/api/market/info` has the Dell's `market`, `pearlMint` and `fishCollection`;
   - the page's bundle no longer contains the TEST program id `4tdod…`;
   - an NFT JSON and image are identical to the Dell's (before the stop, or from a backup).
7. **Switch the domain.**
   - In the project, Settings → Domains → add `breathless.gotclass.xyz`.
   - In Cloudflare, replace the tunnel's record with the record Vercel shows, **DNS only (grey cloud)**. Proxied through Cloudflare, Vercel would see Cloudflare's IPs, and the per-IP limits would lump players together.
   - Wait for Vercel's certificate.
8. **Watch.**
   - Sell a fish end to end.
   - In Settings → Cron Jobs, press Run on `/api/cron/sweep`. It must answer 200. A 401 with `{"error":"Unauthorized"}` means `CRON_SECRET` is missing; an HTML login page means Deployment Protection stopped the call before it reached the function.
   - Check the next 04:00 UTC run in the function logs (`[market] sweep`).
   - Keep the Dell stopped, with its files untouched, for rollback.

### Rollback (Vercel → Dell)

1. Stop Vercel's market: remove `MARKET_SECRET_KEY` from Production and redeploy. `/api/market` then answers 503, and the NFT routes keep working.
2. Export the state Vercel built up, into an empty directory:
   ```bash
   MARKET_STORE_PREFIX=live: UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
     node sensor/scripts/export-from-redis.mjs /tmp/breathless-export
   ```
   - It writes the three files in the Dell's formats.
   - Sales made on Vercel are in them. Without this step a seller could replay a sale on the Dell and be paid again.
3. Copy them into the Dell's market dir, replacing the old ones (keep a backup), then run `sudo systemctl start breathless`.
4. Point Cloudflare's record back at the tunnel, and re-enable the deploy workflow.

A Vercel-only problem (a bad deployment) needs none of this: Deployments → an earlier one → Promote, or Instant Rollback.

### Known limits on Vercel

- **Per instance, not per deployment.** These are in each instance's memory:
  - the HTTP rate limiters, and the fish mint and migration quotas;
  - the NFT render limit (40/min);
  - the rpc-guard concurrency limit and 429 backoff;
  - the balance and owned-fish caches.

  `process-guard` is not installed on Vercel. A stray rejection there is up to Vercel's runtime: at worst it ends that one instance, and the others keep serving.

  Under load Vercel runs several instances, so each limit is that many times looser.
- **What must hold across instances is in Redis:** one payout per fish (SET NX), gapless fish numbers (one Lua script), one PEARL mint and one collection (a lock), and the registry.
- **The 50,000 PEARL daily cap.** It is checked against Redis just before each sale. Two sales by one seller on two instances at the same moment can both pass, so a seller can go over the cap by at most one sale per instance.
- **Burn retries.** A payout whose burn failed is no longer retried in memory. The fish waits in the market wallet for the next sweep: after the next sale (10-min throttle), or at the daily cron.
- **Fish numbers.** Redis keeps every (owner, fish) → number pair. The Dell file keeps the last 20,000.

---

## 中文

Dell 部署（deploy/SETUP.md）完全不变。这里是第二种托管同一个 `main` 的方式：
- 游戏作为静态文件；
- 所有 `/api` 路由放在一个 Vercel Function 里；
- 状态存在 Upstash Redis。

### 分工

| 部分 | Dell（`npm start`） | Vercel |
| --- | --- | --- |
| 游戏（`game/dist`，7 个 HTML 入口） | `sensor/static.mjs` | Vercel CDN。响应头相同：`/assets/*` 缓存一年（immutable），其余 `no-cache`，全部带 `nosniff`。未知路径在这里是 404，Dell 会回退到 `index.html`。 |
| `/api/market/*`、`/api/nft/*` | `sensor/index.mjs` | `api/index.mjs` → `sensor/vercel-handler.mjs`，处理函数相同 |
| 市场状态 | 市场目录里的文件 | Upstash Redis（`sensor/market-store.mjs`），键都在 `MARKET_STORE_PREFIX` 下 |
| 市场钱包 | `.market-keypair.json`（没有就新建） | `MARKET_SECRET_KEY`，只读。永不生成；没有它，市场就回 503。 |
| 销毁清扫 | 启动时一次，之后每 10 分钟 | 每天一次 cron `GET /api/cron/sweep`（UTC 04:00）；另外卖鱼后最多每 10 分钟一次（`waitUntil`） |
| `/sensor` WebSocket（Presage） | 有 | **没有**。Presage 关闭时，生产版游戏只用键盘，不会连它。 |

`vercel.json` 写全了构建配置，控制台里不用设置任何构建项：
- 安装：`npm ci && npm ci --prefix game`；
- 构建：`npm --prefix game run build`，输出 `game/dist`；
- 函数及其 `maxDuration`、`/api/*` 重写、cron 和响应头。

根目录 `package.json` 现在列出函数运行要用的依赖：umi、mpl-core、mpl-toolbox、mpl-token-metadata、`@upstash/redis` 和 `@vercel/functions`。
- 版本都是精确版本。和 `sensor/package-lock.json` 不一致时，`sensor/test/vercel-handler.test.mjs` 会失败。
- 不含 Presage SDK、sharp、dotenv 和 ws。追踪出来的函数约 5 MB。
- Dell 不会装这些：`deploy.sh` 只在 `sensor/` 里跑 `npm ci`。

### 限制（2026-10-12 核对）

- **运行时长。** Hobby 计划开启 Fluid compute（默认开）时，默认和上限都是 300 秒（[文档](https://vercel.com/docs/functions/configuring-functions/duration)）。
  - `vercel.json` 设为 300。
  - `/api/market/sell-batch` 过了 240 秒就不再开始卖新的鱼。没轮到的鱼回 `503`，游戏会重试。
  - 24 条鱼遇上 RPC 429 退避时可能超过 300 秒，所以加了这个截止时间。
- **Cron。** Hobby 计划最多每天一次，误差 ±59 分钟（[用量](https://vercel.com/docs/cron-jobs/usage-and-pricing)）。调用方式是对生产 URL 发 GET，带 `Authorization: Bearer $CRON_SECRET`（[管理](https://vercel.com/docs/cron-jobs/manage-cron-jobs)）。可能重复或漏掉一次；清扫是幂等的。
- **Redis。** Vercel KV 已停用，Redis 改由 Marketplace（Upstash）提供（[文档](https://vercel.com/docs/redis)）。
- **CDN。** `/api/nft/*` 的 200 响应带 `Vercel-CDN-Cache-Control: max-age=31536000`（[文档](https://vercel.com/docs/caching/cdn-cache)）。
  - CDN 缓存一年，而且不会把这个头转给浏览器，所以浏览器和钱包看到的 `Cache-Control` 和字节都与 Dell 相同。
  - 每次部署都从新缓存开始，所以换了卡面渲染后重新部署就能生效。

### 一次性配置

1. **项目。** 在 Settings → Build and Deployment：
   - Framework Preset 选 Other；
   - Build/Install/Output 都不覆盖（由 `vercel.json` 决定）；
   - Root Directory 用仓库根目录；
   - Node.js 选 24.x（见 `package.json` 的 `engines`）。

   Fluid compute 保持开启。
2. **Redis。** Marketplace → Upstash → Redis → Create，然后连接到本项目。
   - 连接后会添加 REST URL 和 token 环境变量。代码读 `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`，或 `KV_REST_API_URL` + `KV_REST_API_TOKEN`，`UPSTASH_` 那一对优先。
   - 连接后去 Settings → Environment Variables 看看实际是哪一对。
   - **Preview 和 Production 各用一个数据库**，至少要用不同的 `MARKET_STORE_PREFIX`。
3. **环境变量。** 见下文。改了之后只对新部署生效，所以要重新部署。
4. **域名。** 切换时才做（下文第 7 步）。

**部署保护。** 本项目在 `*.vercel.app` 上开了 Vercel Authentication（`all_except_custom_domains`）：
- 预览和生产的 `*.vercel.app` 地址只能在登录了 Vercel 的浏览器里打开，直接 `curl` 会拿到登录页；
- 自定义域名是公开的。

### 环境变量

服务器（运行时）。这些变量都不会进游戏包，只有 `VITE_*` 会。

| 名称 | 环境 | 机密 | 说明 |
| --- | --- | --- | --- |
| `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`（或 `KV_REST_API_URL`、`KV_REST_API_TOKEN`） | 全部 | token 是 | Upstash 集成自动添加。 |
| `MARKET_STORE` | 全部 | 否 | `redis`。可不设（有凭据时本来就会选 Redis），设了以后数据库缺失会明确报错。在 Vercel 上文件存储会拒绝启动。 |
| `MARKET_STORE_PREFIX` | 全部 | 否 | 键前缀，默认 `market:`。例如 Preview 用 `preview:`，切换时 Production 用 `live:`。 |
| `MARKET_SECRET_KEY` | 全部 | **是**，标为 Sensitive | 市场钱包的 64 字节私钥：keypair 文件里的 JSON 数组，或 base58。切换前一律用**测试钱包**。 |
| `CRON_SECRET` | Production | **是** | 随机串，至少 16 个字符（`openssl rand -hex 32`）。Vercel 调 cron 时会带上；不设的话 `/api/cron/sweep` 对谁都回 401。 |
| `PUBLIC_ORIGIN` | 全部 | 否 | `https://breathless.gotclass.xyz`，让 NFT JSON 指向正式游戏，和 Dell 输出的字节完全一致。 |
| `SOLANA_RPC` | 全部 | URL 里带 API key 时**是** | 市场用的 RPC。默认取 `VITE_SOLANA_RPC`，再没有就用公共 devnet（批量卖鱼时会 429）。 |
| `SOLANA_RPC_CONCURRENCY` | 可选 | 否 | 同时进行的调用数，默认 3。付费套餐才调高。 |
| `PLAYER_STATE_PROGRAM_ID` | Preview + Production，**只在切换前**，切换时删掉 | 否 | `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`，测试版 player_state（见 contracts/DEPLOYED.md），它的 oracle 是测试市场钱包。不设就是正式程序，oracle 是正式钱包，测试市场铸鱼会报 `0x1770`（Unauthorized）。必须和 `VITE_PLAYER_STATE_PROGRAM_ID` 一起设。 |
| `FISH_MARKET_PROGRAM_ID` | **必须不设** | 不适用 | program 模式需要文件存储；用 Redis 时市场会拒绝启动。 |

Vercel 上不用 `PRESAGE_*`、`PORT`、`HOST`、`MAX_LIVE_SESSIONS`、`MAX_CONN_PER_IP` 和 `SENSOR_*`。
- `MAX_CONN_PER_IP`（index.mjs 里叫 `MAX_PER_IP`）限制的是 WebSocket 连接数，这里没有 WebSocket。
- 真正起作用的按 IP 限制是 `market.mjs`、`nft-serial.mjs` 和 `nft-meta.mjs` 里的 HTTP 限流。在 Vercel 上每个实例各算各的（见「已知局限」）。

游戏（构建时）。Vite 会把这些变量打进页面，所以**不要在 `VITE_*` 里放任何机密**。Vercel 构建时能看到所有环境变量，但只有 `VITE_*` 会进包。

| 名称 | 不设时 | Vercel 上 |
| --- | --- | --- |
| `VITE_PRESAGE_ENABLED` | 关 | **不设。** 设成 `1` 时游戏会连 `/sensor` WebSocket，而 Vercel 提供不了，除非 `VITE_SENSOR_URL` 指向别处的 sensor。 |
| `VITE_SENSOR_URL` | `wss://<页面域名>/sensor` | 不设 |
| `VITE_FRAME_FORMAT` | JPEG | 不设 |
| `VITE_NFT_ORIGIN` | 页面是公网 https 时用页面域名，否则用正式游戏 | **Preview 和 Production 都设为 `https://breathless.gotclass.xyz`。** 否则在 `*.vercel.app` 上铸的鱼会指向钱包打不开的地址（部署保护）。 |
| `VITE_SOLANA_RPC` | 公共 devnet | 同 Dell（不设）。会公开，不能用带 key 的 URL。 |
| `VITE_GEAR_NFT` | 开 | 不设 |
| `VITE_PLAYER_STATE_PROGRAM_ID` | 正式的 devnet 程序 | **切换前 Preview 和 Production 都设为 `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`**，和 `PLAYER_STATE_PROGRAM_ID` 同值；切换时删掉。 |

Dell 的构建（`.github/workflows/deploy.yml`）只设置 `VITE_PRESAGE_ENABLED`（取自仓库变量），其余都用上表的默认值。

### 部署

Vercel 项目通过 Vercel 的 GitHub app（已装在 Breathless-Game 组织上）连接到 `Breathless-Game/Breathless`。每次 push 到 `main` 都会自动部署 Production；每个 pull request 分支都会得到一个 Preview 部署（受 Vercel Authentication 保护），使用 Preview 环境变量，切换之前它们和 Production 一样，是同一个测试市场钱包和 `test:` Redis 前缀。不 push 也想重新部署：控制台 → Deployments → Redeploy。Vercel 仍然没有对应的 GitHub Actions workflow；`deploy.yml` 照旧在每次 push 到 `main` 时部署 Dell。

### 用测试钱包做预览

切换之前，**Preview 和 Production 都用测试市场钱包**，并且各用自己的 Redis 数据库（或 `MARKET_STORE_PREFIX`）。这里绝不能用正式钱包或正式状态。切换时再把正式状态导入一个全新的前缀，并换上正式私钥。

1. 在自己电脑上生成一次性的 devnet 钱包，例如 `solana-keygen new --no-bip39-passphrase -o /tmp/test-market.json`，再到 https://faucet.solana.com 领 devnet SOL。
2. 把文件内容填进 `MARKET_SECRET_KEY`（Sensitive）。同时设置：
   - `MARKET_STORE=redis` 和 `MARKET_STORE_PREFIX=preview:`；
   - 上文所说的 `PUBLIC_ORIGIN` 和 `VITE_NFT_ORIGIN`；
   - `SOLANA_RPC`；
   - `PLAYER_STATE_PROGRAM_ID` 和 `VITE_PLAYER_STATE_PROGRAM_ID`，都设为 `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`。

   然后删掉本地文件。

   测试版 player_state 绑定的是一个测试钱包 `8RJHaqvY2EjsezPU8PX6Cakz6DWPkzjcNTumR7x6tiax`（它 Config 里的 oracle），以及这个钱包的测试 PEARL 币。换别的测试钱包，就要另部署一份 player_state：由测试程序的 admin（也就是这个钱包）调用 `set_oracle` 只能修好铸鱼，Config 里的 PEARL 币在 `initialize_config` 时就定死了，PEARL 消费仍会烧旧的测试 PEARL。

   两个程序 ID **必须一起设、同一个值**。只设了一个（或两个值不同）时，市场把 record_catch 发给一个程序，游戏却认另一个，于是游戏拒签每一笔铸鱼（"游戏和市场版本不一致……没有签署任何交易"），刷新页面也没用。

   `VITE_*` 是构建时写进页面的，新增、修改或删除之后都要**重新部署**（重新构建，不是 promote 旧部署）。
3. 部署，用登录了 Vercel 的浏览器打开部署地址。
   - `/api/market/info` 显示的是测试钱包。第一次使用时，市场会创建测试 PEARL 币和鱼集合；Redis 锁保证只有一个实例去做。
   - 打开一个 NFT 地址看看，例如 `/api/nft/img/v1/c61cd89c/uncommon/slim-130-45-50-310-3/Striped%20Wrasse.png`。
   - 玩一遍：钓鱼、铸造、卖出。测试鱼和测试 PEARL 不值钱，也和正式的互不相干。
4. 要重来时，在 Upstash 控制台（Data Browser）删掉 `preview:*` 键，或者换一个新前缀。

### 切换（Dell → Vercel）

第 1–6 步在同一个时间窗口内做完。复制状态前必须先停掉 Dell 的市场，而且 Vercel 上线后 Dell 绝不能再跑：同一个钱包配两本账，同一条鱼可能被付两次钱。

1. **冻结 Dell。**
   - 在 GitHub 停用 Dell 的部署：Actions → deploy → Disable workflow。不停用的话，下一次 push 会把 Dell 重新启动。
   - 在 Dell 上运行 `sudo systemctl stop breathless`。从这里到第 7 步，游戏是下线的。
2. **复制状态。**
   - 从 Dell 的市场目录（默认 `/srv/breathless/app/sensor/`）把 `.market-state.json`、`.market-fish.jsonl`、`.market-serial.json` 复制到自己电脑。
   - `.market-keypair.json` 只能走你自己的安全渠道。导入脚本不会读它。
3. **试运行。** 在 shell 里放好 Production 数据库的凭据：
   ```bash
   MARKET_STORE_PREFIX=live: UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
     node sensor/scripts/import-to-redis.mjs <三个文件所在目录> --dry-run
   ```
   只打印数量，不连接任何服务。对照文件核对数量。

   前缀用 Production 从没用过的（`live:`），这样不会混进测试数据。
4. **导入。** 去掉 `--dry-run` 再跑一次，然后再跑一次。第二次必须全是 `0 written` / `already there`。
5. **设置 Production 变量。**
   - `MARKET_SECRET_KEY` = Dell 上 `.market-keypair.json` 的内容（Sensitive）；
   - `MARKET_STORE_PREFIX=live:`；
   - `CRON_SECRET`、`PUBLIC_ORIGIN`、`SOLANA_RPC`（用 Dell 的那个）；
   - 从 Production **删掉** `PLAYER_STATE_PROGRAM_ID` 和 `VITE_PLAYER_STATE_PROGRAM_ID`，让服务器和游戏都回到正式程序 `EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ`（oracle 是正式钱包）。如果换了正式私钥却留着这两个变量，所有铸鱼都会报 `0x1770`，PEARL 消费也会指向测试 PEARL 币。
6. **重新部署 Production 并核对**（`VITE_` 变量变了，必须重新构建）。 用登录的浏览器打开它的 `*.vercel.app` 地址：
   - `/api/market/info` 里的 `market`、`pearlMint`、`fishCollection` 和 Dell 一致；
   - 页面的 JS 包里不再有测试程序 ID `4tdod…`；
   - NFT 的 JSON 和图片与 Dell 的完全相同（停机前保存的，或备份里的）。
7. **切换域名。**
   - 项目 Settings → Domains → 添加 `breathless.gotclass.xyz`。
   - 在 Cloudflare 把隧道的记录换成 Vercel 给出的记录，**只用 DNS（灰色云朵）**。经过 Cloudflare 代理的话，Vercel 看到的是 Cloudflare 的 IP，按 IP 的限流会把玩家混在一起。
   - 等 Vercel 签好证书。
8. **观察。**
   - 完整卖一条鱼。
   - 在 Settings → Cron Jobs 对 `/api/cron/sweep` 点 Run，必须回 200。回 401 且内容是 `{"error":"Unauthorized"}`，说明 `CRON_SECRET` 没设；回的是 HTML 登录页，说明请求在到达函数前被部署保护拦下了。
   - 在函数日志里确认下一次 UTC 04:00 的运行（`[market] sweep`）。
   - Dell 保持停止，文件不动，留着回滚用。

### 回滚（Vercel → Dell）

1. 停掉 Vercel 的市场：从 Production 删除 `MARKET_SECRET_KEY` 并重新部署。之后 `/api/market` 回 503，NFT 路由照常工作。
2. 把 Vercel 期间积累的状态导出到一个空目录：
   ```bash
   MARKET_STORE_PREFIX=live: UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
     node sensor/scripts/export-from-redis.mjs /tmp/breathless-export
   ```
   - 它会按 Dell 的格式写出三个文件，里面包括在 Vercel 上的成交记录。
   - 不做这一步的话，卖家可以在 Dell 上重放一笔成交，再拿一次钱。
3. 把它们复制进 Dell 的市场目录，替换旧文件（先备份），然后运行 `sudo systemctl start breathless`。
4. 把 Cloudflare 的记录指回隧道，并重新启用部署 workflow。

只是 Vercel 自身出问题（某次部署坏了）就不用这么做：在 Deployments 里选之前的部署 → Promote，或用 Instant Rollback。

### Vercel 上的已知局限

- **按实例计算，而不是按部署。** 下面这些都在各实例自己的内存里：
  - HTTP 限流，以及铸鱼和迁移配额；
  - NFT 渲染限制（每分钟 40 次）；
  - rpc-guard 的并发上限和 429 退避；
  - 余额和持有鱼的缓存。

  Vercel 上不装 `process-guard`。偶发的未处理拒绝交给 Vercel 运行时处理：最坏结束那一个实例，其他实例照常服务。

  负载高时 Vercel 会开多个实例，每个限制就相应放宽几倍。
- **必须跨实例成立的都在 Redis 里：** 每条鱼只付一次钱（SET NX）、鱼编号连续无空号（一个 Lua 脚本）、只有一个 PEARL 币和一个集合（锁），以及登记表。
- **每日 50,000 PEARL 上限。** 每次成交前都会对照 Redis 检查。同一卖家在两个实例上同时成交时，两笔可能都通过，所以最多会超出「每个实例一笔」。
- **销毁重试。** 付款后销毁失败的鱼不再在内存里重试，而是留在市场钱包里，等下一次清扫：下一次卖鱼之后（10 分钟节流），或每天的 cron。
- **鱼编号。** Redis 保留所有 (owner, fish) → 编号；Dell 的文件只保留最近 20,000 条。

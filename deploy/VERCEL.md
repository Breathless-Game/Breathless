# Vercel 部署 / Vercel deployment

[English](#english) · [中文](#中文)

Production runs on Vercel since 2026-10-13: the game as static files, and every `/api` route in
one Vercel Function with its state in Upstash Redis. The team's Dell, which served production
before that, is decommissioned; its setup scripts are only in the git history.

---

## English

### What runs where

| Piece | `npm start` (self-hosting; production until 2026-10-13) | Vercel (production) |
| --- | --- | --- |
| Game (`game/dist`, 7 HTML entries) | `sensor/static.mjs` | Vercel's CDN. Same headers: `/assets/*` immutable for a year, everything else `no-cache`, `nosniff` everywhere. Unknown paths are a 404 here; `npm start` falls back to `index.html`. |
| `/api/market/*`, `/api/nft/*` | `sensor/index.mjs` | `api/index.mjs` → `sensor/vercel-handler.mjs`: the same handlers |
| Market state | files in the market dir | Upstash Redis (`sensor/market-store.mjs`), under `MARKET_STORE_PREFIX` |
| Market wallet | `.market-keypair.json` (created if missing) | `MARKET_SECRET_KEY`, read only. It is never generated, and without it the market answers 503. |
| Burn sweep | at start-up, then every 10 min | daily cron `GET /api/cron/sweep` (04:00 UTC), and after a sale at most every 10 min (`waitUntil`) |
| `/sensor` WebSocket (Presage) | yes | **no**. With Presage off the production game never opens it (keyboard only). |

`vercel.json` describes the whole build, so the dashboard needs no build settings:
- install: `npm ci && npm ci --prefix game`;
- build: `npm --prefix game run build`, output `game/dist`;
- the function and its `maxDuration`, the `/api/*` rewrite, the cron, and the headers.

The root `package.json` lists the function's runtime dependencies: umi, mpl-core, mpl-toolbox, mpl-token-metadata, `@upstash/redis` and `@vercel/functions`.
- The versions are exact, and `sensor/test/vercel-handler.test.mjs` fails if they drift from `sensor/package-lock.json`.
- The Presage SDK, sharp, dotenv and ws are not among them. The traced function is about 5 MB.
- `npm start` does not use them: it runs on `sensor/package.json`'s dependencies (`npm run setup`).

### Limits (checked 2026-10-12)

- **Duration.** Hobby with Fluid compute (on by default): 300 s default and 300 s maximum ([docs](https://vercel.com/docs/functions/configuring-functions/duration)).
  - `vercel.json` sets 300.
  - `/api/market/sell` and `/api/market/sell-batch` start no fish and send no payout after 180 s. Fish they did not reach answer `503 "sell this fish again"`, and the game retries them. A payout sent just before that can still take ~110 s (429 backoff on the send, then up to 90 s to confirm), so 180 s keeps the request under 300 s.
  - The sweep (cron or after a sale) starts no burn or resume after 180 s; the rest wait for the next sweep.
  - A 24-fish batch behind RPC 429 backoff can take longer than 300 s, which is why the deadline exists.
- **Cron.** Hobby allows once a day at most, ±59 min ([usage](https://vercel.com/docs/cron-jobs/usage-and-pricing)). A cron is a GET to the production URL with `Authorization: Bearer $CRON_SECRET` ([manage](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). It may fire twice or be missed; the sweep is idempotent.
- **Redis.** Vercel KV is gone; Redis comes from the Marketplace (Upstash) ([docs](https://vercel.com/docs/redis)).
- **CDN.** `/api/nft/*` 200s carry `Vercel-CDN-Cache-Control: max-age=31536000` ([docs](https://vercel.com/docs/caching/cdn-cache)).
  - Vercel's CDN keeps them for a year and never forwards that header, so browsers and wallets see the same `Cache-Control` and the same bytes as from `npm start`.
  - Every deployment starts a fresh cache, so a new card renderer shows after a redeploy.

### One-time setup

All of this is done; it is here so the project can be rebuilt.

1. **Project.** In Settings → Build and Deployment:
   - Framework Preset: Other;
   - no Build/Install/Output overrides (`vercel.json` sets them);
   - Root Directory: the repo root;
   - Node.js 24.x (`engines` in `package.json`).

   Fluid compute stays on.
2. **Redis.** Marketplace → Upstash → Redis → Create, then connect it to the project.
   - Connecting adds the REST URL and token as environment variables. The code reads `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN`, and the `UPSTASH_` pair wins.
   - After connecting, check in Settings → Environment Variables which pair you got.
   - Production and Preview must never share keys: Production uses the prefix `live:`, Preview `test:` (or a database of its own).
3. **Environment variables.** See below. A change only applies to new deployments, so redeploy after editing.
4. **Domain.** Settings → Domains → `breathless.gotclass.xyz`. In Cloudflare it is a CNAME to `cname.vercel-dns.com`, **DNS only (grey cloud)**.

**Deployment Protection.** This project has Vercel Authentication on `*.vercel.app` (`all_except_custom_domains`):
- Preview and production `*.vercel.app` URLs only open in a browser logged in to Vercel, and plain `curl` gets the login page.
- The custom domain is public.

### Environment variables

Server (runtime). None of these reach the game bundle; only `VITE_*` do.

| Name | Environments | Secret | What |
| --- | --- | --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | all | the token, yes | Added by the Upstash integration. |
| `MARKET_STORE` | all | no | `redis`. Optional, since the credentials select Redis anyway, but it makes a missing database fail loudly. On Vercel the file store refuses to start. |
| `MARKET_STORE_PREFIX` | all | no | Key prefix (default `market:`). Production: `live:`. Preview: `test:`. |
| `MARKET_SECRET_KEY` | all | **yes**, mark it Sensitive | The market wallet's 64-byte secret key: the keypair file's JSON array, or base58. Production: the **live** market wallet. Preview: a **TEST** wallet, never the live key. |
| `CRON_SECRET` | Production | **yes** | Random, at least 16 characters (`openssl rand -hex 32`). Vercel sends it with each cron call; without it `/api/cron/sweep` answers 401 to everyone. |
| `PUBLIC_ORIGIN` | all | no | `https://breathless.gotclass.xyz`, so the NFT JSON points at the real game, byte for byte as `npm start` serves it. |
| `SOLANA_RPC` | all | **yes** if the URL holds an API key | The market's RPC. Default: `VITE_SOLANA_RPC`, else public devnet, which answers 429 under a bulk sell. If it has the Metaplex DAS API (public devnet and Helius do), `/api/market/fish` lists by its owner index instead of `getProgramAccounts`; checked on the first read, nothing to set. |
| `SOLANA_RPC_CONCURRENCY` | optional | no | Calls in flight, default 3. Raise only on a paid plan. |
| `PLAYER_STATE_PROGRAM_ID` | **Preview only** | no | `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`, the TEST player_state (contracts/DEPLOYED.md), whose oracle is the TEST market wallet. **Not set in Production**: unset = the live program, whose oracle is the live wallet. With the TEST wallet and no TEST program, fish mints fail with `0x1770` (Unauthorized). Always set together with `VITE_PLAYER_STATE_PROGRAM_ID`. |
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
| `VITE_SOLANA_RPC` | public devnet | unset. Public: never a keyed URL. |
| `VITE_GEAR_NFT` | on | unset |
| `VITE_PLAYER_STATE_PROGRAM_ID` | the live devnet program | **Preview only**: `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`, the same value as `PLAYER_STATE_PROGRAM_ID`. **Not set in Production.** |

CI (`.github/workflows/ci.yml`) builds with none of these set. It only runs the tests and the build; it never deploys.

### Deploying

The Vercel project is connected to `Breathless-Game/Breathless` through Vercel's GitHub app (installed on the Breathless-Game org).
- Every push to `main` deploys **Production** automatically: the live market wallet, the `live:` prefix and the live player_state program.
- Every pull request branch gets a **Preview** deployment (behind Vercel Authentication) with the Preview environment variables: the TEST market wallet, the `test:` prefix and the TEST player_state program `4tdod…`.
- To deploy again without a push: dashboard → Deployments → Redeploy.

No GitHub Actions workflow deploys anything; `ci.yml` only checks.

After a deploy that touched the market, check production:
- sell a fish end to end;
- in Settings → Cron Jobs, press Run on `/api/cron/sweep`. It must answer 200. A 401 with `{"error":"Unauthorized"}` means `CRON_SECRET` is missing; an HTML login page means Deployment Protection stopped the call before it reached the function;
- the daily 04:00 UTC run shows in the function logs as `[market] sweep`.

### Preview with a TEST wallet

**Preview always uses a TEST market wallet** and the `test:` prefix. Never put the live wallet or the live state (`live:`) in Preview.

1. Make a throwaway devnet wallet on your own machine, e.g. `solana-keygen new --no-bip39-passphrase -o /tmp/test-market.json`, and fund it from https://faucet.solana.com.
2. Paste the file's contents into Preview's `MARKET_SECRET_KEY` (Sensitive). Also set, for Preview:
   - `MARKET_STORE=redis` and `MARKET_STORE_PREFIX=test:`;
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
4. To start over, delete the `test:*` keys in the Upstash console (Data Browser), or switch Preview to a new prefix.

### Cutover from the Dell (done 2026-10-13)

For the record:
- The Dell's `breathless` service was stopped and disabled, and its `deploy` workflow disabled in GitHub (since replaced by `ci.yml`, which deploys nothing). The Dell is decommissioned.
- Its market state (`.market-state.json`, `.market-fish.jsonl`, `.market-serial.json`) was imported with `sensor/scripts/import-to-redis.mjs` into Production's Redis under the fresh prefix `live:`.
- Production's environment: `MARKET_STORE_PREFIX=live:`, `MARKET_SECRET_KEY` = the live market wallet (Sensitive), plus `CRON_SECRET` and `PUBLIC_ORIGIN`. `SOLANA_RPC` is unset, so the market uses public devnet, as the Dell did. `PLAYER_STATE_PROGRAM_ID` and `VITE_PLAYER_STATE_PROGRAM_ID` were deleted from Production, so the server and the game both use the live program `EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ`, whose oracle is the live wallet. Those two variables and the `test:` prefix are Preview-only.
- DNS: `breathless.gotclass.xyz` is a CNAME to `cname.vercel-dns.com` in Cloudflare, **DNS only (grey cloud)**. Proxied through Cloudflare, Vercel would see Cloudflare's IPs, and the per-IP limits would lump players together.

Never run a second market with the live wallet next to Vercel: one wallet with two ledgers could pay for the same fish twice.

### Rolling back and moving the market

**A bad deploy.** Dashboard → Deployments:
- **Instant Rollback** puts the previous Production deployment back at once (on Hobby, only the one before the current one).
- **Promote** on any earlier Production deployment goes further back.

An Instant Rollback reuses the old build as it was, with its baked-in `VITE_*` values; an environment variable change needs a new build (Redeploy). The market's state lives in Redis, not in a deployment, so a rollback never rolls the market back.

**Moving the market off Vercel**, if it ever has to move again:
1. Stop Vercel's market: remove `MARKET_SECRET_KEY` from Production and redeploy. `/api/market` then answers 503, and the NFT routes keep working.
2. Export the state into an empty directory:
   ```bash
   MARKET_STORE_PREFIX=live: UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
     node sensor/scripts/export-from-redis.mjs /tmp/breathless-export
   ```
   - It writes the three files in the file store's formats (what `npm start` reads from its market dir).
   - Every sale made on Vercel is in them. The new host must start from these files, or a seller could replay a sale and be paid again.
3. Start the new host with these files and the live wallet, and only then point the domain at it.

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
- **Fish numbers.** Redis keeps every (owner, fish) → number pair. The file store (`npm start`) keeps the last 20,000.

### Health check

Hobby keeps runtime logs for about an hour, so `.github/workflows/health.yml` checks production every hour (minute 23) with `scripts/health-check.mjs`. It uses only public endpoints and the public devnet RPC: no secrets, no repo settings.

| Check | Passes when |
| --- | --- |
| `site` | `GET /` is 200 HTML with `<canvas id="scene">` and the title. |
| `market-info` | `GET /api/market/info` is 200 JSON with `mode: "server"`, `market`, `pearlMint`, `fishCollection`, `tokenProgram`, and `funded: true`. |
| `market-sol` | The market wallet holds ≥ 0.5 SOL. **Warn** below 0.5 (the server's own airdrop level, `AIRDROP_BELOW_SOL`; the airdrop rarely works, so top it up by hand). **Critical** below 0.02 (`FUNDED_SOL`: info says `funded: false` and setup refuses to run). A sale costs the market about 0.002 SOL (the seller's PEARL account rent, first sale only) plus a few transaction fees, so 0.5 SOL is a couple of hundred new sellers. |
| `pearl-mint` | The PEARL mint is an SPL Token (not Token-2022) mint and its mint authority is the market. The market mints each payout; it holds no PEARL, so there is no PEARL balance to watch. |
| `fish-collection` | The fish collection is a Metaplex Core account. |
| `nft-meta`, `nft-image` | Venomous Hammerhead Shark #0026's on-chain metadata URI is 200 `application/json` with that name, and its `image` is 200 `image/png`. |
| `cron-route` | `GET /api/cron/sweep` without auth is 401 (the function is up and the route exists; the sweep itself needs `CRON_SECRET`). |

Each request is tried up to 3 times (on a network error, a timeout of 20 s, a 429 or a 5xx). The three chain checks share one `getMultipleAccounts` call. When the RPC still does not answer they show `rpc-unreachable`, which does not count as a failure.

**The issue.** On a failure or a warning it opens one issue labelled `health`, assigned to Bowen1314 (GitHub emails the assignee), titled `Production health check failing: market-sol:warn, …`. The body has the table of all checks. While it stays open:
- a change in the set of failing checks gets a comment at once;
- the same set gets a reminder comment at most every 6 h;
- full recovery gets a "Recovered" comment and closes the issue.

The run stays green either way; it goes red only when the script itself breaks. Each run's table is also in its job summary.

**By hand.** Actions → Health → Run workflow (tick `dry_run` to only print). Locally, `node scripts/health-check.mjs` only prints (dry run is the default outside Actions). GitHub turns off scheduled workflows in a public repo after 60 days without activity; if the runs stop, re-enable the workflow in the Actions tab.

---

## 中文

2026-10-13 起，生产环境跑在 Vercel 上：
- 游戏作为静态文件；
- 所有 `/api` 路由放在一个 Vercel Function 里；
- 状态存在 Upstash Redis。

之前跑生产环境的团队 Dell 已经退役，它的配置脚本只留在 git 历史里。

### 分工

| 部分 | `npm start`（自托管；2026-10-13 前的生产环境） | Vercel（生产环境） |
| --- | --- | --- |
| 游戏（`game/dist`，7 个 HTML 入口） | `sensor/static.mjs` | Vercel CDN。响应头相同：`/assets/*` 缓存一年（immutable），其余 `no-cache`，全部带 `nosniff`。未知路径在这里是 404，`npm start` 会回退到 `index.html`。 |
| `/api/market/*`、`/api/nft/*` | `sensor/index.mjs` | `api/index.mjs` → `sensor/vercel-handler.mjs`，处理函数相同 |
| 市场状态 | 市场目录里的文件 | Upstash Redis（`sensor/market-store.mjs`），键都在 `MARKET_STORE_PREFIX` 下 |
| 市场钱包 | `.market-keypair.json`（没有就新建） | `MARKET_SECRET_KEY`，只读。永不生成；没有它，市场就回 503。 |
| 销毁清扫 | 启动时一次，之后每 10 分钟 | 每天一次 cron `GET /api/cron/sweep`（UTC 04:00）；另外卖鱼后最多每 10 分钟一次（`waitUntil`） |
| `/sensor` WebSocket（Presage） | 有 | **没有**。Presage 关闭时，生产版游戏只用键盘，不会连它。 |

`vercel.json` 写全了构建配置，控制台里不用设置任何构建项：
- 安装：`npm ci && npm ci --prefix game`；
- 构建：`npm --prefix game run build`，输出 `game/dist`；
- 函数及其 `maxDuration`、`/api/*` 重写、cron 和响应头。

根目录 `package.json` 列出函数运行要用的依赖：umi、mpl-core、mpl-toolbox、mpl-token-metadata、`@upstash/redis` 和 `@vercel/functions`。
- 版本都是精确版本。和 `sensor/package-lock.json` 不一致时，`sensor/test/vercel-handler.test.mjs` 会失败。
- 不含 Presage SDK、sharp、dotenv 和 ws。追踪出来的函数约 5 MB。
- `npm start` 不用这些：它用的是 `sensor/package.json` 的依赖（`npm run setup`）。

### 限制（2026-10-12 核对）

- **运行时长。** Hobby 计划开启 Fluid compute（默认开）时，默认和上限都是 300 秒（[文档](https://vercel.com/docs/functions/configuring-functions/duration)）。
  - `vercel.json` 设为 300。
  - `/api/market/sell` 和 `/api/market/sell-batch` 过了 180 秒就不再开始卖新的鱼，也不再发放 PEARL。没轮到的鱼回 `503`，游戏会重试。截止前刚发出的付款还可能要约 110 秒（发送时的 429 退避，加上最多 90 秒确认），所以定 180 秒，保证请求在 300 秒内结束。
  - 清扫（cron 或卖鱼之后）过了 180 秒就不再开始新的销毁或续卖，剩下的等下一次清扫。
  - 24 条鱼遇上 RPC 429 退避时可能超过 300 秒，所以加了这个截止时间。
- **Cron。** Hobby 计划最多每天一次，误差 ±59 分钟（[用量](https://vercel.com/docs/cron-jobs/usage-and-pricing)）。调用方式是对生产 URL 发 GET，带 `Authorization: Bearer $CRON_SECRET`（[管理](https://vercel.com/docs/cron-jobs/manage-cron-jobs)）。可能重复或漏掉一次；清扫是幂等的。
- **Redis。** Vercel KV 已停用，Redis 改由 Marketplace（Upstash）提供（[文档](https://vercel.com/docs/redis)）。
- **CDN。** `/api/nft/*` 的 200 响应带 `Vercel-CDN-Cache-Control: max-age=31536000`（[文档](https://vercel.com/docs/caching/cdn-cache)）。
  - CDN 缓存一年，而且不会把这个头转给浏览器，所以浏览器和钱包看到的 `Cache-Control` 和字节都与 `npm start` 输出的相同。
  - 每次部署都从新缓存开始，所以换了卡面渲染后重新部署就能生效。

### 一次性配置

这些都已经做完；写在这里是为了万一要重建项目。

1. **项目。** 在 Settings → Build and Deployment：
   - Framework Preset 选 Other；
   - Build/Install/Output 都不覆盖（由 `vercel.json` 决定）；
   - Root Directory 用仓库根目录；
   - Node.js 选 24.x（见 `package.json` 的 `engines`）。

   Fluid compute 保持开启。
2. **Redis。** Marketplace → Upstash → Redis → Create，然后连接到本项目。
   - 连接后会添加 REST URL 和 token 环境变量。代码读 `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`，或 `KV_REST_API_URL` + `KV_REST_API_TOKEN`，`UPSTASH_` 那一对优先。
   - 连接后去 Settings → Environment Variables 看看实际是哪一对。
   - Production 和 Preview 绝不能共用键：Production 用前缀 `live:`，Preview 用 `test:`（或者单独一个数据库）。
3. **环境变量。** 见下文。改了之后只对新部署生效，所以要重新部署。
4. **域名。** Settings → Domains → `breathless.gotclass.xyz`。在 Cloudflare 里它是指向 `cname.vercel-dns.com` 的 CNAME，**只用 DNS（灰色云朵）**。

**部署保护。** 本项目在 `*.vercel.app` 上开了 Vercel Authentication（`all_except_custom_domains`）：
- 预览和生产的 `*.vercel.app` 地址只能在登录了 Vercel 的浏览器里打开，直接 `curl` 会拿到登录页；
- 自定义域名是公开的。

### 环境变量

服务器（运行时）。这些变量都不会进游戏包，只有 `VITE_*` 会。

| 名称 | 环境 | 机密 | 说明 |
| --- | --- | --- | --- |
| `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`（或 `KV_REST_API_URL`、`KV_REST_API_TOKEN`） | 全部 | token 是 | Upstash 集成自动添加。 |
| `MARKET_STORE` | 全部 | 否 | `redis`。可不设（有凭据时本来就会选 Redis），设了以后数据库缺失会明确报错。在 Vercel 上文件存储会拒绝启动。 |
| `MARKET_STORE_PREFIX` | 全部 | 否 | 键前缀（默认 `market:`）。Production：`live:`。Preview：`test:`。 |
| `MARKET_SECRET_KEY` | 全部 | **是**，标为 Sensitive | 市场钱包的 64 字节私钥：keypair 文件里的 JSON 数组，或 base58。Production 用**正式**市场钱包；Preview 用**测试钱包**，绝不能放正式私钥。 |
| `CRON_SECRET` | Production | **是** | 随机串，至少 16 个字符（`openssl rand -hex 32`）。Vercel 调 cron 时会带上；不设的话 `/api/cron/sweep` 对谁都回 401。 |
| `PUBLIC_ORIGIN` | 全部 | 否 | `https://breathless.gotclass.xyz`，让 NFT JSON 指向正式游戏，和 `npm start` 输出的字节完全一致。 |
| `SOLANA_RPC` | 全部 | URL 里带 API key 时**是** | 市场用的 RPC。默认取 `VITE_SOLANA_RPC`，再没有就用公共 devnet（批量卖鱼时会 429）。它若支持 Metaplex DAS API（公共 devnet 和 Helius 都支持），`/api/market/fish` 就用它的持有人索引代替 `getProgramAccounts`；第一次读取时自动探测，无需设置。 |
| `SOLANA_RPC_CONCURRENCY` | 可选 | 否 | 同时进行的调用数，默认 3。付费套餐才调高。 |
| `PLAYER_STATE_PROGRAM_ID` | **只在 Preview** | 否 | `4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`，测试版 player_state（见 contracts/DEPLOYED.md），它的 oracle 是测试市场钱包。**Production 不设**：不设就是正式程序，oracle 是正式钱包。用测试钱包却没指向测试程序时，铸鱼会报 `0x1770`（Unauthorized）。必须和 `VITE_PLAYER_STATE_PROGRAM_ID` 一起设。 |
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
| `VITE_SOLANA_RPC` | 公共 devnet | 不设。会公开，不能用带 key 的 URL。 |
| `VITE_GEAR_NFT` | 开 | 不设 |
| `VITE_PLAYER_STATE_PROGRAM_ID` | 正式的 devnet 程序 | **只在 Preview**：`4tdodYRKyHKMPs7ZzY4yPs7CM3PnGrJV6FWfYbp7473L`，和 `PLAYER_STATE_PROGRAM_ID` 同值。**Production 不设。** |

CI（`.github/workflows/ci.yml`）构建时这些都不设。它只跑测试和构建，从不部署。

### 部署

Vercel 项目通过 Vercel 的 GitHub app（已装在 Breathless-Game 组织上）连接到 `Breathless-Game/Breathless`。
- 每次 push 到 `main` 都会自动部署 **Production**：正式市场钱包、`live:` 前缀、正式 player_state 程序。
- 每个 pull request 分支都会得到一个 **Preview** 部署（受 Vercel Authentication 保护），使用 Preview 环境变量：测试市场钱包、`test:` 前缀、测试 player_state 程序 `4tdod…`。
- 不 push 也想重新部署：控制台 → Deployments → Redeploy。

没有任何 GitHub Actions workflow 负责部署；`ci.yml` 只做检查。

改动过市场的部署上线后，检查一下生产环境：
- 完整卖一条鱼；
- 在 Settings → Cron Jobs 对 `/api/cron/sweep` 点 Run，必须回 200。回 401 且内容是 `{"error":"Unauthorized"}`，说明 `CRON_SECRET` 没设；回的是 HTML 登录页，说明请求在到达函数前被部署保护拦下了；
- 每天 UTC 04:00 的运行会在函数日志里显示为 `[market] sweep`。

### 用测试钱包做预览

**Preview 一律用测试市场钱包**和 `test:` 前缀。Preview 里绝不能放正式钱包或正式状态（`live:`）。

1. 在自己电脑上生成一次性的 devnet 钱包，例如 `solana-keygen new --no-bip39-passphrase -o /tmp/test-market.json`，再到 https://faucet.solana.com 领 devnet SOL。
2. 把文件内容填进 Preview 的 `MARKET_SECRET_KEY`（Sensitive）。同时给 Preview 设置：
   - `MARKET_STORE=redis` 和 `MARKET_STORE_PREFIX=test:`；
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
4. 要重来时，在 Upstash 控制台（Data Browser）删掉 `test:*` 键，或者给 Preview 换一个新前缀。

### 从 Dell 切换（2026-10-13 已完成）

记录如下：
- Dell 上的 `breathless` 服务已停止并禁用，GitHub 里的 `deploy` workflow 已停用（后来换成了不部署任何东西的 `ci.yml`）。Dell 已经退役。
- 它的市场状态（`.market-state.json`、`.market-fish.jsonl`、`.market-serial.json`）用 `sensor/scripts/import-to-redis.mjs` 导入了 Production 的 Redis，放在全新的前缀 `live:` 下。
- Production 的环境变量：`MARKET_STORE_PREFIX=live:`，`MARKET_SECRET_KEY` = 正式市场钱包（Sensitive），另有 `CRON_SECRET` 和 `PUBLIC_ORIGIN`。`SOLANA_RPC` 没有设，市场用公共 devnet，和 Dell 一样。`PLAYER_STATE_PROGRAM_ID` 和 `VITE_PLAYER_STATE_PROGRAM_ID` 已从 Production 删除，服务器和游戏都用正式程序 `EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ`（oracle 是正式钱包）。这两个变量和 `test:` 前缀只在 Preview 里用。
- DNS：`breathless.gotclass.xyz` 在 Cloudflare 里是指向 `cname.vercel-dns.com` 的 CNAME，**只用 DNS（灰色云朵）**。经过 Cloudflare 代理的话，Vercel 看到的是 Cloudflare 的 IP，按 IP 的限流会把玩家混在一起。

绝不要在 Vercel 之外再用正式钱包跑第二个市场：同一个钱包配两本账，同一条鱼可能被付两次钱。

### 回滚和迁出市场

**某次部署坏了。** 控制台 → Deployments：
- **Instant Rollback** 立即换回上一个 Production 部署（Hobby 计划只能回到当前这个之前的那一个）。
- 对更早的 Production 部署点 **Promote**，可以回到更早的版本。

Instant Rollback 原样复用旧的构建，包括当时打进去的 `VITE_*` 值；改了环境变量就要重新构建（Redeploy）。市场状态在 Redis 里，不属于某个部署，所以回滚不会让市场状态倒退。

**把市场迁出 Vercel**（万一以后还要再搬）：
1. 停掉 Vercel 的市场：从 Production 删除 `MARKET_SECRET_KEY` 并重新部署。之后 `/api/market` 回 503，NFT 路由照常工作。
2. 把状态导出到一个空目录：
   ```bash
   MARKET_STORE_PREFIX=live: UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
     node sensor/scripts/export-from-redis.mjs /tmp/breathless-export
   ```
   - 它按文件存储的格式（`npm start` 从市场目录读的那种）写出三个文件。
   - 在 Vercel 上的所有成交都在里面。新的服务器必须从这些文件开始，否则卖家可以重放一笔成交，再拿一次钱。
3. 用这些文件和正式钱包启动新服务器，然后才把域名指过去。

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
- **鱼编号。** Redis 保留所有 (owner, fish) → 编号；文件存储（`npm start`）只保留最近 20,000 条。

### 健康检查

Hobby 计划的运行日志只保留约一小时，所以 `.github/workflows/health.yml` 每小时（第 23 分钟）用 `scripts/health-check.mjs` 检查一次生产环境。只用公开接口和公共 devnet RPC：不需要任何机密，也不用改仓库设置。

| 检查 | 通过条件 |
| --- | --- |
| `site` | `GET /` 回 200 HTML，含 `<canvas id="scene">` 和标题。 |
| `market-info` | `GET /api/market/info` 回 200 JSON：`mode: "server"`，有 `market`、`pearlMint`、`fishCollection`、`tokenProgram`，且 `funded: true`。 |
| `market-sol` | 市场钱包至少 0.5 SOL。低于 0.5 是**警告**（服务器自己的空投线 `AIRDROP_BELOW_SOL`；空投基本领不到，要手动充值）。低于 0.02 是**严重**（`FUNDED_SOL`：info 显示 `funded: false`，初始化也会拒绝执行）。每笔成交市场大约花 0.002 SOL（卖家 PEARL 账户的租金，只在第一次卖时）加几笔手续费，所以 0.5 SOL 够两百来个新卖家。 |
| `pearl-mint` | PEARL 币是 SPL Token（不是 Token-2022），铸币权限是市场钱包。市场每次付款都是现铸，自己不持有 PEARL，所以没有 PEARL 余额可看。 |
| `fish-collection` | 鱼集合是 Metaplex Core 账户。 |
| `nft-meta`、`nft-image` | Venomous Hammerhead Shark #0026 链上的元数据 URI 回 200 `application/json` 且名字对得上，它的 `image` 回 200 `image/png`。 |
| `cron-route` | 不带授权的 `GET /api/cron/sweep` 回 401（说明函数在跑、路由还在；真正的清扫需要 `CRON_SECRET`）。 |

每个请求最多试 3 次（网络错误、20 秒超时、429 或 5xx 时重试）。三项链上检查共用一次 `getMultipleAccounts`。RPC 一直不应答时显示 `rpc-unreachable`，不算失败。

**Issue。** 有失败或警告时，开一个带 `health` 标签、指派给 Bowen1314 的 issue（GitHub 会给被指派人发邮件），标题形如 `Production health check failing: market-sol:warn, …`，正文是全部检查的表格。issue 开着的时候：
- 失败的检查集合一变，马上评论；
- 集合没变，最多每 6 小时提醒一次；
- 全部恢复后评论 "Recovered" 并关闭 issue。

无论检查结果如何，运行本身都是绿的；只有脚本自己出错才会变红。每次运行的表格也在它的 job summary 里。

**手动运行。** Actions → Health → Run workflow（勾上 `dry_run` 就只打印）。在本地运行 `node scripts/health-check.mjs` 只会打印（不在 Actions 里时默认 dry run）。公开仓库 60 天没有活动时，GitHub 会停用定时 workflow；定时运行停了的话，到 Actions 页面重新启用。

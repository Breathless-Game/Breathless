# Dell 部署 / Dell deployment

[中文](#中文) · [English](#english)

---

## 中文

**整体流程**：push 到 `main` → GitHub 云端 runner 构建并测试游戏（`build` job）→ Dell 上的 self-hosted runner 下载构建产物，运行 `deploy/deploy.sh`：同步到 `/srv/breathless/app`、只给 `sensor/` 装依赖、重启 `breathless` 服务、做健康检查。Dell 不做构建（内存小，又是共享机器）。服务只监听 `127.0.0.1:8794`，公网 HTTPS 由现有的 Cloudflare Tunnel 提供。

以下是一次性的准备清单。

### 0. 前提

- Ubuntu 22.04 或更新，x86_64。Presage 的 linux-x64 运行库要求 glibc ≥ 2.35（Ubuntu 24.04 是 2.39，没问题）。
- 这是**共享机器**：不升级系统自带的 Node 18，不动其他服务。应用用自己的 Node 24（装在 `/opt/breathless-node`），端口 8794（8080、8787 等已被占用）。
- 机器上需要 `git`、`rsync`、`curl`、`xz`；第 1 步的脚本会补装缺的。

### 1. 运行初始化脚本（root，一次性，可重复运行）

把仓库的 `deploy/` 文件夹放到 Dell 上（用你自己有权限的方式 `git clone` 私有仓库，或者 `scp -r deploy/ dell:/tmp/breathless-deploy`），然后：

```bash
sudo bash /tmp/breathless-deploy/bootstrap-dell.sh
```

它会：

1. 创建系统用户 `breathless`（家目录 `/srv/breathless`，不能登录）；
2. 从 nodejs.org 下载官方 Node 24 压缩包并校验 SHA256，装到 `/opt/breathless-node`（`sudo NODE_MAJOR=22 bash …` 可以换大版本）；
3. 安装 `/etc/systemd/system/breathless.service`（`User=breathless`、`MemoryMax=1400M`、`Restart=always`、`PORT=8794`）并 enable，第一次部署时才启动；
4. 经 `visudo -c` 检查后安装 `/etc/sudoers.d/breathless`：`breathless` 只能免密执行 `systemctl restart breathless`、`systemctl is-active breathless` 和 `journalctl -u breathless -n 50 --no-pager` 这三条命令（参数固定，没有通配符：带通配符的 journalctl 能读别的服务的日志，它的分页器还能开出 root shell）；
5. 如果没有 `/srv/breathless/app/.env`，就创建一个（权限 600，属于 `breathless`），里面只有一行空的 `PRESAGE_API_KEY=`。

它**不碰** cloudflared 和 GitHub runner，这两项在下面手动做。

### 2. 填 Presage key（你自己在 Dell 上填）

```bash
sudo -u breathless -H nano /srv/breathless/app/.env
# PRESAGE_API_KEY=<你的 key>
```

- **绝对不要把 key 贴进聊天、仓库、GitHub**（包括 Secrets、issue、PR、Actions 日志）。它只存在于 Dell 上这个文件里；`deploy.sh` 只检查它在不在，从不打印。
- 文件权限保持 600。没有 key 也能跑，只是变成模拟器模式。
- 改完要重启才生效：`sudo systemctl restart breathless`。
- 同一个文件里还可以写 `MAX_LIVE_SESSIONS`、`MAX_CONN_PER_IP`、`SENSOR_RECORD`（见 README 的「自托管」）。`PORT` 由 systemd unit 固定为 8794。

> **Presage 暂时关闭**（额度用完，HTTP 402）。代码默认关：服务器不加载 SDK、**忽略** `.env` 里的 `PRESAGE_API_KEY`、丢弃摄像头帧；游戏不请求摄像头，只用键盘（按住 Shift 下潜）。key 可以留在 `.env` 里不动。恢复时两处都要开，不用改代码：
>
> 1. 服务器：在 `/srv/breathless/app/.env` 加一行 `PRESAGE_ENABLED=1`，然后 `sudo systemctl restart breathless`。日志里的 `Presage SmartSpectra is disabled` 会变成 `Presage live, max 1 at a time`。
> 2. 游戏（构建时）：生产构建在 GitHub 云端 runner 上做（`.github/workflows/deploy.yml` 的 `build` job），`VITE_*` 只从那里的环境来，Dell 上的 `.env` 管不到它。在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 新建变量 `VITE_PRESAGE_ENABLED` = `1`，再到 Actions 里手动运行一次 **Deploy**（workflow_dispatch）或 push 一次 `main`，重新构建。
>
> 只开一边不行：只开服务器，游戏仍是纯键盘；只开游戏，服务器会回「已关闭」，游戏自动退回键盘。本地开发：`.env` 里 `PRESAGE_ENABLED=1`，`game/.env` 里（或命令行）`VITE_PRESAGE_ENABLED=1`。

### 3. 注册 GitHub self-hosted runner（仓库主 Lucas 操作）

1. 在 GitHub 打开仓库 **Settings → Actions → Runners → New self-hosted runner**，选 **Linux / x64**。页面会给出下载命令和一条带一次性 token 的 `./config.sh --url … --token …`。
2. 在 Dell 上，以 `breathless` 用户安装（runner 拒绝以 root 运行，也不应该用 root）：

   ```bash
   sudo -u breathless -H bash
   mkdir -p /srv/breathless/actions-runner && cd /srv/breathless/actions-runner
   # 粘贴 GitHub 页面上 "Download" 那几行（curl … actions-runner-linux-x64-*.tar.gz，tar xzf …）
   ./config.sh --url https://github.com/LucasYanzy/HackRU26 --token <页面上的 token> \
     --labels dell --name dell-breathless --unattended
   exit
   ```

   如果 `config.sh` 说缺依赖（如 libicu），运行 `sudo /srv/breathless/actions-runner/bin/installdependencies.sh`。
3. 装成系统服务，让它以 `breathless` 身份常驻：

   ```bash
   cd /srv/breathless/actions-runner
   sudo ./svc.sh install breathless
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

4. 回到 GitHub 的 Runners 页面，应该看到 `dell-breathless` 在线，标签是 `self-hosted`、`Linux`、`X64`、`dell`。

**为什么 runner 和应用必须是同一个 Linux 用户 `breathless`**：部署 job 要写 `/srv/breathless/app`（属于 `breathless`），而 sudoers 只允许 `breathless` 重启这个服务。应用是系统级 unit，用 `sudo -n systemctl …` 管理，所以不涉及 `systemctl --user` 的 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` 问题，也不需要 `loginctl enable-linger`。

### 4. Cloudflare：在**现有**隧道里加一条规则（不要新建隧道）

```bash
sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak.$(date +%Y%m%d-%H%M%S)
sudo nano /etc/cloudflared/config.yml
```

在 `ingress:` 列表里、最后那条 `- service: http_status:404` **之前**加一条（参考 `deploy/cloudflared.example.yml`），其他规则一律不动：

```yaml
  - hostname: <你的子域名>        # 例如 breathless.example.com
    service: http://127.0.0.1:8794
```

WebSocket（游戏的 `wss://<域名>/sensor`）会自动穿过隧道，不需要额外设置。然后：

```bash
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://<你的子域名>   # 应该匹配到 127.0.0.1:8794
grep '^tunnel:' /etc/cloudflared/config.yml                          # 现有隧道的名字或 UUID
sudo cloudflared tunnel route dns <现有隧道> <你的子域名>
sudo systemctl restart cloudflared
```

- ⚠️ 重启 cloudflared 会让这台机器上**其他所有经隧道的网站断开几秒**，挑没人用的时候做。
- `route dns` 需要 Cloudflare 的证书（`cert.pem`，通常在 `/root/.cloudflared/` 或 `/etc/cloudflared/`）。如果报找不到证书，就在 Cloudflare 控制台手动加一条 DNS：`<你的子域名>` CNAME `<隧道 UUID>.cfargotunnel.com`，开启代理（橙色云）。
- 出问题时用备份恢复：`sudo cp /etc/cloudflared/config.yml.bak.<时间> /etc/cloudflared/config.yml && sudo systemctl restart cloudflared`。

### 5. 第一次部署

push 到 `main`，或者在 GitHub **Actions → Deploy → Run workflow**（选 `main`）。在 Dell 上检查：

```bash
systemctl status breathless
journalctl -u breathless -f
curl -I http://127.0.0.1:8794/
```

### 6. 验证

1. 用 Chrome 打开 `https://<你的子域名>`，按 Enter → **Start with camera**，允许摄像头。
2. 左上角应显示 **Presage · live camera**，标签在 **BREATHING / HOLDING** 之间切换，波形在动；`journalctl -u breathless` 里能看到 `presage status: running`。
3. 显示 "Server busy" 说明已经有另一个玩家在用实时检测（`MAX_LIVE_SESSIONS=1`），这时游戏会自动改用键盘。
4. 如果一直停在 "Presage is warming up…"：实时模式以 JPEG 上传，每帧约 10–35 kB，30 fps 约 3–6 Mbit/s。在一台不在局域网里的电脑上运行 `node sensor/stream-test.mjs wss://<你的子域名>/sensor`（需先 `npm --prefix sensor install`），它会打印实际上行速率和 Presage 接收的帧数，不用摄像头就能确认隧道这条路是通的；`journalctl -u breathless` 每分钟会记一行帧率、平均帧大小和解码耗时。

### 7. 安全须知

- 只有 push 到 `main` 才会部署；在其他分支手动运行 workflow 只构建，不部署。
- self-hosted runner 只能挂在**私有**仓库上（公开仓库的 fork PR 能在 Dell 上执行代码）。能 push 到 `main` 的人等于能以 `breathless` 身份在 Dell 上运行代码、读到 `.env`，所以只给可信的人写权限。
- 服务只监听 `127.0.0.1:8794`，只有隧道能访问它；不要在防火墙上开这个端口。
- 录制默认关闭（不设 `SENSOR_RECORD`）：陌生人的呼吸数据不会落盘。
- `MAX_LIVE_SESSIONS=1` 保护 Presage 配额（SDK 一个进程也只能跑一个会话）；`MAX_CONN_PER_IP=8` 限制单个 IP 的连接数。
- `breathless` 的 sudo 权限只有上面三条固定命令；应用本身被 `MemoryMax=1400M` 限住，不会挤爆这台共享机器。

### 8. 日常运维

- 看日志：`journalctl -u breathless -f`；重启：`sudo systemctl restart breathless`。
- 回滚：部署失败会自动回滚（见第 9 节）；要回到更早的版本，在 GitHub Actions 里找到旧的那次 Deploy 运行，**Re-run all jobs**（用那次的代码重新构建并部署）。
- 升级 Node：`sudo NODE_MAJOR=<版本> bash deploy/bootstrap-dell.sh`，再触发一次部署（会重装 sensor 依赖）。

### 9. 回滚

- **保留什么**：每次部署前，`deploy.sh` 把当前线上版本（`sensor/` 连同 `node_modules`、`game/dist/`、`package.json`）用硬链接快照到 `/srv/breathless/app/.rollback/`，只保留**一份**（上一个版本）。硬链接几乎不占磁盘；依赖变了的那次部署之后，旧的 `node_modules` 会多占一份空间，直到下一次部署。`.rollback/RELEASE` 是那个版本的 commit，`/srv/breathless/app/RELEASE` 是当前线上的 commit。
- **健康检查**：重启后在 `HEALTH_TIMEOUT`（60 秒）内，`http://127.0.0.1:8794/` 必须返回新的 `index.html`，并且 `http://127.0.0.1:8794/api/market/info` 必须返回 200 和 JSON。没有市场（或市场暂时坏了）时，在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 里加变量 `HEALTH_MARKET=0` 跳过第二项，不用改代码。
- **自动回滚**：同步开始之后任何一步失败（`npm ci`、重启、健康检查、任务被取消），就把 `.rollback` 恢复回去、重启、再做一次健康检查。部署任务仍然是**红的**，日志里写 `ROLLED BACK to previous release <commit>`；如果回滚后也不健康，写 `ROLLBACK FAILED`，需要人工处理。第一次部署没有备份，失败就和以前一样直接报错。
- **手动回滚**（回到 `.rollback` 里的那个版本，比如新版本通过了健康检查但有 bug）：在 Dell 上以 `breathless` 用户运行仓库里任意一份 `deploy/deploy.sh --rollback`，例如 runner 工作目录里的那份：`sudo -u breathless bash <checkout>/deploy/deploy.sh --rollback`。它只用 `.rollback`，不需要构建产物，只用上面三条允许的 sudo 命令。回滚后 `.rollback` 不变，下一次部署会重新备份。
- **永远不碰**：`/srv/breathless/app/.env`、`sensor/.market-*`（市场密钥和状态、鱼的集合与种子登记）和 `sensor/recordings/`。它们不进备份，部署和回滚都不会覆盖或删除它们，所以回滚不会让市场状态倒退。

---

## English

**How it works**: a push to `main` builds and tests the game on GitHub's hosted runner (`build` job); then the self-hosted runner on the Dell downloads the build and runs `deploy/deploy.sh`: sync into `/srv/breathless/app`, install `sensor/` dependencies only, restart the `breathless` service, health check. The Dell never builds (little RAM, shared box). The service listens on `127.0.0.1:8794` only; public HTTPS comes from the existing Cloudflare Tunnel.

One-time checklist:

### 0. Prerequisites

- Ubuntu 22.04 or newer, x86_64. The Presage linux-x64 runtime needs glibc ≥ 2.35 (Ubuntu 24.04 ships 2.39).
- This is a **shared box**: don't upgrade the system Node 18 or touch other services. The app gets its own Node 24 in `/opt/breathless-node` and port 8794 (8080, 8787 and others are taken).
- `git`, `rsync`, `curl`, `xz` are needed; step 1's script installs whichever is missing.

### 1. Run the bootstrap script (root, once, safe to re-run)

Get the repo's `deploy/` folder onto the Dell (`git clone` the private repo with your own access, or `scp -r deploy/ dell:/tmp/breathless-deploy`), then:

```bash
sudo bash /tmp/breathless-deploy/bootstrap-dell.sh
```

It:

1. creates the system user `breathless` (home `/srv/breathless`, no login shell);
2. downloads the official Node 24 tarball from nodejs.org, checks its SHA256 and installs it to `/opt/breathless-node` (`sudo NODE_MAJOR=22 bash …` picks another major);
3. installs `/etc/systemd/system/breathless.service` (`User=breathless`, `MemoryMax=1400M`, `Restart=always`, `PORT=8794`) and enables it; the first deploy starts it;
4. installs `/etc/sudoers.d/breathless` after `visudo -c`: `breathless` may run, without a password, exactly `systemctl restart breathless`, `systemctl is-active breathless` and `journalctl -u breathless -n 50 --no-pager` (arguments pinned, no wildcards: a wildcard journalctl could read other services' logs, and its pager can open a root shell);
5. creates `/srv/breathless/app/.env` (mode 600, owned by `breathless`) with an empty `PRESAGE_API_KEY=` line, only if the file doesn't exist.

It does **not** touch cloudflared or the GitHub runner; those are the manual steps below.

### 2. Add the Presage key (yourself, on the Dell)

```bash
sudo -u breathless -H nano /srv/breathless/app/.env
# PRESAGE_API_KEY=<your key>
```

- **Never paste the key into a chat, the repo, or GitHub** (Secrets, issues, PRs, Actions logs included). It lives only in this file on the Dell; `deploy.sh` checks that it is there and never prints it.
- Keep the file at mode 600. Without a key the server still runs, in simulator mode.
- Restart to apply changes: `sudo systemctl restart breathless`.
- The same file can set `MAX_LIVE_SESSIONS`, `MAX_CONN_PER_IP`, `SENSOR_RECORD` (README, "Self-hosting"). `PORT` is pinned to 8794 by the systemd unit.

> **Presage is temporarily off** (its credits ran out, HTTP 402). Off is the default in code: the server never loads the SDK, **ignores** `PRESAGE_API_KEY` in `.env` and drops camera frames; the game never asks for the camera and plays on the keyboard (hold Shift to dive). The key can stay in `.env`. To turn it back on, flip both switches; no code change:
>
> 1. Server: add `PRESAGE_ENABLED=1` to `/srv/breathless/app/.env`, then `sudo systemctl restart breathless`. The log's `Presage SmartSpectra is disabled` line becomes `Presage live, max 1 at a time`.
> 2. Game (build time): the production build runs on GitHub's runner (the `build` job in `.github/workflows/deploy.yml`) and gets its `VITE_*` values only from there; the Dell's `.env` never reaches it. Create the repository variable `VITE_PRESAGE_ENABLED` = `1` under **Settings → Secrets and variables → Actions → Variables**, then run the **Deploy** workflow by hand (workflow_dispatch) or push to `main` to rebuild.
>
> One without the other doesn't work: the server alone leaves the game keyboard-only; the game alone gets "turned off" from the server and drops back to the keyboard. Local dev: `PRESAGE_ENABLED=1` in `.env`, and `VITE_PRESAGE_ENABLED=1` in `game/.env` (or on the command line).

### 3. Register the GitHub self-hosted runner (repo owner, Lucas)

1. On GitHub open the repo's **Settings → Actions → Runners → New self-hosted runner** and pick **Linux / x64**. The page shows the download commands and a `./config.sh --url … --token …` line with a one-time token.
2. On the Dell, install it as the `breathless` user (the runner refuses to run as root, and shouldn't):

   ```bash
   sudo -u breathless -H bash
   mkdir -p /srv/breathless/actions-runner && cd /srv/breathless/actions-runner
   # paste the "Download" lines from the GitHub page (curl … actions-runner-linux-x64-*.tar.gz, tar xzf …)
   ./config.sh --url https://github.com/LucasYanzy/HackRU26 --token <token from the page> \
     --labels dell --name dell-breathless --unattended
   exit
   ```

   If `config.sh` reports missing dependencies (e.g. libicu), run `sudo /srv/breathless/actions-runner/bin/installdependencies.sh`.
3. Install it as a system service that runs as `breathless`:

   ```bash
   cd /srv/breathless/actions-runner
   sudo ./svc.sh install breathless
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

4. GitHub's Runners page should now show `dell-breathless` online with the labels `self-hosted`, `Linux`, `X64`, `dell`.

**Why the runner and the app must be the same Linux user, `breathless`**: the deploy job writes `/srv/breathless/app` (owned by `breathless`), and sudoers lets only `breathless` restart the service. The app is a system unit managed with `sudo -n systemctl …`, so the `systemctl --user` pitfalls (`XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` unset inside a service) and `loginctl enable-linger` don't apply.

### 4. Cloudflare: add one rule to the **existing** tunnel (don't create a new one)

```bash
sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak.$(date +%Y%m%d-%H%M%S)
sudo nano /etc/cloudflared/config.yml
```

Inside the `ingress:` list, **above** the final `- service: http_status:404`, add this rule (see `deploy/cloudflared.example.yml`) and leave every other rule alone:

```yaml
  - hostname: <your subdomain>      # e.g. breathless.example.com
    service: http://127.0.0.1:8794
```

WebSockets (the game's `wss://<hostname>/sensor`) pass through the tunnel automatically; nothing else to set. Then:

```bash
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://<your subdomain>   # should match 127.0.0.1:8794
grep '^tunnel:' /etc/cloudflared/config.yml                            # the existing tunnel's name or UUID
sudo cloudflared tunnel route dns <existing tunnel> <your subdomain>
sudo systemctl restart cloudflared
```

- ⚠️ Restarting cloudflared **drops every other site on this tunnel for a few seconds**. Do it at a quiet time.
- `route dns` needs the Cloudflare origin certificate (`cert.pem`, usually in `/root/.cloudflared/` or `/etc/cloudflared/`). If it can't find one, add the DNS record in the Cloudflare dashboard instead: `<your subdomain>` CNAME `<tunnel UUID>.cfargotunnel.com`, proxied (orange cloud).
- To undo: `sudo cp /etc/cloudflared/config.yml.bak.<time> /etc/cloudflared/config.yml && sudo systemctl restart cloudflared`.

### 5. First deploy

Push to `main`, or GitHub **Actions → Deploy → Run workflow** on `main`. On the Dell:

```bash
systemctl status breathless
journalctl -u breathless -f
curl -I http://127.0.0.1:8794/
```

### 6. Verify

1. Open `https://<your subdomain>` in Chrome, press Enter → **Start with camera**, allow the camera.
2. The top-left should read **Presage · live camera**, the chip should switch between **BREATHING** and **HOLDING**, and the waveform should move; `journalctl -u breathless` shows `presage status: running`.
3. "Server busy" means another player is already using live sensing (`MAX_LIVE_SESSIONS=1`); the game then switches to the keyboard by itself.
4. If it stays on "Presage is warming up…": live mode uploads JPEG frames of about 10–35 kB, 3–6 Mbit/s at 30 fps. From a machine outside the LAN, `node sensor/stream-test.mjs wss://<your subdomain>/sensor` (after `npm --prefix sensor install`) prints the real upload rate and how many frames Presage accepted, so the tunnel path can be checked without a camera. `journalctl -u breathless` logs a line a minute with the frame rate, average frame size and decode time.

### 7. Security notes

- Only pushes to `main` deploy; running the workflow by hand on another branch only builds.
- Keep the self-hosted runner on a **private** repo (fork PRs to a public repo could run code on the Dell). Anyone who can push to `main` can run code on the Dell as `breathless` and read `.env`, so only give write access to people you trust.
- The server binds `127.0.0.1:8794`; only the tunnel exposes it. Don't open that port in the firewall.
- Recordings are off by default (`SENSOR_RECORD` unset): strangers' breathing data is never written to disk.
- `MAX_LIVE_SESSIONS=1` protects the Presage quota (and the SDK can only run one session per process anyway); `MAX_CONN_PER_IP=8` limits connections per IP.
- `breathless` can sudo only the three pinned commands above, and the app is capped by `MemoryMax=1400M` so it can't starve the shared box.

### 8. Day-to-day

- Logs: `journalctl -u breathless -f`. Restart: `sudo systemctl restart breathless`.
- Roll back: a failed deploy rolls back by itself (section 9). To go further back, open an older Deploy run in GitHub Actions and **Re-run all jobs** (rebuilds and deploys that commit).
- Upgrade Node: `sudo NODE_MAJOR=<major> bash deploy/bootstrap-dell.sh`, then deploy again (the sensor's dependencies get reinstalled).

### 9. Rollback

- **What is kept**: before each deploy, `deploy.sh` snapshots the live release (`sensor/` with its `node_modules`, `game/dist/`, `package.json`) into `/srv/breathless/app/.rollback/` with hard links, and keeps exactly **one** (the previous release). Hard links cost almost no disk; after a deploy that changed dependencies, the old `node_modules` takes its own space until the next deploy. `.rollback/RELEASE` holds that release's commit, `/srv/breathless/app/RELEASE` the live one.
- **Health check**: within `HEALTH_TIMEOUT` (60 s) of the restart, `http://127.0.0.1:8794/` must serve the new `index.html` and `http://127.0.0.1:8794/api/market/info` must answer 200 with JSON. Without the market (or while it is down), add the repository variable `HEALTH_MARKET=0` (**Settings → Secrets and variables → Actions → Variables**) to skip the second check, no code change needed.
- **Automatic rollback**: if anything fails once the sync has started (`npm ci`, the restart, the health check, the job being cancelled), `.rollback` is restored, the service restarted and checked again. The deploy job still goes **red**, with `ROLLED BACK to previous release <commit>` in the log; if the restored release isn't healthy either, it says `ROLLBACK FAILED` and needs a human. A first deploy has no backup and fails as before.
- **Manual rollback** (back to the release in `.rollback`, e.g. when a new release passed the health check but has a bug): on the Dell, as `breathless`, run any checkout's `deploy/deploy.sh --rollback`, e.g. the runner's: `sudo -u breathless bash <checkout>/deploy/deploy.sh --rollback`. It uses only `.rollback` (no build artifact) and only the three allowed sudo commands. `.rollback` stays as it is; the next deploy takes a fresh backup.
- **Never touched**: `/srv/breathless/app/.env`, `sensor/.market-*` (the market's keys and state, the fish collection and seed registry) and `sensor/recordings/`. They are not in the backup, and neither a deploy nor a rollback overwrites or deletes them, so a rollback never winds the market's state back.

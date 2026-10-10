#!/usr/bin/env bash
# Deploys Breathless on the Dell. Run by the GitHub Actions `deploy` job, as the
# `breathless` user, from a checkout whose game/dist holds the build artifact:
#
#   1. rsync sensor/, game/dist/ and package.json into DEPLOY_DIR
#      (DEPLOY_DIR/.env, sensor/recordings/ and the PEARL market's keys and
#      state, sensor/.market-*, are never touched)
#   2. npm ci --omit=dev in sensor/, only when its lockfile or Node changed
#   3. restart the systemd unit (sudoers-breathless allows exactly that)
#   4. wait until http://127.0.0.1:$PORT/ serves the new index.html
#
# Safe to re-run. Overridable: DEPLOY_DIR, NODE_BIN, PORT, HEALTH_TIMEOUT.
# One-time setup: deploy/SETUP.md.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/srv/breathless/app}"
NODE_BIN="${NODE_BIN:-/opt/breathless-node/bin/node}"
PORT="${PORT:-8794}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
SERVICE=breathless

log() { printf '[deploy] %s\n' "$*"; }
die() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}
sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# npm's shebang is `#!/usr/bin/env node`: put our Node first on PATH, or npm would
# run on the box's system Node 18.
NODE_DIR="$(dirname "$NODE_BIN")"
[[ -x "$NODE_BIN" && -x "$NODE_DIR/npm" ]] || die "no Node at $NODE_BIN: run deploy/bootstrap-dell.sh (or set NODE_BIN)"
export PATH="$NODE_DIR:$PATH"
command -v rsync >/dev/null || die "rsync is not installed"
command -v curl >/dev/null || die "curl is not installed"
[[ -f "$SRC_DIR/game/dist/index.html" ]] || die "$SRC_DIR/game/dist is missing: download the build artifact first"

log "node $("$NODE_BIN" -v), $SRC_DIR -> $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/sensor" "$DEPLOY_DIR/game/dist"

# 1. Sync. Each rsync --delete is scoped to its own folder, so DEPLOY_DIR/.env is
#    outside every one of them; node_modules, recordings and the market's
#    keypairs + state (.market-*) are excluded and protected (P) so --delete can
#    never remove them.
rsync -a --delete \
  --exclude='/node_modules/' --exclude='/recordings/' --exclude='/.market-*' --exclude='.env' \
  --filter='P /node_modules/' --filter='P /recordings/' --filter='P /.market-*' \
  "$SRC_DIR/sensor/" "$DEPLOY_DIR/sensor/"
rsync -a --delete "$SRC_DIR/game/dist/" "$DEPLOY_DIR/game/dist/"
rsync -a "$SRC_DIR/package.json" "$DEPLOY_DIR/package.json"

# 2. Sensor dependencies. npm ci pulls every platform's Presage runtime (a few
#    hundred MB), so skip it when nothing it depends on changed.
stamp="$DEPLOY_DIR/sensor/node_modules/.breathless-deps"
want="$(sha256 "$DEPLOY_DIR/sensor/package-lock.json") node-$("$NODE_BIN" -v)"
if [[ -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
  log "sensor dependencies unchanged"
else
  log "npm ci --omit=dev in sensor/"
  (cd "$DEPLOY_DIR/sensor" && npm ci --omit=dev --no-audit --no-fund)
  printf '%s\n' "$want" >"$stamp"
fi

# The key itself is never printed, only whether it is there.
if [[ ! -f "$DEPLOY_DIR/.env" ]] || ! grep -Eq '^[[:space:]]*PRESAGE_API_KEY=[^[:space:]#]' "$DEPLOY_DIR/.env"; then
  log "WARNING: no PRESAGE_API_KEY in $DEPLOY_DIR/.env: the server will run the simulator only (deploy/SETUP.md, step 2)"
fi

# 3. Restart. Only these exact sudo commands are allowed (deploy/sudoers-breathless).
log "restarting $SERVICE"
sudo -n /usr/bin/systemctl restart "$SERVICE"

# 4. Health check: the new index.html must come back from the server.
url="http://127.0.0.1:$PORT/"
deadline=$((SECONDS + HEALTH_TIMEOUT))
until curl -fsS --max-time 5 "$url" 2>/dev/null | cmp -s - "$DEPLOY_DIR/game/dist/index.html"; do
  if ((SECONDS >= deadline)); then
    log "health check failed: $url did not serve the new build within ${HEALTH_TIMEOUT}s"
    sudo -n /usr/bin/systemctl is-active "$SERVICE" || true
    sudo -n /usr/bin/journalctl -u "$SERVICE" -n 50 --no-pager || true
    exit 1
  fi
  sleep 2
done
log "healthy: $url ($(sudo -n /usr/bin/systemctl is-active "$SERVICE" || true))"

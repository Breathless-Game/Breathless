#!/usr/bin/env bash
# Deploys Breathless on the Dell. Run by the GitHub Actions `deploy` job, as the
# `breathless` user, from a checkout whose game/dist holds the build artifact:
#
#   0. snapshot the live release into DEPLOY_DIR/.rollback (hard links, so it
#      costs almost no disk; exactly one previous release is kept)
#   1. rsync sensor/, game/dist/ and package.json into DEPLOY_DIR
#      (DEPLOY_DIR/.env, sensor/recordings/ and the PEARL market's keys and
#      state, sensor/.market-*, are never touched)
#   2. npm ci --omit=dev in sensor/, only when its lockfile or Node changed
#   3. restart the systemd unit (sudoers-breathless allows exactly that)
#   4. wait until http://127.0.0.1:$PORT/ serves the new index.html and
#      /api/market/info answers 200 with JSON
#
# If anything fails after step 1 has started, the previous release is restored
# from .rollback, the service restarted and checked again, and the script still
# exits non-zero ("ROLLED BACK"), so the GitHub run stays red.
#
#   bash deploy/deploy.sh             deploy this checkout
#   bash deploy/deploy.sh --rollback  restore .rollback by hand (deploy/SETUP.md)
#
# Safe to re-run. Overridable: DEPLOY_DIR, NODE_BIN, PORT, HEALTH_TIMEOUT,
# HEALTH_INTERVAL, HEALTH_MARKET=0 (skip the market check). One-time setup:
# deploy/SETUP.md. Tests: deploy/test-deploy.sh.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/srv/breathless/app}"
NODE_BIN="${NODE_BIN:-/opt/breathless-node/bin/node}"
PORT="${PORT:-8794}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
HEALTH_MARKET="${HEALTH_MARKET:-1}"
SERVICE=breathless
MODE=deploy
case "${1:-}" in
  '') ;;
  --rollback) MODE=rollback ;;
  *)
    printf 'usage: %s [--rollback]\n' "$0" >&2
    exit 64
    ;;
esac

log() { printf '[deploy] %s\n' "$*"; }
die() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}
# A line GitHub also shows on the run's summary page.
loud() {
  log "$*"
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then printf '::error::%s\n' "$*"; fi
}
sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
# Write a small file by rename, never in place: an existing file may be a hard
# link shared with .rollback, and writing through it would change the backup too.
write_file() {
  printf '%s\n' "$2" >"$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"
}

# npm's shebang is `#!/usr/bin/env node`: put our Node first on PATH, or npm would
# run on the box's system Node 18.
NODE_DIR="$(dirname "$NODE_BIN")"
[[ -x "$NODE_BIN" && -x "$NODE_DIR/npm" ]] || die "no Node at $NODE_BIN: run deploy/bootstrap-dell.sh (or set NODE_BIN)"
export PATH="$NODE_DIR:$PATH"
command -v rsync >/dev/null || die "rsync is not installed"
command -v curl >/dev/null || die "curl is not installed"
if [[ "$MODE" == deploy ]]; then
  [[ -f "$SRC_DIR/game/dist/index.html" ]] || die "$SRC_DIR/game/dist is missing: download the build artifact first"
fi

mkdir -p "$DEPLOY_DIR/sensor" "$DEPLOY_DIR/game/dist"
DEPLOY_DIR="$(cd "$DEPLOY_DIR" && pwd)" # --link-dest wants an absolute path
BACKUP="$DEPLOY_DIR/.rollback"          # outside every synced (--delete) folder
NEW_SHA="${GITHUB_SHA:-$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo unknown)}"
PREV_SHA=unknown
if [[ -s "$DEPLOY_DIR/RELEASE" ]]; then PREV_SHA="$(head -n 1 "$DEPLOY_DIR/RELEASE")"; fi

# Live state that stays where it is through every deploy and rollback: excluded
# (never copied into or out of a release) and protected (P) from --delete.
# node_modules is not in this list: deploys exclude it themselves (npm ci owns
# it), while backups and restores carry it along with the release.
KEEP=(--exclude='/recordings/' --exclude='/.market-*' --exclude='.env'
  --filter='P /recordings/' --filter='P /.market-*')

# ---- health check -----------------------------------------------------------
# Against the local port, not the tunnel. The market is imported lazily after
# the server starts listening, so /api/market answers 503 for a few seconds:
# both checks are retried until HEALTH_TIMEOUT.
url="http://127.0.0.1:$PORT/"
market_url="${url}api/market/info"

index_ok() { curl -fsS --max-time 5 "$url" 2>/dev/null | cmp -s - "$DEPLOY_DIR/game/dist/index.html"; }
# -f turns any 4xx/5xx (the 503 of a market that failed to load) into a failure;
# the body must then parse as a JSON object.
market_ok() {
  curl -fsS --max-time 15 -H 'Accept: application/json' "$market_url" 2>/dev/null |
    "$NODE_BIN" -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j && typeof j === "object" ? 0 : 1)' 2>/dev/null
}

healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) problem
  while :; do
    problem=''
    if ! index_ok; then
      problem="$url did not serve the expected index.html"
    elif [[ "$HEALTH_MARKET" != 0 ]] && ! market_ok; then
      problem="$market_url did not answer 200 with JSON"
    fi
    if [[ -z "$problem" ]]; then return 0; fi
    if ((SECONDS >= deadline)); then
      log "health check failed: $problem within ${HEALTH_TIMEOUT}s"
      sudo -n /usr/bin/systemctl is-active "$SERVICE" || true
      sudo -n /usr/bin/journalctl -u "$SERVICE" -n 50 --no-pager || true
      return 1
    fi
    sleep "$HEALTH_INTERVAL"
  done
}

restart() {
  log "restarting $SERVICE"
  # Only these exact sudo commands are allowed (deploy/sudoers-breathless).
  sudo -n /usr/bin/systemctl restart "$SERVICE"
}

# ---- rollback ---------------------------------------------------------------
# Put .rollback back over sensor/ (node_modules included), game/dist/ and
# package.json. First empty both folders except the live state (an rsync --delete
# from an empty dir, with the same KEEP rules), then fill them from the backup.
# Not a plain rsync over the top: its size + mtime quick check would skip files
# that differ, and npm gives every installed file the same fixed mtime
# (1985-10-26), so a dependency's same-size files from two versions would never be
# put back. --link-dest makes the restored files hard links to the backup instead
# of copies, so restoring hundreds of MB of node_modules costs no disk.
restore() {
  local empty="$DEPLOY_DIR/.rollback.empty"
  log "restoring release $(head -n 1 "$BACKUP/RELEASE") from $BACKUP"
  rm -rf "$empty" && mkdir "$empty" &&
    rsync -a --delete "${KEEP[@]}" "$empty/" "$DEPLOY_DIR/sensor/" &&
    rsync -a --delete "$empty/" "$DEPLOY_DIR/game/dist/" &&
    rmdir "$empty" &&
    rsync -a --link-dest="$BACKUP/sensor" "${KEEP[@]}" "$BACKUP/sensor/" "$DEPLOY_DIR/sensor/" &&
    rsync -a --link-dest="$BACKUP/game/dist" "$BACKUP/game/dist/" "$DEPLOY_DIR/game/dist/" &&
    { [[ ! -f "$BACKUP/package.json" ]] || rsync -a -I "$BACKUP/package.json" "$DEPLOY_DIR/package.json"; } &&
    write_file "$DEPLOY_DIR/RELEASE" "$(head -n 1 "$BACKUP/RELEASE")"
}

have_backup() { [[ -f "$BACKUP/game/dist/index.html" && -f "$BACKUP/RELEASE" ]]; }

# Armed from the first change to the live files until the new release is healthy:
# any exit in between (a failed rsync, npm ci, restart or health check, or the
# job being cancelled) rolls back.
ARMED=0
on_exit() {
  local rc=$1
  trap - EXIT
  set +e
  if ((rc == 0 || ARMED == 0)); then exit "$rc"; fi
  ARMED=0
  if ! have_backup; then
    loud "deploy of $NEW_SHA FAILED (exit $rc) and there is no previous release to roll back to"
    exit "$rc"
  fi
  log "deploy of $NEW_SHA failed (exit $rc): rolling back"
  if restore && restart && healthy; then
    loud "ROLLED BACK to previous release $(head -n 1 "$BACKUP/RELEASE"): $NEW_SHA failed and is NOT live"
    exit 1
  fi
  loud "ROLLBACK FAILED: deploy of $NEW_SHA failed and restoring $(head -n 1 "$BACKUP/RELEASE") did not come back healthy either; the site may be down (deploy/SETUP.md, Rollback)"
  exit 2
}
trap 'on_exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$MODE" == rollback ]]; then
  have_backup || die "no previous release in $BACKUP"
  restore || die "restoring $BACKUP failed"
  restart
  healthy || die "$(head -n 1 "$BACKUP/RELEASE") restored but not healthy"
  log "rolled back by hand: live release is $(head -n 1 "$DEPLOY_DIR/RELEASE")"
  exit 0
fi

log "node $("$NODE_BIN" -v), $SRC_DIR -> $DEPLOY_DIR, release $PREV_SHA -> $NEW_SHA"

# 0. Backup. Hard links through rsync --link-dest (GNU `cp -al` is not on macOS,
#    where the tests run). Safe because nothing below writes into a live file in
#    place: rsync writes a temp file and renames it over the old one, --delete and
#    npm ci unlink, and write_file renames. Built aside, then swapped in, so a
#    failure here leaves the old backup and the live site as they were.
if [[ -f "$DEPLOY_DIR/game/dist/index.html" ]]; then
  log "backing up release $PREV_SHA to $BACKUP"
  rm -rf "$BACKUP.new" "$BACKUP.old"
  mkdir -p "$BACKUP.new/sensor" "$BACKUP.new/game/dist"
  rsync -a --link-dest="$DEPLOY_DIR/sensor" "${KEEP[@]}" "$DEPLOY_DIR/sensor/" "$BACKUP.new/sensor/"
  rsync -a --link-dest="$DEPLOY_DIR/game/dist" "$DEPLOY_DIR/game/dist/" "$BACKUP.new/game/dist/"
  if [[ -f "$DEPLOY_DIR/package.json" ]]; then cp -p "$DEPLOY_DIR/package.json" "$BACKUP.new/package.json"; fi
  write_file "$BACKUP.new/RELEASE" "$PREV_SHA"
  if [[ -d "$BACKUP" ]]; then mv "$BACKUP" "$BACKUP.old"; fi
  mv "$BACKUP.new" "$BACKUP"
  rm -rf "$BACKUP.old"
elif have_backup; then
  # No live release but a backup, e.g. after a rollback that failed half-way:
  # keep it, it is still the last release known to have worked.
  log "no live release in $DEPLOY_DIR: keeping $BACKUP ($(head -n 1 "$BACKUP/RELEASE")) to roll back to"
else
  log "no release in $DEPLOY_DIR yet: first deploy, nothing to back up"
fi

ARMED=1

# 1. Sync. Each rsync --delete is scoped to its own folder, so DEPLOY_DIR/.env and
#    DEPLOY_DIR/.rollback are outside every one of them; node_modules, recordings
#    and the market's keypairs + state (.market-*) are excluded and protected (P)
#    so --delete can never remove them.
rsync -a --delete \
  --exclude='/node_modules/' --filter='P /node_modules/' "${KEEP[@]}" \
  "$SRC_DIR/sensor/" "$DEPLOY_DIR/sensor/"
rsync -a --delete "$SRC_DIR/game/dist/" "$DEPLOY_DIR/game/dist/"
rsync -a "$SRC_DIR/package.json" "$DEPLOY_DIR/package.json"
write_file "$DEPLOY_DIR/RELEASE" "$NEW_SHA"

# 2. Sensor dependencies. npm ci pulls every platform's Presage runtime (a few
#    hundred MB), so skip it when nothing it depends on changed.
stamp="$DEPLOY_DIR/sensor/node_modules/.breathless-deps"
want="$(sha256 "$DEPLOY_DIR/sensor/package-lock.json") node-$("$NODE_BIN" -v)"
if [[ -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
  log "sensor dependencies unchanged"
else
  log "npm ci --omit=dev in sensor/"
  (cd "$DEPLOY_DIR/sensor" && npm ci --omit=dev --no-audit --no-fund)
  write_file "$stamp" "$want"
fi

# The key itself is never printed, only whether it is there.
if [[ ! -f "$DEPLOY_DIR/.env" ]] || ! grep -Eq '^[[:space:]]*PRESAGE_API_KEY=[^[:space:]#]' "$DEPLOY_DIR/.env"; then
  log "WARNING: no PRESAGE_API_KEY in $DEPLOY_DIR/.env: the server will run the simulator only (deploy/SETUP.md, step 2)"
fi

# 3. Restart.
restart

# 4. Health check: the new index.html must come back from the server, and the
#    PEARL market must answer (HEALTH_MARKET=0 skips that part).
healthy || exit 1
ARMED=0
log "healthy: $url ($(sudo -n /usr/bin/systemctl is-active "$SERVICE" || true)), release $NEW_SHA is live, $PREV_SHA kept in $BACKUP"

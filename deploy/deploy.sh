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
#      /api/health says the PEARL market module loaded; /api/market/info is
#      only advisory (a WARNING, never a rollback: it waits on the Solana RPC)
#
# If anything fails after step 1 has started, the previous release is restored
# from .rollback, the service restarted and checked again, and the script still
# exits non-zero ("ROLLED BACK"), so the GitHub run stays red.
#
#   bash deploy/deploy.sh             deploy this checkout
#   bash deploy/deploy.sh --rollback  restore .rollback by hand (deploy/SETUP.md)
#
# Safe to re-run. Overridable: DEPLOY_DIR, NODE_BIN, PORT, HEALTH_TIMEOUT,
# HEALTH_INTERVAL, HEALTH_MARKET=0 (skip the market checks). One-time setup:
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
warn() {
  log "WARNING: $*"
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then printf '::warning::%s\n' "$*"; fi
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
# Against the local port, not the tunnel, retried until HEALTH_TIMEOUT. Only a
# sign that the release itself is broken fails the deploy (and so rolls back):
#   - / not serving the new index.html: the process is down or crashed
#   - /api/health saying the PEARL market module failed to load, or never
#     finished loading (HEALTH_MARKET=1); answered from memory, no RPC call
# /api/market/info is still asked, but only warns: it waits on the Solana RPC (a
# balance read), so a public-RPC 429 storm stalls it for minutes while the server
# is fine. A release from before /api/health (a 404, e.g. the one a rollback
# restores) is gated on index.html alone.
url="http://127.0.0.1:$PORT/"
health_url="${url}api/health"
market_url="${url}api/market/info"

index_ok() { curl -fsS --max-time 5 "$url" 2>/dev/null | cmp -s - "$DEPLOY_DIR/game/dist/index.html"; }
# The market's state in /api/health: starting, up or failed. "none" when the
# route is a 404 (an older release), nothing when it didn't answer 200 + JSON.
market_state() {
  local out code nl=$'\n'
  out="$(curl -sS --max-time 5 -H 'Accept: application/json' -w '\n%{http_code}' "$health_url" 2>/dev/null)" || return 0
  code=${out##*$nl}
  if [[ "$code" == 404 ]]; then
    echo none
  elif [[ "$code" == 200 ]]; then
    printf '%s' "${out%$nl*}" |
      "$NODE_BIN" -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); if (typeof j?.market === "string") console.log(j.market)' 2>/dev/null || true
  fi
}
# -f turns any 4xx/5xx (a 503 while the RPC throttles us) into a failure; the
# body must then parse as a JSON object.
market_ok() {
  curl -fsS --max-time 15 -H 'Accept: application/json' "$market_url" 2>/dev/null |
    "$NODE_BIN" -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j && typeof j === "object" ? 0 : 1)' 2>/dev/null
}

healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) problem state='' info
  while :; do
    problem=''
    info=ok
    if ! index_ok; then
      problem="$url did not serve the expected index.html"
    elif [[ "$HEALTH_MARKET" != 0 ]]; then
      state="$(market_state)"
      case "$state" in
        up | none) market_ok || info=slow ;;
        failed) problem="the PEARL market failed to load ($health_url: market $state)" ;;
        '') problem="$health_url did not answer 200 with JSON" ;;
        *) problem="the PEARL market did not finish loading ($health_url: market $state)" ;;
      esac
    fi
    if [[ -z "$problem" && "$info" == ok ]]; then return 0; fi
    if ((SECONDS >= deadline)); then
      if [[ -z "$problem" ]]; then
        if [[ "$state" == none ]]; then
          warn "$market_url did not answer 200 with JSON within ${HEALTH_TIMEOUT}s; this release has no /api/health, so index.html alone decides"
        else
          warn "$market_url did not answer 200 with JSON within ${HEALTH_TIMEOUT}s, but the server is up and the PEARL market loaded: most likely the Solana RPC rate-limiting us (429), so no rollback"
        fi
        return 0
      fi
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
#    PEARL market module must have loaded (HEALTH_MARKET=0 skips that part); a
#    slow /api/market/info only warns.
healthy || exit 1
ARMED=0
log "healthy: $url ($(sudo -n /usr/bin/systemctl is-active "$SERVICE" || true)), release $NEW_SHA is live, $PREV_SHA kept in $BACKUP"

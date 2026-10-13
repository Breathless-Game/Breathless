#!/usr/bin/env bash
# Tests deploy/deploy.sh (backup, health checks, rollback) against a temp
# DEPLOY_DIR, with fakes on PATH: sudo records calls and refuses anything
# sudoers-breathless doesn't allow, curl answers from what was "live" at the last
# restart, npm `ci` rebuilds node_modules from the lockfile. Node is real.
#
#   bash deploy/test-deploy.sh
#
# Runs on Linux (GNU rsync, CI) and macOS (openrsync, bash 3.2).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_NODE="$(command -v node)" || {
  echo "node is required" >&2
  exit 1
}
TMP="$(mktemp -d "${TMPDIR:-/tmp}/deploy-test.XXXXXX")"
TMP="$(cd "$TMP" && pwd)"
trap 'rm -rf "$TMP"' EXIT

export DEPLOY_DIR="$TMP/app"
export FAKE_STATE="$TMP/state" # what the fake server serves
export FAKE_LOG="$TMP/log"     # sudo.log, curl.log, npm.log of the last run
FAKES="$TMP/fakes"
mkdir -p "$FAKES/bin" "$FAKES/node"

# ---- fakes ------------------------------------------------------------------
ln -s "$REAL_NODE" "$FAKES/node/node"

cat >"$FAKES/node/npm" <<'EOF'
#!/usr/bin/env bash
# Fake npm: `ci` removes node_modules, then installs a "dependency" built from the
# lockfile, or fails half-way when FAKE_NPM_FAIL is set.
echo "npm $*" >>"$FAKE_LOG/npm.log"
[[ "${1:-}" == ci ]] || exit 0
rm -rf node_modules
mkdir -p node_modules/dep
if [[ -n "${FAKE_NPM_FAIL:-}" ]]; then
  echo partial >node_modules/dep/half-written.js
  echo "npm ERR! fake failure" >&2
  exit 1
fi
printf 'dep built from %s\n' "$(cat package-lock.json)" >node_modules/dep/index.js
# Like real npm: packed files carry a fixed mtime (1985-10-26), so two versions of
# a same-size file look identical to rsync's size + mtime quick check.
touch -t 198510260815 node_modules/dep/index.js
EOF

cat >"$FAKES/bin/sudo" <<'EOF'
#!/usr/bin/env bash
# Fake sudo: only the exact commands in deploy/sudoers-breathless. A restart makes
# the "server" serve whatever is in DEPLOY_DIR at that moment.
echo "$*" >>"$FAKE_LOG/sudo.log"
[[ "${1:-}" == -n ]] && shift
case "$*" in
  "/usr/bin/systemctl restart breathless")
    mkdir -p "$FAKE_STATE"
    cp "$DEPLOY_DIR/game/dist/index.html" "$FAKE_STATE/served.html"
    # Markers in a release's sensor/ that change how its "server" behaves (see the fake curl).
    for m in MARKET_BROKEN MARKET_STUCK MARKET_SLOW NO_HEALTH; do
      if [[ -f "$DEPLOY_DIR/sensor/$m" ]]; then touch "$FAKE_STATE/$m"; else rm -f "$FAKE_STATE/$m"; fi
    done
    ;;
  "/usr/bin/systemctl is-active breathless") echo active ;;
  "/usr/bin/journalctl -u breathless -n 50 --no-pager") echo "-- fake journal --" ;;
  *)
    echo "NOT ALLOWED: $*" >>"$FAKE_LOG/sudo.log"
    echo "sudo: a password is required" >&2
    exit 1
    ;;
esac
EOF

cat >"$FAKES/bin/curl" <<'EOF'
#!/usr/bin/env bash
# Fake curl: the URL is the last argument; honours -f and -w '\n%{http_code}'.
# Down when FAKE_CURL_DOWN is set, before the first restart, or when the served
# index.html says BROKEN (a release whose server never starts). The release's
# markers: MARKET_BROKEN (market module failed: /api/health says failed, market
# routes 503), MARKET_STUCK (never leaves starting), MARKET_SLOW (module up, but
# /api/market/info times out, as behind devnet 429s), NO_HEALTH (a release from
# before /api/health: 404).
url="${*: -1}"
fail=0 write=0
for a in "$@"; do
  case "$a" in
    -w) write=1 ;;
    -*f*) [[ "$a" == --* ]] || fail=1 ;;
  esac
done
echo "$url" >>"$FAKE_LOG/curl.log"
if [[ -n "${FAKE_CURL_DOWN:-}" || ! -f "$FAKE_STATE/served.html" ]] || grep -q BROKEN "$FAKE_STATE/served.html"; then
  echo "curl: (7) Failed to connect" >&2
  exit 7
fi
on() { [[ -f "$FAKE_STATE/$1" ]]; }
code=200
case "$url" in
  */api/health)
    if on NO_HEALTH; then
      code=404 body='{"error":"Not found"}'
    elif on MARKET_BROKEN; then
      body='{"ok":true,"market":"failed"}'
    elif on MARKET_STUCK; then
      body='{"ok":true,"market":"starting"}'
    else
      body='{"ok":true,"market":"up"}'
    fi
    ;;
  */api/market/info)
    if on MARKET_SLOW; then
      if ((write)); then printf '\n000'; fi
      echo "curl: (28) Operation timed out" >&2
      exit 28
    elif on MARKET_BROKEN || on MARKET_STUCK; then
      code=503 body='{"error":"PEARL market is unavailable on this server"}'
    else
      body='{"mode":"server","funded":true}'
    fi
    ;;
  */) body="$(cat "$FAKE_STATE/served.html")" ;;
  *) code=404 body='{"error":"Not found"}' ;;
esac
if ((fail && code >= 400)); then
  echo "curl: (22) The requested URL returned error: $code" >&2
  exit 22
fi
printf '%s\n' "$body"
if ((write)); then printf '\n%s' "$code"; fi
exit 0
EOF
chmod +x "$FAKES/bin/sudo" "$FAKES/bin/curl" "$FAKES/node/npm"

# ---- releases ---------------------------------------------------------------
# r2 starts as a copy of r1 with times preserved, so files it doesn't change are
# "unchanged" to rsync, as on the Dell between two releases.
R="$TMP/releases"
mkdir -p "$R/r1/sensor" "$R/r1/game/dist/assets" "$R/r1/deploy"
cp "$HERE/deploy.sh" "$R/r1/deploy/deploy.sh"
echo 'export const v = 1;' >"$R/r1/sensor/index.mjs"
echo 'export const same = true;' >"$R/r1/sensor/unchanged.mjs"
echo 'only in r1' >"$R/r1/sensor/only-r1.mjs"
echo '{"name":"sensor"}' >"$R/r1/sensor/package.json"
echo 'lock-1' >"$R/r1/sensor/package-lock.json"
echo '<html>release 1</html>' >"$R/r1/game/dist/index.html"
echo 'a1' >"$R/r1/game/dist/assets/a1.js"
echo '{"name":"breathless","v":1}' >"$R/r1/package.json"
find "$R/r1" -type f -exec touch -t 202601010000 {} +

cp -Rp "$R/r1" "$R/r2"
echo 'export const v = 2;' >"$R/r2/sensor/index.mjs"
rm "$R/r2/sensor/only-r1.mjs" "$R/r2/game/dist/assets/a1.js"
echo 'only in r2' >"$R/r2/sensor/only-r2.mjs"
echo 'lock-2' >"$R/r2/sensor/package-lock.json"
echo '<html>release 2</html>' >"$R/r2/game/dist/index.html"
echo 'a2' >"$R/r2/game/dist/assets/a2.js"
echo '{"name":"breathless","v":2}' >"$R/r2/package.json"

cp -Rp "$R/r2" "$R/broken" # the server never comes up
echo '<html>release 2 BROKEN</html>' >"$R/broken/game/dist/index.html"
cp -Rp "$R/r2" "$R/nomarket" # serves index.html, but the market module failed to load
touch "$R/nomarket/sensor/MARKET_BROKEN"
cp -Rp "$R/r2" "$R/stuck" # the market module never finishes loading
touch "$R/stuck/sensor/MARKET_STUCK"
cp -Rp "$R/r2" "$R/slow" # market loaded, but /api/market/info stuck behind devnet 429s
touch "$R/slow/sensor/MARKET_SLOW"
cp -Rp "$R/r1" "$R/old" # release 1 as built before /api/health existed
touch "$R/old/sensor/NO_HEALTH"
cp -Rp "$R/old" "$R/oldslow" # ... whose /api/market/info is also stuck behind 429s
touch "$R/oldslow/sensor/MARKET_SLOW"
cp -Rp "$R/r2" "$R/noartifact" # build artifact not downloaded
rm -rf "$R/noartifact/game/dist"

# ---- helpers ----------------------------------------------------------------
fails=0
current=''
ok() { printf '  ok    %s\n' "$1"; }
bad() {
  printf '  FAIL  %s\n' "$1"
  fails=$((fails + 1))
  scenario_failed=1
}
check() { # check "description" command...
  local what="$1"
  shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}
scenario() {
  finish
  current="$1"
  scenario_failed=0
  printf '\n== %s\n' "$current"
}
results=()
finish() {
  if [[ -n "$current" ]]; then
    if ((scenario_failed)); then results+=("FAIL  $current"); else results+=("PASS  $current"); fi
  fi
}
inode() { ls -di "$1" | awk '{print $1}'; }
same_file() { cmp -s "$1" "$2"; }
has_text() { grep -qF -- "$2" "$1"; }
lacks_text() { ! grep -qF -- "$2" "$1"; }
count() { grep -cF -- "$2" "$1" 2>/dev/null || true; }
missing() { [[ ! -e "$1" ]]; }

# Fresh DEPLOY_DIR with live state that no deploy or rollback may touch.
STATE_FILES=(.env sensor/.market-state.json sensor/.market-fish.jsonl sensor/.market-keypair.json sensor/recordings/session-1.bin)
fresh() {
  rm -rf "$DEPLOY_DIR" "$FAKE_STATE" "$FAKE_LOG"
  mkdir -p "$DEPLOY_DIR/sensor/recordings" "$FAKE_STATE" "$FAKE_LOG"
  echo 'PRESAGE_API_KEY=fake-test-value' >"$DEPLOY_DIR/.env"
  echo '{"mint":"fake","sold":[]}' >"$DEPLOY_DIR/sensor/.market-state.json"
  echo '{"fish":1}' >"$DEPLOY_DIR/sensor/.market-fish.jsonl"
  echo '[1,2,3]' >"$DEPLOY_DIR/sensor/.market-keypair.json"
  echo 'rec' >"$DEPLOY_DIR/sensor/recordings/session-1.bin"
  state_before=''
  for f in "${STATE_FILES[@]}"; do state_before+="$f $(inode "$DEPLOY_DIR/$f") $(cksum <"$DEPLOY_DIR/$f")"$'\n'; done
}
state_intact() {
  local now='' f
  for f in "${STATE_FILES[@]}"; do
    [[ -f "$DEPLOY_DIR/$f" ]] || return 1
    now+="$f $(inode "$DEPLOY_DIR/$f") $(cksum <"$DEPLOY_DIR/$f")"$'\n'
  done
  [[ "$now" == "$state_before" ]]
}
state_not_in_backup() {
  [[ -d "$DEPLOY_DIR/.rollback" ]] || return 0
  [[ -z "$(find "$DEPLOY_DIR/.rollback" \( -name '.env' -o -name '.market-*' -o -name recordings \) -print)" ]]
}

# deploy RELEASE SHA [VAR=value ...]: run deploy.sh from that release; sets $rc, output in $OUT.
OUT="$TMP/out.log"
deploy() {
  local rel="$1" sha="$2"
  shift 2
  rm -f "$FAKE_LOG"/*.log
  mkdir -p "$FAKE_LOG"
  set +e
  env PATH="$FAKES/bin:$PATH" NODE_BIN="$FAKES/node/node" GITHUB_SHA="$sha" GITHUB_ACTIONS='' \
    HEALTH_TIMEOUT=1 HEALTH_INTERVAL=0.2 "$@" \
    bash "$R/$rel/deploy/deploy.sh" ${ARGS:-} >"$OUT" 2>&1
  rc=$?
  set -e
  touch "$FAKE_LOG/sudo.log" "$FAKE_LOG/curl.log" "$FAKE_LOG/npm.log"
  sed 's/^/        | /' "$OUT"
}
restarts() { count "$FAKE_LOG/sudo.log" 'systemctl restart breathless'; }
is_release() { # the live files are exactly release $1 (node_modules from its lockfile)
  local r="$R/$1" d="$DEPLOY_DIR" deps
  deps="$(cat "$d/sensor/node_modules/dep/index.js" 2>/dev/null || true)"
  [[ "$deps" == "dep built from $(cat "$r/sensor/package-lock.json")" ]] || {
    echo "        node_modules: $deps"
    return 1
  }
  missing "$d/sensor/node_modules/dep/half-written.js" || {
    echo "        node_modules: half-written.js left over"
    return 1
  }
  same_file "$d/package.json" "$r/package.json" || {
    echo "        package.json differs"
    return 1
  }
  diff -r -x node_modules -x recordings -x '.market-*' "$r/sensor" "$d/sensor" | sed 's/^/        diff: /' &&
    diff -r "$r/game/dist" "$d/game/dist" | sed 's/^/        diff: /'
}
release_is() { [[ "$(cat "$DEPLOY_DIR/RELEASE")" == "$1" ]]; }

# ---- scenarios ----------------------------------------------------------------
scenario "first deploy succeeds, no backup"
fresh
deploy r1 sha-1
check "exit 0" test "$rc" -eq 0
check "release 1 is live" is_release r1
check "RELEASE is sha-1" release_is sha-1
check "no .rollback on a first deploy" missing "$DEPLOY_DIR/.rollback"
check "restarted once" test "$(restarts)" -eq 1
check "npm ci ran" has_text "$FAKE_LOG/npm.log" 'npm ci --omit=dev'
check "market checked" has_text "$FAKE_LOG/curl.log" '/api/market/info'
check ".env and .market-* untouched" state_intact

scenario "second deploy succeeds, backup is release 1"
nm_inode_r1="$(inode "$DEPLOY_DIR/sensor/node_modules/dep/index.js")"
deploy r2 sha-2
check "exit 0" test "$rc" -eq 0
check "release 2 is live" is_release r2
check "RELEASE is sha-2" release_is sha-2
check ".rollback/RELEASE is sha-1" test "$(cat "$DEPLOY_DIR/.rollback/RELEASE")" == sha-1
check "backup holds release 1's index.html" same_file "$DEPLOY_DIR/.rollback/game/dist/index.html" "$R/r1/game/dist/index.html"
check "backup holds release 1's sensor files" same_file "$DEPLOY_DIR/.rollback/sensor/only-r1.mjs" "$R/r1/sensor/only-r1.mjs"
check "backup holds release 1's node_modules" has_text "$DEPLOY_DIR/.rollback/sensor/node_modules/dep/index.js" 'lock-1'
check "backup has no .env, .market-* or recordings" state_not_in_backup
check "exactly one backup dir" test "$(find "$DEPLOY_DIR" -maxdepth 1 -name '.rollback*' | wc -l | tr -d ' ')" -eq 1
check ".env and .market-* untouched" state_intact

scenario "backup is hard-linked"
check "unchanged sensor file shares its inode with the backup" \
  test "$(inode "$DEPLOY_DIR/sensor/unchanged.mjs")" -eq "$(inode "$DEPLOY_DIR/.rollback/sensor/unchanged.mjs")"
check "backup node_modules is release 1's inode, not a copy (npm ci didn't write through it)" \
  test "$(inode "$DEPLOY_DIR/.rollback/sensor/node_modules/dep/index.js")" -eq "$nm_inode_r1"

scenario "health check fails: rolled back to release 1"
fresh
deploy r1 sha-1
deploy broken sha-2
check "exit non-zero" test "$rc" -ne 0
check "says ROLLED BACK" has_text "$OUT" 'ROLLED BACK to previous release sha-1'
check "release 1 is live again (node_modules too)" is_release r1
check "RELEASE is sha-1" release_is sha-1
check "restarted twice" test "$(restarts)" -eq 2
check "exactly one backup dir left" test "$(find "$DEPLOY_DIR" -maxdepth 1 -name '.rollback*' | wc -l | tr -d ' ')" -eq 1
check "diagnostics logged with allowed commands" has_text "$FAKE_LOG/sudo.log" 'journalctl -u breathless -n 50 --no-pager'
check ".env and .market-* untouched" state_intact

scenario "npm ci fails mid-deploy: rolled back"
fresh
deploy r1 sha-1
deploy r2 sha-2 FAKE_NPM_FAIL=1
check "exit non-zero" test "$rc" -ne 0
check "says ROLLED BACK" has_text "$OUT" 'ROLLED BACK to previous release sha-1'
check "release 1 is live again, half-installed node_modules gone" is_release r1
check "restarted once (by the rollback)" test "$(restarts)" -eq 1
check ".env and .market-* untouched" state_intact

scenario "healthy: /api/health up, market info answers, no warning"
fresh
deploy r1 sha-1
deploy r2 sha-2
check "exit 0" test "$rc" -eq 0
check "asked /api/health" has_text "$FAKE_LOG/curl.log" '/api/health'
check "asked /api/market/info" has_text "$FAKE_LOG/curl.log" '/api/market/info'
check "no WARNING" lacks_text "$OUT" 'WARNING: http'

scenario "market module failed to load, index.html fine: rolled back"
fresh
deploy r1 sha-1
deploy nomarket sha-2
check "exit non-zero" test "$rc" -ne 0
check "blames the market module" has_text "$OUT" 'the PEARL market failed to load'
check "says ROLLED BACK" has_text "$OUT" 'ROLLED BACK to previous release sha-1'
check "release 1 is live again" is_release r1
check "MARKET_BROKEN marker removed by restore" missing "$DEPLOY_DIR/sensor/MARKET_BROKEN"
check ".env and .market-* untouched" state_intact

scenario "HEALTH_MARKET=0 skips the market check"
fresh
deploy r1 sha-1
deploy nomarket sha-2 HEALTH_MARKET=0
check "exit 0" test "$rc" -eq 0
check "never asked for /api/market/info" lacks_text "$FAKE_LOG/curl.log" '/api/market/info'
check "never asked for /api/health" lacks_text "$FAKE_LOG/curl.log" '/api/health'
check "RELEASE is sha-2" release_is sha-2

scenario "market module never finishes loading: rolled back"
fresh
deploy r1 sha-1
deploy stuck sha-2
check "exit non-zero" test "$rc" -ne 0
check "says it did not finish loading" has_text "$OUT" 'did not finish loading'
check "says ROLLED BACK" has_text "$OUT" 'ROLLED BACK to previous release sha-1'
check "release 1 is live again" is_release r1

scenario "market info times out behind RPC 429s, server and market up: live, with a warning"
fresh
deploy r1 sha-1
deploy slow sha-2
check "exit 0" test "$rc" -eq 0
check "warns about the RPC" has_text "$OUT" 'WARNING: http://127.0.0.1:8794/api/market/info did not answer 200 with JSON'
check "names rate limiting" has_text "$OUT" 'rate-limiting'
check "no rollback" lacks_text "$OUT" 'ROLLED BACK'
check "restarted once" test "$(restarts)" -eq 1
check "slow release is live" is_release slow
check "RELEASE is sha-2" release_is sha-2
check ".env and .market-* untouched" state_intact

scenario "warning is a GitHub ::warning::, not an ::error::"
fresh
deploy r1 sha-1
deploy slow sha-2 GITHUB_ACTIONS=true
check "exit 0" test "$rc" -eq 0
check "::warning:: line" has_text "$OUT" '::warning::'
check "no ::error:: line" lacks_text "$OUT" '::error::'

scenario "process down: rolled back to a release without /api/health"
fresh
deploy old sha-1
check "the old release deploys (no /api/health: index.html decides)" test "$rc" -eq 0
deploy broken sha-2
check "exit 1, not 2" test "$rc" -eq 1
check "says ROLLED BACK" has_text "$OUT" 'ROLLED BACK to previous release sha-1'
check "no ROLLBACK FAILED" lacks_text "$OUT" 'ROLLBACK FAILED'
check "old release is live again" is_release old

scenario "rollback to an old release whose market info is stuck behind 429s: still rolled back"
fresh
deploy oldslow sha-1
check "the old release deploys, with a warning" has_text "$OUT" 'no /api/health'
deploy broken sha-2
check "exit 1, not 2" test "$rc" -eq 1
check "says ROLLED BACK" has_text "$OUT" 'ROLLED BACK to previous release sha-1'
check "old release is live again" is_release oldslow

scenario "rollback's own health check fails: loud, non-zero"
fresh
deploy r1 sha-1
deploy broken sha-2 FAKE_CURL_DOWN=1
check "exit 2" test "$rc" -eq 2
check "says ROLLBACK FAILED" has_text "$OUT" 'ROLLBACK FAILED'
check "files are still restored to release 1" is_release r1
check ".env and .market-* untouched" state_intact

scenario "first deploy fails with no backup: fails as before"
fresh
deploy broken sha-2
check "exit 1" test "$rc" -eq 1
check "says there is no previous release" has_text "$OUT" 'no previous release to roll back to'
check "restarted once, no rollback" test "$(restarts)" -eq 1
check ".env and .market-* untouched" state_intact

scenario "failure before anything changed: no rollback"
fresh
deploy r1 sha-1
deploy r2 sha-2
deploy noartifact sha-3
check "exit 1" test "$rc" -eq 1
check "no restart" test "$(restarts)" -eq 0
check "release 2 still live, untouched" is_release r2
check "RELEASE is still sha-2" release_is sha-2
check "backup still release 1" test "$(cat "$DEPLOY_DIR/.rollback/RELEASE")" == sha-1
check "no ROLLED BACK message" lacks_text "$OUT" 'ROLLED BACK'

scenario "manual rollback: deploy.sh --rollback"
ARGS=--rollback deploy r2 manual
check "exit 0" test "$rc" -eq 0
check "release 1 is live" is_release r1
check "RELEASE is sha-1" release_is sha-1
check ".env and .market-* untouched" state_intact

scenario "no live release but a backup (half-failed rollback): backup kept"
fresh
deploy r1 sha-1
deploy r2 sha-2
rm -rf "$DEPLOY_DIR/game/dist" "$DEPLOY_DIR/sensor/node_modules" "$DEPLOY_DIR/sensor/index.mjs"
deploy broken sha-3
check "exit non-zero" test "$rc" -ne 0
check "kept the backup" has_text "$OUT" 'keeping'
check "says ROLLED BACK to release 1" has_text "$OUT" 'ROLLED BACK to previous release sha-1'
check "release 1 is live" is_release r1
check ".env and .market-* untouched" state_intact

scenario "only sudo commands from sudoers-breathless were used"
fresh
deploy r1 sha-1
deploy broken sha-2
check "no refused sudo call" lacks_text "$FAKE_LOG/sudo.log" 'NOT ALLOWED'
check "every call is -n + an allowed command" \
  test -z "$(grep -vxE -- '-n /usr/bin/systemctl (restart|is-active) breathless|-n /usr/bin/journalctl -u breathless -n 50 --no-pager' "$FAKE_LOG/sudo.log" || true)"
finish

printf '\n'
printf '%s\n' "${results[@]}"
if ((fails)); then
  printf '\n%d check(s) failed\n' "$fails"
  exit 1
fi
printf '\nall %d scenarios passed\n' "${#results[@]}"

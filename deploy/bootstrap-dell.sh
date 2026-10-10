#!/usr/bin/env bash
# One-time setup of the Dell for Breathless. Idempotent: safe to run again.
#
#   sudo bash deploy/bootstrap-dell.sh
#
# - creates the system user `breathless` (home /srv/breathless, no login shell)
# - installs Node $NODE_MAJOR to /opt/breathless-node; the box's own Node 18 is left alone
# - installs /etc/systemd/system/breathless.service (enabled; the first deploy starts it)
# - installs /etc/sudoers.d/breathless (restart / is-active / journal of that unit only)
# - creates /srv/breathless/app/.env (mode 600) with an empty PRESAGE_API_KEY= if missing
#
# It does NOT touch cloudflared or the GitHub runner: those are manual steps in
# deploy/SETUP.md. Only this folder (deploy/) is needed on the Dell to run it.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-24}"
NODE_DIR="${NODE_DIR:-/opt/breathless-node}"
APP_USER=breathless
APP_HOME=/srv/breathless
APP_DIR="$APP_HOME/app"
PORT=8794
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[bootstrap] %s\n' "$*"; }
die() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
[[ -f "$HERE/breathless.service" && -f "$HERE/sudoers-breathless" ]] || die "breathless.service / sudoers-breathless not found next to this script"

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m): the Presage SDK ships linux-x64 and linux-arm64 only" ;;
esac

# The Presage linux runtime is built on Ubuntu 22.04 and needs glibc >= 2.35.
glibc="$(ldd --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+$' || true)"
if [[ -n $glibc ]] && ! printf '2.35\n%s\n' "$glibc" | sort -V -C; then
  die "glibc $glibc is older than 2.35, which the Presage SDK needs (Ubuntu 22.04 or newer)"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Tools the deploy job and this script use.
pkgs=()
for pair in rsync:rsync curl:curl git:git xz:xz-utils; do
  command -v "${pair%%:*}" >/dev/null || pkgs+=("${pair#*:}")
done
if ((${#pkgs[@]})); then
  log "installing ${pkgs[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pkgs[@]}"
fi

# 2. User. The GitHub runner and the app both run as this user.
if id -u "$APP_USER" >/dev/null 2>&1; then
  log "user $APP_USER exists"
else
  useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
  log "created user $APP_USER (home $APP_HOME)"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_HOME" "$APP_DIR"

# 3. Node, from the official tarball, checked against nodejs.org's SHASUMS256.
have="$([[ -x "$NODE_DIR/bin/node" ]] && "$NODE_DIR/bin/node" -v || true)"
if [[ $have == "v$NODE_MAJOR."* ]]; then
  log "Node $have already in $NODE_DIR"
else
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  curl -fsSLo "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  tarball="$(grep -oE "node-v[0-9.]+-linux-$NODE_ARCH\.tar\.xz$" "$tmp/SHASUMS256.txt" | head -n1)"
  [[ -n $tarball ]] || die "no linux-$NODE_ARCH tarball listed at $base"
  log "downloading $tarball"
  curl -fsSLo "$tmp/$tarball" "$base/$tarball"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -)
  rm -rf "$NODE_DIR.new"
  mkdir -p "$NODE_DIR.new"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR.new" --strip-components=1 --no-same-owner
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.new" "$NODE_DIR"
  log "installed $("$NODE_DIR/bin/node" -v) to $NODE_DIR (was: ${have:-none})"
fi

# 4. .env for the key: created empty, never overwritten. Fill it in on the Dell.
if [[ -e "$APP_DIR/.env" ]]; then
  log "$APP_DIR/.env exists: left as is"
else
  install -o "$APP_USER" -g "$APP_USER" -m 600 /dev/null "$APP_DIR/.env"
  printf 'PRESAGE_API_KEY=\n' >"$APP_DIR/.env"
  log "created $APP_DIR/.env (mode 600): add the key yourself (deploy/SETUP.md, step 2)"
fi

# 5. systemd unit (enabled; the first deploy's restart starts it).
sed "s|/opt/breathless-node/bin/node|$NODE_DIR/bin/node|" "$HERE/breathless.service" >"$tmp/breathless.service"
unit=/etc/systemd/system/breathless.service
if cmp -s "$tmp/breathless.service" "$unit"; then
  log "$unit up to date"
else
  install -m 644 -o root -g root "$tmp/breathless.service" "$unit"
  systemctl daemon-reload
  log "installed $unit"
  if [[ -f "$APP_DIR/sensor/index.mjs" ]]; then
    systemctl restart breathless
    log "restarted breathless with the new unit"
  fi
fi
systemctl enable --quiet breathless
log "breathless.service enabled"

# 6. sudoers drop-in, validated before it goes live.
cp "$HERE/sudoers-breathless" "$tmp/sudoers"
visudo -cqf "$tmp/sudoers" || die "sudoers-breathless failed visudo -c"
if cmp -s "$tmp/sudoers" /etc/sudoers.d/breathless; then
  log "/etc/sudoers.d/breathless up to date"
else
  install -m 440 -o root -g root "$tmp/sudoers" /etc/sudoers.d/breathless
  log "installed /etc/sudoers.d/breathless"
fi

# 7. The port must be ours.
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet breathless; then
  log "WARNING: something else already listens on port $PORT"
fi

cat <<EOF

[bootstrap] Done. Still to do by hand (deploy/SETUP.md):
  2. add the Presage key:  sudo -u $APP_USER -H nano $APP_DIR/.env
  3. register the GitHub runner as user $APP_USER, label "dell"
  4. add the Cloudflare ingress rule -> http://127.0.0.1:$PORT
  5. push to main (or run the Deploy workflow) for the first deploy
EOF

#!/usr/bin/env bash
# Runs tests/player_state.ts against a fresh local validator.
#
# player_state is loaded as an upgradeable program whose upgrade authority is a
# throwaway wallet made here, because initialize_config only accepts the
# upgrade authority. Nothing touches devnet or any key in .keys/.
# Build first: anchor build -p player_state
set -euo pipefail
cd "$(dirname "$0")/.."

PROGRAM_ID=EUzJF8sYEMiqM2XV7FrPoPiQ89VHJvJ4VeeFtuXVaWJQ
SO=target/deploy/player_state.so
# 8899 is the sensor server's; Anchor.toml's test validator uses 8999 too.
PORT=${PLAYER_STATE_TEST_PORT:-8999}
FAUCET=${PLAYER_STATE_TEST_FAUCET:-9990}

[ -f "$SO" ] || { echo "missing $SO: run anchor build -p player_state" >&2; exit 1; }

TMP=$(mktemp -d)
VALIDATOR=
cleanup() {
  [ -n "$VALIDATOR" ] && kill "$VALIDATOR" 2>/dev/null && wait "$VALIDATOR" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

solana-keygen new --no-bip39-passphrase -s -o "$TMP/wallet.json" >/dev/null
AUTHORITY=$(solana-keygen pubkey "$TMP/wallet.json")

solana-test-validator --reset --quiet --ledger "$TMP/ledger" \
  --bind-address 127.0.0.1 --rpc-port "$PORT" --faucet-port "$FAUCET" \
  --mint "$AUTHORITY" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$AUTHORITY" \
  >"$TMP/validator.log" 2>&1 &
VALIDATOR=$!

for _ in $(seq 1 60); do
  solana cluster-version -u "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break
  kill -0 "$VALIDATOR" 2>/dev/null || { cat "$TMP/validator.log" >&2; exit 1; }
  sleep 1
done

ANCHOR_PROVIDER_URL="http://127.0.0.1:$PORT" ANCHOR_WALLET="$TMP/wallet.json" \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/player_state.ts

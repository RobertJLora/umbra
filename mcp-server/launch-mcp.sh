#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$SCRIPT_DIR/index.js"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUST_BROKER_DIR="$ROOT_DIR/rust-broker"
RUST_BROKER_BIN="$RUST_BROKER_DIR/target/release/umbra-rust-broker"
BROKER_MODE="${UMBRA_BROKER_MODE:-rust}"
BROKER_LOCK_DIR="${UMBRA_BROKER_LOCK_DIR:-/tmp/umbra-rust-broker.lock}"
PORT_START="${UMBRA_PORT_START:-47821}"
PORT_END="${UMBRA_PORT_END:-47852}"
MIN_FREE_PORTS="${UMBRA_MIN_FREE_PORTS:-3}"
STALE_MIN_AGE_SECONDS="${UMBRA_STALE_LISTENER_MIN_AGE_SECONDS:-60}"
BROKER_START_TIMEOUT_SECONDS="${UMBRA_BROKER_START_TIMEOUT_SECONDS:-8}"

has_free_bridge_port() {
  local port
  for ((port = PORT_START; port <= PORT_END; port += 1)); do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
  done

  return 1
}

free_bridge_port_count() {
  local port count=0
  for ((port = PORT_START; port <= PORT_END; port += 1)); do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      count=$((count + 1))
    fi
  done
  echo "$count"
}

cleanup_disconnected_bridge_listeners() {
  node "$SCRIPT_DIR/cleanup-listeners.mjs" \
    --only-disconnected \
    --min-age-seconds "$STALE_MIN_AGE_SECONDS" \
    >/dev/null || true
}

rust_broker_needs_build() {
  if [[ ! -x "$RUST_BROKER_BIN" ]]; then
    return 0
  fi
  if find "$RUST_BROKER_DIR/src" "$RUST_BROKER_DIR/Cargo.toml" "$RUST_BROKER_DIR/Cargo.lock" \
    -newer "$RUST_BROKER_BIN" -print -quit | grep -q .; then
    return 0
  fi
  return 1
}

wait_for_rust_broker() {
  local attempts="$((BROKER_START_TIMEOUT_SECONDS * 10))"
  local attempt
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if node "$SCRIPT_DIR/check-rust-broker.mjs" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

start_rust_broker_once() {
  if mkdir "$BROKER_LOCK_DIR" >/dev/null 2>&1; then
    trap 'rmdir "$BROKER_LOCK_DIR" >/dev/null 2>&1 || true' RETURN
    if node "$SCRIPT_DIR/check-rust-broker.mjs" >/dev/null 2>&1; then
      return 0
    fi
    echo "[umbra] Rust broker not running; ensuring launchd broker." >&2
    if rust_broker_needs_build && ! cargo build --quiet --release --manifest-path "$RUST_BROKER_DIR/Cargo.toml"; then
      return 1
    fi
    mkdir -p "$HOME/.umbra/bin"
    cp "$RUST_BROKER_BIN" "$HOME/.umbra/bin/umbra-rust-broker"
    node "$SCRIPT_DIR/ensure-rust-broker.mjs"
    return $?
  fi

  wait_for_rust_broker
}

free_ports="$(free_bridge_port_count)"
if (( free_ports < MIN_FREE_PORTS )); then
  echo "[umbra] only $free_ports free bridge ports remain; recycling old disconnected listeners before startup." >&2
  cleanup_disconnected_bridge_listeners
fi

if ! has_free_bridge_port; then
  echo "[umbra] port range still exhausted after safe cleanup; active or unknown listeners were preserved." >&2
fi

if [[ "$BROKER_MODE" == "rust" ]]; then
  start_rust_broker_once || true

  if node "$SCRIPT_DIR/check-rust-broker.mjs" >/dev/null 2>&1; then
    export UMBRA_MCP_SHIM_MODE="rust"
  elif [[ "${UMBRA_BROKER_REQUIRED:-0}" == "1" ]]; then
    echo "[umbra] Rust broker did not become ready." >&2
    exit 1
  else
    echo "[umbra] Rust broker unavailable; falling back to legacy bridge." >&2
  fi
fi

# Replace the launcher shell with the MCP server so stdin/stdout close and
# parent-process lifecycle signals reach the Node process directly.
exec node "$SERVER"

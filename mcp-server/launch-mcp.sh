#!/usr/bin/env bash
set -euo pipefail

# Environment overrides this launcher and the companion server read. Every one
# of them falls back to a portable default derived from $HOME, so a stock
# install needs none of them.
#
#   UMBRA_SHARED_KEY            the pairing key itself
#   UMBRA_SHARED_KEY_FILE       file holding the pairing key, default
#                               $HOME/.umbra/shared-key
#   UMBRA_DOWNLOAD_DIR          directory Chrome saves downloads into, default
#                               $HOME/Downloads. Set this when the browser's
#                               download folder was moved: the extension holds
#                               no downloads permission, so it cannot read the
#                               real setting and every download-waiting tool
#                               watches this directory instead.
#   UMBRA_BROKER_SOCKET         broker Unix socket, default
#                               $HOME/.umbra/run/broker.sock
#   UMBRA_BROKER_LAUNCHD_LABEL  launchd job to kick, default dev.umbra.broker
#   UMBRA_BROKER_MODE           rust (default) or legacy
#   UMBRA_BROKER_REQUIRED       1 to fail instead of falling back to legacy
#   UMBRA_PORT_START            loopback bridge port range start, default 47821
#   UMBRA_PORT_END              loopback bridge port range end, default 47852

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$SCRIPT_DIR/index.js"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUST_BROKER_DIR="$ROOT_DIR/rust-broker"
RUST_BROKER_BIN="$RUST_BROKER_DIR/target/release/umbra-rust-broker"
BROKER_MODE="${UMBRA_BROKER_MODE:-rust}"
# Per-user lock directory. A world-writable location lets any other local
# account pre-create this path and stall every broker start on this machine.
BROKER_LOCK_DIR="${UMBRA_BROKER_LOCK_DIR:-$HOME/.umbra/run/broker-start.lock}"
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

# cargo is commonly installed at $HOME/.cargo/bin/cargo, which is not on a login
# PATH on most machines, so probe both places before deciding the toolchain is
# missing. Prints the resolved path, or returns 1 when there is none.
resolve_cargo_bin() {
  if command -v cargo >/dev/null 2>&1; then
    command -v cargo
    return 0
  fi
  if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
    printf '%s\n' "$HOME/.cargo/bin/cargo"
    return 0
  fi
  return 1
}

# Returns 0 when the release binary is usable afterwards, 1 when the caller
# should give up on Rust mode. A missing toolchain is never fatal to the
# launcher: an existing binary is reused as-is, and with no binary at all the
# caller falls through to the legacy bridge.
build_rust_broker() {
  local cargo_bin
  if ! cargo_bin="$(resolve_cargo_bin)"; then
    if [[ -x "$RUST_BROKER_BIN" ]]; then
      echo "[umbra] cargo not found in PATH or \$HOME/.cargo/bin; reusing the existing Rust broker binary without rebuilding." >&2
      return 0
    fi
    echo "[umbra] cargo not found in PATH or \$HOME/.cargo/bin; skipping the Rust broker build and falling back to the legacy bridge." >&2
    return 1
  fi
  "$cargo_bin" build --quiet --release --manifest-path "$RUST_BROKER_DIR/Cargo.toml"
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
  mkdir -p "$(dirname "$BROKER_LOCK_DIR")" >/dev/null 2>&1 || true
  if mkdir "$BROKER_LOCK_DIR" >/dev/null 2>&1; then
    trap 'rmdir "$BROKER_LOCK_DIR" >/dev/null 2>&1 || true' RETURN
    if node "$SCRIPT_DIR/check-rust-broker.mjs" >/dev/null 2>&1; then
      return 0
    fi
    echo "[umbra] Rust broker not running; ensuring launchd broker." >&2
    if rust_broker_needs_build && ! build_rust_broker; then
      return 1
    fi
    mkdir -p "$HOME/.umbra/bin"
    cp "$RUST_BROKER_BIN" "$HOME/.umbra/bin/Umbra Helper"
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

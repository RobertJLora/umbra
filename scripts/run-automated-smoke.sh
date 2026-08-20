#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_TEST_PROFILE="$ROOT_DIR/.local/chrome-automated-smoke-profile-$(date +%Y%m%d%H%M%S)-$$"
PROFILE_DIR="${UMBRA_TEST_PROFILE:-$DEFAULT_TEST_PROFILE}"
EXTENSION_DIR="$ROOT_DIR/extension"
PLAYWRIGHT_CHROME_FOR_TESTING="$HOME/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
if [[ -n "${CODEX_CHROME_BIN:-}" ]]; then
  CHROME_BIN="$CODEX_CHROME_BIN"
elif [[ -x "$PLAYWRIGHT_CHROME_FOR_TESTING" ]]; then
  CHROME_BIN="$PLAYWRIGHT_CHROME_FOR_TESTING"
else
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
CDP_PORT="${UMBRA_CDP_PORT:-47840}"
BRIDGE_PORT_START="${UMBRA_PORT_START:-47821}"
BRIDGE_PORT_END="${UMBRA_PORT_END:-47852}"
DEFAULT_PROFILE_ROOT="$HOME/Library/Application Support/Google/Chrome"

case "$PROFILE_DIR" in
  "$DEFAULT_PROFILE_ROOT"|"$DEFAULT_PROFILE_ROOT"/*)
    echo "Refusing to use the primary Chrome profile path: $PROFILE_DIR" >&2
    exit 2
    ;;
esac

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "Missing Chrome binary: $CHROME_BIN" >&2
  exit 2
fi

if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo "Missing extension directory: $EXTENSION_DIR" >&2
  exit 2
fi

SHARED_KEY="${UMBRA_SHARED_KEY:-$(openssl rand -hex 32)}"
mkdir -p "$PROFILE_DIR"

CHROME_PID=""
cleanup() {
  if [[ -n "$CHROME_PID" ]] && kill -0 "$CHROME_PID" >/dev/null 2>&1; then
    CHILD_PIDS="$(pgrep -P "$CHROME_PID" 2>/dev/null || true)"
    if [[ -n "$CHILD_PIDS" ]]; then
      kill $CHILD_PIDS >/dev/null 2>&1 || true
    fi
    kill "$CHROME_PID" >/dev/null 2>&1 || true
    for _ in {1..25}; do
      if ! kill -0 "$CHROME_PID" >/dev/null 2>&1; then
        wait "$CHROME_PID" >/dev/null 2>&1 || true
        return
      fi
      sleep 0.2
    done
    CHILD_PIDS="$(pgrep -P "$CHROME_PID" 2>/dev/null || true)"
    if [[ -n "$CHILD_PIDS" ]]; then
      kill -9 $CHILD_PIDS >/dev/null 2>&1 || true
    fi
    kill -9 "$CHROME_PID" >/dev/null 2>&1 || true
    wait "$CHROME_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[smoke] launching isolated Chrome profile"
echo "[smoke] profile:   $PROFILE_DIR"
echo "[smoke] extension: $EXTENSION_DIR"
echo "[smoke] cdp port:  $CDP_PORT"

"$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --load-extension="$EXTENSION_DIR" \
  about:blank >/tmp/umbra-smoke-chrome.log 2>&1 &
CHROME_PID="$!"

node "$ROOT_DIR/scripts/configure-extension-cdp.mjs" \
  --cdp-port "$CDP_PORT" \
  --shared-key "$SHARED_KEY" \
  --port-start "$BRIDGE_PORT_START" \
  --port-end "$BRIDGE_PORT_END" \
  --timeout-ms 20000

cd "$ROOT_DIR/mcp-server"
set +e
UMBRA_SHARED_KEY="$SHARED_KEY" \
UMBRA_PORT_START="$BRIDGE_PORT_START" \
UMBRA_PORT_END="$BRIDGE_PORT_END" \
UMBRA_SMOKE_TIMEOUT_MS="${UMBRA_SMOKE_TIMEOUT_MS:-30000}" \
npm run smoke
SMOKE_STATUS=$?
set -e

cleanup
trap - EXIT
exit "$SMOKE_STATUS"

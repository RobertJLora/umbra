#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${TMPDIR:-/tmp}/umbra-headless-$$"
EXTENSION_DIR="$ROOT_DIR/extension"
PLAYWRIGHT_CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
PLAYWRIGHT_CHROME_FOR_TESTING="$HOME/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
if [[ -n "${CODEX_CHROME_BIN:-}" ]]; then
  CHROME_BIN="$CODEX_CHROME_BIN"
elif [[ -x "$PLAYWRIGHT_CHROMIUM" ]]; then
  CHROME_BIN="$PLAYWRIGHT_CHROMIUM"
elif [[ -x "$PLAYWRIGHT_CHROME_FOR_TESTING" ]]; then
  CHROME_BIN="$PLAYWRIGHT_CHROME_FOR_TESTING"
else
  echo "No isolated Chrome binary found. Refusing to launch the signed-in Google Chrome.app." >&2
  exit 2
fi
echo "[smoke] chrome: $CHROME_BIN"
CDP_PORT="${UMBRA_CDP_PORT:-47901}"
BRIDGE_PORT_START="${UMBRA_PORT_START:-47833}"
BRIDGE_PORT_END="${UMBRA_PORT_END:-47852}"
SHARED_KEY="${UMBRA_SHARED_KEY:-$(openssl rand -hex 32)}"

mkdir -p "$PROFILE_DIR"
CHROME_PID=""
cleanup() {
  if [[ -n "$CHROME_PID" ]] && kill -0 "$CHROME_PID" >/dev/null 2>&1; then
    kill "$CHROME_PID" >/dev/null 2>&1 || true
    wait "$CHROME_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$PROFILE_DIR"
}
trap cleanup EXIT

"$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --headless=new \
  --disable-gpu \
  --window-size=1280,900 \
  --load-extension="$EXTENSION_DIR" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  about:blank >/tmp/umbra-headless.log 2>&1 &
CHROME_PID="$!"

node "$ROOT_DIR/scripts/configure-extension-cdp.mjs" \
  --cdp-port "$CDP_PORT" \
  --shared-key "$SHARED_KEY" \
  --port-start "$BRIDGE_PORT_START" \
  --port-end "$BRIDGE_PORT_END" \
  --extension-name "Umbra" \
  --timeout-ms 30000

SKIP_RELOAD=1 \
UMBRA_SHARED_KEY="$SHARED_KEY" \
UMBRA_PORT_START="$BRIDGE_PORT_START" \
UMBRA_PORT_END="$BRIDGE_PORT_END" \
node "$ROOT_DIR/mcp-server/export-click-fixture-smoke.mjs"

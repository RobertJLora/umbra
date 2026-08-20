#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${UMBRA_TEST_PROFILE:-$ROOT_DIR/.local/chrome-test-profile}"
EXTENSION_DIR="$ROOT_DIR/extension"
DEFAULT_PROFILE_ROOT="$HOME/Library/Application Support/Google/Chrome"

case "$PROFILE_DIR" in
  "$DEFAULT_PROFILE_ROOT"|"$DEFAULT_PROFILE_ROOT"/*)
    echo "Refusing to use the primary Chrome profile path: $PROFILE_DIR" >&2
    exit 2
    ;;
esac

if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo "Missing extension directory: $EXTENSION_DIR" >&2
  exit 2
fi

mkdir -p "$PROFILE_DIR"

echo "Launching isolated Chrome test profile:"
echo "  profile:   $PROFILE_DIR"
echo "  extension: $EXTENSION_DIR"
echo
echo "After Chrome opens, configure the extension popup with the smoke-test shared key and port range."

open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --load-extension="$EXTENSION_DIR" \
  "chrome://extensions"

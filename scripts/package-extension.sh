#!/usr/bin/env bash
# Build the public Chrome Web Store package for the Umbra extension.
#
# The zip is assembled from an explicit allowlist, never from the extension
# directory as a whole. That is the point: an exclude list lets a new stray file
# ride into a submission silently, and an allowlist makes every shipped file a
# decision someone made. The allowlist lives in scripts/verify-package.mjs and
# is read from there, so the builder and the pre-submission gate cannot drift
# apart.
#
# Two things are deliberately left out of the package. recipes/ holds the
# site-specific page automation, which stays local-only: a checkout loaded
# unpacked keeps it and keeps the capability, while the public build reports a
# clear "page recipe not installed in this build" error instead. assets/ no
# longer exists in the tree at all.
#
# Icons are refreshed from branding/icons/ and stripped of metadata before they
# are staged, because exported artwork arrives carrying generator provenance
# blocks and an EXIF signature. Stripping happens in extension/icons/ as well as
# in the staged copy, so an unpacked install and the submitted zip carry the
# same bytes.
#
# Environment overrides:
#   UMBRA_EXTENSION_DIR       source tree (default: <repo>/extension)
#   UMBRA_BRANDING_ICON_DIR   icon masters (default: <repo>/branding/icons)
#   UMBRA_DIST_DIR            output directory (default: <repo>/dist)
#   UMBRA_SKIP_ICON_REFRESH   set to 1 to leave extension/icons untouched
#   UMBRA_SKIP_VERIFY         set to 1 to build without running the gate
#
# Usage: bash scripts/package-extension.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

EXTENSION_DIR="${UMBRA_EXTENSION_DIR:-$REPO_ROOT/extension}"
BRANDING_ICON_DIR="${UMBRA_BRANDING_ICON_DIR:-$REPO_ROOT/branding/icons}"
DIST_DIR="${UMBRA_DIST_DIR:-$REPO_ROOT/dist}"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-package.mjs"

# Icon sizes the manifest declares. Masters live in branding/icons/ at these
# same names; any size with no master keeps whatever is already in the tree.
ICON_SIZES="16 32 48 128"

fail() {
  printf 'package-extension: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'node is required and was not found on PATH.'
command -v zip >/dev/null 2>&1 || fail 'zip is required and was not found on PATH. On Debian or Ubuntu: apt-get install zip'
[ -d "$EXTENSION_DIR" ] || fail "extension directory not found: $EXTENSION_DIR"
[ -f "$VERIFY_SCRIPT" ] || fail "allowlist source not found: $VERIFY_SCRIPT"

MANIFEST="$EXTENSION_DIR/manifest.json"
[ -f "$MANIFEST" ] || fail "manifest not found: $MANIFEST"

VERSION="$(UMBRA_MANIFEST="$MANIFEST" node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.UMBRA_MANIFEST, "utf8"));
if (!manifest.version) { process.stderr.write("manifest has no version field\n"); process.exit(1); }
process.stdout.write(String(manifest.version));
')"
[ -n "$VERSION" ] || fail 'could not read a version from the manifest.'

BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/umbra-package.XXXXXX")"
trap 'rm -rf "$BUILD_TMP"' EXIT
STAGE_DIR="$BUILD_TMP/extension"
mkdir -p "$STAGE_DIR"

# --- PNG metadata stripper -------------------------------------------------
# Chunks are copied verbatim, so their CRCs stay valid and no pixel is touched.
# Everything outside the keep set goes, which is what removes the tEXt, zTXt,
# iTXt, eXIf and C2PA blocks that exported artwork arrives with.
STRIP_PNG="$BUILD_TMP/strip-png.mjs"
cat > "$STRIP_PNG" <<'STRIP_PNG_EOF'
import fs from 'node:fs';

const KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM']);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const file of process.argv.slice(2)) {
  const source = fs.readFileSync(file);
  if (source.length < 8 || !source.subarray(0, 8).equals(SIGNATURE)) {
    process.stderr.write(`not a PNG: ${file}\n`);
    process.exit(1);
  }
  const kept = [SIGNATURE];
  const dropped = [];
  let cursor = 8;
  while (cursor + 8 <= source.length) {
    const length = source.readUInt32BE(cursor);
    const type = source.toString('latin1', cursor + 4, cursor + 8);
    const end = cursor + 12 + length;
    if (KEEP.has(type)) kept.push(source.subarray(cursor, end));
    else dropped.push(type);
    cursor = end;
    if (type === 'IEND') break;
  }
  // Bytes past IEND are not a chunk the loop above can drop, so a PNG whose
  // only foreign data sits after the end marker used to skip the rewrite
  // entirely and ship with its provenance block intact.
  const trailing = source.length - cursor;
  if (trailing > 0) dropped.push(`${trailing} trailing byte(s) after IEND`);
  if (dropped.length === 0) continue;
  fs.writeFileSync(file, Buffer.concat(kept));
  process.stdout.write(`  stripped ${dropped.join(', ')} from ${file.split('/').pop()}\n`);
}
STRIP_PNG_EOF

# --- refresh icons from the branding masters -------------------------------
if [ "${UMBRA_SKIP_ICON_REFRESH:-0}" = "1" ]; then
  printf 'Icon refresh skipped (UMBRA_SKIP_ICON_REFRESH=1).\n'
else
  mkdir -p "$EXTENSION_DIR/icons"
  refreshed=0
  for size in $ICON_SIZES; do
    master="$BRANDING_ICON_DIR/icon${size}.png"
    target="$EXTENSION_DIR/icons/icon${size}.png"
    if [ ! -f "$master" ]; then
      [ -f "$target" ] || fail "no icon for size ${size}: neither $master nor $target exists."
      continue
    fi
    cp "$master" "$target"
    refreshed=$((refreshed + 1))
  done
  printf 'Refreshed %s icon(s) from %s\n' "$refreshed" "$BRANDING_ICON_DIR"
fi

# Strip in the source tree as well as the staged copy, so an unpacked install
# loaded straight from this checkout carries the same clean bytes the store
# package does.
# An array, not a space-joined string: a checkout under a path with a space in
# it word-split the string and the stripper was handed path fragments, after the
# icons had already been refreshed in the source tree.
ICON_FILES=()
for icon in "$EXTENSION_DIR"/icons/*.png; do
  [ -f "$icon" ] || continue
  ICON_FILES+=("$icon")
done
[ ${#ICON_FILES[@]} -gt 0 ] || fail "no icons found in $EXTENSION_DIR/icons"
node "$STRIP_PNG" "${ICON_FILES[@]}"

# --- stage the allowlist ---------------------------------------------------
ALLOWLIST="$(UMBRA_VERIFY_MODULE="$VERIFY_SCRIPT" node -e '
import(process.env.UMBRA_VERIFY_MODULE)
  .then((mod) => { process.stdout.write(mod.EXTENSION_FILES.join("\n")); })
  .catch((error) => { process.stderr.write(String(error && error.message) + "\n"); process.exit(1); });
')"
[ -n "$ALLOWLIST" ] || fail 'the allowlist in scripts/verify-package.mjs came back empty.'

STAGED_LIST="$BUILD_TMP/staged.txt"
: > "$STAGED_LIST"

while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  source_file="$EXTENSION_DIR/$relative"
  [ -f "$source_file" ] || fail "allowlisted file is missing from the source tree: $relative"
  mkdir -p "$STAGE_DIR/$(dirname "$relative")"
  cp "$source_file" "$STAGE_DIR/$relative"
  printf '%s\n' "$relative" >> "$STAGED_LIST"
done <<EOF
$ALLOWLIST
EOF

mkdir -p "$STAGE_DIR/icons"
for icon in "$EXTENSION_DIR"/icons/*.png; do
  [ -f "$icon" ] || continue
  base="$(basename "$icon")"
  case "$base" in
    icon[0-9]*.png)
      cp "$icon" "$STAGE_DIR/icons/$base"
      printf 'icons/%s\n' "$base" >> "$STAGED_LIST"
      ;;
    *)
      printf 'package-extension: skipping unexpected file in icons/: %s\n' "$base" >&2
      ;;
  esac
done

# Pin every staged mtime so two builds of the same source produce the same
# archive and can be diffed. 1980-01-01 is the earliest date the zip format
# can record.
# Pin the modes too. `cp` applies the caller's umask and `zip -X` still records
# the unix mode, so two builds of the same source under umask 022 and umask 077
# produced different archives and a colleague's hash never matched.
find "$STAGE_DIR" -type f -exec chmod 644 {} +
find "$STAGE_DIR" -type d -exec chmod 755 {} +
find "$STAGE_DIR" -exec touch -t 198001010000 {} +

# --- build -----------------------------------------------------------------
# The zip is assembled inside the temp directory and only moved into dist/ once
# it has passed the gate. Building straight into dist/ left a rejected package
# sitting at the canonical upload path, indistinguishable from one that passed.
mkdir -p "$DIST_DIR"
STAGED_ZIP="$BUILD_TMP/umbra-$VERSION.zip"

SORTED_LIST="$BUILD_TMP/sorted.txt"
LC_ALL=C sort "$STAGED_LIST" > "$SORTED_LIST"

(
  cd "$STAGE_DIR"
  # -X drops platform extra fields, -D omits directory entries, -q keeps the
  # output readable, and -@ takes the file list on stdin in a fixed order.
  zip -X -D -q -9 "$STAGED_ZIP" -@ < "$SORTED_LIST"
)

ZIP_BYTES="$(wc -c < "$STAGED_ZIP" | tr -d ' ')"
FILE_COUNT="$(wc -l < "$SORTED_LIST" | tr -d ' ')"

if [ "${UMBRA_SKIP_VERIFY:-0}" = "1" ]; then
  # The filename carries the caveat, so an unverified build cannot be mistaken
  # for a submittable one.
  ZIP_PATH="$DIST_DIR/umbra-$VERSION-unverified.zip"
  rm -f "$ZIP_PATH"
  mv "$STAGED_ZIP" "$ZIP_PATH"
  printf 'Built %s\n  %s files, %s bytes\n' "$ZIP_PATH" "$FILE_COUNT" "$ZIP_BYTES"
  printf 'Verification skipped (UMBRA_SKIP_VERIFY=1). Run: node scripts/verify-package.mjs %s\n' "$ZIP_PATH"
  exit 0
fi

printf 'Built %s\n  %s files, %s bytes\n' "$BUILD_TMP/umbra-$VERSION.zip" "$FILE_COUNT" "$ZIP_BYTES"

if ! node "$VERIFY_SCRIPT" "$STAGED_ZIP"; then
  printf 'The package did not pass verification, so %s was not written.\n' "$DIST_DIR/umbra-$VERSION.zip" >&2
  exit 1
fi

ZIP_PATH="$DIST_DIR/umbra-$VERSION.zip"
rm -f "$ZIP_PATH"
mv "$STAGED_ZIP" "$ZIP_PATH"
printf 'Wrote %s\n' "$ZIP_PATH"

#!/usr/bin/env node
// Pre-submission gate for the packaged Umbra extension.
//
// Run it against the zip that scripts/package-extension.sh produced. It reads
// the archive with no external tools, then asserts everything that must be true
// of a submission: nothing outside the allowlist rode along, the archive is
// small, no author identity or third-party product name reached a shipped byte,
// no icon carries generator provenance metadata, no source file compiles a
// string into code, and the manifest asks for site access at grant time rather
// than at install time.
//
// This file is also the single source of the packaging allowlist. The build
// script reads EXTENSION_FILES from here rather than keeping a second copy, so
// the thing that builds the zip and the thing that judges it cannot drift.
//
// Usage: node scripts/verify-package.mjs [path/to/umbra-<version>.zip]
// With no argument it picks the newest dist/umbra-*.zip.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// Every non-icon file that ships. Adding a file to the extension does not add
// it to the package: it has to be listed here on purpose.
//
// recipes/ is deliberately absent. That is the whole mechanism that keeps the
// site-specific page automation local-only: the public build ships without the
// recipe file, and the dispatch in extension/background.js reports a clear
// "page recipe not installed in this build" error instead of crashing. An
// unpacked install loaded from a checkout still has the file and still runs it.
export const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'content-agent.js',
  'ax-tree.js',
  'cursor-overlay.js',
  'session-state.js',
  'shared.js',
  'javascript-safety.js',
  'offscreen.html',
  'offscreen.js',
  // The vendored GIF encoder offscreen.js imports. Without it on this list the
  // packaged build ships an offscreen document whose module never loads, which
  // takes the whole bridge down rather than just the recorder.
  'vendor/gifenc.js',
  'options.html',
  'options.js',
  'popup.html',
  'popup.js',
];

// icons/ ships as a directory so a new size does not need a code change, but
// the names are pinned so nothing else can hide in there. iconNN.png is the
// light-toolbar set, iconNN-dark.png the white set setIcon swaps in for dark
// color schemes, and mark-light.png the white mark the popup and options
// pages render on their dark UI.
export const ICON_DIR = 'icons/';
export const ICON_ENTRY_PATTERN = /^icons\/(?:icon\d{2,4}(?:-dark)?|mark-light)\.png$/;

// Paths that must never appear in a built package, checked by name so the
// failure message can say which boundary was crossed.
export const FORBIDDEN_PREFIXES = ['recipes/', 'assets/'];

export const MAX_ZIP_BYTES = 500 * 1024;

// Author identity. The surname is matched on its own because a path fragment
// can carry it without the full name.
//
// Both needles are assembled from fragments on purpose. Written out as literals
// they would be exactly the leak the release identity gate in
// mcp-server/release-check.mjs scans every tracked file for, so this file would
// fail that gate on every run. Assembling them keeps the scanner out of its own
// results without exempting the one file that must never be exempt. The
// surname is bounded because it is a substring of ordinary English words such
// as "exploration".
const AUTHOR_GIVEN_NAME = ['rob', 'ert'].join('');
const AUTHOR_SURNAME = ['lo', 'ra'].join('');

const IDENTITY_PATTERNS = [
  { label: 'author first name', re: new RegExp(AUTHOR_GIVEN_NAME, 'i') },
  { label: 'author surname', re: new RegExp(`(?<![a-z])${AUTHOR_SURNAME}(?![a-z])`, 'i') },
  { label: 'a macOS home path', re: /\/Users\/[A-Za-z]/ },
];

// Third-party product names. None of these belong in a submitted package: some
// are unrelated vendors whose names were left in identifiers by an earlier
// port, and the rest are image generators whose provenance metadata rides in
// artwork. "cursor" is not on this list on purpose, because it is a CSS
// property that appears legitimately in the options and popup stylesheets.
//
// The SEO vendor needle is assembled from fragments for the same reason the
// identity needles are: written out it would be an occurrence of exactly the
// name this gate exists to keep out of shipped bytes, so the gate would fail on
// its own source. That vendor's page automation lives only in the optional
// local plugins, which never ship.
const SEO_VENDOR = ['ah', 'refs'].join('');

const PRODUCT_NAME_PATTERNS = [
  new RegExp(SEO_VENDOR, 'i'),
  // Case sensitive on purpose: `CiC` is the third-party product abbreviation,
  // while `cic:` and `cic-content-agent` are this extension's own internal wire
  // identifiers and are not a product name.
  /\bCiC\b/,
  /codex/i,
  /openai/i,
  /chatgpt/i,
  /\bdall-?e\b/i,
  /midjourney/i,
  /stable\s*diffusion/i,
  /nano\s*banana/i,
  /\bgemini\b/i,
  /\bfirefly\b/i,
  /photoshop/i,
  /\badobe\b/i,
  /copilot/i,
  /perplexity/i,
  /anthropic/i,
  /\bclaude\b/i,
  /\bgrok\b/i,
];

// The store listing description is read before anything else, so it carries a
// stricter bar than the rest of the package: no product name at all, including
// the SEO tools whose page automation the extension can drive.
const TRADEMARK_PATTERNS = [...PRODUCT_NAME_PATTERNS, /semrush/i, /moz\b/i];

// Compiling a string into code. Chrome Web Store scanners flag these on
// presence, and the manifest declares script-src 'self', so any hit here is
// both a review risk and a contradiction of the extension's own policy.
const REMOTE_CODE_PATTERNS = [
  { label: 'AsyncFunction constructor', re: /AsyncFunction/ },
  // Bare `Function(...)` is a constructor call too, and it is the spelling a
  // minifier emits.
  { label: 'Function( constructor', re: /(^|[^\w.$])Function\s*\(/ },
  { label: 'eval(', re: /(^|[^\w.$])eval\s*\(/ },
  // Reaching AsyncFunction through the prototype chain is how it is actually
  // written; the literal string above is the one form nobody uses.
  { label: 'AsyncFunction via getPrototypeOf', re: /getPrototypeOf\s*\(\s*async\s+function/ },
  { label: 'import() or require() of a remote URL', re: /\b(?:import|require)\s*\(\s*["'`]https?:/ },
  { label: 'a string body passed to setTimeout or setInterval', re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/ },
  { label: 'a computed property that reassembles eval', re: /\[\s*["'`]ev["'`]\s*\+/ },
  { label: 'a remote script tag', re: /<script[^>]+src\s*=\s*["']https?:/i },
];

// PNG chunks a shipped icon may carry. Everything else is dropped at build
// time, which is what removes the generator signature blocks that arrive
// embedded in exported artwork.
const ALLOWED_PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM']);

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.json', '.css', '.md', '.txt', '.svg']);

export function isTextEntry(name) {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function isAllowedEntry(name) {
  if (EXTENSION_FILES.includes(name)) return true;
  return ICON_ENTRY_PATTERN.test(name);
}

// --- zip reading -----------------------------------------------------------
// Reading the archive here rather than shelling out to unzip keeps the gate
// self-contained and makes every assertion testable against a synthetic entry
// list with no filesystem involved.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('Not a zip archive: no end-of-central-directory record found.');
}

export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('Zip64 archives are not supported by this gate; the package should be far smaller.');
  }

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt central directory at entry ${index}.`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      entries.push({ name, data: Buffer.alloc(0), isDirectory: true, compressedSize, uncompressedSize });
      continue;
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Corrupt local header for ${name}.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported compression method ${method} for ${name}.`);
    entries.push({ name, data, isDirectory: false, compressedSize, uncompressedSize });
  }
  return entries;
}

// --- PNG chunk reading -----------------------------------------------------

export function readPngChunkTypes(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('Not a PNG file.');
  }
  const types = [];
  let cursor = 8;
  while (cursor + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.toString('latin1', cursor + 4, cursor + 8);
    types.push(type);
    cursor += 12 + length;
    if (type === 'IEND') break;
  }
  // A chunk walk that stops at IEND never sees what was appended after it, and
  // an author name or home path pasted there survives every other check while
  // Chrome still renders the icon normally. The marker fails the allowed-chunk
  // test the same way a stray tEXt chunk does.
  if (cursor < buffer.length) {
    types.push('trailing-data');
  }
  return types;
}

// --- verification ----------------------------------------------------------

// The author deliberately chose their personal site as Umbra's public home, so
// homepage_url and the listing point at it. That host contains the author name,
// which every other identity check still blocks. It is neutralized here before
// the scan (replaced with same-length filler so line numbers are unchanged), so
// the one approved occurrence passes while the name stays blocked everywhere
// else.
const APPROVED_IDENTITY_STRINGS = ['robertjohnlora.com', 'github.com/RobertJLora'];

function neutralizeApproved(text) {
  let out = text;
  for (const approved of APPROVED_IDENTITY_STRINGS) {
    out = out.split(approved).join('#'.repeat(approved.length));
  }
  return out;
}

function scanText(entries, patterns, describe) {
  const hits = [];
  for (const entry of entries) {
    if (entry.isDirectory || !isTextEntry(entry.name)) continue;
    const text = neutralizeApproved(entry.data.toString('utf8'));
    for (const pattern of patterns) {
      const re = pattern.re ?? pattern;
      const match = re.exec(text);
      if (!match) continue;
      const line = text.slice(0, match.index).split('\n').length;
      hits.push(describe(entry, pattern, match, line));
    }
  }
  return hits;
}

/**
 * Judge a set of zip entries. Returns every check with its verdict rather than
 * throwing on the first failure, so one run reports everything that is wrong.
 */
export function verifyPackage({ entries, zipSize }) {
  const checks = [];
  const add = (name, failures, detail) => {
    checks.push({ name, ok: failures.length === 0, failures, detail });
  };

  const files = entries.filter((entry) => !entry.isDirectory);
  const names = files.map((entry) => entry.name);

  add(
    'archive size is under the submission budget',
    typeof zipSize === 'number' && zipSize > MAX_ZIP_BYTES
      ? [`archive is ${zipSize} bytes, over the ${MAX_ZIP_BYTES}-byte limit`]
      : [],
    typeof zipSize === 'number' ? `${zipSize} bytes` : 'size not supplied',
  );

  add(
    'every entry is on the allowlist',
    names.filter((name) => !isAllowedEntry(name)).map((name) => `${name} is not allowlisted`),
    `${names.length} entries`,
  );

  const missing = EXTENSION_FILES.filter((file) => !names.includes(file));
  add('every allowlisted file is present', missing.map((file) => `${file} is missing from the archive`));

  const iconEntries = names.filter((name) => name.startsWith(ICON_DIR));
  add(
    'the icon set is present',
    iconEntries.length === 0 ? ['no icons/ entry in the archive'] : [],
    `${iconEntries.length} icons`,
  );

  add(
    'no local-only or leftover directory shipped',
    names
      .filter((name) => FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .map((name) => `${name} must not ship in the public package`),
  );

  add(
    'entry paths are plain relative paths',
    names
      .filter(
        (name) =>
          name.startsWith('/') ||
          name.includes('..') ||
          name.includes('__MACOSX') ||
          path.basename(name) === '.DS_Store',
      )
      .map((name) => `${name} is not a plain relative path`),
  );

  add(
    'no author identity in any shipped byte',
    [
      ...names
        .filter((name) => IDENTITY_PATTERNS.some(({ re }) => re.test(name)))
        .map((name) => `entry name ${name} carries author identity`),
      ...scanText(
        files,
        IDENTITY_PATTERNS,
        (entry, pattern, match, line) => `${entry.name}:${line} carries ${pattern.label} (${match[0]})`,
      ),
    ],
  );

  add(
    'no third-party product name in any shipped byte',
    [
      ...names
        .filter((name) => PRODUCT_NAME_PATTERNS.some((re) => re.test(name)))
        .map((name) => `entry name ${name} carries a third-party product name`),
      ...scanText(
        files,
        PRODUCT_NAME_PATTERNS,
        (entry, pattern, match, line) => `${entry.name}:${line} names ${match[0]}`,
      ),
    ],
  );

  add(
    'no source file compiles a string into code',
    scanText(
      files,
      REMOTE_CODE_PATTERNS,
      (entry, pattern, match, line) => `${entry.name}:${line} uses ${pattern.label}`,
    ),
  );

  const iconFailures = [];
  for (const entry of files) {
    if (!entry.name.toLowerCase().endsWith('.png')) continue;
    let types;
    try {
      types = readPngChunkTypes(entry.data);
    } catch (error) {
      iconFailures.push(`${entry.name} is not readable as a PNG: ${error.message}`);
      continue;
    }
    for (const type of types) {
      if (!ALLOWED_PNG_CHUNKS.has(type)) {
        iconFailures.push(`${entry.name} carries a ${type} chunk, which can hold generator provenance metadata`);
      }
    }
  }
  add('no icon carries provenance metadata', iconFailures);

  const manifestEntry = files.find((entry) => entry.name === 'manifest.json');
  const manifestFailures = [];
  let manifest = null;
  if (!manifestEntry) {
    manifestFailures.push('manifest.json is missing');
  } else {
    try {
      manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    } catch (error) {
      manifestFailures.push(`manifest.json does not parse: ${error.message}`);
    }
  }
  if (manifest) {
    const optional = manifest.optional_host_permissions ?? [];
    if (!optional.includes('<all_urls>')) {
      manifestFailures.push('optional_host_permissions does not declare <all_urls>');
    }
    const required = manifest.host_permissions ?? [];
    if (required.length > 0) {
      manifestFailures.push(
        `host_permissions is non-empty (${required.join(', ')}); site access must be requested at grant time`,
      );
    }
    if (manifest.manifest_version !== 3) {
      manifestFailures.push(`manifest_version is ${manifest.manifest_version}, expected 3`);
    }
    if (!manifest.homepage_url) {
      manifestFailures.push('homepage_url is missing, so the popup and options page are a dead end for a reviewer');
    }
    const description = String(manifest.description ?? '');
    if (!description) {
      manifestFailures.push('description is empty');
    }
    // The name is the single most visible string in a listing and the homepage
    // link is right under it, so both carry the same bar the description does.
    for (const [field, value] of [
      ['description', description],
      ['name', String(manifest.name ?? '')],
      ['homepage_url', String(manifest.homepage_url ?? '')],
    ]) {
      for (const re of TRADEMARK_PATTERNS) {
        const match = re.exec(value);
        if (match) manifestFailures.push(`${field} names ${match[0]}, a third-party trademark`);
      }
    }
  }
  add('the manifest is store-ready', manifestFailures);

  add('the store listing text carries no third-party name or author identity', checkStoreListingText());

  const failed = checks.filter((check) => !check.ok);
  return { ok: failed.length === 0, checks, failures: failed.flatMap((check) => check.failures) };
}

// store/description.txt is the text pasted into the listing, and listing.md and
// permission-justifications.md are the text pasted into the dashboard. None of
// them ship inside the zip, so nothing was reading them for the very names the
// stricter bar exists to keep out of a listing.
export const STORE_TEXT_FILES = [
  'store/description.txt',
  'store/listing.md',
  'store/permission-justifications.md',
];

export function checkStoreListingText(root = REPO_ROOT, files = STORE_TEXT_FILES) {
  const failures = [];
  for (const relative of files) {
    let text;
    try {
      text = neutralizeApproved(fs.readFileSync(path.join(root, relative), 'utf8'));
    } catch {
      continue;
    }
    for (const pattern of [...TRADEMARK_PATTERNS, ...IDENTITY_PATTERNS]) {
      const re = pattern.re ?? pattern;
      const match = re.exec(text);
      if (!match) continue;
      const line = text.slice(0, match.index).split('\n').length;
      failures.push(`${relative}:${line} names ${match[0]}`);
    }
  }
  return failures;
}

export function verifyPackageFile(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const entries = readZipEntries(buffer);
  return verifyPackage({ entries, zipSize: buffer.length });
}

function newestBuiltPackage() {
  const distDir = process.env.UMBRA_DIST_DIR || path.join(REPO_ROOT, 'dist');
  let candidates = [];
  try {
    candidates = fs
      .readdirSync(distDir)
      .filter((name) => /^umbra-.*\.zip$/.test(name))
      .map((name) => path.join(distDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    candidates = [];
  }
  return candidates[0] ?? null;
}

function main(argv) {
  const zipPath = argv[0] ? path.resolve(argv[0]) : newestBuiltPackage();
  if (!zipPath) {
    process.stderr.write('No package to verify. Build one with: bash scripts/package-extension.sh\n');
    return 1;
  }
  if (!fs.existsSync(zipPath)) {
    process.stderr.write(`No such package: ${zipPath}\n`);
    return 1;
  }

  let report;
  try {
    report = verifyPackageFile(zipPath);
  } catch (error) {
    process.stderr.write(`Could not read ${path.basename(zipPath)}: ${error.message}\n`);
    return 1;
  }

  process.stdout.write(`Verifying ${path.basename(zipPath)}\n`);
  for (const check of report.checks) {
    const mark = check.ok ? 'ok  ' : 'FAIL';
    const detail = check.detail ? ` (${check.detail})` : '';
    process.stdout.write(`  ${mark} ${check.name}${detail}\n`);
    for (const failure of check.failures) process.stdout.write(`       ${failure}\n`);
  }

  if (!report.ok) {
    process.stdout.write(`\n${report.failures.length} problem(s) block submission.\n`);
    return 1;
  }
  process.stdout.write('\nPackage is ready to submit.\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

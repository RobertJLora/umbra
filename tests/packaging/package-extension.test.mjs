// Packaging gate tests.
//
// Two things are under test. First, that the allowlist in
// scripts/verify-package.mjs actually covers what the extension needs at
// runtime, so an allowlist build cannot ship a broken extension. Second, that
// verify-package.mjs catches each class of problem it exists to catch, checked
// against synthetic entry sets so no case depends on the state of the tree.
//
// One integration case runs the real build script against a throwaway copy of
// the extension tree and proves a stray file does not reach the archive. It
// skips itself when the zip binary is absent rather than failing on a machine
// that cannot build a package at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { SEO_VENDOR, SEO_VENDOR_RE } from '../identity-needles.mjs';
import { fileURLToPath } from 'node:url';

import {
  EXTENSION_FILES,
  FORBIDDEN_PREFIXES,
  ICON_ENTRY_PATTERN,
  MAX_ZIP_BYTES,
  isAllowedEntry,
  readPngChunkTypes,
  readZipEntries,
  verifyPackage,
  verifyPackageFile,
} from '../../scripts/verify-package.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');
const PACKAGE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'package-extension.sh');

const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));

function hasZip() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- synthetic package builder ---------------------------------------------
// A minimal package that passes every check, so each failure case can turn one
// thing bad and assert that exactly that check flips.

function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

function makePng(extraChunks = []) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    pngChunk('IEND'),
  ]);
}

const CLEAN_MANIFEST = {
  manifest_version: 3,
  name: 'Umbra',
  version: '0.0.1',
  description: 'Give a local agent scripted control of tabs it owns in your signed-in browser.',
  homepage_url: 'https://example.invalid/umbra',
  permissions: ['storage', 'tabs', 'debugger'],
  optional_host_permissions: ['<all_urls>'],
};

function cleanEntries(overrides = {}) {
  const entries = EXTENSION_FILES.map((name) => ({
    name,
    isDirectory: false,
    data: Buffer.from(name === 'manifest.json' ? JSON.stringify(CLEAN_MANIFEST) : `// ${name}\n`, 'utf8'),
  }));
  for (const size of [16, 32, 48, 128]) {
    entries.push({ name: `icons/icon${size}.png`, isDirectory: false, data: makePng() });
  }
  if (overrides.manifest) {
    const entry = entries.find((item) => item.name === 'manifest.json');
    entry.data = Buffer.from(JSON.stringify({ ...CLEAN_MANIFEST, ...overrides.manifest }), 'utf8');
  }
  if (overrides.add) entries.push(...overrides.add);
  if (overrides.replace) {
    for (const replacement of overrides.replace) {
      const index = entries.findIndex((item) => item.name === replacement.name);
      if (index >= 0) entries[index] = { isDirectory: false, ...replacement };
      else entries.push({ isDirectory: false, ...replacement });
    }
  }
  return entries;
}

function checkNamed(report, name) {
  const check = report.checks.find((item) => item.name === name);
  assert.ok(check, `no check named "${name}" in the report`);
  return check;
}

// --- the allowlist covers what the extension actually loads ----------------

test('the allowlist covers every resource the manifest declares', () => {
  const declared = new Set(['manifest.json']);
  declared.add(manifest.background.service_worker);
  declared.add(manifest.options_page);
  declared.add(manifest.action.default_popup);
  for (const value of Object.values(manifest.icons ?? {})) declared.add(value);
  for (const value of Object.values(manifest.action?.default_icon ?? {})) declared.add(value);
  for (const group of manifest.web_accessible_resources ?? []) {
    for (const value of group.resources ?? []) declared.add(value);
  }

  for (const resource of declared) {
    assert.ok(
      isAllowedEntry(resource),
      `manifest declares ${resource} but the packaging allowlist would drop it from the build`,
    );
  }
});

test('the allowlist covers every icon on disk, and every icon name is pinned', () => {
  const icons = fs.readdirSync(path.join(EXTENSION_DIR, 'icons'));
  assert.ok(icons.length > 0, 'extension/icons is empty');
  for (const icon of icons) {
    assert.match(
      `icons/${icon}`,
      ICON_ENTRY_PATTERN,
      `extension/icons/${icon} does not match the pinned icon name pattern, so it would not ship`,
    );
  }
});

test('the allowlist covers every script the extension loads at runtime', () => {
  const referenced = new Set();
  const sources = EXTENSION_FILES.filter((name) => name.endsWith('.js') || name.endsWith('.html'));
  for (const name of sources) {
    const text = fs.readFileSync(path.join(EXTENSION_DIR, name), 'utf8');
    for (const match of text.matchAll(/['"]([\w./-]+\.(?:js|html))['"]/g)) referenced.add(match[1]);
    for (const match of text.matchAll(/\bsrc="([^"]+)"/g)) referenced.add(match[1]);
  }

  const local = [...referenced]
    .map((value) => value.replace(/^\.\//, ''))
    .filter((value) => !value.startsWith('/') && !value.includes('..'))
    .filter((value) => fs.existsSync(path.join(EXTENSION_DIR, value)));

  assert.ok(local.length >= 5, `expected to find several referenced files, found ${local.length}`);

  for (const value of local) {
    const isRecipe = value.startsWith('recipes/');
    assert.ok(
      isAllowedEntry(value) || isRecipe,
      `${value} is loaded at runtime but is neither allowlisted nor a local-only recipe`,
    );
  }

  // The recipe path is built at runtime from the action name rather than
  // written as a literal, which is what keeps the worker from naming any site
  // it can automate. Assert the mechanism is still there, otherwise this file
  // would pass on a tree that reverted to a hardcoded recipe map.
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  assert.match(
    background,
    /recipes\/\$\{namespace\}-actions\.js/,
    'background.js should compute the recipe path from the action namespace',
  );
  assert.equal(
    /['"]recipes\/[\w.-]+\.js['"]/.test(background),
    false,
    'background.js should name no individual recipe file',
  );
});

test('every allowlisted file exists in the extension tree', () => {
  for (const name of EXTENSION_FILES) {
    assert.ok(fs.existsSync(path.join(EXTENSION_DIR, name)), `allowlisted file is missing: extension/${name}`);
  }
});

test('the allowlist excludes the local-only and removed directories', () => {
  for (const prefix of FORBIDDEN_PREFIXES) {
    assert.ok(
      !EXTENSION_FILES.some((name) => name.startsWith(prefix)),
      `${prefix} must not be on the packaging allowlist`,
    );
    assert.ok(!isAllowedEntry(`${prefix}anything.js`), `${prefix} entries must not be allowlisted`);
  }
});

// --- the gate catches what it exists to catch ------------------------------

test('a clean package passes every check', () => {
  const report = verifyPackage({ entries: cleanEntries(), zipSize: 90_000 });
  assert.equal(report.ok, true, report.failures.join('\n'));
});

test('an oversized archive fails', () => {
  const report = verifyPackage({ entries: cleanEntries(), zipSize: MAX_ZIP_BYTES + 1 });
  assert.equal(checkNamed(report, 'archive size is under the submission budget').ok, false);
});

test('a file outside the allowlist fails', () => {
  const entries = cleanEntries({
    add: [{ name: 'notes.txt', isDirectory: false, data: Buffer.from('stray\n') }],
  });
  const report = verifyPackage({ entries, zipSize: 90_000 });
  const check = checkNamed(report, 'every entry is on the allowlist');
  assert.equal(check.ok, false);
  assert.match(check.failures.join(' '), /notes\.txt/);
});

test('a recipes or assets entry fails', () => {
  for (const prefix of FORBIDDEN_PREFIXES) {
    const entries = cleanEntries({
      add: [{ name: `${prefix}thing.js`, isDirectory: false, data: Buffer.from('//\n') }],
    });
    const report = verifyPackage({ entries, zipSize: 90_000 });
    assert.equal(
      checkNamed(report, 'no local-only or leftover directory shipped').ok,
      false,
      `${prefix} was not rejected`,
    );
  }
});

test('a missing allowlisted file fails', () => {
  const entries = cleanEntries().filter((entry) => entry.name !== 'shared.js');
  const report = verifyPackage({ entries, zipSize: 90_000 });
  const check = checkNamed(report, 'every allowlisted file is present');
  assert.equal(check.ok, false);
  assert.match(check.failures.join(' '), /shared\.js/);
});

test('author identity in a file name or in file content fails', () => {
  // Both leaks are assembled rather than written out. A fixture that spells the
  // name is itself an occurrence of the name, so the release identity gate in
  // mcp-server/release-check.mjs flags this file and the gate then has to
  // exempt the very test that enforces it. Assembling keeps the fixture honest.
  const homePath = `/${['Us', 'ers'].join('')}/someone/Downloads`;
  const authorName = ['rob', 'ert'].join('');

  const inContent = verifyPackage({
    entries: cleanEntries({
      replace: [{ name: 'shared.js', data: Buffer.from(`const dir = "${homePath}";\n`) }],
    }),
    zipSize: 90_000,
  });
  const contentCheck = checkNamed(inContent, 'no author identity in any shipped byte');
  assert.equal(contentCheck.ok, false);
  assert.match(contentCheck.failures.join(' '), /shared\.js:1/);

  const inName = verifyPackage({
    entries: cleanEntries({
      add: [{ name: `${authorName}-notes.js`, isDirectory: false, data: Buffer.from('//\n') }],
    }),
    zipSize: 90_000,
  });
  assert.equal(checkNamed(inName, 'no author identity in any shipped byte').ok, false);
});

test('a third-party product name in shipped source fails, and a CSS cursor rule does not', () => {
  const bad = verifyPackage({
    entries: cleanEntries({
      replace: [{ name: 'background.js', data: Buffer.from("const ALARM = 'codex_bridge_wake';\n") }],
    }),
    zipSize: 90_000,
  });
  const check = checkNamed(bad, 'no third-party product name in any shipped byte');
  assert.equal(check.ok, false);
  assert.match(check.failures.join(' '), /codex/i);

  const cursor = verifyPackage({
    entries: cleanEntries({
      replace: [{ name: 'popup.html', data: Buffer.from('<style>button { cursor: pointer; }</style>\n') }],
    }),
    zipSize: 90_000,
  });
  assert.equal(
    checkNamed(cursor, 'no third-party product name in any shipped byte').ok,
    true,
    'a CSS cursor declaration must not read as a product name',
  );
});

test('compiling a string into code fails, and Runtime.evaluate does not', () => {
  const cases = [
    'const AsyncFunction = 1;\n',
    'const f = new Function("return 1");\n',
    'const value = eval("1 + 1");\n',
  ];
  for (const source of cases) {
    const report = verifyPackage({
      entries: cleanEntries({ replace: [{ name: 'content-agent.js', data: Buffer.from(source) }] }),
      zipSize: 90_000,
    });
    assert.equal(
      checkNamed(report, 'no source file compiles a string into code').ok,
      false,
      `not rejected: ${source.trim()}`,
    );
  }

  const debuggerPath = verifyPackage({
    entries: cleanEntries({
      replace: [
        {
          name: 'background.js',
          data: Buffer.from("await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression });\n"),
        },
      ],
    }),
    zipSize: 90_000,
  });
  assert.equal(
    checkNamed(debuggerPath, 'no source file compiles a string into code').ok,
    true,
    'the sanctioned debugger path must not be flagged',
  );
});

test('an icon carrying provenance metadata fails', () => {
  const withMetadata = makePng([
    pngChunk('tEXt', Buffer.from('Software\0an image generator', 'latin1')),
    pngChunk('eXIf', Buffer.from('MM\0*', 'latin1')),
  ]);
  const report = verifyPackage({
    entries: cleanEntries({ replace: [{ name: 'icons/icon128.png', data: withMetadata }] }),
    zipSize: 90_000,
  });
  const check = checkNamed(report, 'no icon carries provenance metadata');
  assert.equal(check.ok, false);
  assert.match(check.failures.join(' '), /tEXt/);
  assert.match(check.failures.join(' '), /eXIf/);
});

test('a manifest that demands site access at install time fails', () => {
  const report = verifyPackage({
    entries: cleanEntries({ manifest: { host_permissions: ['<all_urls>'], optional_host_permissions: [] } }),
    zipSize: 90_000,
  });
  const check = checkNamed(report, 'the manifest is store-ready');
  assert.equal(check.ok, false);
  assert.match(check.failures.join(' '), /optional_host_permissions/);
  assert.match(check.failures.join(' '), /host_permissions is non-empty/);
});

test('a third-party product name in the store description fails', () => {
  // Built from a fragment, not written out: the literal is exactly what the
  // gate scans shipped bytes for, and this file is one of them.
  const description = `Drive Chrome from the shadow. ${SEO_VENDOR} exports, owned tabs.`;
  const report = verifyPackage({
    entries: cleanEntries({ manifest: { description } }),
    zipSize: 90_000,
  });
  const check = checkNamed(report, 'the manifest is store-ready');
  assert.equal(check.ok, false);
  assert.match(check.failures.join(' '), SEO_VENDOR_RE);
});

test('a third-party product name anywhere in a shipped file fails', () => {
  const entries = cleanEntries({
    replace: [{ name: 'background.js', data: Buffer.from(`const recipe = 'recipes/${SEO_VENDOR}-actions.js';\n`, 'utf8') }],
  });

  const report = verifyPackage({ entries, zipSize: 90_000 });
  const check = checkNamed(report, 'no third-party product name in any shipped byte');
  assert.equal(check.ok, false);
  assert.match(check.failures.join(' '), SEO_VENDOR_RE);
});

test('readPngChunkTypes reads the chunks a stripped icon keeps', () => {
  assert.deepEqual(readPngChunkTypes(makePng()), ['IHDR', 'IDAT', 'IEND']);
});

// --- the real build --------------------------------------------------------

test('the build script ships the allowlist and ignores a stray file', { skip: hasZip() ? false : 'zip is not installed' }, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-package-test-'));
  try {
    const sourceDir = path.join(workDir, 'extension');
    fs.cpSync(EXTENSION_DIR, sourceDir, { recursive: true });

    const run = (distDir) => {
      fs.mkdirSync(distDir, { recursive: true });
      execFileSync('bash', [PACKAGE_SCRIPT], {
        env: { ...process.env, UMBRA_EXTENSION_DIR: sourceDir, UMBRA_DIST_DIR: distDir },
        stdio: 'pipe',
      });
      const built = fs.readdirSync(distDir).filter((name) => name.endsWith('.zip'));
      assert.equal(built.length, 1, `expected one zip in ${distDir}, found ${built.join(', ')}`);
      return path.join(distDir, built[0]);
    };

    const baselineZip = run(path.join(workDir, 'dist-baseline'));
    const baselineNames = readZipEntries(fs.readFileSync(baselineZip))
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(
      baselineNames.filter((name) => !name.startsWith('icons/')),
      [...EXTENSION_FILES].sort(),
    );
    assert.ok(baselineNames.some((name) => ICON_ENTRY_PATTERN.test(name)), 'no icons in the built package');
    assert.equal(verifyPackageFile(baselineZip).ok, true);

    // A stray file, a leftover directory, and a recipe file all land in the
    // source tree. None of them may reach the archive.
    fs.writeFileSync(path.join(sourceDir, 'scratch-notes.txt'), 'local scratch\n');
    fs.mkdirSync(path.join(sourceDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'assets', 'source-art.jpg'), Buffer.alloc(64));
    fs.mkdirSync(path.join(sourceDir, 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'recipes', 'extra-actions.js'), 'globalThis.x = 1;\n');

    const strayZip = run(path.join(workDir, 'dist-stray'));
    const strayNames = readZipEntries(fs.readFileSync(strayZip))
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(strayNames, baselineNames, 'a stray file changed the contents of the package');
    assert.equal(
      fs.readFileSync(strayZip).equals(fs.readFileSync(baselineZip)),
      true,
      'the build is not reproducible: two builds of the same allowlist differ',
    );
    assert.equal(verifyPackageFile(strayZip).ok, true);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

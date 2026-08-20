import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// The extension a browser actually loaded. The default is this checkout's own
// `extension/` folder, because loading unpacked from the repository is the
// documented setup. Anyone who loaded a copy from somewhere else points
// UMBRA_EXTENSION_DIR at it and gets a real drift comparison back. The old
// hardcoded path reported full drift on every run for everyone except the one
// machine it named.
const activeExtensionDirFromEnv = process.env.UMBRA_EXTENSION_DIR?.trim() || '';
const canonicalExtensionDir = path.join(repoRoot, 'extension');
const activeExtensionDir = activeExtensionDirFromEnv
  ? path.resolve(activeExtensionDirFromEnv)
  : canonicalExtensionDir;
const comparingAgainstSelf = path.resolve(activeExtensionDir) === path.resolve(canonicalExtensionDir);

// Identity gate. A release fails when any file that would ship carries the
// author's name, an absolute home directory, or the third-party SEO product
// whose automation stays in the local-only plugins. That is the class of leak
// this whole sanitize pass exists to remove. Two knobs keep it usable while
// other work is in flight: --identity-only skips the test run, and --paths
// narrows the scan to named subdirectories.
//
// The two name needles are assembled from fragments on purpose. Written out as
// literals they would match this file itself on every run, which leaves only
// two bad options: exempt the one file that must never be exempt, or fail every
// release. Assembling them keeps the scanner inside its own scope.
const AUTHOR_GIVEN_NAME = ['rob', 'ert'].join('');
const AUTHOR_SURNAME = ['lo', 'ra'].join('');
const AUTHOR_HANDLE = `rj${AUTHOR_SURNAME}`;
// The SEO vendor whose page automation the optional local plugins drive. Those
// plugins are gitignored, so the gate skips them and every remaining hit is a
// tracked file naming a third-party product the public tree has no reason to
// mention. Assembled from fragments for the same reason the names above are.
const SEO_VENDOR = ['ah', 'refs'].join('');

const IDENTITY_PATTERNS = [
  { name: 'author-name', regex: new RegExp(AUTHOR_GIVEN_NAME, 'i') },
  { name: 'author-handle', regex: new RegExp(AUTHOR_HANDLE, 'i') },
  // Bounded, because the surname is a substring of ordinary English words such
  // as "exploration" and an unbounded match would bury real leaks in noise.
  { name: 'author-surname', regex: new RegExp(`(?<![a-z])${AUTHOR_SURNAME}(?![a-z])`, 'i') },
  { name: 'home-path', regex: /\/Users\/[A-Za-z]/ },
  { name: 'seo-vendor', regex: new RegExp(SEO_VENDOR, 'i') },
];

// Directories the scan never walks, whatever .gitignore says. `.git` holds
// packed history that is not a shipped file, and build output under `target`
// is regenerated rather than tracked.
const ALWAYS_SKIPPED_DIRS = new Set(['.git', 'node_modules', 'target']);

// Binary payloads have no reviewable text, and a byte sequence that happens to
// spell a name inside a PNG is not a leak anyone can act on.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.mov', '.webm', '.wasm', '.dylib', '.so', '.rlib', '.crate',
]);

const MAX_SCANNED_BYTES = 5 * 1024 * 1024;

function parseArgs(argv) {
  const options = { identityOnly: false, skipIdentity: false, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--identity-only') {
      options.identityOnly = true;
    } else if (arg === '--skip-identity') {
      options.skipIdentity = true;
    } else if (arg === '--paths') {
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        options.paths.push(argv[index + 1]);
        index += 1;
      }
    } else {
      throw new Error(`Unknown release-check option: ${arg}`);
    }
  }
  return options;
}

// A small .gitignore matcher, deliberately limited to the pattern shapes this
// repository uses: comments, blank lines, directory suffixes, root anchors, and
// single-segment globs. It exists so the gate skips exactly what the repository
// already refuses to publish, including docs/private-setup.md, without shelling
// out to git.
function compileIgnoreRules(gitignoreText) {
  const rules = [];
  for (const rawLine of gitignoreText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }
    const directoryOnly = line.endsWith('/');
    let pattern = directoryOnly ? line.slice(0, -1) : line;
    const rootAnchored = pattern.startsWith('/') || pattern.includes('/');
    pattern = pattern.replace(/^\//, '');
    const body = pattern
      .split('/')
      .map((segment) => segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'))
      .join('/');
    const prefix = rootAnchored ? '^' : '(^|.*/)';
    rules.push({
      directoryOnly,
      // The path itself, or anything beneath it.
      selfOrBelow: new RegExp(`${prefix}${body}($|/)`),
      // Strictly beneath it. A `dir/` rule excludes everything under that
      // directory, so a file has to be skipped on its ancestor's rule even when
      // the walk starts inside the directory and never sees the entry itself.
      below: new RegExp(`${prefix}${body}/`),
    });
  }
  return rules;
}

function isIgnored(rules, relativePath, isDirectory) {
  return rules.some((rule) => {
    if (rule.directoryOnly) {
      // A trailing slash in .gitignore matches a directory and its contents,
      // never a plain file that happens to carry the same name.
      return isDirectory ? rule.selfOrBelow.test(relativePath) : rule.below.test(relativePath);
    }
    return rule.selfOrBelow.test(relativePath);
  });
}

async function collectScannableFiles(root, rules, scopes) {
  const files = [];
  async function walk(currentAbsolute, currentRelative) {
    const entries = await fsp.readdir(currentAbsolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRS.has(entry.name) || isIgnored(rules, relative, true)) {
          continue;
        }
        await walk(path.join(currentAbsolute, entry.name), relative);
      } else if (entry.isFile()) {
        if (isIgnored(rules, relative, false)) {
          continue;
        }
        if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        files.push(relative);
      }
    }
  }
  if (scopes.length === 0) {
    await walk(root, '');
  } else {
    for (const scope of scopes) {
      const normalized = scope.replace(/\/+$/, '');
      const absolute = path.join(root, normalized);
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat) {
        throw new Error(`--paths names a path that does not exist: ${scope}`);
      }
      if (isIgnored(rules, normalized, stat.isDirectory())) {
        // Naming an ignored path explicitly scans nothing, and a green exit code
        // on a scan that covered no files reads as a pass. Refuse instead.
        throw new Error(
          `--paths names ${scope}, which .gitignore excludes, so nothing under it would be scanned.`,
        );
      }
      if (stat.isDirectory()) {
        await walk(absolute, normalized);
      } else {
        files.push(normalized);
      }
    }
  }
  return files.sort();
}

async function scanForIdentityLeaks(scopes) {
  const gitignoreText = await fsp.readFile(path.join(repoRoot, '.gitignore'), 'utf8').catch(() => '');
  const rules = compileIgnoreRules(gitignoreText);
  const files = await collectScannableFiles(repoRoot, rules, scopes);
  const warnings = [];
  const findings = [];
  let scannedFileCount = 0;
  for (const relative of files) {
    const absolute = path.join(repoRoot, relative);
    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat || stat.size > MAX_SCANNED_BYTES) {
      continue;
    }
    const content = await fsp.readFile(absolute, 'utf8').catch(() => null);
    if (content === null || content.includes('\u0000')) {
      continue;
    }
    scannedFileCount += 1;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      for (const pattern of IDENTITY_PATTERNS) {
        if (pattern.regex.test(lines[index])) {
          findings.push({
            file: relative,
            line: index + 1,
            pattern: pattern.name,
            text: lines[index].trim().slice(0, 160),
          });
        }
      }
    }
  }
  if (scannedFileCount === 0) {
    warnings.push('the identity scan covered zero files');
  }
  return { scannedFileCount, findings, warnings };
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function listFiles(dir) {
  const files = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else {
        files.push(path.relative(dir, filePath));
      }
    }
  }
  await walk(dir);
  return files.sort();
}

async function compareExtensionDirs(left, right) {
  const leftFiles = await listFiles(left);
  const rightFiles = await listFiles(right).catch(() => []);
  const all = [...new Set([...leftFiles, ...rightFiles])].sort();
  const drift = [];
  for (const file of all) {
    const [leftContent, rightContent] = await Promise.all([
      fsp.readFile(path.join(left, file)).catch(() => null),
      fsp.readFile(path.join(right, file)).catch(() => null),
    ]);
    const leftHash = leftContent ? crypto.createHash('sha256').update(leftContent).digest('hex') : null;
    const rightHash = rightContent ? crypto.createHash('sha256').update(rightContent).digest('hex') : null;
    if (!leftHash || !rightHash || leftHash !== rightHash) {
      drift.push(file);
    }
  }
  return drift;
}

const options = parseArgs(process.argv.slice(2));

const identity = options.skipIdentity
  ? { skipped: true, scannedFileCount: 0, findings: [], warnings: ['the identity scan was skipped with --skip-identity'] }
  : await scanForIdentityLeaks(options.paths);

// A scan that covered zero files is not a pass. --skip-identity and a --paths
// scope that resolves to nothing both used to report passed: true with
// scannedFileCount: 0, so a CI step reading the JSON got a green on a scan that
// never looked at anything.
const identityScanned = identity.scannedFileCount > 0;
const identityPassed = identityScanned && identity.findings.length === 0;
const identityExitCode = identityPassed ? 0 : 1;

if (identity.findings.length > 0) {
  console.error(`Identity gate failed. ${identity.findings.length} line(s) carry an author name, an absolute home path, or a third-party product name:`);
  for (const finding of identity.findings.slice(0, 50)) {
    console.error(`  ${finding.file}:${finding.line} [${finding.pattern}] ${finding.text}`);
  }
  if (identity.findings.length > 50) {
    console.error(`  ... and ${identity.findings.length - 50} more.`);
  }
  console.error('');
  console.error('A test that asserts one of these names is absent still counts as a hit, because the');
  console.error('repository target is zero occurrences anywhere. Build the needle from fragments the');
  console.error('way IDENTITY_PATTERNS in this file does, so the assertion stays readable and the');
  console.error('literal never appears.');
}

for (const warning of identity.warnings ?? []) {
  console.error(`Identity gate warning: ${warning}.`);
}

if (options.identityOnly) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: 'identity-only',
    identity: {
      scannedFileCount: identity.scannedFileCount,
      scopes: options.paths.length > 0 ? options.paths : ['<repository root>'],
      scanned: identityScanned,
      passed: identityPassed,
      findingCount: identity.findings.length,
      findings: identity.findings,
      warnings: identity.warnings ?? [],
    },
  }, null, 2));
  process.exit(identityExitCode);
}

const test = spawnSync('npm', ['test'], {
  cwd: path.join(repoRoot, 'mcp-server'),
  stdio: 'inherit',
});
if (test.status !== 0) {
  process.exit(test.status || 1);
}

const canonicalManifest = await readJson(path.join(canonicalExtensionDir, 'manifest.json'));
const activeManifest = comparingAgainstSelf
  ? canonicalManifest
  : await readJson(path.join(activeExtensionDir, 'manifest.json')).catch(() => null);
const drift = comparingAgainstSelf
  ? []
  : await compareExtensionDirs(canonicalExtensionDir, activeExtensionDir);

const checklist = {
  generatedAt: new Date().toISOString(),
  testsPassed: true,
  identity: {
    scannedFileCount: identity.scannedFileCount,
    scopes: options.paths.length > 0 ? options.paths : ['<repository root>'],
    skipped: identity.skipped === true,
    scanned: identityScanned,
    passed: identityPassed,
    findingCount: identity.findings.length,
    findings: identity.findings,
    warnings: identity.warnings ?? [],
  },
  canonicalVersion: canonicalManifest.version,
  activeVersion: activeManifest?.version || null,
  activeExtensionDir,
  activeExtensionDirSource: activeExtensionDirFromEnv ? 'UMBRA_EXTENSION_DIR' : 'repository',
  comparedAgainstSeparateCopy: !comparingAgainstSelf,
  activeMatchesCanonicalByHash: drift.length === 0,
  drift,
  nextSteps: [
    comparingAgainstSelf
      ? 'Set UMBRA_EXTENSION_DIR to a separately loaded copy to get a real drift comparison.'
      : 'Sync canonical extension/ to the loaded extension folder if drift is expected.',
    'Reload the unpacked extension after extension code changes.',
    'Run live smoke checks after reload.',
  ],
};

console.log(JSON.stringify(checklist, null, 2));
process.exit(identityExitCode);

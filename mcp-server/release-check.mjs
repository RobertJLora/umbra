import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const activeExtensionDir = '/Users/RobertLora/Documents/Workspaces/Projects/Active/umbra/extension';

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

const test = spawnSync('npm', ['test'], {
  cwd: path.join(repoRoot, 'mcp-server'),
  stdio: 'inherit',
});
if (test.status !== 0) {
  process.exit(test.status || 1);
}

const canonicalManifest = await readJson(path.join(repoRoot, 'extension', 'manifest.json'));
const activeManifest = await readJson(path.join(activeExtensionDir, 'manifest.json')).catch(() => null);
const drift = await compareExtensionDirs(path.join(repoRoot, 'extension'), activeExtensionDir);

const checklist = {
  generatedAt: new Date().toISOString(),
  testsPassed: true,
  canonicalVersion: canonicalManifest.version,
  activeVersion: activeManifest?.version || null,
  activeExtensionDir,
  activeMatchesCanonicalByHash: drift.length === 0,
  drift,
  nextSteps: [
    'Sync canonical extension/ to the Active loaded extension folder if drift is expected.',
    'Reload the unpacked CiC extension registered from the Active path after extension code changes.',
    'Run live smoke checks after reload.',
  ],
};

console.log(JSON.stringify(checklist, null, 2));

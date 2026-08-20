import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FileDownloadLedger, describeUserPath } from '../../mcp-server/download-ledger.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function writeAged(filePath, contents, ageMs) {
  await fsp.writeFile(filePath, contents, 'utf8');
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, stamp, stamp);
}

test('file download ledger waits for an exact stable file without Chrome downloads permission', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cic-download-ledger-'));
  try {
    const ledger = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
    const filePath = path.join(tempDir, 'fixture.csv');
    await fsp.writeFile(filePath, 'a,b\n1,2\n', 'utf8');

    const result = await ledger.waitForExact({ filename: 'fixture.csv', timeoutMs: 200 });

    assert.equal(result.filePath, filePath);
    assert.equal(result.bytes, fs.statSync(filePath).size);
    assert.ok(result.ledgerEvents.some((event) => event.type === 'wait_exact_start'));
    assert.ok(ledger.snapshot().some((event) => event.type === 'wait_exact_complete'));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('file download ledger finds the newest matching completed download', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cic-download-ledger-'));
  try {
    const ledger = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
    const sinceMs = Date.now() - 1_000;
    await fsp.writeFile(path.join(tempDir, 'old-target.csv'), 'old\n', 'utf8');
    await fsp.writeFile(path.join(tempDir, 'target-other.csv.crdownload'), 'partial\n', 'utf8');
    await fsp.writeFile(path.join(tempDir, 'target-report.csv'), 'new\n', 'utf8');

    const result = await ledger.waitForNew({
      sinceMs,
      timeoutMs: 200,
      extension: '.csv',
      nameIncludes: ['target', 'report'],
    });

    assert.equal(result.filename, 'target-report.csv');
    assert.ok(result.bytes > 0);
    assert.ok(result.ledgerEvents.some((event) => event.type === 'wait_new_start'));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a missing download directory fails by name at wait entry instead of running the full timeout', async () => {
  const missingDir = path.join(os.tmpdir(), `umbra-missing-downloads-${Date.now()}`);
  const ledger = new FileDownloadLedger({ downloadDir: missingDir, pollMs: 5, stableSamples: 1 });

  const startedAt = Date.now();
  await assert.rejects(
    () => ledger.waitForNew({ sinceMs: Date.now() - 1_000, timeoutMs: 30_000, extension: '.csv' }),
    (error) => {
      assert.match(error.message, /Download directory not found/);
      assert.match(error.message, /UMBRA_DOWNLOAD_DIR/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 500, 'wait entry must fail fast, not after the timeout');

  await assert.rejects(
    () => ledger.waitForExact({ filename: 'anything.csv', timeoutMs: 30_000 }),
    /Download directory not found/,
  );
  assert.ok(ledger.snapshot().some((event) => event.type === 'download_dir_missing'));

  // findNew stays tolerant, because the Ahrefs runner calls it as the recovery
  // inside a catch where a throw would replace the original error.
  assert.deepEqual(await ledger.findNew({ sinceMs: 0, extension: '.csv' }), []);
});

test('neither ledger nor Ahrefs runner prints an absolute home path in an error', () => {
  for (const relative of ['mcp-server/download-ledger.mjs', 'mcp-server/ahrefs-export.js']) {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.doesNotMatch(source, /\/Users\//, relative);
  }
  const home = os.homedir();
  assert.equal(describeUserPath(path.join(home, 'Downloads')), path.join('~', 'Downloads'));
  assert.equal(describeUserPath('/opt/shared/downloads'), '/opt/shared/downloads');
});

test('a claimed download wins over a newer file that only matches the substring', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'umbra-download-attribution-'));
  try {
    const claimed = 'example.com-organic-keywords-subdo_2026-08-20_09-06-33.csv';
    const decoy = 'example.com-invoice.csv';
    await writeAged(path.join(tempDir, claimed), 'Keyword,Volume\na,1\n', 2_000);
    await writeAged(path.join(tempDir, decoy), 'unrelated\n', 1_000);
    const sinceMs = Date.now() - 5_000;

    const unattributed = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
    const generic = await unattributed.waitForNew({
      sinceMs,
      timeoutMs: 200,
      extension: '.csv',
      nameIncludes: ['example.com'],
    });
    assert.equal(generic.filename, decoy, 'without a claim the newest match still wins');
    assert.equal(generic.attributed, false);

    const attributed = new FileDownloadLedger({
      downloadDir: tempDir,
      pollMs: 5,
      stableSamples: 1,
      scope: { tabId: 42 },
      attributionSource: async () => [{ suggestedFilename: claimed, tabId: 42, guid: 'abc' }],
    });
    const pinned = await attributed.waitForNew({
      sinceMs,
      timeoutMs: 200,
      extension: '.csv',
      nameIncludes: ['example.com'],
    });
    assert.equal(pinned.filename, claimed);
    assert.equal(pinned.attributed, true);
    assert.ok(attributed.snapshot().some((event) => event.type === 'download_will_begin'));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('attribution degrades to filename and mtime when the signal is unavailable or wrong', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'umbra-download-attribution-'));
  try {
    const present = 'example.com-organic-keywords-subdo_2026-08-20_09-06-33.csv';
    await writeAged(path.join(tempDir, present), 'Keyword,Volume\na,1\n', 1_000);
    const sinceMs = Date.now() - 5_000;

    const brokenSource = new FileDownloadLedger({
      downloadDir: tempDir,
      pollMs: 5,
      stableSamples: 1,
      attributionSource: async () => {
        throw new Error('no download attribution on this build');
      },
    });
    const degraded = await brokenSource.waitForNew({
      sinceMs,
      timeoutMs: 200,
      extension: '.csv',
      nameIncludes: ['example.com'],
    });
    assert.equal(degraded.filename, present);
    assert.equal(degraded.attributed, false);

    // Chrome renames on filename conflict, so a claim can name a file that never
    // appears. The lower tiers must still answer rather than wait out the timeout.
    const staleClaim = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
    staleClaim.claimExpectedDownload({ suggestedFilename: 'never-written.csv', tabId: 7 });
    const recovered = await staleClaim.waitForNew({
      sinceMs,
      timeoutMs: 200,
      extension: '.csv',
      nameIncludes: ['example.com'],
    });
    assert.equal(recovered.filename, present);
    assert.equal(recovered.attributed, false);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('report filename hints outrank an unrelated file that shares the domain name', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'umbra-download-hints-'));
  try {
    const report = 'example.com-organic-keywords-subdo_2026-08-20_09-06-33.csv';
    const human = 'example.com-invoice.csv';
    await writeAged(path.join(tempDir, report), 'Keyword,Volume\na,1\n', 2_000);
    await writeAged(path.join(tempDir, human), 'unrelated\n', 1_000);
    const sinceMs = Date.now() - 5_000;
    const ledger = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });

    const hinted = await ledger.findNew({
      sinceMs,
      extension: '.csv',
      nameIncludes: ['example.com'],
      nameIncludesAny: ['organic-keywords'],
    });
    assert.equal(hinted[0].filename, report);

    const noHintMatches = await ledger.findNew({
      sinceMs,
      extension: '.csv',
      nameIncludes: ['example.com'],
      nameIncludesAny: ['refdomains'],
    });
    assert.equal(noHintMatches[0].filename, human, 'a hint that matches nothing must not starve the match');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

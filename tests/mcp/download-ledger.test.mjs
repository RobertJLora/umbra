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

  // findNew stays tolerant, because an export runner calls it as the recovery
  // inside a catch where a throw would replace the original error.
  assert.deepEqual(await ledger.findNew({ sinceMs: 0, extension: '.csv' }), []);
});

test('the ledger prints no absolute home path in an error', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'download-ledger.mjs'), 'utf8');
  assert.doesNotMatch(source, /\/Users\//);
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

test('an accented filename matches whichever unicode normalization the caller typed', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cic-download-ledger-'));
  try {
    // APFS keeps the bytes it was given, so a name Chrome built from page text
    // arrives decomposed while a token a caller typed is usually composed.
    const composedToken = 'cafe\u0301'.normalize('NFC');
    const decomposedToken = 'cafe\u0301'.normalize('NFD');
    assert.notEqual(composedToken, decomposedToken, 'the two normal forms must differ as strings');
    await fsp.writeFile(path.join(tempDir, `${decomposedToken}-export.csv`), 'a,b\n1,2\n', 'utf8');

    for (const token of [composedToken, decomposedToken]) {
      const ledger = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
      const matches = await ledger.findNew({ sinceMs: 0, nameIncludes: [token] });
      assert.equal(matches.length, 1, `token ${JSON.stringify(token)} matched nothing`);
    }

    // The same split used to drop the whole CDP attribution tier to tier 0.
    const ledger = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
    ledger.claimExpectedDownload({ suggestedFilename: `${composedToken}-export.csv`, tabId: 1 });
    const attributed = await ledger.findNew({ sinceMs: 0, expectedNames: ledger.expectedFilenames() });
    assert.equal(attributed[0]?.attributed, true);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a filename cannot escape the watched directory, on the wait or the clear path', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cic-download-ledger-'));
  try {
    const outside = path.join(tempDir, 'outside');
    const watched = path.join(tempDir, 'dl');
    await fsp.mkdir(outside);
    await fsp.mkdir(watched);
    const victim = path.join(outside, 'secret.txt');
    await fsp.writeFile(victim, 'SECRET\n', 'utf8');

    const ledger = new FileDownloadLedger({ downloadDir: watched, pollMs: 5, stableSamples: 1 });
    await assert.rejects(
      ledger.waitForExact({ filename: '../outside/secret.txt', timeoutMs: 100 }),
      /Timed out/,
      'a traversal filename reported a file outside the download directory as a completed download',
    );
    await ledger.clearExact('../outside/secret.txt').catch(() => {});
    assert.equal(fs.existsSync(victim), true, 'clearExact deleted a file outside the download directory');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a stale file already sitting at the expected name is not reported as this download', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cic-download-ledger-'));
  try {
    const stale = path.join(tempDir, 'stale-export.csv');
    await writeAged(stale, 'col1,col2\nold,data\n', 60 * 60 * 1000);

    const ledger = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
    await assert.rejects(
      ledger.waitForExact({ filename: 'stale-export.csv', timeoutMs: 150, sinceMs: Date.now() }),
      /predates this call/,
    );

    // A file written after the call still answers, so the tool keeps working.
    const fresh = new FileDownloadLedger({ downloadDir: tempDir, pollMs: 5, stableSamples: 1 });
    const sinceMs = Date.now();
    const pending = fresh.waitForExact({ filename: 'stale-export.csv', timeoutMs: 2_000, sinceMs });
    await fsp.writeFile(stale, 'col1,col2\nnew,data\n', 'utf8');
    const result = await pending;
    assert.equal(result.filePath, stale);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('browser_wait_for_download says the extension is not connected instead of timing out', async () => {
  const { resolveDownloadWait } = await import('../../mcp-server/download-ledger.mjs');
  const startedAt = Date.now();
  await assert.rejects(
    resolveDownloadWait({ timeoutMs: 30_000 }, () => false, 'sess_x'),
    /extension is not connected/,
  );
  assert.ok(Date.now() - startedAt < 1_000, 'the not-connected case burned the wait');

  await assert.rejects(
    resolveDownloadWait({ timeoutMs: -5 }, () => true, 'sess_x'),
    /positive timeoutMs/,
  );
});

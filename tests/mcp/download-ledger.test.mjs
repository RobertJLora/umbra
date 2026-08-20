import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDownloadLedger } from '../../mcp-server/download-ledger.mjs';

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

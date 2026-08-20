import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseElapsedSeconds } from '../../mcp-server/cleanup-headless-chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const cleanupScript = path.join(repoRoot, 'mcp-server', 'cleanup-headless-chrome.mjs');

describe('cleanup-headless-chrome.mjs', () => {
  it('targets only stale headless automation Chrome roots', () => {
    const source = fs.readFileSync(cleanupScript, 'utf8');

    assert.match(source, /DEFAULT_MIN_AGE_MINUTES = 60/);
    assert.match(source, /agent-browser-profile-/);
    assert.match(source, /\.chrome-cdp-profile12-lanes\//);
    assert.match(source, /browser-use-user-data-dir-/);
    assert.match(source, /playwright_chromiumdev_profile-/);
    assert.match(source, /puppeteer_dev_chrome_profile-/);
    assert.match(source, /\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome/);
    assert.match(source, /--headless/);
    assert.doesNotMatch(source, /Google Chrome Helper/);
  });

  it('supports dry-run and age guards before terminating', () => {
    const source = fs.readFileSync(cleanupScript, 'utf8');

    assert.match(source, /--dry-run/);
    assert.match(source, /--min-age-minutes/);
    assert.match(source, /pid=,etime=,command=/);
    assert.match(source, /processInfo\.ageSeconds >= minAgeMinutes \* 60/);
    assert.match(source, /process\.kill\(pid, 'SIGTERM'\)/);
  });

  it('parses macOS ps elapsed time formats', () => {
    assert.equal(parseElapsedSeconds('03:12'), 192);
    assert.equal(parseElapsedSeconds('01:03:12'), 3792);
    assert.equal(parseElapsedSeconds('2-01:03:12'), 176592);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isBridgeHealth, parseElapsedSeconds } from '../../mcp-server/cleanup-listeners.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const cleanupScript = path.join(repoRoot, 'mcp-server', 'cleanup-listeners.mjs');

describe('cleanup-listeners.mjs', () => {
  it('can limit automatic cleanup to old disconnected bridge listeners', () => {
    const source = fs.readFileSync(cleanupScript, 'utf8');

    assert.match(source, /--only-disconnected/);
    assert.match(source, /--min-age-seconds/);
    assert.match(source, /path: '\/healthz'/);
    assert.match(source, /isBridgeHealth\(health\)/);
    assert.match(source, /healthExtensionConnected\(health\) !== false/);
    assert.match(source, /ageSeconds < options\.minAgeSeconds/);
  });

  it('defaults test cleanup to disconnected listeners so active agents are preserved', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp-server', 'package.json'), 'utf8'));

    assert.match(packageJson.scripts['cleanup:test'], /--preserve-port 47821/);
    assert.match(packageJson.scripts['cleanup:test'], /--only-disconnected/);
    assert.match(packageJson.scripts['cleanup:test:force'], /--preserve-port 47821/);
    assert.doesNotMatch(packageJson.scripts['cleanup:test:force'], /--only-disconnected/);
  });

  it('parses macOS ps elapsed time formats', () => {
    assert.equal(parseElapsedSeconds('03:12'), 192);
    assert.equal(parseElapsedSeconds('01:03:12'), 3792);
    assert.equal(parseElapsedSeconds('2-01:03:12'), 176592);
  });

  it('recognizes bridge health responses when process command inspection is blocked', () => {
    assert.equal(isBridgeHealth({
      ok: true,
      name: 'umbra',
      sessionId: 'sess_test',
      extensionConnected: false,
    }), true);
    assert.equal(isBridgeHealth({ ok: true, name: 'other-service' }), false);
    assert.equal(isBridgeHealth({ ok: false, name: 'umbra' }), false);
  });
});

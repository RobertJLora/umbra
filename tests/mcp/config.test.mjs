import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveBrokerSocketPath,
  resolveDownloadDir,
  resolveLaunchdLabel,
  resolveSharedKeyPath,
} from '../../mcp-server/config.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MIN_CHILD_CALL_TIMEOUT_MS,
  resolveBrokerRequestTimeoutMs,
  resolveChildCallTimeoutMs,
} from '../../mcp-server/timeouts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const configSource = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'config.js'), 'utf8');
const timeoutsSource = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'timeouts.js'), 'utf8');
const serverManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'mcp-server', 'package.json'), 'utf8'),
);

const MANAGED_VARS = [
  'UMBRA_DOWNLOAD_DIR',
  'UMBRA_BROKER_SOCKET',
  'UMBRA_BROKER_LAUNCHD_LABEL',
  'UMBRA_SHARED_KEY_FILE',
];

// Every resolver reads process.env at call time, so a test can set a variable,
// read the resolver, and restore the previous value without reimporting.
function withEnv(values, fn) {
  const saved = new Map();
  for (const name of MANAGED_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    for (const [name, value] of Object.entries(values)) {
      process.env[name] = value;
    }
    return fn();
  } finally {
    for (const name of MANAGED_VARS) {
      const previous = saved.get(name);
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
  }
}

describe('mcp-server/config.js', () => {
  it('honours the environment variable for every resolver', () => {
    withEnv({ UMBRA_DOWNLOAD_DIR: '/var/tmp/umbra-downloads' }, () => {
      assert.equal(resolveDownloadDir(), '/var/tmp/umbra-downloads');
    });
    withEnv({ UMBRA_BROKER_SOCKET: '/var/tmp/umbra/custom.sock' }, () => {
      assert.equal(resolveBrokerSocketPath(), '/var/tmp/umbra/custom.sock');
    });
    withEnv({ UMBRA_BROKER_LAUNCHD_LABEL: 'org.example.umbra' }, () => {
      assert.equal(resolveLaunchdLabel(), 'org.example.umbra');
    });
    withEnv({ UMBRA_SHARED_KEY_FILE: '/var/tmp/umbra/key' }, () => {
      assert.equal(resolveSharedKeyPath(), '/var/tmp/umbra/key');
    });
  });

  it('treats a blank variable as unset instead of returning an empty path', () => {
    withEnv({ UMBRA_DOWNLOAD_DIR: '   ' }, () => {
      assert.equal(resolveDownloadDir(), path.join(os.homedir(), 'Downloads'));
    });
  });

  it('derives every unset fallback from the running user home directory', () => {
    withEnv({}, () => {
      assert.equal(resolveDownloadDir(), path.join(os.homedir(), 'Downloads'));
      assert.equal(resolveBrokerSocketPath(), path.join(os.homedir(), '.umbra', 'run', 'broker.sock'));
      assert.equal(resolveSharedKeyPath(), path.join(os.homedir(), '.umbra', 'shared-key'));
      assert.equal(resolveLaunchdLabel(), 'dev.umbra.broker');
    });
  });

  it('keeps the broker socket out of world-writable /tmp', () => {
    withEnv({}, () => {
      assert.doesNotMatch(resolveBrokerSocketPath(), /^\/tmp\//);
    });
  });

  // Personal-identity scanning is repo-wide and lives in the release check.
  // This case covers only the hardcoded absolute paths these two modules exist
  // to replace.
  it('ships no hardcoded home path and no world-writable socket path', () => {
    assert.doesNotMatch(configSource, /\/Users\//);
    assert.doesNotMatch(configSource, /\/tmp\/umbra/);
    assert.doesNotMatch(timeoutsSource, /\/Users\//);
  });
});

describe('mcp-server/timeouts.js', () => {
  it('clamps a child call down to the remaining parent budget', () => {
    assert.equal(resolveChildCallTimeoutMs(3000, 60000), 3000);
  });

  it('fills a child timeout from the remaining budget when the child omits one', () => {
    assert.equal(resolveChildCallTimeoutMs(12000, undefined), 12000);
    assert.equal(resolveChildCallTimeoutMs(12000, 0), 12000);
  });

  it('never returns a value below the one second floor', () => {
    assert.equal(resolveChildCallTimeoutMs(10, 10), MIN_CHILD_CALL_TIMEOUT_MS);
    assert.equal(resolveChildCallTimeoutMs(-5, 250), MIN_CHILD_CALL_TIMEOUT_MS);
  });

  it('returns null when neither a budget nor a request is usable', () => {
    assert.equal(resolveChildCallTimeoutMs(undefined, undefined), null);
    assert.equal(resolveChildCallTimeoutMs(0, null), null);
  });

  it('keeps resolveBrokerRequestTimeoutMs raising to the floor and capping the ceiling', () => {
    assert.equal(resolveBrokerRequestTimeoutMs(undefined, {}), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveBrokerRequestTimeoutMs(60000, { timeoutMs: 3000 }), 60000);
    assert.equal(resolveBrokerRequestTimeoutMs(60000, { timeoutMs: 95000 }), 100000);
    assert.equal(resolveBrokerRequestTimeoutMs(60000, { timeoutMs: 600000 }), 185000);
  });
});

describe('mcp-server/package.json', () => {
  it('is publishable with a scoped public name and an npx entry point', () => {
    assert.equal(serverManifest.private, undefined);
    assert.match(serverManifest.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/);
    assert.equal(serverManifest.bin.umbra, './cli.js');
    assert.equal(serverManifest.publishConfig.access, 'public');
  });

  it('allowlists the runtime files and excludes the local-only Ahrefs plugin', () => {
    const files = serverManifest.files;
    assert.ok(Array.isArray(files));
    for (const required of [
      'index.js',
      'cli.js',
      'tools.js',
      'bridge-core.js',
      'rust-broker-client.js',
      'timeouts.js',
      'config.js',
      'auth.js',
      'session-registry.js',
      'tab-ownership.js',
      'batch-refs.js',
      'download-ledger.mjs',
      'ensure-rust-broker.mjs',
      'check-rust-broker.mjs',
      'launch-mcp.sh',
    ]) {
      assert.ok(files.includes(required), `files allowlist is missing ${required}`);
    }
    assert.ok(!files.includes('ahrefs-export.js'));
    for (const entry of files) {
      assert.doesNotMatch(entry, /^(capture-|export-|benchmark-|demo-)|smoke/);
    }
  });
});

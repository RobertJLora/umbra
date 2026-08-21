import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RETIRED_BROKER_SOCKET_PATH,
  describeSocketPathProblem,
  ensureBrokerSocketAlias,
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

  it('treats the retired /tmp socket as unset instead of binding a second broker', () => {
    withEnv({ UMBRA_BROKER_SOCKET: RETIRED_BROKER_SOCKET_PATH }, () => {
      assert.equal(
        resolveBrokerSocketPath(),
        path.join(os.homedir(), '.umbra', 'run', 'broker.sock'),
      );
    });
    withEnv({ UMBRA_BROKER_SOCKET: '  /tmp/umbra-rust-broker.sock  ' }, () => {
      assert.equal(
        resolveBrokerSocketPath(),
        path.join(os.homedir(), '.umbra', 'run', 'broker.sock'),
      );
    });
  });

  it('replaces a leftover retired path with a symlink to the live socket', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-alias-'));
    const live = path.join(dir, 'run', 'broker.sock');
    const retired = path.join(dir, 'retired.sock');
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, '');
    fs.writeFileSync(retired, 'stale');
    try {
      const result = ensureBrokerSocketAlias(retired, live);
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'alias');
      assert.equal(fs.readlinkSync(retired), live);
      const again = ensureBrokerSocketAlias(retired, live);
      assert.equal(again.ok, true);
      assert.equal(fs.readlinkSync(retired), live);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Personal-identity scanning is repo-wide and lives in the release check.
  // This case covers only the hardcoded absolute paths these two modules exist
  // to replace. The retired socket is named so leftover shims can be aliased;
  // the live default still cannot resolve under /tmp.
  it('ships no hardcoded home path and no world-writable live socket path', () => {
    assert.doesNotMatch(configSource, /\/Users\//);
    assert.match(configSource, /RETIRED_BROKER_SOCKET_PATH/);
    assert.doesNotMatch(timeoutsSource, /\/Users\//);
    assert.doesNotMatch(timeoutsSource, /\/tmp\/umbra/);
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

  it('allowlists the runtime files and nothing from the local-only plugins folder', () => {
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
      'fs-guard.js',
      'loopback-host.js',
      'auth.js',
      'session-registry.js',
      'tab-ownership.js',
      'batch-refs.js',
      'download-ledger.mjs',
      'ensure-rust-broker.mjs',
      'check-rust-broker.mjs',
      'launch-mcp.sh',
      'plugins-loader.mjs',
    ]) {
      assert.ok(files.includes(required), `files allowlist is missing ${required}`);
    }
    // The loader ships. What it loads never does: plugins/ is local-only, and
    // an allowlist entry naming it would put an unpublished path in the package.
    for (const entry of files) {
      assert.doesNotMatch(entry, /^plugins\//, `${entry} would publish a local-only plugin`);
    }
    for (const entry of files) {
      assert.doesNotMatch(entry, /^(capture-|export-|benchmark-|demo-)|smoke/);
    }
  });
});

describe('portable path resolution', () => {
  it('a tilde in a path variable expands instead of becoming a directory named "~"', () => {
    const home = os.homedir();
    withEnv({ UMBRA_SHARED_KEY_FILE: '~/.umbra/shared-key' }, () => {
      assert.equal(resolveSharedKeyPath(), path.join(home, '.umbra', 'shared-key'));
    });
    withEnv({ UMBRA_DOWNLOAD_DIR: '~/Downloads' }, () => {
      assert.equal(resolveDownloadDir(), path.join(home, 'Downloads'));
    });
    withEnv({ UMBRA_BROKER_SOCKET: '  ~/.umbra/run/broker.sock  ' }, () => {
      assert.equal(resolveBrokerSocketPath(), path.join(home, '.umbra', 'run', 'broker.sock'));
    });
    // A relative value resolves to absolute, so no resolver depends on the working
    // directory the MCP client happened to launch with.
    withEnv({ UMBRA_BROKER_SOCKET: 'run/broker.sock' }, () => {
      assert.equal(path.isAbsolute(resolveBrokerSocketPath()), true);
    });
    });

  it('a socket path the kernel cannot bind is reported by length, not as a bare bind failure', () => {
    assert.equal(describeSocketPathProblem('/tmp/short.sock'), '');
    const tooLong = `/tmp/${'p'.repeat(120)}.sock`;
    assert.match(describeSocketPathProblem(tooLong), /over the 103-byte limit/);
    });
});

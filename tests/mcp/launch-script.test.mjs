import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const launchScript = path.join(repoRoot, 'mcp-server', 'launch-mcp.sh');
const ensureScript = path.join(repoRoot, 'mcp-server', 'ensure-rust-broker.mjs');
const checkScript = path.join(repoRoot, 'mcp-server', 'check-rust-broker.mjs');

function runNode(scriptPath, env) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      { env: { ...process.env, ...env }, timeout: 10_000 },
      () => {},
    );
    child.on('close', (code) => resolve(code));
  });
}

describe('launch-mcp.sh', () => {
  it('execs the MCP server directly after startup preflight', () => {
    const source = fs.readFileSync(launchScript, 'utf8');

    assert.match(source, /has_free_bridge_port\(\)/);
    assert.match(source, /free_bridge_port_count\(\)/);
    assert.match(source, /cleanup-listeners\.mjs/);
    assert.match(source, /--only-disconnected/);
    assert.match(source, /exec node "\$SERVER"/);
    assert.doesNotMatch(source, /node "\$SERVER" 2> >\(tee/);
    assert.doesNotMatch(source, /ERR_FILE/);
    assert.doesNotMatch(source, /kill "\$pid"/);
  });

  it('full suite stops a bridge when authentication times out before session tracking', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'full-suite-runner.mjs'), 'utf8');

    assert.match(source, /if \(context\.options\.brokerMode === 'rust'\)/);
    assert.match(source, /port = await bridge\.start\(\);/);
    assert.match(source, /catch \(error\) \{\n    await bridge\?\.stop\?\.\(\)\.catch\(\(\) => \{\}\);/);
    assert.match(source, /context\.brokerRuntime\?\.stop\?\.\(\)\.catch\(\(\) => \{\}\);/);
    assert.match(source, /newListeners = after\.filter/);
    assert.doesNotMatch(source, /listener\.port !== 47821/);
  });

  it('MCP server closes session tabs on clean shutdown unless keep-open is requested', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'index.js'), 'utf8');

    assert.match(source, /UMBRA_KEEP_TABS_OPEN/);
    assert.match(source, /UMBRA_CLOSE_ON_SHUTDOWN/);
    assert.match(source, /bridge\.sendCommand\('browser_close_session_tabs', \{\}\)/);
    assert.match(source, /UMBRA_SHUTDOWN_CLOSE_TIMEOUT_MS/);
  });

  it('starts the Rust broker by default and can fall back to legacy when allowed', () => {
    const source = fs.readFileSync(launchScript, 'utf8');
    const index = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'index.js'), 'utf8');

    assert.match(source, /BROKER_MODE="\$\{UMBRA_BROKER_MODE:-rust\}"/);
    assert.match(source, /BROKER_LOCK_DIR/);
    assert.match(source, /rust_broker_needs_build/);
    assert.match(source, /-newer "\$RUST_BROKER_BIN"/);
    assert.match(source, /start_rust_broker_once/);
    assert.match(source, /check-rust-broker\.mjs/);
    assert.match(source, /ensure-rust-broker\.mjs/);
    assert.match(source, /build --quiet --release --manifest-path/);
    assert.match(source, /UMBRA_MCP_SHIM_MODE="rust"/);
    assert.match(source, /UMBRA_BROKER_REQUIRED/);
    assert.match(index, /RustBrokerClient/);
    assert.match(index, /UMBRA_MCP_SHIM_MODE === 'rust'/);
  });

  it('probes for cargo in more than one location and falls back instead of failing', () => {
    const source = fs.readFileSync(launchScript, 'utf8');

    assert.match(source, /resolve_cargo_bin\(\)/);
    assert.match(source, /command -v cargo/);
    assert.match(source, /\$HOME\/\.cargo\/bin\/cargo/);
    assert.match(source, /falling back to the legacy bridge/);
    // The bare invocation resolved only against a login PATH, which does not
    // carry $HOME/.cargo/bin on most machines.
    assert.doesNotMatch(source, /! cargo build/);
    assert.doesNotMatch(source, /^\s*cargo build/m);
  });

  it('documents the portable environment overrides, including the download directory', () => {
    const source = fs.readFileSync(launchScript, 'utf8');

    assert.match(source, /UMBRA_DOWNLOAD_DIR/);
    assert.match(source, /\$HOME\/Downloads/);
    assert.match(source, /UMBRA_BROKER_SOCKET/);
    assert.match(source, /UMBRA_BROKER_LAUNCHD_LABEL/);
    assert.match(source, /UMBRA_SHARED_KEY_FILE/);
  });

  it('keeps broker lifecycle state out of world-writable /tmp', () => {
    for (const file of [launchScript, ensureScript, checkScript]) {
      const source = fs.readFileSync(file, 'utf8');
      assert.ok(!source.includes('/tmp/umbra'), `${path.basename(file)} still points at /tmp`);
    }
  });

  it('resolves broker lifecycle paths through config.js and names no author', () => {
    const ensureSource = fs.readFileSync(ensureScript, 'utf8');
    const checkSource = fs.readFileSync(checkScript, 'utf8');

    for (const source of [ensureSource, checkSource]) {
      assert.doesNotMatch(source, /robert/i);
      assert.doesNotMatch(source, /\/Users\/[A-Za-z]/);
      assert.match(source, /from '\.\/config\.js'/);
      assert.match(source, /resolveBrokerSocketPath\(\)/);
    }

    assert.match(ensureSource, /resolveLaunchdLabel\(\)/);
    assert.doesNotMatch(ensureSource, /com\.robertlora/i);
  });

  it('pins the socket path for a broker it spawns itself', () => {
    const ensureSource = fs.readFileSync(ensureScript, 'utf8');

    // Without this the spawned broker binds whatever default it was compiled
    // with, and the health probe here waits out its full timeout against a
    // socket nothing ever created.
    assert.match(ensureSource, /UMBRA_BROKER_SOCKET: socketPath/);
    assert.match(ensureSource, /ensureDirectory\(path\.dirname\(logPath\)\)/);
  });

  it('check-rust-broker honours UMBRA_BROKER_SOCKET end to end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-check-'));
    const socketPath = path.join(dir, 'b.sock');
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write(`${JSON.stringify({ type: 'health', ok: true })}\n`);
      });
    });

    try {
      await new Promise((resolve) => server.listen(socketPath, resolve));
      const healthy = await runNode(checkScript, { UMBRA_BROKER_SOCKET: socketPath });
      assert.equal(healthy, 0);

      const missing = await runNode(checkScript, {
        UMBRA_BROKER_SOCKET: path.join(dir, 'absent.sock'),
        UMBRA_BROKER_CHECK_TIMEOUT_MS: '400',
      });
      assert.equal(missing, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test cleanup no longer kills connected agent bridge listeners by default', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp-server', 'package.json'), 'utf8'));

    assert.match(packageJson.scripts['cleanup:test'], /--only-disconnected/);
    assert.ok(packageJson.scripts['cleanup:test:force']);
  });
});

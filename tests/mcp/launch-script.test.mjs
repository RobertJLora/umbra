import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const launchScript = path.join(repoRoot, 'mcp-server', 'launch-mcp.sh');

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
    assert.match(source, /cargo build --quiet --release --manifest-path/);
    assert.match(source, /UMBRA_MCP_SHIM_MODE="rust"/);
    assert.match(source, /UMBRA_BROKER_REQUIRED/);
    assert.match(index, /RustBrokerClient/);
    assert.match(index, /UMBRA_MCP_SHIM_MODE === 'rust'/);
  });

  it('test cleanup no longer kills connected agent bridge listeners by default', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp-server', 'package.json'), 'utf8'));

    assert.match(packageJson.scripts['cleanup:test'], /--only-disconnected/);
    assert.ok(packageJson.scripts['cleanup:test:force']);
  });
});

import process from 'node:process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createSessionId } from './auth.js';
import { RustBrokerClient } from './rust-broker-client.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustManifest = path.join(repoRoot, 'rust-broker', 'Cargo.toml');

function loadSharedKey() {
  const directKey = process.env.UMBRA_SHARED_KEY?.trim();
  if (directKey) {
    return directKey;
  }

  const keyFile = process.env.UMBRA_SHARED_KEY_FILE;
  if (keyFile) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }

  return '';
}

const SHARED_KEY = loadSharedKey();
if (!SHARED_KEY) {
  console.error('Missing UMBRA_SHARED_KEY or UMBRA_SHARED_KEY_FILE');
  process.exit(1);
}

const portStart = Number(process.env.UMBRA_RUST_SMOKE_PORT_START || 47849);
const portEnd = Number(process.env.UMBRA_RUST_SMOKE_PORT_END || 47852);
const timeoutMs = Number(process.env.UMBRA_SMOKE_TIMEOUT_MS || 30000);
const socketPath = process.env.UMBRA_BROKER_SOCKET
  || `/tmp/umbra-rust-smoke-${process.pid}.sock`;
const sessionId = createSessionId();
const groupTitle = `Codex Rust Smoke ${process.pid}`;

function assertSmoke(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function startFixtureServer() {
  const pages = {
    '/initial': {
      title: 'Codex Rust Broker Smoke Initial',
      body: 'Rust broker smoke initial page loaded.',
    },
    '/navigated': {
      title: 'Codex Rust Broker Smoke Navigated',
      body: 'Rust broker smoke body text OK after navigation.',
    },
  };

  const server = http.createServer((request, response) => {
    const page = pages[new URL(request.url, 'http://127.0.0.1').pathname] ?? pages['/initial'];
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${page.title}</title></head>
  <body>
    <main>
      <h1>${page.title}</h1>
      <p id="smoke-body">${page.body}</p>
    </main>
  </body>
</html>`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

function startRustBroker() {
  fs.rmSync(socketPath, { force: true });
  const child = spawn('cargo', ['run', '--quiet', '--manifest-path', rustManifest], {
    env: {
      ...process.env,
      UMBRA_SHARED_KEY: SHARED_KEY,
      UMBRA_PORT_START: String(portStart),
      UMBRA_PORT_END: String(portEnd),
      UMBRA_BROKER_SOCKET: socketPath,
      UMBRA_BROKER_SESSION_ID: `rust_broker_smoke_${process.pid}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout.on('data', () => {});
  return {
    child,
    getStderr: () => stderr,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          delay(1500).then(() => child.kill('SIGKILL')),
        ]);
      }
      fs.rmSync(socketPath, { force: true });
    },
  };
}

async function connectClient() {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    const client = new RustBrokerClient({
      sessionId,
      socketPath,
      requestTimeoutMs: 15000,
    });
    try {
      await client.start();
      return client;
    } catch (error) {
      lastError = error;
      await client.stop().catch(() => {});
      await delay(250);
    }
  }
  throw lastError || new Error('Timed out waiting for Rust broker shim socket.');
}

async function waitForExtension(client) {
  const startedAt = Date.now();
  let health = null;
  while (Date.now() - startedAt < timeoutMs) {
    health = await client.health();
    if (health?.extension_connected === true) {
      return health;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for extension to connect to Rust broker. Last health: ${JSON.stringify(health)}`);
}

let fixture = null;
let client = null;
let broker = null;

try {
  broker = startRustBroker();
  client = await connectClient();
  const health = await waitForExtension(client);
  console.error(`[rust-smoke] extension connected through Rust broker on port ${health.listener?.port}`);
  fixture = await startFixtureServer();
  console.error(`[rust-smoke] fixture listening on ${fixture.baseUrl}`);

  const created = await client.sendCommand('browser_create_tab', {
    url: `${fixture.baseUrl}/initial`,
    activate: false,
    groupTitle,
    groupColor: 'cyan',
    groupCollapsed: true,
  });
  const tabId = created.tabId;
  assertSmoke(Number.isInteger(tabId), 'Rust broker create_tab did not return a tabId.');

  const navigated = await client.sendCommand('browser_navigate', {
    tabId,
    url: `${fixture.baseUrl}/navigated`,
    activate: false,
  });
  assertSmoke(navigated.title === 'Codex Rust Broker Smoke Navigated', 'Rust broker navigation did not reach fixture.');

  const page = await client.sendCommand('browser_get_page_content', {
    tabId,
    format: 'text',
    selector: 'main',
    maxChars: 2000,
  });
  assertSmoke(page.content.includes('Rust broker smoke body text OK'), 'Rust broker page read missed fixture text.');

  const tabs = await client.sendCommand('browser_list_tabs', {});
  assertSmoke(tabs.tabs.length === 1, 'Rust broker session should own exactly one test tab.');

  const closed = await client.sendCommand('browser_close_session_tabs', {});
  assertSmoke(closed.closedTabCount === 1, 'Rust broker close_session_tabs did not close the owned tab.');

  const finalHealth = await client.health();
  console.log(JSON.stringify({
    ok: true,
    rustBroker: true,
    sessionId,
    brokerPort: health.listener?.port,
    created: {
      tabId,
      title: created.title,
      url: created.url,
    },
    navigated: {
      title: navigated.title,
      url: navigated.url,
    },
    read: {
      title: page.title,
      contentIncludesFixture: page.content.includes('Rust broker smoke body text OK'),
    },
    closed: {
      closedTabCount: closed.closedTabCount,
      closedWindowCount: closed.closedWindowCount,
    },
    pressure: finalHealth.pressure,
  }, null, 2));
} catch (error) {
  console.error(`[rust-smoke] Error: ${error?.stack || error?.message || error}`);
  if (broker?.getStderr) {
    const stderr = broker.getStderr();
    if (stderr) {
      console.error(`[rust-smoke] broker stderr:\n${stderr}`);
    }
  }
  process.exitCode = 1;
} finally {
  if (client) {
    await client.stop().catch(() => {});
  }
  if (fixture) {
    await fixture.close().catch(() => {});
  }
  if (broker) {
    await broker.stop().catch(() => {});
  }
}

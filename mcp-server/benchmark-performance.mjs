import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionId } from './auth.js';
import { LocalBridgeServer } from './bridge-core.js';
import { RustBrokerClient } from './rust-broker-client.js';
import { resolveBrokerSocketPath, resolveSharedKeyPath } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(__dirname, '..');
const REPORTS_ROOT = path.join(BRIDGE_ROOT, 'reports', 'performance');
const RUST_MANIFEST = path.join(BRIDGE_ROOT, 'rust-broker', 'Cargo.toml');
const RUST_RELEASE_BINARY = path.join(BRIDGE_ROOT, 'rust-broker', 'target', 'release', 'umbra-rust-broker');
const DEFAULT_SHARED_KEY_FILE = resolveSharedKeyPath();
const DEFAULT_PORT_START = 47829;
const DEFAULT_PORT_END = 47852;
const DEFAULT_TIMEOUT_MS = 45_000;

function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function parseArgs(argv) {
  const options = {
    runs: Number(process.env.UMBRA_BENCH_RUNS || 2),
    tabs: Number(process.env.UMBRA_BENCH_TABS || 4),
    largeKb: Number(process.env.UMBRA_BENCH_LARGE_KB || 128),
    portStart: Number(process.env.UMBRA_BENCH_PORT_START || DEFAULT_PORT_START),
    portEnd: Number(process.env.UMBRA_BENCH_PORT_END || DEFAULT_PORT_END),
    timeoutMs: Number(process.env.UMBRA_BENCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    reportDir: '',
    keepTabsOpen: process.env.UMBRA_BENCH_KEEP_TABS_OPEN === '1',
    brokerMode: process.env.UMBRA_BROKER_MODE === 'rust' ? 'rust' : 'legacy',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runs') {
      options.runs = Number(argv[++index]);
    } else if (arg.startsWith('--runs=')) {
      options.runs = Number(arg.slice('--runs='.length));
    } else if (arg === '--tabs') {
      options.tabs = Number(argv[++index]);
    } else if (arg.startsWith('--tabs=')) {
      options.tabs = Number(arg.slice('--tabs='.length));
    } else if (arg === '--large-kb') {
      options.largeKb = Number(argv[++index]);
    } else if (arg.startsWith('--large-kb=')) {
      options.largeKb = Number(arg.slice('--large-kb='.length));
    } else if (arg === '--port-start') {
      options.portStart = Number(argv[++index]);
    } else if (arg.startsWith('--port-start=')) {
      options.portStart = Number(arg.slice('--port-start='.length));
    } else if (arg === '--port-end') {
      options.portEnd = Number(argv[++index]);
    } else if (arg.startsWith('--port-end=')) {
      options.portEnd = Number(arg.slice('--port-end='.length));
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index]);
    } else if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    } else if (arg === '--report-dir') {
      options.reportDir = argv[++index];
    } else if (arg.startsWith('--report-dir=')) {
      options.reportDir = arg.slice('--report-dir='.length);
    } else if (arg === '--keep-tabs-open') {
      options.keepTabsOpen = true;
    } else if (arg === '--broker-mode') {
      options.brokerMode = argv[++index];
    } else if (arg.startsWith('--broker-mode=')) {
      options.brokerMode = arg.slice('--broker-mode='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error(`Invalid --runs value: ${options.runs}`);
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 1) {
    throw new Error(`Invalid --tabs value: ${options.tabs}`);
  }

  if (!Number.isFinite(options.largeKb) || options.largeKb < 1) {
    throw new Error(`Invalid --large-kb value: ${options.largeKb}`);
  }

  if (!Number.isFinite(options.portStart) || !Number.isFinite(options.portEnd) || options.portStart > options.portEnd) {
    throw new Error(`Invalid port range: ${options.portStart}-${options.portEnd}`);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }

  options.runs = Math.floor(options.runs);
  options.tabs = Math.floor(options.tabs);
  options.largeKb = Math.floor(options.largeKb);
  if (!['legacy', 'rust'].includes(options.brokerMode)) {
    throw new Error(`Invalid --broker-mode value: ${options.brokerMode}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run bench -- [options]

Runs a local, non-account-auth CiC performance benchmark against fixture pages.

Options:
  --runs <n>          Iterations per scenario. Default: 2
  --tabs <n>          Tabs for the multi-tab scenario. Default: 4
  --large-kb <n>      Approximate large payload size. Default: 128
  --port-start <n>    Bridge port range start. Default: 47829
  --port-end <n>      Bridge port range end. Default: 47852
  --timeout-ms <n>    Extension wait/request timeout. Default: 45000
  --report-dir <dir>  Output directory. Default: reports/performance/performance-<stamp>
  --broker-mode <m>   legacy or rust. Default: legacy
  --keep-tabs-open    Leave benchmark tabs open for inspection.
`);
}

function loadSharedKey() {
  const directKey = process.env.UMBRA_SHARED_KEY?.trim();
  if (directKey) {
    return directKey;
  }

  const keyFile = process.env.UMBRA_SHARED_KEY_FILE || DEFAULT_SHARED_KEY_FILE;
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }

  return '';
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function makeRepeatedText(targetKb) {
  const line = 'Umbra benchmark fixture text for payload measurement and rendered DOM reads. ';
  const targetBytes = targetKb * 1024;
  let text = '';
  while (Buffer.byteLength(text, 'utf8') < targetBytes) {
    text += line;
  }
  return text;
}

function pageHtml(url, options) {
  const pathname = url.pathname;
  const title = {
    '/small': 'CiC Bench Small Fixture',
    '/medium': 'CiC Bench Medium Fixture',
    '/large': 'CiC Bench Large Fixture',
    '/seo': 'CiC Bench Technical Fixture',
    '/export': 'CiC Bench Export Fixture',
  }[pathname] || 'CiC Bench Fixture';

  if (pathname === '/large') {
    const targetKb = Number(url.searchParams.get('kb') || options.largeKb);
    const repeated = makeRepeatedText(targetKb);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p id="payload">${repeated}</p>
    </main>
  </body>
</html>`;
  }

  if (pathname === '/seo') {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <meta name="description" content="Local benchmark technical snapshot fixture">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${options.baseUrl}/seo">
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"WebPage","name":"CiC Bench Technical Fixture"}
    </script>
  </head>
  <body>
    <header><a href="/small">Small</a><a href="/medium">Medium</a></header>
    <main>
      <h1>${title}</h1>
      <h2>Snapshot Inputs</h2>
      <p id="seo-body">Rendered technical snapshot fixture.</p>
      <img src="/assets/pixel.png" width="1" height="1" alt="Benchmark pixel">
    </main>
  </body>
</html>`;
  }

  if (pathname === '/export') {
    const rows = Array.from({ length: 80 }, (_, index) => (
      `<tr><td>keyword-${index + 1}</td><td>${index + 10}</td><td>${index % 7}</td></tr>`
    )).join('');
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <button id="export-button" type="button">Generate Export</button>
      <p id="export-status">waiting</p>
      <table id="export-table">
        <thead><tr><th>Keyword</th><th>Clicks</th><th>Rank</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>
    <script>
      document.querySelector('#export-button').addEventListener('click', () => {
        document.querySelector('#export-status').textContent = 'export ready';
        document.body.dataset.exportReady = 'true';
      });
    </script>
  </body>
</html>`;
  }

  const rows = Array.from({ length: pathname === '/medium' ? 24 : 4 }, (_, index) => (
    `<li><a href="/medium?row=${index + 1}">Fixture link ${index + 1}</a></li>`
  )).join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p id="bench-body">Local fixture page for CiC benchmark iteration ${url.searchParams.get('iteration') || '0'}.</p>
      <p id="status">idle</p>
      <ul>${rows}</ul>
      <button id="ready-button" type="button">Ready</button>
    </main>
    <script>
      document.querySelector('#ready-button').addEventListener('click', () => {
        document.querySelector('#status').textContent = 'clicked';
      });
    </script>
  </body>
</html>`;
}

async function startFixtureServer(options) {
  const stats = {
    requests: 0,
    responseBytes: 0,
    paths: {},
  };

  let baseUrl = '';
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=',
    'base64',
  );

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    stats.requests += 1;
    stats.paths[url.pathname] = (stats.paths[url.pathname] || 0) + 1;

    if (url.pathname === '/assets/pixel.png') {
      stats.responseBytes += pixel.length;
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': pixel.length,
        'cache-control': 'no-store',
      });
      response.end(pixel);
      return;
    }

    const body = pageHtml(url, { ...options, baseUrl });
    const bytes = Buffer.byteLength(body, 'utf8');
    stats.responseBytes += bytes;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': bytes,
      'cache-control': 'no-store',
    });
    response.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    stats,
    snapshotStats: () => ({
      requests: stats.requests,
      responseBytes: stats.responseBytes,
      paths: { ...stats.paths },
    }),
    close: () => closeServer(server),
  };
}

function waitForAuthenticatedBridge(bridge, label, timeoutMs) {
  if (typeof bridge.health === 'function') {
    return waitForRustBrokerExtension(bridge, label, timeoutMs);
  }

  if (bridge.registry.isConnected()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for ${label} authentication.`));
    }, timeoutMs);

    const onAuth = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      bridge.registry.off('authenticated', onAuth);
    };

    bridge.registry.on('authenticated', onAuth);
  });
}

async function waitForRustBrokerExtension(bridge, label, timeoutMs) {
  const startedAt = Date.now();
  let health = null;
  while (Date.now() - startedAt < timeoutMs) {
    health = await bridge.health();
    if (health?.extension_connected === true) {
      return health;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for ${label} Rust broker extension connection. Last health: ${JSON.stringify(health)}`);
}

function startRustBrokerRuntime({ sharedKey, options, runId }) {
  // The benchmark starts its own throwaway broker, so it needs a socket of its
  // own: pointing it at the real one would make the run fight the broker the
  // user's sessions are already using. Keep it beside the real socket in the
  // per-user run directory rather than in world-writable /tmp, where another
  // local account can pre-create the path and block startup.
  const socketPath = process.env.UMBRA_BROKER_SOCKET
    || path.join(path.dirname(resolveBrokerSocketPath()), `bench-${process.pid}-${runId}.sock`);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });

  const command = fs.existsSync(RUST_RELEASE_BINARY) ? RUST_RELEASE_BINARY : 'cargo';
  const args = command === 'cargo'
    ? ['run', '--quiet', '--manifest-path', RUST_MANIFEST]
    : [];

  const child = spawn(command, args, {
    env: {
      ...process.env,
      UMBRA_SHARED_KEY: sharedKey,
      UMBRA_PORT_START: String(options.portStart),
      UMBRA_PORT_END: String(options.portEnd),
      UMBRA_REQUEST_TIMEOUT_MS: String(options.timeoutMs),
      UMBRA_BROKER_SOCKET: socketPath,
      UMBRA_BROKER_SESSION_ID: `rust_broker_bench_${process.pid}_${runId}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });

  return {
    child,
    socketPath,
    command,
    getStdout: () => stdout,
    getStderr: () => stderr,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          delay(1500).then(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }),
        ]);
      }
      fs.rmSync(socketPath, { force: true });
    },
  };
}

async function connectRustBrokerClient({ sessionId, socketPath, timeoutMs }) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    const client = new RustBrokerClient({
      sessionId,
      socketPath,
      requestTimeoutMs: timeoutMs,
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

async function startBenchmarkBridge(context) {
  if (context.options.brokerMode === 'rust') {
    context.brokerRuntime = startRustBrokerRuntime({
      sharedKey: context.sharedKey,
      options: context.options,
      runId: context.runId,
    });
    context.bridge = await connectRustBrokerClient({
      sessionId: context.sessionId,
      socketPath: context.brokerRuntime.socketPath,
      timeoutMs: context.options.timeoutMs,
    });
    return context.bridge.health();
  }

  context.bridge = new LocalBridgeServer({
    sharedKey: context.sharedKey,
    sessionId: context.sessionId,
    portStart: context.options.portStart,
    portEnd: context.options.portEnd,
    requestTimeoutMs: context.options.timeoutMs,
  });
  context.port = await context.bridge.start();
  return null;
}

async function stopBenchmarkBridge(context) {
  await context.bridge?.stop?.().catch(() => {});
  await context.brokerRuntime?.stop?.().catch(() => {});
}

function bridgeIsConnected(bridge) {
  if (!bridge) {
    return false;
  }
  if (typeof bridge.isConnected === 'function') {
    return bridge.isConnected();
  }
  return bridge.registry?.isConnected?.() === true;
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function parsePs(output) {
  const rows = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPct: Number(match[3]),
      rssKb: Number(match[4]),
      command: match[5],
    });
  }
  return rows;
}

function isGoogleChromeProcess(row) {
  const command = row.command || '';
  return (
    command.includes('/Google Chrome.app/') ||
    command.includes('/Google Chrome for Testing.app/') ||
    command.includes('/Chromium.app/') ||
    /\bGoogle Chrome( Helper)?\b/.test(command) ||
    /\bChrome for Testing( Helper)?\b/.test(command) ||
    /\bChromium( Helper)?\b/.test(command)
  );
}

function isCodexProcess(row) {
  const command = row.command || '';
  return /Codex|OpenAI|ChatGPT/.test(command) && !isGoogleChromeProcess(row);
}

function isRustBrokerProcess(row) {
  return /umbra-rust-broker/.test(row.command || '');
}

function summarizeProcesses(rows) {
  const chromeRows = rows.filter(isGoogleChromeProcess);
  const codexRows = rows.filter(isCodexProcess);
  const nodeRows = rows.filter((row) => row.pid === process.pid || /benchmark-performance\.mjs/.test(row.command));
  const rustRows = rows.filter(isRustBrokerProcess);

  const totalsFor = (items) => ({
    count: items.length,
    cpuPct: round(items.reduce((sum, row) => sum + row.cpuPct, 0), 2),
    rssKb: items.reduce((sum, row) => sum + row.rssKb, 0),
    rssMb: round(items.reduce((sum, row) => sum + row.rssKb, 0) / 1024, 1),
  });

  return {
    chrome: {
      ...totalsFor(chromeRows),
      top: chromeRows
        .toSorted((left, right) => right.rssKb - left.rssKb)
        .slice(0, 8)
        .map((row) => ({
          pid: row.pid,
          cpuPct: row.cpuPct,
          rssMb: round(row.rssKb / 1024, 1),
          command: row.command.slice(0, 220),
        })),
    },
    codexApp: {
      ...totalsFor(codexRows),
      top: codexRows
        .toSorted((left, right) => right.rssKb - left.rssKb)
        .slice(0, 8)
        .map((row) => ({
          pid: row.pid,
          cpuPct: row.cpuPct,
          rssMb: round(row.rssKb / 1024, 1),
          command: row.command.slice(0, 220),
        })),
    },
    benchmarkNode: {
      ...totalsFor(nodeRows),
      processes: nodeRows.map((row) => ({
        pid: row.pid,
        cpuPct: row.cpuPct,
        rssMb: round(row.rssKb / 1024, 1),
        command: row.command.slice(0, 220),
      })),
    },
    rustBroker: {
      ...totalsFor(rustRows),
      processes: rustRows.map((row) => ({
        pid: row.pid,
        cpuPct: row.cpuPct,
        rssMb: round(row.rssKb / 1024, 1),
        command: row.command.slice(0, 220),
      })),
    },
  };
}

async function sampleProcesses(label, samples) {
  const sampledAt = new Date().toISOString();
  try {
    const output = await execFilePromise('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command=']);
    const rows = parsePs(output);
    const sample = {
      label,
      sampledAt,
      method: 'ps -axo pid,ppid,pcpu,rss,command',
      ...summarizeProcesses(rows),
    };
    samples.push(sample);
    return sample;
  } catch (error) {
    const sample = {
      label,
      sampledAt,
      method: 'ps -axo pid,ppid,pcpu,rss,command',
      error: error?.message || String(error),
    };
    samples.push(sample);
    return sample;
  }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function makeMeasuredSender({ bridge, commands, scenario }) {
  return async function sendMeasured(tool, params = {}, extra = {}) {
    const approxRequest = { type: 'command', id: 'req_benchmark_sample', tool, params };
    const requestBytes = byteLength(approxRequest);
    const started = performance.now();
    try {
      const result = await bridge.sendCommand(tool, params);
      const elapsedMs = performance.now() - started;
      const responseBytes = byteLength(result);
      const entry = {
        scenario,
        iteration: extra.iteration ?? null,
        tool,
        status: 'pass',
        elapsedMs: round(elapsedMs, 2),
        requestBytes,
        responseBytes,
        totalBytes: requestBytes + responseBytes,
      };
      commands.push(entry);
      return result;
    } catch (error) {
      const elapsedMs = performance.now() - started;
      commands.push({
        scenario,
        iteration: extra.iteration ?? null,
        tool,
        status: 'fail',
        elapsedMs: round(elapsedMs, 2),
        requestBytes,
        responseBytes: 0,
        totalBytes: requestBytes,
        error: error?.message || String(error),
      });
      throw error;
    }
  };
}

function percentiles(values) {
  if (!values.length) {
    return { min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const pick = (percentile) => {
    const index = Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
  };

  return {
    min: round(sorted[0], 2),
    avg: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
    p50: round(pick(50), 2),
    p95: round(pick(95), 2),
    max: round(sorted[sorted.length - 1], 2),
  };
}

function commandCounts(commands) {
  return commands.reduce((counts, command) => {
    counts[command.tool] = (counts[command.tool] || 0) + 1;
    return counts;
  }, {});
}

function payloadSummary(commands) {
  return commands.reduce((summary, command) => {
    summary.requestBytes += command.requestBytes || 0;
    summary.responseBytes += command.responseBytes || 0;
    summary.totalBytes += command.totalBytes || 0;
    return summary;
  }, { requestBytes: 0, responseBytes: 0, totalBytes: 0 });
}

function diffFixtureStats(before, after) {
  const paths = {};
  const names = new Set([...Object.keys(before.paths || {}), ...Object.keys(after.paths || {})]);
  for (const name of names) {
    const delta = (after.paths?.[name] || 0) - (before.paths?.[name] || 0);
    if (delta !== 0) {
      paths[name] = delta;
    }
  }
  return {
    requests: after.requests - before.requests,
    responseBytes: after.responseBytes - before.responseBytes,
    paths,
  };
}

async function cleanupTabs({ send, groupTitle, keepTabsOpen }) {
  const before = await send('browser_list_tabs', {});
  let closeResult = null;
  if (!keepTabsOpen) {
    closeResult = await send('browser_close_session_tabs', {});
  }
  const after = await send('browser_list_tabs', {});
  const groupProbe = await send('browser_cleanup_groups', {
    title: groupTitle,
    dryRun: true,
    mode: 'closeTabs',
    includeConnected: true,
  });
  return {
    tabsBeforeCleanup: before.tabs?.length || 0,
    closeResult,
    tabsLeftOpen: after.tabs?.length || 0,
    matchedGroupsAfterCleanup: groupProbe.matchedGroupCount || 0,
  };
}

async function runScenario(context, scenario, fn) {
  const scenarioCommands = [];
  const send = makeMeasuredSender({
    bridge: context.bridge,
    commands: scenarioCommands,
    scenario: scenario.name,
  });
  const fixtureBefore = context.fixture.snapshotStats();
  const processBefore = await sampleProcesses(`${scenario.name}:before`, context.processSamples);
  const started = performance.now();
  let status = 'pass';
  let error = null;
  let extraMetrics = {};

  console.error(`[bench] scenario ${scenario.name}`);
  try {
    extraMetrics = await fn({
      ...context,
      send,
      groupTitle: `${context.groupTitle}: ${scenario.label}`,
    });
  } catch (caught) {
    status = 'fail';
    error = caught?.stack || caught?.message || String(caught);
  }

  let cleanup = null;
  try {
    cleanup = await cleanupTabs({
      send,
      groupTitle: `${context.groupTitle}: ${scenario.label}`,
      keepTabsOpen: context.options.keepTabsOpen,
    });
  } catch (caught) {
    status = 'fail';
    error = error || caught?.stack || caught?.message || String(caught);
  }

  const elapsedMs = performance.now() - started;
  const processAfter = await sampleProcesses(`${scenario.name}:after`, context.processSamples);
  const fixtureAfter = context.fixture.snapshotStats();
  const latencies = scenarioCommands.map((command) => command.elapsedMs);
  const result = {
    runId: context.runId,
    scenario: scenario.name,
    label: scenario.label,
    status,
    iterations: context.options.runs,
    elapsedMs: round(elapsedMs, 2),
    commandCount: scenarioCommands.length,
    commandCounts: commandCounts(scenarioCommands),
    latencyMs: percentiles(latencies),
    payloadBytes: payloadSummary(scenarioCommands),
    fixture: diffFixtureStats(fixtureBefore, fixtureAfter),
    tabs: cleanup,
    process: {
      before: {
        chrome: processBefore.chrome,
        codexApp: processBefore.codexApp,
        benchmarkNode: processBefore.benchmarkNode,
        rustBroker: processBefore.rustBroker,
      },
      after: {
        chrome: processAfter.chrome,
        codexApp: processAfter.codexApp,
        benchmarkNode: processAfter.benchmarkNode,
        rustBroker: processAfter.rustBroker,
      },
    },
    ...extraMetrics,
  };

  if (error) {
    result.error = error;
  }

  context.commands.push(...scenarioCommands);
  context.matrix.push(result);
  await appendJsonl(context.resultLog, result);
  await appendJsonl(context.commandLog, scenarioCommands);

  if (status === 'fail') {
    throw new Error(`${scenario.name} failed: ${error}`);
  }

  return result;
}

async function scenarioCreateRead({ fixture, options, send, groupTitle }) {
  const titles = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    const page = await send('browser_get_page_content', { tabId, format: 'text' }, { iteration });
    await send('browser_run_page_action', {
      tabId,
      action: 'element_positions',
      params: { headings: ['CiC Bench Small Fixture'] },
      timeoutMs: 5_000,
    }, { iteration });
    titles.push(page.title);
  }
  return { titles };
}

async function scenarioNavigateLoop({ fixture, options, send, groupTitle }) {
  const finalUrls = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    await send('browser_navigate', { tabId, url: `${fixture.baseUrl}/medium?iteration=${iteration}`, groupTitle }, { iteration });
    const navigated = await send('browser_navigate', { tabId, url: `${fixture.baseUrl}/small?iteration=${iteration}&round=2`, groupTitle }, { iteration });
    await send('browser_get_page_content', { tabId, format: 'text' }, { iteration });
    finalUrls.push(navigated.url);
  }
  return { finalUrls };
}

async function scenarioMultiTab({ fixture, options, send, groupTitle }) {
  const opened = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const createdTabs = [];
    for (let tabIndex = 0; tabIndex < options.tabs; tabIndex += 1) {
      const created = await send('browser_create_tab', {
        url: `${fixture.baseUrl}/medium?iteration=${iteration}&tab=${tabIndex}`,
        activate: false,
        groupTitle,
        groupColor: 'cyan',
        groupCollapsed: true,
      }, { iteration });
      createdTabs.push(created.tabId ?? created.id);
    }
    const listed = await send('browser_list_tabs', {}, { iteration });
    await Promise.all(createdTabs.map((tabId) => send('browser_get_page_content', { tabId, format: 'text' }, { iteration })));
    opened.push({
      iteration,
      requestedTabs: options.tabs,
      listedTabs: listed.tabs?.length || 0,
    });
  }
  return { opened };
}

async function scenarioLargePayload({ fixture, options, send, groupTitle }) {
  const responseSizes = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/large?iteration=${iteration}&kb=${options.largeKb}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    const html = await send('browser_get_page_content', { tabId, format: 'html' }, { iteration });
    const text = await send('browser_get_page_content', { tabId, format: 'text' }, { iteration });
    responseSizes.push({
      htmlBytes: byteLength(html),
      textBytes: byteLength(text),
    });
  }
  return { responseSizes };
}

async function scenarioTechnicalSnapshot({ fixture, options, send, groupTitle }) {
  const snapshots = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/seo?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    const snapshot = await send('browser_get_technical_snapshot', { tabId, includeHtml: false }, { iteration });
    snapshots.push({
      title: snapshot.title,
      headingCount: snapshot.headings?.length ?? snapshot.h1?.length ?? null,
      linkCount: snapshot.links?.length ?? null,
      imageCount: snapshot.images?.length ?? null,
    });
  }
  return { snapshots };
}

async function scenarioWaitLoop({ fixture, options, send, groupTitle }) {
  const waited = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    const result = await send('browser_wait', {
      tabId,
      selector: '#ready-button',
      visible: true,
      timeoutMs: 5_000,
    }, { iteration });
    waited.push({ iteration, tabId, ok: result.ok !== false });
  }
  return { waited };
}

async function scenarioScreenshot({ fixture, options, send, groupTitle }) {
  const screenshots = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    let screenshot = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt > 0) {
          await delay(500);
        }
        screenshot = await send('browser_screenshot', { tabId }, { iteration, attempt });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!screenshot) {
      throw lastError || new Error('Screenshot failed without an extension error.');
    }
    screenshots.push({
      iteration,
      tabId,
      bytes: typeof screenshot.data === 'string' ? screenshot.data.length : 0,
      activated: screenshot.activated === true,
    });
  }
  return { screenshots };
}

async function scenarioSeparateWorkflow({ fixture, options, send, groupTitle }) {
  const statuses = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    await send('browser_wait', { tabId, selector: '#ready-button', visible: true, timeoutMs: 5_000 }, { iteration });
    await send('browser_click', { tabId, selector: '#ready-button', activate: false }, { iteration });
    const status = await send('browser_get_page_content', {
      tabId,
      format: 'text',
      selector: '#status',
      maxChars: 200,
    }, { iteration });
    statuses.push(status.content);
  }
  return { statuses };
}

async function scenarioBatchWorkflow({ fixture, options, send, groupTitle }) {
  const batchResults = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const batch = await send('browser_batch', {
      timeoutMs: 10_000,
      calls: [
        {
          label: 'create',
          tool: 'browser_create_tab',
          params: {
            url: `${fixture.baseUrl}/small?iteration=${iteration}`,
            activate: false,
            groupTitle,
            groupColor: 'cyan',
            groupCollapsed: true,
          },
        },
        {
          label: 'wait-ready',
          tool: 'browser_wait',
          params: { tabId: { $ref: 'create.tabId' }, selector: '#ready-button', visible: true, timeoutMs: 5_000 },
        },
        {
          label: 'click-ready',
          tool: 'browser_click',
          params: { tabId: { $ref: 'create.tabId' }, selector: '#ready-button', activate: false },
        },
        {
          label: 'read-status',
          tool: 'browser_get_page_content',
          params: { tabId: { $ref: 'create.tabId' }, format: 'text', selector: '#status', maxChars: 200 },
        },
      ],
    }, { iteration });
    batchResults.push({
      iteration,
      ok: batch.ok,
      steps: batch.results?.length || 0,
      status: batch.results?.at(-1)?.result?.content || null,
    });
  }
  return { batchResults };
}

async function scenarioExportLike({ fixture, options, send, groupTitle }) {
  const exports = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/export?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    await send('browser_click', { tabId, selector: '#export-button', activate: false }, { iteration });
    const status = await send('browser_get_page_content', {
      tabId,
      format: 'text',
      selector: '#export-status',
      maxChars: 200,
    }, { iteration });
    const table = await send('browser_get_page_content', {
      tabId,
      format: 'text',
      selector: '#export-table',
      maxChars: 8_000,
    }, { iteration });
    exports.push({
      iteration,
      status: status.content,
      tableBytes: byteLength(table.content),
    });
  }
  return { exports };
}

async function scenarioReadInteractive({ fixture, options, send, groupTitle }) {
  const reads = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    const interactive = await send('browser_read_interactive', { tabId, maxItems: 20 }, { iteration });
    reads.push({ count: interactive.count, firstRef: interactive.controls?.[0]?.ref || null });
  }
  return { reads };
}

async function scenarioReadInteractiveRefClick({ fixture, options, send, groupTitle }) {
  const clicks = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    let interactive = await send('browser_read_interactive', { tabId, selector: '#ready-button', maxItems: 5 }, { iteration });
    let ref = interactive.controls?.[0]?.ref;
    let retriedStaleRef = false;
    try {
      await send('browser_click', { tabId, ref, selector: '#ready-button', activate: false }, { iteration });
    } catch (error) {
      const staleRefError =
        String(error?.code || '').includes('stale_interactive_ref') ||
        String(error?.message || '').includes('Stale interactive ref');
      if (!staleRefError) {
        throw error;
      }
      retriedStaleRef = true;
      interactive = await send('browser_read_interactive', { tabId, selector: '#ready-button', maxItems: 5 }, { iteration });
      ref = interactive.controls?.[0]?.ref;
      await send('browser_click', { tabId, ref, selector: '#ready-button', activate: false }, { iteration });
    }
    const status = await send('browser_get_page_content', { tabId, selector: '#status', maxChars: 200 }, { iteration });
    clicks.push({ ref, status: status.content, retriedStaleRef });
  }
  return { clicks };
}

async function scenarioRecipeWorkflow({ fixture, options, send, groupTitle }) {
  const recipes = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    const recipe = await send('browser_wait_click_read', {
      tabId,
      waitSelector: '#ready-button',
      clickSelector: '#ready-button',
      readSelector: '#status',
      maxChars: 200,
      timeoutMs: 10_000,
    }, { iteration });
    recipes.push({ ok: recipe.ok, steps: recipe.results?.length || 0 });
  }
  return { recipes };
}

async function scenarioCachedSecondRead({ fixture, options, send, groupTitle }) {
  const cached = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const tabId = created.tabId ?? created.id;
    await send('browser_get_page_content', { tabId, format: 'text', selector: 'main' }, { iteration, read: 1 });
    const second = await send('browser_get_page_content', { tabId, format: 'text', selector: 'main' }, { iteration, read: 2 });
    cached.push({ cacheHit: second.cache?.hit === true });
  }
  return { cached };
}

async function scenarioGroupFindAdoptOverhead({ fixture, options, send, groupTitle }) {
  const groups = [];
  for (let iteration = 0; iteration < options.runs; iteration += 1) {
    const created = await send('browser_create_tab', {
      url: `${fixture.baseUrl}/small?iteration=${iteration}`,
      activate: false,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: true,
    }, { iteration });
    const found = await send('browser_find_groups', { title: groupTitle, limit: 5 }, { iteration });
    groups.push({ tabId: created.tabId ?? created.id, groupCount: found.count });
  }
  return { groups };
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function appendJsonl(filePath, rows) {
  const values = Array.isArray(rows) ? rows : [rows];
  if (!values.length) {
    return;
  }
  await fsp.appendFile(filePath, `${values.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function escapeTable(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 500);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }
  if (bytes >= 1024 * 1024) {
    return `${round(bytes / (1024 * 1024), 2)} MB`;
  }
  if (bytes >= 1024) {
    return `${round(bytes / 1024, 1)} KB`;
  }
  return `${bytes} B`;
}

async function writeArtifacts(context, finalStatus) {
  const fixtureStats = context.fixture?.snapshotStats?.() || { requests: 0, responseBytes: 0, paths: {} };
  const summary = {
    status: finalStatus,
    scenarioCount: context.matrix.length,
    passCount: context.matrix.filter((row) => row.status === 'pass').length,
    failCount: context.matrix.filter((row) => row.status === 'fail').length,
    commandCount: context.commands.length,
    payloadBytes: payloadSummary(context.commands),
    tabsLeftOpen: context.matrix.reduce((sum, row) => sum + (row.tabs?.tabsLeftOpen || 0), 0),
    fixtureRequests: fixtureStats.requests,
    fixtureResponseBytes: fixtureStats.responseBytes,
  };

  const payload = {
    schemaVersion: 1,
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    benchmarkKind: 'local-http-fixture-no-account-auth',
    reportDir: context.reportDir,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      bridgeRoot: BRIDGE_ROOT,
      mcpServerDir: __dirname,
      psSampling: 'ps -axo pid,ppid,pcpu,rss,command',
    },
    options: context.options,
    bridge: {
      brokerMode: context.options.brokerMode,
      sessionId: context.sessionId,
      port: context.port,
      authElapsedMs: context.authElapsedMs,
      groupTitle: context.groupTitle,
      rustSocketPath: context.brokerRuntime?.socketPath || null,
      rustRuntimeCommand: context.brokerRuntime?.command || null,
    },
    fixture: {
      baseUrl: context.fixture?.baseUrl || null,
      stats: fixtureStats,
    },
    summary,
    matrix: context.matrix,
    commands: context.commands,
    processSamples: context.processSamples,
  };

  await fsp.writeFile(context.resultsJson, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.writeFile(context.processJson, `${JSON.stringify(context.processSamples, null, 2)}\n`, 'utf8');
  await fsp.writeFile(context.markdownPath, makeMarkdown(payload), 'utf8');
  return payload;
}

function makeMarkdown(payload) {
  const matrixRows = payload.matrix.map((row) => (
    `| ${row.scenario} | ${row.status} | ${row.iterations} | ${row.commandCount} | ${row.latencyMs.p50} | ${row.latencyMs.p95} | ${formatBytes(row.payloadBytes.totalBytes)} | ${row.tabs?.tabsLeftOpen ?? 0} | ${round(row.process?.after?.chrome?.cpuPct ?? 0, 2)} | ${row.process?.after?.chrome?.rssMb ?? 0} | ${round(row.process?.after?.rustBroker?.cpuPct ?? 0, 2)} | ${row.process?.after?.rustBroker?.rssMb ?? 0} |`
  ));
  const commandRows = Object.entries(commandCounts(payload.commands))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `| ${name} | ${count} |`);
  const failures = payload.matrix.filter((row) => row.status === 'fail');
  const failureRows = failures.length
    ? failures.map((row) => `| ${row.scenario} | ${escapeTable(row.error)} |`)
    : ['| - | None |'];

  return `# CiC Performance Benchmark

Generated: ${payload.generatedAt}

Report folder: \`${payload.reportDir}\`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | ${payload.summary.status} |
| Scenarios | ${payload.summary.scenarioCount} |
| Passed | ${payload.summary.passCount} |
| Failed | ${payload.summary.failCount} |
| Commands measured | ${payload.summary.commandCount} |
| Payload bytes measured | ${formatBytes(payload.summary.payloadBytes.totalBytes)} |
| Tabs left open | ${payload.summary.tabsLeftOpen} |
| Fixture requests | ${payload.summary.fixtureRequests} |
| Fixture response bytes | ${formatBytes(payload.summary.fixtureResponseBytes)} |
| Broker mode | ${payload.bridge.brokerMode} |
| Bridge auth latency | ${payload.bridge.authElapsedMs}ms |
| Bridge port | ${payload.bridge.port} |
| Rust broker socket | ${payload.bridge.rustSocketPath || '-'} |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${matrixRows.join('\n')}

## Command Counts

| Command | Count |
|---|---:|
${commandRows.join('\n')}

## Failures

| Scenario | Error |
|---|---|
${failureRows.join('\n')}

## Artifacts

- Results JSON: \`${payload.reportDir}/results.json\`
- Scenario JSONL: \`${payload.reportDir}/results.jsonl\`
- Command JSONL: \`${payload.reportDir}/commands.jsonl\`
- Process samples: \`${payload.reportDir}/process-samples.json\`
`;
}

function emptyProcessSummary() {
  return {
    chrome: { count: 0, cpuPct: 0, rssKb: 0, rssMb: 0, top: [] },
    codexApp: { count: 0, cpuPct: 0, rssKb: 0, rssMb: 0, top: [] },
    benchmarkNode: { count: 0, cpuPct: 0, rssKb: 0, rssMb: 0, processes: [] },
    rustBroker: { count: 0, cpuPct: 0, rssKb: 0, rssMb: 0, processes: [] },
  };
}

function makeFailureRow(context, { scenario, label, error, elapsedMs }) {
  const lastSample = context.processSamples.at(-1) || emptyProcessSummary();
  return {
    runId: context.runId,
    scenario,
    label,
    status: 'fail',
    iterations: 0,
    elapsedMs: round(elapsedMs, 2),
    commandCount: 0,
    commandCounts: {},
    latencyMs: percentiles([]),
    payloadBytes: { requestBytes: 0, responseBytes: 0, totalBytes: 0 },
    fixture: { requests: 0, responseBytes: 0, paths: {} },
    tabs: {
      tabsBeforeCleanup: 0,
      closeResult: null,
      tabsLeftOpen: 0,
      matchedGroupsAfterCleanup: 0,
    },
    process: {
      before: {
        chrome: lastSample.chrome || emptyProcessSummary().chrome,
        codexApp: lastSample.codexApp || emptyProcessSummary().codexApp,
        benchmarkNode: lastSample.benchmarkNode || emptyProcessSummary().benchmarkNode,
        rustBroker: lastSample.rustBroker || emptyProcessSummary().rustBroker,
      },
      after: {
        chrome: lastSample.chrome || emptyProcessSummary().chrome,
        codexApp: lastSample.codexApp || emptyProcessSummary().codexApp,
        benchmarkNode: lastSample.benchmarkNode || emptyProcessSummary().benchmarkNode,
        rustBroker: lastSample.rustBroker || emptyProcessSummary().rustBroker,
      },
    },
    error: error?.stack || error?.message || String(error),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sharedKey = loadSharedKey();
  if (!sharedKey) {
    throw new Error('Missing UMBRA_SHARED_KEY or UMBRA_SHARED_KEY_FILE.');
  }

  const runId = `performance-${stampForPath()}`;
  const reportDir = path.resolve(options.reportDir || path.join(REPORTS_ROOT, runId));
  await fsp.mkdir(reportDir, { recursive: true });

  const context = {
    options,
    runId,
    reportDir,
    resultsJson: path.join(reportDir, 'results.json'),
    resultLog: path.join(reportDir, 'results.jsonl'),
    commandLog: path.join(reportDir, 'commands.jsonl'),
    processJson: path.join(reportDir, 'process-samples.json'),
    markdownPath: path.join(reportDir, 'Performance_Benchmark_Report.md'),
    sharedKey,
    sessionId: createSessionId(),
    bridge: null,
    brokerRuntime: null,
    port: null,
    authElapsedMs: null,
    fixture: null,
    groupTitle: `CiC Bench ${runId}`,
    matrix: [],
    commands: [],
    processSamples: [],
  };

  let finalStatus = 'pass';
  const runStarted = performance.now();
  try {
    await fsp.writeFile(context.resultLog, '', 'utf8');
    await fsp.writeFile(context.commandLog, '', 'utf8');
    context.fixture = await startFixtureServer(options);

    await sampleProcesses('before-bridge-start', context.processSamples);
    const authStarted = performance.now();
    const initialHealth = await startBenchmarkBridge(context);
    if (options.brokerMode === 'rust') {
      context.port = initialHealth?.listener?.port ?? null;
      console.error(`[bench] rust broker shim listening on ${context.brokerRuntime.socketPath}`);
      if (context.port) {
        console.error(`[bench] rust broker extension endpoint on 127.0.0.1:${context.port}`);
      }
    } else {
      console.error(`[bench] bridge listening on 127.0.0.1:${context.port}`);
    }
    console.error(`[bench] fixture listening on ${context.fixture.baseUrl}`);
    const authenticatedHealth = await waitForAuthenticatedBridge(context.bridge, context.sessionId, options.timeoutMs);
    if (options.brokerMode === 'rust') {
      context.port = authenticatedHealth?.listener?.port ?? context.port;
    }
    context.authElapsedMs = round(performance.now() - authStarted, 2);
    console.error(`[bench] extension authenticated in ${context.authElapsedMs}ms`);
    await sampleProcesses('after-bridge-auth', context.processSamples);

    const scenarios = [
      { name: 'create-read-text', label: 'Create Read', fn: scenarioCreateRead },
      { name: 'navigate-loop', label: 'Navigate Loop', fn: scenarioNavigateLoop },
      { name: 'wait-loop', label: 'Wait Loop', fn: scenarioWaitLoop },
      { name: 'screenshot', label: 'Screenshot', fn: scenarioScreenshot },
      { name: 'multi-tab-fanout', label: 'Multi Tab', fn: scenarioMultiTab },
      { name: 'large-payload-html', label: 'Large Payload', fn: scenarioLargePayload },
      { name: 'technical-snapshot', label: 'Technical Snapshot', fn: scenarioTechnicalSnapshot },
      { name: 'workflow-separate', label: 'Workflow Separate', fn: scenarioSeparateWorkflow },
      { name: 'workflow-batch', label: 'Workflow Batch', fn: scenarioBatchWorkflow },
      { name: 'export-like-workflow', label: 'Export Like', fn: scenarioExportLike },
      { name: 'read-interactive', label: 'Read Interactive', fn: scenarioReadInteractive },
      { name: 'read-interactive-ref-click', label: 'Read Interactive Ref Click', fn: scenarioReadInteractiveRefClick },
      { name: 'recipe-workflow', label: 'Recipe Workflow', fn: scenarioRecipeWorkflow },
      { name: 'cached-second-read', label: 'Cached Second Read', fn: scenarioCachedSecondRead },
      { name: 'group-find-adopt-overhead', label: 'Group Find Adopt Overhead', fn: scenarioGroupFindAdoptOverhead },
    ];

    for (const scenario of scenarios) {
      try {
        await runScenario(context, scenario, scenario.fn);
      } catch {
        finalStatus = 'fail';
      }
    }
  } catch (error) {
    finalStatus = 'fail';
    if (!context.matrix.some((row) => row.status === 'fail')) {
      const row = makeFailureRow(context, {
        scenario: context.port ? 'bridge-auth' : 'bridge-start',
        label: context.port ? 'Bridge Auth' : 'Bridge Start',
        error,
        elapsedMs: performance.now() - runStarted,
      });
      context.matrix.push(row);
      await appendJsonl(context.resultLog, row).catch(() => {});
    }
    console.error(`[bench] ${error?.stack || error?.message || error}`);
  } finally {
    if (bridgeIsConnected(context.bridge) && !options.keepTabsOpen) {
      await context.bridge.sendCommand('browser_close_session_tabs', {}).catch(() => {});
    }
    await sampleProcesses('before-shutdown', context.processSamples).catch(() => {});
    await stopBenchmarkBridge(context);
    await context.fixture?.close().catch(() => {});
    await delay(50);
    const payload = await writeArtifacts(context, finalStatus);
    console.log(JSON.stringify({
      ok: finalStatus === 'pass',
      runId: payload.runId,
      reportDir: payload.reportDir,
      summary: payload.summary,
      markdown: payload.reportDir ? `${payload.reportDir}/Performance_Benchmark_Report.md` : '',
      results: payload.reportDir ? `${payload.reportDir}/results.json` : '',
    }, null, 2));
  }

  if (finalStatus !== 'pass') {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[bench] ${error?.stack || error?.message || error}`);
  process.exit(1);
});

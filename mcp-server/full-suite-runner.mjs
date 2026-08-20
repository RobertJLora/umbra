import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';
import { FileDownloadLedger } from './download-ledger.mjs';
import { RustBrokerClient } from './rust-broker-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(__dirname, '..');
const REPORTS_ROOT = path.join(BRIDGE_ROOT, 'reports');
const RUST_MANIFEST = path.join(BRIDGE_ROOT, 'rust-broker', 'Cargo.toml');
const RUST_RELEASE_BINARY = path.join(BRIDGE_ROOT, 'rust-broker', 'target', 'release', 'umbra-rust-broker');
const DOWNLOAD_DIR = '/Users/RobertLora/Documents/Downloads';
const DEFAULT_SHARED_KEY_FILE = '/Users/RobertLora/.umbra/shared-key';
const DEFAULT_SUITES = ['baseline', 'concurrency', 'ahrefs', 'social', 'research', 'downloads', 'seo', 'cleanup'];
const DEFAULT_PORT_START = 47829;
const DEFAULT_PORT_END = 47852;
const DEFAULT_TIMEOUT_MS = 60_000;
const DENIAL_RE = /not owned|does not own|already owned/i;
const COLORS = ['blue', 'green', 'yellow', 'pink', 'purple', 'cyan', 'orange'];

function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function parseArgs(argv) {
  const options = {
    suites: DEFAULT_SUITES,
    portStart: Number(process.env.UMBRA_SUITE_PORT_START || DEFAULT_PORT_START),
    portEnd: Number(process.env.UMBRA_SUITE_PORT_END || DEFAULT_PORT_END),
    timeoutMs: Number(process.env.UMBRA_SUITE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    reportDir: '',
    keepOpenOnFail: false,
    cleanupMode: 'closeTabs',
    brokerMode: process.env.UMBRA_BROKER_MODE === 'rust' ? 'rust' : 'legacy',
    ahrefsTarget: process.env.UMBRA_AHREFS_TARGET || 'adaptivesecurity.com',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--suites') {
      options.suites = argv[++index].split(',').map((suite) => suite.trim()).filter(Boolean);
    } else if (arg.startsWith('--suites=')) {
      options.suites = arg.slice('--suites='.length).split(',').map((suite) => suite.trim()).filter(Boolean);
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
    } else if (arg === '--keep-open-on-fail') {
      options.keepOpenOnFail = true;
    } else if (arg === '--cleanup-mode') {
      options.cleanupMode = argv[++index];
    } else if (arg.startsWith('--cleanup-mode=')) {
      options.cleanupMode = arg.slice('--cleanup-mode='.length);
    } else if (arg === '--broker-mode') {
      options.brokerMode = argv[++index];
    } else if (arg.startsWith('--broker-mode=')) {
      options.brokerMode = arg.slice('--broker-mode='.length);
    } else if (arg === '--ahrefs-target') {
      options.ahrefsTarget = argv[++index];
    } else if (arg.startsWith('--ahrefs-target=')) {
      options.ahrefsTarget = arg.slice('--ahrefs-target='.length);
    } else if (!arg.startsWith('-')) {
      options.suites = arg.split(',').map((suite) => suite.trim()).filter(Boolean);
    }
  }

  if (!Number.isFinite(options.portStart) || !Number.isFinite(options.portEnd) || options.portStart > options.portEnd) {
    throw new Error(`Invalid port range: ${options.portStart}-${options.portEnd}`);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }

  if (!['closeTabs', 'keepTabsGrouped', 'ungroupOnly'].includes(options.cleanupMode)) {
    throw new Error(`Unsupported cleanup mode: ${options.cleanupMode}`);
  }

  if (!['legacy', 'rust'].includes(options.brokerMode)) {
    throw new Error(`Unsupported broker mode: ${options.brokerMode}`);
  }

  return options;
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

class Reporter {
  constructor({ reportDir, runId, options }) {
    this.reportDir = reportDir;
    this.runId = runId;
    this.options = options;
    this.results = [];
    this.failures = [];
    this.resultLog = path.join(reportDir, 'results.jsonl');
    this.failureLog = path.join(reportDir, 'failures.jsonl');
    this.markdownPath = path.join(reportDir, 'Full_Bridge_Test_Report.md');
  }

  async init() {
    await fsp.mkdir(this.reportDir, { recursive: true });
    await fsp.writeFile(this.resultLog, '', 'utf8');
    await fsp.writeFile(this.failureLog, '', 'utf8');
  }

  async result(entry) {
    const normalized = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.results.push(normalized);
    await fsp.appendFile(this.resultLog, `${JSON.stringify(normalized)}\n`, 'utf8');
  }

  async failure(entry) {
    const normalized = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.failures.push(normalized);
    await fsp.appendFile(this.failureLog, `${JSON.stringify(normalized)}\n`, 'utf8');
  }

  async writeMarkdown() {
    const statusCounts = this.results.reduce((counts, result) => {
      counts[result.status] = (counts[result.status] || 0) + 1;
      return counts;
    }, {});
    const suites = [...new Set(this.results.map((result) => result.suite))];
    const suiteRows = suites.map((suite) => {
      const rows = this.results.filter((result) => result.suite === suite);
      const failed = rows.filter((row) => row.status === 'fail').length;
      const warned = rows.filter((row) => row.status === 'warn').length;
      const passed = rows.filter((row) => row.status === 'pass').length;
      const elapsed = rows.reduce((sum, row) => sum + (row.elapsedMs || 0), 0);
      const verdict = failed ? 'Fail' : warned ? 'Warn' : 'Pass';
      return `| ${suite} | ${verdict} | ${passed} | ${warned} | ${failed} | ${Math.round(elapsed / 100) / 10}s |`;
    });

    const failureRows = this.failures.length
      ? this.failures.map((failure) => (
          `| ${failure.suite || ''} | ${failure.task || ''} | ${failure.sessionId || ''} | ${failure.tabId || ''} | ${escapeTable(failure.error || failure.failureText || '')} | ${escapeTable(failure.proposedFix || '')} |`
        ))
      : ['| - | - | - | - | None recorded. | - |'];

    const evidenceRows = this.results
      .filter((result) => result.status !== 'pass' || result.filePath || result.screenshotPath || result.downloadedFilePath || result.url)
      .slice(-80)
      .map((result) => (
        `| ${result.suite} | ${result.task} | ${result.status} | ${escapeTable(result.url || '')} | ${escapeTable(result.filePath || result.downloadedFilePath || result.screenshotPath || '')} | ${escapeTable(result.failureText || result.note || '')} |`
      ));

    const content = `# Umbra Full Suite Report

Generated: ${new Date().toISOString()}

Report folder: \`${this.reportDir}\`

## Run Configuration

| Field | Value |
|---|---|
| Suites | ${this.options.suites.join(', ')} |
| Port range | ${this.options.portStart}-${this.options.portEnd} |
| Timeout | ${this.options.timeoutMs}ms |
| Cleanup mode | ${this.options.cleanupMode} |
| Broker mode | ${this.options.brokerMode} |
| Downloads | ${DOWNLOAD_DIR} |
| Shared key source | ${process.env.UMBRA_SHARED_KEY ? 'env' : DEFAULT_SHARED_KEY_FILE} |

## Summary

| Metric | Count |
|---|---:|
| Pass | ${statusCounts.pass || 0} |
| Warn | ${statusCounts.warn || 0} |
| Fail | ${statusCounts.fail || 0} |
| Total results | ${this.results.length} |
| Failure records | ${this.failures.length} |

## Suite Matrix

| Suite | Verdict | Pass | Warn | Fail | Logged elapsed |
|---|---|---:|---:|---:|---:|
${suiteRows.join('\n')}

## Failure Log

| Suite | Task | Session | Tab | Error | Proposed fix |
|---|---|---|---:|---|---|
${failureRows.join('\n')}

## Evidence Trail

| Suite | Task | Status | URL | File | Note |
|---|---|---|---|---|---|
${evidenceRows.join('\n') || '| - | - | - | - | - | - |'}

## Daily Use Recommendation

- Use Umbra for signed-in Chrome state, tab groups, concurrent browser sessions, and Chrome-initiated downloads.
- Use Browser Use for fast public/in-app browsing where persistent auth and local downloads do not matter.
- Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.
- Use Firecrawl, curl, or Screaming Frog for public raw HTTP status, headers, large crawls, and repeatable technical SEO at scale.
- Keep password manager, cookies, tokens, OTP, passkeys, and account-security pages out of the bridge.

## Generated Files

- Results JSONL: \`${this.resultLog}\`
- Failures JSONL: \`${this.failureLog}\`
`;

    await fsp.writeFile(this.markdownPath, content, 'utf8');
  }
}

function escapeTable(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 500);
}

function makeContext({ options, reporter, sharedKey }) {
  return {
    options,
    reporter,
    sharedKey,
    runId: reporter.runId,
    activeSessions: new Set(),
    ownedTabs: new Map(),
    brokerRuntime: null,
  };
}

async function waitForAuthenticatedBridge(bridge, label, timeoutMs) {
  if (typeof bridge.health === 'function') {
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

  if (bridge.registry.isConnected()) {
    return;
  }

  await new Promise((resolve, reject) => {
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

function startRustBrokerRuntime(context) {
  const socketPath = process.env.UMBRA_BROKER_SOCKET
    || `/tmp/umbra-rust-suite-${process.pid}-${context.runId}.sock`;
  fs.rmSync(socketPath, { force: true });

  const command = fs.existsSync(RUST_RELEASE_BINARY) ? RUST_RELEASE_BINARY : 'cargo';
  const args = command === 'cargo'
    ? ['run', '--quiet', '--manifest-path', RUST_MANIFEST]
    : [];
  const child = spawn(command, args, {
    env: {
      ...process.env,
      UMBRA_SHARED_KEY: context.sharedKey,
      UMBRA_PORT_START: String(context.options.portStart),
      UMBRA_PORT_END: String(context.options.portEnd),
      UMBRA_REQUEST_TIMEOUT_MS: String(context.options.timeoutMs),
      UMBRA_BROKER_SOCKET: socketPath,
      UMBRA_BROKER_SESSION_ID: `rust_broker_suite_${process.pid}_${context.runId}`,
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
    socketPath,
    command,
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

async function ensureRustBrokerRuntime(context) {
  if (!context.brokerRuntime) {
    context.brokerRuntime = startRustBrokerRuntime(context);
  }
  return context.brokerRuntime;
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

async function startBridgeSession(context, { suite, label, requestTimeoutMs = context.options.timeoutMs, portStart, portEnd } = {}) {
  const sessionId = `suite_${suite}_${label}_${context.runId}`.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 80);
  let bridge = null;
  const startedAt = Date.now();
  let port = null;
  try {
    if (context.options.brokerMode === 'rust') {
      const runtime = await ensureRustBrokerRuntime(context);
      bridge = await connectRustBrokerClient({
        sessionId,
        socketPath: runtime.socketPath,
        timeoutMs: requestTimeoutMs,
      });
      const health = await waitForAuthenticatedBridge(bridge, sessionId, context.options.timeoutMs);
      port = health?.listener?.port ?? null;
    } else {
      bridge = new LocalBridgeServer({
        sharedKey: context.sharedKey,
        sessionId,
        portStart: portStart ?? context.options.portStart,
        portEnd: portEnd ?? context.options.portEnd,
        requestTimeoutMs,
      });
      port = await bridge.start();
      await waitForAuthenticatedBridge(bridge, sessionId, context.options.timeoutMs);
    }
    const session = { suite, label, sessionId, bridge, port, tabs: [] };
    context.activeSessions.add(session);
    context.ownedTabs.set(session, session.tabs);
    await context.reporter.result({
      suite,
      task: 'bridge-auth',
      status: 'pass',
      sessionId,
      port,
      elapsedMs: Date.now() - startedAt,
    });
    return session;
  } catch (error) {
    await bridge?.stop?.().catch(() => {});
    await delay(75);
    throw error;
  }
}

async function stopBridgeSession(context, session, { closeTabs = true } = {}) {
  if (!session) {
    return;
  }

  if (closeTabs) {
    await closeOwnedTabs(session);
  }

  await session.bridge.stop().catch(() => {});
  context.activeSessions.delete(session);
  await delay(75);
}

async function closeOwnedTabs(session) {
  const seen = new Set(session.tabs.filter(Boolean));
  try {
    const listed = await session.bridge.sendCommand('browser_list_tabs', {});
    for (const tab of listed.tabs || []) {
      seen.add(tab.tabId ?? tab.id);
    }
  } catch {
    // The bridge may already be stopped or disconnected.
  }

  if (seen.size > 0) {
    await session.bridge.sendCommand('browser_close_session_tabs', {}).catch(async () => {
      for (const tabId of seen) {
        await session.bridge.sendCommand('browser_close_tab', { tabId }).catch(() => {});
      }
    });
  }
  session.tabs.length = 0;
}

async function recordFailure(context, fields) {
  await context.reporter.failure(fields);
  await context.reporter.result({
    ...fields,
    status: 'fail',
  });
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function safeSuite(context, suiteName, fn) {
  const startedAt = Date.now();
  console.error(`[full-suite] starting ${suiteName}`);
  try {
    await fn();
    await context.reporter.result({
      suite: suiteName,
      task: 'suite-complete',
      status: 'pass',
      elapsedMs: Date.now() - startedAt,
    });
    console.error(`[full-suite] completed ${suiteName}`);
  } catch (error) {
    await recordFailure(context, {
      suite: suiteName,
      task: 'suite-error',
      error: error?.stack || error?.message || String(error),
      failureText: error?.message || String(error),
      elapsedMs: Date.now() - startedAt,
      proposedFix: 'Inspect the suite-specific result rows and patch the narrow bridge behavior that failed.',
    });
    if (!context.options.keepOpenOnFail) {
      await cleanupAllSessions(context, { closeTabs: true });
    }
    console.error(`[full-suite] failed ${suiteName}: ${error?.message || error}`);
  } finally {
    await context.reporter.writeMarkdown();
  }
}

async function cleanupAllSessions(context, { closeTabs = true } = {}) {
  const sessions = [...context.activeSessions];
  for (const session of sessions) {
    await stopBridgeSession(context, session, { closeTabs });
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function makeXlsxBuffer() {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="BridgeSuite" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>suite</t></is></c><c r="B1" t="inlineStr"><is><t>status</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>downloads</t></is></c><c r="B2" t="inlineStr"><is><t>ok</t></is></c></row>
  </sheetData>
</worksheet>`,
    },
  ]);
}

function makePdfBuffer() {
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 62 >>
stream
BT /F1 16 Tf 36 100 Td (Umbra PDF fixture) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000251 00000 n 
0000000363 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
startxref
433
%%EOF
`, 'utf8');
}

async function startFixtureServer(runId) {
  const csvName = `codex-bridge-suite-${runId}-sample.csv`;
  const xlsxName = `codex-bridge-suite-${runId}-sample.xlsx`;
  const pdfName = `codex-bridge-suite-${runId}-sample.pdf`;
  const inlinePdfName = `codex-bridge-suite-${runId}-inline.pdf`;
  const blobName = `codex-bridge-suite-${runId}-blob.csv`;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (url.pathname === `/files/${csvName}`) {
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${csvName}"`,
      });
      response.end('suite,kind,status\nfull-suite,csv,ok\n');
      return;
    }

    if (url.pathname === `/files/${xlsxName}`) {
      const data = makeXlsxBuffer();
      response.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${xlsxName}"`,
        'content-length': data.length,
      });
      response.end(data);
      return;
    }

    if (url.pathname === `/files/${pdfName}` || url.pathname === `/files/${inlinePdfName}`) {
      const data = makePdfBuffer();
      const disposition = url.pathname.includes(inlinePdfName) ? 'inline' : 'attachment';
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': `${disposition}; filename="${path.basename(url.pathname)}"`,
        'content-length': data.length,
      });
      response.end(data);
      return;
    }

    const page = pageHtml(url.pathname, {
      runId,
      csvName,
      xlsxName,
      pdfName,
      inlinePdfName,
      blobName,
    });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    files: { csvName, xlsxName, pdfName, inlinePdfName, blobName },
    close: () => closeServer(server),
  };
}

function pageHtml(pathname, names) {
  if (pathname === '/downloads') {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Codex Bridge Downloads</title></head>
<body>
  <main>
    <h1>Codex Bridge Downloads</h1>
    <a id="csv-download" href="/files/${names.csvName}" download="${names.csvName}">Download CSV</a>
    <a id="xlsx-download" href="/files/${names.xlsxName}" download="${names.xlsxName}">Download XLSX</a>
    <a id="pdf-download" href="/files/${names.pdfName}" download="${names.pdfName}">Download PDF</a>
    <a id="inline-pdf" href="/files/${names.inlinePdfName}">Open Rendered PDF</a>
    <button id="blob-download" type="button">Download Blob CSV</button>
    <p id="download-status">waiting</p>
  </main>
  <script>
    document.querySelector('#blob-download').addEventListener('click', () => {
      const blob = new Blob(['suite,kind,status\\nfull-suite,blob,ok\\n'], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = '${names.blobName}';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      document.querySelector('#download-status').textContent = 'blob-clicked';
    });
  </script>
</body>
</html>`;
  }

  if (pathname === '/seo') {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Codex Bridge SEO Fixture</title>
  <meta name="description" content="SEO fixture for Umbra technical snapshot tests.">
  <meta name="robots" content="index,follow">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="/seo">
  <link rel="alternate" hreflang="es" href="/seo?lang=es">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Bridge SEO Fixture"}</script>
</head>
<body>
  <header><h1>Codex Bridge SEO Fixture</h1></header>
  <main>
    <h2>Rendered DOM</h2>
    <p>Technical snapshot marker: codex-bridge-seo-ok.</p>
    <a href="/baseline">Internal fixture link</a>
    <a href="https://example.com/" rel="nofollow">External nofollow link</a>
    <img src="/image/missing-alt.png">
    <img src="/image/empty-alt.png" alt="">
    <img src="/image/lazy.png" alt="Lazy fixture" loading="lazy">
  </main>
</body>
</html>`;
  }

  if (pathname.startsWith('/concurrency/')) {
    const [, , label = 'unknown', tab = '0'] = pathname.split('/');
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Codex Bridge ${label} Tab ${tab}</title></head>
<body>
  <main>
    <h1>Codex Bridge ${label} Tab ${tab}</h1>
    <button id="lane-button">Lane Button</button>
    <p id="marker">codex-bridge-concurrency-ok ${label} ${tab}</p>
  </main>
</body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Codex Bridge Baseline</title></head>
<body>
  <main>
    <h1>Codex Bridge Baseline</h1>
    <p id="baseline-marker">codex-bridge-baseline-ok ${names.runId}</p>
    <button id="baseline-button" type="button">Click Baseline Button</button>
    <p id="baseline-status">waiting</p>
  </main>
  <script>
    document.querySelector('#baseline-button').addEventListener('click', () => {
      document.querySelector('#baseline-status').textContent = 'clicked-ok';
    });
  </script>
</body>
</html>`;
}

async function waitForDownload(filename, timeoutMs) {
  const ledger = new FileDownloadLedger({ downloadDir: DOWNLOAD_DIR });
  return await ledger.waitForExact({
    filename,
    timeoutMs,
    removeExisting: true,
  });
}

async function waitForNewAhrefsCsv({ sinceMs, target, reportLabel, timeoutMs }) {
  const expectedNameTokens = {
    'top-pages': ['top-pages'],
    'organic-keywords': ['organic-keywords'],
    'referring-domains': ['refdomains', 'referring-domains'],
  }[reportLabel] || [];
  const ledger = new FileDownloadLedger({ downloadDir: DOWNLOAD_DIR, pollMs: 500 });
  const targetToken = target.toLowerCase().replace(/^www\./, '');
  const startedAt = Date.now();
  ledger.record('wait_ahrefs_start', { sinceMs, timeoutMs, targetToken, expectedNameTokens });

  while (Date.now() - startedAt <= timeoutMs) {
    const targetMatches = await ledger.findNew({
      sinceMs,
      extension: '.csv',
      nameIncludes: [targetToken],
    });
    const preferred = expectedNameTokens.length > 0
      ? targetMatches.find((match) => expectedNameTokens.some((token) => match.filename.toLowerCase().includes(token)))
      : targetMatches[0];
    const fallback = targetMatches[0];
    if (preferred || fallback) {
      const match = preferred || fallback;
      ledger.record('wait_ahrefs_complete', { filePath: match.filePath, bytes: match.bytes });
      return {
        ...match,
        elapsedMs: Date.now() - startedAt,
        ledgerEvents: ledger.snapshot(),
      };
    }
    await delay(500);
  }

  ledger.record('wait_ahrefs_timeout', { sinceMs, timeoutMs, targetToken, expectedNameTokens });
  throw new Error(`Timed out waiting for a new Ahrefs ${reportLabel || ''} CSV for ${target}.`);
}

async function waitForPageText(session, tabId, predicate, timeoutMs, task = 'wait-for-text') {
  const startedAt = Date.now();
  let lastText = '';
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const page = await session.bridge.sendCommand('browser_get_page_content', { tabId, format: 'text' });
      lastText = page.bodyText || page.content || '';
      if (predicate(lastText, page)) {
        return page;
      }
    } catch {
      // Some navigations briefly expose Chrome error/PDF viewer states.
    }
    await delay(500);
  }
  throw new Error(`${task} timed out. Last text: ${lastText.slice(0, 300)}`);
}

async function writeScreenshot(context, suite, task, screenshot) {
  if (!screenshot?.data) {
    return '';
  }
  const screenshotsDir = path.join(context.reporter.reportDir, 'screenshots');
  await fsp.mkdir(screenshotsDir, { recursive: true });
  const screenshotPath = path.join(screenshotsDir, `${suite}-${task}-${Date.now()}.png`);
  await fsp.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  return screenshotPath;
}

async function runBaseline(context) {
  let fixture = null;
  let session = null;
  const suite = 'baseline';
  try {
    fixture = await startFixtureServer(context.runId);
    session = await startBridgeSession(context, { suite, label: 'main' });
    const startedAt = Date.now();
    const tab = await session.bridge.sendCommand('browser_create_tab', {
      url: `${fixture.baseUrl}/baseline`,
      activate: false,
    });
    session.tabs.push(tab.tabId);

    const groupName = `Suite baseline ${context.runId.slice(-6)}`;
    const group = await session.bridge.sendCommand('browser_group_tabs', {
      title: groupName,
      color: 'green',
      collapsed: false,
    });
    const [text, html, technical] = await Promise.all([
      session.bridge.sendCommand('browser_get_page_content', { tabId: tab.tabId, format: 'text' }),
      session.bridge.sendCommand('browser_get_page_content', { tabId: tab.tabId, format: 'html' }),
      session.bridge.sendCommand('browser_get_technical_snapshot', { tabId: tab.tabId }),
    ]);
    requireCondition((text.bodyText || '').includes('codex-bridge-baseline-ok'), 'Baseline text marker missing.');
    requireCondition((html.html || html.content || '').includes('baseline-button'), 'Baseline HTML marker missing.');
    requireCondition(technical.title === 'Codex Bridge Baseline', 'Technical snapshot returned wrong title.');

    const screenshot = await session.bridge.sendCommand('browser_screenshot', { tabId: tab.tabId });
    const screenshotPath = await writeScreenshot(context, suite, 'baseline', screenshot);
    await session.bridge.sendCommand('browser_click_text', {
      tabId: tab.tabId,
      text: 'Click Baseline Button',
      selector: 'button',
    });
    const clicked = await waitForPageText(
      session,
      tab.tabId,
      (bodyText) => bodyText.includes('clicked-ok'),
      5_000,
      'baseline-click',
    );

    await context.reporter.result({
      suite,
      task: 'create-group-read-click-screenshot-close',
      status: 'pass',
      sessionId: session.sessionId,
      port: session.port,
      tabIds: [tab.tabId],
      groupName,
      groupId: group.group?.groupId,
      url: text.url,
      title: text.title,
      screenshotPath,
      elapsedMs: Date.now() - startedAt,
      note: `Clicked text and saw ${clicked.title}.`,
    });
  } finally {
    await fixture?.close().catch(() => {});
    await stopBridgeSession(context, session, { closeTabs: context.options.cleanupMode === 'closeTabs' });
  }
}

async function runConcurrency(context) {
  const suite = 'concurrency';
  let fixture = null;
  try {
    fixture = await startFixtureServer(context.runId);
    for (const sessionCount of [3, 5, 8]) {
      if (context.options.portEnd - context.options.portStart + 1 < sessionCount) {
        await context.reporter.result({
          suite,
          task: `stress-${sessionCount}-sessions`,
          status: 'warn',
          failureText: `Skipped because port range has fewer than ${sessionCount} slots.`,
        });
        continue;
      }

      const startedAt = Date.now();
      const sessions = [];
      try {
        for (let index = 0; index < sessionCount; index += 1) {
          sessions.push(await startBridgeSession(context, {
            suite,
            label: `s${sessionCount}_${index + 1}`,
            portStart: context.options.portStart + index,
            portEnd: context.options.portStart + index,
          }));
        }

        for (const [index, session] of sessions.entries()) {
          const groupName = `Suite ${sessionCount} ${index + 1}`;
          for (let tabIndex = 1; tabIndex <= 2; tabIndex += 1) {
            const tab = await session.bridge.sendCommand('browser_create_tab', {
              url: `${fixture.baseUrl}/concurrency/${session.label}/${tabIndex}`,
              activate: false,
            });
            session.tabs.push(tab.tabId);
          }
          await session.bridge.sendCommand('browser_group_tabs', {
            title: groupName,
            color: COLORS[index % COLORS.length],
            collapsed: false,
          });
        }

        const listed = await Promise.all(sessions.map(async (session) => ({
          session,
          state: await session.bridge.sendCommand('browser_list_tabs', {}),
        })));

        for (const { session, state } of listed) {
          requireCondition(state.group, `Missing group for ${session.sessionId}`);
          requireCondition(state.tabs.length === 2, `${session.sessionId} expected 2 tabs, saw ${state.tabs.length}.`);
          requireCondition(
            state.tabs.every((tab) => tab.groupId === state.group.groupId),
            `${session.sessionId} has tabs outside its group.`,
          );
        }

        let denials = 0;
        const denialTasks = [];
        for (let index = 0; index < sessions.length; index += 1) {
          const actor = sessions[index];
          const target = sessions[(index + 1) % sessions.length];
          denialTasks.push(
            expectDenied(() => actor.bridge.sendCommand('browser_get_page_content', { tabId: target.tabs[0], format: 'text' })),
            expectDenied(() => actor.bridge.sendCommand('browser_click', { tabId: target.tabs[0], selector: '#lane-button' })),
            expectDenied(() => actor.bridge.sendCommand('browser_close_tab', { tabId: target.tabs[0] })),
          );
        }
        const denialResults = await Promise.all(denialTasks);
        denials = denialResults.filter(Boolean).length;
        requireCondition(denials === denialTasks.length, `Expected ${denialTasks.length} cross-session denials, saw ${denials}.`);

        await context.reporter.result({
          suite,
          task: `stress-${sessionCount}-sessions`,
          status: 'pass',
          sessionIds: sessions.map((session) => session.sessionId),
          ports: sessions.map((session) => session.port),
          tabIds: sessions.flatMap((session) => session.tabs),
          groupNames: listed.map(({ state }) => state.group?.title),
          elapsedMs: Date.now() - startedAt,
          note: `${sessionCount} sessions, ${sessions.length * 2} tabs, ${denials} cross-session denials.`,
        });
      } finally {
        for (const session of sessions) {
          await stopBridgeSession(context, session, { closeTabs: context.options.cleanupMode === 'closeTabs' });
        }
      }
    }
  } finally {
    await fixture?.close().catch(() => {});
  }
}

async function expectDenied(fn) {
  try {
    await fn();
    return false;
  } catch (error) {
    if (DENIAL_RE.test(error?.message || '')) {
      return true;
    }
    throw error;
  }
}

async function runDownloads(context) {
  const suite = 'downloads';
  let session = null;
  const fixtures = [];
  try {
    session = await startBridgeSession(context, { suite, label: 'files', requestTimeoutMs: Math.max(context.options.timeoutMs, 90_000) });

    const downloads = [
      { task: 'download-csv', selector: '#csv-download', fileKey: 'csvName' },
      { task: 'download-xlsx', selector: '#xlsx-download', fileKey: 'xlsxName' },
      { task: 'download-pdf', selector: '#pdf-download', fileKey: 'pdfName' },
      { task: 'download-blob', selector: '#blob-download', fileKey: 'blobName' },
    ];

    for (const download of downloads) {
      const fixture = await startFixtureServer(`${context.runId}-${download.task}`);
      fixtures.push(fixture);
      const filename = fixture.files[download.fileKey];
      const startedAt = Date.now();
      const tab = await session.bridge.sendCommand('browser_create_tab', {
        url: `${fixture.baseUrl}/downloads`,
        activate: true,
      });
      session.tabs.push(tab.tabId);
      await session.bridge.sendCommand('browser_group_tabs', {
        title: `Suite downloads ${context.runId.slice(-6)}`,
        color: 'blue',
      });
      await fsp.rm(path.join(DOWNLOAD_DIR, filename), { force: true }).catch(() => {});
      await session.bridge.sendCommand('browser_click', {
        tabId: tab.tabId,
        selector: download.selector,
      });
      const completed = await waitForDownload(filename, context.options.timeoutMs);
      await context.reporter.result({
        suite,
        task: download.task,
        status: 'pass',
        sessionId: session.sessionId,
        tabId: tab.tabId,
        url: `${fixture.baseUrl}/downloads`,
        downloadedFilePath: completed.filePath,
        filePath: completed.filePath,
        bytes: completed.bytes,
        sawPartial: completed.sawPartial,
        elapsedMs: Date.now() - startedAt,
        note: 'Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture.',
      });
    }

    const fixture = await startFixtureServer(`${context.runId}-rendered-pdf`);
    fixtures.push(fixture);
    const inlineStartedAt = Date.now();
    const inlineTab = await session.bridge.sendCommand('browser_create_tab', {
      url: `${fixture.baseUrl}/files/${fixture.files.inlinePdfName}`,
      activate: true,
    });
    session.tabs.push(inlineTab.tabId);
    try {
      const screenshot = await session.bridge.sendCommand('browser_screenshot', { tabId: inlineTab.tabId });
      const screenshotPath = await writeScreenshot(context, suite, 'rendered-pdf', screenshot);
      await context.reporter.result({
        suite,
        task: 'rendered-pdf',
        status: 'pass',
        sessionId: session.sessionId,
        tabId: inlineTab.tabId,
        url: `${fixture.baseUrl}/files/${fixture.files.inlinePdfName}`,
        screenshotPath,
        elapsedMs: Date.now() - inlineStartedAt,
        note: 'Rendered inline PDF can be opened and screenshot; DOM text may be unavailable in Chrome PDF viewer.',
      });
    } catch (error) {
      await context.reporter.result({
        suite,
        task: 'rendered-pdf',
        status: 'warn',
        sessionId: session.sessionId,
        tabId: inlineTab.tabId,
        url: `${fixture.baseUrl}/files/${fixture.files.inlinePdfName}`,
        failureText: error?.message || String(error),
        elapsedMs: Date.now() - inlineStartedAt,
        note: 'Inline PDF viewer is not a normal webpage DOM; this is expected on some Chrome builds.',
      });
    }
  } finally {
    for (const fixture of fixtures) {
      await fixture.close().catch(() => {});
    }
    await stopBridgeSession(context, session, { closeTabs: context.options.cleanupMode === 'closeTabs' });
  }
}

async function runSeo(context) {
  const suite = 'seo';
  let fixture = null;
  let session = null;
  try {
    fixture = await startFixtureServer(context.runId);
    session = await startBridgeSession(context, { suite, label: 'snapshot', requestTimeoutMs: Math.max(context.options.timeoutMs, 90_000) });
    const tab = await session.bridge.sendCommand('browser_create_tab', {
      url: `${fixture.baseUrl}/seo`,
      activate: false,
    });
    session.tabs.push(tab.tabId);
    await session.bridge.sendCommand('browser_group_tabs', {
      title: `Suite seo ${context.runId.slice(-6)}`,
      color: 'purple',
    });
    const snapshot = await session.bridge.sendCommand('browser_get_technical_snapshot', {
      tabId: tab.tabId,
      includeHtml: true,
    });
    requireCondition(snapshot.title === 'Codex Bridge SEO Fixture', 'SEO snapshot title mismatch.');
    requireCondition(snapshot.meta.description.includes('SEO fixture'), 'SEO meta description missing.');
    requireCondition(snapshot.headings.counts.h1 === 1, 'SEO h1 count mismatch.');
    requireCondition(snapshot.structuredData.jsonLdTypes.includes('Article'), 'JSON-LD Article type missing.');

    await context.reporter.result({
      suite,
      task: 'local-rendered-technical-snapshot',
      status: 'pass',
      sessionId: session.sessionId,
      tabId: tab.tabId,
      url: snapshot.url,
      title: snapshot.title,
      statusCode: snapshot.statusCode,
      htmlLength: snapshot.htmlLength,
      elapsedMs: snapshot.performance?.durationMs || 0,
      note: `H1=${snapshot.headings.counts.h1 || 0}, links=${snapshot.links.total}, images=${snapshot.images.total}.`,
    });

    const publicUrl = 'https://travelbagexperts.com/best-luggage-for-suits/?_verify=1777045074000';
    const publicStartedAt = Date.now();
    const publicTab = await session.bridge.sendCommand('browser_create_tab', {
      url: publicUrl,
      activate: false,
    });
    session.tabs.push(publicTab.tabId);
    const publicSnapshot = await session.bridge.sendCommand('browser_get_technical_snapshot', {
      tabId: publicTab.tabId,
      includeHtml: false,
    });
    const headerStatus = await fetchHeadStatus(publicUrl);
    await context.reporter.result({
      suite,
      task: 'public-rendered-vs-raw-status',
      status: publicSnapshot.title ? 'pass' : 'warn',
      sessionId: session.sessionId,
      tabId: publicTab.tabId,
      url: publicSnapshot.url || publicUrl,
      title: publicSnapshot.title,
      statusCode: publicSnapshot.statusCode,
      rawHttpStatus: headerStatus.status,
      failureText: headerStatus.error || '',
      elapsedMs: Date.now() - publicStartedAt,
      note: 'Bridge captures rendered DOM state; curl/Firecrawl/Screaming Frog remain better for raw HTTP/header audits at scale.',
    });
  } finally {
    await fixture?.close().catch(() => {});
    await stopBridgeSession(context, session, { closeTabs: context.options.cleanupMode === 'closeTabs' });
  }
}

async function fetchHeadStatus(url) {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, url: response.url };
  } catch (error) {
    return { status: null, error: error?.message || String(error) };
  }
}

async function runResearch(context) {
  const suite = 'research';
  const urls = [
    'https://example.com/',
    'https://www.wikipedia.org/',
    'https://news.ycombinator.com/',
  ];
  let session = null;
  try {
    session = await startBridgeSession(context, { suite, label: 'public', requestTimeoutMs: Math.max(context.options.timeoutMs, 90_000) });
    for (const [index, url] of urls.entries()) {
      const startedAt = Date.now();
      const tab = await session.bridge.sendCommand('browser_create_tab', { url, activate: false });
      session.tabs.push(tab.tabId);
      try {
        const page = await session.bridge.sendCommand('browser_get_page_content', { tabId: tab.tabId, format: 'text' });
        await context.reporter.result({
          suite,
          task: `public-page-${index + 1}`,
          status: (page.bodyText || page.content || '').length > 20 ? 'pass' : 'warn',
          sessionId: session.sessionId,
          tabId: tab.tabId,
          url: page.url || url,
          title: page.title,
          elapsedMs: Date.now() - startedAt,
          note: (page.bodyText || page.content || '').slice(0, 180),
        });
      } catch (error) {
        await context.reporter.result({
          suite,
          task: `public-page-${index + 1}`,
          status: 'warn',
          sessionId: session.sessionId,
          tabId: tab.tabId,
          url,
          failureText: error?.message || String(error),
          elapsedMs: Date.now() - startedAt,
          note: 'One public page failed to expose a readable DOM; suite continued to the remaining pages.',
        });
      }
    }
    await session.bridge.sendCommand('browser_group_tabs', {
      title: `Suite research ${context.runId.slice(-6)}`,
      color: 'cyan',
    });
  } finally {
    await stopBridgeSession(context, session, { closeTabs: context.options.cleanupMode === 'closeTabs' });
  }
}

async function runSocial(context) {
  const suite = 'social';
  const urls = [
    {
      label: 'x',
      url: 'https://x.com/search?q=%22GPT-5.5%22&src=typed_query&f=live',
    },
    {
      label: 'reddit',
      url: 'https://www.reddit.com/search/?q=%22GPT-5.5%22&sort=new',
    },
    {
      label: 'linkedin',
      url: 'https://www.linkedin.com/search/results/content/?keywords=%22GPT-5.5%22',
    },
  ];
  let session = null;
  try {
    session = await startBridgeSession(context, { suite, label: 'visible-readonly', requestTimeoutMs: Math.max(context.options.timeoutMs, 90_000) });
    for (const item of urls) {
      const startedAt = Date.now();
      const tab = await session.bridge.sendCommand('browser_create_tab', { url: item.url, activate: false });
      session.tabs.push(tab.tabId);
      await delay(2_000);
      const page = await session.bridge.sendCommand('browser_get_page_content', { tabId: tab.tabId, format: 'text' });
      const bodyText = page.bodyText || page.content || '';
      await context.reporter.result({
        suite,
        task: `readonly-${item.label}`,
        status: bodyText.length > 20 || page.title ? 'pass' : 'warn',
        sessionId: session.sessionId,
        tabId: tab.tabId,
        url: page.url || item.url,
        title: page.title,
        elapsedMs: Date.now() - startedAt,
        note: bodyText.slice(0, 240),
      });
    }
    await session.bridge.sendCommand('browser_group_tabs', {
      title: `Suite social ${context.runId.slice(-6)}`,
      color: 'orange',
    });
  } finally {
    await stopBridgeSession(context, session, { closeTabs: context.options.cleanupMode === 'closeTabs' });
  }
}

async function runAhrefs(context) {
  const suite = 'ahrefs';
  const target = context.options.ahrefsTarget;
  const reports = [
    {
      label: 'top-pages',
      url: `https://app.ahrefs.com/v2-site-explorer/top-pages?target=${encodeURIComponent(target)}&mode=subdomains&country=us&compareDate=prevMonth`,
    },
    {
      label: 'organic-keywords',
      url: `https://app.ahrefs.com/v2-site-explorer/organic-keywords?target=${encodeURIComponent(target)}&mode=subdomains&country=us&compareDate=prevMonth`,
    },
    {
      label: 'referring-domains',
      url: `https://app.ahrefs.com/v2-site-explorer/refdomains?target=${encodeURIComponent(target)}&mode=subdomains`,
    },
  ];
  let session = null;
  try {
    session = await startBridgeSession(context, { suite, label: 'exports', requestTimeoutMs: Math.max(context.options.timeoutMs, 180_000) });
    const overviewStartedAt = Date.now();
    const overviewTab = await session.bridge.sendCommand('browser_create_tab', {
      url: `https://app.ahrefs.com/v2-site-explorer/overview?target=${encodeURIComponent(target)}&mode=subdomains&country=us`,
      activate: false,
    });
    session.tabs.push(overviewTab.tabId);
    const overview = await waitForPageText(
      session,
      overviewTab.tabId,
      (bodyText, page) => Boolean(page.title) && !/sign in|log in/i.test(page.title),
      Math.max(context.options.timeoutMs, 90_000),
      'ahrefs-overview',
    );
    const overviewHtml = await session.bridge.sendCommand('browser_get_page_content', {
      tabId: overviewTab.tabId,
      format: 'html',
    });
    await context.reporter.result({
      suite,
      task: 'overview-readable-text-html',
      status: (overview.bodyText || overview.content || '').length > 200 && (overviewHtml.html || overviewHtml.content || '').length > 1000 ? 'pass' : 'warn',
      sessionId: session.sessionId,
      tabId: overviewTab.tabId,
      url: overview.url,
      title: overview.title,
      htmlLength: (overviewHtml.html || overviewHtml.content || '').length,
      elapsedMs: Date.now() - overviewStartedAt,
      note: (overview.bodyText || overview.content || '').slice(0, 260),
    });

    await session.bridge.sendCommand('browser_group_tabs', {
      title: `Suite ahrefs ${context.runId.slice(-6)}`,
      color: 'yellow',
    });

    for (const report of reports) {
      await exportAhrefsReport(context, session, { target, ...report });
    }
  } finally {
    await stopBridgeSession(context, session, { closeTabs: context.options.cleanupMode === 'closeTabs' });
  }
}

async function exportAhrefsReport(context, session, report) {
  const suite = 'ahrefs';
  const startedAt = Date.now();
  const sinceMs = Date.now();
  const tab = await session.bridge.sendCommand('browser_create_tab', {
    url: report.url,
    activate: true,
  });
  session.tabs.push(tab.tabId);

  try {
    await waitForPageText(
      session,
      tab.tabId,
      (bodyText) => /export/i.test(bodyText),
      Math.max(context.options.timeoutMs, 90_000),
      `ahrefs-${report.label}-export-button`,
    );
    await session.bridge.sendCommand('browser_click_text', {
      tabId: tab.tabId,
      text: 'Export',
      selector: 'button,[role="button"]',
      exact: true,
      index: -1,
    });
    await waitForPageText(
      session,
      tab.tabId,
      (bodyText) => /CSV|Google Sheets|Export/i.test(bodyText),
      20_000,
      `ahrefs-${report.label}-export-modal`,
    );

    let selectedCsv = false;
    const modalHtml = await session.bridge.sendCommand('browser_get_page_content', {
      tabId: tab.tabId,
      format: 'html',
    }).catch(() => null);
    const modalContent = modalHtml?.html || modalHtml?.content || '';
    const csvUtf8AppearsSelected = /checked=\"\"[^>]+name=\"export-encoding-options\"[\s\S]{0,800}CSV \(UTF-8/i.test(modalContent);
    for (const attempt of [
      { text: 'CSV (UTF-8', selector: '[role="dialog"] label,[role="dialog"] span,[role="dialog"] div', exact: false },
      { text: 'CSV', selector: '[role="dialog"] label,[role="dialog"] span,[role="dialog"] div', exact: false },
    ]) {
      if (csvUtf8AppearsSelected) {
        selectedCsv = true;
        break;
      }
      try {
        await session.bridge.sendCommand('browser_click_text', {
          tabId: tab.tabId,
          ...attempt,
        });
        selectedCsv = true;
        break;
      } catch {
        // Try the next visible label variant.
      }
    }

    const csvSelectionNote = selectedCsv
      ? 'CSV UTF-8 was selected or already selected in the export modal.'
      : 'CSV UTF-8 selection was not confirmed before export; downloaded filename/type still decides pass/fail.';

    await session.bridge.sendCommand('browser_click_text', {
      tabId: tab.tabId,
      text: 'Export',
      selector: '[role="dialog"] button,button',
      exact: true,
      index: -1,
    });
    const downloaded = await waitForNewAhrefsCsv({
      sinceMs,
      target: report.target,
      reportLabel: report.label,
      timeoutMs: Math.max(context.options.timeoutMs, 180_000),
    });
    const lineCount = await countLines(downloaded.filePath);
    await context.reporter.result({
      suite,
      task: `${report.label}-csv-export`,
      status: 'pass',
      sessionId: session.sessionId,
      tabId: tab.tabId,
      url: report.url,
      downloadedFilePath: downloaded.filePath,
      filePath: downloaded.filePath,
      bytes: downloaded.bytes,
      lines: lineCount,
      elapsedMs: Date.now() - startedAt,
      note: `Ahrefs CSV landed in Robert downloads via primary signed-in Chrome. ${csvSelectionNote}`,
    });
  } catch (error) {
    await recordFailure(context, {
      suite,
      task: `${report.label}-csv-export`,
      sessionId: session.sessionId,
      tabId: tab.tabId,
      url: report.url,
      error: error?.message || String(error),
      failureText: error?.message || String(error),
      elapsedMs: Date.now() - startedAt,
      proposedFix: 'Retest the Ahrefs export modal selector flow; if the modal changed, patch browser_click_text or add a narrow export helper.',
    });
  }
}

async function countLines(filePath) {
  const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
  if (!text) {
    return 0;
  }
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length;
}

async function runCleanup(context) {
  const suite = 'cleanup';
  const before = await listListeners();
  const probe = await runStdioShutdownProbe(context);
  const launcherProbe = await runLauncherShutdownProbe(context);
  const after = await listListeners();
  const beforeKeys = new Set(before.map((listener) => `${listener.port}:${listener.pid}`));
  const newListeners = after.filter((listener) => !beforeKeys.has(`${listener.port}:${listener.pid}`));
  const status = probe.exited && launcherProbe.exited && newListeners.length === 0 ? 'pass' : 'fail';
  await context.reporter.result({
    suite,
    task: 'listeners-and-stdio-shutdown',
    status,
    portsBefore: before.map((listener) => listener.port),
    portsAfter: after.map((listener) => listener.port),
    elapsedMs: probe.elapsedMs,
    launcherElapsedMs: launcherProbe.elapsedMs,
    note: `Direct stdio exited=${probe.exited}; launcher stdio exited=${launcherProbe.exited}; existing registered MCP listeners are preserved.`,
    failureText: [
      !probe.exited ? 'Direct index.js stdio probe did not exit.' : '',
      !launcherProbe.exited ? 'launch-mcp.sh stdio probe did not exit.' : '',
      newListeners.length ? `New listeners remain: ${newListeners.map((listener) => `${listener.port}/${listener.pid}`).join(', ')}` : '',
    ].filter(Boolean).join(' '),
  });
}

async function listListeners() {
  const output = await runCommand('lsof', ['-nP', '-iTCP:47821-47852', '-sTCP:LISTEN'], { timeoutMs: 5_000 }).catch((error) => ({
    stdout: '',
    stderr: error.message,
    code: 1,
  }));
  const lines = output.stdout.split('\n').slice(1).filter(Boolean);
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    const name = parts.find((part) => /:(\d+)$/.test(part) || /:(\d+)->/.test(part)) || '';
    const match = name.match(/:(\d+)(?:->|$)/);
    return {
      command: parts[0],
      pid: Number(parts[1]),
      user: parts[2],
      port: match ? Number(match[1]) : null,
      raw: line,
    };
  }).filter((listener) => listener.port);
}

async function runStdioShutdownProbe(context) {
  const startedAt = Date.now();
  const port = context.options.portEnd;
  const child = spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      UMBRA_SHARED_KEY_FILE: DEFAULT_SHARED_KEY_FILE,
      UMBRA_SESSION_ID: `suite_cleanup_probe_${context.runId}`,
      UMBRA_PORT_START: String(port),
      UMBRA_PORT_END: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end();

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(false);
    }, 8_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  return {
    exited,
    elapsedMs: Date.now() - startedAt,
    stderr: stderr.slice(-1000),
  };
}

async function runLauncherShutdownProbe(context) {
  const startedAt = Date.now();
  const port = context.options.portEnd;
  const child = spawn(path.join(__dirname, 'launch-mcp.sh'), {
    cwd: __dirname,
    env: {
      ...process.env,
      UMBRA_SHARED_KEY_FILE: DEFAULT_SHARED_KEY_FILE,
      UMBRA_SESSION_ID: `suite_cleanup_launcher_probe_${context.runId}`,
      UMBRA_PORT_START: String(port),
      UMBRA_PORT_END: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end();

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(false);
    }, 8_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  return {
    exited,
    elapsedMs: Date.now() - startedAt,
    stderr: stderr.slice(-1000),
  };
}

function runCommand(command, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const suiteRunners = {
  baseline: runBaseline,
  concurrency: runConcurrency,
  ahrefs: runAhrefs,
  social: runSocial,
  research: runResearch,
  downloads: runDownloads,
  seo: runSeo,
  cleanup: runCleanup,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sharedKey = loadSharedKey();
  if (!sharedKey) {
    throw new Error(`Missing shared key. Set UMBRA_SHARED_KEY or UMBRA_SHARED_KEY_FILE.`);
  }

  const runId = stampForPath();
  const reportDir = path.resolve(options.reportDir || path.join(REPORTS_ROOT, `full-suite-${runId}`));
  const reporter = new Reporter({ reportDir, runId, options });
  await reporter.init();
  const context = makeContext({ options, reporter, sharedKey });

  for (const suiteName of options.suites) {
    const runner = suiteRunners[suiteName];
    if (!runner) {
      await recordFailure(context, {
        suite: suiteName,
        task: 'suite-lookup',
        error: `Unknown suite: ${suiteName}`,
        proposedFix: `Use one of: ${Object.keys(suiteRunners).join(', ')}`,
      });
      continue;
    }
    await safeSuite(context, suiteName, () => runner(context));
  }

  await cleanupAllSessions(context, { closeTabs: options.cleanupMode === 'closeTabs' });
  await context.brokerRuntime?.stop?.().catch(() => {});
  await reporter.writeMarkdown();
  console.log(JSON.stringify({
    ok: reporter.failures.length === 0,
    reportDir,
    markdownPath: reporter.markdownPath,
    resultLog: reporter.resultLog,
    failureLog: reporter.failureLog,
    results: reporter.results.length,
    failures: reporter.failures.length,
  }, null, 2));

  if (reporter.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(`[full-suite] ${error.stack || error.message}`);
  process.exit(1);
});

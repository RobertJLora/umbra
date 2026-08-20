#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createSessionId } from './auth.js';
import { LocalBridgeServer } from './bridge-core.js';
import { AHREFS_REPORTS, runAhrefsExport } from './ahrefs-export.js';
import { resolveSharedKeyPath } from './config.js';

function parseArgs(argv) {
  const options = {
    target: '',
    country: 'us',
    mode: 'subdomains',
    report: 'organic-keywords',
    out: '',
    keepTabs: false,
    groupTitle: 'Ahrefs Export',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--target') {
      options.target = next;
      i += 1;
    } else if (arg === '--country') {
      options.country = next;
      i += 1;
    } else if (arg === '--mode') {
      options.mode = next;
      i += 1;
    } else if (arg === '--report') {
      options.report = next;
      i += 1;
    } else if (arg === '--out') {
      options.out = next;
      i += 1;
    } else if (arg === '--keep-tabs') {
      options.keepTabs = true;
    } else if (arg === '--group-title') {
      options.groupTitle = next;
      i += 1;
    }
  }
  if (!options.target) {
    throw new Error('Missing --target example.com');
  }
  if (!AHREFS_REPORTS[options.report]) {
    throw new Error(`Unsupported --report ${options.report}. Use ${Object.keys(AHREFS_REPORTS).join(', ')}`);
  }
  return options;
}

function loadSharedKey() {
  const direct = process.env.UMBRA_SHARED_KEY?.trim();
  if (direct) return direct;
  return fs.readFileSync(resolveSharedKeyPath(), 'utf8').trim();
}

function getFrontmostApp() {
  return spawnSync('osascript', [
    '-e',
    'tell application "System Events" to get name of first process whose frontmost is true',
  ], { encoding: 'utf8' }).stdout.trim();
}

function restoreIfStolen(previousApp) {
  if (!previousApp || previousApp === 'Google Chrome') return;
  if (getFrontmostApp() !== 'Google Chrome') return;
  spawnSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of process ${JSON.stringify(previousApp)} to true`,
  ]);
}

async function waitForAuth(bridge, timeoutMs) {
  if (bridge.registry.isConnected()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.registry.off('authenticated', onAuth);
      reject(new Error(`Timed out waiting ${timeoutMs}ms for extension authentication.`));
    }, timeoutMs);
    const onAuth = () => {
      clearTimeout(timer);
      bridge.registry.off('authenticated', onAuth);
      resolve();
    };
    bridge.registry.on('authenticated', onAuth);
  });
}

const options = parseArgs(process.argv.slice(2));
const bridge = new LocalBridgeServer({
  sharedKey: loadSharedKey(),
  sessionId: createSessionId(),
  portStart: Number(process.env.UMBRA_PORT_START || 47829),
  portEnd: Number(process.env.UMBRA_PORT_END || 47852),
  requestTimeoutMs: 120_000,
});
const result = {
  ok: false,
  target: options.target,
  report: options.report,
};

try {
  await bridge.start();
  const previousApp = getFrontmostApp();
  result.previousApp = previousApp;
  await waitForAuth(bridge, 90_000);
  result.authenticated = true;
  restoreIfStolen(previousApp);

  const exported = await runAhrefsExport((tool, params) => bridge.sendCommand(tool, params), options);
  Object.assign(result, exported);
  restoreIfStolen(previousApp);
} catch (error) {
  result.error = error.message;
} finally {
  await bridge.stop?.().catch(() => {});
  if (bridge.httpServer) {
    await new Promise((resolve) => bridge.httpServer.close(() => resolve()));
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSessionId } from './auth.js';
import { LocalBridgeServer } from './bridge-core.js';
import { resolveSharedKeyPath } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.resolve(__dirname, '../tests/fixtures/ahrefs-export.html');

// Every install gets its own extension id, so the options-page reload fallback
// only runs when UMBRA_EXTENSION_ID names this one. Without it the run reports
// the skip rather than opening a URL for an extension nobody has installed.
const extensionId = process.env.UMBRA_EXTENSION_ID?.trim() || '';

function loadSharedKey() {
  const directKey = process.env.UMBRA_SHARED_KEY?.trim();
  if (directKey) {
    return directKey;
  }
  return fs.readFileSync(resolveSharedKeyPath(), 'utf8').trim();
}

function readCanonicalVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension', 'manifest.json'), 'utf8')).version;
}

function getFrontmostApp() {
  return spawnSync('osascript', [
    '-e',
    'tell application "System Events" to get name of first process whose frontmost is true',
  ], { encoding: 'utf8' }).stdout.trim();
}

function restoreIfStolen(previousApp) {
  if (!previousApp || previousApp === 'Google Chrome') return false;
  if (getFrontmostApp() !== 'Google Chrome') return false;
  spawnSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of process ${JSON.stringify(previousApp)} to true`,
  ]);
  return true;
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

async function waitForDisconnect(bridge, timeoutMs) {
  if (!bridge.registry.isConnected()) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const onDisc = () => {
      clearTimeout(timer);
      bridge.registry.off('disconnected', onDisc);
      resolve(true);
    };
    bridge.registry.on('disconnected', onDisc);
  });
}

function openReloadPage() {
  if (!extensionId) {
    return;
  }
  spawnSync('open', [`chrome-extension://${extensionId}/options.html?reload=1`]);
}

function startFixtureServer() {
  const html = fs.readFileSync(fixturePath);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const previousApp = getFrontmostApp();
const canonicalVersion = readCanonicalVersion();
const samples = [previousApp];
const result = {
  ok: false,
  previousApp,
  canonicalVersion,
  samples,
};

const bridge = new LocalBridgeServer({
  sharedKey: loadSharedKey(),
  sessionId: createSessionId(),
  portStart: Number(process.env.UMBRA_PORT_START || 47829),
  portEnd: Number(process.env.UMBRA_PORT_END || 47852),
  requestTimeoutMs: 60_000,
});

const fixture = await startFixtureServer();
result.fixtureUrl = fixture.url;

try {
  await bridge.start();
  await waitForAuth(bridge, 90_000);
  result.authenticated = true;
  samples.push(getFrontmostApp());
  restoreIfStolen(previousApp);

  const skipReload = process.env.SKIP_RELOAD === '1';
  if (!skipReload) {
    try {
      await bridge.sendCommand('browser_reload_extension', {});
      result.reloadVia = 'browser_reload_extension';
    } catch (error) {
      result.reloadVia = 'options_reload_url';
      result.reloadError = error.message;
      openReloadPage();
      restoreIfStolen(previousApp);
    }

    result.disconnected = await waitForDisconnect(bridge, 20_000);
    if (!result.disconnected) {
      openReloadPage();
      restoreIfStolen(previousApp);
      result.disconnected = await waitForDisconnect(bridge, 20_000);
    }
    await waitForAuth(bridge, 90_000);
    result.reauthenticated = true;
  } else {
    result.reloadVia = 'skipped';
  }
  result.sessionStatus = await bridge.sendCommand('browser_get_session_status', {}).catch((error) => ({ error: error.message }));
  samples.push(getFrontmostApp());
  restoreIfStolen(previousApp);

  const created = await bridge.sendCommand('browser_create_tab', {
    url: 'about:blank',
    activate: false,
    groupTitle: 'Bridge Fixture',
    groupCollapsed: true,
  });
  const tabId = created.tabId ?? created.id;
  result.tabId = tabId;
  samples.push(getFrontmostApp());

  await bridge.sendCommand('browser_navigate', {
    tabId,
    url: fixture.url,
    activate: false,
  });
  const exported = await bridge.sendCommand('browser_run_page_action', {
    tabId,
    action: 'ahrefs_export_csv',
    params: { timeoutMs: 8_000 },
    timeoutMs: 12_000,
  });
  result.exportAction = exported.result || exported;
  const page = await bridge.sendCommand('browser_get_page_content', { tabId, format: 'text' });
  result.pageText = (page.bodyText || page.content || '').slice(0, 500);
  result.clickedToolbar = /toolbar-export/.test(result.pageText);
  result.clickedChart = /chart-export/.test(result.pageText);
  result.clickedModal = /modal-export/.test(result.pageText);
  result.loadedVersion = result.sessionStatus?.extensionVersion || null;
  const exportPayload = result.exportAction?.result || result.exportAction;
  result.exportPayload = exportPayload;
  result.ok = Boolean(
    result.loadedVersion === canonicalVersion
    && (exportPayload?.exported === true)
    && result.clickedToolbar
    && result.clickedModal
    && !result.clickedChart,
  );
} catch (error) {
  result.error = error.message;
} finally {
  try {
    const closed = await bridge.sendCommand('browser_close_session_tabs', {});
    result.closedTabCount = closed.closedTabCount;
  } catch {
    // never opened or already gone
  }
  samples.push(getFrontmostApp());
  restoreIfStolen(previousApp);
  result.finalApp = getFrontmostApp();
  result.stoleFocus = samples.some((app) => app === 'Google Chrome') && previousApp !== 'Google Chrome';
  await fixture.close();
  await bridge.stop?.().catch(() => {});
  if (bridge.httpServer) {
    await new Promise((resolve) => bridge.httpServer.close(() => resolve()));
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

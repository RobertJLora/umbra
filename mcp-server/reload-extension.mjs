#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSessionId } from './auth.js';
import { LocalBridgeServer } from './bridge-core.js';
import { resolveSharedKeyPath } from './config.js';

process.env.UMBRA_ALLOW_EXTENSION_RELOAD = process.env.UMBRA_ALLOW_EXTENSION_RELOAD || '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// The AppleScript fallback needs a chrome-extension:// URL, which needs the
// install's own id. Every install gets a different one, so it comes from
// UMBRA_EXTENSION_ID. Without it the fallback is skipped and the run reports
// why, instead of opening a tab for an extension that is not installed here.
const extensionId = process.env.UMBRA_EXTENSION_ID?.trim() || '';
const reloadUrl = extensionId ? `chrome-extension://${extensionId}/options.html?reload=1` : '';

function loadSharedKey() {
  const directKey = process.env.UMBRA_SHARED_KEY?.trim();
  if (directKey) {
    return directKey;
  }
  return fs.readFileSync(resolveSharedKeyPath(), 'utf8').trim();
}

// The version this checkout would load. Comparing the reloaded extension
// against the repository's own manifest is the check that means something; the
// old pinned string only ever matched one build.
async function readCanonicalVersion() {
  const manifest = JSON.parse(await fsp.readFile(path.join(repoRoot, 'extension', 'manifest.json'), 'utf8'));
  return manifest.version;
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

function openReloadTab() {
  if (!reloadUrl) {
    return { skipped: true, reason: 'Set UMBRA_EXTENSION_ID to let the AppleScript fallback open this install\'s options page.' };
  }
  const script = `
tell application "Google Chrome"
  if (count of windows) = 0 then
    make new window
  end if
  tell window 1
    make new tab with properties {URL:${JSON.stringify(reloadUrl)}}
  end tell
end tell
`;
  const ran = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  return { status: ran.status, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() };
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

const previousApp = getFrontmostApp();
const canonicalVersion = await readCanonicalVersion();
const result = { ok: false, previousApp, canonicalVersion };
const bridge = new LocalBridgeServer({
  sharedKey: loadSharedKey(),
  sessionId: createSessionId(),
  portStart: Number(process.env.UMBRA_PORT_START || 47829),
  portEnd: Number(process.env.UMBRA_PORT_END || 47852),
  requestTimeoutMs: 20_000,
});

try {
  await bridge.start();
  await waitForAuth(bridge, 90_000);
  result.authenticated = true;
  restoreIfStolen(previousApp);

  try {
    const reload = await bridge.sendCommand('browser_reload_extension', {});
    result.reloadVia = 'browser_reload_extension';
    result.reload = reload;
  } catch (error) {
    result.reloadVia = 'applescript_options_tab';
    result.reloadError = error.message;
    result.appleScript = openReloadTab();
    restoreIfStolen(previousApp);
  }

  result.disconnected = await waitForDisconnect(bridge, 25_000);
  await waitForAuth(bridge, 90_000);
  result.reauthenticated = true;
  result.sessionStatus = await bridge.sendCommand('browser_get_session_status', {});
  result.loadedVersion = result.sessionStatus?.extensionVersion || null;
  result.loadedName = result.sessionStatus?.extensionName || null;
  result.ok = result.loadedVersion === canonicalVersion;
  result.finalApp = getFrontmostApp();
  restoreIfStolen(previousApp);
} catch (error) {
  result.error = error.message;
  result.finalApp = getFrontmostApp();
} finally {
  await bridge.stop?.().catch(() => {});
  if (bridge.httpServer) {
    await new Promise((resolve) => bridge.httpServer.close(() => resolve()));
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

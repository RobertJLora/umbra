import process from 'node:process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';
import { resolveSharedKeyPath } from './config.js';

const DEFAULT_AUTH_CHECK_URL = 'https://app.ahrefs.com/dashboard';
const DEFAULT_EXPECT_HOST = 'app.ahrefs.com';
const DEFAULT_REJECT_PATTERN = String.raw`/user/login|/signin|/sign-in|accounts\.google\.com`;
const timeoutMs = Number(process.env.UMBRA_SMOKE_TIMEOUT_MS || 60000);

// UMBRA_SHARED_KEY wins, then the key file, which defaults to the canonical
// path the options page writes. Reading the default means a paired install
// needs no environment setup to run this smoke.
function loadSharedKey() {
  const directKey = process.env.UMBRA_SHARED_KEY?.trim();
  if (directKey) {
    return directKey;
  }
  return fs.readFileSync(resolveSharedKeyPath(), 'utf8').trim();
}

let SHARED_KEY = '';
try {
  SHARED_KEY = loadSharedKey();
} catch {
  SHARED_KEY = '';
}
if (!SHARED_KEY) {
  console.error(`Missing shared key. Set UMBRA_SHARED_KEY, or write one to ${resolveSharedKeyPath()} with the options page Generate button.`);
  process.exit(1);
}

function assertSmoke(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function waitForAuthenticatedBridge(bridge) {
  if (bridge.registry.isConnected()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for extension authentication.`));
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

const authUrl = process.env.UMBRA_AUTH_CHECK_URL || DEFAULT_AUTH_CHECK_URL;
const expectedHost = process.env.UMBRA_AUTH_EXPECT_HOST || DEFAULT_EXPECT_HOST;
const rejectPattern = new RegExp(process.env.UMBRA_AUTH_REJECT_URL_PATTERN || DEFAULT_REJECT_PATTERN, 'i');
const bridge = new LocalBridgeServer({
  sharedKey: SHARED_KEY,
  sessionId: 'sess_auth_reuse_check',
  portStart: Number(process.env.UMBRA_PORT_START || 47821),
  portEnd: Number(process.env.UMBRA_PORT_END || 47852),
  requestTimeoutMs: timeoutMs,
});

let tabId = null;

try {
  const port = await bridge.start();
  console.error(`[auth-smoke] bridge listening on 127.0.0.1:${port}`);
  await waitForAuthenticatedBridge(bridge);
  console.error('[auth-smoke] extension authenticated');

  const created = await bridge.sendCommand('browser_create_tab', {
    url: authUrl,
    activate: false,
  });
  tabId = created.tabId ?? created.id;
  const finalUrl = created.url || '';
  const host = finalUrl ? new URL(finalUrl).hostname : '';

  assertSmoke(Number.isInteger(tabId), 'browser_create_tab did not return a numeric tabId.');
  assertSmoke(host === expectedHost, `Expected host ${expectedHost}, got ${host || '(empty)'}.`);
  assertSmoke(!rejectPattern.test(finalUrl), `Auth check landed on a sign-in URL: ${finalUrl}`);

  await bridge.sendCommand('browser_close_tab', { tabId });
  tabId = null;

  console.log(JSON.stringify({
    ok: true,
    checkedUrl: authUrl,
    final: {
      title: created.title,
      url: finalUrl,
      host,
    },
  }, null, 2));

  await bridge.stop();
  await delay(25);
  process.exit(0);
} catch (error) {
  console.error(`[auth-smoke] ${error.stack || error.message}`);
  if (tabId !== null && bridge.registry.isConnected()) {
    await bridge.sendCommand('browser_close_tab', { tabId }).catch(() => {});
  }
  await bridge.stop().catch(() => {});
  process.exit(1);
}

import fs from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';

function env(name, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function loadSharedKey() {
  const directKey = env('UMBRA_SHARED_KEY');
  if (directKey) {
    return directKey;
  }

  const keyFile = env('UMBRA_SHARED_KEY_FILE');
  if (keyFile) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }

  return '';
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lane';
}

function waitForAuthenticatedBridge(bridge, label, timeoutMs) {
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

const sharedKey = loadSharedKey();
if (!sharedKey) {
  console.error('Missing UMBRA_SHARED_KEY or UMBRA_SHARED_KEY_FILE');
  process.exit(1);
}

const label = env('CIC_DEMO_LABEL', 'Research Lane');
const slug = slugify(label);
const groupTitle = env('CIC_DEMO_GROUP_TITLE', `CiC ${label}`);
const urls = env('CIC_DEMO_URLS')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const port = Number(env('CIC_DEMO_PORT', '47829'));
const keepOpenMs = Number(env('CIC_DEMO_KEEP_OPEN_MS', '0'));
const closeSignalFile = env('CIC_DEMO_CLOSE_FILE', `/tmp/cic-demo-close-${slug}`);
const reportPath = env('CIC_DEMO_REPORT', `/tmp/cic-demo-${slug}.json`);
const timeoutMs = Number(env('UMBRA_SMOKE_TIMEOUT_MS', '60000'));

if (urls.length === 0) {
  console.error('Missing CIC_DEMO_URLS');
  process.exit(1);
}

const sessionId = `sess_demo_${slug}`;
const bridge = new LocalBridgeServer({
  sharedKey,
  sessionId,
  portStart: port,
  portEnd: port,
  requestTimeoutMs: timeoutMs,
});

let cleaned = false;

async function closeTabs(reason) {
  if (cleaned) {
    return null;
  }
  cleaned = true;
  if (!bridge.registry.isConnected()) {
    return { closed: false, reason: 'bridge_not_connected' };
  }
  const result = await bridge.sendCommand('browser_close_session_tabs', {}).catch((error) => ({
    closed: false,
    error: error.message,
  }));
  console.error(`[cic-demo:${label}] closed session tabs (${reason})`);
  return result;
}

async function shutdown(reason) {
  const closeResult = await closeTabs(reason);
  await bridge.stop().catch(() => {});
  return closeResult;
}

process.on('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit(130));
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit(143));
});

try {
  const boundPort = await bridge.start();
  console.error(`[cic-demo:${label}] bridge listening on 127.0.0.1:${boundPort}`);
  await waitForAuthenticatedBridge(bridge, label, timeoutMs);
  console.error(`[cic-demo:${label}] extension authenticated`);

  const tabs = [];
  for (const [index, url] of urls.entries()) {
    const tab = await bridge.sendCommand('browser_create_tab', {
      url,
      activate: index === 0,
      groupTitle,
      groupColor: 'cyan',
      groupCollapsed: false,
    });
    tabs.push(tab);
  }

  await bridge.sendCommand('browser_group_tabs', {
    title: groupTitle,
    color: 'cyan',
    collapsed: false,
  });

  const reads = [];
  for (const tab of tabs) {
    const tabId = tab.tabId ?? tab.id;
    const page = await bridge.sendCommand('browser_get_page_content', { tabId, format: 'text' }).catch((error) => ({
      title: tab.title || '',
      url: tab.url || '',
      error: error.message,
    }));
    reads.push({
      tabId,
      title: page.title || tab.title || '',
      url: page.url || tab.url || '',
      snippet: (page.bodyText || page.content || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      error: page.error || null,
    });
  }

  const listed = await bridge.sendCommand('browser_list_tabs', {});
  const report = {
    ok: true,
    label,
    sessionId,
    port: boundPort,
    groupTitle,
    closeSignalFile,
    tabs: reads,
    group: listed.group,
    openedAt: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  const hasTimeout = keepOpenMs > 0;
  const startedAt = Date.now();
  const ttlNote = hasTimeout ? ` or timeout after ${keepOpenMs}ms` : '';
  console.error(`[cic-demo:${label}] holding open; close with: touch '${closeSignalFile}'${ttlNote}`);
  while (!hasTimeout || Date.now() - startedAt < keepOpenMs) {
    if (fs.existsSync(closeSignalFile)) {
      break;
    }
    await delay(1000);
  }

  const reason = fs.existsSync(closeSignalFile) ? 'close_signal' : 'timeout';
  const closeResult = await shutdown(reason);
  console.log(JSON.stringify({ ok: true, label, sessionId, closeResult }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(`[cic-demo:${label}] ${error.stack || error.message}`);
  await shutdown('error').catch(() => {});
  process.exit(1);
}

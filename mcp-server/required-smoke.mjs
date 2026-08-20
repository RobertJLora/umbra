import process from 'node:process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';
import { FileDownloadLedger } from './download-ledger.mjs';

const DOWNLOAD_DIR = '/Users/RobertLora/Documents/Downloads';
const PORT_A = Number(process.env.UMBRA_REQUIRED_PORT_A || 47829);
const PORT_B = Number(process.env.UMBRA_REQUIRED_PORT_B || (PORT_A + 1));
const timeoutMs = Number(process.env.UMBRA_SMOKE_TIMEOUT_MS || 30000);

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

function assertSmoke(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function startFixtureServer(downloadName) {
  const pages = {
    '/session-a-one': {
      title: 'Codex Required Smoke A1',
      body: 'Session A owns tab one.',
    },
    '/session-a-two': {
      title: 'Codex Required Smoke A2',
      body: 'Session A owns tab two.',
    },
    '/session-b-one': {
      title: 'Codex Required Smoke B1',
      body: 'Session B owns its own tab.',
    },
    '/downloads': {
      title: 'Codex Required Smoke Downloads',
      body: 'Download fixture page.',
    },
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === `/files/${downloadName}`) {
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${downloadName}"`,
      });
      response.end('session,tab,status\nb,download,ok\n');
      return;
    }

    const page = pages[url.pathname] ?? pages['/session-a-one'];
    const downloadLink = url.pathname === '/downloads'
      ? `<p><a id="csv-download" href="/files/${downloadName}" download="${downloadName}">Download CSV</a></p>`
      : '';

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${page.title}</title></head>
  <body>
    <main>
      <h1>${page.title}</h1>
      <p id="smoke-body">${page.body}</p>
      ${downloadLink}
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
    close: () => closeServer(server),
  };
}

function waitForAuthenticatedBridge(bridge, label) {
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

async function waitForDownload(filePath) {
  const ledger = new FileDownloadLedger({ downloadDir: DOWNLOAD_DIR });
  return await ledger.waitForExact({
    filename: path.basename(filePath),
    timeoutMs,
  });
}

async function closeOwnedTabs(bridge, tabIds) {
  for (const tabId of tabIds.filter(Boolean)) {
    await bridge.sendCommand('browser_close_tab', { tabId }).catch(() => {});
  }
}

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const downloadName = `codex-bridge-required-smoke-${stamp}.csv`;
const downloadPath = path.join(DOWNLOAD_DIR, downloadName);
const bridgeA = new LocalBridgeServer({
  sharedKey: SHARED_KEY,
  sessionId: 'sess_required_alpha',
  portStart: PORT_A,
  portEnd: PORT_A,
});
const bridgeB = new LocalBridgeServer({
  sharedKey: SHARED_KEY,
  sessionId: 'sess_required_beta',
  portStart: PORT_B,
  portEnd: PORT_B,
});

let fixture = null;
const tabsA = [];
const tabsB = [];

try {
  fixture = await startFixtureServer(downloadName);
  const portA = await bridgeA.start();
  const portB = await bridgeB.start();
  console.error(`[required-smoke] bridge A listening on 127.0.0.1:${portA}`);
  console.error(`[required-smoke] bridge B listening on 127.0.0.1:${portB}`);
  console.error(`[required-smoke] fixture listening on ${fixture.baseUrl}`);

  await Promise.all([
    waitForAuthenticatedBridge(bridgeA, 'session A'),
    waitForAuthenticatedBridge(bridgeB, 'session B'),
  ]);
  console.error('[required-smoke] both sessions authenticated');

  const a1 = await bridgeA.sendCommand('browser_create_tab', {
    url: `${fixture.baseUrl}/session-a-one`,
    activate: false,
  });
  const a2 = await bridgeA.sendCommand('browser_create_tab', {
    url: `${fixture.baseUrl}/session-a-two`,
    activate: false,
  });
  const b1 = await bridgeB.sendCommand('browser_create_tab', {
    url: `${fixture.baseUrl}/session-b-one`,
    activate: false,
  });
  tabsA.push(a1.tabId, a2.tabId);
  tabsB.push(b1.tabId);

  const [aTabs, bTabs, aPage, bPage] = await Promise.all([
    bridgeA.sendCommand('browser_list_tabs', {}),
    bridgeB.sendCommand('browser_list_tabs', {}),
    bridgeA.sendCommand('browser_get_page_content', { tabId: a1.tabId, format: 'text' }),
    bridgeB.sendCommand('browser_get_page_content', { tabId: b1.tabId, format: 'text' }),
  ]);

  assertSmoke(aTabs.tabs.length === 2, `Expected session A to own 2 tabs, saw ${aTabs.tabs.length}.`);
  assertSmoke(bTabs.tabs.length === 1, `Expected session B to own 1 tab, saw ${bTabs.tabs.length}.`);
  assertSmoke(aPage.title === 'Codex Required Smoke A1', 'Session A read the wrong page.');
  assertSmoke(bPage.title === 'Codex Required Smoke B1', 'Session B read the wrong page.');

  let crossSessionDenied = false;
  try {
    await bridgeA.sendCommand('browser_switch_tab', { tabId: b1.tabId });
  } catch (error) {
    crossSessionDenied = /not owned|does not own|already owned/.test(error.message);
  }
  assertSmoke(crossSessionDenied, 'Session A was able to operate on session B tab.');

  const downloadTab = await bridgeB.sendCommand('browser_create_tab', {
    url: `${fixture.baseUrl}/downloads`,
    activate: false,
  });
  tabsB.push(downloadTab.tabId);
  await bridgeB.sendCommand('browser_click', {
    tabId: downloadTab.tabId,
    selector: '#csv-download',
  });
  const downloaded = await waitForDownload(downloadPath);

  await closeOwnedTabs(bridgeA, tabsA);
  await closeOwnedTabs(bridgeB, tabsB);
  tabsA.length = 0;
  tabsB.length = 0;

  console.log(JSON.stringify({
    ok: true,
    sessions: [
      {
        sessionId: 'sess_required_alpha',
        port: portA,
        ownedTabCount: aTabs.tabs.length,
        tabTitles: aTabs.tabs.map((tab) => tab.title),
      },
      {
        sessionId: 'sess_required_beta',
        port: portB,
        ownedTabCount: bTabs.tabs.length,
        tabTitles: bTabs.tabs.map((tab) => tab.title),
      },
    ],
    totalTabsOpened: 3,
    crossSessionDenied,
    download: {
      filename: downloadName,
      path: downloaded.path,
      bytes: downloaded.bytes,
    },
  }, null, 2));

  await fixture.close();
  fixture = null;
  await bridgeA.stop();
  await bridgeB.stop();
  await delay(25);
  process.exit(0);
} catch (error) {
  console.error(`[required-smoke] ${error.stack || error.message}`);
  await closeOwnedTabs(bridgeA, tabsA);
  await closeOwnedTabs(bridgeB, tabsB);
  await fixture?.close().catch(() => {});
  await bridgeA.stop().catch(() => {});
  await bridgeB.stop().catch(() => {});
  process.exit(1);
}

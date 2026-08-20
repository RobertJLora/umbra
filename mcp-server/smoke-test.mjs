import process from 'node:process';
import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionId } from './auth.js';
import { LocalBridgeServer } from './bridge-core.js';
import { resolveSharedKeyPath } from './config.js';

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

const bridge = new LocalBridgeServer({
  sharedKey: SHARED_KEY,
  sessionId: createSessionId(),
  portStart: Number(process.env.UMBRA_PORT_START || 47821),
  portEnd: Number(process.env.UMBRA_PORT_END || 47852),
});

const timeoutMs = Number(process.env.UMBRA_SMOKE_TIMEOUT_MS || 15000);
const groupTitle = `Umbra Smoke ${process.pid}`;

function assertSmoke(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function startFixtureServer() {
  const pages = {
    '/initial': {
      title: 'Codex Bridge Smoke Initial',
      body: 'Initial smoke page loaded.',
    },
    '/navigated': {
      title: 'Codex Bridge Smoke Navigated',
      body: 'Smoke body text OK after navigation.',
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

function waitForAuthenticatedBridge() {
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

let fixture = null;
let smokeTabId = null;
let smokeTabIds = [];

try {
  fixture = await startFixtureServer();
  const port = await bridge.start();
  console.error(`[smoke] bridge listening on 127.0.0.1:${port}`);
  console.error(`[smoke] fixture listening on ${fixture.baseUrl}`);
  await waitForAuthenticatedBridge();
  console.error('[smoke] extension authenticated');

  const created = await bridge.sendCommand('browser_create_tab', {
    url: `${fixture.baseUrl}/initial`,
    activate: true,
    groupTitle,
  });
  smokeTabId = created.tabId ?? created.id;
  smokeTabIds.push(smokeTabId);
  assertSmoke(Number.isInteger(smokeTabId), 'browser_create_tab did not return a numeric tabId.');

  const createdSecond = await bridge.sendCommand('browser_create_tab', {
    url: `${fixture.baseUrl}/initial?second=1`,
    activate: false,
    groupTitle,
  });
  const secondTabId = createdSecond.tabId ?? createdSecond.id;
  smokeTabIds.push(secondTabId);
  assertSmoke(Number.isInteger(secondTabId), 'second browser_create_tab did not return a numeric tabId.');

  const tabs = await bridge.sendCommand('browser_list_tabs', {});
  assertSmoke(
    tabs.tabs?.some((tab) => (tab.tabId ?? tab.id) === smokeTabId),
    'browser_list_tabs did not include the session-owned smoke tab.',
  );
  assertSmoke(
    tabs.tabs?.some((tab) => (tab.tabId ?? tab.id) === secondTabId),
    'browser_list_tabs did not include the second session-owned smoke tab.',
  );

  const navigated = await bridge.sendCommand('browser_navigate', {
    tabId: smokeTabId,
    url: `${fixture.baseUrl}/navigated`,
    groupTitle,
  });
  assertSmoke((navigated.url || '').includes('/navigated'), 'browser_navigate did not reach the fixture URL.');

  const tabsBeforeImplicitNavigate = await bridge.sendCommand('browser_list_tabs', {});
  const implicitNavigateTab = tabsBeforeImplicitNavigate.tabs?.find((tab) => (tab.tabId ?? tab.id) === smokeTabId);
  assertSmoke(implicitNavigateTab, 'browser_list_tabs did not include the explicit navigate tab before implicit navigation.');
  const implicitNavigateWindowId = implicitNavigateTab.windowId;

  const implicitNavigated = await bridge.sendCommand('browser_navigate', {
    url: `${fixture.baseUrl}/navigated?implicit=1`,
    groupTitle,
  });
  const implicitNavigatedAgain = await bridge.sendCommand('browser_navigate', {
    url: `${fixture.baseUrl}/navigated?implicit=2`,
    groupTitle,
  });
  const tabsAfterImplicitNavigate = await bridge.sendCommand('browser_list_tabs', {});
  assertSmoke(
    (implicitNavigated.tabId ?? implicitNavigated.id) === smokeTabId
      && (implicitNavigatedAgain.tabId ?? implicitNavigatedAgain.id) === smokeTabId,
    'browser_navigate without tabId/newTab did not reuse the existing active session tab.',
  );
  assertSmoke(
    tabsAfterImplicitNavigate.tabs.length === tabsBeforeImplicitNavigate.tabs.length,
    'browser_navigate without tabId/newTab increased the session tab count.',
  );
  assertSmoke(
    implicitNavigated.windowId === implicitNavigateWindowId
      && implicitNavigatedAgain.windowId === implicitNavigateWindowId,
    'browser_navigate without tabId/newTab moved navigation to a different window.',
  );

  const page = await bridge.sendCommand('browser_get_page_content', {
    tabId: smokeTabId,
    format: 'text',
  });
  const bodyText = page.bodyText || page.content || '';
  assertSmoke(
    page.title === 'Codex Bridge Smoke Navigated',
    `browser_get_page_content returned the wrong title: ${JSON.stringify({
      title: page.title,
      url: page.url,
      bodyText: bodyText.slice(0, 120),
    })}`,
  );
  assertSmoke(
    bodyText.includes('Smoke body text OK after navigation.'),
    'browser_get_page_content did not return the expected body text.',
  );
  assertSmoke(
    !Array.isArray(page.renderedImages) || page.renderedImages.length === 0,
    'browser_get_page_content should default to text-only reads without rendered images.',
  );

  const pressure = await bridge.sendCommand('browser_get_bridge_pressure', {
    includePerformance: false,
  });
  assertSmoke(pressure.ownedTabCount >= 2, 'browser_get_bridge_pressure did not report owned smoke tabs.');
  assertSmoke(
    pressure.extension?.connectedCount >= 1,
    'browser_get_bridge_pressure did not include extension connection pressure signals.',
  );

  const freezePreview = await bridge.sendCommand('browser_freeze_session_tabs', {
    dryRun: true,
  });
  assertSmoke(freezePreview.dryRun === true, 'browser_freeze_session_tabs should default to dry-run preview semantics.');
  assertSmoke(freezePreview.discardedTabCount === 0, 'dry-run freeze should not discard tabs.');

  const evaluated = await bridge.sendCommand('browser_run_page_action', {
    tabId: smokeTabId,
    action: 'element_positions',
    params: { headings: ['Codex Bridge Smoke Navigated'] },
  });
  assertSmoke(evaluated.ok === true, `browser_run_page_action did not return ok=true: ${JSON.stringify(evaluated)}`);
  assertSmoke(
    Number.isInteger(evaluated.result?.viewport?.w),
    'browser_run_page_action did not return JSON-safe viewport data.',
  );

  const closedSession = await bridge.sendCommand('browser_close_session_tabs', {});
  assertSmoke(closedSession.closedTabCount >= 2, 'browser_close_session_tabs did not close the owned smoke tabs.');
  const tabsAfterClose = await bridge.sendCommand('browser_list_tabs', {});
  assertSmoke(tabsAfterClose.tabs.length === 0, 'browser_close_session_tabs left owned tabs visible.');
  assertSmoke(tabsAfterClose.group === null, 'browser_close_session_tabs left a session group attached.');
  const staleGroupProbe = await bridge.sendCommand('browser_cleanup_groups', {
    title: groupTitle,
    dryRun: true,
    mode: 'closeTabs',
  });
  assertSmoke(staleGroupProbe.matchedGroupCount === 0, 'browser_close_session_tabs left a stale visible Chrome group.');

  console.log(JSON.stringify({
    ok: true,
    tabIds: smokeTabIds,
    createTab: {
      title: created.title,
      url: created.url,
    },
    ownedTabCount: tabs.tabs.length,
    navigate: {
      title: navigated.title,
      url: navigated.url,
    },
    read: {
      title: page.title,
      url: page.url,
      bodyTextIncludesFixture: true,
    },
    pageAction: {
      action: evaluated.action,
      viewport: evaluated.result.viewport,
    },
    pressure: {
      ownedTabCount: pressure.ownedTabCount,
      connectedCount: pressure.extension?.connectedCount ?? null,
      pressure: pressure.pressure,
    },
    freezePreview: {
      candidateTabCount: freezePreview.candidateTabCount,
      skippedCount: freezePreview.skipped.length,
    },
    closeSessionTabs: closedSession,
    groupCleanup: staleGroupProbe,
  }, null, 2));

  await fixture.close();
  fixture = null;
  smokeTabId = null;
  smokeTabIds = [];
  await bridge.stop();
  await delay(25);
  process.exit(0);
} catch (error) {
  console.error(`[smoke] ${error.stack || error.message}`);
  if (bridge.registry.isConnected()) {
    await bridge.sendCommand('browser_close_session_tabs', {}).catch(async () => {
      for (const tabId of smokeTabIds) {
        await bridge.sendCommand('browser_close_tab', { tabId }).catch(() => {});
      }
    });
  }
  await fixture?.close().catch(() => {});
  await bridge.stop().catch(() => {});
  process.exit(1);
}

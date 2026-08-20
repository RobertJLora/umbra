import process from 'node:process';
import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';
import { resolveSharedKeyPath } from './config.js';

const PORT_START = Number(process.env.UMBRA_STRESS_PORT_START || 47829);
const SESSION_COUNT = Number(process.env.UMBRA_STRESS_SESSIONS || 3);
const TABS_PER_SESSION = Number(process.env.UMBRA_STRESS_TABS || 5);
const KEEP_OPEN_MS = Number(process.env.UMBRA_STRESS_KEEP_OPEN_MS || 0);
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

// Mirrors `sessionLabel` in extension/background.js. If that prefix changes,
// this assertion has to change with it or every stress run fails on a title
// mismatch that has nothing to do with tab grouping.
function expectedGroupTitle(sessionId) {
  const parts = String(sessionId).split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const tail = parts.at(-1) || String(sessionId);
  const readable = tail.length > 12 ? tail.slice(-6) : tail;
  return `Bridge ${readable}`;
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

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const sessionSlug = parts[0] || 'unknown';
    const tabNumber = parts[1] || '0';
    const title = `Codex Group Stress ${sessionSlug.toUpperCase()} Tab ${tabNumber}`;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <main>
      <h1>${title}</h1>
      <p id="session">session=${sessionSlug}</p>
      <p id="tab">tab=${tabNumber}</p>
      <p id="marker">codex-group-stress-ok</p>
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

async function closeOwnedTabs(bridge, tabIds) {
  for (const tabId of tabIds.filter(Boolean)) {
    await bridge.sendCommand('browser_close_tab', { tabId }).catch(() => {});
  }
}

const labels = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
const fixture = await startFixtureServer();
const sessions = Array.from({ length: SESSION_COUNT }, (_, index) => {
  const label = labels[index] || `s${index + 1}`;
  const port = PORT_START + index;
  const sessionId = `sess_group_${label}`;
  return {
    label,
    sessionId,
    port,
    bridge: new LocalBridgeServer({
      sharedKey: SHARED_KEY,
      sessionId,
      portStart: port,
      portEnd: port,
      requestTimeoutMs: timeoutMs,
    }),
    tabs: [],
  };
});

try {
  await Promise.all(sessions.map(async (session) => {
    await session.bridge.start();
    console.error(`[group-stress] ${session.sessionId} listening on 127.0.0.1:${session.port}`);
  }));

  await Promise.all(sessions.map((session) => waitForAuthenticatedBridge(session.bridge, session.sessionId)));
  console.error(`[group-stress] authenticated ${sessions.length} sessions`);

  for (const session of sessions) {
    for (let tabIndex = 1; tabIndex <= TABS_PER_SESSION; tabIndex += 1) {
      const created = await session.bridge.sendCommand('browser_create_tab', {
        url: `${fixture.baseUrl}/${session.label}/${tabIndex}`,
        activate: false,
      });
      session.tabs.push(created.tabId ?? created.id);
    }
  }

  const listed = await Promise.all(sessions.map(async (session) => ({
    session,
    state: await session.bridge.sendCommand('browser_list_tabs', {}),
  })));

  for (const { session, state } of listed) {
    assertSmoke(state.sessionId === session.sessionId, `List response returned wrong session for ${session.sessionId}.`);
    assertSmoke(state.group, `Missing Chrome tab group for ${session.sessionId}.`);
    assertSmoke(state.tabs.length === TABS_PER_SESSION, `${session.sessionId} expected ${TABS_PER_SESSION} tabs, saw ${state.tabs.length}.`);
    assertSmoke(
      state.tabs.every((tab) => tab.groupId === state.group.groupId),
      `${session.sessionId} has tabs outside its reported group.`,
    );
    assertSmoke(
      state.group.title === expectedGroupTitle(session.sessionId),
      `${session.sessionId} group title mismatch: ${state.group.title}`,
    );
  }

  const contentReads = await Promise.all(sessions.flatMap((session) => (
    session.tabs.map((tabId, index) => session.bridge.sendCommand('browser_get_page_content', {
      tabId,
      format: 'text',
    }).then((page) => ({ session, tabId, tabNumber: index + 1, page })))
  )));

  for (const read of contentReads) {
    assertSmoke(
      read.page.title === `Codex Group Stress ${read.session.label.toUpperCase()} Tab ${read.tabNumber}`,
      `Wrong title for ${read.session.sessionId} tab ${read.tabNumber}.`,
    );
    assertSmoke(
      (read.page.bodyText || read.page.content || '').includes('codex-group-stress-ok'),
      `Missing body marker for ${read.session.sessionId} tab ${read.tabNumber}.`,
    );
  }

  let crossSessionDenials = 0;
  for (let index = 0; index < sessions.length; index += 1) {
    const actor = sessions[index];
    const target = sessions[(index + 1) % sessions.length];
    try {
      await actor.bridge.sendCommand('browser_get_page_content', {
        tabId: target.tabs[0],
        format: 'text',
      });
    } catch (error) {
      if (/not owned|does not own|already owned/.test(error.message)) {
        crossSessionDenials += 1;
      } else {
        throw error;
      }
    }
  }
  assertSmoke(crossSessionDenials === sessions.length, `Expected ${sessions.length} cross-session denials, saw ${crossSessionDenials}.`);

  if (KEEP_OPEN_MS > 0) {
    console.error(`[group-stress] keeping groups open for ${KEEP_OPEN_MS}ms`);
    await delay(KEEP_OPEN_MS);
  }

  for (const session of sessions) {
    await closeOwnedTabs(session.bridge, session.tabs);
    session.tabs.length = 0;
  }

  console.log(JSON.stringify({
    ok: true,
    sessionCount: sessions.length,
    tabsPerSession: TABS_PER_SESSION,
    totalTabsOpened: sessions.length * TABS_PER_SESSION,
    crossSessionDenials,
    groups: listed.map(({ session, state }) => ({
      sessionId: session.sessionId,
      port: session.port,
      group: state.group,
      tabCount: state.tabs.length,
      tabTitles: state.tabs.map((tab) => tab.title),
    })),
  }, null, 2));

  await fixture.close();
  await Promise.all(sessions.map((session) => session.bridge.stop()));
  await delay(25);
  process.exit(0);
} catch (error) {
  console.error(`[group-stress] ${error.stack || error.message}`);
  await Promise.all(sessions.map((session) => closeOwnedTabs(session.bridge, session.tabs)));
  await fixture.close().catch(() => {});
  await Promise.all(sessions.map((session) => session.bridge.stop().catch(() => {})));
  process.exit(1);
}

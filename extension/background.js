import { ensureInstallId, loadBridgeConfig, saveBridgeConfig } from './shared.js';
import { serializeJavascriptResult } from './javascript-safety.js';
import { SessionStateStore } from './session-state.js';

const GROUP_COLORS = ['blue', 'green', 'yellow', 'pink', 'purple', 'cyan', 'orange'];
const DEFAULT_GROUP_COLOR = 'cyan';
const BRIDGE_WAKE_ALARM_NAME = 'umbra_bridge_wake';
const BRIDGE_WAKE_PERIOD_MINUTES = 1;
const DEDICATED_WINDOW_STORAGE_KEY = 'bridgeDedicatedWindowId';
const TAB_COMPLETE_POLL_INTERVAL_MS = 750;
const CONTENT_AGENT_PORT_NAME = 'cic-content-agent';
const CONTENT_AGENT_SCRIPT = 'content-agent.js';
const AX_TREE_SCRIPT = 'ax-tree.js';
const CONTENT_AGENT_READY_TIMEOUT_MS = 2_000;
const CONTENT_AGENT_COMMAND_TIMEOUT_MS = 120_000;
const READ_CACHE_TTL_MS = 1_500;
const FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX = 16_000;
const CONSOLE_MESSAGE_CAP = 200;
const SCREENSHOT_STITCH_SETTLE_MS = 120;
const consoleBuffers = new Map();
const sessionStore = new SessionStateStore();
// One session-state read per worker lifetime, started at module scope so it is
// already in flight before any message arrives. Everything that touches
// sessionStore awaits this promise first, which is what stops a message-woken
// worker from persisting an empty map over stored tab ownership and then
// reading the wiped state back. A rejected load resolves here so callers are
// never blocked; SessionStateStore refuses to persist until a load succeeded.
const sessionStoreReady = sessionStore.load().catch((error) => {
  console.error('[bridge] session state load failed', error);
  return sessionStore;
});
const contentAgents = new Map();
// tabId -> { refCount, attachPromise }. Chrome allows one debugger client per
// target, so every Umbra call on a tab shares a single attachment.
const tabDebuggerAttachments = new Map();
const readCache = new Map();
let initializePromise = null;
let bootstrapped = false;
let nextContentAgentRequestId = 1;

function sessionLabel(sessionId) {
  const parts = String(sessionId).split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const tail = parts.at(-1) || String(sessionId);
  const readable = tail.length > 12 ? tail.slice(-6) : tail;
  return `Bridge ${readable}`;
}

function sessionColor(sessionId) {
  return DEFAULT_GROUP_COLOR;
}

function buildGroupUpdate(sessionId, params = {}, { includeDefaults = false } = {}) {
  const update = {};
  const requestedTitle = typeof params.title === 'string' ? params.title : params.groupTitle;
  const requestedColor = params.color || params.groupColor;
  const requestedCollapsed =
    typeof params.collapsed === 'boolean'
      ? params.collapsed
      : typeof params.groupCollapsed === 'boolean'
        ? params.groupCollapsed
        : undefined;

  if (typeof requestedTitle === 'string' && requestedTitle.trim()) {
    update.title = requestedTitle.trim().slice(0, 80);
  } else if (includeDefaults) {
    update.title = sessionLabel(sessionId);
  }

  if (GROUP_COLORS.includes(requestedColor)) {
    update.color = requestedColor;
  } else if (includeDefaults) {
    update.color = sessionColor(sessionId);
  }

  if (typeof requestedCollapsed === 'boolean') {
    update.collapsed = requestedCollapsed;
  } else if (includeDefaults) {
    update.collapsed = true;
  }

  return update;
}

async function updateTabGroup(sessionId, groupId, params = {}, options = {}) {
  const update = buildGroupUpdate(sessionId, params, options);
  if (Object.keys(update).length > 0) {
    await chrome.tabGroups.update(groupId, update);
  }
}

function serializeError(error, fallbackCode = 'bridge_error') {
  return {
    code: error?.code || fallbackCode,
    message: error?.message || 'Bridge command failed.',
  };
}

function readCacheKey(sessionId, tabId, kind, options = {}, domVersion = null) {
  return JSON.stringify({
    sessionId,
    tabId,
    kind,
    domVersion,
    options,
  });
}

function getReadCache(key) {
  const entry = readCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.createdAt > READ_CACHE_TTL_MS) {
    readCache.delete(key);
    return null;
  }
  return {
    ...entry.result,
    cache: {
      hit: true,
      ttlMs: READ_CACHE_TTL_MS,
      cachedAt: entry.createdAt,
    },
  };
}

function setReadCache(key, result) {
  readCache.set(key, {
    createdAt: Date.now(),
    result,
  });
}

function invalidateTabReadCache(tabId) {
  for (const key of [...readCache.keys()]) {
    if (key.includes(`"tabId":${tabId}`)) {
      readCache.delete(key);
    }
  }
}

function getConsoleBuffer(tabId) {
  if (!consoleBuffers.has(tabId)) {
    consoleBuffers.set(tabId, { lastNavTs: 0, messages: [] });
  }
  return consoleBuffers.get(tabId);
}

function pushConsoleMessage(tabId, message) {
  const level = message?.level === 'warning' || message?.level === 'error' || message?.level === 'debug'
    ? message.level
    : 'info';
  const entry = {
    level,
    text: String(message?.text || '').slice(0, 2000),
    ts: Number(message?.ts) || Date.now(),
  };
  const buffer = getConsoleBuffer(tabId);
  const duplicate = buffer.messages.some((existing) => (
    existing.ts === entry.ts && existing.level === entry.level && existing.text === entry.text
  ));
  if (duplicate) {
    return;
  }
  buffer.messages.push(entry);
  if (buffer.messages.length > CONSOLE_MESSAGE_CAP) {
    buffer.messages.splice(0, buffer.messages.length - CONSOLE_MESSAGE_CAP);
  }
}

function markConsoleNavigation(tabId) {
  getConsoleBuffer(tabId).lastNavTs = Date.now();
}

function filterConsoleMessages(tabId, { level = 'info', all = false } = {}) {
  const ranks = { debug: 10, info: 20, warning: 30, error: 40 };
  const requested = ranks[level] ? level : 'info';
  const minRank = ranks[requested];
  const buffer = getConsoleBuffer(tabId);
  return buffer.messages
    .filter((message) => (ranks[message.level] || 20) >= minRank)
    .filter((message) => all || message.ts >= buffer.lastNavTs)
    .slice(-CONSOLE_MESSAGE_CAP);
}

function invalidateSessionReadCache(sessionId) {
  for (const key of [...readCache.keys()]) {
    if (key.includes(`"sessionId":"${sessionId}"`)) {
      readCache.delete(key);
    }
  }
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function safeGetWindow(windowId) {
  if (!Number.isInteger(windowId)) {
    return null;
  }

  try {
    return await chrome.windows.get(windowId);
  } catch {
    return null;
  }
}

function isNormalWindow(window) {
  return Boolean(window && window.type === 'normal');
}

function isNonNormalWindowError(error) {
  const message = String(error?.message || '');
  return /only be moved to and from normal windows/i.test(message)
    || /Grouping is not supported by tabs in this window/i.test(message);
}

async function getNormalWindow(windowId) {
  const window = await safeGetWindow(windowId);
  return isNormalWindow(window) ? window : null;
}

async function listNormalWindows() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return (windows || []).filter(isNormalWindow);
}

async function getStoredDedicatedWindowId() {
  const { [DEDICATED_WINDOW_STORAGE_KEY]: windowId } = await chrome.storage.local.get({
    [DEDICATED_WINDOW_STORAGE_KEY]: null,
  });
  return Number.isInteger(windowId) ? windowId : null;
}

async function rememberDedicatedWindowId(windowId) {
  if (Number.isInteger(windowId)) {
    await chrome.storage.local.set({ [DEDICATED_WINDOW_STORAGE_KEY]: windowId });
  }
}

async function clearDedicatedWindowId(windowId = null) {
  const storedWindowId = await getStoredDedicatedWindowId();
  if (windowId === null || storedWindowId === windowId) {
    await chrome.storage.local.remove(DEDICATED_WINDOW_STORAGE_KEY);
  }
}

async function bridgeIsConfigured() {
  const config = await loadBridgeConfig();
  return config.bridgeEnabled === true && Boolean(config.sharedKey);
}

async function closeOffscreenDocument() {
  if (!chrome.offscreen?.closeDocument) {
    return;
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed, or never created on this install.
  }
}

async function ensureOffscreenDocument() {
  // A fresh install has no shared key, so there is nothing for the scanner to
  // connect to. Creating the document anyway left a permanently resident page
  // ticking every two seconds, which pinned the service worker awake and wrote
  // to chrome.storage.local continuously while doing no work.
  if (!(await bridgeIsConfigured())) {
    await closeOffscreenDocument();
    await chrome.storage.local.set({
      bridgeDebug: {
        updatedAt: Date.now(),
        state: 'bridge_not_configured',
        message: 'Set a shared key in the Umbra options page to start the local bridge scanner.',
      },
    });
    return;
  }

  if (!chrome.offscreen?.createDocument) {
    await chrome.storage.local.set({
      bridgeDebug: {
        updatedAt: Date.now(),
        state: 'offscreen_unavailable',
        message: 'chrome.offscreen.createDocument is unavailable in this Chrome context.',
      },
    });
    return;
  }

  const url = chrome.runtime.getURL('offscreen.html');
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (contexts.length > 0) {
      return;
    }
  }

  try {
    // No Reason enum value covers holding a raw WebSocket. DOM_SCRAPING is the
    // closest available value and the justification below is the accurate
    // description of what the document does. Moving the connection loop into a
    // worker instead would put a postMessage relay on the round trip of every
    // tool call, which is the opposite of what this document exists for.
    // scripts/configure-extension-cdp.mjs repeats this declaration; keep both
    // in step so the repository never states two different reasons.
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: 'Maintain authenticated loopback WebSocket connections to local bridge sessions.',
    });
    await chrome.storage.local.set({
      bridgeDebug: {
        updatedAt: Date.now(),
        state: 'offscreen_created',
        message: 'Created offscreen document successfully.',
      },
    });
  } catch (error) {
    const message = error?.message || 'Unknown offscreen creation error.';
    if (message.includes('Only a single offscreen document may be created')) {
      await chrome.storage.local.set({
        bridgeDebug: {
          updatedAt: Date.now(),
          state: 'offscreen_exists',
          message,
        },
      });
      return;
    }

    await chrome.storage.local.set({
      bridgeDebug: {
        updatedAt: Date.now(),
        state: 'offscreen_create_failed',
        message,
      },
    });
    throw error;
  }
}

async function ensureBridgeWakeAlarm() {
  if (!chrome.alarms?.create) {
    await chrome.storage.local.set({
      bridgeDebug: {
        updatedAt: Date.now(),
        state: 'alarms_unavailable',
        message: 'chrome.alarms is unavailable; offscreen scanner will rely on startup/install events only.',
      },
    });
    return;
  }

  await chrome.alarms.create(BRIDGE_WAKE_ALARM_NAME, {
    periodInMinutes: BRIDGE_WAKE_PERIOD_MINUTES,
  });
}

async function waitForOffscreenDocumentClosed(url, timeoutMs = 2_000) {
  if (!chrome.runtime.getContexts) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (contexts.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function restartOffscreenDocument() {
  await chrome.storage.local.set({
    bridgeStatus: { connectedCount: 0, ports: [], sessions: [], updatedAt: Date.now() },
    bridgeDebug: {
      updatedAt: Date.now(),
      state: 'offscreen_restarting',
      message: 'Restarting offscreen bridge scanner.',
    },
  });

  const url = chrome.runtime.getURL('offscreen.html');
  if (chrome.offscreen?.closeDocument) {
    await closeOffscreenDocument();
    await waitForOffscreenDocumentClosed(url);
  }

  // bridge_save_config reaches this on every save, including the save that
  // cleared the key or unchecked the enable toggle. ensureOffscreenDocument
  // reads the configuration again, so an unconfigured install ends up with the
  // document closed instead of immediately recreated.
  await ensureOffscreenDocument();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (!changes.sharedKey && !changes.bridgeEnabled) {
    return;
  }
  bridgeIsConfigured()
    .then((configured) => (configured ? undefined : closeOffscreenDocument()))
    .catch((error) => console.error('[bridge] config change handling failed', error));
});

function tabUrlMatchesExpected(actualUrl, expectedUrl) {
  if (!expectedUrl) {
    return true;
  }
  if (!actualUrl) {
    return false;
  }
  try {
    return new URL(actualUrl).href === new URL(expectedUrl).href;
  } catch {
    return actualUrl === expectedUrl;
  }
}

function clampTimeoutMs(value, fallback = 45_000, max = 180_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 1_000), max);
}

async function waitForTabComplete(tabId, timeoutMs = 45_000, expectedUrl = '', options = {}) {
  const existing = await safeGetTab(tabId);
  if (!existing) {
    return { timedOut: false, tabId };
  }

  // The URL the tab held before the navigation was requested. A load that ends
  // anywhere other than here counts as arrived, which is what lets an http to
  // https upgrade, an added tracking parameter, a login bounce, or a path
  // normalization settle instead of burning the whole timeout on an
  // href-identical match that never comes.
  const preNavUrl = existing.url || '';
  const arrived = (url) => tabUrlMatchesExpected(url, expectedUrl) || url !== preNavUrl;
  // chrome.tabs.update resolves before the tab leaves `complete` on the old
  // document, so a caller that just asked for the URL the tab already sits on
  // would otherwise get pre-navigation state handed straight back.
  if (existing.status === 'complete' && options.navigationPending !== true && tabUrlMatchesExpected(existing.url, expectedUrl)) {
    return { timedOut: false, tabId };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(listener);
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => resolve({ timedOut: true, tabId }));
    }, timeoutMs);

    const poll = setInterval(() => {
      safeGetTab(tabId)
        .then((tab) => {
          if (!tab || (tab.status === 'complete' && arrived(tab.url || ''))) {
            finish(() => resolve({ timedOut: false, tabId }));
          }
        })
        .catch(() => finish(() => resolve({ timedOut: false, tabId })));
    }, TAB_COMPLETE_POLL_INTERVAL_MS);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }

      safeGetTab(tabId)
        .then((tab) => {
          if (!tab || arrived(tab.url || '')) {
            finish(() => resolve({ timedOut: false, tabId }));
          }
        })
        .catch(() => finish(() => resolve({ timedOut: false, tabId })));
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function normalizeBridgeUrl(rawUrl = 'about:blank') {
  const value = String(rawUrl || 'about:blank').trim() || 'about:blank';
  if (value === 'about:blank') {
    return value;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value.slice(0, 120)}`);
  }

  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme for navigation: ${parsed.protocol}`);
  }

  return parsed.href;
}

async function ensureSessionGroup(sessionId, anchorTabId, groupOptions = {}) {
  const session = sessionStore.ensureSession(sessionId);
  const tab = await safeGetTab(anchorTabId);
  if (!tab) {
    return session.groupId;
  }
  if (!(await getNormalWindow(tab.windowId))) {
    return session.groupId;
  }

  if (session.groupId !== null) {
    try {
      await chrome.tabGroups.get(session.groupId);
      const groupId = await groupTabsInNormalWindow([anchorTabId], { groupId: session.groupId });
      await updateTabGroup(sessionId, groupId, groupOptions);
      sessionStore.setGroup(sessionId, groupId);
      return groupId;
    } catch {
      sessionStore.setGroup(sessionId, null);
    }
  }

  try {
    const groupId = await groupTabsInNormalWindow([anchorTabId]);
    await updateTabGroup(sessionId, groupId, groupOptions, { includeDefaults: true });
    sessionStore.setGroup(sessionId, groupId);
    await sessionStore.persist();
    return groupId;
  } catch (error) {
    if (isNonNormalWindowError(error)) {
      return session.groupId;
    }
    throw error;
  }
}

function normalizeTabIdList(tabIds) {
  if (!Array.isArray(tabIds)) {
    return [];
  }

  return [...new Set(tabIds.map((tabId) => Number(tabId)).filter((tabId) => Number.isInteger(tabId)))];
}

async function groupTabsInNormalWindow(tabIds, { groupId = null } = {}) {
  const ids = normalizeTabIdList(tabIds);
  if (ids.length === 0) {
    throw new Error('No tabs to group.');
  }

  const tabs = [];
  for (const tabId of ids) {
    const tab = await safeGetTab(tabId);
    if (tab) {
      tabs.push(tab);
    }
  }
  if (tabs.length === 0) {
    throw new Error('None of the tabs to group still exist.');
  }

  const liveIds = tabs.map((tab) => tab.id);
  const sourceWindowIds = [...new Set(tabs.map((tab) => tab.windowId).filter((id) => Number.isInteger(id)))];
  for (const windowId of sourceWindowIds) {
    if (!(await getNormalWindow(windowId))) {
      throw new Error(`Tabs can only be grouped in a normal Chrome window. Window ${windowId} is Meet, app, or popup.`);
    }
  }

  let targetGroupId = Number.isInteger(groupId) ? groupId : null;
  let homeWindowId = tabs[0].windowId;
  if (targetGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(targetGroupId);
      const groupWindow = await getNormalWindow(group.windowId);
      if (!groupWindow) {
        targetGroupId = null;
      } else {
        homeWindowId = group.windowId;
      }
    } catch {
      targetGroupId = null;
    }
  } else if (!(await getNormalWindow(homeWindowId))) {
    throw new Error(`Tabs can only be grouped in a normal Chrome window. Window ${homeWindowId} is Meet, app, or popup.`);
  }

  try {
    if (targetGroupId !== null) {
      return await chrome.tabs.group({ tabIds: liveIds, groupId: targetGroupId });
    }
    return await chrome.tabs.group({
      tabIds: liveIds,
      createProperties: { windowId: homeWindowId },
    });
  } catch (error) {
    if (!isNonNormalWindowError(error)) {
      throw error;
    }
    const fallbackWindow = await getNormalWindow(tabs[0].windowId);
    if (!fallbackWindow) {
      throw error;
    }
    const sameWindowIds = tabs
      .filter((tab) => tab.windowId === fallbackWindow.id)
      .map((tab) => tab.id);
    return await chrome.tabs.group({
      tabIds: sameWindowIds,
      createProperties: { windowId: fallbackWindow.id },
    });
  }
}

async function groupSessionTabs(sessionId, params = {}) {
  const session = sessionStore.ensureSession(sessionId);
  const requestedTabIds = normalizeTabIdList(params.tabIds);
  const tabIds = requestedTabIds.length > 0 ? requestedTabIds : sessionStore.listTabIds(sessionId);
  if (tabIds.length === 0) {
    throw new Error(`Session ${sessionId} does not own any tabs to group.`);
  }

  const tabs = [];
  for (const tabId of tabIds) {
    tabs.push(await getOwnedTab(sessionId, tabId));
  }

  let targetGroupId = Number.isInteger(params.groupId) ? params.groupId : session.groupId;
  if (params.newGroup === true) {
    targetGroupId = null;
  }

  if (targetGroupId !== null && targetGroupId !== undefined) {
    if (session.groupId !== targetGroupId) {
      throw new Error(`Group ${targetGroupId} is not owned by session ${sessionId}.`);
    }

    try {
      await chrome.tabGroups.get(targetGroupId);
    } catch {
      targetGroupId = null;
      sessionStore.setGroup(sessionId, null);
    }
  }

  const groupId = await groupTabsInNormalWindow(tabIds, {
    groupId: targetGroupId !== null && targetGroupId !== undefined ? targetGroupId : null,
  });

  await updateTabGroup(sessionId, groupId, params, {
    includeDefaults: targetGroupId === null || targetGroupId === undefined || params.newGroup === true,
  });

  sessionStore.setGroup(sessionId, groupId);
  if (!session.activeTabId || !tabIds.includes(session.activeTabId)) {
    sessionStore.setActiveTab(sessionId, tabs[0].id);
  }
  await sessionStore.persist();

  const group = await serializeSessionGroup(sessionId);
  const updatedTabs = [];
  for (const tabId of tabIds) {
    const tab = await safeGetTab(tabId);
    if (tab) {
      updatedTabs.push(await serializeTab(tab));
    }
  }

  return {
    sessionId,
    group,
    tabCount: updatedTabs.length,
    tabs: updatedTabs,
  };
}

async function cleanupGroups(params = {}) {
  const exactTitle = typeof params.title === 'string' ? params.title.trim() : '';
  const titlePrefix = typeof params.titlePrefix === 'string' ? params.titlePrefix.trim() : '';
  const mode = params.mode === 'ungroupOnly' ? 'ungroupOnly' : 'closeTabs';
  const dryRun = params.dryRun === true;
  const includeConnected = params.includeConnected === true;
  const maxGroups = Number.isInteger(params.maxGroups) && params.maxGroups > 0 ? Math.min(params.maxGroups, 50) : 12;

  if (!exactTitle && !titlePrefix) {
    throw new Error('Cleanup requires title or titlePrefix.');
  }

  const groups = await chrome.tabGroups.query({});
  const matches = groups
    .filter((group) => {
      const title = group.title || '';
      return exactTitle ? title === exactTitle : title.startsWith(titlePrefix);
    })
    .slice(0, maxGroups);

  const cleaned = [];
  const skipped = [];
  const connectedSessions = sessionStore.listSessions().filter((session) => session.connected);
  for (const group of matches) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const tabIds = tabs.map((tab) => tab.id).filter((tabId) => Number.isInteger(tabId));
    const connectedOwners = connectedSessions
      .filter((session) => session.groupId === group.id || tabIds.some((tabId) => session.tabIds.includes(tabId)))
      .map((session) => session.sessionId);

    if (connectedOwners.length > 0 && !includeConnected) {
      skipped.push({
        groupId: group.id,
        title: group.title || '',
        color: group.color || '',
        tabCount: tabIds.length,
        reason: 'connected_session',
        connectedOwners,
      });
      continue;
    }

    if (!dryRun && tabIds.length > 0) {
      if (mode === 'ungroupOnly') {
        await chrome.tabs.ungroup(tabIds);
      } else {
        for (const tabId of tabIds) {
          invalidateContentAgent(tabId, 'tab_closed');
        }
        await chrome.tabs.remove(tabIds);
      }
    }

    if (!dryRun) {
      for (const tabId of tabIds) {
        sessionStore.releaseTab(tabId);
      }
    }

    cleaned.push({
      groupId: group.id,
      title: group.title || '',
      color: group.color || '',
      mode,
      dryRun,
      tabCount: tabIds.length,
    });
  }

  if (!dryRun) {
    await sessionStore.persist();
  }
  return {
    matchedGroupCount: matches.length,
    cleanedGroupCount: cleaned.length,
    skippedGroupCount: skipped.length,
    cleanedTabCount: dryRun ? 0 : cleaned.reduce((sum, group) => sum + group.tabCount, 0),
    matchedTabCount: cleaned.reduce((sum, group) => sum + group.tabCount, 0) + skipped.reduce((sum, group) => sum + group.tabCount, 0),
    mode,
    dryRun,
    includeConnected,
    groups: cleaned,
    skippedGroups: skipped,
  };
}

async function closeOwnedSessionWindows(sessionId, tabIds) {
  const tabIdSet = new Set(tabIds);
  const closedWindowIds = [];
  const preservedWindows = [];
  const windowTabMap = new Map();
  const missingTabIds = [];

  for (const tabId of tabIdSet) {
    const tab = await safeGetTab(tabId);
    if (!tab) {
      invalidateContentAgent(tabId, 'missing_tab');
      sessionStore.releaseTab(tabId);
      missingTabIds.push(tabId);
      continue;
    }

    if (!windowTabMap.has(tab.windowId)) {
      windowTabMap.set(tab.windowId, []);
    }
    windowTabMap.get(tab.windowId).push(tab);
  }

  const closedTabIds = [];
  for (const [windowId, ownedTabs] of windowTabMap.entries()) {
    const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
    const allTabsOwnedBySession =
      tabs.length > 0 &&
      tabs.every((tab) => tabIdSet.has(tab.id) && sessionStore.findOwner(tab.id) === sessionId);

    if (allTabsOwnedBySession) {
      for (const tab of tabs) {
        invalidateContentAgent(tab.id, 'window_closed');
      }
      await chrome.windows.remove(windowId).catch(() => {});
      closedWindowIds.push(windowId);
      await clearDedicatedWindowId(windowId);
      for (const tab of tabs) {
        sessionStore.releaseTab(tab.id);
        closedTabIds.push(tab.id);
      }
      continue;
    }

    for (const tab of ownedTabs) {
      // The list came from this session's own record, but a stored map that
      // handed the same tab to two sessions would make that list a lie. Check
      // ownership against the map before removing anything, so a close can
      // never reach another session's tab.
      if (sessionStore.findOwner(tab.id) !== sessionId) {
        continue;
      }
      invalidateContentAgent(tab.id, 'tab_closed');
      await chrome.tabs.remove(tab.id);
      sessionStore.releaseTab(tab.id);
      closedTabIds.push(tab.id);
    }

    preservedWindows.push({
      windowId,
      tabCount: tabs.length,
      ownedTabCount: ownedTabs.length,
      unownedTabCount: Math.max(0, tabs.length - ownedTabs.length),
    });
  }

  return { closedTabIds, missingTabIds, closedWindowIds, preservedWindows };
}

async function closeSessionTabs(sessionId) {
  const tabIds = sessionStore.listTabIds(sessionId);
  const { closedTabIds, missingTabIds, closedWindowIds, preservedWindows } =
    await closeOwnedSessionWindows(sessionId, tabIds);

  const session = sessionStore.ensureSession(sessionId);
  session.groupId = null;
  session.activeTabId = null;
  await sessionStore.persist();

  return {
    sessionId,
    closed: true,
    closedTabIds,
    missingTabIds,
    closedWindowIds,
    preservedWindows,
    closedTabCount: closedTabIds.length,
    closedWindowCount: closedWindowIds.length,
  };
}

async function freezeSessionTabs(sessionId, params = {}) {
  const requestedTabIds = normalizeTabIdList(params.tabIds);
  const sourceTabIds = requestedTabIds.length > 0 ? requestedTabIds : sessionStore.listTabIds(sessionId);
  const maxTabs = Number.isInteger(params.maxTabs) && params.maxTabs > 0 ? Math.min(params.maxTabs, 50) : 20;
  const dryRun = params.dryRun !== false;
  const includeActive = params.includeActive === true;
  const candidates = [];
  const skipped = [];
  const discarded = [];

  for (const tabId of sourceTabIds) {
    sessionStore.assertOwned(sessionId, tabId);
    const tab = await safeGetTab(tabId);
    if (!tab) {
      sessionStore.releaseTab(tabId);
      skipped.push({ tabId, reason: 'missing' });
      continue;
    }

    if (tab.active && !includeActive) {
      skipped.push({ tabId, reason: 'active_tab' });
      continue;
    }

    if (tab.audible === true) {
      skipped.push({ tabId, reason: 'audible_tab' });
      continue;
    }

    if (tab.pinned === true) {
      skipped.push({ tabId, reason: 'pinned_tab' });
      continue;
    }

    if (tab.discarded === true) {
      skipped.push({ tabId, reason: 'already_discarded' });
      continue;
    }

    if (candidates.length >= maxTabs) {
      skipped.push({ tabId, reason: 'max_tabs' });
      continue;
    }

    const candidate = await serializeTab(tab);
    candidates.push(candidate);
    if (!dryRun) {
      if (typeof chrome.tabs.discard !== 'function') {
        skipped.push({ tabId, reason: 'discard_unavailable' });
        continue;
      }

      try {
        const discardedTab = await chrome.tabs.discard(tab.id);
        discarded.push(await serializeTab(discardedTab || tab));
      } catch (error) {
        skipped.push({
          tabId,
          reason: 'discard_failed',
          message: error?.message || 'Chrome could not discard this tab.',
        });
      }
    }
  }

  if (skipped.some((item) => item.reason === 'missing')) {
    await sessionStore.persist();
  }

  return {
    sessionId,
    dryRun,
    includeActive,
    warnings: [
      'Discarding a tab can force a reload when inspected again.',
      'Active, audible, pinned, missing, and already-discarded owned tabs are skipped by default.',
    ],
    requestedTabCount: sourceTabIds.length,
    candidateTabCount: candidates.length,
    discardedTabCount: discarded.length,
    candidates,
    discarded,
    skipped,
  };
}

async function getOwnedTab(sessionId, tabId) {
  sessionStore.assertOwned(sessionId, tabId);
  const tab = await safeGetTab(tabId);
  if (!tab) {
    invalidateContentAgent(tabId, 'missing_tab');
    sessionStore.releaseTab(tabId);
    await sessionStore.persist();
    throw new Error(`Owned tab ${tabId} no longer exists.`);
  }
  return tab;
}

// Returns the window new session tabs go into, or null when a fresh unfocused
// window has to be created instead.
//
// A focused window is never reused, including the stored dedicated one. That is
// the behaviour README, docs/architecture.md and the store description all
// describe, and it was the one part not implemented: the stored window was
// returned whenever it still existed, so tabs landed in whatever window the
// person was working in.
async function findBackgroundWindowId() {
  const storedId = await getStoredDedicatedWindowId();
  const stored = await getNormalWindow(storedId);
  if (stored && stored.focused !== true) {
    return stored.id;
  }
  if (!stored) {
    await clearDedicatedWindowId(storedId);
  }

  const windows = await listNormalWindows();
  const unfocused = windows.find((window) => window.focused !== true);
  if (!unfocused) {
    // Every candidate is focused, so there is nothing to reuse without adding
    // tabs to the window in use. The caller creates a fresh unfocused one.
    return null;
  }
  await rememberDedicatedWindowId(unfocused.id);
  return unfocused.id;
}

async function createDedicatedWindowWithTab({ url = 'about:blank', activate = false } = {}) {
  const createdWindow = await chrome.windows.create({
    url,
    focused: Boolean(activate),
    state: 'normal',
    type: 'normal',
  });
  if (!isNormalWindow(createdWindow)) {
    if (Number.isInteger(createdWindow?.id)) {
      await chrome.windows.remove(createdWindow.id).catch(() => {});
    }
    throw new Error('Chrome created a non-normal window. Umbra will not use Meet, app, or popup windows.');
  }
  const createdTab = createdWindow.tabs?.[0] ?? null;
  if (!createdTab?.id) {
    throw new Error('Chrome did not return a tab for the new Umbra window.');
  }

  await rememberDedicatedWindowId(createdWindow.id);

  return createdTab;
}

async function createSessionTab(_sessionId, { url = 'about:blank', activate = false, newWindow = false } = {}) {
  if (newWindow === true) {
    return await createDedicatedWindowWithTab({ url, activate });
  }
  const windowId = await findBackgroundWindowId();
  if (windowId !== null) {
    const tab = await chrome.tabs.create({ url, active: Boolean(activate), windowId });
    if (!(await getNormalWindow(tab.windowId))) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      return await createDedicatedWindowWithTab({ url, activate });
    }
    if (activate) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    }
    return tab;
  }

  return await createDedicatedWindowWithTab({ url, activate });
}

async function getOrCreateSessionTab(sessionId, options = {}) {
  const {
    tabId = null,
    createIfMissing = false,
    newTab = false,
    activate = false,
    url = 'about:blank',
    updateActive = true,
    persist = true,
    newWindow = false,
  } = options;

  if (tabId !== null) {
    const tab = await getOwnedTab(sessionId, tabId);
    if (activate && !tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    if (updateActive) {
      sessionStore.setActiveTab(sessionId, tab.id);
      if (persist) {
        await sessionStore.persist();
      }
    }
    return await safeGetTab(tab.id);
  }

  const session = sessionStore.ensureSession(sessionId);
  let releasedMissingTab = false;
  if (!newTab && tabId === null) {
    const liveIds = [];
    for (const candidate of session.tabIds) {
      const live = await safeGetTab(candidate);
      if (live) {
        liveIds.push(candidate);
      }
    }
    if (liveIds.length > 1) {
      throw new Error(`Session owns ${liveIds.length} tabs. Pass tabId so parallel work does not hit the wrong tab. Owned tabIds: ${liveIds.join(', ')}`);
    }
  }
  if (!newTab) {
    const candidates = [session.activeTabId, ...session.tabIds.filter((candidate) => candidate !== session.activeTabId)];
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) {
        continue;
      }

      const tab = await safeGetTab(candidate);
      if (!tab) {
        invalidateContentAgent(candidate, 'missing_tab');
        sessionStore.releaseTab(candidate);
        releasedMissingTab = true;
        continue;
      }

      if (activate && !tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
      }
      if (updateActive) {
        sessionStore.setActiveTab(sessionId, tab.id);
      }
      if (persist || releasedMissingTab) {
        await sessionStore.persist();
      }
      return await safeGetTab(tab.id);
    }
  }

  if (!createIfMissing && !newTab) {
    if (releasedMissingTab) {
      await sessionStore.persist();
    }
    throw new Error(`Session ${sessionId} does not own any tabs yet.`);
  }

  const createdTab = await createSessionTab(sessionId, { url, activate, newWindow });
  sessionStore.claimTab(sessionId, createdTab.id);
  sessionStore.setActiveTab(sessionId, createdTab.id);
  await ensureSessionGroup(sessionId, createdTab.id);
  await sessionStore.persist();
  return createdTab;
}

async function serializeTab(tab) {
  return {
    id: tab.id,
    tabId: tab.id,
    title: tab.title || '(untitled)',
    url: tab.url || '',
    active: tab.active === true,
    status: tab.status || 'unknown',
    groupId: tab.groupId ?? null,
    windowId: tab.windowId ?? null,
    index: tab.index ?? null,
    pinned: tab.pinned === true,
  };
}

async function findChromeTabs(params = {}) {
  const titleIncludes = String(params.titleIncludes || '').trim().toLowerCase();
  const urlIncludes = String(params.urlIncludes || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const tabs = await chrome.tabs.query({});
  const matches = [];

  for (const tab of tabs) {
    const title = tab.title || '';
    const url = tab.url || '';
    if (titleIncludes && !title.toLowerCase().includes(titleIncludes)) {
      continue;
    }
    if (urlIncludes && !url.toLowerCase().includes(urlIncludes)) {
      continue;
    }
    matches.push(await serializeTab(tab));
    if (matches.length >= limit) {
      break;
    }
  }

  return {
    count: matches.length,
    tabs: matches,
  };
}

async function findChromeGroups(params = {}) {
  const titleIncludes = String(params.titleIncludes || '').trim().toLowerCase();
  const title = String(params.title || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const groups = await chrome.tabGroups.query({});
  const matches = [];

  for (const group of groups) {
    const groupTitle = group.title || '';
    if (title && groupTitle.toLowerCase() !== title) {
      continue;
    }
    if (titleIncludes && !groupTitle.toLowerCase().includes(titleIncludes)) {
      continue;
    }

    const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
    const owners = [...new Set(tabs.map((tab) => sessionStore.findOwner(tab.id)).filter(Boolean))];
    const liveOwners = owners.filter((owner) => sessionStore.getSession(owner)?.connected === true);
    matches.push({
      id: group.id,
      groupId: group.id,
      title: groupTitle,
      color: group.color || '',
      collapsed: group.collapsed === true,
      windowId: group.windowId ?? null,
      tabCount: tabs.length,
      owned: owners.length > 0,
      ownerSessionIds: owners,
      liveOwnerSessionIds: liveOwners,
      tabs: tabs.slice(0, 10).map((tab) => ({
        tabId: tab.id,
        title: tab.title || '(untitled)',
        url: tab.url || '',
        ownerSessionId: sessionStore.findOwner(tab.id),
      })),
    });
    if (matches.length >= limit) {
      break;
    }
  }

  return { count: matches.length, groups: matches };
}

async function adoptChromeGroup(sessionId, params = {}) {
  const groupId = Number(params.groupId);
  if (!Number.isInteger(groupId)) {
    throw new Error('groupId is required to adopt an existing Chrome group.');
  }
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) {
    throw new Error(`Chrome group ${groupId} no longer exists.`);
  }
  const tabs = await chrome.tabs.query({ groupId });
  if (tabs.length === 0) {
    throw new Error(`Chrome group ${groupId} does not contain any tabs.`);
  }

  const refused = [];
  for (const tab of tabs) {
    const owner = sessionStore.findOwner(tab.id);
    const ownerSession = owner ? sessionStore.getSession(owner) : null;
    if (owner && owner !== sessionId && ownerSession?.connected === true) {
      refused.push({ tabId: tab.id, ownerSessionId: owner });
    }
    const url = tab.url || '';
    if (/^(chrome|chrome-extension|devtools):/i.test(url)) {
      refused.push({ tabId: tab.id, reason: 'internal_tab' });
    }
  }
  if (refused.length > 0) {
    return {
      adopted: false,
      groupId,
      refused,
      message: 'Group contains live-owned or browser-internal tabs and was not adopted.',
    };
  }

  for (const tab of tabs) {
    const owner = sessionStore.findOwner(tab.id);
    if (owner && owner !== sessionId) {
      sessionStore.releaseTab(tab.id);
    }
    sessionStore.claimTab(sessionId, tab.id);
  }
  sessionStore.setGroup(sessionId, groupId);
  sessionStore.setActiveTab(sessionId, tabs[0].id);
  await updateTabGroup(sessionId, groupId, {
    groupTitle: params.groupTitle || group.title || sessionLabel(sessionId),
    groupColor: params.groupColor || group.color || DEFAULT_GROUP_COLOR,
    groupCollapsed: typeof params.groupCollapsed === 'boolean' ? params.groupCollapsed : group.collapsed,
  });
  await sessionStore.persist();

  return {
    adopted: true,
    groupId,
    tabCount: tabs.length,
    tabs: await Promise.all(tabs.map((tab) => serializeTab(tab))),
  };
}

async function adoptExistingTab(sessionId, params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) {
    throw new Error('tabId is required to adopt an existing tab.');
  }

  const tab = await safeGetTab(tabId);
  if (!tab) {
    throw new Error(`Tab ${tabId} no longer exists.`);
  }

  const url = tab.url || '';
  if (/^(chrome|chrome-extension|devtools):/i.test(url)) {
    throw new Error('Cannot adopt browser-internal tabs.');
  }

  sessionStore.claimTab(sessionId, tab.id);
  sessionStore.setActiveTab(sessionId, tab.id);
  if (params.groupTitle || params.groupColor || params.groupCollapsed !== undefined) {
    await ensureSessionGroup(sessionId, tab.id, {
      groupTitle: params.groupTitle,
      groupColor: params.groupColor,
      groupCollapsed: params.groupCollapsed,
    });
  }
  await sessionStore.persist();

  return await serializeTab((await safeGetTab(tab.id)) || tab);
}

async function serializeSessionGroup(sessionId) {
  const session = sessionStore.ensureSession(sessionId);
  if (session.groupId === null || session.groupId === undefined) {
    return null;
  }

  try {
    const group = await chrome.tabGroups.get(session.groupId);
    return {
      id: group.id,
      groupId: group.id,
      title: group.title || '',
      color: group.color || '',
      collapsed: group.collapsed === true,
      windowId: group.windowId ?? null,
    };
  } catch {
    sessionStore.setGroup(sessionId, null);
    await sessionStore.persist();
    return null;
  }
}

async function markDebugGroup(sessionId, params = {}) {
  const session = sessionStore.ensureSession(sessionId);
  let groupId = Number(params.groupId);
  if (!Number.isInteger(groupId)) {
    groupId = session.groupId;
  }
  if (!Number.isInteger(groupId)) {
    throw new Error('No session group is available to mark as Debug.');
  }
  const group = await chrome.tabGroups.get(groupId);
  const baseTitle = String(params.title || group.title || sessionLabel(sessionId)).replace(/\s+Debug$/i, '').trim();
  const title = `${baseTitle || sessionLabel(sessionId)} Debug`.slice(0, 80);
  await chrome.tabGroups.update(groupId, {
    title,
    color: GROUP_COLORS.includes(params.groupColor) ? params.groupColor : group.color || DEFAULT_GROUP_COLOR,
    collapsed: params.collapsed === true ? true : group.collapsed === true,
  });
  sessionStore.setGroup(sessionId, groupId);
  await sessionStore.persist();
  return {
    marked: true,
    leaveOpen: params.leaveOpen !== false,
    groupId,
    title,
  };
}

async function executeInTab(tabId, func, args = [], options = {}) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: options.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
    func,
    args,
  });

  if (result?.result?.__error) {
    const error = new Error(result.result.__error);
    if (result.result.__errorCode || result.result.code) {
      error.code = result.result.__errorCode || result.result.code;
    }
    throw error;
  }

  return result?.result;
}

async function assertWindowOwnedExclusively(sessionId, windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const unowned = tabs.filter((tab) => sessionStore.findOwner(tab.id) !== sessionId);
  if (unowned.length > 0) {
    const error = new Error('Window has mixed/unowned tabs. Resize is refused so your everyday Chrome window is not changed.');
    error.code = 'mixed_window';
    throw error;
  }
}

function requirePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function requireSelectorOrRef(params, toolName) {
  const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
  const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
  if (!selector && !ref) {
    throw new Error(`${toolName} requires selector or ref.`);
  }
  return { selector, ref };
}

function isBrowserInternalUrl(url) {
  return /^(chrome|chrome-extension|chrome-untrusted|devtools):/i.test(String(url || ''));
}

function isTabsContextUrl(url, includeInternal) {
  const value = String(url || '');
  if (/^(https?:|file:|about:)/i.test(value)) {
    return true;
  }
  return includeInternal === true && isBrowserInternalUrl(value);
}

function requireAbsoluteFilePath(filePath) {
  const value = typeof filePath === 'string' ? filePath.trim() : '';
  if (!value) {
    throw new Error('browser_file_upload requires filePath.');
  }
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('filePath must be an absolute local path.');
  }
  return value;
}

const SHORTCUT_CATALOG = [
  { name: 'Enter', keys: ['Enter'], modifiers: { meta: false, ctrl: false, alt: false, shift: false } },
  { name: 'Escape', keys: ['Escape'], modifiers: { meta: false, ctrl: false, alt: false, shift: false } },
  { name: 'Tab', keys: ['Tab'], modifiers: { meta: false, ctrl: false, alt: false, shift: false } },
  { name: 'Meta+l', keys: ['l'], modifiers: { meta: true, ctrl: false, alt: false, shift: false } },
  { name: 'Meta+a', keys: ['a'], modifiers: { meta: true, ctrl: false, alt: false, shift: false } },
  { name: 'Meta+c', keys: ['c'], modifiers: { meta: true, ctrl: false, alt: false, shift: false } },
  { name: 'Meta+v', keys: ['v'], modifiers: { meta: true, ctrl: false, alt: false, shift: false } },
  { name: 'ArrowDown', keys: ['ArrowDown'], modifiers: { meta: false, ctrl: false, alt: false, shift: false } },
  { name: 'ArrowUp', keys: ['ArrowUp'], modifiers: { meta: false, ctrl: false, alt: false, shift: false } },
];

function emptyShortcutModifiers() {
  return { meta: false, ctrl: false, alt: false, shift: false };
}

function applyShortcutModifierName(modifiers, name) {
  const lower = String(name || '').toLowerCase();
  if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') {
    modifiers.meta = true;
    return true;
  }
  if (lower === 'ctrl' || lower === 'control') {
    modifiers.ctrl = true;
    return true;
  }
  if (lower === 'alt' || lower === 'option') {
    modifiers.alt = true;
    return true;
  }
  if (lower === 'shift') {
    modifiers.shift = true;
    return true;
  }
  return false;
}

function mergeShortcutModifiers(base, extra) {
  const modifiers = { ...emptyShortcutModifiers(), ...(base || {}) };
  if (extra && typeof extra === 'object') {
    if (extra.meta === true) modifiers.meta = true;
    if (extra.ctrl === true) modifiers.ctrl = true;
    if (extra.alt === true) modifiers.alt = true;
    if (extra.shift === true) modifiers.shift = true;
  }
  return modifiers;
}

function parseShortcutChord(raw, extraModifiers) {
  const parts = String(raw || '').split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('browser_shortcut requires name or keys.');
  }
  const modifiers = emptyShortcutModifiers();
  const keyParts = [];
  for (const part of parts) {
    if (!applyShortcutModifierName(modifiers, part)) {
      keyParts.push(part);
    }
  }
  if (keyParts.length === 0) {
    throw new Error(`browser_shortcut could not parse keys: ${raw}`);
  }
  return {
    name: String(raw),
    key: keyParts[keyParts.length - 1],
    modifiers: mergeShortcutModifiers(modifiers, extraModifiers),
  };
}

function parseShortcutKeys(keys, extraModifiers) {
  const modifiers = emptyShortcutModifiers();
  const keyParts = [];
  for (const raw of keys) {
    const value = String(raw || '').trim();
    if (!value) {
      continue;
    }
    if (value.includes('+')) {
      const parsed = parseShortcutChord(value, extraModifiers);
      Object.assign(modifiers, parsed.modifiers);
      keyParts.push(parsed.key);
      continue;
    }
    if (!applyShortcutModifierName(modifiers, value)) {
      keyParts.push(value);
    }
  }
  if (keyParts.length === 0) {
    throw new Error('browser_shortcut requires name or keys.');
  }
  return {
    name: keys.join('+'),
    key: keyParts[keyParts.length - 1],
    modifiers: mergeShortcutModifiers(modifiers, extraModifiers),
  };
}

function parseShortcutSpec(params = {}) {
  if (typeof params.name === 'string' && params.name.trim()) {
    const name = params.name.trim();
    const listed = SHORTCUT_CATALOG.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (listed) {
      return { name: listed.name, key: listed.keys[0], modifiers: { ...listed.modifiers } };
    }
    return parseShortcutChord(name, params.modifiers);
  }
  if (Array.isArray(params.keys)) {
    return parseShortcutKeys(params.keys, params.modifiers);
  }
  if (typeof params.keys === 'string' && params.keys.trim()) {
    return parseShortcutChord(params.keys.trim(), params.modifiers);
  }
  throw new Error('browser_shortcut requires name or keys.');
}

async function claimTabDebugger(target) {
  try {
    await chrome.debugger.attach(target, '1.3');
    return;
  } catch (error) {
    const message = error?.message || String(error);
    if (!/already attached/i.test(message)) {
      throw error;
    }
    // Chrome reports one client per target with the same message whether the
    // holder is this extension or an open DevTools window, and only the owner
    // can detach. A detach that succeeds therefore proves the leftover
    // attachment was ours and it is safe to take the target again.
    try {
      await chrome.debugger.detach(target);
    } catch {
      const busy = new Error(
        'Another debugger client is attached to this tab. Close DevTools on it, or dismiss the debugging banner, then run the command again.',
      );
      busy.code = 'debugger_busy';
      throw busy;
    }
    await chrome.debugger.attach(target, '1.3');
  }
}

async function withOwnedTabDebugger(tabId, fn) {
  if (!chrome.debugger || typeof chrome.debugger.attach !== 'function') {
    const error = new Error('Debugger API is missing.');
    error.code = 'debugger_unavailable';
    throw error;
  }

  const target = { tabId };
  let entry = tabDebuggerAttachments.get(tabId);
  if (!entry) {
    entry = { refCount: 0, attachPromise: claimTabDebugger(target) };
    entry.attachPromise.catch(() => {});
    tabDebuggerAttachments.set(tabId, entry);
  }
  entry.refCount += 1;

  const release = () => {
    entry.refCount -= 1;
    if (entry.refCount > 0 || tabDebuggerAttachments.get(tabId) !== entry) {
      return false;
    }
    tabDebuggerAttachments.delete(tabId);
    return true;
  };

  try {
    await entry.attachPromise;
  } catch (error) {
    release();
    throw error;
  }

  try {
    return await fn(target);
  } finally {
    // Concurrent calls share one attachment, so only the last one out detaches.
    // Detaching while another call was still issuing commands used to make every
    // remaining chrome.debugger.sendCommand on that tab fail.
    if (release()) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

chrome.debugger?.onDetach?.addListener((source) => {
  // A user dismissing the "being debugged" banner, a crashed tab, or Chrome
  // itself can end the attachment without running the release above. Drop the
  // cached entry so the next call attaches again instead of sending commands
  // into a target nothing is attached to.
  if (Number.isInteger(source?.tabId)) {
    tabDebuggerAttachments.delete(source.tabId);
  }
});

async function resolveFileInputSelector(tabId, selector, ref) {
  if (ref) {
    try {
      const prepared = await sendContentAgentCommand(tabId, 'prepare_file_input', {
        ref,
        options: selector ? { selector } : {},
      });
      if (prepared?.__error) {
        const error = new Error(prepared.__error);
        error.code = prepared.__errorCode || prepared.code;
        throw error;
      }
      if (prepared?.selector) {
        return prepared.selector;
      }
    } catch (error) {
      if (!useOneShotContentFallback(error) || !selector) {
        throw error;
      }
    }
  }
  const prepared = await executeInTab(tabId, prepareFileInputBySelector, [selector]);
  if (prepared?.__error) {
    throw new Error(prepared.__error);
  }
  return prepared.selector;
}

async function setOwnedTabFileInput(tabId, selector, filePath) {
  return await withOwnedTabDebugger(tabId, async (target) => {
    try {
      const documentResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
      const rootId = documentResult?.root?.nodeId;
      if (!rootId) {
        throw new Error('Could not read the page document for file upload.');
      }
      const queryResult = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
        nodeId: rootId,
        selector,
      });
      const nodeId = queryResult?.nodeId;
      if (!nodeId) {
        throw new Error(`File input not found for selector: ${selector}`);
      }
      await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', {
        nodeId,
        files: [filePath],
      });
      return { tabId, uploaded: true };
    } catch (error) {
      const message = error?.message || String(error);
      if (/ENOENT|no such file|does not exist/i.test(message) && !/File input not found/i.test(message)) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      throw error;
    }
  });
}

function normalizeScreenshotFormat(value) {
  return String(value || 'png').toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
}

function screenshotMimeType(format) {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

function normalizeScreenshotZoom(value) {
  if (value === undefined || value === null || value === '') {
    return 1;
  }
  const zoom = Number(value);
  if (!Number.isFinite(zoom) || zoom < 1) {
    return 1;
  }
  return zoom;
}

function applyScreenshotZoom(region, zoom) {
  if (!region || zoom <= 1) {
    return region;
  }
  const width = Math.max(1, Number(region.width ?? region.w ?? 0));
  const height = Math.max(1, Number(region.height ?? region.h ?? 0));
  const x = Number(region.x || 0);
  const y = Number(region.y || 0);
  const zoomedW = Math.max(1, width / zoom);
  const zoomedH = Math.max(1, height / zoom);
  return {
    x: x + ((width - zoomedW) / 2),
    y: y + ((height - zoomedH) / 2),
    width: zoomedW,
    height: zoomedH,
  };
}

function stripScreenshotDataUrl(dataUrl) {
  return String(dataUrl || '').replace(/^data:image\/(?:png|jpeg);base64,/, '');
}

function screenshotCaptureOptions(format) {
  return format === 'jpeg'
    ? { format: 'jpeg', quality: 80 }
    : { format: 'png' };
}

async function executeInTabWithRetry(tabId, func, args = [], options = {}) {
  const retries = options.retries ?? 2;
  const delayMs = options.delayMs ?? 300;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await executeInTab(tabId, func, args);
    } catch (error) {
      const message = error?.message || '';
      const isRetriableFrameError =
        message.includes('Frame with ID 0 is showing error page') ||
        message.includes('Cannot access contents of url');

      if (!isRetriableFrameError || attempt === retries) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function rejectContentAgentPending(agent, error) {
  for (const [id, pending] of agent.pending.entries()) {
    clearTimeout(pending.timer);
    pending.reject(error);
    agent.pending.delete(id);
  }
}

function invalidateContentAgent(tabId, reason = 'invalidated') {
  invalidateTabReadCache(tabId);
  const agent = contentAgents.get(tabId);
  if (!agent) {
    return;
  }
  contentAgents.delete(tabId);
  agent.disconnected = true;
  agent.readyWaiters.splice(0).forEach((waiter) => waiter.reject(new Error(`Content agent ${reason}.`)));
  rejectContentAgentPending(agent, new Error(`Content agent ${reason}.`));
  try {
    agent.port.disconnect();
  } catch {
    // The content port may already be gone after navigation or tab close.
  }
}

function invalidateSessionContentAgents(sessionId, reason = 'session_disconnected') {
  invalidateSessionReadCache(sessionId);
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return;
  }
  for (const tabId of session.tabIds) {
    invalidateContentAgent(tabId, reason);
  }
}

function resolveContentAgentReady(agent, message = {}) {
  agent.ready = true;
  agent.version = message.version || '';
  agent.url = message.url || '';
  agent.title = message.title || '';
  agent.domVersion = Number.isInteger(message.domVersion) ? message.domVersion : agent.domVersion;
  const waiters = agent.readyWaiters.splice(0);
  for (const waiter of waiters) {
    waiter.resolve(agent);
  }
}

function waitForContentAgentReady(agent, timeoutMs = CONTENT_AGENT_READY_TIMEOUT_MS) {
  if (agent.ready && !agent.disconnected) {
    return Promise.resolve(agent);
  }

  return new Promise((resolve, reject) => {
    let waiter;
    const timer = setTimeout(() => {
      agent.readyWaiters = agent.readyWaiters.filter((candidate) => candidate !== waiter);
      reject(new Error('Timed out waiting for content agent to connect.'));
    }, timeoutMs);
    waiter = {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    agent.readyWaiters.push(waiter);
  });
}

async function ensureContentAgent(tabId) {
  const existing = contentAgents.get(tabId);
  if (existing && !existing.disconnected) {
    // A live agent is used as-is. Re-injecting ax-tree.js here reset the shared
    // element ref store before every content-agent command, so any ref minted by
    // browser_read_interactive failed on the very next call. Liveness is proved
    // instead by the postMessage in sendContentAgentCommand, which invalidates
    // this record and retries once when the port turns out to be dead.
    return await waitForContentAgentReady(existing);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [AX_TREE_SCRIPT, CONTENT_AGENT_SCRIPT],
    });
  } catch (error) {
    error.code = 'content_agent_injection_failed';
    throw error;
  }

  const agent = contentAgents.get(tabId);
  if (!agent) {
    const error = new Error('Content agent did not open a runtime port.');
    error.code = 'content_agent_unavailable';
    throw error;
  }
  return await waitForContentAgentReady(agent);
}

async function sendContentAgentCommand(tabId, action, params = {}, timeoutMs = CONTENT_AGENT_COMMAND_TIMEOUT_MS, options = {}) {
  const agent = await ensureContentAgent(tabId);
  const id = `content_agent_${Date.now()}_${nextContentAgentRequestId}`;
  nextContentAgentRequestId += 1;

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pending.delete(id);
        reject(new Error(`Timed out waiting for content agent action: ${action}`));
      }, timeoutMs);

      agent.pending.set(id, { resolve, reject, timer, action });
      try {
        agent.port.postMessage({
          type: 'agent_command',
          id,
          action,
          params,
        });
      } catch (error) {
        clearTimeout(timer);
        agent.pending.delete(id);
        if (!error.code) {
          error.code = 'content_agent_port_dead';
        }
        reject(error);
      }
    });
  } catch (error) {
    if (options.retried === true || error?.code !== 'content_agent_port_dead') {
      throw error;
    }
    // The port object outlived the document it belonged to, which raises
    // "Attempting to use a disconnected port object" and matches no fallback
    // pattern. Drop the cached agent, reinject, and run the command once more
    // so the caller gets a result instead of a raw Chrome message.
    invalidateContentAgent(tabId, 'stale');
    return await sendContentAgentCommand(tabId, action, params, timeoutMs, { retried: true });
  }
}

function useOneShotContentFallback(error) {
  if ([
    'content_agent_injection_failed',
    'content_agent_unavailable',
    // A port that is dead but not yet disconnected. sendContentAgentCommand
    // reinjects and retries once on its own; reaching a caller means the retry
    // failed too, so the one-shot injection is the last thing left to try.
    'content_agent_port_dead',
  ].includes(error?.code)) {
    return true;
  }

  const message = error?.message || '';
  return (
    /^Content agent (stale|invalidated|navigation|tab_removed|tab_closed|window_closed|session_disconnected|missing_tab|disconnected)\./.test(message) ||
    message === 'Timed out waiting for content agent to connect.' ||
    message.startsWith('Timed out waiting for content agent action:')
  );
}

function extractDomVersion(result) {
  return Number.isInteger(result?.contentAgent?.domVersion)
    ? result.contentAgent.domVersion
    : Number.isInteger(result?.domVersion)
      ? result.domVersion
      : null;
}

async function readPageContentViaAgent(sessionId, tabId, options) {
  try {
    const probe = contentAgents.get(tabId);
    const domVersion = Number.isInteger(probe?.domVersion) ? probe.domVersion : null;
    const key = readCacheKey(sessionId, tabId, 'page_content', options, domVersion);
    const cached = getReadCache(key);
    if (cached) {
      return cached;
    }
    const result = await sendContentAgentCommand(tabId, 'read_page_content', { options }, 30_000);
    setReadCache(readCacheKey(sessionId, tabId, 'page_content', options, extractDomVersion(result)), result);
    return result;
  } catch (error) {
    if (!useOneShotContentFallback(error)) {
      throw error;
    }
    const result = await executeInTabWithRetry(tabId, readPageContent, [options]);
    return {
      ...result,
      contentAgent: {
        used: false,
        fallback: true,
        reason: error.code || 'content_agent_unavailable',
      },
    };
  }
}

async function readInteractiveViaAgent(sessionId, tabId, options) {
  try {
    const probe = contentAgents.get(tabId);
    const domVersion = Number.isInteger(probe?.domVersion) ? probe.domVersion : null;
    const key = readCacheKey(sessionId, tabId, 'interactive', options, domVersion);
    const cached = getReadCache(key);
    if (cached) {
      return cached;
    }
    const result = await sendContentAgentCommand(tabId, 'read_interactive', { options }, 30_000);
    setReadCache(readCacheKey(sessionId, tabId, 'interactive', options, extractDomVersion(result)), result);
    return result;
  } catch (error) {
    if (!useOneShotContentFallback(error)) {
      throw error;
    }
    const result = await executeInTabWithRetry(tabId, readInteractive, [options]);
    return {
      ...result,
      contentAgent: {
        used: false,
        fallback: true,
        reason: error.code || 'content_agent_unavailable',
      },
    };
  }
}

async function waitForSelectorViaAgent(tabId, selector, options) {
  const rawTimeoutMs = Number(options?.timeoutMs);
  const commandTimeoutMs = (Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 10_000) + 1_000;
  try {
    return await sendContentAgentCommand(tabId, 'wait_for_selector', { selector, options }, commandTimeoutMs);
  } catch (error) {
    if (!useOneShotContentFallback(error)) {
      throw error;
    }
    const result = await executeInTab(tabId, waitForSelector, [selector, options]);
    return {
      ...result,
      contentAgent: {
        used: false,
        fallback: true,
        reason: error.code || 'content_agent_unavailable',
      },
    };
  }
}

function requireJavascriptCode(code) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('browser_javascript requires code.');
  }
  return code;
}

function isDebuggerAccessFailure(error) {
  // A page exception is the caller's own code throwing. It must never be
  // retried anywhere, because re-running caller code submits the same form
  // twice, and its text can contain the word "debugger" by coincidence.
  if (error?.code === 'javascript_error') {
    return false;
  }
  if (/Debugger API is missing/i.test(error?.message || '')) {
    return true;
  }
  // debugger_busy and debugger_unavailable both land here, and so does any
  // failure that carries no code at all, which is what a raw sendCommand
  // rejection looks like.
  return !error?.code || /debugger/i.test(String(error.code));
}

// Caller-supplied code runs only through chrome.debugger Runtime.evaluate, the
// API Google sanctions for it. Compiling a string inside the page instead is a
// catalogued eval-evasion pattern and contradicts the script-src 'self' CSP
// declared in extension/manifest.json, so there is no second world to fall back
// into. When the debugger cannot be reached the caller gets one actionable
// error naming the fix rather than a raw Chrome message.
async function executeJavascriptWithWorldFallback(tabId, code, timeoutMs) {
  try {
    const evaluated = await withOwnedTabDebugger(tabId, async (target) => chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(async () => {\n${String(code || '')}\n})()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    }));
    if (evaluated?.exceptionDetails) {
      const thrown = new Error(evaluated.exceptionDetails.text || 'JavaScript threw.');
      thrown.code = 'javascript_error';
      throw thrown;
    }
    return { value: { ok: true, value: evaluated?.result?.value ?? null }, world: 'debugger' };
  } catch (error) {
    if (!isDebuggerAccessFailure(error)) {
      throw error;
    }
    const blocked = new Error(
      `browser_javascript evaluates code through the Chrome debugger and could not attach to this tab: ${error?.message || String(error)}`,
    );
    blocked.code = error?.code || 'debugger_unavailable';
    blocked.cause = error;
    throw blocked;
  }
}

function finalizeJavascriptResult(tabId, payload, extra = {}) {
  const value = payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'value')
    ? payload.value
    : payload;
  return {
    tabId,
    ...serializeJavascriptResult(value),
    ...extra,
  };
}

// Every caller-supplied script goes straight to the debugger. Asking the content
// agent first was a round trip that executed nothing: the request always set
// pageWorld, and the agent answers that flag by returning without running the
// code, so the only effect was carrying the whole code string across a port and
// paying a 24 KB script injection to be told to use the debugger anyway. The
// agent version is read from the local record so the response keeps that field.
async function executeJavascriptViaAgent(tabId, code, options = {}) {
  const timeoutMs = clampTimeoutMs(options.timeoutMs, 10_000, 120_000);
  const agent = contentAgents.get(tabId);
  const agentLive = Boolean(agent && agent.ready && !agent.disconnected);
  const result = await executeJavascriptWithWorldFallback(tabId, code, timeoutMs);
  return finalizeJavascriptResult(tabId, result.value, {
    world: result.world,
    contentAgent: agentLive
      ? { used: false, version: agent.version || '' }
      : { used: false, fallback: true, reason: 'content_agent_unavailable' },
  });
}

async function ensureAxTreeHelpers(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [AX_TREE_SCRIPT],
  });
}

function readAxTreeInPage(options = {}) {
  const api = globalThis.UmbraAxTree;
  if (!api?.walkAxTree) {
    return { __error: 'AX tree helpers are not loaded.' };
  }
  const selector = String(options.selector || '').trim();
  const root = selector ? document.querySelector(selector) : (document.body || document.documentElement);
  if (!root) {
    return { __error: selector ? `Selector not found: ${selector}` : 'Page root was not found.' };
  }
  const domVersion = Number.isInteger(globalThis.__umbraContentAgent?.domVersion)
    ? globalThis.__umbraContentAgent.domVersion
    : 0;
  const walked = api.walkAxTree(root, {
    filter: options.filter,
    maxNodes: options.maxNodes,
  }, {
    document,
    refStore: api.getSharedRefStore(),
    domVersion,
  });
  return {
    title: document.title,
    url: location.href,
    selector,
    filter: walked.filter,
    maxNodes: walked.maxNodes,
    truncated: walked.truncated,
    count: walked.nodes.length,
    domVersion,
    nodes: walked.nodes,
  };
}

function findAxNodesInPage(options = {}) {
  const api = globalThis.UmbraAxTree;
  if (!api?.findAxNodes) {
    return { __error: 'AX tree helpers are not loaded.' };
  }
  const query = String(options.query || '').trim();
  if (!query) {
    return { __error: 'browser_find requires query.' };
  }
  const selector = String(options.selector || '').trim();
  const root = selector ? document.querySelector(selector) : (document.body || document.documentElement);
  if (!root) {
    return { __error: selector ? `Selector not found: ${selector}` : 'Page root was not found.' };
  }
  const domVersion = Number.isInteger(globalThis.__umbraContentAgent?.domVersion)
    ? globalThis.__umbraContentAgent.domVersion
    : 0;
  const found = api.findAxNodes(root, {
    query,
    limit: options.limit,
    filter: 'all',
  }, {
    document,
    refStore: api.getSharedRefStore(),
    domVersion,
  });
  return {
    title: document.title,
    url: location.href,
    query,
    selector,
    count: found.matches.length,
    domVersion,
    matches: found.matches,
  };
}

function formInputInPage(params = {}) {
  const api = globalThis.UmbraAxTree;
  if (!api?.applyFormInput) {
    return { __error: 'AX tree helpers are not loaded.' };
  }
  const selector = String(params.selector || '').trim();
  const ref = String(params.ref || '').trim();
  let element = null;
  if (ref) {
    const resolved = api.resolveElementRef(api.getSharedRefStore(), ref, Number.isInteger(globalThis.__umbraContentAgent?.domVersion)
      ? globalThis.__umbraContentAgent.domVersion
      : api.getSharedRefStore().domVersion);
    if (resolved.__error) {
      return resolved;
    }
    element = resolved.element;
  } else if (selector) {
    element = document.querySelector(selector);
    if (!element) {
      return { __error: `Selector not found: ${selector}` };
    }
  } else {
    return { __error: 'browser_form_input requires selector or ref.' };
  }
  const result = api.applyFormInput(element, {
    value: params.value,
    checked: params.checked,
  });
  if (result.__error) {
    return result;
  }
  return {
    ...result,
    ref: ref || undefined,
    selector: selector || undefined,
  };
}

async function readAxTreeViaAgent(sessionId, tabId, options) {
  try {
    const probe = contentAgents.get(tabId);
    const domVersion = Number.isInteger(probe?.domVersion) ? probe.domVersion : null;
    const key = readCacheKey(sessionId, tabId, 'ax_tree', options, domVersion);
    const cached = getReadCache(key);
    if (cached) {
      return cached;
    }
    const result = await sendContentAgentCommand(tabId, 'read_ax_tree', { options }, 30_000);
    setReadCache(readCacheKey(sessionId, tabId, 'ax_tree', options, extractDomVersion(result)), result);
    return result;
  } catch (error) {
    if (!useOneShotContentFallback(error)) {
      throw error;
    }
    await ensureAxTreeHelpers(tabId);
    const result = await executeInTabWithRetry(tabId, readAxTreeInPage, [options]);
    if (result?.__error) {
      throw new Error(result.__error);
    }
    return {
      ...result,
      contentAgent: {
        used: false,
        fallback: true,
        reason: error.code || 'content_agent_unavailable',
      },
    };
  }
}

async function findAxNodesViaAgent(sessionId, tabId, options) {
  try {
    return await sendContentAgentCommand(tabId, 'find_ax_nodes', { options }, 30_000);
  } catch (error) {
    if (!useOneShotContentFallback(error)) {
      throw error;
    }
    await ensureAxTreeHelpers(tabId);
    const result = await executeInTabWithRetry(tabId, findAxNodesInPage, [options]);
    if (result?.__error) {
      throw new Error(result.__error);
    }
    return {
      ...result,
      contentAgent: {
        used: false,
        fallback: true,
        reason: error.code || 'content_agent_unavailable',
      },
    };
  }
}

async function formInputViaAgent(tabId, params) {
  try {
    const result = await sendContentAgentCommand(tabId, 'form_input', params);
    if (result?.__error) {
      const error = new Error(result.__error);
      error.code = result.__errorCode || result.code;
      throw error;
    }
    return result;
  } catch (error) {
    if (error?.code === 'stale_interactive_ref' || !useOneShotContentFallback(error)) {
      throw error;
    }
    await ensureAxTreeHelpers(tabId);
    const result = await executeInTab(tabId, formInputInPage, [params]);
    if (result?.__error) {
      const wrapped = new Error(result.__error);
      wrapped.code = result.__errorCode || result.code;
      throw wrapped;
    }
    return result;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_AGENT_PORT_NAME) {
    return;
  }

  const tabId = port.sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    port.disconnect();
    return;
  }

  const existing = contentAgents.get(tabId);
  if (existing && existing.port !== port) {
    invalidateContentAgent(tabId, 'replaced');
  }

  const agent = {
    tabId,
    port,
    ready: false,
    disconnected: false,
    version: '',
    url: '',
    title: '',
    domVersion: 0,
    pending: new Map(),
    readyWaiters: [],
  };
  contentAgents.set(tabId, agent);

  port.onMessage.addListener((message) => {
    if (message?.type === 'agent_ready') {
      resolveContentAgentReady(agent, message);
      return;
    }

    if (message?.type === 'console_message') {
      pushConsoleMessage(tabId, message);
      return;
    }

    if (message?.type === 'agent_response' && message.id) {
      const pending = agent.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      agent.pending.delete(message.id);
      if (message.ok === true) {
        if (Number.isInteger(message.result?.contentAgent?.domVersion)) {
          agent.domVersion = message.result.contentAgent.domVersion;
        } else if (Number.isInteger(message.result?.domVersion)) {
          agent.domVersion = message.result.domVersion;
        }
        pending.resolve(message.result);
        return;
      }
      const error = new Error(message.error?.message || `Content agent action failed: ${pending.action}`);
      error.code = message.error?.code || 'content_agent_command_error';
      pending.reject(error);
    }
  });

  port.onDisconnect.addListener(() => {
    if (contentAgents.get(tabId) === agent) {
      contentAgents.delete(tabId);
    }
    agent.disconnected = true;
    agent.readyWaiters.splice(0).forEach((waiter) => waiter.reject(new Error('Content agent disconnected.')));
    rejectContentAgentPending(agent, new Error('Content agent disconnected.'));
  });
});

function collectRenderedImages() {
  const absoluteUrl = (value) => {
    try {
      return value ? new URL(value, location.href).href : '';
    } catch {
      return value || '';
    }
  };
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    return [...element.getClientRects()].some((rect) => rect.width >= 8 && rect.height >= 8);
  };
  const nearestText = (element) => {
    const container = element.closest('article,[data-message-author-role],main,section,figure,div') || element.parentElement;
    return normalize(container?.innerText || '').slice(0, 240);
  };

  return [...document.querySelectorAll('img')]
    .filter(isVisible)
    .map((image, index) => {
      const rect = image.getBoundingClientRect();
      const src = image.currentSrc || image.getAttribute('src') || '';
      const srcset = image.getAttribute('srcset') || '';
      const label =
        image.getAttribute('alt') ||
        image.getAttribute('aria-label') ||
        image.closest('[aria-label]')?.getAttribute('aria-label') ||
        '';
      return {
        index,
        src: absoluteUrl(src),
        srcset: srcset.slice(0, 500),
        alt: label,
        title: image.getAttribute('title') || '',
        naturalWidth: image.naturalWidth || null,
        naturalHeight: image.naturalHeight || null,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        loading: image.getAttribute('loading') || '',
        nearestText: nearestText(image),
      };
    });
}

function formatRenderedImageSummary(images) {
  if (!images.length) {
    return '';
  }

  const rows = images.slice(0, 20).map((image, index) => {
    const dimensions = `${image.naturalWidth || '?'}x${image.naturalHeight || '?'} natural, ${image.renderedWidth || '?'}x${image.renderedHeight || '?'} rendered`;
    const alt = image.alt ? ` alt="${image.alt.slice(0, 120)}"` : '';
    const src = image.src ? ` src="${image.src.slice(0, 220)}"` : image.srcset ? ` srcset="${image.srcset.slice(0, 220)}"` : '';
    const nearby = image.nearestText ? ` nearby="${image.nearestText.slice(0, 160)}"` : '';
    return `${index + 1}. ${dimensions}${alt}${src}${nearby}`;
  });

  return `Rendered images (${images.length} visible):\n${rows.join('\n')}`;
}

function readPageContent(options = {}) {
  const config = typeof options === 'string' ? { format: options } : options || {};
  const format = config.format === 'html' ? 'html' : 'text';
  const selector = typeof config.selector === 'string' ? config.selector.trim() : '';
  const modeCandidates = ['page', 'body', 'main', 'selector'];
  const requestedMode = String(config.mode || '').trim();
  const mode = selector
    ? 'selector'
    : modeCandidates.includes(requestedMode)
      ? requestedMode
      : 'page';
  const includeImages = config.includeImages === true;
  // Zero used to mean unbounded, and nothing downstream bounds a page read: the
  // Rust broker frames responses with an unbounded line reader, so one runaway
  // page could buffer a single unbounded line. Keep this number in step with
  // readPageContent in extension/content-agent.js and with the maxChars
  // description in mcp-server/tools.js.
  const MAX_CHARS_LIMIT = 500_000;
  const rawMaxChars = Number(config.maxChars);
  // Floored at one character, matching readPageContent in content-agent.js: a
  // fractional value used to survive the `> 0` test and floor to zero, which
  // truncate() reads as unbounded.
  const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1
    ? Math.min(Math.floor(rawMaxChars), MAX_CHARS_LIMIT)
    : MAX_CHARS_LIMIT;
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  const absoluteUrl = (value) => {
    try {
      return value ? new URL(value, location.href).href : '';
    } catch {
      return value || '';
    }
  };
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    return [...element.getClientRects()].some((rect) => rect.width >= 8 && rect.height >= 8);
  };
  const nearestText = (element) => {
    const container = element.closest('article,[data-message-author-role],main,section,figure,div') || element.parentElement;
    return normalize(container?.innerText || '').slice(0, 240);
  };

  const resolveRoot = () => {
    if (selector) {
      return document.querySelector(selector);
    }
    if (mode === 'body') {
      return document.body || document.documentElement;
    }
    if (mode === 'main') {
      return document.querySelector('main, article, [role="main"]') || document.body || document.documentElement;
    }
    return document.documentElement;
  };
  const root = resolveRoot();
  if (!root) {
    return { __error: `Selector not found: ${selector}` };
  }

  const queryRoot = root === document.documentElement ? document : root;
  const renderedImages = includeImages ? [...queryRoot.querySelectorAll('img')]
    .filter(isVisible)
    .map((image, index) => {
      const rect = image.getBoundingClientRect();
      const src = image.currentSrc || image.getAttribute('src') || '';
      const srcset = image.getAttribute('srcset') || '';
      const label =
        image.getAttribute('alt') ||
        image.getAttribute('aria-label') ||
        image.closest('[aria-label]')?.getAttribute('aria-label') ||
        '';
      return {
        index,
        src: absoluteUrl(src),
        srcset: srcset.slice(0, 500),
        alt: label,
        title: image.getAttribute('title') || '',
        naturalWidth: image.naturalWidth || null,
        naturalHeight: image.naturalHeight || null,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        loading: image.getAttribute('loading') || '',
        nearestText: nearestText(image),
      };
    }) : [];
  const renderedImageSummary = (() => {
    if (!renderedImages.length) {
      return '';
    }

    const rows = renderedImages.slice(0, 20).map((image, index) => {
      const dimensions = `${image.naturalWidth || '?'}x${image.naturalHeight || '?'} natural, ${image.renderedWidth || '?'}x${image.renderedHeight || '?'} rendered`;
      const alt = image.alt ? ` alt="${image.alt.slice(0, 120)}"` : '';
      const src = image.src ? ` src="${image.src.slice(0, 220)}"` : image.srcset ? ` srcset="${image.srcset.slice(0, 220)}"` : '';
      const nearby = image.nearestText ? ` nearby="${image.nearestText.slice(0, 160)}"` : '';
      return `${index + 1}. ${dimensions}${alt}${src}${nearby}`;
    });

    return `Rendered images (${renderedImages.length} visible):\n${rows.join('\n')}`;
  })();
  const truncate = (value) => {
    const text = String(value || '');
    if (!maxChars || text.length <= maxChars) {
      return {
        value: text,
        truncated: false,
        originalLength: text.length,
      };
    }

    return {
      value: text.slice(0, maxChars),
      truncated: true,
      originalLength: text.length,
    };
  };

  const base = {
    title: document.title,
    url: location.href,
    format,
    mode,
    selector,
    maxChars,
    includeImages,
    renderedImages,
  };

  if (format === 'html') {
    const rawHtml = root === document.documentElement ? document.documentElement.outerHTML : root.outerHTML || '';
    const html = truncate(rawHtml);
    return {
      ...base,
      // The html branch never folds the image summary into content, so this is
      // the only copy of it and it ships only when there is one. `html` used to
      // carry a second byte-identical copy of `content` on every html read.
      ...(renderedImageSummary ? { renderedImageSummary } : {}),
      truncated: html.truncated,
      originalContentLength: html.originalLength,
      contentLength: html.value.length,
      content: html.value,
    };
  }

  const rawBodyText = root.innerText || root.textContent || '';
  // content is body text plus the rendered-image summary when one exists. With
  // no summary the two strings are identical, which is every read at the default
  // includeImages: false, so bodyText ships only when it genuinely differs.
  const rawContent = renderedImageSummary ? `${rawBodyText}\n\n${renderedImageSummary}` : rawBodyText;
  const content = truncate(rawContent);
  const bodyText = rawContent === rawBodyText ? null : truncate(rawBodyText);
  return {
    ...base,
    ...(renderedImageSummary ? { renderedImageSummary } : {}),
    truncated: content.truncated,
    originalContentLength: content.originalLength,
    contentLength: content.value.length,
    ...(bodyText ? { bodyText: bodyText.value, bodyTextTruncated: bodyText.truncated } : {}),
    content: content.value,
  };
}

function readInteractive(options = {}) {
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  const cssEscape = (value) => globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : String(value || '').replace(/["\\]/g, '\\$&');
  const domVersion = Number.isInteger(globalThis.__umbraContentAgent?.domVersion)
    ? globalThis.__umbraContentAgent.domVersion
    : 0;
  const selector = String(options.selector || '').trim() || [
    'button',
    'a[href]',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="switch"]',
    '[aria-haspopup]',
    '[onclick]',
    'summary',
  ].join(',');
  const maxItems = Math.min(Math.max(Number(options.maxItems) || 80, 1), 300);
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
  };
  const elementName = (element) => {
    const aria = normalize(element.getAttribute('aria-label') || '');
    if (aria) {
      return aria;
    }
    if (element.id) {
      const label = document.querySelector(`label[for="${cssEscape(element.id)}"]`);
      const labelText = normalize(label?.innerText || label?.textContent || '');
      if (labelText) {
        return labelText;
      }
    }
    return normalize(element.innerText || element.textContent || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('value') || '');
  };
  const nearbyLabel = (element) => {
    const label = element.closest('label');
    if (label) {
      return normalize(label.innerText || label.textContent || '').slice(0, 240);
    }
    const container = element.closest('td,th,li,form,section,article,div') || element.parentElement;
    return normalize(container?.innerText || container?.textContent || '').slice(0, 240);
  };
  const selectorHint = (element) => {
    const tagName = element.tagName.toLowerCase();
    if (element.id) {
      return `${tagName}#${cssEscape(element.id)}`;
    }
    const aria = element.getAttribute('aria-label');
    if (aria) {
      return `${tagName}[aria-label="${String(aria).slice(0, 80).replace(/"/g, '\\"')}"]`;
    }
    const name = element.getAttribute('name');
    if (name) {
      return `${tagName}[name="${String(name).slice(0, 80).replace(/"/g, '\\"')}"]`;
    }
    const type = element.getAttribute('type');
    return type ? `${tagName}[type="${cssEscape(type)}"]` : tagName;
  };
  const controls = [...document.querySelectorAll(selector)]
    .filter(isVisible)
    .slice(0, maxItems)
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        ref: `cic:${domVersion}:${index}`,
        index,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        name: elementName(element).slice(0, 500),
        text: normalize(element.innerText || element.textContent || '').slice(0, 500),
        value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? String(element.value || '').slice(0, 500)
          : '',
        selectorHint: selectorHint(element),
        disabled: Boolean(element.closest('[disabled], [aria-disabled="true"]')),
        hidden: false,
        contentEditable: element.isContentEditable === true,
        nearbyLabel: nearbyLabel(element),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
        },
      };
    });
  return {
    title: document.title,
    url: location.href,
    selector,
    count: controls.length,
    maxItems,
    domVersion,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    controls,
    _compactSummary: `Interactive controls: ${controls.length} on ${document.title || location.href}`,
  };
}

function toBridgeSafeValue(value, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const maxArrayLength = options.maxArrayLength ?? 200;
  const maxStringLength = options.maxStringLength ?? 20_000;
  const seen = new WeakSet();

  const convert = (current, depth) => {
    if (current === null || current === undefined) {
      return current ?? null;
    }

    const type = typeof current;
    if (type === 'string') {
      return current.length > maxStringLength ? `${current.slice(0, maxStringLength)}...[truncated]` : current;
    }
    if (type === 'number') {
      return Number.isFinite(current) ? current : String(current);
    }
    if (type === 'boolean') {
      return current;
    }
    if (type === 'bigint') {
      return current.toString();
    }
    if (type === 'function' || type === 'symbol') {
      return String(current);
    }

    if (depth >= maxDepth) {
      return '[MaxDepth]';
    }

    if (seen.has(current)) {
      return '[Circular]';
    }
    seen.add(current);

    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack || '',
      };
    }

    if (current instanceof Element) {
      const rect = current.getBoundingClientRect();
      return {
        tagName: current.tagName.toLowerCase(),
        id: current.id || '',
        className: String(current.className || ''),
        text: String(current.innerText || current.textContent || '').trim().slice(0, 500),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
        },
      };
    }

    if (current instanceof DOMRect || current instanceof DOMRectReadOnly) {
      return {
        x: current.x,
        y: current.y,
        width: current.width,
        height: current.height,
        top: current.top,
        right: current.right,
        bottom: current.bottom,
        left: current.left,
      };
    }

    if (Array.isArray(current)) {
      return current.slice(0, maxArrayLength).map((item) => convert(item, depth + 1));
    }

    const output = {};
    for (const [key, item] of Object.entries(current).slice(0, 200)) {
      output[key] = convert(item, depth + 1);
    }
    return output;
  };

  return convert(value, 0);
}

// Page actions runPageAction implements itself. Everything else is a page
// recipe: an optional local file this build may or may not carry.
const BUILTIN_PAGE_ACTIONS = new Set([
  'render_wait',
  'element_positions',
  'inspect_controls',
  'click_control',
  'limit_table_rows',
  'scroll_selector',
  'restore_table_rows',
  'wait_for_text',
]);

// A page action that is not built in is namespaced: the part of its name before
// the first underscore names a recipe file at recipes/<namespace>-actions.js.
// Nothing here lists the namespaces, so a build carries exactly the recipes its
// recipes/ folder holds and no file names any of them.
//
// runPageAction is stringified into the tab by chrome.scripting.executeScript,
// so its free identifiers resolve in the injected world rather than in the
// service worker: a recipe has to be a file injected into that same world,
// which is the default ISOLATED one, and cannot be a module import.
function pageRecipeNamespace(action) {
  const name = String(action || '');
  if (!name || BUILTIN_PAGE_ACTIONS.has(name)) {
    return '';
  }
  const [namespace = ''] = name.split('_');
  return /^[a-z0-9]+$/.test(namespace) ? namespace : '';
}

async function ensurePageRecipe(tabId, action) {
  const namespace = pageRecipeNamespace(action);
  if (!namespace) {
    return { namespace: '', installed: false };
  }
  const file = `recipes/${namespace}-actions.js`;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return { namespace, installed: true };
  } catch (error) {
    // A build without that recipe file is the normal case, not an anomaly.
    // Reporting here would bury the reason, so the action runs and
    // runPageAction names the missing recipe with the one error a caller can
    // act on.
    return { namespace, installed: false, reason: error?.message || 'recipe_injection_failed' };
  }
}

async function runPageAction(action, params = {}, options = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 10_000, 120_000));

  const actionPromise = (async () => {
    if (action === 'render_wait') {
      const spinners = document.querySelectorAll(
        '[class*="spinner"], [class*="loading"], [class*="skeleton"], [class*="Spinner"], [class*="Loading"]',
      );
      const visibleSpinners = [...spinners].filter((spinner) => {
        const style = window.getComputedStyle(spinner);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });
      return {
        loaded: visibleSpinners.length === 0,
        visibleSpinnerCount: visibleSpinners.length,
        message: visibleSpinners.length > 0
          ? `STILL LOADING: ${visibleSpinners.length} spinners found.`
          : 'Page loaded. No spinners detected.',
      };
    }

    if (action === 'element_positions') {
      const headings = Array.isArray(params.headings) && params.headings.length
        ? params.headings
        : ['Backlink profile', 'Search'];
      const positions = {};
      headings.forEach((name) => {
        const heading = Array.from(document.querySelectorAll('h4')).find((item) => item.textContent.trim() === name);
        if (!heading) {
          return;
        }
        let element = heading;
        for (let index = 0; index < 10; index += 1) {
          element = element?.parentElement;
          if (!element) {
            break;
          }
          const rect = element.getBoundingClientRect();
          if (rect.height > 150) {
            positions[name] = {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
            };
            break;
          }
        }
      });

      const bp = positions['Backlink profile'];
      const sr = positions.Search;
      const dpr = window.devicePixelRatio;
      if (bp && sr) {
        const urStartX = bp.x + Math.round(bp.w / 2);
        const searchMidX = sr.x + Math.round(sr.w / 2);
        positions._cropUR = {
          cssRegion: { x: urStartX, y: bp.y, w: searchMidX - urStartX, h: bp.h },
          sips: {
            cropOffsetY: Math.round(bp.y * dpr),
            cropOffsetX: Math.round(urStartX * dpr),
            height: Math.round(bp.h * dpr),
            width: Math.round((searchMidX - urStartX) * dpr),
          },
        };
        positions._cropSearch = {
          cssRegion: { x: sr.x, y: sr.y, w: sr.w, h: sr.h },
          sips: {
            cropOffsetY: Math.round(sr.y * dpr),
            cropOffsetX: Math.round(sr.x * dpr),
            height: Math.round(sr.h * dpr),
            width: Math.round(sr.w * dpr),
          },
        };
      }
      return { dpr, viewport: { w: window.innerWidth, h: window.innerHeight }, positions };
    }

    if (action === 'inspect_controls') {
      const selector = params.selector || 'button,a,label,[role="button"],[role="link"],[role="menuitem"],[role="radio"]';
      const textIncludes = String(params.textIncludes || '').trim().toLowerCase();
      const ariaIncludes = String(params.ariaIncludes || '').trim().toLowerCase();
      const minX = Number.isFinite(Number(params.minX)) ? Number(params.minX) : -Infinity;
      const minY = Number.isFinite(Number(params.minY)) ? Number(params.minY) : -Infinity;
      const maxY = Number.isFinite(Number(params.maxY)) ? Number(params.maxY) : Infinity;
      const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 300);
      const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
          return false;
        }
        return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
      };

      const controls = [...document.querySelectorAll(selector)]
        .map((element, domIndex) => {
          const rect = element.getBoundingClientRect();
          const text = normalize(element.innerText || element.textContent || '');
          const ariaLabel = normalize(element.getAttribute('aria-label') || '');
          const title = normalize(element.getAttribute('title') || '');
          return {
            domIndex,
            tagName: element.tagName.toLowerCase(),
            role: element.getAttribute('role') || '',
            type: element.getAttribute('type') || '',
            ariaLabel,
            title,
            text,
            disabled: Boolean(element.closest('[disabled], [aria-disabled="true"]')),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
            },
            selectorHint: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${ariaLabel ? `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]` : ''}`,
          };
        })
        .filter((item) => item.disabled === false)
        .filter((item) => item.rect.width > 0 && item.rect.height > 0)
        .filter((item) => item.rect.x >= minX && item.rect.y >= minY && item.rect.y <= maxY)
        .filter((item) => !textIncludes || item.text.toLowerCase().includes(textIncludes))
        .filter((item) => !ariaIncludes || item.ariaLabel.toLowerCase().includes(ariaIncludes))
        .filter((item) => {
          const element = document.querySelectorAll(selector)[item.domIndex];
          return element && isVisible(element);
        })
        .slice(0, limit);

      return {
        selector,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        count: controls.length,
        controls,
      };
    }

    if (action === 'click_control') {
      const selector = params.selector || 'button,a,label,[role="button"],[role="link"],[role="menuitem"],[role="radio"]';
      const domIndex = Number(params.domIndex);
      if (!Number.isInteger(domIndex) || domIndex < 0) {
        throw new Error('domIndex must be a non-negative integer from inspect_controls.');
      }
      const element = document.querySelectorAll(selector)[domIndex];
      if (!element) {
        throw new Error(`No control found for selector ${selector} at domIndex ${domIndex}.`);
      }
      if (element.closest('[disabled], [aria-disabled="true"]')) {
        throw new Error(`Control at domIndex ${domIndex} is disabled.`);
      }

      element.scrollIntoView({ block: params.block || 'center', inline: 'center', behavior: 'instant' });
      await wait(Number(params.waitMsBeforeClick) || 100);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
      await wait(Number(params.waitMsAfterClick) || 500);
      return {
        clicked: true,
        selector,
        domIndex,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        text: String(element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    }

    if (action === 'limit_table_rows') {
      const targetRows = Math.min(Math.max(Number(params.rowCount) || 12, 1), 12);
      const rows = document.querySelectorAll('table tbody tr');
      let hiddenCount = 0;
      for (let index = targetRows; index < rows.length; index += 1) {
        rows[index].style.display = 'none';
        hiddenCount += 1;
      }
      document.querySelectorAll('[class*="showMore"], [class*="show-more"], [class*="pagination"]').forEach((element) => {
        element.style.display = 'none';
      });
      return { targetRows, totalRows: rows.length, hiddenCount };
    }

    if (action === 'scroll_selector') {
      const selector = params.selector || 'table';
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Selector not found: ${selector}`);
      }
      element.scrollIntoView({ block: params.block || 'start', inline: 'nearest', behavior: 'instant' });
      await wait(Number(params.waitMs) || 500);
      return { selector, scrolled: true };
    }

    if (action === 'restore_table_rows') {
      document.querySelectorAll('table tbody tr').forEach((row) => {
        row.style.display = '';
      });
      return { restored: true };
    }

    if (action === 'wait_for_text') {
      const needle = String(params.text || '').trim();
      const waitLimit = Math.max(250, Math.min(Number(params.timeoutMs) || 20_000, 90_000));
      const startedAt = Date.now();
      while (Date.now() - startedAt <= waitLimit) {
        const haystack = document.body?.innerText || '';
        if (needle && haystack.includes(needle)) {
          return { found: true, elapsedMs: Date.now() - startedAt, text: needle };
        }
        await wait(250);
      }
      return { found: false, elapsedMs: waitLimit, text: needle };
    }

    // Anything else is a page recipe: an optional local file background.js
    // injects into this world before calling runPageAction, registered under
    // the namespace its action name starts with. A build without that file
    // reports what is missing instead of throwing an unresolved-identifier
    // error.
    // Same derivation and the same validation background.js applied before
    // injecting, so the two functions cannot disagree about which file a name
    // points at, and an own-property lookup so inherited Object members such as
    // constructor or valueOf cannot answer as a namespace.
    const rawNamespace = typeof action === 'string' ? action.split('_')[0] : '';
    const namespace = /^[a-z0-9]+$/.test(rawNamespace) ? rawNamespace : '';
    const registry = globalThis.__umbraPageRecipes;
    const installed = namespace && registry && Object.hasOwn(registry, namespace)
      ? registry[namespace]
      : null;
    if (installed && typeof installed === 'object' && !Array.isArray(installed)) {
      const recipe = Object.hasOwn(installed, action) ? installed[action] : undefined;
      if (typeof recipe !== 'function') {
        throw new Error(`Unsupported page action: ${action}`);
      }
      const value = await recipe(params);
      // A recipe that silently does nothing, because a selector stopped matching
      // after a site redesign, must not read as a completed export.
      if (value === undefined || value === null) {
        throw new Error(`Page recipe ${action} returned no result.`);
      }
      return value;
    }

    // The caller passed in why injection failed when it did, so a broken recipe
    // file no longer reports as an absent one.
    if (options.recipeFailure) {
      throw new Error(`Page recipe for ${action} failed to inject: ${options.recipeFailure}`);
    }
    throw new Error(`Page recipe not installed in this build: ${action}.`);
  })();

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Page action timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  const result = await Promise.race([actionPromise, timeout]);
  return {
    ok: true,
    action,
    result,
    title: document.title,
    url: location.href,
  };
}

function getTechnicalSnapshot(options = {}) {
  const absoluteUrl = (value) => {
    try {
      return value ? new URL(value, location.href).href : '';
    } catch {
      return value || '';
    }
  };

  const text = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || '';
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name)?.trim() || '';
  const navigation = performance.getEntriesByType('navigation')?.[0] || null;
  // Only the first 80 headings and links are ever returned, but every heading
  // level and every href, rel, and sameHost flag feeds the counts below, so the
  // full pass stays and only the text read is capped. Measured on a page with
  // 6,567 anchors, reading innerText for all of them costs 25.2 ms against
  // 0.1 ms for the first 80.
  const SAMPLE_LIMIT = 80;
  const elementText = (element, maxLength) => String(element.innerText || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading, index) => ({
    level: heading.tagName.toLowerCase(),
    text: index < SAMPLE_LIMIT ? elementText(heading, 240) : '',
  }));
  const anchors = [...document.querySelectorAll('a[href]')];
  const images = [...document.querySelectorAll('img')];
  const pageUrl = new URL(location.href);
  const linkData = anchors.map((link, index) => {
    const href = absoluteUrl(link.getAttribute('href'));
    let sameHost = false;
    try {
      sameHost = new URL(href).hostname === pageUrl.hostname;
    } catch {
      sameHost = false;
    }
    return {
      href,
      text: index < SAMPLE_LIMIT ? elementText(link, 160) : '',
      rel: link.getAttribute('rel') || '',
      sameHost,
    };
  });
  const collectJsonLdTypes = (node, acc = []) => {
    if (!node) {
      return acc;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => collectJsonLdTypes(item, acc));
      return acc;
    }
    if (typeof node !== 'object') {
      return acc;
    }
    const type = node['@type'];
    if (Array.isArray(type)) {
      acc.push(...type);
    } else if (type) {
      acc.push(type);
    }
    if (node['@graph']) {
      collectJsonLdTypes(node['@graph'], acc);
    }
    return acc;
  };
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => {
    const raw = script.textContent || '';
    try {
      const parsed = JSON.parse(raw);
      return {
        valid: true,
        types: collectJsonLdTypes(parsed),
      };
    } catch (error) {
      return {
        valid: false,
        error: error?.message || 'Invalid JSON-LD',
      };
    }
  });
  // One serialization, whether or not the caller wants the markup back. The
  // previous shape serialized the whole document twice when includeHtml was set
  // and once even when it was not, purely to read a length off it.
  const html = document.documentElement.outerHTML;

  return {
    url: location.href,
    finalUrl: location.href,
    title: document.title,
    readyState: document.readyState,
    statusCode: Number.isInteger(navigation?.responseStatus) ? navigation.responseStatus : null,
    statusSource: Number.isInteger(navigation?.responseStatus) ? 'performance.navigation.responseStatus' : 'unavailable',
    htmlLength: html.length,
    html: options.includeHtml ? html : undefined,
    document: {
      lang: document.documentElement.getAttribute('lang') || '',
      charset: document.characterSet || '',
      viewport: attr('meta[name="viewport"]', 'content'),
    },
    meta: {
      description: text('meta[name="description"]'),
      robots: text('meta[name="robots"]'),
      googlebot: text('meta[name="googlebot"]'),
    },
    canonical: absoluteUrl(attr('link[rel~="canonical"]', 'href')),
    hreflang: [...document.querySelectorAll('link[rel~="alternate"][hreflang]')].map((link) => ({
      hreflang: link.getAttribute('hreflang') || '',
      href: absoluteUrl(link.getAttribute('href')),
    })),
    headings: {
      counts: headings.reduce((counts, heading) => {
        counts[heading.level] = (counts[heading.level] || 0) + 1;
        return counts;
      }, {}),
      items: headings.slice(0, SAMPLE_LIMIT),
    },
    links: {
      total: linkData.length,
      internal: linkData.filter((link) => link.sameHost).length,
      external: linkData.filter((link) => !link.sameHost).length,
      nofollow: linkData.filter((link) => /\bnofollow\b/i.test(link.rel)).length,
      samples: linkData.slice(0, SAMPLE_LIMIT),
    },
    images: {
      total: images.length,
      missingAlt: images.filter((image) => !image.hasAttribute('alt')).length,
      emptyAlt: images.filter((image) => image.hasAttribute('alt') && image.getAttribute('alt') === '').length,
      lazy: images.filter((image) => image.loading === 'lazy' || image.getAttribute('loading') === 'lazy').length,
      samples: images.slice(0, SAMPLE_LIMIT).map((image) => ({
        src: absoluteUrl(image.getAttribute('src') || image.currentSrc || ''),
        alt: image.getAttribute('alt'),
        loading: image.getAttribute('loading') || '',
        width: image.naturalWidth || image.width || null,
        height: image.naturalHeight || image.height || null,
      })),
    },
    structuredData: {
      jsonLdCount: jsonLd.length,
      jsonLdTypes: [...new Set(jsonLd.flatMap((entry) => entry.types || []))],
      jsonLdParseErrors: jsonLd.filter((entry) => !entry.valid).map((entry) => entry.error),
      microdataItemTypes: [...new Set([...document.querySelectorAll('[itemscope][itemtype]')].map((node) => node.getAttribute('itemtype') || ''))].filter(Boolean),
    },
    performance: navigation
      ? {
          type: navigation.type,
          durationMs: Math.round(navigation.duration || 0),
          domContentLoadedMs: Math.round((navigation.domContentLoadedEventEnd || 0) - (navigation.startTime || 0)),
          loadEventMs: Math.round((navigation.loadEventEnd || 0) - (navigation.startTime || 0)),
          transferSize: navigation.transferSize || null,
          encodedBodySize: navigation.encodedBodySize || null,
          decodedBodySize: navigation.decodedBodySize || null,
        }
      : null,
    robotsText: /\/robots\.txt(?:$|\?)/i.test(location.pathname)
      ? (document.body?.innerText || '').slice(0, 20_000)
      : undefined,
    issues: (() => {
      const found = [];
      const titleText = document.title || '';
      if (!titleText) found.push({ severity: 'error', code: 'missing_title', message: 'Page has no title.' });
      else if (titleText.length < 20 || titleText.length > 70) found.push({ severity: 'warn', code: 'title_length', message: `Title is ${titleText.length} characters.` });
      const description = text('meta[name="description"]');
      if (!description) found.push({ severity: 'warn', code: 'missing_description', message: 'Meta description is missing.' });
      else if (description.length < 50 || description.length > 170) found.push({ severity: 'info', code: 'description_length', message: `Meta description is ${description.length} characters.` });
      const h1Count = headings.filter((item) => item.level === 'h1').length;
      if (h1Count !== 1) found.push({ severity: 'warn', code: 'h1_count', message: `Page has ${h1Count} H1 tags.` });
      const robots = text('meta[name="robots"]').toLowerCase();
      if (/\bnoindex\b/.test(robots)) found.push({ severity: 'error', code: 'noindex', message: 'robots meta contains noindex.' });
      const canonicalHref = absoluteUrl(attr('link[rel~="canonical"]', 'href'));
      if (canonicalHref) {
        try {
          const canonicalUrl = new URL(canonicalHref);
          const here = new URL(location.href);
          if (canonicalUrl.origin + canonicalUrl.pathname !== here.origin + here.pathname) {
            found.push({ severity: 'warn', code: 'canonical_mismatch', message: `Canonical is ${canonicalHref}.` });
          }
        } catch {
          found.push({ severity: 'warn', code: 'canonical_invalid', message: `Canonical is not a valid URL: ${canonicalHref}` });
        }
      } else if (!/\/robots\.txt(?:$|\?)/i.test(location.pathname)) {
        found.push({ severity: 'warn', code: 'missing_canonical', message: 'No canonical tag.' });
      }
      const placeholderImages = images.filter((image) => {
        const src = String(image.getAttribute('src') || image.currentSrc || '');
        return src.startsWith('data:image') && (image.naturalWidth || image.width || 0) <= 1;
      }).length;
      if (placeholderImages) {
        found.push({ severity: 'info', code: 'lazy_placeholders', message: `${placeholderImages} images are still 1x1 data placeholders.` });
      }
      const missingAlt = images.filter((image) => !image.hasAttribute('alt')).length;
      if (missingAlt) found.push({ severity: 'warn', code: 'missing_alt', message: `${missingAlt} images have no alt attribute.` });
      if (jsonLd.some((entry) => !entry.valid)) {
        found.push({ severity: 'warn', code: 'jsonld_parse', message: 'At least one JSON-LD block failed to parse.' });
      }
      const status = Number.isInteger(navigation?.responseStatus) ? navigation.responseStatus : null;
      if (status && status >= 400) found.push({ severity: 'error', code: 'http_status', message: `HTTP ${status}.` });
      return found;
    })(),
  };
}

function clickSelector(selector, doubleClick = false) {
  const element = document.querySelector(selector);
  if (!element) {
    return { __error: `Selector not found: ${selector}` };
  }

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const fireClick = () => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.click();
  };
  fireClick();
  if (doubleClick) {
    fireClick();
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 }));
  }
  return { clicked: true, doubleClick: Boolean(doubleClick), selector, x: rect.x, y: rect.y };
}

function clickAtPoint(x, y, doubleClick = false) {
  const pointX = Number(x);
  const pointY = Number(y);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) {
    return { __error: 'browser_click requires both x and y as CSS pixels.' };
  }

  const element = document.elementFromPoint(pointX, pointY);
  if (!element) {
    return { __error: `No element at viewport point ${pointX},${pointY}.` };
  }

  const fireReact = (target, handlerName) => {
    if (!target) return false;
    const makeEvent = (currentTarget) => ({
      preventDefault() {},
      stopPropagation() {},
      nativeEvent: { preventDefault() {}, stopPropagation() {} },
      currentTarget,
      target,
      clientX: pointX,
      clientY: pointY,
    });
    const callHandler = (props, currentTarget) => {
      const handler = props?.[handlerName];
      if (typeof handler !== 'function') return false;
      handler(makeEvent(currentTarget));
      return true;
    };
    let node = target;
    for (let depth = 0; depth < 10 && node; depth += 1) {
      const propsKey = Object.keys(node).find((item) => item.startsWith('__reactProps$'));
      if (callHandler(propsKey ? node[propsKey] : null, node)) return true;
      const fiberKey = Object.keys(node).find((item) => item.startsWith('__reactFiber$'));
      let fiber = fiberKey ? node[fiberKey] : null;
      for (let up = 0; up < 10 && fiber; up += 1) {
        if (callHandler(fiber.memoizedProps || fiber.pendingProps, fiber.stateNode || node)) {
          return true;
        }
        fiber = fiber.return;
      }
      node = node.parentElement;
    }
    return false;
  };

  const mouseInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: pointX,
    clientY: pointY,
    screenX: pointX,
    screenY: pointY,
    button: 0,
    buttons: 1,
  };
  const pointerInit = {
    ...mouseInit,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };

  const fireClick = () => {
    element.dispatchEvent(new PointerEvent('pointerover', pointerInit));
    element.dispatchEvent(new MouseEvent('mouseover', mouseInit));
    element.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    element.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    element.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 }));
    try {
      element.click();
    } catch {
      // some custom elements reject a second click
    }
    fireReact(element, 'onClick');
  };

  fireClick();
  if (doubleClick) {
    fireClick();
    element.dispatchEvent(new MouseEvent('dblclick', { ...mouseInit, buttons: 0, detail: 2 }));
  }

  const rect = element.getBoundingClientRect();
  return {
    clicked: true,
    doubleClick: Boolean(doubleClick),
    x: pointX,
    y: pointY,
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || '',
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function parseInteractiveRef(ref) {
  const match = /^cic:(\d+):(\d+)$/.exec(String(ref || '').trim());
  if (!match) {
    return { __error: 'Invalid interactive ref. Run browser_read_interactive again.' };
  }
  return {
    domVersion: Number(match[1]),
    index: Number(match[2]),
  };
}

function resolveInteractiveRef(ref, selector = '') {
  const parsed = parseInteractiveRef(ref);
  if (parsed.__error) {
    return parsed;
  }
  const currentDomVersion = Number.isInteger(globalThis.__umbraContentAgent?.domVersion)
    ? globalThis.__umbraContentAgent.domVersion
    : null;
  if (currentDomVersion !== null && currentDomVersion !== parsed.domVersion) {
    return { __error: 'Stale interactive ref. Run browser_read_interactive again.', code: 'stale_interactive_ref' };
  }
  const options = selector ? { selector, maxItems: parsed.index + 1 } : { maxItems: parsed.index + 1 };
  const current = readInteractive(options);
  // readInteractive numbers its controls after filtering for visibility, so the
  // index has to be applied to the same filtered list. Indexing the raw node
  // list meant any hidden element earlier in document order shifted the answer
  // by one, which returned a real but wrong element and left the guard below
  // almost never firing. Keep this filter identical to readInteractive's.
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
  };
  const element = [...document.querySelectorAll(current.selector)].filter(isVisible)[parsed.index];
  if (!element) {
    return { __error: 'Interactive ref no longer resolves. Run browser_read_interactive again.', code: 'stale_interactive_ref' };
  }
  return { element, ref: parsed, current };
}

function clickInteractiveRef(ref, selector = '', doubleClick = false) {
  const resolved = resolveInteractiveRef(ref, selector);
  if (resolved.__error) {
    return resolved;
  }
  const { element } = resolved;
  if (element.closest('[disabled], [aria-disabled="true"]')) {
    return { __error: 'Interactive ref resolved to a disabled element.' };
  }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const fireClick = () => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.click();
  };
  fireClick();
  if (doubleClick) {
    fireClick();
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 }));
  }
  return {
    clicked: true,
    doubleClick: Boolean(doubleClick),
    ref,
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || '',
    x: rect.x,
    y: rect.y,
  };
}

function clickVisibleText(text, options = {}) {
  const needle = String(text || '').trim().replace(/\s+/g, ' ');
  if (!needle) {
    return { __error: 'Text is required.' };
  }

  const selector = options.selector || 'button,a,label,[role="button"],[role="menuitem"],[role="radio"],span,div';
  const exact = options.exact !== false;
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
  };

  const candidates = [...document.querySelectorAll(selector)]
    .filter((element) => {
      if (element.closest('[disabled], [aria-disabled="true"]')) {
        return false;
      }
      const value = normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
      if (!value) {
        return false;
      }
      return exact ? value === needle : value.includes(needle);
    })
    .filter(isVisible)
    .map((element) => {
      const clickable = element.closest('button,a,label,[role="button"],[role="menuitem"],[role="radio"]') || element;
      const rect = clickable.getBoundingClientRect();
      const value = normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
      return {
        element,
        clickable,
        rect,
        value,
        score:
          (value === needle ? 0 : 1000) +
          Math.abs(value.length - needle.length) +
          (['BUTTON', 'A', 'LABEL'].includes(clickable.tagName) ? 0 : 50),
      };
    })
    .sort((left, right) => left.score - right.score || left.rect.top - right.rect.top || left.rect.left - right.rect.left);

  if (candidates.length === 0) {
    return { __error: `Visible text not found: ${needle}` };
  }

  const rawIndex = Number.isInteger(options.index) ? options.index : 0;
  const index = rawIndex < 0 ? candidates.length + rawIndex : rawIndex;
  if (index < 0 || index >= candidates.length) {
    return { __error: `Text match index ${rawIndex} is out of range for ${candidates.length} candidates.` };
  }

  const candidate = candidates[index];
  candidate.clickable.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = candidate.clickable.getBoundingClientRect();
  candidate.clickable.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
  candidate.clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  candidate.clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  candidate.clickable.click();
  return {
    clicked: true,
    text: needle,
    matchedText: candidate.value,
    tagName: candidate.clickable.tagName.toLowerCase(),
    role: candidate.clickable.getAttribute('role') || '',
    index: rawIndex,
    candidateCount: candidates.length,
    x: rect.x,
    y: rect.y,
  };
}

function fillSelector(selector, value) {
  const element = document.querySelector(selector);
  if (!element) {
    return { __error: `Selector not found: ${selector}` };
  }

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  element.focus();

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    element.value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    return { __error: `Selector ${selector} did not match an input-like or contenteditable element.` };
  }

  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { filled: true, selector, contentEditable: element.isContentEditable };
}

function fillInteractiveRef(ref, value, selector = '') {
  const resolved = resolveInteractiveRef(ref, selector);
  if (resolved.__error) {
    return resolved;
  }
  const { element } = resolved;
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    element.value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    return { __error: 'Interactive ref did not resolve to an input-like or contenteditable element.' };
  }
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { filled: true, ref, contentEditable: element.isContentEditable };
}

function pressKey(key, modifiers = {}) {
  const target = document.activeElement || document.body || document.documentElement;
  const meta = modifiers.meta === true;
  const ctrl = modifiers.ctrl === true;
  const alt = modifiers.alt === true;
  const shift = modifiers.shift === true;
  const init = {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: meta,
    ctrlKey: ctrl,
    altKey: alt,
    shiftKey: shift,
  };
  if (meta && String(key).toLowerCase() === 'a') {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.select();
    } else {
      document.execCommand('selectAll');
    }
  } else if (meta && String(key).toLowerCase() === 'c') {
    document.execCommand('copy');
  } else if (meta && String(key).toLowerCase() === 'v') {
    document.execCommand('paste');
  }
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { key, modifiers: { meta, ctrl, alt, shift } };
}

function prepareFileInputBySelector(selector) {
  const value = String(selector || '').trim();
  if (!value) {
    return { __error: 'browser_file_upload requires selector or ref.' };
  }
  const element = document.querySelector(value);
  const fileInput = element instanceof HTMLInputElement && element.type === 'file'
    ? element
    : element?.querySelector?.('input[type="file"]') || null;
  if (!(fileInput instanceof HTMLInputElement) || fileInput.type !== 'file') {
    return { __error: `Selector ${value} did not match an input[type=file].` };
  }
  const marker = `cic-file-${Date.now()}`;
  fileInput.setAttribute('data-cic-file-target', marker);
  fileInput.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  fileInput.focus();
  return { selector: `input[type="file"][data-cic-file-target="${marker}"]` };
}

function scrollPage(selector, x = 0, y = 0) {
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) {
      return { __error: `Selector not found: ${selector}` };
    }
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { selector, scrolled: true };
  }

  window.scrollBy(x, y);
  return { x, y, scrolled: true };
}

function scrollInteractiveRef(ref, selector = '') {
  const resolved = resolveInteractiveRef(ref, selector);
  if (resolved.__error) {
    return resolved;
  }
  const { element } = resolved;
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  return {
    ref,
    scrolled: true,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function hoverSelector(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    return { __error: `Selector not found: ${selector}` };
  }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  element.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
  return { hovered: true, selector };
}

function selectOptionsBySelector(selector, values) {
  const element = document.querySelector(selector);
  if (!element) {
    return { __error: `Selector not found: ${selector}` };
  }
  if (!(element instanceof HTMLSelectElement)) {
    return { __error: 'Target is not a select element.' };
  }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  element.focus();
  const wanted = (Array.isArray(values) ? values : []).map((value) => String(value));
  const selected = [];
  if (element.multiple) {
    for (const option of element.options) {
      const match = wanted.includes(option.value) || wanted.includes(option.text) || wanted.includes(option.label);
      option.selected = match;
      if (match) {
        selected.push(option.value);
      }
    }
  } else {
    let matchIndex = -1;
    for (const value of wanted) {
      const index = [...element.options].findIndex((option) => (
        option.value === value || option.text === value || option.label === value
      ));
      if (index >= 0) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex >= 0) {
      element.selectedIndex = matchIndex;
      selected.push(element.options[matchIndex].value);
    }
  }
  if (selected.length === 0) {
    return { __error: 'No matching select option for the provided values.' };
  }
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { selected };
}

async function typeSelector(selector, text, slowly = false) {
  const element = selector
    ? document.querySelector(selector)
    : (document.activeElement || document.body || document.documentElement);
  if (!element) {
    return { __error: selector ? `Selector not found: ${selector}` : 'No active element to type into.' };
  }
  const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  if (!isField && !element.isContentEditable) {
    return { __error: 'Target did not match an input-like or contenteditable element.' };
  }
  const value = String(text ?? '');
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  element.focus();
  if (!slowly) {
    if (isField) {
      element.value = value;
    } else {
      element.textContent = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return { typed: true, length: value.length };
  }
  if (isField) {
    element.value = '';
  } else {
    element.textContent = '';
  }
  for (const char of value) {
    const init = { key: char, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keypress', init));
    if (isField) {
      element.value += char;
    } else {
      element.textContent = `${element.textContent || ''}${char}`;
    }
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { typed: true, length: value.length };
}

function getScreenshotScrollState() {
  const root = document.documentElement;
  const body = document.body;
  return {
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    viewportWidth: window.innerWidth || root.clientWidth || 1,
    viewportHeight: window.innerHeight || root.clientHeight || 1,
    documentWidth: Math.max(root.scrollWidth, body ? body.scrollWidth : 0, root.clientWidth, 1),
    documentHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0, root.clientHeight, 1),
    dpr: window.devicePixelRatio || 1,
  };
}

function setWindowScroll(x, y) {
  window.scrollTo({ left: Number(x) || 0, top: Number(y) || 0, behavior: 'instant' });
  return { scrollX: window.scrollX, scrollY: window.scrollY };
}

function installAndReadPageConsole() {
  const key = '__umbraPageConsole';
  const cap = 200;
  const formatArg = (value) => {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    const type = typeof value;
    if (type === 'string') {
      return value;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
      return String(value);
    }
    if (type === 'symbol') {
      return value.toString();
    }
    if (type === 'function') {
      return value.name ? `[function ${value.name}]` : '[function]';
    }
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  };
  if (!globalThis[key]) {
    const store = { messages: [] };
    const wrap = (level, methodName) => {
      const original = console[methodName].bind(console);
      console[methodName] = (...args) => {
        try {
          store.messages.push({
            level,
            text: args.map(formatArg).join(' ').slice(0, 2000),
            ts: Date.now(),
          });
          if (store.messages.length > cap) {
            store.messages.splice(0, store.messages.length - cap);
          }
        } catch {
          // Ignore console mirror failures.
        }
        return original(...args);
      };
    };
    wrap('error', 'error');
    wrap('warning', 'warn');
    wrap('info', 'info');
    wrap('info', 'log');
    wrap('debug', 'debug');
    globalThis[key] = store;
  }
  return { messages: globalThis[key].messages.slice(-cap) };
}

function hasSelector(selector) {
  return Boolean(document.querySelector(selector));
}

function waitForSelector(selector, options = {}) {
  const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 10_000, 120_000));
  const visible = options.visible === true;
  const startedAt = Date.now();

  const isMatch = () => {
    const element = document.querySelector(selector);
    if (!element) {
      return false;
    }
    if (!visible) {
      return true;
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
  };

  if (isMatch()) {
    return {
      selector,
      found: true,
      visible,
      strategy: 'immediate',
      elapsedMs: Date.now() - startedAt,
    };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(safetyPoll);
      observer.disconnect();
      callback();
    };
    const check = () => {
      if (!isMatch()) {
        return;
      }
      finish(() => resolve({
        selector,
        found: true,
        visible,
        strategy: 'mutation_observer',
        elapsedMs: Date.now() - startedAt,
      }));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for selector: ${selector}`)));
    }, timeoutMs);
    const observer = new MutationObserver(check);
    const safetyPoll = setInterval(check, 1_000);

    observer.observe(document.documentElement || document, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  });
}

async function buildPopupState() {
  const config = await loadBridgeConfig();
  const {
    bridgeStatus = { connectedCount: 0, ports: [], sessions: [] },
    bridgeDebug = null,
  } = await chrome.storage.local.get({
    bridgeStatus: { connectedCount: 0, ports: [], sessions: [] },
    bridgeDebug: null,
  });

  const sessions = [];
  for (const session of sessionStore.listSessions()) {
    const tabs = [];
    for (const tabId of session.tabIds) {
      const tab = await safeGetTab(tabId);
      if (!tab) {
        continue;
      }
      tabs.push({
        id: tab.id,
        title: tab.title || '(untitled)',
        url: tab.url || '',
      });
    }

    sessions.push({
      sessionId: session.sessionId,
      port: session.port,
      connected: session.connected,
      groupId: session.groupId,
      activeTabId: session.activeTabId,
      tabs,
    });
  }

  return { config, bridgeStatus, bridgeDebug, sessions };
}

async function getBridgePressure(sessionId, params = {}) {
  const session = sessionStore.ensureSession(sessionId, null, { touch: false });
  const {
    bridgeStatus = { connectedCount: 0, ports: [], updatedAt: null },
    bridgeDebug = null,
  } = await chrome.storage.local.get({
    bridgeStatus: { connectedCount: 0, ports: [], updatedAt: null },
    bridgeDebug: null,
  });
  const includeTabs = params.includeTabs !== false;
  const includePerformance = params.includePerformance === true;
  const maxTabSamples = Number.isInteger(params.maxTabSamples) && params.maxTabSamples > 0
    ? Math.min(params.maxTabSamples, 50)
    : 20;
  const ownedTabs = [];
  const missingTabIds = [];

  for (const tabId of [...session.tabIds]) {
    const tab = await safeGetTab(tabId);
    if (!tab) {
      invalidateContentAgent(tabId, 'missing_tab');
      sessionStore.releaseTab(tabId);
      missingTabIds.push(tabId);
      continue;
    }
    ownedTabs.push(tab);
  }

  if (missingTabIds.length > 0) {
    await sessionStore.persist();
  }

  const frozenCount = ownedTabs.filter((tab) => tab.discarded === true).length;
  const loadingCount = ownedTabs.filter((tab) => tab.status === 'loading').length;
  const pendingByTab = [...contentAgents.values()].map((agent) => ({
    tabId: agent.tabId,
    pendingRequestCount: agent.pending.size,
    ready: agent.ready === true && agent.disconnected !== true,
  }));
  const pendingRequestCount = pendingByTab.reduce((sum, item) => sum + item.pendingRequestCount, 0);
  const pressureScore = ownedTabs.length + loadingCount * 2 + Math.max(0, missingTabIds.length - frozenCount);
  const pressure = pressureScore >= 20 ? 'high' : pressureScore >= 10 ? 'medium' : 'low';
  const samples = includeTabs
    ? ownedTabs.slice(0, maxTabSamples).map((tab) => ({
        tabId: tab.id,
        title: tab.title || '(untitled)',
        url: tab.url || '',
        active: tab.active === true,
        status: tab.status || 'unknown',
        discarded: tab.discarded === true,
        pinned: tab.pinned === true,
        windowId: tab.windowId ?? null,
        groupId: tab.groupId ?? null,
      }))
    : [];
  const performanceMemory = includePerformance && performance?.memory
    ? {
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit ?? null,
        totalJSHeapSize: performance.memory.totalJSHeapSize ?? null,
        usedJSHeapSize: performance.memory.usedJSHeapSize ?? null,
      }
    : null;

  return {
    sessionId,
    generatedAt: Date.now(),
    pressure,
    score: pressureScore,
    connected: session.connected === true,
    port: session.port,
    groupId: session.groupId,
    activeTabId: session.activeTabId,
    ownedTabCount: ownedTabs.length,
    loadingTabCount: loadingCount,
    discardedTabCount: frozenCount,
    missingTabIds,
    tabSamples: samples,
    extension: {
      connectedCount: Number(bridgeStatus.connectedCount) || 0,
      portCount: Array.isArray(bridgeStatus.ports) ? bridgeStatus.ports.length : 0,
      ports: Array.isArray(bridgeStatus.ports) ? bridgeStatus.ports.slice(0, 50) : [],
      statusUpdatedAt: bridgeStatus.updatedAt || null,
      scannerState: bridgeDebug?.state || null,
      scannerUpdatedAt: bridgeDebug?.updatedAt || null,
    },
    contentAgents: {
      connectedCount: contentAgents.size,
      ownedTabCount: ownedTabs.filter((tab) => contentAgents.has(tab.id)).length,
      pendingRequestCount,
      queueDepthByTab: pendingByTab,
      fairness: {
        maxPendingPerTab: pendingByTab.reduce((max, item) => Math.max(max, item.pendingRequestCount), 0),
        tabsWithPendingRequests: pendingByTab.filter((item) => item.pendingRequestCount > 0).length,
      },
    },
    performance: performanceMemory,
  };
}

function base64FromBytes(bytes) {
  // A per-byte string append costs 389 ms on a 10 MB image because each step
  // grows a rope V8 has to flatten. Fixed windows joined once cost 54 ms for
  // byte-identical output, which matters because a full-page stitch can reach a
  // 2880 by 32000 canvas once device pixel ratio multiplies the capture height.
  const chunkSize = 32_768;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

// Returns the bare base64 payload, not a data URL. Every consumer either hands
// it straight to the caller or decodes it again, so wrapping it in a prefix here
// only to strip that prefix back off later copied the whole image twice more.
async function encodeCanvasBase64(canvas, format = 'png') {
  const blob = await canvas.convertToBlob({
    type: screenshotMimeType(format),
    quality: format === 'jpeg' ? 0.8 : undefined,
  });
  const buffer = await blob.arrayBuffer();
  return base64FromBytes(new Uint8Array(buffer));
}

async function captureSilentScreenshot(tab, { format, fullPage }) {
  if (!chrome.debugger || typeof chrome.debugger.attach !== 'function') {
    const error = new Error('Silent screenshot is unavailable because the debugger API is missing.');
    error.code = 'silent_screenshot_unavailable';
    throw error;
  }

  const commandParams = {
    ...screenshotCaptureOptions(format),
    fromSurface: true,
  };

  const captureOnce = async (target) => {
    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', commandParams);
    if (!result?.data) {
      const error = new Error('Silent screenshot returned no image data.');
      error.code = 'silent_screenshot_empty';
      throw error;
    }
    // Page.captureScreenshot already returns base64, so it is passed along as
    // it is rather than wrapped in a data URL prefix that the next step strips.
    return result.data;
  };

  try {
    return await withOwnedTabDebugger(tab.id, async (target) => {
      if (!fullPage) {
        return { dataUrl: await captureOnce(target), truncated: false };
      }

      const metrics = await executeInTab(tab.id, getScreenshotScrollState);
      const captureHeight = Math.min(metrics.documentHeight, FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX);
      const truncated = metrics.documentHeight > FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX;
      const viewportH = Math.max(1, metrics.viewportHeight);
      const maxScrollY = Math.max(0, metrics.documentHeight - viewportH);
      const slices = [];
      try {
        for (let y = 0; y < captureHeight; y += viewportH) {
          const scrollY = Math.min(y, maxScrollY);
          await executeInTab(tab.id, setWindowScroll, [metrics.scrollX, scrollY]);
          await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_STITCH_SETTLE_MS));
          slices.push({
            dataUrl: await captureOnce(target),
            destY: y,
            sourceY: Math.max(0, y - scrollY),
          });
        }
      } finally {
        await executeInTab(tab.id, setWindowScroll, [metrics.scrollX, metrics.scrollY]).catch(() => {});
      }

      return {
        dataUrl: await stitchScreenshotSlices(slices, {
          widthCss: metrics.viewportWidth,
          heightCss: captureHeight,
          dpr: metrics.dpr,
          format,
        }),
        truncated,
      };
    });
  } catch (error) {
    if (error?.code === 'silent_screenshot_empty' || error?.code === 'silent_screenshot_unavailable' || error?.code === 'debugger_unavailable') {
      if (error?.code === 'debugger_unavailable') {
        const missing = new Error('Silent screenshot is unavailable because the debugger API is missing.');
        missing.code = 'silent_screenshot_unavailable';
        throw missing;
      }
      throw error;
    }
    const wrapped = new Error(`Silent screenshot failed: ${error?.message || String(error)}`);
    wrapped.code = 'silent_screenshot_failed';
    throw wrapped;
  }
}

// Accepts either a full data URL, which is what the visible-tab capture API
// returns, or the bare base64 payload that Page.captureScreenshot already hands
// back. Taking both means the debugger path never wraps a prefix on just to
// have it stripped off again one line later.
function dataUrlToBlob(dataUrl, fallbackMime = 'image/png') {
  const raw = String(dataUrl || '');
  if (!raw) {
    const error = new Error('Screenshot data URL is missing payload.');
    error.code = 'screenshot_data_url_invalid';
    throw error;
  }

  let payload = raw;
  let mime = fallbackMime;
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    if (comma < 0) {
      const error = new Error('Screenshot data URL is missing payload.');
      error.code = 'screenshot_data_url_invalid';
      throw error;
    }
    const header = raw.slice(0, comma);
    if (!/;base64/i.test(header)) {
      const error = new Error('Screenshot data URL must be base64.');
      error.code = 'screenshot_data_url_invalid';
      throw error;
    }
    payload = raw.slice(comma + 1);
    const mimeMatch = header.match(/^data:([^;,]+)/i);
    mime = mimeMatch ? mimeMatch[1] : fallbackMime;
  }

  // MV3 connect-src rejects data URLs. Decode locally.
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function imageBitmapFromDataUrl(dataUrl, fallbackMime = 'image/png') {
  return await createImageBitmap(dataUrlToBlob(dataUrl, fallbackMime));
}

// Takes a data URL or a bare base64 payload and returns bare base64.
async function cropScreenshotDataUrl(dataUrl, region = null, devicePixelRatio = 1, format = 'png') {
  if (!region) {
    return dataUrl;
  }
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    const error = new Error('Screenshot crop is unavailable in this Chrome context.');
    error.code = 'screenshot_crop_unavailable';
    throw error;
  }
  const image = await imageBitmapFromDataUrl(dataUrl, screenshotMimeType(format));
  const dpr = Math.max(1, Number(devicePixelRatio) || 1);
  const sourceX = Math.max(0, Math.round(Number(region.x || 0) * dpr));
  const sourceY = Math.max(0, Math.round(Number(region.y || 0) * dpr));
  const sourceW = Math.max(1, Math.round(Number(region.width ?? region.w ?? image.width) * dpr));
  const sourceH = Math.max(1, Math.round(Number(region.height ?? region.h ?? image.height) * dpr));
  const clampedW = Math.max(1, Math.min(sourceW, image.width - sourceX));
  const clampedH = Math.max(1, Math.min(sourceH, image.height - sourceY));
  const canvas = new OffscreenCanvas(clampedW, clampedH);
  const context = canvas.getContext('2d');
  context.drawImage(image, sourceX, sourceY, clampedW, clampedH, 0, 0, clampedW, clampedH);
  return await encodeCanvasBase64(canvas, format);
}

// Takes slices holding data URLs or bare base64 payloads, returns bare base64.
async function stitchScreenshotSlices(slices, { widthCss, heightCss, dpr, format }) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    const error = new Error('Full page screenshot stitch is unavailable in this Chrome context.');
    error.code = 'screenshot_stitch_unavailable';
    throw error;
  }
  const scale = Math.max(1, Number(dpr) || 1);
  const canvasW = Math.max(1, Math.round(Number(widthCss) * scale));
  const canvasH = Math.max(1, Math.round(Number(heightCss) * scale));
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvasW, canvasH);
  for (const slice of slices) {
    const image = await imageBitmapFromDataUrl(slice.dataUrl, screenshotMimeType(format));
    const destY = Math.round(Number(slice.destY || 0) * scale);
    const sourceY = Math.max(0, Math.round(Number(slice.sourceY || 0) * scale));
    const drawH = Math.min(image.height - sourceY, canvasH - destY);
    if (drawH <= 0) {
      continue;
    }
    context.drawImage(image, 0, sourceY, image.width, drawH, 0, destY, image.width, drawH);
  }
  return await encodeCanvasBase64(canvas, format);
}

// Ref resolution goes through the content agent only, exactly as browser_scroll
// and browser_click do, because the agent owns the shared ref store the ref was
// minted from. There is no one-shot fallback here on purpose: chrome.scripting
// serializes an injected function without its scope, so a one-shot copy of the
// resolver cannot reach the helpers it is built from and would replace a clear
// agent error with an unresolved-identifier one.
async function resolveScreenshotRefRect(tabId, ref, selector = '') {
  const result = await sendContentAgentCommand(tabId, 'scroll_interactive_ref', {
    ref,
    options: selector ? { selector } : {},
  });
  if (result?.__error) {
    const error = new Error(result.__error);
    error.code = result.__errorCode || result.code;
    throw error;
  }
  return result;
}

async function buildScreenshotPreflight(tab) {
  const window = await safeGetWindow(tab.windowId);
  return {
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    tabActive: tab.active === true,
    tabStatus: tab.status || 'unknown',
    windowId: tab.windowId ?? null,
    windowFocused: window?.focused === true,
    width: tab.width ?? null,
    height: tab.height ?? null,
    recommendation: 'Retry after the tab finishes loading, or capture without crop if the failure came from image readback.',
  };
}

async function buildSessionStatus(sessionId) {
  const session = sessionStore.ensureSession(sessionId);
  const tabs = [];
  const missingTabIds = [];

  for (const tabId of [...session.tabIds]) {
    const tab = await safeGetTab(tabId);
    if (tab) {
      tabs.push(await serializeTab(tab));
    } else {
      invalidateContentAgent(tabId, 'missing_tab');
      sessionStore.releaseTab(tabId);
      missingTabIds.push(tabId);
    }
  }

  if (missingTabIds.length > 0) {
    await sessionStore.persist();
  }

  const group = await serializeSessionGroup(sessionId);
  const windowIds = [...new Set(tabs.map((tab) => tab.windowId).filter(Number.isInteger))];
  const preservedWindowIds = [];
  const removableWindowIds = [];

  for (const windowId of windowIds) {
    const windowTabs = await chrome.tabs.query({ windowId }).catch(() => []);
    const allTabsOwnedBySession =
      windowTabs.length > 0 &&
      windowTabs.every((tab) => sessionStore.findOwner(tab.id) === sessionId);
    if (allTabsOwnedBySession) {
      removableWindowIds.push(windowId);
    } else {
      preservedWindowIds.push(windowId);
    }
  }

  const manifest = chrome.runtime.getManifest();
  return {
    sessionId,
    extensionName: manifest.name,
    extensionVersion: manifest.version,
    port: session.port,
    connected: session.connected,
    group,
    activeTabId: session.activeTabId,
    tabCount: tabs.length,
    tabs,
    missingTabIds,
    cleanup: {
      ownedTabsCanClose: tabs.length > 0,
      removableWindowIds,
      preservedWindowIds,
      wouldCloseWindowCount: removableWindowIds.length,
      wouldPreserveWindowCount: preservedWindowIds.length,
    },
  };
}

async function handleBridgeCommand(message) {
  const { sessionId, tool, params = {} } = message;
  const connectionChanged = sessionStore.markConnected(sessionId, message.port ?? null);
  if (connectionChanged) {
    await sessionStore.persist();
  }

  if (tool === 'browser_get_session_status') {
    return await buildSessionStatus(sessionId);
  }

  if (tool === 'browser_list_tabs') {
    const tabs = [];
    let releasedMissingTab = false;
    for (const tabId of sessionStore.listTabIds(sessionId)) {
      const tab = await safeGetTab(tabId);
      if (tab) {
        tabs.push(await serializeTab(tab));
      } else {
        sessionStore.releaseTab(tabId);
        releasedMissingTab = true;
      }
    }
    if (releasedMissingTab) {
      await sessionStore.persist();
    }
    const session = sessionStore.ensureSession(sessionId);
    const group = await serializeSessionGroup(sessionId);
    return {
      sessionId,
      group,
      activeTabId: session.activeTabId,
      tabs,
    };
  }

  if (tool === 'browser_tabs_context') {
    const includeInternal = params.includeInternal === true;
    const createIfEmpty = params.createIfEmpty === true;
    let releasedMissingTab = false;
    let created = false;
    let ownedCount = 0;
    for (const tabId of sessionStore.listTabIds(sessionId)) {
      const tab = await safeGetTab(tabId);
      if (tab) {
        ownedCount += 1;
      } else {
        sessionStore.releaseTab(tabId);
        releasedMissingTab = true;
      }
    }
    if (createIfEmpty && ownedCount === 0) {
      const createdTab = await getOrCreateSessionTab(sessionId, {
        createIfMissing: true,
        newTab: true,
        activate: false,
        url: 'about:blank',
      });
      await ensureSessionGroup(sessionId, createdTab.id, { groupCollapsed: true });
      created = true;
    } else if (releasedMissingTab) {
      await sessionStore.persist();
    }

    const ownedIds = new Set(sessionStore.listTabIds(sessionId));
    const chromeTabs = await chrome.tabs.query({});
    const tabs = [];
    for (const tab of chromeTabs) {
      const url = tab.url || '';
      if (!isTabsContextUrl(url, includeInternal)) {
        continue;
      }
      tabs.push({
        tabId: tab.id,
        title: tab.title || '(untitled)',
        url,
        active: tab.active === true,
        windowId: tab.windowId ?? null,
        owned: ownedIds.has(tab.id),
      });
    }
    return { sessionId, created, tabs };
  }

  if (tool === 'browser_find_tabs') {
    return await findChromeTabs(params);
  }

  if (tool === 'browser_adopt_tab') {
    return await adoptExistingTab(sessionId, params);
  }

  if (tool === 'browser_find_groups') {
    return await findChromeGroups(params);
  }

  if (tool === 'browser_adopt_group') {
    return await adoptChromeGroup(sessionId, params);
  }

  if (tool === 'browser_create_tab') {
    const url = normalizeBridgeUrl(params.url || 'about:blank');
    const tab = await getOrCreateSessionTab(sessionId, {
      createIfMissing: true,
      newTab: true,
      activate: params.activate === true,
      url,
      newWindow: params.newWindow === true,
    });
    await ensureSessionGroup(sessionId, tab.id, {
      groupTitle: params.groupTitle,
      groupColor: params.groupColor,
      groupCollapsed: params.groupCollapsed,
    });
    let loadTimedOut = false;
    if (url !== 'about:blank') {
      const waited = await waitForTabComplete(tab.id, clampTimeoutMs(params.timeoutMs), url);
      loadTimedOut = waited?.timedOut === true;
    }
    const updated = await safeGetTab(tab.id);
    return {
      ...(await serializeTab(updated || tab)),
      loadTimedOut,
    };
  }

  if (tool === 'browser_group_tabs') {
    return await groupSessionTabs(sessionId, params);
  }

  if (tool === 'browser_navigate') {
    const activate = params.activate === true;
    const url = normalizeBridgeUrl(params.url);
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: true,
      newTab: params.newTab === true,
      activate,
      url,
      newWindow: params.newWindow === true,
    });
    await ensureSessionGroup(sessionId, tab.id, {
      groupTitle: params.groupTitle,
      groupColor: params.groupColor,
      groupCollapsed: params.groupCollapsed,
    });
    invalidateTabReadCache(tab.id);
    await chrome.tabs.update(
      tab.id,
      activate ? { url, active: true } : { url },
    );
    const waited = await waitForTabComplete(tab.id, clampTimeoutMs(params.timeoutMs), url, {
      navigationPending: true,
    });
    const updated = await safeGetTab(tab.id);
    return {
      ...(await serializeTab(updated || tab)),
      loadTimedOut: waited?.timedOut === true,
    };
  }

  if (tool === 'browser_switch_tab') {
    const tab = await getOwnedTab(sessionId, params.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    sessionStore.setActiveTab(sessionId, tab.id);
    await sessionStore.persist();
    return { tabId: tab.id, active: true };
  }

  if (tool === 'browser_close_tab') {
    const tab = await getOwnedTab(sessionId, params.tabId);
    invalidateContentAgent(tab.id, 'tab_closed');
    await chrome.tabs.remove(tab.id);
    sessionStore.releaseTab(tab.id);
    await sessionStore.persist();
    return { tabId: tab.id, closed: true };
  }

  if (tool === 'browser_close_session_tabs') {
    return await closeSessionTabs(sessionId);
  }

  if (tool === 'browser_mark_debug_group') {
    return await markDebugGroup(sessionId, params);
  }

  if (tool === 'browser_freeze_session_tabs') {
    return await freezeSessionTabs(sessionId, params);
  }

  if (tool === 'browser_cleanup_groups') {
    return await cleanupGroups(params);
  }

  if (tool === 'browser_screenshot') {
    const silent = params.silent === true;
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: silent ? false : true,
    });
    const format = normalizeScreenshotFormat(params.format);
    const fullPage = params.fullPage === true;
    const zoom = normalizeScreenshotZoom(params.zoom);
    let region = !fullPage && params.region && typeof params.region === 'object' ? params.region : null;
    if (!fullPage && !region && typeof params.ref === 'string' && params.ref.trim()) {
      // Resolve through the content agent, the same path browser_scroll and
      // browser_click use, because the agent owns the shared ref store the ref
      // was minted from. The one-shot injection resolves refs by re-deriving an
      // index, so it can only ever approximate what the agent already knows.
      const refResult = await resolveScreenshotRefRect(tab.id, params.ref, params.selector || '');
      region = refResult?.rect || null;
    }
    if (!fullPage && zoom > 1 && !region) {
      const metrics = await executeInTab(tab.id, getScreenshotScrollState);
      region = {
        x: 0,
        y: 0,
        width: metrics.viewportWidth,
        height: metrics.viewportHeight,
      };
    }
    if (!fullPage && region) {
      region = applyScreenshotZoom(region, zoom);
    }
    let dataUrl;
    let truncated = false;
    try {
      if (silent) {
        const silentCapture = await captureSilentScreenshot(tab, { format, fullPage });
        dataUrl = silentCapture.dataUrl;
        truncated = Boolean(silentCapture.truncated);
        if (!fullPage) {
          const devicePixelRatio = region
            ? await executeInTab(tab.id, () => window.devicePixelRatio || 1).catch(() => 1)
            : 1;
          dataUrl = await cropScreenshotDataUrl(dataUrl, region, devicePixelRatio, format);
        }
      } else if (fullPage) {
        const metrics = await executeInTab(tab.id, getScreenshotScrollState);
        const captureHeight = Math.min(metrics.documentHeight, FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX);
        truncated = metrics.documentHeight > FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX;
        const viewportH = Math.max(1, metrics.viewportHeight);
        const maxScrollY = Math.max(0, metrics.documentHeight - viewportH);
        const slices = [];
        try {
          for (let y = 0; y < captureHeight; y += viewportH) {
            const scrollY = Math.min(y, maxScrollY);
            await executeInTab(tab.id, setWindowScroll, [metrics.scrollX, scrollY]);
            await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_STITCH_SETTLE_MS));
            const sliceDataUrl = await chrome.tabs.captureVisibleTab(
              tab.windowId,
              screenshotCaptureOptions(format),
            );
            slices.push({
              dataUrl: sliceDataUrl,
              destY: y,
              sourceY: Math.max(0, y - scrollY),
            });
          }
        } finally {
          await executeInTab(tab.id, setWindowScroll, [metrics.scrollX, metrics.scrollY]).catch(() => {});
        }
        dataUrl = await stitchScreenshotSlices(slices, {
          widthCss: metrics.viewportWidth,
          heightCss: captureHeight,
          dpr: metrics.dpr,
          format,
        });
      } else {
        const fullDataUrl = await chrome.tabs.captureVisibleTab(
          tab.windowId,
          screenshotCaptureOptions(format),
        );
        const devicePixelRatio = region
          ? await executeInTab(tab.id, () => window.devicePixelRatio || 1).catch(() => 1)
          : 1;
        dataUrl = await cropScreenshotDataUrl(fullDataUrl, region, devicePixelRatio, format);
      }
    } catch (error) {
      error.preflight = await buildScreenshotPreflight(tab);
      throw error;
    }
    return {
      tabId: tab.id,
      activated: !silent,
      silent,
      zoom,
      mimeType: screenshotMimeType(format),
      cropped: Boolean(region),
      region: region || null,
      fullPage,
      format,
      ...(truncated ? { truncated: true } : {}),
      preflight: await buildScreenshotPreflight(tab),
      data: stripScreenshotDataUrl(dataUrl),
    };
  }

  if (tool === 'browser_get_page_content') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
      updateActive: false,
      persist: false,
    });
    return await readPageContentViaAgent(sessionId, tab.id, {
      format: params.format || 'text',
      mode: params.mode || '',
      selector: params.selector || '',
      maxChars: params.maxChars,
      includeImages: params.includeImages === true,
    });
  }

  if (tool === 'browser_read_interactive') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
      updateActive: false,
      persist: false,
    });
    return await readInteractiveViaAgent(sessionId, tab.id, {
      selector: params.selector || '',
      maxItems: params.maxItems,
    });
  }

  if (tool === 'browser_read_page') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
      updateActive: false,
      persist: false,
    });
    const result = await readAxTreeViaAgent(sessionId, tab.id, {
      filter: params.filter,
      maxNodes: params.maxNodes,
      selector: params.selector || '',
    });
    if (result?.__error) {
      throw new Error(result.__error);
    }
    return {
      tabId: tab.id,
      url: result.url,
      title: result.title,
      domVersion: result.domVersion,
      nodes: result.nodes || [],
    };
  }

  if (tool === 'browser_find') {
    const query = String(params.query || '').trim();
    if (!query) {
      throw new Error('browser_find requires query.');
    }
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
      updateActive: false,
      persist: false,
    });
    const result = await findAxNodesViaAgent(sessionId, tab.id, {
      query,
      selector: params.selector || '',
      limit: params.limit,
    });
    if (result?.__error) {
      throw new Error(result.__error);
    }
    return {
      tabId: tab.id,
      query,
      matches: result.matches || [],
    };
  }

  if (tool === 'browser_form_input') {
    const { selector, ref } = requireSelectorOrRef(params, 'browser_form_input');
    if (params.value === undefined && typeof params.checked !== 'boolean') {
      throw new Error('browser_form_input requires value or checked.');
    }
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const result = await formInputViaAgent(tab.id, {
      selector,
      ref,
      value: params.value,
      checked: params.checked,
    });
    return {
      tabId: tab.id,
      ...result,
    };
  }

  if (tool === 'browser_get_bridge_pressure') {
    return await getBridgePressure(sessionId, params);
  }

  if (tool === 'browser_get_technical_snapshot') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
      updateActive: false,
      persist: false,
    });
    return await executeInTabWithRetry(tab.id, getTechnicalSnapshot, [{
      includeHtml: params.includeHtml === true,
    }]);
  }

  if (tool === 'browser_run_page_action') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    // Keep the injection result. A recipe file that is present but fails to
    // inject and one that is genuinely absent are different failures with
    // different fixes, and the reason was being computed and then discarded, so
    // both reported "not installed in this build".
    const recipe = await ensurePageRecipe(tab.id, params.action);
    return await executeInTabWithRetry(tab.id, runPageAction, [
      params.action,
      params.params && typeof params.params === 'object' ? params.params : {},
      { timeoutMs: params.timeoutMs, recipeFailure: recipe.installed ? '' : (recipe.reason || '') },
    ]);
  }

  if (tool === 'browser_javascript') {
    const code = requireJavascriptCode(params.code);
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    return await executeJavascriptViaAgent(tab.id, code, { timeoutMs: params.timeoutMs });
  }

  if (tool === 'browser_click') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const doubleClick = params.doubleClick === true;
    const hasRef = typeof params.ref === 'string' && Boolean(params.ref.trim());
    const hasSelector = typeof params.selector === 'string' && Boolean(params.selector.trim());
    const hasCoords = Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y));
    if (!hasRef && !hasSelector && !hasCoords) {
      throw new Error('browser_click requires selector, ref, or both x and y.');
    }
    if (hasCoords) {
      return await executeInTab(tab.id, clickAtPoint, [Number(params.x), Number(params.y), doubleClick]);
    }
    if (hasRef) {
      const result = await sendContentAgentCommand(tab.id, 'click_interactive_ref', {
        ref: params.ref,
        options: {
          ...(params.selector ? { selector: params.selector } : {}),
          doubleClick,
        },
      });
      if (result?.__error) {
        const error = new Error(result.__error);
        error.code = result.__errorCode || result.code;
        throw error;
      }
      return result;
    }
    return await executeInTab(tab.id, clickSelector, [params.selector, doubleClick]);
  }

  if (tool === 'browser_click_text') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    return await executeInTab(tab.id, clickVisibleText, [params.text, {
      exact: params.exact !== false,
      selector: params.selector || '',
      index: Number.isInteger(params.index) ? params.index : 0,
    }]);
  }

  if (tool === 'browser_fill') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    if (typeof params.ref === 'string' && params.ref.trim()) {
      const result = await sendContentAgentCommand(tab.id, 'fill_interactive_ref', {
        ref: params.ref,
        value: params.value,
        options: params.selector ? { selector: params.selector } : {},
      });
      if (result?.__error) {
        const error = new Error(result.__error);
        error.code = result.__errorCode || result.code;
        throw error;
      }
      return result;
    }
    return await executeInTab(tab.id, fillSelector, [params.selector, params.value]);
  }

  if (tool === 'browser_file_upload') {
    const filePath = requireAbsoluteFilePath(params.filePath);
    const { selector, ref } = requireSelectorOrRef(params, 'browser_file_upload');
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const targetSelector = await resolveFileInputSelector(tab.id, selector, ref);
    await setOwnedTabFileInput(tab.id, targetSelector, filePath);
    return { tabId: tab.id, uploaded: true, filePath };
  }

  if (tool === 'browser_press_key') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const chord = parseShortcutChord(String(params.key || ''), null);
    return await executeInTab(tab.id, pressKey, [chord.key, chord.modifiers]);
  }

  if (tool === 'browser_shortcut') {
    if (params.list === true) {
      return { shortcuts: SHORTCUT_CATALOG };
    }
    const chord = parseShortcutSpec(params);
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const result = await executeInTab(tab.id, pressKey, [chord.key, chord.modifiers]);
    return { tabId: tab.id, dispatched: true, name: chord.name, ...result };
  }

  if (tool === 'browser_scroll') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    if (typeof params.ref === 'string' && params.ref.trim()) {
      const result = await sendContentAgentCommand(tab.id, 'scroll_interactive_ref', {
        ref: params.ref,
        options: params.selector ? { selector: params.selector } : {},
      });
      if (result?.__error) {
        const error = new Error(result.__error);
        error.code = result.__errorCode || result.code;
        throw error;
      }
      return result;
    }
    return await executeInTab(tab.id, scrollPage, [params.selector || '', params.x || 0, params.y || 0]);
  }

  if (tool === 'browser_wait') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
      updateActive: false,
      persist: false,
    });
    return await waitForSelectorViaAgent(tab.id, params.selector, {
      timeoutMs: params.timeoutMs,
      visible: params.visible === true,
    });
  }

  if (tool === 'browser_resize') {
    const width = requirePositiveInteger(params.width, 'width');
    const height = requirePositiveInteger(params.height, 'height');
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    await assertWindowOwnedExclusively(sessionId, tab.windowId);
    const updated = await chrome.windows.update(tab.windowId, {
      width,
      height,
      state: 'normal',
      focused: false,
    });
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      width: updated?.width ?? width,
      height: updated?.height ?? height,
      resized: true,
    };
  }

  if (tool === 'browser_navigate_back') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    try {
      await chrome.tabs.goBack(tab.id);
    } catch {
      return { tabId: tab.id, moved: false, reason: 'no-history' };
    }
    await waitForTabComplete(tab.id, clampTimeoutMs(params.timeoutMs));
    const updated = await safeGetTab(tab.id);
    return { tabId: tab.id, moved: true, url: updated?.url || tab.url || '' };
  }

  if (tool === 'browser_navigate_forward') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    try {
      await chrome.tabs.goForward(tab.id);
    } catch {
      return { tabId: tab.id, moved: false, reason: 'no-history' };
    }
    await waitForTabComplete(tab.id, clampTimeoutMs(params.timeoutMs));
    const updated = await safeGetTab(tab.id);
    return { tabId: tab.id, moved: true, url: updated?.url || tab.url || '' };
  }

  if (tool === 'browser_hover') {
    const { selector, ref } = requireSelectorOrRef(params, 'browser_hover');
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    if (ref) {
      const result = await sendContentAgentCommand(tab.id, 'hover_interactive_ref', {
        ref,
        options: selector ? { selector } : {},
      });
      if (result?.__error) {
        const error = new Error(result.__error);
        error.code = result.__errorCode || result.code;
        throw error;
      }
      return { tabId: tab.id, hovered: true };
    }
    await executeInTab(tab.id, hoverSelector, [selector]);
    return { tabId: tab.id, hovered: true };
  }

  if (tool === 'browser_select_option') {
    const { selector, ref } = requireSelectorOrRef(params, 'browser_select_option');
    if (!Array.isArray(params.values) || params.values.length === 0) {
      throw new Error('browser_select_option requires a non-empty values array.');
    }
    const values = params.values.map((value) => String(value));
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    if (ref) {
      const result = await sendContentAgentCommand(tab.id, 'select_interactive_ref', {
        ref,
        values,
        options: selector ? { selector } : {},
      });
      if (result?.__error) {
        const error = new Error(result.__error);
        error.code = result.__errorCode || result.code;
        throw error;
      }
      return { tabId: tab.id, selected: result.selected || [] };
    }
    const result = await executeInTab(tab.id, selectOptionsBySelector, [selector, values]);
    return { tabId: tab.id, selected: result?.selected || [] };
  }

  if (tool === 'browser_type') {
    if (params.text === undefined || params.text === null) {
      throw new Error('browser_type requires text.');
    }
    const text = String(params.text);
    const slowly = params.slowly === true;
    const submit = params.submit === true;
    const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    if (!slowly) {
      if (ref) {
        const result = await sendContentAgentCommand(tab.id, 'fill_interactive_ref', {
          ref,
          value: text,
          options: selector ? { selector } : {},
        });
        if (result?.__error) {
          const error = new Error(result.__error);
          error.code = result.__errorCode || result.code;
          throw error;
        }
      } else if (selector) {
        await executeInTab(tab.id, fillSelector, [selector, text]);
      } else {
        await executeInTab(tab.id, typeSelector, ['', text, false]);
      }
    } else if (ref) {
      const result = await sendContentAgentCommand(tab.id, 'type_interactive_ref', {
        ref,
        text,
        options: {
          ...(selector ? { selector } : {}),
          slowly: true,
        },
      });
      if (result?.__error) {
        const error = new Error(result.__error);
        error.code = result.__errorCode || result.code;
        throw error;
      }
    } else {
      await executeInTab(tab.id, typeSelector, [selector || '', text, true]);
    }
    if (submit) {
      await executeInTab(tab.id, pressKey, ['Enter']);
    }
    return { tabId: tab.id, typed: true, length: text.length };
  }

  if (tool === 'browser_console_messages') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
      updateActive: false,
      persist: false,
    });
    const level = ['error', 'warning', 'info', 'debug'].includes(params.level) ? params.level : 'info';
    const all = params.all === true;
    try {
      const agentResult = await sendContentAgentCommand(tab.id, 'read_console_messages', {});
      for (const message of agentResult?.messages || []) {
        pushConsoleMessage(tab.id, message);
      }
    } catch (error) {
      if (!useOneShotContentFallback(error)) {
        throw error;
      }
    }
    try {
      const pageResult = await executeInTab(tab.id, installAndReadPageConsole, [], { world: 'MAIN' });
      for (const message of pageResult?.messages || []) {
        pushConsoleMessage(tab.id, message);
      }
    } catch {
      // MAIN-world console wrap is best effort if the page blocks it.
    }
    return {
      tabId: tab.id,
      messages: filterConsoleMessages(tab.id, { level, all }),
    };
  }

  if (tool === 'browser_reload_extension') {
    setTimeout(() => {
      chrome.runtime.reload();
    }, 250);
    return { ok: true, reloading: true };
  }

  throw new Error(`Unsupported tool: ${tool}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    // bridge_command, bridge_session_connected, and bridge_session_disconnected
    // all write session state, and a message can wake a cold worker. Await the
    // one-time load rather than all of initialize(), which would put offscreen
    // document creation on the critical path of every command.
    await sessionStoreReady;
    switch (message?.type) {
      case 'bridge_command':
        return await handleBridgeCommand(message);
      case 'bridge_session_connected':
        sessionStore.markConnected(message.sessionId, message.port ?? null);
        await sessionStore.persist();
        return { ok: true };
      case 'bridge_session_disconnected': {
        invalidateSessionContentAgents(message.sessionId, 'session_disconnected');
        sessionStore.markDisconnected(message.sessionId);
        await sessionStore.persist();
        return { ok: true };
      }
      case 'bridge_reconnect':
        await restartOffscreenDocument();
        return { ok: true };
      case 'bridge_get_runtime_config': {
        const installId = await ensureInstallId();
        const config = await loadBridgeConfig();
        return { ok: true, config: { ...config, installId } };
      }
      case 'bridge_debug_status':
        await chrome.storage.local.set({ bridgeDebug: message.status });
        return { ok: true };
      case 'bridge_get_status':
        return await buildPopupState();
      case 'bridge_save_config': {
        const config = await saveBridgeConfig(message.config || {});
        await restartOffscreenDocument();
        return { ok: true, config };
      }
      case 'bridge_status_update':
        await chrome.storage.local.set({ bridgeStatus: message.status });
        return { ok: true };
      default:
        return { ok: false };
    }
  })()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ __error: serializeError(error) }));

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  consoleBuffers.delete(tabId);
  invalidateContentAgent(tabId, 'tab_removed');
  if (sessionStore.releaseTab(tabId)) {
    await sessionStore.persist();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.url) {
    markConsoleNavigation(tabId);
  }
  if (changeInfo?.url || changeInfo?.status === 'loading') {
    invalidateContentAgent(tabId, 'navigation');
  }
});

chrome.tabGroups.onRemoved?.addListener(async (group) => {
  for (const session of sessionStore.listSessions()) {
    if (session.groupId === group.id) {
      session.groupId = null;
      await sessionStore.persist();
      break;
    }
  }
});

chrome.windows.onRemoved?.addListener((windowId) => {
  clearDedicatedWindowId(windowId).catch(() => {});
});

async function initialize(reason = 'initialize') {
  if (initializePromise) {
    return initializePromise;
  }

  initializePromise = (async () => {
    // The one-minute wake alarm calls this on every tick. Only the alarm itself
    // and the offscreen document are re-ensured, because resurrecting a dead
    // offscreen document is the alarm's whole purpose. Re-reading session state
    // on a tick would replace the live map and discard any tab an in-flight
    // command just claimed, leaving that tab in Chrome and owned by nobody.
    if (!bootstrapped) {
      await chrome.storage.local.set({
        bridgeDebug: {
          updatedAt: Date.now(),
          state: 'initializing',
          message: `Ensuring Umbra scanner (${reason}).`,
        },
      });
      await ensureInstallId();
      await sessionStoreReady;
      bootstrapped = true;
    }
    await ensureBridgeWakeAlarm();
    await ensureOffscreenDocument();
  })();

  try {
    await initializePromise;
  } finally {
    initializePromise = null;
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_WAKE_ALARM_NAME) {
    return;
  }

  initialize('alarm').catch((error) => console.error('[bridge] alarm init failed', error));
});

chrome.runtime.onInstalled.addListener((details) => {
  initialize('installed').catch((error) => console.error('[bridge] install init failed', error));
  if (details?.reason !== 'install') {
    return;
  }
  // A first install lands on a popup asking for a shared key it has never
  // explained. The options page is where the key gets generated and where the
  // rest of the setup is written down, so open it once, on install only.
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('[bridge] could not open the options page on install', error);
  }
});

chrome.runtime.onStartup.addListener(() => {
  initialize('startup').catch((error) => console.error('[bridge] startup init failed', error));
});

void initialize('worker_boot');

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
const CURSOR_OVERLAY_SCRIPT = 'cursor-overlay.js';
// Glide time scales with travel distance between these two, so a short hop does
// not sit through a full half second before the real dispatch runs.
const CURSOR_MIN_GLIDE_MS = 260;
const CURSOR_MAX_GLIDE_MS = 520;
// Distance, in CSS pixels, at which a glide reaches CURSOR_MAX_GLIDE_MS.
const CURSOR_FULL_TRAVEL_PX = 900;
// How long browser_screenshot waits for an already-started cursor injection to
// land before hiding and capturing anyway.
const CURSOR_SETTLE_BEFORE_CAPTURE_MS = 150;
// The install setting is read from chrome.storage on a short TTL rather than on
// every click, because a per-action storage round trip would show up as latency
// on the one path that has to stay fast.
const CURSOR_CONFIG_TTL_MS = 5_000;
// Recording defaults and bounds. The schema in mcp-server/tools.js states the
// same numbers to the caller; these are what an omitted parameter becomes.
const GIF_DEFAULT_FPS = 4;
const GIF_MIN_FPS = 1;
const GIF_MAX_FPS = 10;
const GIF_DEFAULT_MAX_FRAMES = 120;
const GIF_MIN_MAX_FRAMES = 2;
const GIF_MAX_MAX_FRAMES = 300;
const GIF_DEFAULT_MAX_WIDTH = 800;
const GIF_MIN_MAX_WIDTH = 160;
const GIF_MAX_MAX_WIDTH = 1600;
const GIF_DEFAULT_QUALITY = 10;
const GIF_MIN_QUALITY = 1;
const GIF_MAX_QUALITY = 30;
const GIF_DEFAULT_WATERMARK = 'Umbra';
// A recording that outlives this is torn down wherever the check runs first.
// The shim and the broker both cap a single call at 185000 ms, so a recording
// left running past three minutes has already outlived any call that could stop
// it, and the tab would keep its attachment and its automation banner forever.
const MAX_RECORDING_MS = 180_000;
const CONTENT_AGENT_READY_TIMEOUT_MS = 2_000;
const CONTENT_AGENT_COMMAND_TIMEOUT_MS = 120_000;
const READ_CACHE_TTL_MS = 1_500;
const FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX = 16_000;
const CONSOLE_MESSAGE_CAP = 200;
// One console call can reach the buffer twice: once as a Runtime.consoleAPICalled
// event and once from the MAIN-world mirror, with timestamps a few milliseconds
// apart. An exact-timestamp check let both in.
const CONSOLE_CROSS_SOURCE_WINDOW_MS = 1_000;
// Runtime.consoleAPICalled is delivered on its own task, and the debugger
// detaches the moment the evaluate callback returns, so queued events need one
// turn to land before the attachment goes away.
const CONSOLE_DRAIN_MS = 50;
const SCREENSHOT_STITCH_SETTLE_MS = 120;
// browser_press_key takes a space-separated sequence and a repeat count. The
// gap keeps each keystroke a separate task, and the dispatch cap stops one call
// from holding the worker for minutes. Drag and scroll bounds are not here
// because those functions are stringified into the page, where a worker
// constant does not resolve; they carry their own numbers.
const KEY_SEQUENCE_GAP_MS = 20;
const KEY_SEQUENCE_MAX_DISPATCHES = 400;
// Request-log ring size per tab. A busy page fires a few hundred requests on
// first paint, so this is deep enough to survive one page load and shallow
// enough that the worker never holds more than a few hundred small objects.
const NETWORK_LOG_CAP = 400;
// A log left running holds a debugger attachment, and an attachment shows
// Chrome's automation banner. Five idle minutes ends it, so a caller who walks
// away never leaves a banner up forever.
const NETWORK_LOG_IDLE_MS = 300_000;
// A data: or blob: URL can be megabytes long. The log records where a request
// went, not what it carried, so the URL is capped at a length that still shows
// the path and query a caller filters on.
const NETWORK_LOG_URL_MAX = 600;
const consoleBuffers = new Map();
// Tabs whose MAIN-world console mirror is already installed. The mirror lives on
// a page global that a navigation wipes, so this is cleared alongside the
// buffers below.
const pageConsoleMirrors = new Set();
// tabId -> request-log state for browser_read_network_requests. Only tabs a
// caller has read at least once are in here: capture starts on the first read
// and ends on stop, so no tab carries an attachment it was never asked for.
const networkLogs = new Map();
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
// tabId -> recorder state for an in-flight GIF recording. The frames themselves
// are not here: they live in the offscreen document, which is a real page and is
// never evicted, while this worker is torn down after about thirty seconds idle.
// What lives here is only what the worker needs to keep pumping and to tear the
// recording down: { sessionId, startedAt, stoppedAt, recording, fps, maxFrames,
// maxWidth, dpr, label, intervalId, watchdogId, frameIntervalMs, lastCaptureMs,
// frameCount, droppedFrames }.
const gifRecordings = new Map();
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
    // Internal only, stripped by filterConsoleMessages. Two sources can report
    // the same console call with slightly different timestamps, and the label is
    // what lets the dedupe below tell that apart from a page that really logged
    // the same line twice.
    source: message?.source || 'page',
  };
  const buffer = getConsoleBuffer(tabId);
  const duplicate = buffer.messages.some((existing) => (
    existing.level === entry.level
    && existing.text === entry.text
    && (existing.ts === entry.ts
      || (existing.source !== entry.source
        && Math.abs(existing.ts - entry.ts) <= CONSOLE_CROSS_SOURCE_WINDOW_MS))
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
    .slice(-CONSOLE_MESSAGE_CAP)
    // The source label is bookkeeping for the dedupe above, so it never reaches
    // a caller: browser_console_messages returns exactly level, text, and ts.
    .map(({ level: entryLevel, text, ts }) => ({ level: entryLevel, text, ts }));
}

// CDP resource types are a longer list than the tool advertises, and the tool's
// enum is the contract. Anything outside it reads as other rather than leaking a
// protocol spelling into a result.
const NETWORK_RESOURCE_TYPES = new Set([
  'xhr',
  'fetch',
  'document',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
]);
const NETWORK_DEFAULT_TYPES = ['xhr', 'fetch', 'document'];

function normalizeNetworkResourceType(type) {
  const key = String(type || '').toLowerCase();
  return NETWORK_RESOURCE_TYPES.has(key) ? key : 'other';
}

function networkHostname(url) {
  try {
    return new URL(String(url || '')).hostname || null;
  } catch {
    return null;
  }
}

function createNetworkLog(sessionId, hostname) {
  return {
    sessionId,
    hostname: hostname ?? null,
    // Ring of finished and in-flight entries, oldest first. index maps a CDP
    // requestId to the entry so the response and failure events can complete
    // the row the request event opened.
    entries: [],
    index: new Map(),
    // The frame the first navigation request was seen on, so a cross-origin
    // iframe cannot be mistaken for the tab moving to another site.
    mainFrameId: null,
    pinned: false,
    // The debugger entry this log incremented, so stop can only decrement that
    // one. Null whenever the log holds no refcount.
    pinHandle: null,
    startedAt: 0,
    lastEventAt: 0,
    idleTimerId: null,
    droppedEntries: 0,
  };
}

function pushNetworkEntry(tabId, entry) {
  const log = networkLogs.get(tabId);
  if (!log) {
    return;
  }
  log.entries.push(entry);
  log.index.set(entry.requestId, entry);
  while (log.entries.length > NETWORK_LOG_CAP) {
    const dropped = log.entries.shift();
    log.droppedEntries += 1;
    if (log.index.get(dropped.requestId) === dropped) {
      log.index.delete(dropped.requestId);
    }
  }
}

function clearNetworkLog(tabId) {
  const log = networkLogs.get(tabId);
  if (!log) {
    return 0;
  }
  const cleared = log.entries.length;
  log.entries = [];
  log.index = new Map();
  log.droppedEntries = 0;
  return cleared;
}

// A cross-site move drops the log: the requests of the page you left are noise
// once you are somewhere else. A same-host move, including every pushState
// navigation inside a single-page app, keeps it.
//
// The trigger is the new document's own request, not chrome.tabs.onUpdated.
// onUpdated reports a URL once the navigation has committed, which is after
// Network.requestWillBeSent for that document has already landed, so clearing
// from there wiped the one row a caller who navigates and then reads wants most:
// the navigation itself. Clearing here, before the push, keeps it.
function clearNetworkLogForNavigation(tabId, url) {
  const log = networkLogs.get(tabId);
  if (!log) {
    return false;
  }
  const hostname = networkHostname(url);
  if (!hostname) {
    return false;
  }
  if (log.hostname === null) {
    log.hostname = hostname;
    return false;
  }
  if (log.hostname === hostname) {
    return false;
  }
  log.hostname = hostname;
  clearNetworkLog(tabId);
  return true;
}

// Chrome announcing that the tab itself is about to load a new document. Two
// signals separate it from a subresource and from an iframe: CDP sets loaderId
// equal to requestId only on a navigation request, and the frame has to be the
// one the log adopted. The first navigation a log sees defines that frame, which
// holds because capture starts before the navigation it is watching for.
function isMainFrameDocumentRequest(log, event) {
  if (!log || normalizeNetworkResourceType(event?.type) !== 'document') {
    return false;
  }
  const requestId = String(event?.requestId || '');
  if (!requestId || String(event?.loaderId || '') !== requestId) {
    return false;
  }
  const frameId = String(event?.frameId || '');
  if (!frameId) {
    return true;
  }
  if (log.mainFrameId === null) {
    log.mainFrameId = frameId;
    return true;
  }
  return log.mainFrameId === frameId;
}

function filterNetworkEntries(tabId, { urlPattern = '', types = null, limit = 50 } = {}) {
  const log = networkLogs.get(tabId);
  if (!log) {
    return [];
  }
  const needle = String(urlPattern || '').toLowerCase();
  const wanted = new Set(
    (Array.isArray(types) && types.length > 0 ? types : NETWORK_DEFAULT_TYPES)
      .map((type) => normalizeNetworkResourceType(type)),
  );
  const matched = log.entries.filter((entry) => (
    wanted.has(entry.resourceType)
    && (needle === '' || entry.url.toLowerCase().includes(needle))
  ));
  // Newest first, which is the order a caller reading after an action wants.
  return matched.slice(-limit).reverse().map((entry) => ({ ...entry }));
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
    const config = await loadBridgeConfig();
    const message = config.sharedKey
      ? 'Loopback scanning is off. Turn Enable loopback scanning on, then Save And Reconnect.'
      : 'Set a shared key in the Umbra options page to start the local bridge scanner.';
    await chrome.storage.local.set({
      bridgeDebug: {
        updatedAt: Date.now(),
        state: 'bridge_not_configured',
        message,
        hasSharedKey: Boolean(config.sharedKey),
        scanningEnabled: config.bridgeEnabled === true,
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

// Waits in the worker rather than in the page. A page-side wait dies with the
// document the navigation replaces, which is the exact event being observed.
// chrome.tabs.onUpdated reports changeInfo.url for pushState moves too, so a
// single-page app is covered and the interval poll is the backstop.
async function waitForTabUrl(tabId, options = {}) {
  const timeoutMs = clampTimeoutMs(options.timeoutMs, 10_000, 120_000);
  const needle = String(options.urlContains || '');
  const requireChange = options.urlChanged === true;
  const startedAt = Date.now();
  const existing = await safeGetTab(tabId);
  const fromUrl = String(options.fromUrl || existing?.url || '');

  const matches = (tab) => {
    if (!tab) {
      return false;
    }
    const url = String(tab.url || '');
    if (needle && !url.includes(needle)) {
      return false;
    }
    if (requireChange && url === fromUrl) {
      return false;
    }
    return tab.status === 'complete';
  };

  const payload = (tab, strategy) => {
    const url = String(tab?.url || '');
    return {
      url,
      fromUrl,
      urlChanged: url !== fromUrl,
      ...(needle ? { matchedUrlContains: url.includes(needle) } : {}),
      elapsedMs: Date.now() - startedAt,
      timedOut: false,
      strategy,
    };
  };

  if (matches(existing)) {
    return payload(existing, 'immediate');
  }

  return await new Promise((resolve, reject) => {
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
      safeGetTab(tabId)
        .then((tab) => {
          finish(() => {
            // The message carries where the tab actually is, which is how a
            // caller learns that the submit it was waiting on never navigated.
            const error = new Error(`Timed out waiting for the tab URL. Still on ${String(tab?.url || fromUrl) || 'an unknown page'}.`);
            error.code = 'wait_timeout';
            reject(error);
          });
        })
        .catch(() => {
          finish(() => {
            const error = new Error(`Timed out waiting for the tab URL. Still on ${fromUrl || 'an unknown page'}.`);
            error.code = 'wait_timeout';
            reject(error);
          });
        });
    }, timeoutMs);

    const settle = (tab, strategy) => {
      if (matches(tab)) {
        finish(() => resolve(payload(tab, strategy)));
      }
    };

    const poll = setInterval(() => {
      safeGetTab(tabId)
        .then((tab) => settle(tab, 'poll'))
        .catch(() => {});
    }, TAB_COMPLETE_POLL_INTERVAL_MS);

    function listener(updatedTabId) {
      if (updatedTabId !== tabId) {
        return;
      }
      safeGetTab(tabId)
        .then((tab) => settle(tab, 'listener'))
        .catch(() => {});
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

const HISTORY_NO_ENTRY_RE = /cannot find a next page in history/i;

// chrome.tabs.update resolves before the tab leaves the old document, and a
// same-document move never re-enters `loading`, so "did we move" is a URL
// question, not a status question.
async function waitForTabUrlChange(tabId, fromUrl, timeoutMs = 8_000) {
  const deadline = Date.now() + Math.max(Number(timeoutMs) || 0, 500);
  while (Date.now() < deadline) {
    const tab = await safeGetTab(tabId);
    if (!tab) {
      return { changed: false, url: fromUrl };
    }
    const url = tab.url || '';
    if (url && url !== fromUrl) {
      return { changed: true, url };
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const settled = await safeGetTab(tabId);
  const url = settled?.url || fromUrl;
  return { changed: Boolean(url) && url !== fromUrl, url };
}

// chrome.tabs.goBack answers the browser-side CanGoBack(), which skips every
// entry Chrome flagged should_skip_on_back_forward_ui. Agent clicks are
// untrusted synthetic events, so the entries behind the current one carry that
// flag and the tabs API reports an empty back stack on a tab holding four
// entries. CanGoForward() has no such filter, which is why forward works. The
// renderer ignores the flag, so window.history is the fallback. Never guess:
// carry the API's own message out with the result.
async function moveTabHistory(tabId, direction, timeoutMs) {
  const settleMs = Math.min(Number(timeoutMs) || 45_000, 10_000);
  const before = await safeGetTab(tabId);
  const fromUrl = before?.url || '';
  const delta = direction === 'back' ? -1 : 1;

  let apiError = '';
  try {
    if (direction === 'back') {
      await chrome.tabs.goBack(tabId);
    } else {
      await chrome.tabs.goForward(tabId);
    }
    const settle = await waitForTabUrlChange(tabId, fromUrl, settleMs);
    if (settle.changed) {
      await waitForTabComplete(tabId, timeoutMs);
    }
    const after = await safeGetTab(tabId);
    return {
      moved: true,
      via: 'tabs',
      url: after?.url || settle.url || fromUrl,
      urlChanged: settle.changed,
    };
  } catch (error) {
    apiError = error?.message || String(error);
  }

  const noEntry = HISTORY_NO_ENTRY_RE.test(apiError);
  let page = null;
  try {
    page = await executeInTabWithRetry(tabId, historyGo, [delta]);
  } catch (scriptError) {
    return {
      moved: false,
      reason: noEntry ? 'no-history' : 'navigation-failed',
      message: apiError,
      fallback: 'unavailable',
      fallbackError: scriptError?.message || String(scriptError),
    };
  }

  if (!page?.attempted) {
    return {
      moved: false,
      reason: 'no-history',
      message: apiError,
      entryCount: page?.length ?? null,
    };
  }

  const settle = await waitForTabUrlChange(tabId, fromUrl, settleMs);
  if (!settle.changed) {
    return {
      moved: false,
      reason: noEntry ? 'no-history' : 'navigation-failed',
      message: apiError,
      entryCount: page.length,
    };
  }
  await waitForTabComplete(tabId, timeoutMs);
  const after = await safeGetTab(tabId);
  return {
    moved: true,
    via: 'page',
    url: after?.url || settle.url,
    urlChanged: true,
    entryCount: page.length,
  };
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

async function cleanupGroups(sessionId, params = {}) {
  const exactTitle = typeof params.title === 'string' ? params.title.trim() : '';
  const titlePrefix = typeof params.titlePrefix === 'string' ? params.titlePrefix.trim() : '';
  const mode = params.mode === 'ungroupOnly' ? 'ungroupOnly' : 'closeTabs';
  const dryRun = params.dryRun === true;
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
  for (const group of matches) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const tabIds = tabs.map((tab) => tab.id).filter((tabId) => Number.isInteger(tabId));
    const foreignOwners = [...new Set(
      tabIds
        .map((tabId) => sessionStore.findOwner(tabId))
        .filter((owner) => owner && owner !== sessionId),
    )];

    if (foreignOwners.length > 0) {
      skipped.push({
        groupId: group.id,
        title: group.title || '',
        color: group.color || '',
        tabCount: tabIds.length,
        reason: 'owned_by_other_session',
        ownedByOther: true,
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

// Returns an unfocused normal window for new session tabs, or null when none
// exists. A focused window is never returned here, including the stored
// dedicated one. createSessionTab may still attach an inactive tab to a focused
// window rather than call chrome.windows.create, which steals OS focus on macOS.
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
    // Every candidate is focused. The caller may attach an inactive tab to an
    // existing window, but it must not call chrome.windows.create unless
    // allowForeground is true: creating a window steals OS focus on macOS.
    return null;
  }
  await rememberDedicatedWindowId(unfocused.id);
  return unfocused.id;
}

async function findAttachableWindowId() {
  const backgroundId = await findBackgroundWindowId();
  if (backgroundId !== null) {
    return backgroundId;
  }
  const windows = await listNormalWindows();
  return Number.isInteger(windows[0]?.id) ? windows[0].id : null;
}


// Bring a tab to the front of its own window without stealing OS focus.
// On macOS, chrome.tabs.update({active:true}) often focuses the window; we
// immediately push focused:false unless the caller opted into allowForeground.
async function activateOwnedTab(tabOrId, { allowForeground = false } = {}) {
  const tab = typeof tabOrId === 'number' ? await chrome.tabs.get(tabOrId) : tabOrId;
  if (!tab?.id) {
    throw new Error('activateOwnedTab requires a live tab.');
  }
  if (tab.active !== true) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  if (!allowForeground && tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: false }).catch(() => {});
  } else if (allowForeground && tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return await safeGetTab(tab.id);
}

const MACOS_NEW_WINDOW_FOCUS_STEAL =
  'newWindow would steal OS focus on macOS. Attach an inactive tab to an existing window, or pass allowForeground only when foreground was explicitly allowed.';
const MACOS_WINDOW_CREATE_FOCUS_STEAL =
  'Creating a Chrome window would steal OS focus on macOS. Attach an inactive tab to an existing window, or pass allowForeground only when foreground was explicitly allowed.';

function assertChromeWindowCreateAllowed({ newWindow = false, allowForeground = false } = {}) {
  if (allowForeground === true) {
    return;
  }
  throw new Error(newWindow === true ? MACOS_NEW_WINDOW_FOCUS_STEAL : MACOS_WINDOW_CREATE_FOCUS_STEAL);
}

async function createDedicatedWindowWithTab({ url = 'about:blank', activate = false, allowForeground = false } = {}) {
  // chrome.windows.create activates Chrome on macOS even with focused: false.
  // allowForeground is the only path that may steal OS focus.
  assertChromeWindowCreateAllowed({ newWindow: false, allowForeground });
  const createdWindow = await chrome.windows.create({
    url,
    focused: false,
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
  if (activate && createdTab?.id) {
    await activateOwnedTab(createdTab, { allowForeground });
  } else if (allowForeground && createdWindow?.id != null) {
    await chrome.windows.update(createdWindow.id, { focused: true }).catch(() => {});
  }

  return createdTab;
}

async function createSessionTab(_sessionId, { url = 'about:blank', activate = false, newWindow = false, allowForeground = false } = {}) {
  if (newWindow === true) {
    assertChromeWindowCreateAllowed({ newWindow: true, allowForeground });
    return await createDedicatedWindowWithTab({ url, activate, allowForeground });
  }
  const windowId = await findAttachableWindowId();
  if (windowId !== null) {
    const before = await getNormalWindow(windowId);
    const wasFocused = before?.focused === true;
    const tab = await chrome.tabs.create({ url, active: Boolean(activate), windowId });
    if (!(await getNormalWindow(tab.windowId))) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      const remaining = (await listNormalWindows()).find((window) => window.id !== tab.windowId);
      if (remaining?.id != null) {
        return await chrome.tabs.create({ url, active: Boolean(activate), windowId: remaining.id });
      }
      assertChromeWindowCreateAllowed({ newWindow: false, allowForeground });
      return await createDedicatedWindowWithTab({ url, activate, allowForeground });
    }
    if (activate && !allowForeground && !wasFocused) {
      // activate on create means "selected in its window"; never steal OS focus
      // at the session-create edge. Do not unfocus a window that was already
      // focused: that backgrounds Chrome while it is already in use.
      await chrome.windows.update(windowId, { focused: false }).catch(() => {});
    }
    return tab;
  }

  assertChromeWindowCreateAllowed({ newWindow: false, allowForeground });
  return await createDedicatedWindowWithTab({ url, activate, allowForeground });
}

async function getOrCreateSessionTab(sessionId, options = {}) {
  const {
    tabId = null,
    createIfMissing = false,
    newTab = false,
    activate = false,
    allowForeground = false,
    url = 'about:blank',
    updateActive = true,
    persist = true,
    newWindow = false,
  } = options;

  if (tabId !== null) {
    const tab = await getOwnedTab(sessionId, tabId);
    if (activate) {
      await activateOwnedTab(tab, { allowForeground });
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

  const createdTab = await createSessionTab(sessionId, { url, activate, newWindow, allowForeground });
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

async function findChromeGroups(sessionId, params = {}) {
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
    const ownedByCaller = owners.includes(sessionId);
    const ownedByOther = owners.some((owner) => owner !== sessionId);
    matches.push({
      id: group.id,
      groupId: group.id,
      title: groupTitle,
      color: group.color || '',
      collapsed: group.collapsed === true,
      windowId: group.windowId ?? null,
      tabCount: tabs.length,
      owned: owners.length > 0,
      ownedByCaller,
      ownedByOther,
      tabs: tabs.slice(0, 10).map((tab) => {
        const owner = sessionStore.findOwner(tab.id);
        return {
          tabId: tab.id,
          title: tab.title || '(untitled)',
          url: tab.url || '',
          ownedByCaller: owner === sessionId,
          ownedByOther: Boolean(owner && owner !== sessionId),
        };
      }),
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
  const requestedGroupId = params.groupId === undefined || params.groupId === null || params.groupId === ''
    ? null
    : Number(params.groupId);
  let groupId = requestedGroupId;
  if (requestedGroupId !== null) {
    if (!Number.isInteger(requestedGroupId)) {
      throw new Error('groupId must be an integer.');
    }
    if (requestedGroupId !== session.groupId) {
      const tabs = await chrome.tabs.query({ groupId: requestedGroupId }).catch(() => []);
      const tabIds = tabs.map((tab) => tab.id).filter((tabId) => Number.isInteger(tabId));
      const ownedOnlyByCaller = tabIds.length > 0
        && tabIds.every((tabId) => sessionStore.findOwner(tabId) === sessionId);
      if (!ownedOnlyByCaller) {
        throw new Error('groupId is not owned by this session.');
      }
    }
    groupId = requestedGroupId;
  } else {
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

// Per-session cursor overrides, set by browser_cursor and dropped when the
// session disconnects. An entry here wins over the install setting.
const cursorSessionOverrides = new Map();
// Last point the cursor was driven to, per tab, so a glide can scale its length
// to the distance travelled without asking the page where the pointer is.
const cursorLastPoint = new Map();
let cursorInstallDefault = null;
let cursorInstallDefaultAt = 0;

async function cursorInstallDefaultEnabled() {
  const now = Date.now();
  if (cursorInstallDefault !== null && now - cursorInstallDefaultAt < CURSOR_CONFIG_TTL_MS) {
    return cursorInstallDefault;
  }
  try {
    const config = await loadBridgeConfig();
    cursorInstallDefault = config.cursorOverlay !== false;
  } catch {
    // An unreadable config keeps the documented default rather than turning the
    // cursor off on a storage hiccup.
    cursorInstallDefault = true;
  }
  cursorInstallDefaultAt = now;
  return cursorInstallDefault;
}

async function cursorEnabledForSession(sessionId) {
  if (sessionId && cursorSessionOverrides.has(sessionId)) {
    return cursorSessionOverrides.get(sessionId) === true;
  }
  return await cursorInstallDefaultEnabled();
}

function cursorGlideDurationMs(fromX, fromY, toX, toY) {
  const dx = Number(toX) - Number(fromX);
  const dy = Number(toY) - Number(fromY);
  const distance = Number.isFinite(dx) && Number.isFinite(dy) ? Math.hypot(dx, dy) : CURSOR_FULL_TRAVEL_PX;
  const ratio = Math.min(1, Math.max(0, distance / CURSOR_FULL_TRAVEL_PX));
  return Math.round(CURSOR_MIN_GLIDE_MS + ((CURSOR_MAX_GLIDE_MS - CURSOR_MIN_GLIDE_MS) * ratio));
}

function cursorRippleVariant(kind) {
  if (kind === 'rightClick' || kind === 'double' || kind === 'triple') {
    return kind;
  }
  return 'click';
}

// tabId -> the last cursor injection started on that tab. The glide and the
// post-action indicator are both started rather than awaited, so without this
// browser_screenshot could run its hide before the ripple injection landed and
// capture the ring the hide exists to remove.
const cursorPendingAnimations = new Map();

function trackCursorAnimation(tabId, promise) {
  if (!promise || typeof promise.then !== 'function') {
    return;
  }
  const settled = promise.then(() => {}, () => {});
  cursorPendingAnimations.set(tabId, settled);
  void settled.then(() => {
    if (cursorPendingAnimations.get(tabId) === settled) {
      cursorPendingAnimations.delete(tabId);
    }
  });
}

// Bounded on purpose. The point is to let an injection already on the wire land
// before the hide, never to hold a capture behind a page that stopped answering.
async function settleCursorAnimations(tabId, timeoutMs = CURSOR_SETTLE_BEFORE_CAPTURE_MS) {
  const pending = cursorPendingAnimations.get(tabId);
  if (!pending) {
    return;
  }
  await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// The overlay brackets whatever dispatch already runs; it never replaces it.
// Every step except run() is swallowed on failure, so a throw inside the
// animation can only ever cost the animation. A throw from run() propagates
// untouched, because that one is the tool's real result.
async function withCursorFeedback(tabId, spec = {}, run) {
  if (typeof run !== 'function') {
    throw new Error('withCursorFeedback requires a run function.');
  }

  const kind = String(spec.kind || 'click');

  let enabled = false;
  try {
    enabled = await cursorEnabledForSession(spec.sessionId || '');
  } catch {
    enabled = false;
  }

  let ready = false;
  if (enabled) {
    try {
      ready = await ensureCursorOverlay(tabId);
    } catch {
      ready = false;
    }
  }
  if (!ready) {
    // The recorder's action frames used to live entirely inside the cursor path,
    // so a recording taken with the cursor off got interval ticks and nothing
    // else: no click markers, no labels, no drag ends. The animation is optional;
    // the evidence is not. Coordinates are used when the caller supplied them
    // and left off otherwise.
    const rawX = Number(spec.x);
    const rawY = Number(spec.y);
    const known = Number.isFinite(rawX) && Number.isFinite(rawY);
    const frameMeta = {
      label: gifActionLabel(kind),
      ...(known ? { x: rawX, y: rawY } : {}),
    };
    pumpGifActionFrame(tabId, { ...frameMeta, kind: `${kind}_before` });
    try {
      return await run();
    } finally {
      pumpGifActionFrame(tabId, { ...frameMeta, kind: kind === 'drag' ? 'drag' : cursorRippleVariant(kind) });
    }
  }

  let point = null;
  try {
    const hasCoords = Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y));
    point = hasCoords
      ? { x: Number(spec.x), y: Number(spec.y) }
      : await executeInTab(tabId, umbraCursorMeasure, [{
        selector: spec.selector || '',
        ref: spec.ref || '',
        // Only a plain window scroll asks for this. Everything else wants null
        // when it named no element, so browser_click_text can place the cursor
        // from its own result instead of on the middle of the viewport.
        fallback: spec.fallback === 'viewport' ? 'viewport' : '',
      }]);
  } catch {
    point = null;
  }
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    // Nothing to aim at up front. browser_click_text is the case that matters:
    // the element is only known once the text has been matched, so the cursor
    // catches up afterwards rather than not showing at all.
    const result = await run();
    try {
      const after = typeof spec.pointFromResult === 'function' ? spec.pointFromResult(result) : null;
      const afterX = Number(after?.x);
      const afterY = Number(after?.y);
      if (Number.isFinite(afterX) && Number.isFinite(afterY)) {
        cursorLastPoint.set(tabId, { x: afterX, y: afterY });
        trackCursorAnimation(tabId, executeInTab(tabId, umbraCursorDrive, [{
          op: 'glide',
          x: afterX,
          y: afterY,
          durationMs: CURSOR_MIN_GLIDE_MS,
        }])
          .then(() => executeInTab(tabId, umbraCursorDrive, [{
            op: 'ripple',
            variant: cursorRippleVariant(kind),
            x: afterX,
            y: afterY,
          }])));
        pumpGifActionFrame(tabId, {
          kind: cursorRippleVariant(kind),
          label: gifActionLabel(kind),
          x: afterX,
          y: afterY,
        });
      }
    } catch {
      // A result that carries no usable point simply gets no animation.
    }
    return result;
  }

  const x = Number(point.x);
  const y = Number(point.y);
  const points = Array.isArray(spec.points) && spec.points.length > 1
    ? spec.points
    : (Number.isFinite(Number(spec.endX)) && Number.isFinite(Number(spec.endY))
      ? [{ x, y }, { x: Number(spec.endX), y: Number(spec.endY) }]
      : null);

  try {
    // Travel is measured against the last point this worker drove the cursor to
    // rather than a round trip into the page, which would put a second script
    // injection on the latency budget of every click. An evicted worker forgets
    // the point and pays one full-length entrance glide.
    const prior = cursorLastPoint.get(tabId) || null;
    const durationMs = cursorGlideDurationMs(prior?.x, prior?.y, x, y);
    cursorLastPoint.set(tabId, points ? points[points.length - 1] : { x, y });
    // Started, not awaited. The overlay places the pointer at the target
    // synchronously and animates the travel afterwards, so the animation
    // overlaps the dispatch instead of preceding it. Awaiting it put 260 to
    // 520 ms on the critical path of every click, fill, type and scroll, which
    // came straight out of the shared browser_batch deadline: a 25-step batch
    // spent up to 13 seconds animating against a 30 second budget and started
    // reporting batch_timeout on work that used to finish.
    const glide = kind === 'drag' && points
      ? executeInTab(tabId, umbraCursorDrive, [{ op: 'dragPath', points, durationMs }])
      : executeInTab(tabId, umbraCursorDrive, [{ op: 'glide', x, y, durationMs }]);
    trackCursorAnimation(tabId, glide);
  } catch {
    // A page that refused the glide still gets the real action.
  }

  // Pre-action frame for a recording on this tab, taken while the cursor is in
  // motion so the frame shows where the action is about to land. Fire and
  // forget: the real dispatch below does not wait on a frame.
  pumpGifActionFrame(tabId, {
    kind: `${kind}_before`,
    label: gifActionLabel(kind),
    x,
    y,
    endX: points ? points[points.length - 1].x : undefined,
    endY: points ? points[points.length - 1].y : undefined,
  });

  const result = await run();

  try {
    if (kind === 'type') {
      trackCursorAnimation(tabId, executeInTab(tabId, umbraCursorDrive, [{ op: 'typing', x, y }]));
    } else if (kind === 'scroll') {
      trackCursorAnimation(tabId, executeInTab(tabId, umbraCursorDrive, [{
        op: 'scrollHint',
        x,
        y,
        direction: spec.direction || 'down',
      }]));
      // A hover gets the glide and nothing else. A ripple there would read as a
      // click that never happened.
    } else if (kind !== 'hover') {
      trackCursorAnimation(tabId, executeInTab(tabId, umbraCursorDrive, [{
        op: 'ripple',
        variant: cursorRippleVariant(kind),
        x: points ? points[points.length - 1].x : x,
        y: points ? points[points.length - 1].y : y,
      }]));
    }
  } catch {
    // The indicator is fire and forget; the tool result is already decided.
  }

  // Post-action frame, taken right after the indicator fires so the frame shows
  // the ripple and whatever the page did in response. A drag keeps its start
  // point here, because the arrow the recorder draws needs both ends.
  pumpGifActionFrame(tabId, {
    kind: kind === 'drag' ? 'drag' : cursorRippleVariant(kind),
    label: gifActionLabel(kind),
    x: kind === 'drag' || !points ? x : points[points.length - 1].x,
    y: kind === 'drag' || !points ? y : points[points.length - 1].y,
    endX: points ? points[points.length - 1].x : undefined,
    endY: points ? points[points.length - 1].y : undefined,
  });

  return result;
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

const TABS_CONTEXT_DEFAULT_LIMIT = 200;
const TABS_CONTEXT_MAX_LIMIT = 500;
// 0 means no shortening. Every existing caller reads `url` as a URL it can
// navigate back to, so the default has to hand back exactly what Chrome
// reported; a caller who wants the compact rows passes a positive number.
const TABS_CONTEXT_DEFAULT_URL_MAX_LENGTH = 0;

// chrome.tabs reports -1 for an ungrouped tab. serializeTab keeps returning that
// raw -1 because existing callers already read it; this is a new field with no
// callers, so it reports null and stays readable.
function normalizeTabGroupId(tab) {
  const none = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
  const value = tab?.groupId;
  return Number.isInteger(value) && value !== none ? value : null;
}

// A tab created moments ago reports an empty url until its navigation commits;
// pendingUrl carries the destination during that window. Reading only url is
// what hid the tab this tool had just created.
function tabsContextUrlOf(tab) {
  return String(tab?.url || tab?.pendingUrl || '');
}

function clampTabsContextLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return TABS_CONTEXT_DEFAULT_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), TABS_CONTEXT_MAX_LIMIT);
}

// 0, the default, returns the URL exactly as Chrome reports it, so it cannot go
// through the usual `Number(x) || default` idiom. Shortening is opt-in on
// purpose: a collapsed query is a syntactically valid but wrong URL under the
// same field name, so a caller round-tripping tabs_context url into
// browser_navigate went somewhere else without an error to explain it.
function clampTabsContextUrlMaxLength(value) {
  if (value === undefined || value === null) {
    return TABS_CONTEXT_DEFAULT_URL_MAX_LENGTH;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return TABS_CONTEXT_DEFAULT_URL_MAX_LENGTH;
  }
  if (parsed === 0) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(parsed), 40), 4096);
}

function shortenTabsContextUrl(url, maxLength) {
  const value = String(url || '');
  if (maxLength === 0 || value.length === 0) {
    return { url: value, truncated: false };
  }
  let short = value;
  let truncated = false;
  const cut = short.search(/[?#]/);
  if (cut !== -1) {
    short = `${short.slice(0, cut)}${short[cut] === '#' ? '#...' : '?...'}`;
    truncated = true;
  }
  if (short.length > maxLength) {
    short = `${short.slice(0, maxLength)}...`;
    truncated = true;
  }
  return { url: short, truncated };
}

function buildTabsContextRow(tab, { owned, urlMaxLength }) {
  const shortened = shortenTabsContextUrl(tabsContextUrlOf(tab), urlMaxLength);
  return {
    tabId: tab.id,
    title: tab.title || '(untitled)',
    url: shortened.url,
    active: tab.active === true,
    windowId: tab.windowId ?? null,
    owned,
    groupId: normalizeTabGroupId(tab),
    ...(shortened.truncated ? { urlTruncated: true } : {}),
  };
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

// One reading of button, clickCount and modifiers for every click path, so the
// coordinate, selector and ref branches cannot drift. Omitting all three gives
// back exactly what a call made before they existed did: one left click with no
// modifiers held.
function normalizeClickOptions(params, doubleClick) {
  const button = params.button === 'right' || params.button === 'middle' ? params.button : 'left';
  const rawCount = Number(params.clickCount);
  const clickCount = Number.isFinite(rawCount) && rawCount >= 1
    ? Math.min(3, Math.floor(rawCount))
    : (doubleClick === true ? 2 : 1);
  const source = params.modifiers && typeof params.modifiers === 'object' ? params.modifiers : {};
  return {
    button,
    clickCount,
    modifiers: {
      ctrl: source.ctrl === true,
      shift: source.shift === true,
      alt: source.alt === true,
      meta: source.meta === true,
    },
  };
}

function clickFeedbackKind(clickOptions) {
  if (clickOptions.button === 'right') {
    return 'rightClick';
  }
  if (clickOptions.clickCount >= 3) {
    return 'triple';
  }
  return clickOptions.clickCount === 2 ? 'double' : 'click';
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

// withOwnedTabDebugger brackets one operation. A recording needs the attachment
// held across hundreds of captures, so these two claim and release the same
// refcounted entry without wrapping a function. Sharing the refcount is the
// point: a browser_screenshot taken while a recording runs joins the existing
// attachment instead of raising debugger_busy, and neither side can detach out
// from under the other.
//
// Returns { target, handle }. The handle is the entry this call incremented, and
// unpinTabDebugger refuses to decrement anything else. Without it a long-lived
// holder could decrement an entry it never pinned: a user dismissing Chrome's
// automation banner makes onDetach drop entry A while a log still believes it is
// pinned, a recording then pins entry B, and the log's stop decremented B to
// zero and detached the recording's attachment out from under it.
async function pinTabDebugger(tabId) {
  if (!chrome.debugger || typeof chrome.debugger.attach !== 'function') {
    const error = new Error('Debugger API is missing.');
    error.code = 'debugger_unavailable';
    throw error;
  }

  const target = { tabId };
  let entry = tabDebuggerAttachments.get(tabId);
  if (!entry) {
    entry = { refCount: 0, detached: false, attachPromise: claimTabDebugger(target) };
    entry.attachPromise.catch(() => {});
    tabDebuggerAttachments.set(tabId, entry);
  }
  entry.refCount += 1;

  try {
    await entry.attachPromise;
  } catch (error) {
    unpinTabDebugger(tabId, entry);
    throw error;
  }

  return { target, handle: entry };
}

function unpinTabDebugger(tabId, handle = null) {
  const entry = tabDebuggerAttachments.get(tabId);
  if (!entry) {
    return false;
  }
  // Identity, the same guard withOwnedTabDebugger's release() already applies.
  // A handle from a superseded entry decrements nothing.
  if (handle && entry !== handle) {
    return false;
  }
  entry.refCount -= 1;
  // Same last-one-out rule as withOwnedTabDebugger's finally: a concurrent call
  // still holding the entry keeps the attachment, and an entry that was already
  // replaced is not ours to detach.
  if (entry.refCount > 0 || tabDebuggerAttachments.get(tabId) !== entry) {
    return false;
  }
  tabDebuggerAttachments.delete(tabId);
  void chrome.debugger.detach({ tabId }).catch(() => {});
  return true;
}

chrome.debugger?.onDetach?.addListener((source) => {
  // A user dismissing the "being debugged" banner, a crashed tab, or Chrome
  // itself can end the attachment without running the release above. Drop the
  // cached entry so the next call attaches again instead of sending commands
  // into a target nothing is attached to. The entry is marked first so anything
  // still holding it as a handle can tell it is dead rather than current.
  if (Number.isInteger(source?.tabId)) {
    const entry = tabDebuggerAttachments.get(source.tabId);
    if (entry) {
      entry.detached = true;
    }
    tabDebuggerAttachments.delete(source.tabId);
  }
});

// browser_javascript runs in the page's MAIN world through the debugger, a world
// neither the content agent's isolated console wrap nor the lazily injected page
// mirror can see. Runtime.consoleAPICalled is the only signal for it, and it
// arrives only while this extension holds the attachment, which is exactly the
// window Runtime.evaluate runs in.
const CDP_CONSOLE_LEVELS = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  warn: 'warning',
  debug: 'debug',
  log: 'info',
  info: 'info',
};

function formatCdpConsoleArg(arg) {
  if (!arg || typeof arg !== 'object') {
    return String(arg ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
    if (typeof arg.value === 'string') {
      return arg.value;
    }
    try {
      return JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  return arg.description || arg.unserializableValue || arg.className || arg.type || '';
}

chrome.debugger?.onEvent?.addListener((source, method, event) => {
  if (method !== 'Runtime.consoleAPICalled' || !Number.isInteger(source?.tabId)) {
    return;
  }
  // Only events from an attachment this extension owns. tabDebuggerAttachments
  // is the single record of that, and onDetach above clears it.
  if (!tabDebuggerAttachments.has(source.tabId)) {
    return;
  }
  pushConsoleMessage(source.tabId, {
    level: CDP_CONSOLE_LEVELS[String(event?.type || 'log').toLowerCase()] || 'info',
    text: (event?.args || []).map(formatCdpConsoleArg).join(' '),
    ts: Number.isFinite(event?.timestamp) ? Math.round(event.timestamp) : Date.now(),
    source: 'debugger',
  });
});

// Request logging. Three CDP events carry everything the tool returns: one opens
// a row, the other two close it. Bodies and headers are never read, so nothing a
// page sent or received is held anywhere in the worker.
const NETWORK_LOG_METHODS = new Set([
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
]);

chrome.debugger?.onEvent?.addListener((source, method, event) => {
  if (!Number.isInteger(source?.tabId) || !NETWORK_LOG_METHODS.has(method)) {
    return;
  }
  const log = networkLogs.get(source.tabId);
  // Only a tab a caller explicitly started logging on, and only while the
  // attachment is ours. tabDebuggerAttachments is the record of that, and
  // onDetach above clears it.
  if (!log || log.pinned !== true || !tabDebuggerAttachments.has(source.tabId)) {
    return;
  }
  const requestId = String(event?.requestId || '');
  if (!requestId) {
    return;
  }
  log.lastEventAt = Date.now();

  if (method === 'Network.requestWillBeSent') {
    const requestUrl = String(event?.request?.url || '');
    if (isMainFrameDocumentRequest(log, event)) {
      if (event?.redirectResponse) {
        // A redirect hop belongs to the navigation already in flight. Adopt the
        // host so the next navigation is measured against it, but keep the
        // chain: the hops are the part a caller debugging a redirect reads for.
        log.hostname = networkHostname(requestUrl) ?? log.hostname;
      } else {
        clearNetworkLogForNavigation(source.tabId, requestUrl);
      }
    }
    pushNetworkEntry(source.tabId, {
      requestId,
      url: requestUrl.slice(0, NETWORK_LOG_URL_MAX),
      method: String(event?.request?.method || 'GET').toUpperCase().slice(0, 12),
      resourceType: normalizeNetworkResourceType(event?.type),
      status: null,
      mimeType: null,
      startedAt: Date.now(),
      durationMs: null,
      failed: false,
      errorText: null,
    });
    return;
  }

  const entry = log.index.get(requestId);
  if (!entry) {
    // The opening event landed before logging started, or the ring has already
    // rolled past it. A row with no request line is worse than no row.
    return;
  }
  entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
  if (method === 'Network.responseReceived') {
    entry.status = Number.isFinite(Number(event?.response?.status)) ? Number(event.response.status) : null;
    entry.mimeType = String(event?.response?.mimeType || '').slice(0, 120) || null;
    // responseReceived carries the settled resource type, which is more accurate
    // than the one guessed when the request went out.
    entry.resourceType = normalizeNetworkResourceType(event?.type || entry.resourceType);
    return;
  }
  entry.failed = true;
  entry.errorText = String(event?.errorText || 'net::ERR_FAILED').slice(0, 120);
});

function clearNetworkLogWatchdog(log) {
  if (log?.idleTimerId !== null && log?.idleTimerId !== undefined) {
    clearTimeout(log.idleTimerId);
    log.idleTimerId = null;
  }
}

function armNetworkLogWatchdog(tabId) {
  const log = networkLogs.get(tabId);
  if (!log) {
    return;
  }
  clearNetworkLogWatchdog(log);
  // Reset on every read rather than on every event: a page that polls in the
  // background would otherwise keep the banner up on a tab nobody is watching.
  log.idleTimerId = setTimeout(() => {
    void stopNetworkLog(tabId, 'idle');
  }, NETWORK_LOG_IDLE_MS);
}

async function startNetworkLog(tabId, sessionId) {
  const existing = networkLogs.get(tabId);
  // The pin has to still be the entry this log took, not merely some entry on
  // the tab: a recording that pinned after onDetach dropped ours is a different
  // attachment, and reusing it would leave this log holding no refcount at all.
  if (existing && existing.pinned === true && existing.pinHandle
    && tabDebuggerAttachments.get(tabId) === existing.pinHandle) {
    existing.sessionId = sessionId;
    armNetworkLogWatchdog(tabId);
    return { log: existing, started: false };
  }

  // A pin that is gone from tabDebuggerAttachments was dropped by onDetach, so
  // there is no refcount left to release and re-pinning is the repair.
  const { target, handle } = await pinTabDebugger(tabId);
  try {
    await chrome.debugger.sendCommand(target, 'Network.enable', {
      // Umbra never reads a body, so Chrome should not hold one for it.
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
    });
  } catch (error) {
    unpinTabDebugger(tabId, handle);
    throw error;
  }

  const tab = await safeGetTab(tabId);
  const log = existing || createNetworkLog(sessionId, networkHostname(tab?.url));
  log.sessionId = sessionId;
  log.hostname = networkHostname(tab?.url) ?? log.hostname;
  log.pinned = true;
  // The entry this log incremented, so its stop can only ever decrement that one.
  log.pinHandle = handle;
  log.startedAt = Date.now();
  log.lastEventAt = Date.now();
  networkLogs.set(tabId, log);
  armNetworkLogWatchdog(tabId);
  return { log, started: true };
}

// Ends capture and releases the attachment, which is what takes Chrome's
// automation banner off the tab. The buffer goes with it: stop is the caller
// saying they are done, and a stopped log that kept its entries would be a
// second state to explain.
async function stopNetworkLog(tabId, reason = 'stop') {
  const log = networkLogs.get(tabId);
  if (!log) {
    return false;
  }
  clearNetworkLogWatchdog(log);
  networkLogs.delete(tabId);
  if (log.pinned !== true) {
    return true;
  }
  log.pinned = false;
  log.stopReason = reason;
  const handle = log.pinHandle || null;
  log.pinHandle = null;
  if (handle && tabDebuggerAttachments.get(tabId) === handle) {
    await chrome.debugger.sendCommand({ tabId }, 'Network.disable').catch(() => {});
  }
  unpinTabDebugger(tabId, handle);
  return true;
}

async function stopSessionNetworkLogs(sessionId) {
  for (const [tabId, log] of [...networkLogs.entries()]) {
    if (log.sessionId === sessionId) {
      await stopNetworkLog(tabId, 'session_disconnected');
    }
  }
}

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

// Chrome treats content-script element.click() and dispatched MouseEvents as
// untrusted. A page that gates a download on a user gesture ignores those and
// leaves the control looking clicked while no file lands. Debugger
// Input.dispatchMouseEvent is a trusted gesture and does not activate the tab.
async function dispatchTrustedMouseClick(tabId, x, y, options = {}) {
  const fallbackX = Number(x);
  const fallbackY = Number(y);
  if (!Number.isFinite(fallbackX) || !Number.isFinite(fallbackY)) {
    throw new Error('Trusted click requires finite x and y CSS pixels.');
  }
  const downloadPath = typeof options.downloadPath === 'string' ? options.downloadPath.trim() : '';

  const tab = await chrome.tabs.get(tabId);
  if (options.activate === true) {
    await activateOwnedTab(tab || tabId, { allowForeground: options.allowForeground === true });
  }

  return await withOwnedTabDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', {
      enabled: true,
    }).catch(() => {});
    let downloadBehavior = { ok: false, protocol: null, error: null };
    if (downloadPath.startsWith('/')) {
      try {
        await chrome.debugger.sendCommand(target, 'Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath,
        });
        downloadBehavior = { ok: true, protocol: 'Page.setDownloadBehavior' };
      } catch (pageError) {
        try {
          await chrome.debugger.sendCommand(target, 'Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath,
            eventsEnabled: true,
          });
          downloadBehavior = { ok: true, protocol: 'Browser.setDownloadBehavior' };
        } catch (browserError) {
          downloadBehavior = {
            ok: false,
            protocol: null,
            error: `${pageError?.message || pageError} | ${browserError?.message || browserError}`,
          };
        }
      }
    }
    await chrome.debugger.sendCommand(target, 'Page.bringToFront').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 80));

    let clickX = fallbackX;
    let clickY = fallbackY;
    let fromQuads = false;
    try {
      const documentResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
      const rootId = documentResult?.root?.nodeId;
      if (rootId) {
        const queryResult = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
          nodeId: rootId,
          selector: '[data-umbra-trusted-click="1"]',
        });
        if (queryResult?.nodeId) {
          const quadsResult = await chrome.debugger.sendCommand(target, 'DOM.getContentQuads', {
            nodeId: queryResult.nodeId,
          });
          const quad = quadsResult?.quads?.[0];
          if (Array.isArray(quad) && quad.length >= 8) {
            clickX = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
            clickY = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
            fromQuads = true;
          }
        }
      }
    } catch {
      // Fall back to the rect the page action already measured.
    }

    const mouse = {
      x: clickX,
      y: clickY,
      button: 'left',
      pointerType: 'mouse',
    };
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...mouse,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...mouse,
      buttons: 1,
      clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...mouse,
      buttons: 0,
      clickCount: 1,
    });

    await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `document.querySelectorAll('[data-umbra-trusted-click]').forEach((node) => node.removeAttribute('data-umbra-trusted-click'))`,
      returnByValue: true,
    }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', {
      enabled: false,
    }).catch(() => {});
    return {
      trustedClick: true,
      via: 'dispatchMouseEvent',
      x: clickX,
      y: clickY,
      fromQuads,
      downloadPath: downloadPath.startsWith('/') ? downloadPath : null,
      downloadBehavior,
    };
  });
}

function trustedClickPointFromRect(rect) {
  if (!rect || typeof rect !== 'object') {
    return null;
  }
  const x = Number(rect.x);
  const y = Number(rect.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const width = Number(rect.width);
  const height = Number(rect.height);
  return {
    x: x + (Number.isFinite(width) && width > 0 ? width / 2 : 0),
    y: y + (Number.isFinite(height) && height > 0 ? height / 2 : 0),
  };
}

function pendingTrustedClickInner(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const inner = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result
    : payload;
  if (inner.pendingTrustedClick !== true) {
    return null;
  }
  return inner;
}

async function maybeDispatchPendingTrustedClick(tabId, payload) {
  const inner = pendingTrustedClickInner(payload);
  if (!inner) {
    return payload;
  }
  const point = trustedClickPointFromRect(inner.submitRect || inner.rect);
  if (!point) {
    throw new Error('Page action requested a trusted click without a submit rect.');
  }
  const downloadPath = typeof inner.downloadPath === 'string' && inner.downloadPath.trim().startsWith('/')
    ? inner.downloadPath.trim()
    : (typeof inner.downloadDir === 'string' && inner.downloadDir.trim().startsWith('/') ? inner.downloadDir.trim() : '');
  // No cursor animation on this path, deliberately. The point was measured off
  // the page a moment ago and this click lands by viewport coordinate, so
  // anything inserted between the two, including the overlay's own script
  // injection, gives a modal, a lazy row or a sticky header time to shift the
  // layout under it. A coordinate click that lands two pixels off is a silent
  // no-op export rather than an error, which is the failure this path exists to
  // avoid. The recorder still marks the click, because that costs one Map
  // lookup and nothing on the dispatch path.
  pumpGifActionFrame(tabId, { kind: 'click_before', label: 'Submit', x: point.x, y: point.y });
  const trusted = await dispatchTrustedMouseClick(tabId, point.x, point.y, { downloadPath });
  pumpGifActionFrame(tabId, { kind: 'click', label: 'Submit', x: point.x, y: point.y });
  const waitAfter = Math.max(0, Math.min(Number(inner.waitMsAfterClick) || 150, 2_000));
  if (waitAfter > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitAfter));
  }
  inner.pendingTrustedClick = false;
  inner.clicked = true;
  if (Object.prototype.hasOwnProperty.call(inner, 'submitted')) {
    inner.submitted = true;
  }
  if (Object.prototype.hasOwnProperty.call(inner, 'exported')) {
    inner.exported = true;
  }
  inner.trustedClick = trusted;
  if (inner.submitResult && typeof inner.submitResult === 'object') {
    inner.submitResult.submitted = true;
    inner.submitResult.pendingTrustedClick = false;
    inner.submitResult.trustedClick = trusted;
  }
  return payload;
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

// Tabs whose current document already holds a same-version overlay. Cleared by
// the navigation and tab-removal listeners below, because a new document starts
// with no overlay in it.
const cursorOverlayReadyTabs = new Set();

function invalidateCursorOverlay(tabId) {
  cursorOverlayReadyTabs.delete(tabId);
  cursorLastPoint.delete(tabId);
  cursorPendingAnimations.delete(tabId);
}

// The lazy path, for a coordinate click on a page that never needed the content
// agent. Fail open is the rule: false means the caller runs the real action with
// no animation, never that the action fails.
async function ensureCursorOverlay(tabId) {
  // Memoized per document. Without this every click, fill, type and scroll paid
  // a chrome.tabs.get plus a two-file chrome.scripting.executeScript before the
  // real dispatch, on a path whose whole job is to stay fast.
  if (cursorOverlayReadyTabs.has(tabId)) {
    return true;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = String(tab?.url || tab?.pendingUrl || '');
    // A chrome://, chrome-extension://, about:, view-source: or Chrome Web Store
    // URL cannot be scripted at all, so the attempt is skipped rather than
    // thrown and swallowed.
    const unscriptable = /^(?:chrome|chrome-extension|chrome-untrusted|devtools|about|view-source|edge|moz-extension|data|blob):/i;
    const webStore = /^https?:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;
    if (!url || unscriptable.test(url) || webStore.test(url)) {
      return false;
    }
    // ax-tree.js rides along because measure resolves refs through
    // UmbraAxTree.resolveElementRef, and both scripts guard on their own version
    // so a same-version copy already in the page is left untouched.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [AX_TREE_SCRIPT, CURSOR_OVERLAY_SCRIPT],
    });
    cursorOverlayReadyTabs.add(tabId);
    return true;
  } catch {
    return false;
  }
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
    // cursor-overlay.js sits between the two on purpose: it needs UmbraAxTree for
    // measure, and its one host insertion has to land before content-agent.js
    // starts the observer that would otherwise count it as a DOM change and bump
    // domVersion under every outstanding element ref.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [AX_TREE_SCRIPT, CURSOR_OVERLAY_SCRIPT, CONTENT_AGENT_SCRIPT],
    });
    // The overlay went in with the agent, so the lazy path has nothing left to
    // do on this document.
    cursorOverlayReadyTabs.add(tabId);
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

// A submit that works navigates the frame, and Chrome can tear the frame down
// before chrome.scripting returns the injected function's value. That rejection
// is evidence the key did something, so it is reported rather than thrown, and
// only when the caller asked for the default action.
const KEY_NAVIGATION_TEARDOWN_RE = /frame (?:with id \d+ )?(?:was |is )?removed|no frame with id|execution context was destroyed|target closed|cannot access contents|the tab was closed/i;

async function dispatchKeyInTab(tabId, key, modifiers = {}, options = {}) {
  try {
    return await executeInTab(tabId, pressKey, [key, modifiers, options]);
  } catch (error) {
    if (options.defaultAction === true && KEY_NAVIGATION_TEARDOWN_RE.test(error?.message || '')) {
      return { key, modifiers, defaultAction: 'navigated', navigationTeardown: true };
    }
    throw error;
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
    const evaluated = await withOwnedTabDebugger(tabId, async (target) => {
      // Enabling Runtime is what makes the caller's own console output
      // reachable. It replays nothing logged earlier, which is why the
      // browser_javascript handler installs the page mirror up front as well.
      await chrome.debugger.sendCommand(target, 'Runtime.enable').catch(() => {});
      const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(async () => {\n${String(code || '')}\n})()`,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
      });
      // consoleAPICalled is delivered on its own task, and withOwnedTabDebugger
      // detaches the moment this callback returns. A detach mid-flight drops the
      // queued events, so give them one turn.
      await new Promise((resolve) => setTimeout(resolve, CONSOLE_DRAIN_MS));
      return result;
    });
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
  // Every element the selector matched is a root, not just the first. Walking
  // only document.querySelector's answer meant `selector: "a"` searched inside
  // the page's first anchor and reported zero matches on a page of links.
  const roots = selector
    ? [...document.querySelectorAll(selector)]
    : [document.body || document.documentElement].filter(Boolean);
  if (!roots.length) {
    return { __error: selector ? `Selector not found: ${selector}` : 'Page root was not found.' };
  }
  const domVersion = Number.isInteger(globalThis.__umbraContentAgent?.domVersion)
    ? globalThis.__umbraContentAgent.domVersion
    : 0;
  const found = api.findAxNodes(roots, {
    query,
    limit: options.limit,
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
  const modeCandidates = ['page', 'body', 'main', 'selector', 'article'];
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
    if (mode === 'article') {
      // This is the one-shot fallback that runs only when the content agent is
      // unreachable, and it picks a root without the density scoring the agent
      // does, so the text still carries whatever boilerplate sits inside that
      // node. The result says so through contentAgent.fallback.
      return document.querySelector('[itemprop="articleBody"], article, main, [role="main"]')
        || document.body
        || document.documentElement;
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
    // Same strip the content agent applies. This one-shot injection is the
    // fallback readPageContentViaAgent uses when the agent is unreachable, and
    // that happens in real sessions, so without it the same call returned
    // different markup depending on which path served it. The overlay's shadow
    // content is never serialized, so the whole of it in raw HTML is this one
    // deterministic empty tag pair.
    const html = truncate(rawHtml.replace(/<umbra-cursor-layer\b[^>]*><\/umbra-cursor-layer>/g, ''));
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
      element.setAttribute('data-umbra-trusted-click', '1');
      const rect = element.getBoundingClientRect();
      return {
        clicked: false,
        pendingTrustedClick: true,
        waitMsAfterClick: Number(params.waitMsAfterClick) || 500,
        downloadPath: typeof params.downloadPath === 'string' ? params.downloadPath : (typeof params.downloadDir === 'string' ? params.downloadDir : ''),
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
  // and once even when it was not, purely to read a length off it. The cursor
  // overlay's empty host is stripped for the same reason the page-content reads
  // strip it, and because htmlLength is a figure that ends up in SEO reporting:
  // counting the agent's own furniture inflated it on every driven page.
  const html = document.documentElement.outerHTML
    .replace(/<umbra-cursor-layer\b[^>]*><\/umbra-cursor-layer>/g, '');

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

function clickSelector(selector, doubleClick = false, options = {}) {
  const element = document.querySelector(selector);
  if (!element) {
    return { __error: `Selector not found: ${selector}` };
  }

  const button = options.button === 'right' ? 2 : options.button === 'middle' ? 1 : 0;
  const held = button === 2 ? 2 : button === 1 ? 4 : 1;
  const modifiers = options.modifiers || {};
  const ctrlKey = modifiers.ctrl === true;
  const shiftKey = modifiers.shift === true;
  const altKey = modifiers.alt === true;
  const metaKey = modifiers.meta === true;
  const modified = ctrlKey || shiftKey || altKey || metaKey;
  const rawCount = Number(options.clickCount);
  const clickCount = Number.isFinite(rawCount) && rawCount >= 1
    ? Math.min(3, Math.floor(rawCount))
    : (doubleClick ? 2 : 1);

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const init = (detail, buttons) => ({
    bubbles: true,
    cancelable: true,
    view: window,
    button,
    buttons,
    detail,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
  });
  const fireClick = (detail) => {
    element.dispatchEvent(new MouseEvent('mouseover', init(0, held)));
    element.dispatchEvent(new MouseEvent('mousedown', init(detail, held)));
    element.dispatchEvent(new MouseEvent('mouseup', init(detail, 0)));
    if (button === 2) {
      // A browser fires no click on a right press; the page gets contextmenu and
      // decides for itself whether to render a menu.
      element.dispatchEvent(new MouseEvent('contextmenu', init(detail, 0)));
      return;
    }
    if (button === 0 && !modified) {
      // Dispatch first, then element.click(), the same order clickAtPoint uses.
      // Only the dispatched event carries `detail`, which is what a page
      // implementing select-paragraph reads on clickCount 3; returning on
      // element.click() alone left detail at 0 on every pass. element.click()
      // still follows, because it is what runs activation behavior.
      element.dispatchEvent(new MouseEvent('click', init(detail, 0)));
      element.click();
      return;
    }
    element.dispatchEvent(new MouseEvent('click', init(detail, 0)));
    if (button === 1) {
      element.dispatchEvent(new MouseEvent('auxclick', init(detail, 0)));
    }
  };
  for (let pass = 1; pass <= clickCount; pass += 1) {
    fireClick(pass);
    if (pass === 2 && button !== 2) {
      element.dispatchEvent(new MouseEvent('dblclick', init(2, 0)));
    }
  }
  // Selecting the block under a triple click is a browser default action, and a
  // dispatched event has none: the click reported clickCount 3 and
  // getSelection() stayed empty. Rebuilt here, and only when the page made no
  // selection of its own.
  const selectTripleClicked = (node) => {
    const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
    if (!selection || String(selection).length > 0) {
      return 0;
    }
    const tag = String(node.tagName || '').toUpperCase();
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && typeof node.select === 'function') {
      node.select();
      return String(node.value || '').length;
    }
    const BLOCK_SELECTOR = 'p, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, pre, figcaption';
    let block = typeof node.closest === 'function' ? node.closest(BLOCK_SELECTOR) : null;
    for (let walk = node; !block && walk && walk !== document.body; walk = walk.parentElement) {
      const display = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(walk).display : '';
      if ((display === 'block' || display === 'list-item' || display === 'table-cell')
        && (walk.textContent || '').trim().length > 0) {
        block = walk;
      }
    }
    if (!block || (block.textContent || '').trim().length === 0) {
      return 0;
    }
    const range = document.createRange();
    range.selectNodeContents(block);
    selection.removeAllRanges();
    selection.addRange(range);
    return String(selection).length;
  };
  const selectedTextLength = clickCount >= 3 && button === 0 ? selectTripleClicked(element) : 0;
  return {
    clicked: true,
    doubleClick: clickCount === 2,
    clickCount,
    ...(selectedTextLength > 0 ? { selectedTextLength } : {}),
    button: options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left',
    selector,
    x: rect.x,
    y: rect.y,
  };
}

function clickAtPoint(x, y, doubleClick = false, options = {}) {
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

  const button = options.button === 'right' ? 2 : options.button === 'middle' ? 1 : 0;
  const held = button === 2 ? 2 : button === 1 ? 4 : 1;
  const modifiers = options.modifiers || {};
  const ctrlKey = modifiers.ctrl === true;
  const shiftKey = modifiers.shift === true;
  const altKey = modifiers.alt === true;
  const metaKey = modifiers.meta === true;
  const modified = ctrlKey || shiftKey || altKey || metaKey;
  const rawCount = Number(options.clickCount);
  const clickCount = Number.isFinite(rawCount) && rawCount >= 1
    ? Math.min(3, Math.floor(rawCount))
    : (doubleClick ? 2 : 1);

  const mouseInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: pointX,
    clientY: pointY,
    screenX: pointX,
    screenY: pointY,
    button,
    buttons: held,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
  };
  const pointerInit = {
    ...mouseInit,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };

  // detail is what a page reads to tell a single click from a double or a
  // select-paragraph triple, so every event in the sequence carries the pass
  // number rather than the constructor default of zero.
  const fireClick = (detail) => {
    element.dispatchEvent(new PointerEvent('pointerover', pointerInit));
    element.dispatchEvent(new MouseEvent('mouseover', mouseInit));
    element.dispatchEvent(new PointerEvent('pointerdown', { ...pointerInit, detail }));
    element.dispatchEvent(new MouseEvent('mousedown', { ...mouseInit, detail }));
    element.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0, detail }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0, detail }));
    if (button === 2) {
      // A browser fires no click on a right press. The page gets contextmenu and
      // renders its own menu if it has one.
      element.dispatchEvent(new MouseEvent('contextmenu', { ...mouseInit, buttons: 0, detail }));
      return;
    }
    element.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0, detail }));
    if (button === 1) {
      element.dispatchEvent(new MouseEvent('auxclick', { ...mouseInit, buttons: 0, detail }));
    }
    if (button === 0 && !modified) {
      // element.click() carries no modifier flags, so it runs only on the plain
      // path. The dispatched click above already runs activation behavior.
      try {
        element.click();
      } catch {
        // some custom elements reject a second click
      }
    }
    fireReact(element, 'onClick');
  };

  for (let pass = 1; pass <= clickCount; pass += 1) {
    fireClick(pass);
    if (pass === 2 && button !== 2) {
      element.dispatchEvent(new MouseEvent('dblclick', { ...mouseInit, buttons: 0, detail: 2 }));
    }
  }

  // Selecting the block under a triple click is a browser default action, and a
  // dispatched event has none: the click reported clickCount 3 and
  // getSelection() stayed empty. Rebuilt here, and only when the page made no
  // selection of its own.
  const selectTripleClicked = (node) => {
    const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
    if (!selection || String(selection).length > 0) {
      return 0;
    }
    const tag = String(node.tagName || '').toUpperCase();
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && typeof node.select === 'function') {
      node.select();
      return String(node.value || '').length;
    }
    const BLOCK_SELECTOR = 'p, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, pre, figcaption';
    let block = typeof node.closest === 'function' ? node.closest(BLOCK_SELECTOR) : null;
    for (let walk = node; !block && walk && walk !== document.body; walk = walk.parentElement) {
      const display = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(walk).display : '';
      if ((display === 'block' || display === 'list-item' || display === 'table-cell')
        && (walk.textContent || '').trim().length > 0) {
        block = walk;
      }
    }
    if (!block || (block.textContent || '').trim().length === 0) {
      return 0;
    }
    const range = document.createRange();
    range.selectNodeContents(block);
    selection.removeAllRanges();
    selection.addRange(range);
    return String(selection).length;
  };
  const selectedTextLength = clickCount >= 3 && button === 0 ? selectTripleClicked(element) : 0;

  const rect = element.getBoundingClientRect();
  return {
    clicked: true,
    doubleClick: clickCount === 2,
    clickCount,
    ...(selectedTextLength > 0 ? { selectedTextLength } : {}),
    button: options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left',
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

// Synthetic drag, dispatched in the page like every other Umbra input path, so
// the tab is never activated and Chrome never shows an automation banner for it.
// Two event families run: the pointer and mouse sequence a canvas, slider or
// custom sortable listens to, and, when the source carries draggable="true", the
// HTML5 drag family, which is the only thing a native drop target reacts to.
async function dragAtPoints(startX, startY, endX, endY, options = {}) {
  const resolvePoint = (rawX, rawY, ref, selector) => {
    const refValue = String(ref || '').trim();
    const selectorValue = String(selector || '').trim();
    if (refValue) {
      const api = globalThis.UmbraAxTree;
      if (!api?.resolveElementRef) {
        return { __error: 'Element refs need the page helpers. Pass coordinates or a selector instead.' };
      }
      const store = api.getSharedRefStore();
      const domVersion = Number.isInteger(globalThis.__umbraContentAgent?.domVersion)
        ? globalThis.__umbraContentAgent.domVersion
        : store.domVersion;
      const resolved = api.resolveElementRef(store, refValue, domVersion);
      if (resolved.__error) {
        return resolved;
      }
      const box = resolved.element.getBoundingClientRect();
      return { x: box.x + (box.width / 2), y: box.y + (box.height / 2), element: resolved.element };
    }
    if (selectorValue) {
      const element = document.querySelector(selectorValue);
      if (!element) {
        return { __error: `Selector not found: ${selectorValue}` };
      }
      const box = element.getBoundingClientRect();
      return { x: box.x + (box.width / 2), y: box.y + (box.height / 2), element };
    }
    // Number(null) is 0, which would turn an omitted end point into a drag to
    // the top-left corner, so a missing value is rejected before it is parsed.
    const pointX = rawX === null || rawX === undefined ? NaN : Number(rawX);
    const pointY = rawY === null || rawY === undefined ? NaN : Number(rawY);
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) {
      return { __error: 'browser_drag requires a start point and an end point, as coordinates, refs, or selectors.' };
    }
    return { x: pointX, y: pointY, element: document.elementFromPoint(pointX, pointY) };
  };

  const from = resolvePoint(startX, startY, options.startRef, options.startSelector);
  if (from.__error) {
    return from;
  }
  const to = resolvePoint(endX, endY, options.ref, options.selector);
  if (to.__error) {
    return to;
  }
  const source = from.element || document.elementFromPoint(from.x, from.y);
  if (!source) {
    return { __error: `No element at viewport point ${from.x},${from.y}.` };
  }

  const rawSteps = Number(options.steps);
  const steps = Number.isFinite(rawSteps) && rawSteps >= 2
    ? Math.min(40, Math.floor(rawSteps))
    : 12;
  const gapMs = 12;
  const mouseInit = (point, buttons) => ({
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: 0,
    buttons,
  });
  const pointerInit = (point, buttons) => ({
    ...mouseInit(point, buttons),
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  });
  // A raw mouse sequence is invisible to a native drop target: the HTML5 model
  // only moves data through drag events sharing one DataTransfer.
  const html5 = typeof source.getAttribute === 'function' && source.getAttribute('draggable') === 'true';
  const transfer = html5 && typeof DataTransfer === 'function' ? new DataTransfer() : null;
  const dragEvent = (type, point, buttons) => new DragEvent(type, { ...mouseInit(point, buttons), dataTransfer: transfer });

  // Moving the thumb of a native range input is a browser default action, and a
  // dispatched pointer sequence carries none: the drag reported success while
  // the slider sat at its start value. The value is read here so the emulation
  // below only runs when the page itself did nothing with the sequence.
  const rangeInput = typeof source.closest === 'function'
    ? (source.matches?.('input[type="range"]') ? source : source.closest('input[type="range"]'))
    : null;
  const rangeValueBefore = rangeInput ? String(rangeInput.value) : null;

  source.dispatchEvent(new PointerEvent('pointerdown', pointerInit(from, 1)));
  source.dispatchEvent(new MouseEvent('mousedown', mouseInit(from, 1)));
  if (transfer) {
    source.dispatchEvent(dragEvent('dragstart', from, 1));
  }

  let over = source;
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    const point = {
      x: from.x + ((to.x - from.x) * ratio),
      y: from.y + ((to.y - from.y) * ratio),
    };
    const under = document.elementFromPoint(point.x, point.y) || over;
    under.dispatchEvent(new PointerEvent('pointermove', pointerInit(point, 1)));
    under.dispatchEvent(new MouseEvent('mousemove', mouseInit(point, 1)));
    if (transfer) {
      if (under !== over) {
        over.dispatchEvent(dragEvent('dragleave', point, 1));
        under.dispatchEvent(dragEvent('dragenter', point, 1));
      }
      under.dispatchEvent(dragEvent('dragover', point, 1));
    }
    over = under;
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }

  const target = document.elementFromPoint(to.x, to.y) || over;
  let dropAccepted = null;
  if (transfer) {
    // A drop handler that calls preventDefault is the page saying it took the
    // payload, which is the one signal available without reading the page.
    dropAccepted = target.dispatchEvent(dragEvent('drop', to, 0)) === false;
  }
  target.dispatchEvent(new PointerEvent('pointerup', pointerInit(to, 0)));
  target.dispatchEvent(new MouseEvent('mouseup', mouseInit(to, 0)));
  if (transfer) {
    source.dispatchEvent(dragEvent('dragend', to, 0));
  }

  // The end point decides the value the same way the browser does: where the
  // pointer let go along the track, snapped to the input's own step.
  let emulatedRange = false;
  let rangeValue = null;
  if (rangeInput && String(rangeInput.value) === rangeValueBefore) {
    const box = rangeInput.getBoundingClientRect();
    const min = Number(rangeInput.min === '' ? 0 : rangeInput.min);
    const max = Number(rangeInput.max === '' ? 100 : rangeInput.max);
    const rawStep = rangeInput.step === '' || rangeInput.step === 'any' ? 1 : Number(rangeInput.step);
    const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
    if (Number.isFinite(min) && Number.isFinite(max) && max > min && box.width > 0) {
      const ratio = Math.min(1, Math.max(0, (to.x - box.x) / box.width));
      const stepped = min + (Math.round(((max - min) * ratio) / step) * step);
      const clamped = Math.min(max, Math.max(min, stepped));
      // Snapping in floats leaves values like 2.7000000000000002 on a 0.1 step
      // and the input would carry that string, so it is rounded to the step's
      // own precision before it is written.
      const decimals = (String(step).split('.')[1] || '').length;
      const next = decimals > 0 ? clamped.toFixed(decimals) : String(clamped);
      if (next !== rangeValueBefore) {
        rangeInput.value = next;
        rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
        rangeInput.dispatchEvent(new Event('change', { bubbles: true }));
        emulatedRange = true;
        rangeValue = String(rangeInput.value);
      }
    }
  }

  return {
    dragged: true,
    steps,
    html5Drag: Boolean(transfer),
    ...(emulatedRange ? { emulatedRange: true, rangeValue } : {}),
    ...(dropAccepted === null ? {} : { dropAccepted }),
    start: { x: Math.round(from.x), y: Math.round(from.y) },
    end: { x: Math.round(to.x), y: Math.round(to.y) },
    sourceTagName: source.tagName ? source.tagName.toLowerCase() : '',
    targetTagName: target.tagName ? target.tagName.toLowerCase() : '',
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

// Synthetic KeyboardEvents are untrusted. The DOM dispatch algorithm runs
// activation behavior for a click whatever its isTrusted value, which is why
// clickSelector's element.click() submits a form. A key event has no activation
// behavior: implicit form submission on Enter is a default action Chrome
// performs only for a trusted key event, so a dispatched Enter reaches page
// listeners and stops there. pressKey therefore emulates the one default action
// agents actually need, and only when the page did not claim the key.
function pressKey(key, modifiers = {}, options = {}) {
  const LEGACY_KEY_CODES = {
    Enter: 13, Tab: 9, Escape: 27, ' ': 32, Backspace: 8, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };
  // Fields whose presence blocks implicit submission, per HTML's implicit
  // submission rules. A form with no submit button submits on Enter only when
  // exactly one of these is present; with two or more a real Enter does nothing,
  // and neither does this.
  const IMPLICIT_SUBMIT_BLOCKERS = ['text', 'search', 'url', 'tel', 'email',
    'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'];

  const meta = modifiers.meta === true;
  const ctrl = modifiers.ctrl === true;
  const alt = modifiers.alt === true;
  const shift = modifiers.shift === true;
  const selector = typeof options.selector === 'string' ? options.selector.trim() : '';
  const wantDefaultAction = options.defaultAction === true;

  let explicit = null;
  if (selector) {
    explicit = document.querySelector(selector);
    if (!explicit) {
      return { __error: `Selector not found: ${selector}` };
    }
    if (explicit !== document.activeElement && typeof explicit.focus === 'function') {
      explicit.focus();
    }
  }
  const target = explicit || document.activeElement || document.body || document.documentElement;

  const keyName = String(key);
  const legacy = Object.prototype.hasOwnProperty.call(LEGACY_KEY_CODES, keyName)
    ? LEGACY_KEY_CODES[keyName]
    : (keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0);
  const code = keyName === ' ' ? 'Space'
    : keyName.length === 1
      ? (/[a-z]/i.test(keyName) ? `Key${keyName.toUpperCase()}`
        : /[0-9]/.test(keyName) ? `Digit${keyName}` : '')
      : keyName;
  const init = {
    key: keyName,
    code,
    keyCode: legacy,
    which: legacy,
    charCode: 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    metaKey: meta,
    ctrlKey: ctrl,
    altKey: alt,
    shiftKey: shift,
  };
  if (meta && keyName.toLowerCase() === 'a') {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.select();
    } else {
      document.execCommand('selectAll');
    }
  } else if (meta && keyName.toLowerCase() === 'c') {
    document.execCommand('copy');
  } else if (meta && keyName.toLowerCase() === 'v') {
    document.execCommand('paste');
  }

  const enterCandidate = wantDefaultAction && keyName === 'Enter' && !meta && !ctrl && !alt;
  const form = enterCandidate ? resolveForm(target) : null;
  const hrefBefore = location.href;
  let pageSubmitted = false;
  let submitPrevented = false;
  // Installed BEFORE dispatch. A page handler that submits the form itself
  // without calling preventDefault would otherwise be followed by our emulation
  // and the form would go twice.
  const onSubmitCapture = () => { pageSubmitted = true; };
  const onSubmitBubble = (event) => { submitPrevented = event.defaultPrevented; };
  if (form) {
    form.addEventListener('submit', onSubmitCapture, { capture: true });
    form.addEventListener('submit', onSubmitBubble, { capture: false });
  }

  const notPrevented = target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: legacy }));
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  const base = {
    key: keyName,
    modifiers: { meta, ctrl, alt, shift },
    defaultPrevented: !notPrevented,
  };
  const cleanup = () => {
    if (!form) {
      return;
    }
    form.removeEventListener('submit', onSubmitCapture, { capture: true });
    form.removeEventListener('submit', onSubmitBubble, { capture: false });
  };

  if (!enterCandidate) {
    cleanup();
    return base;
  }
  if (!notPrevented) {
    cleanup();
    return { ...base, defaultAction: 'none', reason: 'page_prevented_default' };
  }
  if (pageSubmitted) {
    cleanup();
    return { ...base, defaultAction: 'none', reason: 'page_submitted', submitPrevented };
  }
  if (location.href !== hrefBefore) {
    cleanup();
    return { ...base, defaultAction: 'none', reason: 'page_navigated' };
  }

  const emulated = emulateEnter(target, form);
  cleanup();
  return { ...base, ...emulated, submitEventFired: pageSubmitted, submitPrevented };

  function resolveForm(el) {
    if (!el || el.isContentEditable) {
      return null;
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'textarea') {
      return null;
    }
    if (el.form instanceof HTMLFormElement) {
      return el.form;
    }
    return typeof el.closest === 'function' ? el.closest('form') : null;
  }

  function emulateEnter(el, ownerForm) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const inputType = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
    if (tag === 'textarea' || el.isContentEditable) {
      return { defaultAction: 'none', reason: 'enter_inserts_newline' };
    }
    // Enter on a button or a link is an activation, and activation behavior does
    // run for a synthetic click, so element.click() reproduces it exactly.
    if (tag === 'button' || tag === 'a' || el.getAttribute?.('role') === 'button'
        || ['submit', 'button', 'reset', 'image'].includes(inputType)) {
      el.click();
      return { defaultAction: 'activate', activatedTag: tag };
    }
    if (!(ownerForm instanceof HTMLFormElement)) {
      return { defaultAction: 'none', reason: 'no_form' };
    }
    // The default button is the first submit button in tree order owned by the
    // form. A real Enter clicks it, so its own click handlers run and its
    // name/value reach the submitted payload; requestSubmit() with no submitter
    // would drop both.
    const defaultButton = [...ownerForm.elements].find((node) => {
      if (!node || node.disabled) {
        return false;
      }
      const nodeTag = String(node.tagName || '').toLowerCase();
      if (nodeTag === 'button') {
        return String(node.type || 'submit').toLowerCase() === 'submit';
      }
      if (nodeTag === 'input') {
        return ['submit', 'image'].includes(String(node.type || '').toLowerCase());
      }
      return false;
    });
    if (defaultButton) {
      defaultButton.click();
      return { defaultAction: 'default_button_click' };
    }
    const blockers = [...ownerForm.elements].filter((node) => (
      String(node.tagName || '').toLowerCase() === 'input'
      && !node.disabled
      && IMPLICIT_SUBMIT_BLOCKERS.includes(String(node.type || 'text').toLowerCase())
    ));
    if (blockers.length > 1) {
      return { defaultAction: 'none', reason: 'multiple_fields_block_implicit_submission' };
    }
    if (typeof ownerForm.requestSubmit === 'function') {
      ownerForm.requestSubmit();
      return { defaultAction: 'request_submit' };
    }
    ownerForm.submit();
    return { defaultAction: 'form_submit', note: 'requestSubmit was unavailable, so the submit event and form validation were skipped' };
  }
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

// Coordinate-mode image upload: the drop zone case, which most modern uploaders
// use instead of a visible input[type=file]. The bytes arrive base64-encoded in
// params because nothing in the page can read a local path, and a File built
// here from a DataTransfer is indistinguishable to the page from one a person
// dragged in.
function dropFileAtPoint(x, y, file) {
  const pointX = Number(x);
  const pointY = Number(y);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) {
    return { __error: 'browser_upload_image requires both x and y as CSS pixels for a drop.' };
  }
  const element = document.elementFromPoint(pointX, pointY);
  if (!element) {
    return { __error: `No element at viewport point ${pointX},${pointY}.` };
  }
  if (typeof DataTransfer !== 'function') {
    return { __error: 'This page cannot build a drop payload. Use ref or selector against a file input instead.' };
  }

  let bytes;
  try {
    const binary = atob(String(file?.data || ''));
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    return { __error: 'The file payload did not decode. Retry the upload.' };
  }

  const mimeType = String(file?.mimeType || 'application/octet-stream');
  const dropped = new File([bytes], String(file?.name || 'upload'), { type: mimeType });
  const transfer = new DataTransfer();
  transfer.items.add(dropped);
  const dragEvent = (type) => new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: pointX,
    clientY: pointY,
    dataTransfer: transfer,
  });

  element.dispatchEvent(dragEvent('dragenter'));
  element.dispatchEvent(dragEvent('dragover'));
  // A drop handler that calls preventDefault is the page saying it took the
  // file. dispatchEvent returning false is that signal.
  const accepted = element.dispatchEvent(dragEvent('drop')) === false;
  return {
    dropped: true,
    accepted,
    x: pointX,
    y: pointY,
    fileName: dropped.name,
    bytes: dropped.size,
    mimeType,
    targetTagName: element.tagName.toLowerCase(),
  };
}

function scrollPage(selector, x = 0, y = 0, options = {}) {
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) {
      return { __error: `Selector not found: ${selector}` };
    }
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { selector, scrolled: true };
  }

  // A scroll click is about 100 CSS pixels, the same notch a wheel reports.
  const direction = String(options.direction || '');
  const rawAmount = Number(options.amount);
  const amount = Number.isFinite(rawAmount) && rawAmount >= 1 ? Math.min(30, Math.floor(rawAmount)) : 3;
  let deltaX = Number(x) || 0;
  let deltaY = Number(y) || 0;
  if (direction === 'down' || direction === 'up') {
    deltaX = 0;
    deltaY = amount * (direction === 'up' ? -100 : 100);
  } else if (direction === 'left' || direction === 'right') {
    deltaY = 0;
    deltaX = amount * (direction === 'left' ? -100 : 100);
  }

  const atX = Number(options.atX);
  const atY = Number(options.atY);
  if (Number.isFinite(atX) && Number.isFinite(atY)) {
    // A page whose content lives in an inner pane ignores window.scrollBy, so
    // walk up from the point the caller named to the first ancestor that can
    // actually scroll on the axis being moved.
    let node = document.elementFromPoint(atX, atY);
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      const canScrollY = node.scrollHeight > node.clientHeight && /auto|scroll/.test(style.overflowY);
      const canScrollX = node.scrollWidth > node.clientWidth && /auto|scroll/.test(style.overflowX);
      if ((deltaY !== 0 && canScrollY) || (deltaX !== 0 && canScrollX)) {
        const beforeTop = node.scrollTop;
        const beforeLeft = node.scrollLeft;
        node.scrollBy(deltaX, deltaY);
        return {
          x: deltaX,
          y: deltaY,
          scrolled: true,
          target: 'element',
          targetTagName: node.tagName.toLowerCase(),
          moved: node.scrollTop !== beforeTop || node.scrollLeft !== beforeLeft,
        };
      }
      node = node.parentElement;
    }
  }

  window.scrollBy(deltaX, deltaY);
  return { x: deltaX, y: deltaY, scrolled: true };
}

function historyGo(delta) {
  const before = location.href;
  const length = history.length;
  if (length <= 1) {
    return { moved: false, before, length, attempted: false };
  }
  history.go(delta);
  return { before, length, attempted: true };
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

// Stringified into the page by executeInTab, so its free identifiers resolve in
// the injected world. It touches nothing but globalThis.UmbraCursor, and every
// path returns a plain object instead of throwing, because a cosmetic miss must
// never become a tool error.
function umbraCursorDrive(spec) {
  const api = globalThis.UmbraCursor;
  if (!api) {
    return { ok: false, reason: 'cursor_overlay_missing' };
  }
  const op = String(spec?.op || '');
  try {
    if (op === 'glide') {
      return api.glideTo({ x: spec.x, y: spec.y, durationMs: spec.durationMs })
        .then(() => ({ ok: true, op }))
        .catch(() => ({ ok: false, op, reason: 'cursor_overlay_failed' }));
    }
    if (op === 'dragPath') {
      return api.dragPath({ points: spec.points, durationMs: spec.durationMs })
        .then(() => ({ ok: true, op }))
        .catch(() => ({ ok: false, op, reason: 'cursor_overlay_failed' }));
    }
    if (op === 'ripple') {
      return { ok: api.ripple({ x: spec.x, y: spec.y, variant: spec.variant }), op };
    }
    if (op === 'typing') {
      return { ok: api.typing({ x: spec.x, y: spec.y }), op };
    }
    if (op === 'scrollHint') {
      return { ok: api.scrollHint({ x: spec.x, y: spec.y, direction: spec.direction }), op };
    }
    if (op === 'hide') {
      return { ok: api.hide(), op };
    }
    if (op === 'state') {
      return { ok: true, op, state: api.state() };
    }
    return { ok: false, op, reason: 'cursor_overlay_unknown_op' };
  } catch {
    return { ok: false, op, reason: 'cursor_overlay_failed' };
  }
}

// Also stringified into the page. Returns viewport CSS pixels or null, and null
// means the caller skips the animation and runs the real action.
function umbraCursorMeasure(target) {
  const api = globalThis.UmbraCursor;
  if (!api || typeof api.measure !== 'function') {
    return null;
  }
  try {
    return api.measure(target || {}) ?? null;
  } catch {
    return null;
  }
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
    // keyCode, which and code were all zero or empty here, so a page handler
    // that branches on event.keyCode ignored every character Umbra typed.
    const legacy = char.toUpperCase().charCodeAt(0) || 0;
    const init = {
      key: char,
      code: /[a-z]/i.test(char) ? `Key${char.toUpperCase()}` : (/[0-9]/.test(char) ? `Digit${char}` : ''),
      keyCode: legacy,
      which: legacy,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
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

// --- GIF recorder ----------------------------------------------------------
// The worker captures frames and forwards them; it never holds them. Everything
// below is either a capture, a message to the offscreen document that does hold
// them, or teardown.

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

// A label a person can read off a frame. The recorder never invents one from
// page text, so a label carries only what the tool call already said it was
// doing.
const GIF_ACTION_LABELS = {
  click: 'Click',
  rightClick: 'Right click',
  double: 'Double click',
  triple: 'Triple click',
  hover: 'Hover',
  type: 'Type',
  scroll: 'Scroll',
  drag: 'Drag',
  select: 'Select',
  upload: 'Upload',
};

function gifActionLabel(kind) {
  return GIF_ACTION_LABELS[String(kind || '')] || 'Action';
}

async function sendOffscreenMessage(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    // No listener means the document that holds the frames is not running, which
    // is what disabling the bridge or clearing the shared key does. Chrome's own
    // message for that says only that a connection could not be established.
    const error = new Error(
      'The recorder is not running. Recording needs the bridge enabled and a shared key set on the options page.',
    );
    error.code = 'gif_offscreen_unavailable';
    throw error;
  }
  if (response?.__error) {
    const error = new Error(response.__error.message || 'Offscreen call failed.');
    error.code = response.__error.code || 'offscreen_call_failed';
    throw error;
  }
  if (!response || response.ok !== true) {
    const error = new Error(response?.error || 'The recorder document did not answer.');
    error.code = response?.code || 'gif_offscreen_unavailable';
    throw error;
  }
  return response;
}

async function pushGifFrame(tabId, dataUrl, meta = {}) {
  const state = gifRecordings.get(tabId);
  if (!state) {
    return false;
  }
  const response = await sendOffscreenMessage({
    type: 'gif_frame',
    tabId,
    dataUrl,
    maxWidth: state.maxWidth,
    maxFrames: state.maxFrames,
    meta: {
      ts: Date.now(),
      kind: 'tick',
      dpr: state.dpr,
      ...meta,
      tabId,
    },
  });
  // The two counts mean different things and are kept apart on purpose. The
  // buffer lives in the offscreen document, so it is the only thing that knows
  // how many frames it evicted to stay under maxFrames; this worker is the only
  // thing that knows how many captures failed outright.
  const reportedCount = Number(response.frameCount);
  state.frameCount = Number.isFinite(reportedCount) ? reportedCount : state.frameCount;
  const reportedDrops = Number(response.droppedFrames);
  state.droppedFrames = Number.isFinite(reportedDrops) ? reportedDrops : state.droppedFrames;
  state.truncatedFrames = response.truncatedFrames === true;
  return true;
}

// One frame, best effort. Every caller except the opening capture in the
// browser_gif start branch uses this, and every one of them is on a path whose
// real job is something else, so a failed frame is dropped rather than raised.
async function captureGifFrame(tabId, meta = {}) {
  const state = gifRecordings.get(tabId);
  if (!state || state.recording !== true) {
    return false;
  }
  if (Date.now() - state.startedAt > MAX_RECORDING_MS) {
    // The worker may have been evicted and resurrected since the watchdog timer
    // was set, in which case this check is the only one left standing.
    await stopGifRecording(tabId, 'watchdog');
    return false;
  }
  if (state.capturing === true) {
    // A slow page at ten frames a second would otherwise queue captures faster
    // than they complete. Skipping the tick keeps the buffer honest about when
    // each frame was taken instead of backdating a pile of them.
    state.skippedFrames += 1;
    // The frame is dropped; its metadata is not. Action frames are the only ones
    // carrying a click variant, a label or drag endpoints, and they are exactly
    // the ones a slow capture swallows, so a click that landed during a tick used
    // to produce an export with no click marker at all. The metadata rides the
    // next frame that does land instead.
    if (isGifActionMeta(meta)) {
      state.pendingActionMeta = { ...meta };
    }
    return false;
  }
  state.capturing = true;
  const captureStartedAt = Date.now();
  const carried = state.pendingActionMeta || null;
  state.pendingActionMeta = null;
  const frameMeta = carried && !isGifActionMeta(meta) ? { ...carried, ...meta, kind: carried.kind } : meta;
  try {
    const capture = await captureSilentScreenshot({ id: tabId }, { format: 'png', fullPage: false });
    return await pushGifFrame(tabId, capture.dataUrl, frameMeta);
  } catch {
    state.failedCaptures += 1;
    // The capture failed, so nothing carried the metadata. Put it back rather
    // than losing the marker to a single bad frame.
    if (carried && !state.pendingActionMeta) {
      state.pendingActionMeta = carried;
    }
    return false;
  } finally {
    state.capturing = false;
    // What the next tick is paced against. A tab whose capture takes 700ms
    // cannot hold four frames a second, and asking it to only produced skipped
    // ticks.
    state.lastCaptureMs = Date.now() - captureStartedAt;
  }
}

// Interval capture, paced to what the tab can actually deliver. A fixed
// setInterval at the requested rate queued ticks faster than a capture
// completed and captureGifFrame dropped every one of them: a recording at four
// frames a second reported 92 skipped frames against 24 exported. Each tick
// schedules the next one, never sooner than the last capture took, so the frame
// rate degrades to what the page can hold instead of shredding.
function scheduleGifTick(tabId) {
  const state = gifRecordings.get(tabId);
  if (!state || state.recording !== true) {
    return;
  }
  const delay = Math.max(state.frameIntervalMs || 0, Math.round(state.lastCaptureMs || 0));
  state.intervalId = setTimeout(() => {
    void captureGifFrame(tabId, { kind: 'tick' })
      .catch(() => false)
      .then(() => scheduleGifTick(tabId));
  }, delay);
}

// A frame worth drawing a marker on: anything the cursor path pumped, as opposed
// to an interval tick.
function isGifActionMeta(meta) {
  const kind = String(meta?.kind || '');
  return kind !== '' && kind !== 'tick' && kind !== 'start';
}

// Called from the cursor driver on paths whose result is already decided. A tab
// with no recording pays one Map lookup and nothing else.
function pumpGifActionFrame(tabId, meta) {
  if (!gifRecordings.has(tabId)) {
    return;
  }
  void captureGifFrame(tabId, meta).catch(() => {});
}

// The control record for a recording lives in this worker's memory, which MV3
// tears down after about thirty seconds idle, while the frames live in the
// offscreen document, which does not get evicted. A resurrected worker used to
// see an empty map: browser_gif stop threw "No recording on this tab" with every
// frame still buffered, status reported frameCount 0 next to a non-zero buffered
// count, and nothing was left to release the debugger pin. These three keep a
// compact copy in chrome.storage.session so a new worker can pick the recording
// back up.
const GIF_RECORDING_STORAGE_KEY = 'gifRecordingsByTab';

async function persistGifRecordings() {
  const snapshot = {};
  for (const [tabId, state] of gifRecordings.entries()) {
    snapshot[String(tabId)] = {
      sessionId: state.sessionId,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      stopReason: state.stopReason,
      recording: state.recording === true,
      fps: state.fps,
      maxFrames: state.maxFrames,
      maxWidth: state.maxWidth,
      dpr: state.dpr,
      frameCount: state.frameCount,
      droppedFrames: state.droppedFrames,
      failedCaptures: state.failedCaptures,
      skippedFrames: state.skippedFrames,
      truncatedFrames: state.truncatedFrames === true,
    };
  }
  try {
    await chrome.storage.session.set({ [GIF_RECORDING_STORAGE_KEY]: snapshot });
  } catch {
    // Session storage is a convenience here. A write that fails costs recovery
    // after an eviction, never the recording that is running now.
  }
}

// Rehydrated recordings come back stopped, not running. The interval and the
// watchdog died with the worker, so the capture genuinely ended at the eviction;
// reporting it as live would promise frames that were never taken. What this
// buys is an honest stop, status and export against the frames the offscreen
// document still holds.
async function rehydrateGifRecordings() {
  let stored = null;
  try {
    const read = await chrome.storage.session.get(GIF_RECORDING_STORAGE_KEY);
    stored = read?.[GIF_RECORDING_STORAGE_KEY] || null;
  } catch {
    return;
  }
  if (!stored || typeof stored !== 'object') {
    return;
  }
  for (const [key, record] of Object.entries(stored)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId) || gifRecordings.has(tabId) || !record) {
      continue;
    }
    gifRecordings.set(tabId, {
      sessionId: record.sessionId || '',
      startedAt: Number(record.startedAt) || Date.now(),
      stoppedAt: Number(record.stoppedAt) || Date.now(),
      stopReason: record.recording === true ? 'worker_evicted' : (record.stopReason || 'stop'),
      recording: false,
      pinned: false,
      pinHandle: null,
      fps: Number(record.fps) || GIF_DEFAULT_FPS,
      maxFrames: Number(record.maxFrames) || GIF_DEFAULT_MAX_FRAMES,
      maxWidth: Number(record.maxWidth) || GIF_DEFAULT_MAX_WIDTH,
      dpr: Number(record.dpr) || 1,
      intervalId: null,
      watchdogId: null,
      frameIntervalMs: Math.round(1000 / (Number(record.fps) || GIF_DEFAULT_FPS)),
      lastCaptureMs: 0,
      capturing: false,
      pendingActionMeta: null,
      frameCount: Number(record.frameCount) || 0,
      droppedFrames: Number(record.droppedFrames) || 0,
      failedCaptures: Number(record.failedCaptures) || 0,
      skippedFrames: Number(record.skippedFrames) || 0,
      truncatedFrames: record.truncatedFrames === true,
    });
  }
  await persistGifRecordings();
}

// A fresh worker holds no pins by definition, so any tab this extension is still
// attached to is an orphan from the worker that died, and Chrome is showing that
// tab an automation banner nothing can take down. Walking the target list and
// detaching those is what makes the "no log or recording leaves a tab attached
// indefinitely" promise true across an eviction.
async function releaseOrphanedTabDebuggers() {
  if (!chrome.debugger || typeof chrome.debugger.getTargets !== 'function') {
    return;
  }
  let targets = [];
  try {
    targets = await chrome.debugger.getTargets();
  } catch {
    return;
  }
  for (const target of targets || []) {
    const tabId = Number(target?.tabId);
    if (!Number.isInteger(tabId) || target?.attached !== true) {
      continue;
    }
    // Re-read on every iteration: a command served while this walk was in
    // flight may have pinned the tab, and that pin is live.
    if (tabDebuggerAttachments.has(tabId)) {
      continue;
    }
    // Detach only ever ends this extension's own attachment. A target held by
    // DevTools or another client rejects, which is the same as leaving it alone.
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function stopGifRecording(tabId, reason = 'stop') {
  const state = gifRecordings.get(tabId);
  if (!state) {
    return null;
  }
  if (state.intervalId !== null) {
    // A self-rescheduling timeout rather than an interval, so the pacing can
    // follow how long a capture on this tab actually takes.
    clearTimeout(state.intervalId);
    state.intervalId = null;
  }
  if (state.watchdogId !== null) {
    clearTimeout(state.watchdogId);
    state.watchdogId = null;
  }
  if (state.recording === true) {
    state.recording = false;
    state.stoppedAt = Date.now();
    state.stopReason = reason;
    if (state.pinned === true) {
      state.pinned = false;
      unpinTabDebugger(tabId, state.pinHandle || null);
      state.pinHandle = null;
    }
  }
  await persistGifRecordings();
  return state;
}

// Stop and throw the frames away. Separate from stop because stop keeps the
// buffer: the usual sequence is stop, then export, then clear.
async function discardGifRecording(tabId) {
  await stopGifRecording(tabId, 'clear');
  gifRecordings.delete(tabId);
  await persistGifRecordings();
  try {
    await sendOffscreenMessage({ type: 'gif_clear', tabId });
  } catch {
    // A closed offscreen document has already lost the frames it held.
  }
}

async function discardSessionGifRecordings(sessionId) {
  for (const [tabId, state] of [...gifRecordings.entries()]) {
    if (state.sessionId === sessionId) {
      await discardGifRecording(tabId);
    }
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

// `recommendation` is a repair hint, so it belongs only on a result that needs
// repairing. Attaching it to every capture made a clean screenshot read like a
// failed one.
async function buildScreenshotPreflight(tab, { degraded = '' } = {}) {
  const window = await safeGetWindow(tab.windowId);
  const preflight = {
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    tabActive: tab.active === true,
    tabStatus: tab.status || 'unknown',
    windowId: tab.windowId ?? null,
    windowFocused: window?.focused === true,
    width: tab.width ?? null,
    height: tab.height ?? null,
  };
  if (degraded === 'capture_failed') {
    preflight.recommendation = 'Retry after the tab finishes loading, or capture without crop if the failure came from image readback.';
  } else if (degraded === 'truncated') {
    preflight.recommendation = `Full page capture stopped at ${FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX}px. Capture the rest with region crops, or scroll and capture again.`;
  }
  return preflight;
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
    const ownedOnly = params.ownedOnly === true;
    const limit = clampTabsContextLimit(params.limit);
    const urlMaxLength = clampTabsContextUrlMaxLength(params.urlMaxLength);
    let releasedMissingTab = false;
    let created = false;
    let createdTabId = null;

    const liveOwnedTabs = new Map();
    for (const tabId of sessionStore.listTabIds(sessionId)) {
      const tab = await safeGetTab(tabId);
      if (tab) {
        liveOwnedTabs.set(tab.id, tab);
      } else {
        sessionStore.releaseTab(tabId);
        releasedMissingTab = true;
      }
    }

    if (createIfEmpty && liveOwnedTabs.size === 0) {
      const createdTab = await getOrCreateSessionTab(sessionId, {
        createIfMissing: true,
        newTab: true,
        activate: false,
        allowForeground: params.allowForeground === true,
        url: 'about:blank',
      });
      await ensureSessionGroup(sessionId, createdTab.id, { groupCollapsed: true });
      created = true;
      createdTabId = createdTab.id;
      // Re-read after grouping: the create result predates the group assignment
      // and can still carry an empty url.
      liveOwnedTabs.set(createdTab.id, (await safeGetTab(createdTab.id)) || createdTab);
    } else if (releasedMissingTab) {
      await sessionStore.persist();
    }

    // Owned tabs come from the session store, never from the query snapshot, and
    // are never filtered by URL. A tab this session owns is always listed.
    const ownedRows = [];
    for (const tab of liveOwnedTabs.values()) {
      ownedRows.push(buildTabsContextRow(tab, { owned: true, urlMaxLength }));
    }

    const unownedRows = [];
    if (!ownedOnly) {
      const chromeTabs = await chrome.tabs.query({});
      for (const tab of chromeTabs) {
        if (liveOwnedTabs.has(tab.id)) {
          continue;
        }
        if (!isTabsContextUrl(tabsContextUrlOf(tab), includeInternal)) {
          continue;
        }
        unownedRows.push(buildTabsContextRow(tab, { owned: false, urlMaxLength }));
      }
    }

    const matchedCount = ownedRows.length + unownedRows.length;
    const tabs = [...ownedRows, ...unownedRows].slice(0, limit);
    return {
      sessionId,
      created,
      createdTabId,
      group: await serializeSessionGroup(sessionId),
      ownedCount: ownedRows.length,
      matchedCount,
      returnedCount: tabs.length,
      truncatedByLimit: tabs.length < matchedCount,
      tabs,
    };
  }

  if (tool === 'browser_find_tabs') {
    return await findChromeTabs(params);
  }

  if (tool === 'browser_adopt_tab') {
    return await adoptExistingTab(sessionId, params);
  }

  if (tool === 'browser_find_groups') {
    return await findChromeGroups(sessionId, params);
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
      allowForeground: params.allowForeground === true,
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
      allowForeground: params.allowForeground === true,
      url,
      newWindow: params.newWindow === true,
    });
    await ensureSessionGroup(sessionId, tab.id, {
      groupTitle: params.groupTitle,
      groupColor: params.groupColor,
      groupCollapsed: params.groupCollapsed,
    });
    invalidateTabReadCache(tab.id);
    await chrome.tabs.update(tab.id, { url });
    if (activate) {
      await activateOwnedTab(tab.id, { allowForeground: params.allowForeground === true });
    }
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
    const activate = params.activate === true;
    const allowForeground = params.allowForeground === true;
    // Default: only retarget the session's active tab. chrome.tabs.update({active:true})
    // steals macOS Chrome focus even when the window was in the background.
    if (activate) {
      await activateOwnedTab(tab, { allowForeground });
    }
    sessionStore.setActiveTab(sessionId, tab.id);
    await sessionStore.persist();
    const live = await safeGetTab(tab.id);
    return {
      tabId: tab.id,
      sessionActive: true,
      active: live?.active === true,
      activated: activate && allowForeground,
      activateRequested: activate,
    };
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
    return await cleanupGroups(sessionId, params);
  }

  if (tool === 'browser_screenshot') {
    // Background-first: silent capture is the default. Visible capture requires
    // silent:false plus activate or allowForeground (FOREGROUND RULE).
    const allowForeground = params.allowForeground === true;
    const activateRequested = params.activate === true;
    const visibleCapture = params.silent === false && (activateRequested || allowForeground);
    const silent = !visibleCapture;
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: visibleCapture && activateRequested,
      allowForeground: visibleCapture && allowForeground,
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
    // An evidence screenshot never carries a stray pointer or a ripple. The GIF
    // recorder calls captureSilentScreenshot directly and deliberately keeps the
    // cursor, which is why this lives in the tool block and not in the capture
    // helper. The settle first: the glide and the post-action indicator are
    // started rather than awaited, so a screenshot issued right after a click
    // could otherwise hide, then have the ripple injection land on top of it.
    await settleCursorAnimations(tab.id);
    await executeInTab(tab.id, umbraCursorDrive, [{ op: 'hide' }]).catch(() => {});
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
      error.preflight = await buildScreenshotPreflight(tab, { degraded: 'capture_failed' });
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
      preflight: await buildScreenshotPreflight(tab, truncated ? { degraded: 'truncated' } : {}),
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
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'type',
      selector,
      ref,
    }, async () => {
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
    });
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
    const result = await executeInTabWithRetry(tab.id, runPageAction, [
      params.action,
      params.params && typeof params.params === 'object' ? params.params : {},
      { timeoutMs: params.timeoutMs, recipeFailure: recipe.installed ? '' : (recipe.reason || '') },
    ]);
    return await maybeDispatchPendingTrustedClick(tab.id, result);
  }

  if (tool === 'browser_javascript') {
    const code = requireJavascriptCode(params.code);
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    // No console mirror is installed from here. Priming it on every tab this
    // tool touched left a permanent MAIN-world monkey-patch on console.error,
    // warn, info, log and debug, plus a globalThis.__umbraPageConsole buffer the
    // page itself could read, on any page the agent ran JS against. That is
    // resident state the extension does not otherwise leave behind, and a
    // console.log whose toString is no longer native is a one-line fingerprint.
    // The mirror stays where it was before: installed by
    // browser_console_messages, which is the tool whose job is reading console
    // output, at the cost of the first read on a tab missing whatever the page
    // logged before it.
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
    // doubleClick predates clickCount and still works: it is normalized here so
    // every path below reads one number.
    const clickOptions = normalizeClickOptions(params, doubleClick);
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: clickFeedbackKind(clickOptions),
      ...(hasCoords ? { x: Number(params.x), y: Number(params.y) } : {}),
      selector: hasSelector ? params.selector : '',
      ref: hasRef ? params.ref : '',
    }, async () => {
      if (hasCoords) {
        return await executeInTab(tab.id, clickAtPoint, [Number(params.x), Number(params.y), doubleClick, clickOptions]);
      }
      if (hasRef) {
        const result = await sendContentAgentCommand(tab.id, 'click_interactive_ref', {
          ref: params.ref,
          options: {
            ...(params.selector ? { selector: params.selector } : {}),
            doubleClick,
            button: clickOptions.button,
            clickCount: clickOptions.clickCount,
            modifiers: clickOptions.modifiers,
          },
        });
        if (result?.__error) {
          const error = new Error(result.__error);
          error.code = result.__errorCode || result.code;
          throw error;
        }
        return result;
      }
      return await executeInTab(tab.id, clickSelector, [params.selector, doubleClick, clickOptions]);
    });
  }

  if (tool === 'browser_drag') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const startRef = typeof params.startRef === 'string' ? params.startRef.trim() : '';
    const startSelector = typeof params.startSelector === 'string' ? params.startSelector.trim() : '';
    const endRef = typeof params.ref === 'string' ? params.ref.trim() : '';
    const endSelector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const hasStartCoords = Number.isFinite(Number(params.startX)) && Number.isFinite(Number(params.startY));
    const hasEndCoords = Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y));
    if (!hasStartCoords && !startRef && !startSelector) {
      throw new Error('browser_drag requires a start point: startX and startY, startRef, or startSelector.');
    }
    if (!hasEndCoords && !endRef && !endSelector) {
      throw new Error('browser_drag requires an end point: x and y, ref, or selector.');
    }
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'drag',
      ...(hasStartCoords ? { x: Number(params.startX), y: Number(params.startY) } : {}),
      selector: startSelector,
      ref: startRef,
      // The overlay draws the path only when it knows both ends up front. An end
      // named by ref or selector is resolved in the page, so those drags get the
      // glide to the start and no arrow.
      ...(hasEndCoords ? { endX: Number(params.x), endY: Number(params.y) } : {}),
    }, async () => await executeInTab(tab.id, dragAtPoints, [
      hasStartCoords ? Number(params.startX) : null,
      hasStartCoords ? Number(params.startY) : null,
      hasEndCoords ? Number(params.x) : null,
      hasEndCoords ? Number(params.y) : null,
      {
        startRef,
        startSelector,
        ref: endRef,
        selector: endSelector,
        ...(Number.isFinite(Number(params.steps)) ? { steps: Number(params.steps) } : {}),
      },
    ]));
  }

  if (tool === 'browser_click_text') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'click',
      // clickVisibleText reports the rect origin of whatever it matched, which
      // is the only point available for a text lookup.
      pointFromResult: (result) => (result && result.clicked === true ? { x: result.x, y: result.y } : null),
    }, async () => await executeInTab(tab.id, clickVisibleText, [params.text, {
      exact: params.exact !== false,
      selector: params.selector || '',
      index: Number.isInteger(params.index) ? params.index : 0,
    }]));
  }

  if (tool === 'browser_fill') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'type',
      selector: typeof params.selector === 'string' ? params.selector : '',
      ref: typeof params.ref === 'string' ? params.ref : '',
    }, async () => {
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
    });
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
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'upload',
      selector,
      ref,
    }, async () => {
      const targetSelector = await resolveFileInputSelector(tab.id, selector, ref);
      await setOwnedTabFileInput(tab.id, targetSelector, filePath);
      return { tabId: tab.id, uploaded: true, filePath };
    });
  }

  if (tool === 'browser_upload_image') {
    const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
    const hasCoords = Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y));
    if (!selector && !ref && !hasCoords) {
      throw new Error('browser_upload_image requires ref, selector, or both x and y.');
    }
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'upload',
      ...(hasCoords && !selector && !ref ? { x: Number(params.x), y: Number(params.y) } : {}),
      selector,
      ref,
    }, async () => {
      if (selector || ref) {
        // File-input mode is the existing upload mechanism unchanged: the path
        // is handed to Chrome and never becomes bytes on the wire, so this mode
        // has no size limit.
        const filePath = requireAbsoluteFilePath(params.filePath);
        const targetSelector = await resolveFileInputSelector(tab.id, selector, ref);
        await setOwnedTabFileInput(tab.id, targetSelector, filePath);
        return { tabId: tab.id, uploaded: true, mode: 'fileInput', filePath };
      }
      if (typeof params.fileData !== 'string' || !params.fileData) {
        throw new Error('browser_upload_image drop mode needs the file contents, which the MCP server attaches before the call leaves it. Retry, or name a file input with ref or selector.');
      }
      const result = await executeInTab(tab.id, dropFileAtPoint, [Number(params.x), Number(params.y), {
        name: params.fileName || '',
        mimeType: params.mimeType || '',
        data: params.fileData,
      }]);
      return { tabId: tab.id, uploaded: true, mode: 'drop', ...result };
    });
  }

  if (tool === 'browser_press_key') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    // A space-separated key is a sequence: "Tab Tab Enter" is three chords, and
    // a single token is one chord, which is what every call before this made.
    const chords = String(params.key || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => parseShortcutChord(token, null));
    if (chords.length === 0) {
      throw new Error('browser_press_key requires key.');
    }
    const repeat = clampInteger(params.repeat, 1, 100, 1);
    const dispatchCount = chords.length * repeat;
    if (dispatchCount > KEY_SEQUENCE_MAX_DISPATCHES) {
      throw new Error(`browser_press_key would dispatch ${dispatchCount} keys, above the ${KEY_SEQUENCE_MAX_DISPATCHES} cap. Shorten the sequence or lower repeat.`);
    }
    const keySelector = typeof params.selector === 'string' ? params.selector.trim() : '';
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'type',
      // With no selector the keystroke lands wherever the page has the caret, so
      // that is where the indicator belongs. A page with nothing focused matches
      // nothing and the animation is skipped.
      selector: keySelector || ':focus',
    }, async () => {
      const keyOptions = {
        defaultAction: params.defaultAction !== false,
        selector: keySelector,
      };
      if (chords.length === 1 && repeat === 1) {
        return await dispatchKeyInTab(tab.id, chords[0].key, chords[0].modifiers, keyOptions);
      }
      const dispatched = [];
      let last = null;
      for (let pass = 0; pass < repeat; pass += 1) {
        for (const chord of chords) {
          if (dispatched.length) {
            await new Promise((resolve) => setTimeout(resolve, KEY_SEQUENCE_GAP_MS));
          }
          last = await dispatchKeyInTab(tab.id, chord.key, chord.modifiers, keyOptions);
          dispatched.push(chord.name);
          if (last?.navigationTeardown === true) {
            // The frame the rest of the sequence would target is gone, so
            // stopping here is the honest answer rather than a run of errors.
            return { ...last, keys: dispatched, repeat, dispatchCount: dispatched.length, stoppedOnNavigation: true };
          }
        }
      }
      return { ...last, keys: dispatched, repeat, dispatchCount: dispatched.length };
    });
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
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'type',
      selector: ':focus',
    }, async () => {
      const result = await dispatchKeyInTab(tab.id, chord.key, chord.modifiers, {
        defaultAction: params.defaultAction !== false,
      });
      return { tabId: tab.id, dispatched: true, name: chord.name, ...result };
    });
  }

  if (tool === 'browser_scroll') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const scrollRef = typeof params.ref === 'string' ? params.ref.trim() : '';
    const scrollSelector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const scrollDirection = ['up', 'down', 'left', 'right'].includes(params.direction) ? params.direction : '';
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'scroll',
      selector: scrollRef ? '' : scrollSelector,
      ref: scrollRef,
      // A plain window scroll names no element, and the chevron still needs a
      // place to draw. This is the one caller that opts into the viewport
      // centre; every other one wants null so it can aim from its own result.
      fallback: 'viewport',
      ...(Number.isFinite(Number(params.atX)) && Number.isFinite(Number(params.atY))
        ? { x: Number(params.atX), y: Number(params.atY) }
        : {}),
      direction: scrollDirection || (Number(params.y || 0) < 0 ? 'up' : 'down'),
    }, async () => {
      if (scrollRef) {
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
      return await executeInTab(tab.id, scrollPage, [params.selector || '', params.x || 0, params.y || 0, {
        direction: scrollDirection,
        ...(Number.isFinite(Number(params.amount)) ? { amount: Number(params.amount) } : {}),
        ...(Number.isFinite(Number(params.atX)) ? { atX: Number(params.atX) } : {}),
        ...(Number.isFinite(Number(params.atY)) ? { atY: Number(params.atY) } : {}),
      }]);
    });
  }

  if (tool === 'browser_wait') {
    const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const urlContains = typeof params.urlContains === 'string' ? params.urlContains.trim() : '';
    const urlChanged = params.urlChanged === true;
    const rawDurationMs = Number(params.durationMs);
    // Clamped up to the schema minimum rather than dropped to zero. Batch
    // children get no schema validation, so durationMs: 10 used to fall through
    // to the no-predicate branch and fail with "browser_wait requires selector,
    // urlContains, urlChanged, or durationMs" on a call that plainly gave one,
    // which sent the caller looking for a parameter they had already supplied.
    const durationMs = Number.isFinite(rawDurationMs) && rawDurationMs > 0
      ? Math.min(30_000, Math.max(50, Math.floor(rawDurationMs)))
      : 0;
    if (!selector && !urlContains && !urlChanged && !durationMs) {
      throw new Error('browser_wait requires selector, urlContains, urlChanged, or durationMs.');
    }
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
      updateActive: false,
      persist: false,
    });
    const budgetMs = clampTimeoutMs(params.timeoutMs, 10_000, 120_000);
    const startedAt = Date.now();
    if (durationMs) {
      // A plain sleep, for the animation or transition that settles with no DOM
      // signal to wait on. The page is never touched.
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      if (!selector && !urlContains && !urlChanged) {
        return { tabId: tab.id, waited: durationMs };
      }
    }
    const waited = durationMs ? { waited: durationMs } : {};
    let navigation = null;
    if (urlContains || urlChanged) {
      navigation = await waitForTabUrl(tab.id, {
        urlContains,
        urlChanged,
        fromUrl: typeof params.fromUrl === 'string' ? params.fromUrl : '',
        timeoutMs: Math.max(500, budgetMs - (Date.now() - startedAt)),
      });
    }
    if (!selector) {
      return { tabId: tab.id, ...waited, ...navigation };
    }
    const remainingMs = Math.max(500, budgetMs - (Date.now() - startedAt));
    const found = await waitForSelectorViaAgent(tab.id, selector, {
      timeoutMs: remainingMs,
      visible: params.visible === true,
    });
    return navigation
      ? { ...found, tabId: tab.id, ...waited, navigation }
      : { ...found, ...waited };
  }

  if (tool === 'browser_resize') {
    const width = requirePositiveInteger(params.width, 'width');
    const height = requirePositiveInteger(params.height, 'height');
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: false,
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
    const result = await moveTabHistory(tab.id, 'back', clampTimeoutMs(params.timeoutMs));
    return { tabId: tab.id, ...result };
  }

  if (tool === 'browser_navigate_forward') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    const result = await moveTabHistory(tab.id, 'forward', clampTimeoutMs(params.timeoutMs));
    return { tabId: tab.id, ...result };
  }

  if (tool === 'browser_hover') {
    const { selector, ref } = requireSelectorOrRef(params, 'browser_hover');
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });
    invalidateTabReadCache(tab.id);
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'hover',
      selector,
      ref,
    }, async () => {
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
    });
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
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'select',
      selector,
      ref,
    }, async () => {
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
    });
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
    return await withCursorFeedback(tab.id, {
      sessionId,
      kind: 'type',
      selector: ref ? '' : (selector || ':focus'),
      ref,
    }, async () => {
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
        const pressed = await dispatchKeyInTab(tab.id, 'Enter', {}, {
          defaultAction: params.defaultAction !== false,
          selector: ref ? '' : selector,
        });
        return { tabId: tab.id, typed: true, length: text.length, submit: pressed };
      }
      return { tabId: tab.id, typed: true, length: text.length };
    });
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
        pushConsoleMessage(tab.id, { ...message, source: 'agent' });
      }
    } catch (error) {
      if (!useOneShotContentFallback(error)) {
        throw error;
      }
    }
    try {
      const pageResult = await executeInTab(tab.id, installAndReadPageConsole, [], { world: 'MAIN' });
      pageConsoleMirrors.add(tab.id);
      for (const message of pageResult?.messages || []) {
        pushConsoleMessage(tab.id, { ...message, source: 'page' });
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
    if (Object.prototype.hasOwnProperty.call(chrome.runtime.getManifest(), 'update_url')) {
      throw new Error(
        'browser_reload_extension is available only on unpacked developer installs. Use the Reload button on the options page, or chrome://extensions.',
      );
    }
    setTimeout(() => {
      chrome.runtime.reload();
    }, 250);
    return { ok: true, reloading: true };
  }

  if (tool === 'browser_cursor') {
    const installDefault = await (async () => {
      try {
        const config = await loadBridgeConfig();
        return config.cursorOverlay !== false;
      } catch {
        return true;
      }
    })();
    if (typeof params.enabled === 'boolean') {
      cursorSessionOverrides.set(sessionId, params.enabled === true);
    }
    const hasOverride = cursorSessionOverrides.has(sessionId);
    let tabId = null;
    if (params.tabId !== undefined && params.tabId !== null) {
      const tab = await getOrCreateSessionTab(sessionId, {
        tabId: params.tabId,
        createIfMissing: false,
        activate: params.activate === true,
        updateActive: false,
        persist: false,
      });
      tabId = tab.id;
      if (hasOverride && cursorSessionOverrides.get(sessionId) !== true) {
        await executeInTab(tab.id, umbraCursorDrive, [{ op: 'hide' }]).catch(() => {});
      }
    }
    return {
      sessionId,
      enabled: hasOverride ? cursorSessionOverrides.get(sessionId) === true : installDefault,
      source: hasOverride ? 'session' : 'install',
      installDefault,
      ...(tabId === null ? {} : { tabId }),
    };
  }

  if (tool === 'browser_gif') {
    const action = String(params.action || '').trim();
    if (!['start', 'stop', 'export', 'clear', 'status'].includes(action)) {
      throw new Error('browser_gif action must be start, stop, export, clear or status.');
    }
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
    });

    const describe = (state) => {
      const durationMs = state ? (state.stoppedAt || Date.now()) - state.startedAt : 0;
      return {
        tabId: tab.id,
        recording: state?.recording === true,
        frameCount: state?.frameCount || 0,
        droppedFrames: state?.droppedFrames || 0,
        failedCaptures: state?.failedCaptures || 0,
        skippedFrames: state?.skippedFrames || 0,
        truncatedFrames: state?.truncatedFrames === true,
        fps: state?.fps ?? null,
        // Frames a second the tab actually delivered. A slow page cannot hold
        // the requested rate, and the pacing lets it fall rather than queue
        // captures that get dropped, so this is the number the export has.
        effectiveFps: state && durationMs > 0
          ? Math.round(((state.frameCount || 0) / (durationMs / 1000)) * 100) / 100
          : null,
        maxFrames: state?.maxFrames ?? null,
        maxWidth: state?.maxWidth ?? null,
        durationMs,
      };
    };

    if (action === 'start') {
      if (gifRecordings.get(tab.id)?.recording === true) {
        throw new Error('A recording is already running on this tab. Stop it before starting another.');
      }
      await discardGifRecording(tab.id);

      const fps = clampNumber(params.fps, GIF_MIN_FPS, GIF_MAX_FPS, GIF_DEFAULT_FPS);
      const maxFrames = clampInteger(params.maxFrames, GIF_MIN_MAX_FRAMES, GIF_MAX_MAX_FRAMES, GIF_DEFAULT_MAX_FRAMES);
      const maxWidth = clampInteger(params.maxWidth, GIF_MIN_MAX_WIDTH, GIF_MAX_MAX_WIDTH, GIF_DEFAULT_MAX_WIDTH);
      // Frame metadata arrives in CSS pixels while the capture is in device
      // pixels, so the ratio is read once per recording rather than once per
      // frame. An unreadable page keeps 1, which only costs overlay precision.
      const dpr = await executeInTab(tab.id, () => window.devicePixelRatio || 1).catch(() => 1);

      // Hold the attachment for the whole recording instead of letting each
      // capture attach and detach at the frame rate.
      const { handle: pinHandle } = await pinTabDebugger(tab.id);

      const state = {
        sessionId,
        startedAt: Date.now(),
        stoppedAt: null,
        stopReason: null,
        recording: true,
        pinned: true,
        pinHandle,
        fps,
        maxFrames,
        maxWidth,
        dpr: Number.isFinite(Number(dpr)) ? Number(dpr) : 1,
        intervalId: null,
        watchdogId: null,
        frameIntervalMs: Math.round(1000 / fps),
        lastCaptureMs: 0,
        capturing: false,
        pendingActionMeta: null,
        frameCount: 0,
        droppedFrames: 0,
        failedCaptures: 0,
        skippedFrames: 0,
        truncatedFrames: false,
      };
      gifRecordings.set(tab.id, state);
      await persistGifRecordings();

      try {
        // The opening frame is captured here rather than through the pump
        // because this is the one capture whose failure should reach the
        // caller: a tab that cannot be captured at all should fail start rather
        // than record nothing and fail at export. captureSilentScreenshot is
        // the capture path for every frame, chosen over the visible-tab capture
        // API because it leaves the tab in the background and Chrome does not
        // throttle it to roughly two calls a second.
        const opening = await captureSilentScreenshot(tab, { format: 'png', fullPage: false });
        await pushGifFrame(tab.id, opening.dataUrl, { kind: 'start', label: 'Recording started' });
      } catch (error) {
        await discardGifRecording(tab.id);
        throw error;
      }

      scheduleGifTick(tab.id);
      state.watchdogId = setTimeout(() => {
        void stopGifRecording(tab.id, 'watchdog');
      }, MAX_RECORDING_MS);

      return { ...describe(state), started: true, maxRecordingMs: MAX_RECORDING_MS };
    }

    if (action === 'stop') {
      const state = await stopGifRecording(tab.id, 'stop');
      if (!state) {
        throw new Error('No recording on this tab. Start one before stopping it.');
      }
      return { ...describe(state), stopped: true };
    }

    if (action === 'clear') {
      const had = gifRecordings.has(tab.id);
      await discardGifRecording(tab.id);
      return { tabId: tab.id, cleared: true, hadRecording: had };
    }

    if (action === 'status') {
      const state = gifRecordings.get(tab.id) || null;
      let buffered = null;
      try {
        const response = await sendOffscreenMessage({ type: 'gif_status', tabId: tab.id });
        buffered = {
          frameCount: response.frameCount,
          droppedFrames: response.droppedFrames,
          truncatedFrames: response.truncatedFrames === true,
        };
      } catch {
        // The buffer lives elsewhere; a document that is gone reports nothing
        // rather than turning a status read into an error.
      }
      return { ...describe(state), buffered };
    }

    // export
    const state = await stopGifRecording(tab.id, 'export');
    const response = await sendOffscreenMessage({
      type: 'gif_export',
      tabId: tab.id,
      quality: clampInteger(params.quality, GIF_MIN_QUALITY, GIF_MAX_QUALITY, GIF_DEFAULT_QUALITY),
      overlays: params.overlays !== false,
      watermark: typeof params.watermark === 'string' ? params.watermark.slice(0, 40) : GIF_DEFAULT_WATERMARK,
      fps: state?.fps ?? GIF_DEFAULT_FPS,
    });
    return {
      tabId: tab.id,
      data: response.data,
      mimeType: 'image/gif',
      bytes: response.bytes,
      frameCount: response.frameCount,
      droppedFrames: response.droppedFrames ?? (state?.droppedFrames || 0),
      failedCaptures: state?.failedCaptures || 0,
      truncatedFrames: response.truncatedFrames === true,
      durationMs: response.durationMs ?? 0,
      fps: state?.fps ?? GIF_DEFAULT_FPS,
      width: response.width ?? null,
      height: response.height ?? null,
    };
  }

  if (tool === 'browser_read_network_requests') {
    const tab = await getOrCreateSessionTab(sessionId, {
      tabId: params.tabId ?? null,
      createIfMissing: false,
      activate: params.activate === true,
      updateActive: false,
      persist: false,
    });
    const filter = {
      urlPattern: typeof params.urlPattern === 'string' ? params.urlPattern.slice(0, 300) : '',
      types: Array.isArray(params.types) ? params.types : null,
      limit: clampInteger(params.limit, 1, 300, 50),
    };

    if (params.stop === true) {
      // The final read: hand back what the buffer holds, then release the
      // attachment so the tab loses its automation banner.
      const requests = filterNetworkEntries(tab.id, filter);
      const stopped = await stopNetworkLog(tab.id, 'stop');
      return {
        tabId: tab.id,
        capturing: false,
        stopped,
        requests,
        count: requests.length,
      };
    }

    const { log, started } = await startNetworkLog(tab.id, sessionId);
    const requests = filterNetworkEntries(tab.id, filter);
    const cleared = params.clear === true ? clearNetworkLog(tab.id) : 0;
    return {
      tabId: tab.id,
      capturing: true,
      startedCapture: started,
      requests,
      count: requests.length,
      buffered: log.entries.length,
      droppedEntries: log.droppedEntries,
      ...(params.clear === true ? { cleared } : {}),
      ...(started
        ? {
          note: 'Logging started with this call, so the log is usually empty. Act on the page and read again.',
        }
        : {}),
    };
  }

  throw new Error(`Unsupported tool: ${tool}`);
}

function isTrustedExtensionSender(sender) {
  const extensionId = chrome.runtime.id;
  if (!sender || (sender.id && sender.id !== extensionId)) {
    return false;
  }
  const origin = String(sender.origin || '');
  const url = String(sender.url || '');
  const extensionOrigin = `chrome-extension://${extensionId}`;
  return origin === extensionOrigin || url.startsWith(`${extensionOrigin}/`);
}

// Toolbar icon color-scheme switching. Stable Chrome has no declarative
// icon_variants, so the offscreen document reports prefers-color-scheme and
// the worker swaps between the dark-glyph set (light toolbars) and the
// white-glyph set (dark toolbars). Reapplied from storage on worker boot
// because setIcon does not survive a service worker restart.
const TOOLBAR_ICON_PATHS = {
  light: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  dark: { 16: 'icons/icon16-dark.png', 32: 'icons/icon32-dark.png', 48: 'icons/icon48-dark.png', 128: 'icons/icon128-dark.png' },
};
let toolbarIconIsDark = null;

async function applyToolbarIconScheme(dark) {
  if (toolbarIconIsDark === dark) {
    return;
  }
  toolbarIconIsDark = dark;
  await chrome.action.setIcon({ path: dark ? TOOLBAR_ICON_PATHS.dark : TOOLBAR_ICON_PATHS.light });
}

void chrome.storage.local.get('toolbarColorScheme')
  .then(({ toolbarColorScheme }) => (toolbarColorScheme ? applyToolbarIconScheme(toolbarColorScheme === 'dark') : undefined))
  .catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted_sender' });
    return false;
  }
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
        cursorSessionOverrides.delete(message.sessionId);
        await discardSessionGifRecordings(message.sessionId);
        await stopSessionNetworkLogs(message.sessionId);
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
      case 'bridge_color_scheme': {
        const dark = message.dark === true;
        await chrome.storage.local.set({ toolbarColorScheme: dark ? 'dark' : 'light' });
        await applyToolbarIconScheme(dark);
        return { ok: true };
      }
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
  pageConsoleMirrors.delete(tabId);
  invalidateCursorOverlay(tabId);
  // A recording on a closed tab has nothing left to capture, and its pin would
  // otherwise hold a debugger attachment on a target that no longer exists.
  await stopGifRecording(tabId, 'tab_removed');
  await discardGifRecording(tabId);
  // Same reason as the recording above: a request log on a closed tab has
  // nothing left to observe and its pin would hold an attachment on a target
  // that no longer exists.
  await stopNetworkLog(tabId, 'tab_removed');
  invalidateContentAgent(tabId, 'tab_removed');
  if (sessionStore.releaseTab(tabId)) {
    await sessionStore.persist();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.url) {
    markConsoleNavigation(tabId);
    // The mirror lives on a MAIN-world global that the new document does not
    // carry, so a stale flag would suppress reinstallation for the rest of the
    // tab's life.
    pageConsoleMirrors.delete(tabId);
    // The request log is not touched here. A move to a different hostname still
    // drops it, but off the new document's own Network.requestWillBeSent, which
    // arrives before this event and before the row that document produced.
  }
  if (changeInfo?.url || changeInfo?.status === 'loading') {
    invalidateContentAgent(tabId, 'navigation');
    // A new document carries no overlay, so the memo has to go with it or the
    // next action would skip the injection and animate nothing.
    invalidateCursorOverlay(tabId);
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
      // Once per worker lifetime, before any command is served. The recordings
      // come back from session storage so stop, status and export answer against
      // the frames the offscreen document still holds, and any debugger
      // attachment left behind by the worker that died is detached, which is
      // what takes Chrome's automation banner back off the tab.
      await rehydrateGifRecordings();
      await releaseOrphanedTabDebuggers();
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

  // A worker evicted mid-recording loses its interval and its watchdog timer, so
  // this minute alarm is the last thing that can notice an overrun recording and
  // release its debugger attachment. It reads the live map, which initialize()
  // has already refilled from chrome.storage.session on a resurrected worker;
  // before that rehydration existed this loop ran over an empty map and could
  // never fire.
  initialize('alarm')
    .then(() => {
      for (const [tabId, state] of [...gifRecordings.entries()]) {
        if (state.recording === true && Date.now() - state.startedAt > MAX_RECORDING_MS) {
          void stopGifRecording(tabId, 'watchdog');
        }
      }
    })
    .catch((error) => console.error('[bridge] alarm init failed', error));
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

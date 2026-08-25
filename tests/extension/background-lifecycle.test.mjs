import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const manifestPath = path.join(repoRoot, 'extension', 'manifest.json');
const backgroundPath = path.join(repoRoot, 'extension', 'background.js');

describe('extension bridge lifecycle', () => {
  it('uses alarms to wake the MV3 worker and recreate the offscreen scanner', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const background = fs.readFileSync(backgroundPath, 'utf8');

    assert.ok(manifest.permissions.includes('alarms'));
    assert.match(background, /BRIDGE_WAKE_ALARM_NAME/);
    assert.match(background, /chrome\.alarms\.create\(BRIDGE_WAKE_ALARM_NAME/);
    assert.match(background, /chrome\.alarms\?\.onAlarm\.addListener/);
    assert.match(background, /ensureOffscreenDocument\(\)/);
    assert.match(background, /case 'bridge_session_disconnected': \{/);
    assert.match(background, /sessionStore\.markDisconnected\(message\.sessionId\)/);
  });

  it('deduplicates initialize calls so reconnect wakes do not stack setup work', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');

    assert.match(background, /let initializePromise = null/);
    assert.match(background, /if \(initializePromise\)/);
    assert.match(background, /initializePromise = \(async \(\) =>/);
    assert.match(background, /finally \{\n    initializePromise = null;/);
  });

  it('expires stale offscreen socket states before reconnecting to a port', () => {
    const offscreen = fs.readFileSync(path.join(repoRoot, 'extension', 'offscreen.js'), 'utf8');

    assert.match(offscreen, /CONNECTING_TIMEOUT_MS/);
    assert.match(offscreen, /UNAUTHENTICATED_OPEN_TIMEOUT_MS/);
    assert.match(offscreen, /function closeExpiredConnection/);
    assert.match(offscreen, /closeExpiredConnection\(port, connection, now\)/);
    assert.match(offscreen, /bridge_resync_now/);
  });

  it('scans offscreen ports in adaptive batches and throttles unchanged status writes', () => {
    const offscreen = fs.readFileSync(path.join(repoRoot, 'extension', 'offscreen.js'), 'utf8');

    assert.match(offscreen, /IDLE_SCAN_PORT_BUDGET = 8/);
    assert.match(offscreen, /CONNECTED_SCAN_PORT_BUDGET = 8/);
    assert.match(offscreen, /STATUS_UPDATE_MIN_INTERVAL_MS/);
    assert.match(offscreen, /HEARTBEAT_MIN_INTERVAL_MS/);
    assert.match(offscreen, /function selectPortsForScan/);
    assert.match(offscreen, /forceFullScan/);
    assert.match(offscreen, /statusSignature/);
    assert.match(offscreen, /lastStatusSignature/);
    assert.match(offscreen, /throttleKey: 'socket_error'/);
  });

  it('supports protocol v2 broker routing without claiming the broker as a browser session', () => {
    const offscreen = fs.readFileSync(path.join(repoRoot, 'extension', 'offscreen.js'), 'utf8');

    assert.match(offscreen, /state\.isBroker = message\.broker === true \|\| Number\(message\.protocolVersion\) >= 2/);
    assert.match(offscreen, /const commandSessionId = String\(message\.sessionId \|\| state\.sessionId \|\| ''\)/);
    assert.match(offscreen, /sessionId: commandSessionId/);
    assert.match(offscreen, /message\.type === 'session_disconnected'/);
    assert.match(offscreen, /if \(!state\.isBroker\) \{/);
    assert.match(offscreen, /if \(sessionId && !state\.isBroker\) \{/);
  });

  it('uses a slower fallback poll while waiting so fast loads cannot miss the complete event', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');

    assert.match(background, /async function waitForTabComplete/);
    assert.match(background, /function tabUrlMatchesExpected/);
    assert.match(background, /TAB_COMPLETE_POLL_INTERVAL_MS = 750/);
    assert.match(background, /const poll = setInterval/);
    assert.match(background, /safeGetTab\(tabId\)/);
    assert.match(background, /tabUrlMatchesExpected\(url, expectedUrl\) \|\| url !== preNavUrl/);
    assert.match(background, /arrived\(tab\.url \|\| ''\)/);
    assert.match(background, /clearInterval\(poll\)/);
  });

  it('routes new session tabs into an existing Chrome window instead of creating a second one', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');

    assert.match(background, /DEDICATED_WINDOW_STORAGE_KEY = 'bridgeDedicatedWindowId'/);
    assert.match(background, /async function findBackgroundWindowId/);
    assert.match(background, /chrome\.windows\.getAll\(\{ windowTypes: \['normal'\] \}\)/);
    assert.match(background, /await rememberDedicatedWindowId\(createdWindow\.id\)/);
    assert.match(background, /chrome\.tabs\.create\(\{ url, active: Boolean\(activate\), windowId \}\)/);
    assert.match(background, /chrome\.windows\.onRemoved\?\.addListener/);
    assert.doesNotMatch(background, /avoidFocused/);
    assert.doesNotMatch(background, /state: activate \? 'normal' : 'minimized'/);
    assert.match(background, /state: 'normal'/);
  });

  it('refuses to put session tabs in a focused window, including the stored one', async () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('async function findBackgroundWindowId');
    const end = background.indexOf('async function createDedicatedWindowWithTab');
    const block = background.slice(start, end);
    assert.ok(start >= 0);
    assert.ok(end > start);

    // README, docs/architecture.md and store/description.txt all promise this,
    // so it is exercised rather than asserted as a source pattern.
    const run = (windows, storedId) => new Function(
      'getStoredDedicatedWindowId',
      'getNormalWindow',
      'clearDedicatedWindowId',
      'listNormalWindows',
      'rememberDedicatedWindowId',
      `${block};return findBackgroundWindowId;`,
    )(
      async () => storedId,
      async (id) => windows.find((window) => window.id === id) || null,
      async () => {},
      async () => windows,
      async () => {},
    )();

    assert.equal(await run([{ id: 7, focused: true }], 7), null, 'a focused stored window was reused');
    assert.equal(await run([{ id: 7, focused: true }], null), null, 'the only window was focused and got reused');
    assert.equal(await run([{ id: 7, focused: false }], 7), 7, 'an unfocused stored window must still be reused');
    assert.equal(
      await run([{ id: 7, focused: true }, { id: 8, focused: false }], null),
      8,
      'an unfocused window should be preferred over the focused one',
    );
  });

  it('never groups or moves tabs through a non-normal window', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const groupStart = background.indexOf('async function groupTabsInNormalWindow');
    const groupEnd = background.indexOf('async function groupSessionTabs');
    const groupBlock = background.slice(groupStart, groupEnd);
    const ensureStart = background.indexOf('async function ensureSessionGroup');
    const ensureEnd = background.indexOf('function normalizeTabIdList');
    const ensureBlock = background.slice(ensureStart, ensureEnd);
    const createStart = background.indexOf('async function createSessionTab');
    const createEnd = background.indexOf('async function getOrCreateSessionTab');
    const createBlock = background.slice(createStart, createEnd);
    const dedicatedStart = background.indexOf('async function createDedicatedWindowWithTab');
    const dedicatedEnd = background.indexOf('async function createSessionTab');
    const dedicatedBlock = background.slice(dedicatedStart, dedicatedEnd);

    assert.ok(groupStart >= 0, 'groupTabsInNormalWindow should exist');
    assert.match(background, /function isNormalWindow/);
    assert.match(background, /function isNonNormalWindowError/);
    assert.match(background, /async function getNormalWindow/);
    assert.match(background, /async function listNormalWindows/);
    assert.match(groupBlock, /createProperties: \{ windowId:/);
    assert.match(groupBlock, /getNormalWindow/);
    assert.match(groupBlock, /isNonNormalWindowError/);
    assert.match(ensureBlock, /groupTabsInNormalWindow/);
    assert.match(ensureBlock, /isNonNormalWindowError/);
    assert.doesNotMatch(ensureBlock, /chrome\.tabs\.group/);
    assert.match(createBlock, /getNormalWindow\(tab\.windowId\)/);
    assert.match(createBlock, /createDedicatedWindowWithTab/);
    assert.match(dedicatedBlock, /isNormalWindow\(createdWindow\)/);
    assert.doesNotMatch(background, /chrome\.tabs\.move\(/);
  });

  it('refuses chrome.windows.create unless allowForeground is true', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const dedicatedStart = background.indexOf('async function createDedicatedWindowWithTab');
    const dedicatedEnd = background.indexOf('async function createSessionTab');
    const dedicatedBlock = background.slice(dedicatedStart, dedicatedEnd);
    const createStart = background.indexOf('async function createSessionTab');
    const createEnd = background.indexOf('async function getOrCreateSessionTab');
    const createBlock = background.slice(createStart, createEnd);

    assert.ok(dedicatedStart >= 0, 'createDedicatedWindowWithTab should exist');
    assert.ok(createStart > dedicatedStart, 'createSessionTab should follow createDedicatedWindowWithTab');

    const guardIdx = dedicatedBlock.indexOf('assertChromeWindowCreateAllowed');
    const createIdx = dedicatedBlock.indexOf('await chrome.windows.create(');
    assert.ok(guardIdx >= 0, 'createDedicatedWindowWithTab must call the allowForeground guard');
    assert.ok(createIdx > guardIdx, 'windows.create must not run before the allowForeground guard');
    assert.match(dedicatedBlock, /focused: false/);
    assert.doesNotMatch(dedicatedBlock, /getLastFocused/);

    const newWindowIdx = createBlock.indexOf('if (newWindow === true)');
    const newWindowGuard = createBlock.indexOf('assertChromeWindowCreateAllowed({ newWindow: true, allowForeground })');
    assert.ok(newWindowIdx >= 0, 'createSessionTab must branch on newWindow');
    assert.ok(newWindowGuard > newWindowIdx, 'newWindow must assert before creating a window');
    assert.doesNotMatch(createBlock, /chrome\.windows\.create\(/);
    assert.equal([...background.matchAll(/chrome\.windows\.create\(/g)].length, 1, 'windows.create must exist in exactly one place');
  });

  it('throws a clear error for newWindow or a first Chrome window without allowForeground', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('const MACOS_NEW_WINDOW_FOCUS_STEAL');
    const end = background.indexOf('async function createDedicatedWindowWithTab');
    assert.ok(start >= 0, 'MACOS_NEW_WINDOW_FOCUS_STEAL should exist');
    assert.ok(end > start, 'window-create guard should sit before createDedicatedWindowWithTab');
    const fn = new Function(`${background.slice(start, end)}; return { assertChromeWindowCreateAllowed, MACOS_NEW_WINDOW_FOCUS_STEAL, MACOS_WINDOW_CREATE_FOCUS_STEAL };`)();

    assert.throws(
      () => fn.assertChromeWindowCreateAllowed({ newWindow: true, allowForeground: false }),
      (error) => error.message === fn.MACOS_NEW_WINDOW_FOCUS_STEAL,
    );
    assert.throws(
      () => fn.assertChromeWindowCreateAllowed({ newWindow: false, allowForeground: false }),
      (error) => error.message === fn.MACOS_WINDOW_CREATE_FOCUS_STEAL,
    );
    assert.doesNotThrow(() => fn.assertChromeWindowCreateAllowed({ newWindow: true, allowForeground: true }));
    assert.doesNotThrow(() => fn.assertChromeWindowCreateAllowed({ newWindow: false, allowForeground: true }));
    assert.match(fn.MACOS_NEW_WINDOW_FOCUS_STEAL, /newWindow would steal OS focus on macOS/);
    assert.match(fn.MACOS_NEW_WINDOW_FOCUS_STEAL, /allowForeground/);
    assert.match(fn.MACOS_WINDOW_CREATE_FOCUS_STEAL, /Creating a Chrome window would steal OS focus on macOS/);
    assert.doesNotMatch(fn.MACOS_NEW_WINDOW_FOCUS_STEAL, /\u2014|\u2013|--/);
    assert.doesNotMatch(fn.MACOS_WINDOW_CREATE_FOCUS_STEAL, /\u2014|\u2013|--/);
  });

  it('undoes macOS focus steals from tab create, group, debugger attach, trusted click, and close', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const helperStart = background.indexOf('function shouldUnfocusStolenWindow');
    const helperEnd = background.indexOf('async function activateOwnedTab');
    assert.ok(helperStart >= 0, 'shouldUnfocusStolenWindow should exist');
    assert.ok(helperEnd > helperStart, 'focus-steal helpers should sit before activateOwnedTab');
    const helpers = new Function(
      `${background.slice(helperStart, helperEnd)}; return { shouldUnfocusStolenWindow, shouldRestoreStolenActiveTab, shouldUndoDownloadFocusSteal, serializeDownloadFocusGuards, deserializeDownloadFocusGuard, normalizeLastFocus, serializeLastFocus, deserializeLastFocus };`,
    )();

    assert.equal(
      helpers.shouldUnfocusStolenWindow({ focused: false }, true, false),
      true,
      'a previously unfocused window that became focused must be unfocused',
    );
    assert.equal(
      helpers.shouldUnfocusStolenWindow({ focused: true }, true, false),
      false,
      'do not background a window Robert was already using',
    );
    assert.equal(
      helpers.shouldUnfocusStolenWindow({ focused: false }, true, true),
      false,
      'allowForeground may keep the raised window',
    );
    assert.equal(
      helpers.shouldUnfocusStolenWindow({ focused: false }, false, false),
      false,
      'an unfocused window that stayed unfocused needs no undo',
    );
    assert.equal(
      helpers.shouldRestoreStolenActiveTab({ focused: true, activeTabId: 3 }, 9, false, true),
      true,
      'grouping in Robert’s focused window must give him his tab back',
    );
    assert.equal(
      helpers.shouldRestoreStolenActiveTab({ focused: false, activeTabId: 3 }, 9, false, true),
      false,
      'restoring an active tab in an unfocused window would itself raise Chrome',
    );

    const stealGuard = {
      undone: false,
      snapshot: { windowId: 7, focused: false, activeTabId: 3 },
    };
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealGuard, 7, -1),
      true,
      'download bubble raising Chrome from another app must undo',
    );
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealGuard, 7, 8),
      false,
      'switching between Chrome windows is not a download steal',
    );
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal({ ...stealGuard, snapshot: { windowId: 7, focused: true, activeTabId: 3 } }, 7, -1),
      false,
      'do not unfocus a window Robert was already using',
    );
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal({ ...stealGuard, undone: true }, 7, -1),
      false,
      'one undo only',
    );
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealGuard, -1, -1),
      false,
      'WINDOW_ID_NONE is Chrome losing focus, not a steal',
    );
    const serialized = helpers.serializeDownloadFocusGuards(new Map([[9, { ...stealGuard, downloadPath: '/tmp', armedAt: 1 }]]));
    assert.deepEqual(serialized['9'], {
      windowId: 7,
      focused: false,
      activeTabId: 3,
      downloadPath: '/tmp',
      armedAt: 1,
      undone: false,
    });
    assert.equal(helpers.deserializeDownloadFocusGuard(serialized['9']).pinHandle, null);
    assert.equal(helpers.deserializeDownloadFocusGuard(serialized['9']).snapshot.windowId, 7);

    const createStart = background.indexOf('async function createSessionTab');
    const createEnd = background.indexOf('async function getOrCreateSessionTab');
    const createBlock = background.slice(createStart, createEnd);
    assert.match(createBlock, /snapshotWindowChromeState\(windowId\)/);
    assert.match(createBlock, /restoreWindowChromeStateIfStolen\(snapshot/);
    assert.match(createBlock, /restoreActiveTab: activate !== true/);
    assert.doesNotMatch(createBlock, /if \(activate && !allowForeground && !wasFocused\)/);

    const trustedClickStart = background.indexOf('async function dispatchTrustedMouseClick');
    const trustedClickEnd = background.indexOf('function trustedClickPointFromRect');
    const trustedClick = background.slice(trustedClickStart, trustedClickEnd);
    const allowIdx = trustedClick.indexOf('if (allowForeground)');
    const bringIdx = trustedClick.indexOf('Page.bringToFront');
    assert.ok(allowIdx >= 0 && bringIdx > allowIdx, 'Page.bringToFront is allowForeground-only');
    assert.match(trustedClick, /Emulation\.setFocusEmulationEnabled/);
    assert.match(trustedClick, /withOwnedTabDebugger\(tabId, async \(target\) => \{/);
    assert.match(trustedClick, /, \{ allowForeground \}\);/);
    assert.match(trustedClick, /trustedClickPointFromQuads\(quad, hit\)/);
    assert.match(trustedClick, /options\.hit === 'radio'/);

    const debuggerStart = background.indexOf('async function withOwnedTabDebugger');
    const debuggerEnd = background.indexOf('async function pinTabDebugger');
    const debuggerBlock = background.slice(debuggerStart, debuggerEnd);
    assert.match(debuggerBlock, /snapshotWindowChromeState\(liveTab\?\.windowId\)/);
    assert.match(debuggerBlock, /restoreWindowChromeStateIfStolen\(snapshot/);

    const groupStart = background.indexOf('async function groupTabsInNormalWindow');
    const groupEnd = background.indexOf('async function groupSessionTabs');
    assert.match(background.slice(groupStart, groupEnd), /restoreWindowChromeStateIfStolen\(snapshot, \{ restoreActiveTab: true \}\)/);

    const closeStart = background.indexOf('async function closeOwnedSessionWindows');
    const closeEnd = background.indexOf('async function closeSessionTabs');
    assert.match(background.slice(closeStart, closeEnd), /restoreWindowChromeStateIfStolen\(snapshot, \{ restoreActiveTab: false \}\)/);

    const downloadGuard = background.slice(
      background.indexOf('async function handleDownloadFocusEvent'),
      background.indexOf('async function dispatchTrustedMouseClick'),
    );
    assert.match(downloadGuard, /guard\.undone !== true/);
    assert.doesNotMatch(downloadGuard, /setTimeout/);
    assert.match(background, /DOWNLOAD_FOCUS_GUARD_ALARM_PREFIX/);
    assert.match(background, /releaseSilentDownloadGuard\(tabId\)/);
    assert.match(background, /chrome\.windows\?\.onFocusChanged\?\.addListener/);
    assert.match(background, /handleDownloadFocusWindowChanged/);
    assert.match(background, /DOWNLOAD_FOCUS_STORAGE_KEY/);
    assert.match(background, /await rehydrateDownloadFocusGuards\(\)/);
    const detachStart = background.indexOf('chrome.debugger?.onDetach?.addListener');
    const detachEnd = background.indexOf('const CDP_CONSOLE_LEVELS');
    const detachBlock = background.slice(detachStart, detachEnd);
    assert.match(detachBlock, /guard\.pinHandle = null/);
    assert.doesNotMatch(detachBlock, /forgetSilentDownloadGuard\(source\.tabId\)/);

    const activateStart = background.indexOf('async function activateOwnedTab');
    const activateEnd = background.indexOf('const MACOS_NEW_WINDOW_FOCUS_STEAL');
    const activateBlock = background.slice(activateStart, activateEnd);
    assert.match(activateBlock, /snapshotWindowChromeState\(tab\.windowId\)/);
    assert.doesNotMatch(activateBlock, /if \(!allowForeground && tab\.windowId != null\) \{\n    await chrome\.windows\.update\(tab\.windowId, \{ focused: false \}\)/);
  });

  it('does not undo a download-bubble steal when LastFocus provenance is unknown', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const helperStart = background.indexOf('function shouldUnfocusStolenWindow');
    const helperEnd = background.indexOf('async function activateOwnedTab');
    const helpers = new Function(
      `${background.slice(helperStart, helperEnd)}; return { shouldUndoDownloadFocusSteal };`,
    )();
    const stealGuard = {
      undone: false,
      snapshot: { windowId: 7, focused: false, activeTabId: 3 },
    };
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealGuard, 7, { kind: 'unknown' }),
      false,
      'unknown provenance must not unfocus a window a human or another session just focused after worker restart',
    );
  });

  it('treats LastFocus none as the steal trigger and window as an in-Chrome switch', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const helperStart = background.indexOf('function shouldUnfocusStolenWindow');
    const helperEnd = background.indexOf('async function activateOwnedTab');
    const helpers = new Function(
      `${background.slice(helperStart, helperEnd)}; return { shouldUndoDownloadFocusSteal };`,
    )();
    const stealGuard = {
      undone: false,
      snapshot: { windowId: 7, focused: false, activeTabId: 3 },
    };
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealGuard, 7, { kind: 'none' }),
      true,
      'none means Chrome was not the focused app and the download bubble steal must undo',
    );
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealGuard, 7, { kind: 'window', id: 8 }),
      false,
      'a focused Chrome window is not a download steal',
    );
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealGuard, 7, -1),
      true,
      'numeric WINDOW_ID_NONE must still undo',
    );
  });

  it('keeps download-focus guards per-tab across concurrent windows', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const helperStart = background.indexOf('function shouldUnfocusStolenWindow');
    const helperEnd = background.indexOf('async function activateOwnedTab');
    const helpers = new Function(
      `${background.slice(helperStart, helperEnd)}; return { shouldUndoDownloadFocusSteal };`,
    )();
    const stealOnSeven = {
      undone: false,
      snapshot: { windowId: 7, focused: false, activeTabId: 3 },
    };
    const stealOnNine = {
      undone: false,
      snapshot: { windowId: 9, focused: false, activeTabId: 4 },
    };
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealOnSeven, 7, { kind: 'none' }),
      true,
      'the session whose unfocused window was raised may undo',
    );
    assert.equal(
      helpers.shouldUndoDownloadFocusSteal(stealOnNine, 7, { kind: 'none' }),
      false,
      'a concurrent session in another window must not unfocus this steal',
    );
  });

  it('round-trips LastFocus through serialize and deserialize including unknown', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const helperStart = background.indexOf('function shouldUnfocusStolenWindow');
    const helperEnd = background.indexOf('async function activateOwnedTab');
    const helpers = new Function(
      `${background.slice(helperStart, helperEnd)}; return { normalizeLastFocus, serializeLastFocus, deserializeLastFocus };`,
    )();
    assert.deepEqual(helpers.normalizeLastFocus(-1), { kind: 'none' });
    assert.deepEqual(helpers.normalizeLastFocus(8), { kind: 'window', id: 8 });
    assert.deepEqual(helpers.normalizeLastFocus(null), { kind: 'unknown' });
    assert.deepEqual(helpers.normalizeLastFocus(undefined), { kind: 'unknown' });
    for (const focus of [{ kind: 'unknown' }, { kind: 'none' }, { kind: 'window', id: 7 }]) {
      assert.deepEqual(helpers.deserializeLastFocus(helpers.serializeLastFocus(focus)), focus);
    }
    assert.deepEqual(helpers.deserializeLastFocus(null), { kind: 'unknown' });
    assert.deepEqual(helpers.deserializeLastFocus(undefined), { kind: 'unknown' });
  });

  it('restores window chrome after close_tab, cleanupGroups, and markDebugGroup', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const usesFocusContract = (block, label) => {
      const ok = /withWindowFocusContract/.test(block)
        || (/snapshotWindowChromeState/.test(block) && /restoreWindowChromeStateIfStolen/.test(block));
      assert.ok(ok, `${label} must restore window focus after the mutation`);
    };

    const closeStart = background.indexOf("if (tool === 'browser_close_tab')");
    const closeNext = background.indexOf('\n  if (tool ===', closeStart + 1);
    usesFocusContract(background.slice(closeStart, closeNext), 'browser_close_tab');

    const cleanupStart = background.indexOf('async function cleanupGroups');
    const cleanupEnd = background.indexOf('async function closeOwnedSessionWindows');
    usesFocusContract(background.slice(cleanupStart, cleanupEnd), 'cleanupGroups');

    const markStart = background.indexOf('async function markDebugGroup');
    const markEnd = background.indexOf('async function executeInTab');
    usesFocusContract(background.slice(markStart, markEnd), 'markDebugGroup');
  });

  it('persists LastFocus on every focus-changed event including WINDOW_ID_NONE', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('async function handleDownloadFocusWindowChanged');
    const end = background.indexOf('async function applySilentDownloadBehavior');
    const changed = background.slice(start, end);
    assert.ok(start >= 0 && end > start, 'handleDownloadFocusWindowChanged should sit before applySilentDownloadBehavior');
    assert.match(changed, /lastFocus = \{ kind: 'none' \}/);
    assert.match(changed, /await persistDownloadFocusGuards\(\)/);
    assert.match(changed, /finally \{/);
    assert.doesNotMatch(changed, /if \(undid\)/);
    assert.match(background, /FOCUS_APP_STORAGE_KEY = 'umbraFocusApp'/);
    assert.match(background, /DOWNLOAD_FOCUS_STORAGE_KEY = 'downloadFocusGuardsByTab'/);
  });

  it('keeps DOM interaction tools background-first unless activation is explicit', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');

    for (const tool of ['browser_run_page_action', 'browser_javascript', 'browser_click', 'browser_click_text', 'browser_fill', 'browser_form_input', 'browser_press_key', 'browser_scroll']) {
      const start = background.indexOf(`if (tool === '${tool}')`);
      const end = background.indexOf('\n  if (tool ===', start + 1);
      const block = background.slice(start, end);

      assert.ok(start >= 0, `${tool} block should exist`);
      assert.match(block, /activate: params\.activate === true/);
    }
  });

  it('allows browser_fill to write contenteditable editors', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('function fillSelector');
    const end = background.indexOf('function pressKey', start);
    const block = background.slice(start, end);

    assert.ok(start >= 0, 'fillSelector should exist');
    assert.ok(end > start, 'fillSelector block should be bounded');
    assert.match(block, /element\.isContentEditable/);
    assert.match(block, /element\.textContent = value/);
    assert.match(block, /input-like or contenteditable element/);
  });

  it('runs predefined page actions with bounded JSON-safe output', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('async function runPageAction');
    const end = background.indexOf('function getTechnicalSnapshot', start);
    const block = background.slice(start, end);

    assert.ok(start >= 0, 'runPageAction should exist');
    assert.ok(end > start, 'runPageAction block should be bounded');
    assert.match(block, /async function runPageAction\(action, params = \{\}, options = \{\}\)/);
    assert.doesNotMatch(block, /eval\(script\)/);
    assert.doesNotMatch(block, /html2canvas/);
    assert.doesNotMatch(block, /cdnjs/);
    assert.match(block, /timeoutMs/);
    assert.match(block, /result,/);
  });

  it('includes a rendered-image inventory in page content reads', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('function collectRenderedImages');
    const end = background.indexOf('function getTechnicalSnapshot', start);
    const block = background.slice(start, end);

    assert.ok(start >= 0, 'collectRenderedImages should exist');
    assert.ok(end > start, 'image inventory helpers should be bounded before technical snapshot');
    assert.match(block, /document\.querySelectorAll\('img'\)/);
    assert.match(block, /naturalWidth/);
    assert.match(block, /renderedWidth/);
    assert.match(block, /nearestText/);
    assert.match(block, /Rendered images/);
    assert.match(block, /renderedImageSummary/);
  });

  it('supports scoped and bounded page content reads without always collecting images', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('function readPageContent');
    const end = background.indexOf('function toBridgeSafeValue', start);
    const block = background.slice(start, end);

    assert.ok(start >= 0, 'readPageContent should exist');
    assert.ok(end > start, 'readPageContent block should be bounded');
    assert.match(block, /modeCandidates = \['page', 'body', 'main', 'selector', 'article'\]/);
    assert.match(block, /document\.querySelector\(selector\)/);
    assert.match(block, /includeImages === true/);
    assert.match(block, /maxChars/);
    assert.match(block, /truncated/);
    assert.match(block, /originalContentLength/);
  });

  it('waits for selectors with a page-side MutationObserver instead of extension polling', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('function waitForSelector');
    const end = background.indexOf('async function buildPopupState', start);
    const block = background.slice(start, end);
    const waitHandler = background.slice(
      background.indexOf("if (tool === 'browser_wait')"),
      background.indexOf('\n  throw new Error', background.indexOf("if (tool === 'browser_wait')")),
    );

    assert.ok(start >= 0, 'waitForSelector should exist');
    assert.ok(end > start, 'waitForSelector block should be bounded');
    assert.match(block, /new MutationObserver\(check\)/);
    assert.match(block, /safetyPoll = setInterval\(check, 1_000\)/);
    assert.match(waitHandler, /waitForSelectorViaAgent\(tab\.id/);
    assert.doesNotMatch(waitHandler, /while \(Date\.now\(\) - started/);
    assert.doesNotMatch(waitHandler, /setTimeout\(resolve, 200\)/);
  });

  it('uses an owned-tab content agent for repeated reads and waits with one-shot fallback', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const agent = fs.readFileSync(path.join(repoRoot, 'extension', 'content-agent.js'), 'utf8');
    const readHandler = background.slice(
      background.indexOf("if (tool === 'browser_get_page_content')"),
      background.indexOf("if (tool === 'browser_get_bridge_pressure')"),
    );
    const waitHandler = background.slice(
      background.indexOf("if (tool === 'browser_wait')"),
      background.indexOf('\n  throw new Error', background.indexOf("if (tool === 'browser_wait')")),
    );

    assert.match(background, /CONTENT_AGENT_PORT_NAME = 'cic-content-agent'/);
    // cursor-overlay.js sits between the two: it reads UmbraAxTree for measure,
    // and its one host insertion has to land before the agent starts the
    // observer that would otherwise count it as a DOM change.
    assert.match(background, /files: \[AX_TREE_SCRIPT, CURSOR_OVERLAY_SCRIPT, CONTENT_AGENT_SCRIPT\]/);
    assert.match(background, /files: \[AX_TREE_SCRIPT\]/);
    assert.match(background, /chrome\.runtime\.onConnect\.addListener/);
    assert.match(background, /sessionStore\.assertOwned\(sessionId, tabId\)/);
    assert.match(background, /invalidateContentAgent\(tabId, 'navigation'\)/);
    assert.match(readHandler, /readPageContentViaAgent\(sessionId, tab\.id/);
    assert.match(readHandler, /readInteractiveViaAgent\(sessionId, tab\.id/);
    assert.match(waitHandler, /waitForSelectorViaAgent\(tab\.id/);
    assert.match(background, /executeInTabWithRetry\(tabId, readPageContent/);
    assert.match(background, /executeInTab\(tabId, waitForSelector/);
    assert.match(background, /Timed out waiting for content agent action:/);
    assert.match(background, /session_disconnected\|missing_tab\|disconnected/);
    assert.match(agent, /chrome\.runtime\.connect\(\{ name: 'cic-content-agent' \}\)/);
    assert.match(agent, /new MutationObserver/);
    assert.match(agent, /IDLE_DISCONNECT_MS/);
    assert.match(agent, /DOM_VERSION_THROTTLE_MS/);
    assert.match(agent, /withActiveRequest/);
    assert.match(agent, /read_page_content/);
    assert.match(agent, /read_interactive/);
    assert.match(agent, /wait_for_selector/);
    assert.doesNotMatch(agent, /eval\(|new Function|cookies|localStorage|sessionStorage/);
  });

  it('freezes only safe owned inactive tabs by default', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('async function freezeSessionTabs');
    const end = background.indexOf('async function getOwnedTab', start);
    const block = background.slice(start, end);

    assert.ok(start >= 0, 'freezeSessionTabs should exist');
    assert.ok(end > start, 'freezeSessionTabs block should be bounded');
    assert.match(block, /sessionStore\.assertOwned\(sessionId, tabId\)/);
    assert.match(block, /tab\.active && !includeActive/);
    assert.match(block, /tab\.audible === true/);
    assert.match(block, /tab\.pinned === true/);
    assert.match(block, /dryRun !== false/);
    assert.match(block, /chrome\.tabs\.discard/);
  });

  it('reports bridge pressure without exposing unowned page data', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('async function getBridgePressure');
    const end = background.indexOf('\n}\n\nasync function handleBridgeCommand', start);
    const block = background.slice(start, end);

    assert.ok(start >= 0, 'getBridgePressure should exist');
    assert.ok(end > start, 'getBridgePressure block should be bounded');
    assert.match(block, /chrome\.storage\.local\.get/);
    assert.match(block, /connectedCount/);
    assert.match(block, /portCount/);
    assert.match(block, /scannerState/);
    assert.match(block, /tabSamples/);
    assert.doesNotMatch(block, /chrome\.tabs\.query\(\{\}/);
  });

  it('closes whole windows only when every tab is owned by the session', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');

    assert.match(background, /async function closeOwnedSessionWindows/);
    assert.match(background, /tabs\.every\(\(tab\) => tabIdSet\.has\(tab\.id\) && sessionStore\.findOwner\(tab\.id\) === sessionId\)/);
    assert.match(background, /await chrome\.windows\.remove\(windowId\)/);
    assert.doesNotMatch(background, /isBlankResidueTab/);
    assert.doesNotMatch(background, /nonBlankTabs/);
    assert.match(background, /preservedWindows/);
  });
});

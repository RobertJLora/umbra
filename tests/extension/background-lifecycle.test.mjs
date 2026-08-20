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

  it('reuses the focused Chrome window as an inactive tab rather than opening a new window', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('async function findBackgroundWindowId');
    const end = background.indexOf('async function createDedicatedWindowWithTab');
    const block = background.slice(start, end);

    assert.ok(start >= 0);
    assert.ok(end > start);
    assert.match(block, /const unfocused = windows.find/);
    assert.match(block, /const chosen = unfocused \|\| windows\[0\]/);
    assert.doesNotMatch(block, /avoidFocused/);
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

  it('does not refocus a previous Chrome window after creating an unfocused CiC window', () => {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const start = background.indexOf('async function createDedicatedWindowWithTab');
    const end = background.indexOf('async function createSessionTab');
    const block = background.slice(start, end);

    assert.ok(start >= 0);
    assert.ok(end > start);
    assert.match(block, /chrome\.windows\.create\(\{/);
    assert.match(block, /focused: Boolean\(activate\)/);
    assert.doesNotMatch(block, /getLastFocused/);
    assert.doesNotMatch(block, /windows\.update\([^)]*\{ focused: true \}/s);
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
    assert.match(block, /modeCandidates = \['page', 'body', 'main', 'selector'\]/);
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
    assert.match(background, /files: \[AX_TREE_SCRIPT, CONTENT_AGENT_SCRIPT\]/);
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

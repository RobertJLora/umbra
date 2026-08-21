import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getToolDefinition } from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const background = read('extension/background.js');
const overlay = read('extension/cursor-overlay.js');

function getToolBlock(source, toolName) {
  const start = source.indexOf(`if (tool === '${toolName}')`);
  assert.ok(start >= 0, `${toolName} handler should exist`);
  const next = source.indexOf('\n  if (tool ===', start + 1);
  return source.slice(start, next === -1 ? source.indexOf('\n  throw new Error', start) : next);
}

function getFunctionBlock(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.ok(start >= 0, `${functionName} should exist`);
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  return source.slice(start, nextFn === -1 ? source.length : start + 1 + nextFn);
}

describe('cursor overlay', () => {
  it('draws in a closed shadow root that the page cannot reach or click', () => {
    assert.match(overlay, /attachShadow\(\{ mode: 'closed' \}\)/);
    assert.match(overlay, /pointer-events/);
    assert.match(overlay, /2147483647/);
    assert.match(overlay, /umbra-cursor-layer/);
    // Without the version guard a re-injection after the content agent's idle
    // disconnect stacks a second host on the first.
    assert.match(overlay, /UmbraCursor\?\.version === CURSOR_OVERLAY_VERSION/);
  });

  it('never touches the page it draws over', () => {
    // The overlay paints and nothing else. A stray event or a moved focus would
    // double-fire handlers the real input helpers already drive.
    assert.doesNotMatch(overlay, /focus\(/);
    assert.doesNotMatch(overlay, /dispatchEvent\(/);
    // The host goes on documentElement, so a body transform rule cannot re-root it.
    assert.doesNotMatch(overlay, /document\.body\.appendChild/);
    // manifest.json declares no web_accessible_resources, so an extension asset
    // URL is unreachable from the page. The art is CSS only.
    assert.doesNotMatch(overlay, /chrome-extension:\/\//);
  });

  it('never lets a page-owned animation promise gate the caller', () => {
    // A page script can pause the overlay's animations through
    // document.getAnimations(), and a hidden tab may not advance its document
    // timeline at all, so animation.finished can stay pending forever. The
    // worker awaits this across chrome.scripting.executeScript, so an
    // unraced wait here hangs the whole tool call with the real action never
    // dispatched.
    const settle = getFunctionBlock(overlay, 'settleAfter');
    assert.match(settle, /setTimeout\(done/);
    assert.match(settle, /SETTLE_SLACK_MS/);
  });

  it('starts the glide instead of waiting on it', () => {
    // Awaiting the glide put 260 to 520 ms on the critical path of every input
    // call, which came out of the shared browser_batch deadline.
    const driver = getFunctionBlock(background, 'withCursorFeedback');
    assert.doesNotMatch(driver, /await executeInTab\(tabId, umbraCursorDrive, \[\{ op: 'glide'/);
    assert.match(driver, /trackCursorAnimation\(tabId, glide\)/);
  });

  it('aims from the result when the caller named no element', () => {
    // measure returns null with no target unless the caller opts into the
    // viewport fallback, which is what keeps the pointFromResult branch
    // reachable for browser_click_text instead of drawing the click marker in
    // the middle of the viewport.
    const measure = getFunctionBlock(overlay, 'measure');
    assert.match(measure, /fallback === 'viewport'/);
    assert.match(measure, /return null;/);
    const driver = getFunctionBlock(background, 'withCursorFeedback');
    assert.match(driver, /spec\.pointFromResult/);
  });

  it('clears every transient marker before a screenshot captures', () => {
    // Fading only the arrow left the ripple, caret, chevron and drag trail
    // animating, so the documented click-then-screenshot pattern captured a ring.
    const hide = getFunctionBlock(overlay, 'hide');
    assert.match(hide, /node !== pointer/);
    assert.match(hide, /node\.remove\(\)/);
    assert.match(getToolBlock(background, 'browser_screenshot'), /settleCursorAnimations/);
  });

  it('keeps the driver fail-open around the real dispatch', () => {
    const driver = getFunctionBlock(background, 'withCursorFeedback');
    assert.ok(
      (driver.match(/catch/g) || []).length >= 3,
      'every overlay step should be individually swallowed',
    );
    assert.match(driver, /return await run\(\)/);
    assert.doesNotMatch(driver, /chrome\.tabs\.update/);
  });

  it('hides the pointer before a screenshot captures', () => {
    assert.match(getToolBlock(background, 'browser_screenshot'), /op: 'hide'/);
  });

  it('refuses to inject on pages Chrome will not script, and swallows the rest', () => {
    const injector = getFunctionBlock(background, 'ensureCursorOverlay');
    assert.match(injector, /chrome:\/\//);
    assert.match(injector, /catch/);
    assert.match(injector, /CURSOR_OVERLAY_SCRIPT/);
  });

  it('injects the overlay before the content agent starts its observer', () => {
    const ensureAgent = getFunctionBlock(background, 'ensureContentAgent');
    assert.match(ensureAgent, /\[AX_TREE_SCRIPT, CURSOR_OVERLAY_SCRIPT, CONTENT_AGENT_SCRIPT\]/);
  });

  it('advertises browser_cursor as a background-first session knob', () => {
    const cursor = getToolDefinition('browser_cursor');
    assert.equal(cursor.inputSchema.type, 'object');
    assert.equal(cursor.inputSchema.properties.enabled.type, 'boolean');
    assert.equal(cursor.inputSchema.properties.activate.type, 'boolean');
    assert.match(cursor.inputSchema.properties.activate.description, /Defaults to false/);
    assert.match(background, /if \(tool === 'browser_cursor'\)/);

    const block = getToolBlock(background, 'browser_cursor');
    assert.match(block, /cursorSessionOverrides/);
    assert.match(block, /source: hasOverride \? 'session' : 'install'/);
    assert.doesNotMatch(block, /chrome\.tabs\.query/);
  });

  it('drops a session override when that session disconnects', () => {
    assert.match(background, /cursorSessionOverrides\.delete\(message\.sessionId\)/);
  });

  it('keeps the overlay host out of raw HTML reads', () => {
    const agent = read('extension/content-agent.js');
    assert.match(agent, /umbra-cursor-layer\\b\[\^>\]\*><\\\/umbra-cursor-layer>/);
  });

  it('defaults the install setting on and hydrates the options toggle behind the guard', () => {
    const shared = read('extension/shared.js');
    assert.match(shared, /cursorOverlay: true/);
    assert.match(shared, /cursorOverlay: config\.cursorOverlay !== false/);
    assert.match(shared, /next\.cursorOverlay = next\.cursorOverlay !== false/);

    const options = read('extension/options.js');
    assert.match(options, /el\('cursorOverlay'\)\.checked = config\.cursorOverlay !== false/);
    // Reading the checkbox before renderState painted it persists a false the
    // user never chose, which this project already shipped once.
    assert.match(options, /cursorOverlay: settingsHydrated\s*\?\s*el\('cursorOverlay'\)\.checked\s*:\s*stored\.cursorOverlay !== false/);
    assert.match(read('extension/options.html'), /id="cursorOverlay"/);
  });
});

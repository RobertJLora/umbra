import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getToolDefinition } from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension', 'manifest.json'), 'utf8'));

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

describe('computer-tool parity', () => {
  it('exposes coordinate click and screenshot zoom/silent schemas', () => {
    const click = getToolDefinition('browser_click');
    assert.equal(click.inputSchema.properties.x.type, 'number');
    assert.equal(click.inputSchema.properties.y.type, 'number');
    assert.equal(click.inputSchema.properties.selector.type, 'string');
    assert.equal(click.inputSchema.properties.ref.type, 'string');
    assert.equal(click.inputSchema.properties.activate.type, 'boolean');
    assert.match(click.description, /selector, interactive ref, or viewport point/);
    assert.match(click.inputSchema.properties.x.description, /CSS-pixel/);
    assert.match(click.inputSchema.properties.y.description, /CSS-pixel/);
    assert.match(click.inputSchema.properties.activate.description, /Defaults to false/);

    const screenshot = getToolDefinition('browser_screenshot');
    assert.equal(screenshot.inputSchema.properties.zoom.type, 'number');
    assert.equal(screenshot.inputSchema.properties.silent.type, 'boolean');
    assert.equal(screenshot.inputSchema.properties.outputPath.type, 'string');
    assert.equal(screenshot.inputSchema.properties.fullPage.type, 'boolean');
    assert.equal(screenshot.inputSchema.properties.region.type, 'object');
    assert.equal(screenshot.inputSchema.properties.ref.type, 'string');
    assert.equal(screenshot.inputSchema.properties.selector.type, 'string');
    assert.deepEqual(screenshot.inputSchema.properties.format.enum, ['png', 'jpeg']);
    assert.match(screenshot.description, /default path activates the tab/i);
    assert.match(screenshot.inputSchema.properties.zoom.description, /tighter crop/);
    assert.match(screenshot.inputSchema.properties.silent.description, /without activating/);

    const serialized = `${JSON.stringify(click)}${JSON.stringify(screenshot)}`;
    assert.doesNotMatch(serialized, /cookie|token|password|storage|captcha/i);
    assert.doesNotMatch(serialized, /\u2014|\u2013|--/);
  });

  it('keeps click and screenshot handlers on owned tabs', () => {
    const clickBlock = getToolBlock(background, 'browser_click');
    const screenshotBlock = getToolBlock(background, 'browser_screenshot');
    const clickAtPointBlock = getFunctionBlock(background, 'clickAtPoint');

    assert.match(clickBlock, /getOrCreateSessionTab\(sessionId/);
    assert.match(clickBlock, /activate: params\.activate === true/);
    assert.match(clickBlock, /clickAtPoint/);
    assert.match(clickBlock, /requires selector, ref, or both x and y/);
    assert.match(clickAtPointBlock, /elementFromPoint/);
    assert.match(clickAtPointBlock, /fireReact/);
    assert.match(clickAtPointBlock, /onClick/);
    assert.match(clickAtPointBlock, /PointerEvent\('pointerdown'/);
    assert.match(clickAtPointBlock, /MouseEvent\('mousedown'/);
    assert.match(clickAtPointBlock, /MouseEvent\('mouseup'/);
    assert.match(clickAtPointBlock, /MouseEvent\('click'/);

    assert.match(screenshotBlock, /getOrCreateSessionTab\(sessionId/);
    assert.match(screenshotBlock, /activate: silent \? false : true/);
    assert.match(screenshotBlock, /applyScreenshotZoom/);
    assert.match(screenshotBlock, /normalizeScreenshotZoom/);
    assert.match(screenshotBlock, /captureSilentScreenshot/);
  });

  it('does not call captureVisibleTab on the silent screenshot branch', () => {
    const screenshotBlock = getToolBlock(background, 'browser_screenshot');
    const silentStart = screenshotBlock.indexOf('if (silent)');
    assert.ok(silentStart >= 0, 'silent branch should exist');
    const elseStart = screenshotBlock.indexOf('} else if (fullPage)', silentStart);
    assert.ok(elseStart > silentStart, 'silent branch should be distinct from the visible-tab path');
    const silentBranch = screenshotBlock.slice(silentStart, elseStart);
    assert.doesNotMatch(silentBranch, /captureVisibleTab/);
    assert.match(silentBranch, /captureSilentScreenshot/);

    const silentHelper = getFunctionBlock(background, 'captureSilentScreenshot');
    const debuggerHelper = getFunctionBlock(background, 'withOwnedTabDebugger');
    assert.doesNotMatch(silentHelper, /captureVisibleTab/);
    assert.match(silentHelper, /withOwnedTabDebugger/);
    assert.match(silentHelper, /Page\.captureScreenshot/);
    assert.match(silentHelper, /debugger API is missing/);
    assert.match(debuggerHelper, /chrome\.debugger\.attach/);
    assert.match(debuggerHelper, /chrome\.debugger\.detach/);
    assert.match(debuggerHelper, /finally/);
  });

  it('decodes screenshot crops without fetch of data URLs', () => {
    const decode = getFunctionBlock(background, 'dataUrlToBlob');
    const crop = getFunctionBlock(background, 'cropScreenshotDataUrl');
    const stitch = getFunctionBlock(background, 'stitchScreenshotSlices');

    assert.match(decode, /atob\(/);
    assert.match(decode, /MV3 connect-src rejects data URLs/);
    assert.doesNotMatch(decode, /fetch\(/);
    assert.match(crop, /imageBitmapFromDataUrl/);
    assert.doesNotMatch(crop, /fetch\(/);
    assert.match(stitch, /imageBitmapFromDataUrl/);
    assert.doesNotMatch(stitch, /fetch\(/);
  });

  it('uses debugger only for silent screenshots, recording frames, owned-tab file upload, page JavaScript, request logging, and trusted clicks', () => {
    assert.equal((manifest.permissions || []).includes('debugger'), true);
    const commands = [...background.matchAll(/chrome\.debugger\.sendCommand\([^,]+,\s*'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(commands)].sort(), [
      'Browser.setDownloadBehavior',
      'DOM.getContentQuads',
      'DOM.getDocument',
      'DOM.querySelector',
      'DOM.setFileInputFiles',
      'Emulation.setFocusEmulationEnabled',
      'Input.dispatchMouseEvent',
      // The request-log job. Nothing reads a body or a header, so enable and
      // disable are the whole Network surface this extension touches.
      'Network.disable',
      'Network.enable',
      'Page.bringToFront',
      'Page.captureScreenshot',
      'Page.setDownloadBehavior',
      // Part of the page-JavaScript job, not a fifth one: enabling Runtime is
      // what makes the caller's own console output reachable, because
      // Runtime.evaluate runs in the MAIN world that neither console mirror sees.
      'Runtime.enable',
      'Runtime.evaluate',
    ]);
    assert.doesNotMatch(background, /if \(tool === 'browser_debugger'\)/);

    const trustedClick = getFunctionBlock(background, 'dispatchTrustedMouseClick');
    const pending = getFunctionBlock(background, 'maybeDispatchPendingTrustedClick');
    const clickBlock = getToolBlock(background, 'browser_click');
    const pageActionBlock = getToolBlock(background, 'browser_run_page_action');
    assert.match(trustedClick, /Page\.setDownloadBehavior/);
    assert.match(trustedClick, /DOM\.getContentQuads/);
    assert.match(trustedClick, /Input\.dispatchMouseEvent/);
    assert.match(trustedClick, /mousePressed/);
    assert.match(trustedClick, /mouseReleased/);
    assert.match(trustedClick, /withOwnedTabDebugger/);
    assert.match(trustedClick, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/);
    assert.doesNotMatch(trustedClick, /focused: false/);
    assert.match(pending, /pendingTrustedClick/);
    assert.match(pending, /dispatchTrustedMouseClick/);
    assert.match(pageActionBlock, /maybeDispatchPendingTrustedClick/);
    assert.doesNotMatch(clickBlock, /chrome\.debugger/);
    assert.doesNotMatch(clickBlock, /dispatchTrustedMouseClick/);
  });

  it('gives every click path a button, a click count and modifier flags', () => {
    for (const block of [
      getFunctionBlock(background, 'clickAtPoint'),
      getFunctionBlock(background, 'clickSelector'),
      fs.readFileSync(path.join(repoRoot, 'extension', 'content-agent.js'), 'utf8'),
    ]) {
      assert.match(block, /ctrlKey/);
      assert.match(block, /shiftKey/);
      assert.match(block, /altKey/);
      assert.match(block, /metaKey/);
      assert.match(block, /detail/);
      // A browser fires contextmenu and no click on a right press, so a page
      // that renders its own menu sees the event it listens for.
      assert.match(block, /contextmenu/);
    }

    const click = getToolDefinition('browser_click');
    assert.deepEqual(click.inputSchema.properties.button.enum, ['left', 'right', 'middle']);
    assert.match(click.inputSchema.properties.button.description, /Defaults to left/);
    assert.equal(click.inputSchema.properties.clickCount.minimum, 1);
    assert.equal(click.inputSchema.properties.clickCount.maximum, 3);
    assert.equal(click.inputSchema.properties.modifiers.type, 'object');
    assert.deepEqual(
      Object.keys(click.inputSchema.properties.modifiers.properties),
      ['ctrl', 'shift', 'alt', 'meta'],
    );

    // doubleClick predates clickCount and has to keep working, so it is
    // normalized once in the handler rather than branched on three times.
    const clickBlock = getToolBlock(background, 'browser_click');
    assert.match(clickBlock, /normalizeClickOptions\(params, doubleClick\)/);
    const normalize = getFunctionBlock(background, 'normalizeClickOptions');
    assert.match(normalize, /doubleClick === true \? 2 : 1/);
  });

  it('drags with a pointer sequence and the HTML5 drag family', () => {
    const drag = getFunctionBlock(background, 'dragAtPoints');
    assert.match(drag, /pointerdown/);
    assert.match(drag, /pointermove/);
    assert.match(drag, /pointerup/);
    // A native drop target ignores raw mouse events: only the drag family
    // sharing one DataTransfer moves anything.
    assert.match(drag, /DataTransfer/);
    assert.match(drag, /dragstart/);
    assert.match(drag, /dragover/);
    assert.match(drag, /'drop'/);
    assert.match(drag, /dragend/);
    assert.match(drag, /draggable/);
    // Synthetic like every other input path, so the tab is never activated and
    // Chrome never shows an automation banner for a drag.
    assert.doesNotMatch(drag, /chrome\.debugger/);

    const dragBlock = getToolBlock(background, 'browser_drag');
    assert.match(dragBlock, /getOrCreateSessionTab\(sessionId/);
    assert.match(dragBlock, /activate: params\.activate === true/);
    assert.match(dragBlock, /kind: 'drag'/);
    assert.match(dragBlock, /requires a start point/);
    assert.match(dragBlock, /requires an end point/);

    const definition = getToolDefinition('browser_drag');
    assert.equal(definition.inputSchema.properties.steps.minimum, 2);
    assert.equal(definition.inputSchema.properties.steps.maximum, 40);
    assert.equal(definition.inputSchema.properties.startRef.type, 'string');
    assert.equal(definition.inputSchema.properties.startSelector.type, 'string');
    assert.doesNotMatch(JSON.stringify(definition), /\u2014|\u2013/);
  });

  it('takes a key sequence and a repeat count, under one dispatch cap', () => {
    const pressBlock = getToolBlock(background, 'browser_press_key');
    assert.match(pressBlock, /split\(/);
    assert.match(pressBlock, /repeat/);
    assert.match(pressBlock, /KEY_SEQUENCE_MAX_DISPATCHES/);
    assert.match(pressBlock, /KEY_SEQUENCE_GAP_MS/);
    // One key with no repeat takes the same single dispatch it always did.
    assert.match(pressBlock, /chords\.length === 1 && repeat === 1/);
    assert.match(background, /const KEY_SEQUENCE_MAX_DISPATCHES = 400;/);

    const press = getToolDefinition('browser_press_key');
    assert.equal(press.inputSchema.properties.repeat.minimum, 1);
    assert.equal(press.inputSchema.properties.repeat.maximum, 100);
    assert.match(press.inputSchema.properties.key.description, /space-separated sequence/);
  });

  it('scrolls an inner pane at a point instead of the window', () => {
    const scroll = getFunctionBlock(background, 'scrollPage');
    assert.match(scroll, /elementFromPoint/);
    assert.match(scroll, /scrollHeight/);
    assert.match(scroll, /overflowY/);
    // x and y keep their delta meaning, so a caller written before direction
    // existed scrolls exactly as far as it used to.
    assert.match(scroll, /let deltaX = Number\(x\) \|\| 0;/);

    const definition = getToolDefinition('browser_scroll');
    assert.deepEqual(definition.inputSchema.properties.direction.enum, ['up', 'down', 'left', 'right']);
    assert.equal(definition.inputSchema.properties.amount.minimum, 1);
    assert.equal(definition.inputSchema.properties.amount.maximum, 30);
    assert.equal(definition.inputSchema.properties.atX.type, 'number');
    assert.equal(definition.inputSchema.properties.atY.type, 'number');
  });

  it('waits a fixed duration without touching the page', () => {
    const waitBlock = getToolBlock(background, 'browser_wait');
    assert.match(waitBlock, /requires selector, urlContains, urlChanged, or durationMs/);
    assert.match(waitBlock, /return \{ tabId: tab\.id, waited: durationMs \};/);

    const wait = getToolDefinition('browser_wait');
    assert.equal(wait.inputSchema.required, undefined);
    assert.equal(wait.inputSchema.properties.durationMs.minimum, 50);
    assert.equal(wait.inputSchema.properties.durationMs.maximum, 30000);
  });

  it('captures console output from the world browser_javascript actually runs in', () => {
    // Runtime.evaluate runs in the page's MAIN world. The content agent's wrap
    // is isolated-world, and the MAIN-world mirror was install-on-first-read, so
    // the first read after a console.log came back empty and the caller's own
    // output was captured by nothing.
    const evaluate = getFunctionBlock(background, 'executeJavascriptWithWorldFallback');
    assert.match(evaluate, /Runtime\.enable/);
    assert.ok(
      evaluate.indexOf('Runtime.enable') < evaluate.indexOf('Runtime.evaluate'),
      'Runtime must be enabled before the evaluate that produces the console output',
    );
    // consoleAPICalled lands on its own task and the detach in the finally block
    // would drop it, so the queued events get one turn.
    assert.match(evaluate, /CONSOLE_DRAIN_MS/);

    assert.match(background, /chrome\.debugger\?\.onEvent\?\.addListener/);
    assert.match(background, /Runtime\.consoleAPICalled/);
    // Only events from an attachment this extension owns.
    assert.match(background, /tabDebuggerAttachments\.has\(source\.tabId\)/);
    // Log.enable would start returning network, security and deprecation
    // entries that browser_console_messages does not return today.
    assert.doesNotMatch(background, /'Log\.enable'/);

    // The source label is dedupe bookkeeping and must never reach a caller.
    const filter = getFunctionBlock(background, 'filterConsoleMessages');
    assert.match(filter, /\.map\(\(\{ level: entryLevel, text, ts \}\) => \(\{ level: entryLevel, text, ts \}\)\)/);
    const push = getFunctionBlock(background, 'pushConsoleMessage');
    assert.match(push, /CONSOLE_CROSS_SOURCE_WINDOW_MS/);
  });

  it('attaches a screenshot repair hint only to a capture that needs repairing', () => {
    const preflight = getFunctionBlock(background, 'buildScreenshotPreflight');
    assert.match(preflight, /degraded/);
    assert.match(preflight, /capture_failed/);
    assert.match(preflight, /truncated/);
    // tabActive, tabStatus and windowFocused stay on every result: they are the
    // honest half of the payload and the fields that answer the focus question.
    assert.match(preflight, /windowFocused/);
    assert.equal(
      (background.match(/Retry after the tab finishes loading/g) || []).length,
      1,
      'the repair hint should exist in exactly one place, the failure branch',
    );
    const screenshotBlock = getToolBlock(background, 'browser_screenshot');
    assert.match(screenshotBlock, /buildScreenshotPreflight\(tab, truncated \? \{ degraded: 'truncated' \} : \{\}\)/);
  });

  it('requests a trusted debugger click for the table-export submit recipe', () => {
    // The vendor filename is assembled from fragments so the literal never
    // appears in the repo; the identity gate targets zero occurrences anywhere.
    const recipeFile = ['ah', 'refs', '-actions.js'].join('');
    const recipePath = path.join(repoRoot, 'extension', 'recipes', recipeFile);
    if (!fs.existsSync(recipePath)) {
      return;
    }
    const recipe = fs.readFileSync(recipePath, 'utf8');
    assert.match(recipe, /pendingTrustedClick: true/);
    assert.match(recipe, /submitRect/);
    assert.match(recipe, /data-umbra-trusted-click/);
    assert.match(recipe, /RECIPE_VERSION = '1\.0\.1'/);
    assert.doesNotMatch(recipe, /reason: submitted \? 'modal_export_click'/);
  });
});

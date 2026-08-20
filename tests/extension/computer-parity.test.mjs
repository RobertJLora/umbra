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

  it('uses debugger only for silent screenshots, owned-tab file upload, and page JavaScript', () => {
    assert.equal((manifest.permissions || []).includes('debugger'), true);
    const commands = [...background.matchAll(/chrome\.debugger\.sendCommand\([^,]+,\s*'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(commands)].sort(), [
      'DOM.getDocument',
      'DOM.querySelector',
      'DOM.setFileInputFiles',
      'Page.captureScreenshot',
      'Runtime.evaluate',
    ]);
    assert.doesNotMatch(background, /if \(tool === 'browser_debugger'\)/);
  });
});

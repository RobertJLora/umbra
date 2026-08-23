// GIF recorder contract tests.
//
// Static assertions against the shipping source, the same shape every other
// extension test in this repo uses. What they pin is not that the recorder
// works, which needs Chrome, but the four decisions that are easy to undo by
// accident: the capture path that does not activate the tab, the attachment
// that is released when a tab goes away, the frame buffer living in the
// offscreen document with a size ceiling, and a tool definition that says
// nothing about how any of it is done.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getToolDefinition } from '../../mcp-server/tools.js';
import { EXTENSION_FILES } from '../../scripts/verify-package.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const background = read('extension/background.js');
const offscreen = read('extension/offscreen.js');

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

describe('gif recorder', () => {
  it('resolves an owned tab and leaves activation opt-in', () => {
    const block = getToolBlock(background, 'browser_gif');
    assert.match(block, /getOrCreateSessionTab\(sessionId/);
    assert.match(block, /activate: params\.activate === true/);
  });

  it('captures frames without activating the tab', () => {
    const block = getToolBlock(background, 'browser_gif');
    // captureVisibleTab forces the tab active and Chrome throttles it to about
    // two calls a second, so it can neither hold a frame rate nor keep the
    // no-focus-theft promise in the manifest description.
    assert.doesNotMatch(block, /captureVisibleTab/);
    assert.match(block, /captureSilentScreenshot/);
  });

  it('releases the pinned attachment when the tab goes away', () => {
    assert.ok(getFunctionBlock(background, 'unpinTabDebugger').length > 0);
    const listenerStart = background.indexOf('chrome.tabs.onRemoved.addListener');
    assert.ok(listenerStart >= 0, 'the tab removal listener should exist');
    const listener = background.slice(listenerStart, listenerStart + 900);
    assert.match(listener, /unpinTabDebugger|stopGifRecording/);
  });

  it('paces interval capture to what the tab delivers and reports what it got', () => {
    // A fixed setInterval at the requested rate queued ticks faster than a
    // capture completed, and captureGifFrame dropped every one of them: a
    // recording at four frames a second reported 92 skipped against 24
    // exported. Each tick now schedules the next, never sooner than the last
    // capture took, so the rate degrades instead of shredding.
    const block = getToolBlock(background, 'browser_gif');
    assert.doesNotMatch(block, /setInterval/);
    assert.match(block, /scheduleGifTick\(tab\.id\)/);
    assert.match(block, /frameIntervalMs: Math\.round\(1000 \/ fps\)/);

    const schedule = getFunctionBlock(background, 'scheduleGifTick');
    assert.match(schedule, /setTimeout/);
    assert.match(schedule, /Math\.max\(state\.frameIntervalMs \|\| 0, Math\.round\(state\.lastCaptureMs \|\| 0\)\)/);
    // The chain has to re-arm itself, or a recording captures one frame.
    assert.match(schedule, /scheduleGifTick\(tabId\)/);
    assert.match(schedule, /state\.recording !== true/);

    // A self-rescheduling timeout, so the teardown has to clear a timeout.
    const stop = getFunctionBlock(background, 'stopGifRecording');
    assert.match(stop, /clearTimeout\(state\.intervalId\)/);

    // Measured, not requested: the pacing means the two can differ, and the
    // export carries the rate the tab actually held.
    const capture = getFunctionBlock(background, 'captureGifFrame');
    assert.match(capture, /state\.lastCaptureMs = Date\.now\(\) - captureStartedAt;/);
    assert.match(block, /effectiveFps/);
    assert.match(block, /state\.frameCount \|\| 0\) \/ \(durationMs \/ 1000\)/);
  });

  it('keeps the frame buffer and the encoder in the offscreen document', () => {
    // Dynamically imported, and deliberately not a static top-level import. This
    // document also holds the bridge sockets, so a missing or half-copied encoder
    // used to stop the whole module from evaluating and take the transport down
    // with it. As a dynamic import a broken encoder costs one tool call.
    assert.match(offscreen, /import\('\.\/vendor\/gifenc\.js'\)/);
    assert.doesNotMatch(offscreen, /^import .* from '\.\/vendor\/gifenc\.js';/m);
    assert.match(offscreen, /MAX_GIF_BYTES/);
  });

  it('refuses an export run as a batch child, on both transports', async () => {
    // Inside a batch the top-level tool name is browser_batch, so neither the
    // pre-call outputPath check nor the disk-write branch fires and the encoded
    // animation comes back inline as roughly 32 MB of base64.
    const { batchChildRejectionReason } = await import('../../mcp-server/tools.js');
    assert.match(batchChildRejectionReason('browser_gif', { action: 'export' }), /browser_batch/);
    assert.equal(batchChildRejectionReason('browser_gif', { action: 'start' }), '');
    assert.equal(batchChildRejectionReason('browser_click', {}), '');
    for (const lane of ['mcp-server/bridge-core.js', 'mcp-server/rust-broker-client.js']) {
      assert.match(read(lane), /batchChildRejectionReason\(toolName, call\.params\)/, lane);
    }
  });

  it('survives an eviction with its control record and its pin', () => {
    // The frames live in the offscreen document, which is not evicted; the
    // control record used to live only in worker memory, so a resurrected worker
    // threw "No recording on this tab" with every frame still buffered and had
    // nothing left to release the debugger attachment.
    assert.match(background, /chrome\.storage\.session\.set\(\{ \[GIF_RECORDING_STORAGE_KEY\]/);
    const rehydrate = getFunctionBlock(background, 'rehydrateGifRecordings');
    assert.match(rehydrate, /gifRecordings\.set/);
    const release = getFunctionBlock(background, 'releaseOrphanedTabDebuggers');
    assert.match(release, /chrome\.debugger\.getTargets/);
    assert.match(release, /tabDebuggerAttachments\.has\(tabId\)/);
    assert.match(background, /await rehydrateGifRecordings\(\);/);
    assert.match(background, /await releaseOrphanedTabDebuggers\(\);/);
  });

  it('publishes a tool definition that describes the recording, not the plumbing', () => {
    const definition = getToolDefinition('browser_gif');
    assert.doesNotMatch(JSON.stringify(definition), /debugger|cookie|token|password/i);
    assert.equal(definition.inputSchema.properties.timeoutMs.type, 'number');
  });

  it('ships the recorder files in the package', () => {
    assert.ok(EXTENSION_FILES.includes('vendor/gifenc.js'));
    assert.ok(EXTENSION_FILES.includes('cursor-overlay.js'));
  });

  it('draws click and drag overlays in Umbra violet', () => {
    assert.match(offscreen, /GIF_CLICK_COLOR = '#8a6cff'/);
    assert.match(offscreen, /GIF_DRAG_COLOR = '#6b46f0'/);
    assert.doesNotMatch(offscreen, /#ff8a3d|#e5484d/);
  });
});

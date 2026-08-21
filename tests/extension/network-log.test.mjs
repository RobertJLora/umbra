// Request-log contract tests.
//
// Static assertions against the shipping source, the same shape the other
// extension tests use. What they pin is not that logging works, which needs
// Chrome, but the decisions that are easy to undo by accident: the CDP surface
// stays two commands wide, capture is scoped to a tab the session owns, the
// attachment is released on stop and on every lifecycle exit, a cross-hostname
// navigation drops the buffer, and the tool definition says nothing about how
// any of it is done.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getToolDefinition, isMcpLocalTool } from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const background = read('extension/background.js');
const parityTest = read('tests/extension/computer-parity.test.mjs');
const permissions = read('docs/permissions.md');

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

describe('network request log', () => {
  it('keeps the CDP surface to enable and disable', () => {
    // The parity suite pins the whole sendCommand list. This asserts the two
    // names this feature added are the two it was allowed to add, so a later
    // reach for Network.getResponseBody fails here as well as there.
    assert.match(parityTest, /'Network\.disable',/);
    assert.match(parityTest, /'Network\.enable',/);
    const networkCommands = [...background.matchAll(/chrome\.debugger\.sendCommand\([^,]+,\s*'(Network\.[^']+)'/g)]
      .map((match) => match[1]);
    assert.deepEqual([...new Set(networkCommands)].sort(), ['Network.disable', 'Network.enable']);
  });

  it('resolves an owned tab and leaves activation opt-in', () => {
    const block = getToolBlock(background, 'browser_read_network_requests');
    assert.match(block, /getOrCreateSessionTab\(sessionId/);
    assert.match(block, /activate: params\.activate === true/);
    assert.match(block, /createIfMissing: false/);
  });

  it('starts capture on first read and says so in the result', () => {
    const block = getToolBlock(background, 'browser_read_network_requests');
    assert.match(block, /startNetworkLog\(tab\.id, sessionId\)/);
    assert.match(block, /capturing: true/);
    assert.match(block, /note:/);
    const start = getFunctionBlock(background, 'startNetworkLog');
    assert.match(start, /pinTabDebugger\(tabId\)/);
    assert.match(start, /'Network\.enable'/);
    // A failed enable must not leave a refcount behind, or the tab keeps its
    // automation banner with nothing logging. The unpin carries the handle the
    // pin returned, so it can only ever decrement the entry this log claimed.
    assert.match(start, /unpinTabDebugger\(tabId, handle\)/);
  });

  it('releases the attachment on stop', () => {
    const block = getToolBlock(background, 'browser_read_network_requests');
    assert.match(block, /params\.stop === true/);
    const stop = getFunctionBlock(background, 'stopNetworkLog');
    assert.match(stop, /'Network\.disable'/);
    // Handle-guarded, so a log whose attachment was already dropped by onDetach
    // cannot decrement a recording's newer entry to zero and detach it.
    assert.match(stop, /unpinTabDebugger\(tabId, handle\)/);
    assert.ok(
      stop.indexOf('Network.disable') < stop.indexOf('unpinTabDebugger'),
      'disable has to reach a live attachment, so it runs before the unpin that detaches',
    );
  });

  it('bounds the buffer and the idle window', () => {
    assert.match(background, /const NETWORK_LOG_CAP = 400;/);
    assert.match(background, /const NETWORK_LOG_IDLE_MS = 300_000;/);
    const push = getFunctionBlock(background, 'pushNetworkEntry');
    assert.match(push, /NETWORK_LOG_CAP/);
    assert.match(push, /shift\(\)/);
    const watchdog = getFunctionBlock(background, 'armNetworkLogWatchdog');
    assert.match(watchdog, /setTimeout/);
    assert.match(watchdog, /stopNetworkLog\(tabId, 'idle'\)/);
  });

  it('stops logging on every lifecycle exit', () => {
    const removedStart = background.indexOf('chrome.tabs.onRemoved.addListener');
    assert.ok(removedStart >= 0, 'the tab removal listener should exist');
    assert.match(background.slice(removedStart, removedStart + 1200), /stopNetworkLog\(tabId, 'tab_removed'\)/);
    const disconnectStart = background.indexOf("case 'bridge_session_disconnected'");
    assert.ok(disconnectStart >= 0, 'the session disconnect case should exist');
    assert.match(background.slice(disconnectStart, disconnectStart + 600), /stopSessionNetworkLogs\(message\.sessionId\)/);
  });

  it('clears the buffer on the new document request, not on the tab update', () => {
    // chrome.tabs.onUpdated reports a URL only once the navigation has
    // committed, which is after Network.requestWillBeSent for that document has
    // already landed. Clearing there wiped the navigation's own row: a caller
    // who navigated and then read by hostname got an empty list.
    const updatedStart = background.indexOf('chrome.tabs.onUpdated.addListener((tabId, changeInfo)');
    assert.ok(updatedStart >= 0, 'the tab update listener should exist');
    const listener = background.slice(updatedStart, updatedStart + 1200);
    assert.doesNotMatch(listener, /clearNetworkLogForNavigation\(/);

    const clear = getFunctionBlock(background, 'clearNetworkLogForNavigation');
    assert.match(clear, /hostname/);
    assert.match(clear, /clearNetworkLog\(tabId\)/);

    const handlerStart = background.indexOf("if (method === 'Network.requestWillBeSent')");
    assert.ok(handlerStart >= 0, 'the request event branch should exist');
    const handler = background.slice(handlerStart, handlerStart + 1400);
    assert.match(handler, /isMainFrameDocumentRequest\(log, event\)/);
    assert.ok(
      handler.indexOf('clearNetworkLogForNavigation') < handler.indexOf('pushNetworkEntry'),
      'the clear has to run before the push, or it drops the row it was meant to keep',
    );
    // A redirect hop is the same navigation, so the chain survives it.
    assert.match(handler, /redirectResponse/);
  });

  it('drops the log only for a main-frame navigation, whatever case CDP sends', () => {
    // Lifted out of the shipping source and run, because the bug this replaced
    // was a decision about which event clears, not a spelling.
    const typesStart = background.indexOf('const NETWORK_RESOURCE_TYPES');
    const typesEnd = background.indexOf('function networkHostname');
    assert.ok(typesStart >= 0 && typesEnd > typesStart, 'the resource type table should exist');
    const sandbox = {};
    vm.createContext(sandbox);
    const { normalizeNetworkResourceType, isMainFrameDocumentRequest } = vm.runInContext(
      `${background.slice(typesStart, typesEnd)}\n${getFunctionBlock(background, 'isMainFrameDocumentRequest')}\n`
      + ';({ normalizeNetworkResourceType, isMainFrameDocumentRequest })',
      sandbox,
      { filename: 'background.js:network-types' },
    );

    // CDP spells the type Document and the filter enum is lowercase.
    assert.equal(normalizeNetworkResourceType('Document'), 'document');
    assert.equal(normalizeNetworkResourceType('XHR'), 'xhr');
    assert.equal(normalizeNetworkResourceType('Preflight'), 'other');

    const log = { mainFrameId: null };
    assert.equal(
      isMainFrameDocumentRequest(log, { type: 'Document', requestId: 'r1', loaderId: 'r1', frameId: 'FRAME_A' }),
      true,
    );
    assert.equal(log.mainFrameId, 'FRAME_A', 'the first navigation names the frame the log follows');
    // A cross-origin iframe navigating is not the tab moving.
    assert.equal(
      isMainFrameDocumentRequest(log, { type: 'Document', requestId: 'r2', loaderId: 'r2', frameId: 'FRAME_B' }),
      false,
    );
    // A subresource carries the navigation's loaderId, not its own.
    assert.equal(
      isMainFrameDocumentRequest(log, { type: 'Document', requestId: 'r3', loaderId: 'r1', frameId: 'FRAME_A' }),
      false,
    );
    assert.equal(
      isMainFrameDocumentRequest(log, { type: 'XHR', requestId: 'r4', loaderId: 'r4', frameId: 'FRAME_A' }),
      false,
    );
  });

  it('records where a request went and never what it carried', () => {
    const listenerStart = background.indexOf("'Network.requestWillBeSent',");
    assert.ok(listenerStart >= 0, 'the request-log event listener should exist');
    assert.match(background, /chrome\.debugger\?\.onEvent\?\.addListener/);
    assert.match(background, /'Network\.responseReceived',/);
    assert.match(background, /'Network\.loadingFailed',/);
    // No body and no header reaches the buffer, which is what keeps the tool
    // definition clear of the vocabulary the contract test forbids.
    assert.doesNotMatch(background, /getResponseBody|Network\.setExtraHTTPHeaders/);
  });

  it('publishes a tool definition that describes the log, not the plumbing', () => {
    const definition = getToolDefinition('browser_read_network_requests');
    assert.ok(definition, 'browser_read_network_requests should be advertised');
    assert.equal(definition.inputSchema.type, 'object');
    assert.doesNotMatch(JSON.stringify(definition), /cookie|token|password|debugger/i);
    assert.equal(definition.inputSchema.properties.urlPattern.maxLength, 300);
    assert.equal(definition.inputSchema.properties.limit.maximum, 300);
    assert.deepEqual(definition.inputSchema.properties.types.items.enum, [
      'xhr',
      'fetch',
      'document',
      'script',
      'stylesheet',
      'image',
      'font',
      'media',
      'other',
    ]);
    // It runs in the extension, so it must not be answered in-process.
    assert.equal(isMcpLocalTool('browser_read_network_requests'), false);
  });

  it('documents the job in the permissions note', () => {
    // The doc and the sendCommand allowlist move together on purpose: a new CDP
    // domain that nobody wrote down is a permission a reader cannot audit.
    assert.match(permissions, /request logging/i);
    assert.match(permissions, /Network\.enable/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalBridgeServer, parseEnvNumber } from '../../mcp-server/bridge-core.js';
import { SessionRegistry } from '../../mcp-server/session-registry.js';
import { MAX_BROWSER_BATCH_CALLS } from '../../mcp-server/tools.js';

function fakeOpenSocket() {
  return {
    readyState: 1,
    sent: [],
    send(payload, callback = () => {}) {
      this.sent.push(JSON.parse(payload));
      callback();
    },
    close() {},
  };
}

describe('CiC bridge hardening', () => {
  it('rejects non-loopback extension connections before handshake listeners attach', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_remote',
      portStart: 47821,
      portEnd: 47821,
    });
    const socket = {
      closed: null,
      close(code, reason) {
        this.closed = { code, reason };
      },
      on() {
        throw new Error('remote sockets should be rejected before listeners are added');
      },
    };

    await bridge.handleConnection(socket, { socket: { remoteAddress: '192.168.1.20' } }, { nonce: 'nonce' });

    assert.deepEqual(socket.closed, { code: 4001, reason: 'loopback_only' });
    assert.equal(bridge.registry.isConnected(), false);
  });

  it('times out pending tool requests and removes them from the registry', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_timeout',
      portStart: 47821,
      portEnd: 47821,
      requestTimeoutMs: 5,
    });
    bridge.registry.setChannel({ socket: fakeOpenSocket(), port: 47821 });
    bridge.registry.markAuthenticated({ extensionInstanceId: 'install_a' });

    await assert.rejects(
      bridge.sendCommand('browser_list_tabs', {}),
      /Timed out waiting for browser_list_tabs result/,
    );
    assert.equal(bridge.registry.pendingRequests.size, 0);
  });

  it('fails all pending requests when the authenticated channel disconnects', async () => {
    const registry = new SessionRegistry({ sessionId: 'sess_disconnect' });
    const socket = fakeOpenSocket();
    registry.setChannel({ socket, port: 47821 });
    registry.markAuthenticated({ extensionInstanceId: 'install_a' });

    const pending = new Promise((resolve, reject) => {
      registry.addPendingRequest('req_1', {
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error('test leaked timer')), 1000),
      });
    });

    registry.clearChannel('socket_closed');

    await assert.rejects(pending, /Extension channel disconnected: socket_closed/);
    assert.equal(registry.pendingRequests.size, 0);
  });

  it('settles only known request IDs and ignores stray extension messages', () => {
    const registry = new SessionRegistry({ sessionId: 'sess_stray' });

    assert.equal(registry.settleRequest({ id: 'missing', type: 'result', result: { ok: true } }), false);
    assert.equal(registry.pendingRequests.size, 0);
  });

  it('uses safe numeric env parsing without accepting NaN or infinities', () => {
    assert.equal(parseEnvNumber('47829', 1), 47829);
    assert.equal(parseEnvNumber('not-a-number', 7), 7);
    assert.equal(parseEnvNumber('Infinity', 7), 7);
    assert.equal(parseEnvNumber('', 7), 7);
    assert.equal(parseEnvNumber('   ', 7), 7);
    assert.equal(parseEnvNumber('0', 7), 0);
  });

  it('runs browser_batch as a bounded MCP-side sequence without forwarding browser_batch to the extension', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_batch',
      portStart: 47821,
      portEnd: 47821,
    });
    const forwarded = [];
    bridge.sendExtensionCommand = async (tool, params) => {
      forwarded.push({ tool, params });
      return { echoedTool: tool, params };
    };

    const result = await bridge.sendCommand('browser_batch', {
      calls: [
        { tool: 'browser_list_tabs', label: 'before' },
        { tool: 'browser_wait', params: { selector: 'main', timeoutMs: 500 }, label: 'wait-main' },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.stopped, false);
    assert.deepEqual(forwarded.map((call) => call.tool), ['browser_list_tabs', 'browser_wait']);
    assert.deepEqual(result.results.map((entry) => [entry.label, entry.ok]), [
      ['before', true],
      ['wait-main', true],
    ]);
    assert.equal(result.timeoutMs, 30000);
  });

  it('stops browser_batch when the total timeout is exhausted', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_batch_timeout',
      portStart: 47821,
      portEnd: 47821,
      requestTimeoutMs: 100,
    });
    const forwarded = [];
    bridge.sendExtensionCommand = async (tool) => {
      forwarded.push(tool);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { tooLate: true };
    };

    const result = await bridge.sendCommand('browser_batch', {
      timeoutMs: 5,
      calls: [
        { tool: 'browser_list_tabs', label: 'slow-list' },
        { tool: 'browser_list_tabs', label: 'blocked-list' },
      ],
    });

    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.equal(result.stopIndex, 1);
    assert.equal(result.timeoutMs, 5);
    assert.deepEqual(forwarded, ['browser_list_tabs']);
    assert.equal(result.results[0].label, 'slow-list');
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].label, 'blocked-list');
    assert.equal(result.results[1].error.code, 'batch_timeout');
  });

  it('resolves browser_batch child params from earlier step results', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_batch_refs',
      portStart: 47821,
      portEnd: 47821,
    });
    const forwarded = [];
    bridge.sendExtensionCommand = async (tool, params) => {
      forwarded.push({ tool, params });
      if (tool === 'browser_create_tab') {
        return { tabId: 123, title: 'Created' };
      }
      return { ok: true, tabId: params.tabId };
    };

    const result = await bridge.sendCommand('browser_batch', {
      calls: [
        { tool: 'browser_create_tab', label: 'create', params: { url: 'https://example.com' } },
        { tool: 'browser_wait', label: 'wait', params: { tabId: { $ref: 'create.tabId' }, selector: 'main' } },
        { tool: 'browser_get_page_content', label: 'read', params: { tabId: '$prev.tabId', format: 'text' } },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(forwarded.map((call) => call.params.tabId), [undefined, 123, 123]);
  });

  it('rejects invalid or nested browser_batch child calls before they reach the extension', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_batch_invalid',
      portStart: 47821,
      portEnd: 47821,
    });
    bridge.sendExtensionCommand = async () => {
      throw new Error('invalid batch child should not reach extension');
    };

    const result = await bridge.sendCommand('browser_batch', {
      calls: [{ tool: 'browser_batch', params: { calls: [] } }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.equal(result.stopIndex, 0);
    assert.equal(result.results[0].error.code, 'invalid_batch_tool');
    await assert.rejects(
      bridge.sendCommand('browser_batch', {
        calls: Array.from({ length: MAX_BROWSER_BATCH_CALLS + 1 }, () => ({ tool: 'browser_list_tabs' })),
      }),
      /at most 25 child calls/,
    );
  });
});

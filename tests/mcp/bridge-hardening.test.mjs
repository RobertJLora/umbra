import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalBridgeServer, parseEnvNumber } from '../../mcp-server/bridge-core.js';
import { SessionRegistry } from '../../mcp-server/session-registry.js';
import { MAX_BROWSER_BATCH_CALLS } from '../../mcp-server/tools.js';
import { resolveBrokerRequestTimeoutMs } from '../../mcp-server/timeouts.js';

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

  it('arms the timeout the caller asked for instead of the fixed request timeout', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_per_call_timeout',
      portStart: 47821,
      portEnd: 47821,
      requestTimeoutMs: 60_000,
    });
    bridge.registry.setChannel({ socket: fakeOpenSocket(), port: 47821 });
    bridge.registry.markAuthenticated({ extensionInstanceId: 'install_a' });

    // The extension clamps browser_run_page_action waits to 90,000 ms, so a
    // plugin-driven export legitimately asks for 95,000 ms. Record what the
    // bridge arms and fire it immediately so the call settles inside the test.
    const armedDelays = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (handler, delay, ...args) => {
      armedDelays.push(delay);
      return realSetTimeout(handler, 0, ...args);
    };

    try {
      await assert.rejects(
        bridge.sendCommand('browser_run_page_action', { action: 'vendor_wait_ready', timeoutMs: 95_000 }),
        /Timed out waiting for browser_run_page_action result/,
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    const expected = resolveBrokerRequestTimeoutMs(60_000, { timeoutMs: 95_000 });
    assert.ok(expected >= 95_000, `the resolved timeout ${expected}ms must cover the 95,000ms request`);
    assert.ok(
      armedDelays.includes(expected),
      `armed delays ${JSON.stringify(armedDelays)} should include ${expected}`,
    );
    assert.ok(
      !armedDelays.includes(60_000),
      'the fixed request timeout must not be armed once the caller supplies a longer one',
    );
  });

  it('fills a batch child budget from the remaining time and never raises one the caller set', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_child_budget',
      portStart: 47821,
      portEnd: 47821,
    });
    const forwarded = [];
    bridge.sendExtensionCommand = async (tool, params) => {
      forwarded.push({ tool, params });
      return { ok: true };
    };

    const result = await bridge.sendCommand('browser_batch', {
      timeoutMs: 8_000,
      calls: [
        { tool: 'browser_wait', label: 'short', params: { selector: 'main', timeoutMs: 500 } },
        { tool: 'browser_navigate', label: 'unbudgeted', params: { url: 'https://example.com' } },
        { tool: 'browser_list_tabs', label: 'no-timeout-parameter' },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(forwarded[0].params.timeoutMs, 500);
    assert.ok(
      forwarded[1].params.timeoutMs > 0 && forwarded[1].params.timeoutMs <= 8_000,
      `browser_navigate should inherit the batch budget, got ${forwarded[1].params.timeoutMs}`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(forwarded[2].params, 'timeoutMs'),
      false,
      'a tool whose schema declares no timeoutMs must not receive one',
    );
  });

  it('gives each navigate_wait_read child its own slice of the composite budget', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_composite_slices',
      portStart: 47821,
      portEnd: 47821,
    });
    const forwarded = [];
    bridge.sendExtensionCommand = async (tool, params) => {
      forwarded.push({ tool, params });
      return tool === 'browser_navigate' ? { tabId: 42 } : { ok: true };
    };

    const result = await bridge.sendCommand('browser_navigate_wait_read', {
      url: 'https://example.com',
      waitSelector: 'main',
      timeoutMs: 15_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.timeoutMs, 15_000);
    // The composite hardcoded activate: false and declared no flag, so a caller
    // who wanted the tab in front had to abandon the recipe for three separate
    // calls. Default stays background, and the result says which it was.
    assert.equal(result.activated, false);
    assert.equal(forwarded.find((call) => call.tool === 'browser_navigate').params.activate, false);

    const foreground = await bridge.sendCommand('browser_navigate_wait_read', {
      url: 'https://example.com',
      waitSelector: 'main',
      timeoutMs: 15_000,
      activate: true,
    });
    assert.equal(foreground.activated, true);
    assert.equal(forwarded.filter((call) => call.tool === 'browser_navigate').at(-1).params.activate, true);

    const navigate = forwarded.find((call) => call.tool === 'browser_navigate');
    const wait = forwarded.find((call) => call.tool === 'browser_wait');
    assert.ok(
      navigate.params.timeoutMs > 0 && navigate.params.timeoutMs < 15_000,
      `navigate needs an explicit budget below the batch deadline, got ${navigate.params.timeoutMs}`,
    );
    assert.ok(
      wait.params.timeoutMs > 0 && wait.params.timeoutMs < 15_000,
      `wait needs its own slice rather than the whole deadline, got ${wait.params.timeoutMs}`,
    );
    assert.ok(
      navigate.params.timeoutMs + wait.params.timeoutMs < 15_000,
      'the waiting steps together must leave room for the read step',
    );
  });

  it('gives the two single-wait composites an explicit wait slice', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_single_wait_slices',
      portStart: 47821,
      portEnd: 47821,
    });
    const forwarded = [];
    bridge.sendExtensionCommand = async (tool, params) => {
      forwarded.push({ tool, params });
      return { ok: true };
    };

    for (const tool of ['browser_wait_click_read', 'browser_click_wait_selector_read']) {
      forwarded.length = 0;
      const result = await bridge.sendCommand(tool, {
        tabId: 7,
        waitSelector: 'main',
        clickSelector: 'button',
        timeoutMs: 20_000,
      });

      assert.equal(result.ok, true, `${tool} should complete`);
      const wait = forwarded.find((call) => call.tool === 'browser_wait');
      assert.ok(
        wait.params.timeoutMs > 0 && wait.params.timeoutMs < 20_000,
        `${tool} wait step needs its own slice, got ${wait.params.timeoutMs}`,
      );
    }
  });
});

describe('batch deadline enforcement', () => {
  it('a hung child cannot hold a batch past the deadline the caller declared', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'k',
      sessionId: 'sess_deadline',
      portStart: 1,
      portEnd: 1,
      requestTimeoutMs: 60_000,
    });
    // A channel that accepts the command and never answers, which is what a wedged
    // extension looks like from here.
    bridge.registry.channel = { socket: { send() {} }, authenticated: true };
    bridge.registry.isConnected = () => true;

    const startedAt = Date.now();
    const result = await bridge.sendBatch({
      timeoutMs: 1_000,
      stopOnError: false,
      calls: [
        { tool: 'browser_wait', params: { tabId: 1, selector: 'main' } },
        { tool: 'browser_get_page_content', params: { tabId: 1 } },
      ],
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 6_000, `a 1,000 ms batch held the caller for ${elapsed} ms`);
    assert.equal(result.ok, false);
    });

  it('composite slices leave the payload step a budget at a small deadline', async () => {
    const bridge = new LocalBridgeServer({
      sharedKey: 'k',
      sessionId: 'sess_slices',
      portStart: 1,
      portEnd: 1,
      requestTimeoutMs: 60_000,
    });

    const seen = [];
    bridge.registry.isConnected = () => true;
    bridge.sendExtensionCommand = async (tool, params) => {
      seen.push({ tool, timeoutMs: params.timeoutMs });
      return { tabId: 1 };
    };

    for (const totalMs of [1_200, 1_500, 2_000, 15_000]) {
      seen.length = 0;
      const result = await bridge.sendNavigateWaitRead({ url: 'https://example.com', waitSelector: 'main', timeoutMs: totalMs });
      const waiting = seen.filter((call) => typeof call.timeoutMs === 'number');
      const sum = waiting.reduce((total, call) => total + call.timeoutMs, 0);
      assert.ok(
        sum < totalMs,
        `at ${totalMs} ms the waiting steps claimed ${sum} ms, leaving nothing for the read step`,
      );
      assert.equal(result.results.length, 3, `the read step never ran at ${totalMs} ms`);
    }
    });
});

describe('batch reference resolution', () => {
  it('treats ordinary data that looks like a reference as the literal it is', async () => {
    const { resolveBatchParams } = await import('../../mcp-server/batch-refs.js');
    const results = [{ ok: true, label: 'create', result: { tabId: 42 } }];

    // A currency amount, a password, and a jQuery-style identifier are data. The
    // bare-string shorthand ran over every string in every child's params, so
    // these used to fail the whole batch while the same value sent outside a
    // batch went through untouched.
    for (const literal of ['$5', '$1250.00', '$Password1', '$config']) {
      assert.equal(resolveBatchParams(literal, results), literal);
    }

    // The shorthand still resolves when it points at something real.
    assert.equal(resolveBatchParams('$create.tabId', results), 42);
    assert.equal(resolveBatchParams('$prev.tabId', results), 42);

    // The documented object form still fails loudly, because there it is
    // unambiguous that a reference was intended.
    assert.throws(() => resolveBatchParams({ $ref: 'nope.tabId' }, results), /Could not resolve/);
  });
});

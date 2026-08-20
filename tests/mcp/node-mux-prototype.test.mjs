import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeMuxPrototype } from '../../mcp-server/node-mux-prototype.js';

describe('Node mux broker prototype', () => {
  it('advertises protocol v2 broker capabilities while preserving legacy fallback', () => {
    const mux = new NodeMuxPrototype({ maxInFlight: 3 });
    const ack = mux.attachExtension({ extensionInstanceId: 'install_test' });

    assert.equal(ack.protocolVersion, 2);
    assert.equal(ack.broker.mode, 'node-mux');
    assert.equal(ack.broker.legacyFallback, true);
    assert.equal(ack.broker.maxInFlight, 3);
    assert.equal(ack.broker.supportsBatch, true);
  });

  it('routes commands by session and settles pending results', async () => {
    const mux = new NodeMuxPrototype({ requestTimeoutMs: 100 });
    mux.attachExtension({ extensionInstanceId: 'install_test' });
    mux.registerShimSession('sess_a');
    mux.claimTab('sess_a', 101);

    const seen = [];
    mux.on('command', (command) => {
      seen.push(command);
      mux.settleResult(command.id, { ok: true, tabId: command.params.tabId });
    });

    const result = await mux.routeCommand({
      sessionId: 'sess_a',
      tool: 'browser_get_page_content',
      params: { tabId: 101 },
    });

    assert.deepEqual(result, { ok: true, tabId: 101 });
    assert.equal(seen[0].sessionId, 'sess_a');
    assert.equal(seen[0].sequence, 1);
    assert.equal(mux.health().pendingRequestCount, 0);
  });

  it('denies cross-session tab routing before it reaches the extension endpoint', async () => {
    const mux = new NodeMuxPrototype({ requestTimeoutMs: 100 });
    mux.attachExtension({ extensionInstanceId: 'install_test' });
    mux.registerShimSession('sess_a');
    mux.registerShimSession('sess_b');
    mux.claimTab('sess_a', 202);

    await assert.rejects(
      mux.routeCommand({
        sessionId: 'sess_b',
        tool: 'browser_get_page_content',
        params: { tabId: 202 },
      }),
      /does not own tab 202/,
    );
  });

  it('times out pending requests and reports health', async () => {
    const mux = new NodeMuxPrototype({ requestTimeoutMs: 5 });
    mux.attachExtension({ extensionInstanceId: 'install_test' });
    mux.registerShimSession('sess_timeout');

    await assert.rejects(
      mux.routeCommand({
        sessionId: 'sess_timeout',
        tool: 'browser_list_tabs',
      }),
      /Timed out waiting for mux request/,
    );

    const health = mux.health();
    assert.equal(health.mode, 'node-mux');
    assert.equal(health.extensionConnected, true);
    assert.equal(health.pendingRequestCount, 0);
    assert.equal(health.connectedSessionCount, 1);
  });

  it('disconnect and cleanup reject pending work and release owned tabs', async () => {
    const mux = new NodeMuxPrototype({ requestTimeoutMs: 100 });
    mux.attachExtension({ extensionInstanceId: 'install_test' });
    mux.registerShimSession('sess_cleanup');
    mux.claimTab('sess_cleanup', 303);

    const pending = mux.routeCommand({
      sessionId: 'sess_cleanup',
      tool: 'browser_list_tabs',
    });
    mux.disconnectShimSession('sess_cleanup', 'test_disconnect');
    await assert.rejects(pending, /test_disconnect/);

    mux.registerShimSession('sess_cleanup');
    mux.claimTab('sess_cleanup', 304);
    const cleanup = mux.cleanupSession('sess_cleanup');

    assert.deepEqual(cleanup.releasedTabIds, [303, 304]);
    assert.deepEqual(mux.sessionStatus('sess_cleanup').tabIds, []);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../../mcp-server/session-registry.js';

function createSocket() {
  return {
    readyState: 1,
    closeCalled: false,
    close() {
      this.closeCalled = true;
    },
  };
}

test('registry replaces a stale channel and marks authentication', () => {
  const registry = new SessionRegistry({ sessionId: 'sess_a' });
  const firstSocket = createSocket();
  const secondSocket = createSocket();

  registry.setChannel({ socket: firstSocket, port: 47821 });
  registry.setChannel({ socket: secondSocket, port: 47822 });
  assert.equal(firstSocket.closeCalled, true);

  registry.markAuthenticated({ extensionInstanceId: 'install_a' });
  const status = registry.getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.channel.port, 47822);
  assert.equal(status.channel.extensionInstanceId, 'install_a');
});

test('registry resolves and rejects pending requests', async () => {
  const registry = new SessionRegistry({ sessionId: 'sess_a' });

  const resolved = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('request timed out in test')), 250);
    registry.addPendingRequest('ok_1', { resolve, reject, timer });
    registry.settleRequest({
      type: 'result',
      id: 'ok_1',
      result: { ok: true },
    });
  });
  assert.deepEqual(resolved, { ok: true });

  await assert.rejects(
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('request timed out in test')), 250);
      registry.addPendingRequest('err_1', { resolve, reject, timer });
      registry.settleRequest({
        type: 'error',
        id: 'err_1',
        error: { code: 'boom', message: 'Bridge failed' },
      });
    }),
    /Bridge failed/,
  );
});

test('registry fails pending requests when the channel drops', async () => {
  const registry = new SessionRegistry({ sessionId: 'sess_a' });
  registry.setChannel({ socket: createSocket(), port: 47821 });
  registry.markAuthenticated();

  await assert.rejects(
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('request timed out in test')), 250);
      registry.addPendingRequest('drop_1', { resolve, reject, timer });
      registry.clearChannel('socket_closed');
    }),
    /socket_closed/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalBridgeServer } from '../../mcp-server/bridge-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function createSocket() {
  return {
    readyState: 1,
    closed: null,
    close(code, reason) {
      this.closed = { code, reason };
    },
    on() {
      throw new Error('duplicate connection should be rejected before listeners are attached');
    },
  };
}

test('bridge rejects duplicate scanner sockets while a healthy channel is connected', async () => {
  const bridge = new LocalBridgeServer({
    sharedKey: 'test-shared-key',
    sessionId: 'sess_duplicate',
    portStart: 47821,
    portEnd: 47821,
  });
  const existingSocket = createSocket();
  const duplicateSocket = createSocket();

  bridge.registry.setChannel({ socket: existingSocket, port: 47821 });
  bridge.registry.markAuthenticated({ extensionInstanceId: 'install_a' });

  await bridge.handleConnection(
    duplicateSocket,
    { socket: { remoteAddress: '127.0.0.1' } },
    { nonce: 'client_nonce' },
  );

  assert.deepEqual(duplicateSocket.closed, {
    code: 4005,
    reason: 'session_already_connected',
  });
  assert.equal(existingSocket.closed, null);
  assert.equal(bridge.registry.getStatus().channel.port, 47821);
});

test('bridge exposes listener health without needing a WebSocket bind', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'bridge-core.js'), 'utf8');

  assert.match(source, /url\.pathname === '\/healthz'/);
  assert.match(source, /extensionConnected: this\.registry\.isConnected\(\)/);
  assert.match(source, /channel: status\.channel/);
});

test('legacy bridge handshake still advertises protocol v1', async () => {
  const bridge = new LocalBridgeServer({
    sharedKey: 'test-shared-key',
    sessionId: 'sess_protocol_v1',
    portStart: 47821,
    portEnd: 47821,
  });
  const handlers = {};
  const socket = {
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
    close() {},
    on(event, handler) {
      handlers[event] = handler;
    },
  };

  await bridge.handleConnection(socket, { socket: { remoteAddress: '127.0.0.1' } }, { nonce: 'client_nonce' });
  handlers.close?.();

  assert.equal(socket.sent[0].type, 'hello_ack');
  assert.equal(socket.sent[0].sessionId, 'sess_protocol_v1');
  assert.equal(socket.sent[0].protocolVersion, 1);
});

test('protocol docs include v2 broker goldens while preserving legacy fallback', () => {
  const protocol = fs.readFileSync(path.join(repoRoot, 'MCP_PROTOCOL.md'), 'utf8');

  assert.match(protocol, /Legacy mode is protocol v1 and remains available/);
  assert.match(protocol, /Protocol v2 is broker mode/);
  assert.match(protocol, /Rust broker is now the launcher default/);
  assert.match(protocol, /UMBRA_BROKER_MODE=legacy/);
  assert.match(protocol, /\{"\$ref":"create\.tabId"\}/);
  assert.match(protocol, /"protocolVersion": 1/);
  assert.match(protocol, /"protocolVersion": 2/);
  assert.match(protocol, /"legacyFallback": true/);
  assert.match(protocol, /"supportsBatch": true/);
  assert.match(protocol, /"supportsSessionRouting": true/);
  assert.match(protocol, /"sessionId": "sess_abc123"/);
});

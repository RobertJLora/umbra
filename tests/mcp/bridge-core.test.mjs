import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalBridgeServer } from '../../mcp-server/bridge-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function createSocket() {
  const handlers = {};
  return {
    readyState: 1,
    closed: null,
    sent: [],
    handlers,
    send(payload, callback = () => {}) {
      this.sent.push(JSON.parse(payload));
      callback();
    },
    close(code, reason) {
      this.closed = { code, reason };
      handlers.close?.();
    },
    on(event, handler) {
      handlers[event] = handler;
    },
  };
}

function newBridge(sessionId, options = {}) {
  return new LocalBridgeServer({
    sharedKey: 'test-shared-key',
    sessionId,
    portStart: 47821,
    portEnd: 47821,
    ...options,
  });
}

test('a second extension connection supersedes the first instead of being refused', async () => {
  const bridge = newBridge('sess_supersede');
  const existingSocket = createSocket();
  const replacementSocket = createSocket();

  bridge.registry.setChannel({ socket: existingSocket, port: 47821 });
  bridge.registry.markAuthenticated({ extensionInstanceId: 'install_a' });

  // A command that is still in flight on the socket being displaced. It can
  // never be answered once that socket closes, so it must fail immediately
  // rather than wait out its transport timeout.
  const inFlight = new Promise((resolve, reject) => {
    bridge.registry.addPendingRequest('req_stale', {
      resolve,
      reject,
      timer: setTimeout(() => reject(new Error('test leaked timer')), 1_000),
      tool: 'browser_list_tabs',
    });
  });

  await bridge.handleConnection(
    replacementSocket,
    { socket: { remoteAddress: '127.0.0.1' } },
    { nonce: 'client_nonce' },
  );

  assert.deepEqual(existingSocket.closed, { code: 4000, reason: 'superseded' });
  assert.equal(replacementSocket.closed, null);
  assert.equal(bridge.registry.channel.socket, replacementSocket);
  assert.equal(replacementSocket.sent[0].type, 'hello_ack');
  await assert.rejects(inFlight, /Extension channel disconnected: superseded/);
});

test('bridge exposes listener health without needing a WebSocket bind', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'bridge-core.js'), 'utf8');

  assert.match(source, /url\.pathname === '\/healthz'/);
  assert.match(source, /extensionConnected: this\.registry\.isConnected\(\)/);
  assert.match(source, /channel: status\.channel/);
});

test('bridge source carries no home directory default and imports no local plugin', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'bridge-core.js'), 'utf8');

  assert.doesNotMatch(source, /\/Users\//);
  assert.match(source, /resolveDownloadDir/);
  // Plugin handlers arrive through the constructor. A static or dynamic import
  // of a plugin module would put a local-only file in the published package's
  // import graph, where it does not exist.
  assert.doesNotMatch(source, /['"]\.\/plugins\//);
  assert.doesNotMatch(source, /import\(/);
});

test('legacy bridge handshake still advertises protocol v1', async () => {
  const bridge = newBridge('sess_protocol_v1');
  const socket = createSocket();

  await bridge.handleConnection(socket, { socket: { remoteAddress: '127.0.0.1' } }, { nonce: 'client_nonce' });
  socket.handlers.close?.();

  assert.equal(socket.sent[0].type, 'hello_ack');
  assert.equal(socket.sent[0].sessionId, 'sess_protocol_v1');
  assert.equal(socket.sent[0].protocolVersion, 1);
});

test('an authenticated ping is answered with a pong', async () => {
  const bridge = newBridge('sess_keepalive');
  const socket = createSocket();

  await bridge.handleConnection(socket, { socket: { remoteAddress: '127.0.0.1' } }, { nonce: 'client_nonce' });
  bridge.registry.markAuthenticated({ extensionInstanceId: 'install_a', socket });

  socket.handlers.message(Buffer.from(JSON.stringify({ type: 'ping', id: 'keepalive_1' })));

  const pong = socket.sent.find((frame) => frame.type === 'pong');
  assert.ok(pong, `expected a pong frame, got ${JSON.stringify(socket.sent)}`);
  assert.equal(pong.id, 'keepalive_1');
  assert.equal(pong.sessionId, 'sess_keepalive');
  assert.equal(socket.closed, null);
});

test('a plugin handler answers its own tool and gets a sendCommand back into the bridge', async () => {
  const seen = [];
  const withPlugin = newBridge('sess_plugin_installed', {
    pluginHandlers: {
      browser_export_vendor: async (sendCommand, params) => {
        seen.push({ hasSendCommand: typeof sendCommand === 'function', params });
        return { ok: true, rowCount: 3 };
      },
      notAFunction: 'ignored',
    },
  });

  assert.deepEqual(await withPlugin.sendCommand('browser_export_vendor', { report: 'organic-keywords' }), {
    ok: true,
    rowCount: 3,
  });
  assert.deepEqual(seen, [{ hasSendCommand: true, params: { report: 'organic-keywords' } }]);
  assert.equal(withPlugin.pluginHandlers.has('notAFunction'), false);
});

test('a build with no plugins forwards an unknown tool to the extension instead of guessing', async () => {
  // Stands in for a published package, which has no plugins folder at all. The
  // tool is never advertised there, so nothing routes it locally and the call
  // takes the ordinary extension path, which is disconnected in this test.
  const withoutPlugins = newBridge('sess_no_plugins');
  assert.equal(withoutPlugins.pluginHandlers.size, 0);

  await assert.rejects(
    withoutPlugins.sendCommand('browser_export_vendor', {}),
    /extension/i,
  );
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

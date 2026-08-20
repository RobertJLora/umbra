import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const offscreenPath = path.join(repoRoot, 'extension', 'offscreen.js');
const offscreenSource = fs.readFileSync(offscreenPath, 'utf8');

function makeSocketClass(created) {
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeSocket.CONNECTING;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      created.push(this);
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.closed = true;
      this.readyState = FakeSocket.CLOSED;
    }

    emit(type, event) {
      const handler = this.listeners.get(type);
      return handler ? handler(event) : undefined;
    }

    frames() {
      return this.sent.map((payload) => JSON.parse(payload));
    }
  }

  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  FakeSocket.CLOSING = 2;
  FakeSocket.CLOSED = 3;
  return FakeSocket;
}

// Runs extension/offscreen.js inside a sandbox with stubbed chrome and
// WebSocket globals so the real scanner logic can be exercised. The single
// source transform drops the shared.js import, whose two helpers are supplied
// as sandbox globals instead, and appends a hook exposing the module-scoped
// functions the tests drive.
async function loadOffscreen(configOverrides = {}) {
  const created = [];
  const runtimeMessages = [];
  const FakeSocket = makeSocketClass(created);
  const config = {
    // Boot with the bridge disabled so module load takes the idle branch and
    // opens no sockets. Tests that need a connection call tryConnect directly.
    bridgeEnabled: false,
    sharedKey: '',
    portStart: 47821,
    portEnd: 47821,
    installId: 'install-test',
    ...configOverrides,
  };

  const sandbox = {
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          const response = message?.type === 'bridge_get_runtime_config'
            ? { config }
            : { ok: true };
          if (typeof callback === 'function') {
            callback(response);
            return undefined;
          }
          return Promise.resolve(response);
        },
        onMessage: { addListener() {} },
      },
      storage: { onChanged: { addListener() {} } },
    },
    WebSocket: FakeSocket,
    JSON,
    Date,
    Math,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener() {},
    computeHmacHex: async () => 'a'.repeat(64),
    randomHex: () => 'b'.repeat(32),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const source = `${offscreenSource.replace(/^import[^\n]*\n/, '')}
globalThis.__umbraTestHooks = {
  connections,
  closeExpiredConnection,
  sendKeepalivePing,
  tryConnect,
  resyncConnections,
  snapshotStatus,
  KEEPALIVE_PING_INTERVAL_MS,
  KEEPALIVE_TEARDOWN_MS,
};
`;
  vm.runInContext(source, sandbox, { filename: 'offscreen.js' });

  // Module load fires one resyncConnections pass. Let it finish before handing
  // the harness back, so its idle sweep cannot tear down a connection a test
  // opens afterwards.
  await new Promise((resolve) => setImmediate(resolve));

  return {
    ...sandbox.__umbraTestHooks,
    created,
    runtimeMessages,
    config,
    FakeSocket,
  };
}

// Walks an authenticated socket through the real handshake so the connection
// state under test is the state the shipping code builds.
async function connectAuthenticatedSocket(harness, port = 47821, { sendPong = true } = {}) {
  const config = { ...harness.config, bridgeEnabled: true, sharedKey: 'test-key' };
  await harness.tryConnect(port, config, 'install-test');

  const socket = harness.created.at(-1);
  socket.readyState = harness.FakeSocket.OPEN;
  await socket.emit('open');
  await socket.emit('message', {
    data: JSON.stringify({ type: 'hello_ack', sessionId: 'sess_a', serverNonce: 'server-nonce' }),
  });
  await socket.emit('message', {
    data: JSON.stringify({ type: 'bind_ack', sessionId: 'sess_a' }),
  });
  if (sendPong) {
    await socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
  }

  return { socket, connection: harness.connections.get(port) };
}

function idleBranchSource() {
  const start = offscreenSource.indexOf('if (!config.bridgeEnabled || !config.sharedKey) {');
  assert.notEqual(start, -1, 'idle branch not found in offscreen.js');
  const end = offscreenSource.indexOf('\n  }', start);
  assert.notEqual(end, -1, 'idle branch has no closing brace');
  return offscreenSource.slice(start, end);
}

describe('offscreen keepalive and status publishing', () => {
  it('sends a ping frame on an authenticated socket and holds off until the interval elapses', async () => {
    const harness = await loadOffscreen();
    const { socket, connection } = await connectAuthenticatedSocket(harness);

    const base = Date.now();
    assert.equal(harness.sendKeepalivePing(47821, connection, base), true);

    const pings = socket.frames().filter((frame) => frame.type === 'ping');
    assert.equal(pings.length, 1);

    assert.equal(harness.sendKeepalivePing(47821, connection, base + 1_000), false);
    assert.equal(socket.frames().filter((frame) => frame.type === 'ping').length, 1);

    assert.equal(
      harness.sendKeepalivePing(47821, connection, base + harness.KEEPALIVE_PING_INTERVAL_MS),
      true,
    );
    assert.equal(socket.frames().filter((frame) => frame.type === 'ping').length, 2);
  });

  it('never pings an unauthenticated socket', async () => {
    const harness = await loadOffscreen();
    const socketClass = harness.FakeSocket;
    const socket = new socketClass('ws://127.0.0.1:47821/bridge');
    socket.readyState = socketClass.OPEN;
    const connection = {
      socket,
      port: 47821,
      authenticated: false,
      createdAt: 0,
      openedAt: 0,
      lastMessageAt: 0,
      lastPingAt: 0,
      pongSeen: false,
    };

    assert.equal(harness.sendKeepalivePing(47821, connection, Date.now()), false);
    assert.deepEqual(socket.sent, []);
  });

  it('records a pong and then reaps the socket once it goes silent past the teardown window', async () => {
    const harness = await loadOffscreen();
    const { connection } = await connectAuthenticatedSocket(harness);

    assert.equal(connection.pongSeen, true);
    assert.ok(connection.lastMessageAt > 0);

    const now = Date.now();
    connection.lastMessageAt = now - (harness.KEEPALIVE_TEARDOWN_MS + 1_000);

    assert.equal(harness.closeExpiredConnection(47821, connection, now), true);
    assert.equal(harness.connections.has(47821), false);
    assert.equal(connection.socket.closed, true);
  });

  it('leaves a silent socket alone when the peer never answered a ping', async () => {
    const harness = await loadOffscreen();
    const { connection } = await connectAuthenticatedSocket(harness, 47821, { sendPong: false });

    assert.equal(connection.pongSeen, false);

    const now = Date.now();
    connection.lastMessageAt = now - (harness.KEEPALIVE_TEARDOWN_MS + 60_000);

    assert.equal(harness.closeExpiredConnection(47821, connection, now), false);
    assert.equal(harness.connections.has(47821), true);
  });

  it('reads lastMessageAt in a teardown condition gated on a seen pong', () => {
    assert.match(offscreenSource, /KEEPALIVE_PING_INTERVAL_MS = 15_000/);
    assert.match(offscreenSource, /KEEPALIVE_TEARDOWN_MS = 45_000/);
    assert.match(offscreenSource, /connection\.pongSeen === true/);
    assert.match(offscreenSource, /now - connection\.lastMessageAt > KEEPALIVE_TEARDOWN_MS/);
    assert.match(offscreenSource, /type: 'ping'/);
    assert.match(offscreenSource, /message\.type === 'pong'/);
    assert.match(offscreenSource, /state\.pongSeen = true/);
  });

  it('pings surviving connections on the same sweep that expires dead ones', () => {
    assert.match(offscreenSource, /closeExpiredConnection\(port, connection, now\)/);
    assert.match(offscreenSource, /sendKeepalivePing\(port, connection, now\)/);
  });

  it('publishes idle status through the throttle instead of forcing every tick', () => {
    const idleBranch = idleBranchSource();

    assert.match(idleBranch, /await publishStatus\(\);/);
    assert.doesNotMatch(idleBranch, /publishStatus\(\{[^)]*force/);
  });

  it('does not justify the keepalive with a network change', () => {
    assert.doesNotMatch(offscreenSource, /wi-?fi|ethernet|\bvpn\b|network (change|switch)/i);
  });
});

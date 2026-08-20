import { computeHmacHex, randomHex } from './shared.js';

const SCAN_TICK_MS = 2_000;
const IDLE_SCAN_PORT_BUDGET = 8;
const CONNECTED_SCAN_PORT_BUDGET = 8;
const STATUS_UPDATE_MIN_INTERVAL_MS = 15_000;
const DEBUG_UPDATE_MIN_INTERVAL_MS = 15_000;
const HEARTBEAT_MIN_INTERVAL_MS = 30_000;
const CONNECTING_TIMEOUT_MS = 4_000;
const UNAUTHENTICATED_OPEN_TIMEOUT_MS = 6_000;
const connections = new Map();
let nextScanIndex = 0;
let lastDesiredPortSignature = '';
let lastStatusSignature = '';
let lastStatusPublishedAt = 0;
let lastHeartbeatPublishedAt = 0;
const debugPublishedAtByKey = new Map();

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (response?.__error) {
        reject(new Error(response.__error.message || 'Background message failed.'));
        return;
      }
      resolve(response);
    });
  });
}

async function loadRuntimeConfig() {
  const response = await sendRuntimeMessage({ type: 'bridge_get_runtime_config' });
  return response.config;
}

async function setDebugStatus(status, options = {}) {
  const now = Date.now();
  const throttleKey = options.throttleKey || status.state || 'debug';
  const minIntervalMs = Number(options.minIntervalMs) || 0;
  const lastPublishedAt = debugPublishedAtByKey.get(throttleKey) || 0;
  if (!options.force && minIntervalMs > 0 && now - lastPublishedAt < minIntervalMs) {
    return;
  }
  debugPublishedAtByKey.set(throttleKey, now);

  await sendRuntimeMessage({
    type: 'bridge_debug_status',
    status: {
      updatedAt: now,
      ...status,
    },
  });
}

function snapshotStatus() {
  const sessions = [...connections.values()]
    .filter((connection) => connection.authenticated)
    .map((connection) => ({
      port: connection.port,
      sessionId: connection.sessionId,
      extensionInstanceId: connection.installId,
    }))
    .sort((left, right) => left.port - right.port);

  return {
    connectedCount: sessions.length,
    ports: sessions.map((session) => session.port),
    sessions,
    updatedAt: Date.now(),
  };
}

function statusSignature(status) {
  return JSON.stringify({
    connectedCount: status.connectedCount,
    ports: status.ports,
    sessions: status.sessions,
  });
}

function publishHeartbeat(extra = {}, options = {}) {
  const now = Date.now();
  if (!options.force && now - lastHeartbeatPublishedAt < HEARTBEAT_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }
  lastHeartbeatPublishedAt = now;

  return setDebugStatus({
    state: 'offscreen_heartbeat',
    message: 'Offscreen bridge scanner heartbeat.',
    connectionCount: connections.size,
    ...extra,
  }, {
    force: true,
    throttleKey: 'offscreen_heartbeat',
  });
}

async function publishStatus(options = {}) {
  const status = snapshotStatus();
  const signature = statusSignature(status);
  const now = Date.now();
  if (
    !options.force
    && signature === lastStatusSignature
    && now - lastStatusPublishedAt < STATUS_UPDATE_MIN_INTERVAL_MS
  ) {
    return status;
  }

  lastStatusSignature = signature;
  lastStatusPublishedAt = now;
  await sendRuntimeMessage({
    type: 'bridge_status_update',
    status,
  });
  return status;
}

function destroyConnection(port) {
  const connection = connections.get(port);
  if (!connection) {
    return;
  }

  try {
    connection.socket.close();
  } catch {
    // Ignore close errors on stale sockets.
  }

  connections.delete(port);
}

function closeExpiredConnection(port, connection, now = Date.now()) {
  if (
    connection.socket.readyState === WebSocket.CONNECTING
    && now - connection.createdAt > CONNECTING_TIMEOUT_MS
  ) {
    destroyConnection(port);
    return true;
  }

  if (
    connection.socket.readyState === WebSocket.OPEN
    && !connection.authenticated
    && now - connection.openedAt > UNAUTHENTICATED_OPEN_TIMEOUT_MS
  ) {
    destroyConnection(port);
    return true;
  }

  if (
    connection.socket.readyState === WebSocket.CLOSING
    || connection.socket.readyState === WebSocket.CLOSED
  ) {
    destroyConnection(port);
    return true;
  }

  return false;
}

function getDesiredPorts(config) {
  const desiredPorts = [];
  for (let port = config.portStart; port <= config.portEnd; port += 1) {
    desiredPorts.push(port);
  }
  return desiredPorts;
}

function selectPortsForScan(desiredPorts, authenticatedCount, forceFullScan = false) {
  if (desiredPorts.length === 0) {
    return [];
  }

  const desiredPortSignature = `${desiredPorts[0]}-${desiredPorts.at(-1)}:${desiredPorts.length}`;
  if (desiredPortSignature !== lastDesiredPortSignature) {
    nextScanIndex = 0;
    lastDesiredPortSignature = desiredPortSignature;
  }

  const budget = authenticatedCount > 0 ? CONNECTED_SCAN_PORT_BUDGET : IDLE_SCAN_PORT_BUDGET;
  const boundedBudget = Math.max(1, Math.min(desiredPorts.length, budget));
  if (forceFullScan || boundedBudget >= desiredPorts.length) {
    return desiredPorts;
  }

  const selected = [];
  for (let offset = 0; offset < desiredPorts.length && selected.length < boundedBudget; offset += 1) {
    selected.push(desiredPorts[(nextScanIndex + offset) % desiredPorts.length]);
  }
  nextScanIndex = (nextScanIndex + boundedBudget) % desiredPorts.length;
  return selected;
}

async function resyncConnections(options = {}) {
  let config;
  try {
    config = await loadRuntimeConfig();
  } catch (error) {
    await setDebugStatus({
      state: 'config_load_failed',
      message: error?.message || 'Failed to load bridge config.',
    }, { minIntervalMs: DEBUG_UPDATE_MIN_INTERVAL_MS, throttleKey: 'config_load_failed' }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));
    return;
  }
  const installId = config.installId;

  if (!config.bridgeEnabled || !config.sharedKey) {
    for (const port of [...connections.keys()]) {
      destroyConnection(port);
    }
    await publishStatus({ force: true });
    await setDebugStatus(
      { state: 'idle', message: 'Waiting for shared key or enabled bridge.' },
      { minIntervalMs: DEBUG_UPDATE_MIN_INTERVAL_MS, throttleKey: 'idle' },
    );
    return;
  }

  const desiredPorts = getDesiredPorts(config);
  const desiredPortSet = new Set(desiredPorts);

  for (const port of [...connections.keys()]) {
    if (!desiredPortSet.has(port)) {
      destroyConnection(port);
    }
  }

  const now = Date.now();
  for (const [port, connection] of [...connections.entries()]) {
    closeExpiredConnection(port, connection, now);
  }

  const authenticatedCount = [...connections.values()].filter((connection) => connection.authenticated).length;
  const scanPorts = selectPortsForScan(desiredPorts, authenticatedCount, options.forceFullScan === true);
  for (const port of scanPorts) {
    const existing = connections.get(port);
    if (existing && (existing.socket.readyState === WebSocket.OPEN || existing.socket.readyState === WebSocket.CONNECTING)) {
      continue;
    }
    void tryConnect(port, config, installId);
  }

  await publishStatus({ force: options.forceFullScan === true });
  await publishHeartbeat({
    ports: scanPorts,
    scanBudget: scanPorts.length,
    desiredPortCount: desiredPorts.length,
  });
  await setDebugStatus({
    state: 'scanning',
    message: `Scanning ${scanPorts.length}/${desiredPorts.length} local bridge session ports.`,
    ports: scanPorts,
    portRange: [config.portStart, config.portEnd],
    authenticatedCount,
  }, { minIntervalMs: DEBUG_UPDATE_MIN_INTERVAL_MS, throttleKey: 'scanning' });
}

async function tryConnect(port, config, installId) {
  const timestamp = Date.now();
  const nonce = randomHex(16);
  let socket;
  try {
    const mac = await computeHmacHex(config.sharedKey, `hello:${port}:${timestamp}:${nonce}`);
    socket = new WebSocket(`ws://127.0.0.1:${port}/bridge?ts=${timestamp}&nonce=${nonce}&mac=${mac}`);
  } catch (error) {
    await setDebugStatus({
      state: 'socket_create_failed',
      message: `Could not create WebSocket for port ${port}: ${error?.message || 'unknown error'}`,
      port,
    }).catch(() => {});
    return;
  }

  const state = {
    socket,
    port,
    nonce,
    createdAt: Date.now(),
    openedAt: 0,
    lastMessageAt: 0,
    authenticated: false,
    isBroker: false,
    installId,
    sessionId: null,
  };
  connections.set(port, state);

  socket.addEventListener('open', () => {
    state.openedAt = Date.now();
    void setDebugStatus({ state: 'socket_open', message: `Socket opened on port ${port}.` }, {
      minIntervalMs: DEBUG_UPDATE_MIN_INTERVAL_MS,
      throttleKey: 'socket_open',
    });
    socket.send(JSON.stringify({
      type: 'hello',
      extensionInstanceId: installId,
      version: '0.1.0',
    }));
  });

  socket.addEventListener('message', async (event) => {
    state.lastMessageAt = Date.now();
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'hello_ack') {
      state.isBroker = message.broker === true || Number(message.protocolVersion) >= 2;
      void setDebugStatus({ state: 'hello_ack', message: `Received hello_ack on port ${port}.`, sessionId: message.sessionId }, {
        force: true,
      });
      const proof = await computeHmacHex(
        config.sharedKey,
        `bind:${message.sessionId}:${nonce}:${message.serverNonce}`,
      );
      socket.send(JSON.stringify({
        type: 'bind',
        extensionInstanceId: installId,
        proof,
      }));
      return;
    }

    if (message.type === 'bind_ack') {
      state.authenticated = true;
      state.isBroker = state.isBroker || message.broker === true || Number(message.protocolVersion) >= 2;
      state.sessionId = message.sessionId;
      await setDebugStatus({ state: 'authenticated', message: `Authenticated on port ${port}.`, sessionId: message.sessionId }, {
        force: true,
      });
      if (!state.isBroker) {
        await chrome.runtime.sendMessage({
          type: 'bridge_session_connected',
          sessionId: message.sessionId,
          port,
        });
      }
      await publishStatus({ force: true });
      return;
    }

    if (message.type === 'session_disconnected') {
      const disconnectedSessionId = String(message.sessionId || '');
      if (disconnectedSessionId) {
        await chrome.runtime.sendMessage({
          type: 'bridge_session_disconnected',
          sessionId: disconnectedSessionId,
        }).catch(() => {});
      }
      return;
    }

    if (message.type !== 'command') {
      return;
    }

    const commandSessionId = String(message.sessionId || state.sessionId || '');
    if (!state.authenticated || !commandSessionId) {
      socket.send(JSON.stringify({
        type: 'error',
        id: message.id,
        error: {
          code: 'not_authenticated',
          message: 'Bridge command received before authentication completed.',
        },
      }));
      return;
    }

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'bridge_command',
        sessionId: commandSessionId,
        port,
        tool: message.tool,
        params: message.params || {},
      });

      if (result?.__error) {
        socket.send(JSON.stringify({
          type: 'error',
          id: message.id,
          error: result.__error,
        }));
        return;
      }

      socket.send(JSON.stringify({
        type: 'result',
        id: message.id,
        result,
      }));
    } catch (error) {
      socket.send(JSON.stringify({
        type: 'error',
        id: message.id,
        error: {
          code: 'background_error',
          message: error?.message || 'Background command failed.',
        },
      }));
    }
  });

  socket.addEventListener('close', async () => {
    const sessionId = state.sessionId;
    connections.delete(port);
    await setDebugStatus({
      state: 'closed',
      message: `Socket closed on port ${port}.`,
      sessionId: sessionId || null,
    });
    if (sessionId && !state.isBroker) {
      await chrome.runtime.sendMessage({
        type: 'bridge_session_disconnected',
        sessionId,
      }).catch(() => {});
    }
    await publishStatus({ force: true });
  });

  socket.addEventListener('error', () => {
    void setDebugStatus({ state: 'socket_error', message: `WebSocket error on port ${port}.` }, {
      minIntervalMs: DEBUG_UPDATE_MIN_INTERVAL_MS,
      throttleKey: 'socket_error',
    });
    try {
      socket.close();
    } catch {
      // Ignore socket close errors after failures.
    }
  });
}

globalThis.addEventListener('error', (event) => {
  void setDebugStatus({
    state: 'offscreen_error',
    message: event.message || 'Unhandled offscreen error.',
  }).catch(() => {});
});

globalThis.addEventListener('unhandledrejection', (event) => {
  void setDebugStatus({
    state: 'offscreen_unhandled_rejection',
    message: event.reason?.message || String(event.reason || 'Unhandled offscreen rejection.'),
  }).catch(() => {});
});

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    if (
      changes.sharedKey ||
      changes.portStart ||
      changes.portEnd ||
      changes.bridgeEnabled ||
      changes.installId
    ) {
      void resyncConnections({ forceFullScan: true });
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type !== 'bridge_resync_now') {
      return { ok: false };
    }

    await resyncConnections({ forceFullScan: true });
    return {
      ok: true,
      status: snapshotStatus(),
    };
  })()
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({
      __error: {
        code: 'offscreen_resync_failed',
        message: error?.message || 'Offscreen resync failed.',
      },
    }));

  return true;
});

void setDebugStatus({
  state: 'offscreen_boot',
  message: 'Offscreen bridge scanner started.',
}).catch(() => {});

setInterval(() => {
  void resyncConnections();
}, SCAN_TICK_MS);

void resyncConnections({ forceFullScan: true });

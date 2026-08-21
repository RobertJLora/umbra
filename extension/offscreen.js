import { computeHmacHex, randomHex } from './shared.js';

const SCAN_TICK_MS = 2_000;
const IDLE_SCAN_PORT_BUDGET = 8;
const CONNECTED_SCAN_PORT_BUDGET = 8;
const STATUS_UPDATE_MIN_INTERVAL_MS = 15_000;
const DEBUG_UPDATE_MIN_INTERVAL_MS = 15_000;
const HEARTBEAT_MIN_INTERVAL_MS = 30_000;
const CONNECTING_TIMEOUT_MS = 4_000;
const UNAUTHENTICATED_OPEN_TIMEOUT_MS = 6_000;
const KEEPALIVE_PING_INTERVAL_MS = 15_000;
const KEEPALIVE_TEARDOWN_MS = 45_000;
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

// Application-level keepalive, sender half. Browser JavaScript cannot send a
// WebSocket protocol ping and never surfaces a protocol pong to a message
// listener, so proving an authenticated socket is still alive takes a frame the
// message handler can see. This sends { type: 'ping' } and the peer answers
// { type: 'pong' }, which lands in the message listener and advances
// lastMessageAt. The failures it catches are sleep and wake, and a peer process
// that is running but no longer servicing its socket.
function sendKeepalivePing(port, connection, now = Date.now()) {
  if (connection.socket.readyState !== WebSocket.OPEN || !connection.authenticated) {
    return false;
  }
  if (now - connection.lastPingAt < KEEPALIVE_PING_INTERVAL_MS) {
    return false;
  }

  connection.lastPingAt = now;
  try {
    connection.socket.send(JSON.stringify({ type: 'ping', ts: now }));
  } catch {
    destroyConnection(port);
    return false;
  }
  return true;
}

function closeExpiredConnection(port, connection, now = Date.now()) {
  // An authenticated socket that answered at least one ping and has since gone
  // silent past KEEPALIVE_TEARDOWN_MS is dead even though readyState still
  // reports OPEN, and resyncConnections will not redial a port whose socket
  // reports OPEN, so the dead socket blocks its own replacement until it is
  // destroyed here. The pongSeen gate keeps this branch off any peer that never
  // answers a ping, so a companion server without a pong handler keeps the
  // previous behaviour instead of looping through a disconnect every 45 seconds.
  if (
    connection.socket.readyState === WebSocket.OPEN
    && connection.authenticated
    && connection.pongSeen === true
    && connection.lastMessageAt > 0
    && now - connection.lastMessageAt > KEEPALIVE_TEARDOWN_MS
  ) {
    destroyConnection(port);
    return true;
  }

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
    // Plain publishStatus, never forced. Forcing skipped the
    // STATUS_UPDATE_MIN_INTERVAL_MS throttle, so an install with no shared key
    // wrote an identical status to chrome.storage.local on every scan tick.
    await publishStatus();
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
    if (closeExpiredConnection(port, connection, now)) {
      continue;
    }
    sendKeepalivePing(port, connection, now);
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
    lastPingAt: 0,
    pongSeen: false,
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

    // Keepalive receiver half. The assignment to lastMessageAt above already
    // recorded that this socket is alive; pongSeen records that the peer
    // understands the ping frame, which is what arms the teardown branch in
    // closeExpiredConnection.
    if (message.type === 'pong') {
      state.pongSeen = true;
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

// --- GIF frame store and encoder -------------------------------------------
// Recorded frames live here rather than in the service worker: MV3 evicts the
// worker after roughly thirty seconds idle and a buffer held in worker memory
// would go with it. This document is a real page and is never evicted, so the
// only thing that ends a recording early is the document itself closing, which
// happens when the bridge is disabled or the shared key is cleared.

// 24 MB of GIF is roughly 32 MB of base64, comfortably inside the 64 MiB
// message ceiling the WebSocket layer inherits. Past that the export fails with
// a message naming the four parameters that bring it down instead of killing
// the connection.
const MAX_GIF_BYTES = 24 * 1024 * 1024;
const GIF_MAX_STORED_FRAMES = 300;
const GIF_DEFAULT_MAX_FRAMES = 120;
const GIF_DEFAULT_MAX_WIDTH = 800;
const GIF_MIN_FRAME_DELAY_MS = 40;
const GIF_MAX_FRAME_DELAY_MS = 2_000;
// How many frames after a click keep drawing its marker, at falling opacity, so
// a click is visible in the exported animation rather than gone in one frame.
const GIF_CLICK_TRAIL_FRAMES = 2;
const GIF_CLICK_COLOR = '#ff8a3d';
const GIF_DRAG_COLOR = '#e5484d';

// tabId -> { frames: [], droppedFrames, truncatedFrames }
const gifFrameStores = new Map();

function gifStore(tabId) {
  let store = gifFrameStores.get(tabId);
  if (!store) {
    store = { frames: [], droppedFrames: 0, truncatedFrames: false };
    gifFrameStores.set(tabId, store);
  }
  return store;
}

function base64ToBytes(payload) {
  const raw = String(payload || '');
  const comma = raw.startsWith('data:') ? raw.indexOf(',') : -1;
  const binary = atob(comma >= 0 ? raw.slice(comma + 1) : raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function gifBase64FromBytes(bytes) {
  // Fixed windows joined once, the same shape the screenshot encoder in the
  // background worker uses. A per-byte append on a 20 MB animation spends most
  // of its time flattening a rope.
  const chunkSize = 32_768;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

// A frame is stored as a downscaled PNG rather than as raw pixels. Raw pixels
// for the default 120 frames at 800 px wide is roughly 190 MB resident in this
// document; the same frames as PNG are around a tenth of that, and the only
// cost is one decode per frame at export, which happens once.
async function storeGifFrame({ tabId, dataUrl, maxWidth, maxFrames, meta }) {
  const store = gifStore(tabId);
  const limit = Math.min(
    GIF_MAX_STORED_FRAMES,
    Math.max(2, Number(maxFrames) || GIF_DEFAULT_MAX_FRAMES),
  );
  const targetWidth = Math.max(160, Number(maxWidth) || GIF_DEFAULT_MAX_WIDTH);

  const source = await createImageBitmap(new Blob([base64ToBytes(dataUrl)], { type: 'image/png' }));
  const scale = Math.min(1, targetWidth / source.width);
  // Even width and height: some GIF decoders cope badly with odd dimensions
  // after a palette pass, and the rounding costs at most one pixel.
  const width = Math.max(2, Math.round(source.width * scale / 2) * 2);
  const height = Math.max(2, Math.round(source.height * scale / 2) * 2);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(source, 0, 0, width, height);
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  source.close();

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  store.frames.push({
    blob,
    width,
    height,
    sourceWidth,
    sourceHeight,
    meta: meta && typeof meta === 'object' ? meta : {},
  });

  while (store.frames.length > limit) {
    store.frames.shift();
    store.droppedFrames += 1;
    store.truncatedFrames = true;
  }

  return store;
}

function gifFrameDelays(frames, fps) {
  const fallback = Math.round(1000 / Math.min(10, Math.max(1, Number(fps) || 4)));
  return frames.map((frame, index) => {
    const next = frames[index + 1];
    const gap = next ? Number(next.meta?.ts) - Number(frame.meta?.ts) : fallback;
    if (!Number.isFinite(gap)) {
      return fallback;
    }
    return Math.min(GIF_MAX_FRAME_DELAY_MS, Math.max(GIF_MIN_FRAME_DELAY_MS, Math.round(gap)));
  });
}

function isGifClickKind(kind) {
  return ['click', 'rightClick', 'double', 'triple'].includes(String(kind || ''));
}

function drawGifRoundedPlate(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  context.fill();
}

// Frame metadata carries CSS pixel coordinates while the capture is in device
// pixels, so every point is mapped through the ratio the recording read once at
// start plus the downscale this document applied.
function gifCssToCanvas(frame) {
  const dpr = Number(frame.meta?.dpr);
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return (frame.width * ratio) / Math.max(1, frame.sourceWidth);
}

function drawGifOverlays(context, frames, index, { watermark }) {
  const frame = frames[index];
  const scale = gifCssToCanvas(frame);
  const { width, height } = frame;

  // Click marker on the frame that carried the click and the two after it, at
  // falling opacity, so it survives long enough to read at four frames a second.
  for (let back = 0; back <= GIF_CLICK_TRAIL_FRAMES; back += 1) {
    const source = frames[index - back];
    if (!source || !isGifClickKind(source.meta?.kind)) {
      continue;
    }
    const x = Number(source.meta.x) * scale;
    const y = Number(source.meta.y) * scale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    context.save();
    context.globalAlpha = 1 - (back / (GIF_CLICK_TRAIL_FRAMES + 1));
    context.strokeStyle = GIF_CLICK_COLOR;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x, y, 18, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    break;
  }

  if (String(frame.meta?.kind || '') === 'drag') {
    const x1 = Number(frame.meta.x) * scale;
    const y1 = Number(frame.meta.y) * scale;
    const x2 = Number(frame.meta.endX) * scale;
    const y2 = Number(frame.meta.endY) * scale;
    if ([x1, y1, x2, y2].every((value) => Number.isFinite(value))) {
      context.save();
      context.strokeStyle = GIF_DRAG_COLOR;
      context.fillStyle = GIF_DRAG_COLOR;
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      context.beginPath();
      context.moveTo(x2, y2);
      context.lineTo(x2 - (12 * Math.cos(angle - 0.4)), y2 - (12 * Math.sin(angle - 0.4)));
      context.lineTo(x2 - (12 * Math.cos(angle + 0.4)), y2 - (12 * Math.sin(angle + 0.4)));
      context.closePath();
      context.fill();
      context.restore();
    }
  }

  const label = typeof frame.meta?.label === 'string' ? frame.meta.label.slice(0, 60) : '';
  if (label) {
    context.save();
    context.font = '13px system-ui, -apple-system, Segoe UI, sans-serif';
    context.textBaseline = 'middle';
    const textWidth = context.measureText(label).width;
    context.fillStyle = 'rgba(0, 0, 0, 0.7)';
    drawGifRoundedPlate(context, 12, 12, textWidth + 20, 26, 6);
    context.fillStyle = '#ffffff';
    context.fillText(label, 22, 25);
    context.restore();
  }

  context.save();
  context.fillStyle = 'rgba(0, 0, 0, 0.35)';
  context.fillRect(0, height - 4, width, 4);
  context.fillStyle = GIF_CLICK_COLOR;
  context.fillRect(0, height - 4, width * ((index + 1) / frames.length), 4);
  context.restore();

  const mark = typeof watermark === 'string' ? watermark.slice(0, 40) : '';
  if (mark) {
    context.save();
    context.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    context.textAlign = 'right';
    context.textBaseline = 'alphabetic';
    context.fillStyle = 'rgba(255, 255, 255, 0.55)';
    context.fillText(mark, width - 10, height - 12);
    context.restore();
  }
}

// Loaded here rather than at the top of the file. This document holds the bridge
// sockets and runs the port scanner, so a static import of the vendored encoder
// made a missing, truncated or half-copied gifenc.js stop the whole module from
// evaluating and take the transport down with it. As a dynamic import a broken
// encoder costs one tool call and nothing else. The CSP is script-src 'self',
// which allows a same-origin dynamic import.
let gifencModulePromise = null;

function loadGifenc() {
  if (!gifencModulePromise) {
    gifencModulePromise = import('./vendor/gifenc.js').catch((error) => {
      gifencModulePromise = null;
      const failure = new Error(`The vendored GIF encoder could not be loaded: ${error?.message || error}`);
      failure.code = 'gif_encoder_unavailable';
      throw failure;
    });
  }
  return gifencModulePromise;
}

async function encodeGif(tabId, { quality, overlays, watermark, fps }) {
  const { GIFEncoder, quantize, applyPalette } = await loadGifenc();
  const store = gifFrameStores.get(tabId);
  const frames = store?.frames || [];
  if (frames.length === 0) {
    const error = new Error('No frames to export. Start a recording on this tab first.');
    error.code = 'gif_no_frames';
    throw error;
  }

  const { width, height } = frames[0];
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  // The 1 to 30 scale runs from a full 256 colour palette down to a small one
  // that encodes fast and small, which is the same direction the scale runs in
  // the tool that inspired it.
  const paletteSize = Math.max(8, Math.round(256 - ((Math.min(30, Math.max(1, Number(quality) || 10)) - 1) * 8)));
  const delays = gifFrameDelays(frames, fps);
  const encoder = GIFEncoder();
  const startedAt = Number(frames[0].meta?.ts) || 0;
  const endedAt = Number(frames[frames.length - 1].meta?.ts) || startedAt;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const bitmap = await createImageBitmap(frame.blob);
    context.clearRect(0, 0, width, height);
    // Every frame is drawn to the first frame's box. A window resized mid
    // recording changes the capture size, and a GIF has one canvas size.
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    if (overlays !== false) {
      drawGifOverlays(context, frames, index, { watermark });
    }

    const { data } = context.getImageData(0, 0, width, height);
    const palette = quantize(data, paletteSize);
    const indexed = applyPalette(data, palette);
    encoder.writeFrame(indexed, width, height, { palette, delay: delays[index] });
  }

  encoder.finish();
  const bytes = encoder.bytesView();
  if (bytes.length > MAX_GIF_BYTES) {
    const error = new Error(
      `The encoded animation is ${bytes.length} bytes, over the ${MAX_GIF_BYTES} byte ceiling. Reduce fps, maxFrames or maxWidth, or raise quality, then export again.`,
    );
    error.code = 'gif_too_large';
    throw error;
  }

  return {
    data: gifBase64FromBytes(bytes),
    bytes: bytes.length,
    frameCount: frames.length,
    droppedFrames: store.droppedFrames,
    truncatedFrames: store.truncatedFrames === true,
    durationMs: Math.max(0, endedAt - startedAt),
    width,
    height,
  };
}

const GIF_MESSAGE_TYPES = new Set(['gif_frame', 'gif_export', 'gif_clear', 'gif_status']);

async function handleGifMessage(message) {
  const tabId = Number(message?.tabId);
  if (!Number.isInteger(tabId)) {
    const error = new Error('A recorder message needs a tabId.');
    error.code = 'gif_bad_tab';
    throw error;
  }

  if (message.type === 'gif_frame') {
    const store = await storeGifFrame({
      tabId,
      dataUrl: message.dataUrl,
      maxWidth: message.maxWidth,
      maxFrames: message.maxFrames,
      meta: message.meta,
    });
    return {
      ok: true,
      frameCount: store.frames.length,
      droppedFrames: store.droppedFrames,
      truncatedFrames: store.truncatedFrames === true,
    };
  }

  if (message.type === 'gif_clear') {
    const had = gifFrameStores.has(tabId);
    gifFrameStores.delete(tabId);
    return { ok: true, cleared: had };
  }

  if (message.type === 'gif_status') {
    const store = gifFrameStores.get(tabId);
    return {
      ok: true,
      frameCount: store ? store.frames.length : 0,
      droppedFrames: store ? store.droppedFrames : 0,
      truncatedFrames: store?.truncatedFrames === true,
    };
  }

  return { ok: true, ...(await encodeGif(tabId, message)) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only bridge_resync_now and the recorder messages belong to this document.
  // Returning false for everything else leaves the reply channel to the
  // background worker; answering here raced it and handed callers a response
  // with no config.
  const isGifMessage = GIF_MESSAGE_TYPES.has(message?.type);
  if (message?.type !== 'bridge_resync_now' && !isGifMessage) {
    return false;
  }
  (async () => {
    if (isGifMessage) {
      return await handleGifMessage(message);
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
        code: error?.code || (isGifMessage ? 'gif_offscreen_failed' : 'offscreen_resync_failed'),
        message: error?.message || (isGifMessage ? 'Recorder call failed.' : 'Offscreen resync failed.'),
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

// The service worker has no DOM, so this document reports the OS color scheme
// for toolbar icon switching and re-reports whenever it changes. Guarded
// because the test harness runs this file in a Node vm with no window.
const colorSchemeQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function reportColorScheme() {
  if (!colorSchemeQuery) {
    return;
  }
  void sendRuntimeMessage({ type: 'bridge_color_scheme', dark: colorSchemeQuery.matches }).catch(() => {});
}

if (colorSchemeQuery) {
  colorSchemeQuery.addEventListener('change', reportColorScheme);
  reportColorScheme();
}

import { EventEmitter } from 'node:events';

export class NodeMuxPrototype extends EventEmitter {
  constructor({ requestTimeoutMs = 15_000, maxInFlight = 16 } = {}) {
    super();
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxInFlight = maxInFlight;
    this.extension = null;
    this.sessions = new Map();
    this.pending = new Map();
    this.nextSequence = 1;
  }

  attachExtension({ extensionInstanceId = 'unknown_install' } = {}) {
    this.extension = {
      extensionInstanceId,
      connected: true,
      connectedAt: Date.now(),
    };
    this.emit('extension_connected', this.extension);
    return this.helloAck();
  }

  helloAck() {
    return {
      type: 'hello_ack',
      protocolVersion: 2,
      broker: {
        mode: 'node-mux',
        legacyFallback: true,
        maxInFlight: this.maxInFlight,
        supportsBatch: true,
      },
    };
  }

  registerShimSession(sessionId) {
    if (!sessionId) {
      throw new Error('registerShimSession requires sessionId.');
    }
    const session = this.sessions.get(sessionId) || {
      sessionId,
      connected: true,
      registeredAt: Date.now(),
      tabIds: new Set(),
    };
    session.connected = true;
    this.sessions.set(sessionId, session);
    this.emit('session_registered', { sessionId });
    return this.sessionStatus(sessionId);
  }

  disconnectShimSession(sessionId, reason = 'shim_disconnected') {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.connected = false;
    this.rejectPendingForSession(sessionId, reason);
    this.emit('session_disconnected', { sessionId, reason });
    return true;
  }

  cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { sessionId, releasedTabIds: [] };
    }
    const releasedTabIds = [...session.tabIds];
    session.tabIds.clear();
    this.rejectPendingForSession(sessionId, 'session_cleanup');
    return { sessionId, releasedTabIds };
  }

  claimTab(sessionId, tabId) {
    const session = this.requireConnectedSession(sessionId);
    const owner = this.findTabOwner(tabId);
    if (owner && owner !== sessionId) {
      throw new Error(`Tab ${tabId} is already owned by ${owner}.`);
    }
    session.tabIds.add(Number(tabId));
    return { sessionId, tabId: Number(tabId) };
  }

  async routeCommand({ sessionId, tool, params = {} } = {}) {
    if (!this.extension?.connected) {
      throw new Error('No extension endpoint is connected.');
    }
    const session = this.requireConnectedSession(sessionId);
    if (params.tabId !== undefined) {
      const tabId = Number(params.tabId);
      if (!session.tabIds.has(tabId)) {
        throw new Error(`Session ${sessionId} does not own tab ${tabId}.`);
      }
    }
    if (this.pending.size >= this.maxInFlight) {
      throw new Error(`Node mux has ${this.pending.size} pending requests, max ${this.maxInFlight}.`);
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const requestId = `mux_${sequence}`;
    const routed = {
      type: 'command',
      id: requestId,
      sequence,
      sessionId,
      tool,
      params,
      deadlineMs: this.requestTimeoutMs,
    };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`Timed out waiting for mux request ${requestId}.`);
        error.code = 'mux_timeout';
        reject(error);
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { sessionId, resolve, reject, timer, routed });
      this.emit('command', routed);
    });
  }

  settleResult(requestId, result) {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(result);
    return true;
  }

  settleError(requestId, error) {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
    return true;
  }

  health() {
    const sessions = [...this.sessions.values()].map((session) => this.serializeSession(session));
    return {
      ok: true,
      mode: 'node-mux',
      protocolVersion: 2,
      extensionConnected: this.extension?.connected === true,
      extensionInstanceId: this.extension?.extensionInstanceId || null,
      sessionCount: sessions.length,
      connectedSessionCount: sessions.filter((session) => session.connected).length,
      pendingRequestCount: this.pending.size,
      sessions,
    };
  }

  sessionStatus(sessionId) {
    return this.serializeSession(this.requireSession(sessionId));
  }

  requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown mux session: ${sessionId}.`);
    }
    return session;
  }

  requireConnectedSession(sessionId) {
    const session = this.requireSession(sessionId);
    if (!session.connected) {
      throw new Error(`Mux session is disconnected: ${sessionId}.`);
    }
    return session;
  }

  findTabOwner(tabId) {
    const normalizedTabId = Number(tabId);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.tabIds.has(normalizedTabId)) {
        return sessionId;
      }
    }
    return null;
  }

  rejectPendingForSession(sessionId, reason) {
    for (const [requestId, pending] of [...this.pending.entries()]) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error(`Mux session ${sessionId} closed: ${reason}.`));
    }
  }

  serializeSession(session) {
    return {
      sessionId: session.sessionId,
      connected: session.connected,
      tabIds: [...session.tabIds].sort((left, right) => left - right),
      registeredAt: session.registeredAt,
    };
  }
}

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

export class SessionRegistry extends EventEmitter {
  constructor({ sessionId, requestTimeoutMs = 60_000 } = {}) {
    super();
    this.sessionId = sessionId;
    this.requestTimeoutMs = requestTimeoutMs;
    this.channel = null;
    this.pendingRequests = new Map();
  }

  setChannel(channel) {
    if (this.channel?.socket && this.channel.socket !== channel.socket) {
      try {
        this.channel.socket.close(4000, 'superseded');
      } catch {
        // Ignore close failures on stale sockets.
      }
    }

    this.channel = {
      ...channel,
      authenticated: false,
      connectedAt: Date.now(),
    };
    this.emit('connected', this.getStatus());
  }

  markAuthenticated(metadata = {}) {
    if (!this.channel) {
      throw new Error('Cannot authenticate a missing channel.');
    }

    this.channel = {
      ...this.channel,
      ...metadata,
      authenticated: true,
      authenticatedAt: Date.now(),
    };
    this.emit('authenticated', this.getStatus());
  }

  clearChannel(reason = 'disconnect') {
    if (!this.channel) {
      return;
    }

    const error = new Error(`Extension channel disconnected: ${reason}`);
    this.failPendingRequests(error);
    this.channel = null;
    this.emit('disconnected', { sessionId: this.sessionId, reason });
  }

  getStatus() {
    return {
      sessionId: this.sessionId,
      connected: this.isConnected(),
      channel: this.channel
        ? {
            port: this.channel.port,
            extensionInstanceId: this.channel.extensionInstanceId ?? null,
            connectedAt: this.channel.connectedAt,
            authenticated: this.channel.authenticated === true,
            authenticatedAt: this.channel.authenticatedAt ?? null,
          }
        : null,
    };
  }

  isConnected() {
    return Boolean(
      this.channel &&
        this.channel.authenticated &&
        this.channel.socket &&
        this.channel.socket.readyState === WebSocket.OPEN,
    );
  }

  addPendingRequest(id, request) {
    this.pendingRequests.set(id, request);
  }

  settleRequest(message) {
    if (!message?.id || !this.pendingRequests.has(message.id)) {
      return false;
    }

    const pending = this.pendingRequests.get(message.id);
    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timer);

    if (message.type === 'result') {
      pending.resolve(message.result ?? {});
      return true;
    }

    if (message.type === 'error') {
      const error = new Error(message.error?.message || 'Bridge command failed.');
      error.code = message.error?.code;
      pending.reject(error);
      return true;
    }

    return false;
  }

  failPendingRequests(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

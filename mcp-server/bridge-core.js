import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createNonce, validateBindProof, validateHelloQuery } from './auth.js';
import { SessionRegistry } from './session-registry.js';
import { TabOwnershipStore } from './tab-ownership.js';
import { MAX_BROWSER_BATCH_CALLS, assertLocalUploadFile, getToolDefinition, isMcpLocalTool } from './tools.js';
import { runAhrefsExport } from './ahrefs-export.js';
import { resolveBatchParams } from './batch-refs.js';
import { FileDownloadLedger } from './download-ledger.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BIND_TIMEOUT_MS = 5_000;
const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_DIR = '/Users/RobertLora/Documents/Downloads';

export class LocalBridgeServer {
  constructor({
    sharedKey,
    sessionId,
    portStart,
    portEnd,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    bindTimeoutMs = DEFAULT_BIND_TIMEOUT_MS,
  }) {
    this.sharedKey = sharedKey;
    this.sessionId = sessionId;
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.bindTimeoutMs = bindTimeoutMs;
    this.registry = new SessionRegistry({ sessionId, requestTimeoutMs });
    this.ownership = new TabOwnershipStore();
    this.httpServer = null;
    this.websocketServer = null;
    this.port = null;

    this.registry.on('connected', (status) => {
      console.error(
        `[umbra] extension socket connected for ${status.sessionId} on port ${status.channel?.port ?? 'unknown'}`,
      );
    });
    this.registry.on('authenticated', (status) => {
      console.error(
        `[umbra] extension authenticated for ${status.sessionId} (${status.channel?.extensionInstanceId ?? 'unknown_install'})`,
      );
    });
    this.registry.on('disconnected', ({ sessionId, reason }) => {
      console.error(`[umbra] extension disconnected for ${sessionId}: ${reason}`);
    });
  }

  async start() {
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      const started = await this.tryStartPort(port);
      if (started) {
        this.port = port;
        return port;
      }
    }

    throw new Error(`No free bridge port found in ${this.portStart}-${this.portEnd}.`);
  }

  async tryStartPort(port) {
    const httpServer = http.createServer((request, response) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      if (url.pathname === '/healthz') {
        const status = this.registry.getStatus();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          name: 'umbra',
          sessionId: this.sessionId,
          port,
          extensionConnected: this.registry.isConnected(),
          channel: status.channel,
        }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'umbra listens on WebSocket /bridge only.' }));
    });

    const websocketServer = new WebSocketServer({ noServer: true });
    websocketServer.on('connection', (socket, request, hello) => {
      this.handleConnection(socket, request, hello).catch((error) => {
        console.error(`[bridge] connection failed: ${error.message}`);
        try {
          socket.close(4003, 'handshake_failed');
        } catch {
          // Ignore close failures on rejected handshakes.
        }
      });
    });

    httpServer.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
        if (url.pathname !== '/bridge') {
          socket.destroy();
          return;
        }

        const hello = validateHelloQuery({
          port,
          searchParams: url.searchParams,
          sharedKey: this.sharedKey,
        });

        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          websocketServer.emit('connection', websocket, request, hello);
        });
      } catch (error) {
        console.error(
          `[umbra] rejected upgrade on port ${port}: ${error?.message || 'invalid bridge upgrade'}`,
        );
        socket.destroy();
      }
    });

    try {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => resolve());
      });
    } catch (error) {
      httpServer.close();
      if (error?.code === 'EADDRINUSE') {
        return false;
      }
      throw error;
    }

    this.httpServer = httpServer;
    this.websocketServer = websocketServer;
    return true;
  }

  async handleConnection(socket, request, hello) {
    const remoteAddress = request.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') {
      socket.close(4001, 'loopback_only');
      return;
    }

    if (this.registry.isConnected()) {
      socket.close(4005, 'session_already_connected');
      return;
    }

    const serverNonce = createNonce();
    const bindTimer = setTimeout(() => {
      socket.close(4002, 'bind_timeout');
    }, this.bindTimeoutMs);

    this.registry.setChannel({
      socket,
      port: this.port,
      remoteAddress,
      clientNonce: hello.nonce,
      serverNonce,
    });

    socket.send(JSON.stringify({
      type: 'hello_ack',
      sessionId: this.sessionId,
      serverNonce,
      protocolVersion: 1,
    }));

    socket.on('message', (buffer) => {
      let message;
      try {
        message = JSON.parse(buffer.toString('utf8'));
      } catch {
        return;
      }

      if (!this.registry.channel?.authenticated) {
        if (message.type === 'hello') {
          return;
        }

        if (message.type !== 'bind') {
          socket.close(4003, 'bind_required');
          return;
        }

        const valid = validateBindProof({
          sharedKey: this.sharedKey,
          sessionId: this.sessionId,
          clientNonce: hello.nonce,
          serverNonce,
          receivedProof: message.proof,
        });

        if (!valid) {
          socket.close(4004, 'invalid_bind');
          return;
        }

        clearTimeout(bindTimer);
        this.registry.markAuthenticated({
          extensionInstanceId: message.extensionInstanceId || null,
          socket,
        });
        this.ownership.ensureSession(this.sessionId);
        socket.send(JSON.stringify({
          type: 'bind_ack',
          sessionId: this.sessionId,
          ready: true,
        }));
        return;
      }

      this.registry.settleRequest(message);
    });

    socket.on('close', () => {
      clearTimeout(bindTimer);
      if (this.registry.channel?.socket === socket) {
        this.registry.clearChannel('socket_closed');
        this.ownership.detachSession(this.sessionId);
      }
    });

    socket.on('error', () => {
      clearTimeout(bindTimer);
    });
  }

  async stop() {
    if (this.websocketServer) {
      for (const client of this.websocketServer.clients) {
        try {
          client.terminate();
        } catch {
          // Ignore stale client shutdown errors.
        }
      }
    }

    this.registry.clearChannel('server_shutdown');

    if (this.websocketServer) {
      await new Promise((resolve) => this.websocketServer.close(resolve));
    }

    if (this.httpServer) {
      await new Promise((resolve, reject) => {
        this.httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        this.httpServer.closeIdleConnections?.();
        this.httpServer.closeAllConnections?.();
      });
    }

    this.websocketServer = null;
    this.httpServer = null;
    this.port = null;
  }

  async sendCommand(tool, params = {}) {
    if (tool === 'browser_batch') {
      return await this.sendBatch(params);
    }
    if (tool === 'browser_wait_click_read') {
      return await this.sendWaitClickRead(params);
    }
    if (tool === 'browser_navigate_wait_read') {
      return await this.sendNavigateWaitRead(params);
    }
    if (tool === 'browser_click_wait_selector_read') {
      return await this.sendClickWaitSelectorRead(params);
    }
    if (tool === 'browser_wait_for_download') {
      return await this.waitForDownload(params);
    }
    if (tool === 'browser_export_ahrefs') {
      return await this.exportAhrefs(params);
    }

    return await this.sendExtensionCommand(tool, params);
  }

  async sendExtensionCommand(tool, params = {}) {
    if (tool === 'browser_file_upload') {
      params = { ...params, filePath: assertLocalUploadFile(params.filePath) };
    }
    if (!this.registry.isConnected()) {
      throw new Error(
        `Chrome extension is not connected for session ${this.sessionId}. Open the extension and configure the shared key first.`,
      );
    }

    const id = `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    const payload = { type: 'command', id, tool, params };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registry.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${tool} result from the extension.`));
      }, this.requestTimeoutMs);

      this.registry.addPendingRequest(id, { resolve, reject, timer, tool });
      this.registry.channel.socket.send(JSON.stringify(payload), (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timer);
        this.registry.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  async sendBatch(params = {}) {
    const calls = params && Array.isArray(params.calls) ? params.calls : null;
    if (!calls) {
      throw new Error('browser_batch requires a calls array.');
    }
    if (calls.length === 0) {
      throw new Error('browser_batch requires at least one child call.');
    }
    if (calls.length > MAX_BROWSER_BATCH_CALLS) {
      throw new Error(`browser_batch accepts at most ${MAX_BROWSER_BATCH_CALLS} child calls.`);
    }

    const stopOnError = params.stopOnError !== false;
    const rawTimeoutMs = Number(params.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
      ? Math.min(Math.floor(rawTimeoutMs), this.requestTimeoutMs * MAX_BROWSER_BATCH_CALLS)
      : DEFAULT_BATCH_TIMEOUT_MS;
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;
    const results = [];

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index] || {};
      const childStartedAt = Date.now();
      const toolName = typeof call.tool === 'string' ? call.tool.trim() : '';
      const entry = {
        index,
        label: typeof call.label === 'string' && call.label ? call.label : undefined,
        tool: toolName || null,
      };

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        results.push({
          ...entry,
          ok: false,
          durationMs: 0,
          error: {
            code: 'batch_timeout',
            message: `browser_batch timed out after ${timeoutMs}ms.`,
          },
        });
        return {
          ok: false,
          stopped: true,
          stopIndex: index,
          callCount: calls.length,
          timeoutMs,
          durationMs: Date.now() - startedAt,
          results,
        };
      }

      const definition = toolName ? getToolDefinition(toolName) : null;
      if (!definition || isMcpLocalTool(toolName)) {
        results.push({
          ...entry,
          ok: false,
          durationMs: Date.now() - childStartedAt,
          error: {
            code: 'invalid_batch_tool',
            message: toolName
              ? `browser_batch cannot run child tool: ${toolName}`
              : 'browser_batch child calls require a tool name.',
          },
        });
        if (stopOnError) {
          return {
            ok: false,
            stopped: true,
            stopIndex: index,
            callCount: calls.length,
            timeoutMs,
            durationMs: Date.now() - startedAt,
            results,
          };
        }
        continue;
      }

      try {
        const rawChildParams =
          call.params && typeof call.params === 'object' && !Array.isArray(call.params)
            ? call.params
            : {};
        const childParams = resolveBatchParams(rawChildParams, results);
        const result = await this.sendExtensionCommand(toolName, childParams);
        results.push({
          ...entry,
          ok: true,
          durationMs: Date.now() - childStartedAt,
          result,
        });
      } catch (error) {
        results.push({
          ...entry,
          ok: false,
          durationMs: Date.now() - childStartedAt,
          error: {
            code: error?.code || 'child_tool_error',
            message: error?.message || String(error),
          },
        });
        if (stopOnError) {
          return {
            ok: false,
            stopped: true,
            stopIndex: index,
            callCount: calls.length,
            timeoutMs,
            durationMs: Date.now() - startedAt,
            results,
          };
        }
      }
    }

    return {
      ok: results.every((result) => result.ok),
      stopped: false,
      callCount: calls.length,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      results,
    };
  }

  async sendWaitClickRead(params = {}) {
    const calls = [
      {
        tool: 'browser_wait',
        label: 'wait',
        params: {
          tabId: params.tabId,
          selector: params.waitSelector,
          visible: params.visible === true,
          timeoutMs: params.timeoutMs,
        },
      },
      {
        tool: 'browser_click',
        label: 'click',
        params: {
          tabId: params.tabId,
          selector: params.clickSelector,
          ref: params.ref,
          activate: false,
        },
      },
      {
        tool: 'browser_get_page_content',
        label: 'read',
        params: {
          tabId: params.tabId,
          selector: params.readSelector || '',
          format: params.format || 'text',
          maxChars: params.maxChars,
        },
      },
    ];
    return await this.sendBatch({ calls, timeoutMs: params.timeoutMs, stopOnError: true });
  }

  async sendNavigateWaitRead(params = {}) {
    const calls = [
      {
        tool: 'browser_navigate',
        label: 'navigate',
        params: {
          tabId: params.tabId,
          url: params.url,
          activate: false,
        },
      },
      {
        tool: 'browser_wait',
        label: 'wait',
        params: {
          tabId: { $ref: 'navigate.tabId' },
          selector: params.waitSelector,
          visible: params.visible === true,
          timeoutMs: params.timeoutMs,
        },
      },
      {
        tool: 'browser_get_page_content',
        label: 'read',
        params: {
          tabId: { $ref: 'navigate.tabId' },
          selector: params.readSelector || '',
          format: params.format || 'text',
          maxChars: params.maxChars,
        },
      },
    ];
    return await this.sendBatch({ calls, timeoutMs: params.timeoutMs, stopOnError: true });
  }

  async sendClickWaitSelectorRead(params = {}) {
    const calls = [
      {
        tool: 'browser_click',
        label: 'click',
        params: {
          tabId: params.tabId,
          selector: params.clickSelector,
          ref: params.ref,
          activate: false,
        },
      },
      {
        tool: 'browser_wait',
        label: 'wait',
        params: {
          tabId: params.tabId,
          selector: params.waitSelector,
          visible: params.visible === true,
          timeoutMs: params.timeoutMs,
        },
      },
      {
        tool: 'browser_get_page_content',
        label: 'read',
        params: {
          tabId: params.tabId,
          selector: params.readSelector || '',
          format: params.format || 'text',
          maxChars: params.maxChars,
        },
      },
    ];
    return await this.sendBatch({ calls, timeoutMs: params.timeoutMs, stopOnError: true });
  }

  async waitForDownload(params = {}) {
    const downloadDir = process.env.UMBRA_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR;
    const ledger = new FileDownloadLedger({ downloadDir });
    const timeoutMs = Number.isFinite(Number(params.timeoutMs)) && Number(params.timeoutMs) > 0
      ? Math.min(Number(params.timeoutMs), 300_000)
      : 30_000;
    if (typeof params.filename === 'string' && params.filename.trim()) {
      return await ledger.waitForExact({ filename: params.filename.trim(), timeoutMs });
    }
    const nameIncludes = [];
    if (typeof params.pattern === 'string' && params.pattern.trim()) {
      nameIncludes.push(params.pattern.trim());
    }
    return await ledger.waitForNew({
      sinceMs: Number.isFinite(Number(params.createdAfterMs)) ? Number(params.createdAfterMs) : Date.now() - 1_000,
      timeoutMs,
      extension: params.extension || '',
      nameIncludes,
    });
  }

  async exportAhrefs(params = {}) {
    return await runAhrefsExport((tool, toolParams) => this.sendCommand(tool, toolParams), params);
  }

}

export function parseEnvNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

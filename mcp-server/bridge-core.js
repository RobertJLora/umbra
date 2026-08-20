import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createNonce, validateBindProof, validateHelloQuery } from './auth.js';
import { SessionRegistry } from './session-registry.js';
import { TabOwnershipStore } from './tab-ownership.js';
import { MAX_BROWSER_BATCH_CALLS, assertLocalUploadFile, getToolDefinition, isMcpLocalTool } from './tools.js';
import { resolveBatchParams } from './batch-refs.js';
import { FileDownloadLedger } from './download-ledger.mjs';
import { resolveDownloadDir } from './config.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveBrokerRequestTimeoutMs,
  resolveChildCallTimeoutMs,
} from './timeouts.js';

const DEFAULT_BIND_TIMEOUT_MS = 5_000;
const DEFAULT_BATCH_TIMEOUT_MS = 30_000;

// Composite recipes run two or three children under a single budget. Handing the
// same number to the batch deadline and to one child is what let the first
// waiting step consume the whole budget, so the step that carries the payload
// returned batch_timeout with no page content. Each waiting step takes a fixed
// share of the total; the remaining steps are filled from whatever is left when
// their turn comes.
const COMPOSITE_NAVIGATE_SHARE = 0.5;
const COMPOSITE_WAIT_AFTER_NAVIGATE_SHARE = 0.35;
const COMPOSITE_SINGLE_WAIT_SHARE = 0.6;

// The batch deadline a composite hands to sendBatch. Mirrors both the fallback
// and the cap sendBatch applies, so the slices below are always computed from
// the number the batch will actually enforce.
function resolveCompositeTimeoutMs(requestedMs, maxMs) {
  const requested = Number(requestedMs);
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_BATCH_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requested), maxMs);
}

function compositeSlice(totalMs, share) {
  return resolveChildCallTimeoutMs(Math.floor(totalMs * share), null) ?? undefined;
}

// Fill or clamp one batch child's own timeout from what is left of the batch
// budget. Without this a child inherits its full tool default (browser_navigate
// waits 45,000 ms) and exhausts a 30,000 ms batch on its own, so the step that
// carries the payload reports batch_timeout. Only tools whose schema declares
// timeoutMs are touched, so no child receives a parameter its schema does not
// describe.
function applyChildBudget(definition, childParams, remainingMs) {
  if (!childParams || typeof childParams !== 'object' || Array.isArray(childParams)) {
    return childParams;
  }
  if (!definition?.inputSchema?.properties?.timeoutMs) {
    return childParams;
  }

  const requested = Number(childParams.timeoutMs);
  const hasRequested = Number.isFinite(requested) && requested > 0;
  const budgeted = resolveChildCallTimeoutMs(remainingMs, hasRequested ? requested : null);
  if (budgeted === null) {
    return childParams;
  }

  // Clamp downward only. A caller who asked for less than the remaining budget
  // keeps the smaller number, including one under the 1,000 ms floor in
  // resolveChildCallTimeoutMs; that floor exists to stop a nearly exhausted
  // parent budget from handing a child a few milliseconds, not to overrule a
  // deliberate short wait.
  if (!hasRequested || budgeted < requested) {
    childParams.timeoutMs = budgeted;
  }
  return childParams;
}

export class LocalBridgeServer {
  constructor({
    sharedKey,
    sessionId,
    portStart,
    portEnd,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    bindTimeoutMs = DEFAULT_BIND_TIMEOUT_MS,
    runAhrefsExport = null,
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

    // The Ahrefs orchestration is a local-only plugin: the published npm package
    // omits ahrefs-export.js through its files allowlist. Taking the runner as a
    // constructor argument keeps that module out of this file's static import
    // graph, so the published package loads with the file absent.
    this.runAhrefsExport = typeof runAhrefsExport === 'function' ? runAhrefsExport : null;
    this.ahrefsExportLoad = null;

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

    // A stale socket that still reports OPEN used to make this method close the
    // extension's replacement connection with 4005 session_already_connected,
    // and the extension then redialled every two seconds forever with no way
    // back. The replacement is already HMAC-gated by validateHelloQuery before
    // handleConnection runs, so letting it win opens no authentication gap.
    // SessionRegistry.setChannel closes the socket it displaces with 4000
    // superseded, and the displaced socket's own close handler checks channel
    // identity before clearing anything, so it cannot tear down the replacement.
    const displacedSocket = this.registry.channel?.socket ?? null;
    if (displacedSocket && displacedSocket !== socket) {
      console.error(
        `[umbra] a new extension socket superseded the existing channel for ${this.sessionId}`,
      );
      // Retire the displaced channel before installing the replacement. Doing it
      // here rejects its pending requests at once instead of leaving every
      // caller to wait out a transport timeout against a socket that is closing,
      // and it makes the displaced socket's own close handler a no-op on
      // whichever tick that handler runs.
      this.registry.clearChannel('superseded');
      this.ownership.detachSession(this.sessionId);
      try {
        displacedSocket.close(4000, 'superseded');
      } catch {
        // Ignore close failures on a socket that is already gone.
      }
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

      // Application-level keepalive. Browser JavaScript cannot send WebSocket
      // protocol pings and never surfaces pong frames to a message listener, so
      // the extension's offscreen document detects a dead-but-OPEN socket by
      // sending {"type":"ping"} and watching for this answer. Every unanswered
      // ping used to fall into settleRequest, which returns false for a message
      // carrying no known pending id, so the frame was silently dropped.
      if (message.type === 'ping') {
        try {
          socket.send(JSON.stringify({
            type: 'pong',
            id: message.id ?? null,
            sessionId: this.sessionId,
          }));
        } catch {
          // A socket that cannot answer a keepalive is already gone; the close
          // handler clears the channel.
        }
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
    // The extension clamps its own wait from params.timeoutMs (browser_wait
    // accepts up to 90,000 ms), so a fixed 60,000 ms transport timer aborted
    // calls the extension was still legitimately servicing, and the caller saw a
    // timeout against a page that had not finished rendering. Honour the
    // per-call value with transport slack on top, which is what the Rust broker
    // lane and the broker itself already do.
    const timeoutMs = resolveBrokerRequestTimeoutMs(this.requestTimeoutMs, params);

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registry.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${tool} result from the extension.`));
      }, timeoutMs);

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
        const childParams = applyChildBudget(
          definition,
          resolveBatchParams(rawChildParams, results),
          remainingMs,
        );
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

  // The whole-recipe deadline for a composite, resolved and capped exactly as
  // sendBatch resolves and caps it, so a slice can never exceed the deadline the
  // batch enforces.
  compositeBudgetMs(requestedMs) {
    return resolveCompositeTimeoutMs(requestedMs, this.requestTimeoutMs * MAX_BROWSER_BATCH_CALLS);
  }

  async sendWaitClickRead(params = {}) {
    const totalMs = this.compositeBudgetMs(params.timeoutMs);
    const calls = [
      {
        tool: 'browser_wait',
        label: 'wait',
        params: {
          tabId: params.tabId,
          selector: params.waitSelector,
          visible: params.visible === true,
          timeoutMs: compositeSlice(totalMs, COMPOSITE_SINGLE_WAIT_SHARE),
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
    return await this.sendBatch({ calls, timeoutMs: totalMs, stopOnError: true });
  }

  async sendNavigateWaitRead(params = {}) {
    const totalMs = this.compositeBudgetMs(params.timeoutMs);
    const calls = [
      {
        tool: 'browser_navigate',
        label: 'navigate',
        params: {
          tabId: params.tabId,
          url: params.url,
          activate: false,
          timeoutMs: compositeSlice(totalMs, COMPOSITE_NAVIGATE_SHARE),
        },
      },
      {
        tool: 'browser_wait',
        label: 'wait',
        params: {
          tabId: { $ref: 'navigate.tabId' },
          selector: params.waitSelector,
          visible: params.visible === true,
          timeoutMs: compositeSlice(totalMs, COMPOSITE_WAIT_AFTER_NAVIGATE_SHARE),
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
    return await this.sendBatch({ calls, timeoutMs: totalMs, stopOnError: true });
  }

  async sendClickWaitSelectorRead(params = {}) {
    const totalMs = this.compositeBudgetMs(params.timeoutMs);
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
          timeoutMs: compositeSlice(totalMs, COMPOSITE_SINGLE_WAIT_SHARE),
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
    return await this.sendBatch({ calls, timeoutMs: totalMs, stopOnError: true });
  }

  async waitForDownload(params = {}) {
    const ledger = new FileDownloadLedger({ downloadDir: resolveDownloadDir() });
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

  // Returns the Ahrefs export runner, or null when this build has no plugin.
  // The injected runner wins. Without one, the module is resolved lazily and at
  // most once, so a checkout that still carries ahrefs-export.js keeps the tool
  // working while a published package that omits the file resolves to null and
  // reports it plainly instead of failing to load.
  async resolveAhrefsExport() {
    if (this.runAhrefsExport) {
      return this.runAhrefsExport;
    }
    if (!this.ahrefsExportLoad) {
      this.ahrefsExportLoad = import('./ahrefs-export.js')
        .then((module) => (typeof module.runAhrefsExport === 'function' ? module.runAhrefsExport : null))
        .catch(() => null);
    }
    this.runAhrefsExport = await this.ahrefsExportLoad;
    return this.runAhrefsExport;
  }

  async exportAhrefs(params = {}) {
    const runExport = await this.resolveAhrefsExport();
    if (!runExport) {
      throw new Error(
        'Ahrefs export plugin is not installed in this build. browser_export_ahrefs needs ahrefs-export.js, which ships only with a full checkout.',
      );
    }
    return await runExport((tool, toolParams) => this.sendCommand(tool, toolParams), params);
  }

}

export function parseEnvNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

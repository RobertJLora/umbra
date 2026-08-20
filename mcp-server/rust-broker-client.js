import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { MAX_BROWSER_BATCH_CALLS, assertLocalUploadFile, getToolDefinition, isMcpLocalTool } from './tools.js';
import { resolveBatchParams } from './batch-refs.js';
import { FileDownloadLedger } from './download-ledger.mjs';
import { resolveBrokerSocketPath, resolveDownloadDir } from './config.js';
import {
  COMMAND_TIMEOUT_SLACK_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MIN_CHILD_CALL_TIMEOUT_MS,
  resolveBrokerRequestTimeoutMs,
  resolveChildCallTimeoutMs,
} from './timeouts.js';

// Re-exported so callers and tests keep importing the command-timeout helper
// from the transport they are configuring. The arithmetic itself lives in
// timeouts.js because all three lanes share it.
export { resolveBrokerRequestTimeoutMs };

const ENSURE_BROKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure-rust-broker.mjs');

const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
const NEWLINE_BYTE = 0x0a;

// One deadline covers every connect attempt plus every broker start it triggers.
// Before this budget existed each attempt could block for the full
// ensure-rust-broker start timeout on its own, so three failing attempts added
// up to roughly 25 seconds of dead time.
const DEFAULT_CONNECT_DEADLINE_MS = 20_000;
const MAX_CONNECT_ATTEMPTS = 3;
const ENSURE_RETRY_BACKOFF_MS = 200;

// Every child still queued keeps this much of the batch budget in reserve, so
// the last step, which is usually the one carrying the page payload, still has
// a budget left when an earlier step runs long.
const CHILD_BUDGET_RESERVE_MS = 2_000;

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function acceptsTimeoutMs(definition) {
  return Boolean(definition?.inputSchema?.properties?.timeoutMs);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class RustBrokerClient extends EventEmitter {
  constructor({
    sessionId,
    socketPath = resolveBrokerSocketPath(),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    connectDeadlineMs = positiveNumber(process.env.UMBRA_BROKER_CONNECT_TIMEOUT_MS) || DEFAULT_CONNECT_DEADLINE_MS,
    socketFactory = null,
    runAhrefsExport = null,
  } = {}) {
    super();
    if (!sessionId) {
      throw new Error('RustBrokerClient requires a sessionId.');
    }
    this.sessionId = sessionId;
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectDeadlineMs = connectDeadlineMs;
    this.socketFactory = socketFactory;
    this.runAhrefsExport = typeof runAhrefsExport === 'function' ? runAhrefsExport : null;
    this.ahrefsExportLoad = null;
    this.socket = null;
    this.chunks = [];
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
    this.registering = null;
  }

  async start() {
    await this.ensureConnected();
    return true;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) {
      return;
    }
    this.socket = null;
    this.chunks = [];

    if (this.socketFactory) {
      this.socket = await this.socketFactory(this.socketPath);
    } else {
      this.socket = await this.connectWithEnsure();
    }

    // No setEncoding: handleData frames raw Buffers so a multi-megabyte
    // response is concatenated and decoded once instead of once per chunk.
    const socket = this.socket;
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => this.rejectAll(error));
    this.socket.on('close', () => {
      this.connected = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      this.registering = null;
      this.rejectAll(new Error('Rust broker shim socket closed.'));
    });
  }

  openBrokerSocket() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const onError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(socket);
      });
    });
  }

  // Runs mcp-server/ensure-rust-broker.mjs as an awaited child. The previous
  // synchronous spawn froze the whole event loop for the child's full start
  // timeout, which stalled the parent-watch interval and stopped SIGINT and
  // SIGTERM handlers from running while a broker was being started.
  runEnsureBroker(budgetMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (healthy) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve(healthy);
      };

      let child;
      try {
        child = spawn(process.execPath, [ENSURE_BROKER_SCRIPT], {
          stdio: 'ignore',
          env: process.env,
        });
      } catch {
        finish(false);
        return;
      }

      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(false);
      }, Math.max(MIN_CHILD_CALL_TIMEOUT_MS, budgetMs));

      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    });
  }

  async connectWithEnsure() {
    const deadlineAt = Date.now() + this.connectDeadlineMs;
    let lastError = new Error('Rust broker socket refused.');

    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        return await this.openBrokerSocket();
      } catch (error) {
        lastError = error;
      }

      // The last iteration ends on its connect attempt. Starting a broker that
      // nothing will connect to afterwards only spends the caller's budget.
      if (attempt === MAX_CONNECT_ATTEMPTS - 1) {
        break;
      }

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const healthy = await this.runEnsureBroker(remainingMs);
      if (healthy) {
        // The broker answered a health check, so retry the connect now rather
        // than sleeping out a fixed backoff.
        continue;
      }

      const backoffMs = Math.min(ENSURE_RETRY_BACKOFF_MS * (attempt + 1), Math.max(0, deadlineAt - Date.now()));
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }

    throw lastError;
  }

  isConnected() {
    return this.connected && this.socket && !this.socket.destroyed;
  }

  async stop() {
    if (this.isConnected()) {
      try {
        await this.sendRawBrokerRequest('disconnect_session', {
          session_id: this.sessionId,
          reason: 'mcp_shutdown',
        });
      } catch {
        // The process is already shutting down; legacy cleanup remains best-effort.
      }
    }
    this.connected = false;
    this.socket?.end();
    this.socket?.destroySoon?.();
    this.socket = null;
    this.rejectAll(new Error('Rust broker client stopped.'));
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

  // `budgetMs` is the caller's remaining budget for this one command. It only
  // ever lowers the transport timer, because resolveBrokerRequestTimeoutMs
  // raises short per-call values to the configured floor and a floored child
  // would keep waiting after its batch had already given up.
  async sendExtensionCommand(tool, params = {}, { budgetMs = null } = {}) {
    if (tool === 'browser_file_upload') {
      params = { ...params, filePath: assertLocalUploadFile(params.filePath) };
    }
    const resolvedTimeoutMs = resolveBrokerRequestTimeoutMs(this.requestTimeoutMs, params);
    const timeoutMs = budgetMs === null
      ? resolvedTimeoutMs
      : resolveChildCallTimeoutMs(budgetMs + COMMAND_TIMEOUT_SLACK_MS, resolvedTimeoutMs);
    try {
      return await this.sendBrokerRequest('command', {
        session_id: this.sessionId,
        tool,
        params,
      }, timeoutMs);
    } catch (error) {
      if (!/session .* is not connected|session_not_registered|session_already_connected|ECONNREFUSED|socket closed|not connected/i.test(error?.message || '')) {
        throw error;
      }
      this.forceReconnect();
      return await this.sendBrokerRequest('command', {
        session_id: this.sessionId,
        tool,
        params,
      }, timeoutMs);
    }
  }

  async health() {
    return await this.sendBrokerRequest('health', {});
  }

  async ensureConnected() {
    if (this.isConnected()) {
      return;
    }
    if (this.registering) {
      await this.registering;
      return;
    }
    this.registering = (async () => {
      await this.connect();
      await this.sendRawBrokerRequest('register_session', {
        session_id: this.sessionId,
        client_pid: process.pid,
        parent_pid: process.ppid,
      });
      this.connected = true;
    })();
    try {
      await this.registering;
    } finally {
      this.registering = null;
    }
  }

  forceReconnect() {
    this.connected = false;
    this.socket?.destroy?.();
    this.socket = null;
    this.registering = null;
  }

  async sendBrokerRequest(type, payload = {}, timeoutMs = this.requestTimeoutMs) {
    await this.ensureConnected();
    return await this.sendRawBrokerRequest(type, payload, timeoutMs);
  }

  async sendRawBrokerRequest(type, payload = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Rust broker socket is not connected.');
    }

    const id = `shim_${Date.now()}_${this.nextId}`;
    this.nextId += 1;
    const message = { type, id, ...payload };
    const line = `${JSON.stringify(message)}\n`;

    const waitMs = resolveBrokerRequestTimeoutMs(timeoutMs, payload?.params || payload);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Rust broker response to ${type}.`));
      }, waitMs);

      this.pending.set(id, { resolve, reject, timer, type });
      this.socket.write(line, 'utf8', (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  // Frames newline-delimited JSON out of raw socket chunks. Only the newest
  // chunk is scanned, and the accumulated pieces are concatenated and decoded
  // once per complete line, so a multi-megabyte response no longer re-flattens
  // a growing string on every one of its ~1,200 chunks. There is deliberately
  // no search offset into an accumulated buffer: measured, that variant saves
  // 11 to 18 percent because indexOf flattens the subject whatever the start
  // index, and it adds state for nothing.
  handleData(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    let start = 0;

    for (;;) {
      const newlineIndex = buffer.indexOf(NEWLINE_BYTE, start);
      if (newlineIndex < 0) {
        break;
      }

      const tail = buffer.subarray(start, newlineIndex);
      let line;
      if (this.chunks.length === 0) {
        line = tail.toString('utf8');
      } else {
        this.chunks.push(tail);
        line = Buffer.concat(this.chunks).toString('utf8');
        this.chunks = [];
      }
      start = newlineIndex + 1;

      const trimmed = line.trim();
      if (trimmed) {
        this.handleLine(trimmed);
      }
    }

    if (start < buffer.length) {
      this.chunks.push(start === 0 ? buffer : buffer.subarray(start));
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const id = message.id;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }

    const error = new Error(message.error?.message || `Rust broker ${pending.type} failed.`);
    error.code = message.error?.code || 'rust_broker_error';
    pending.reject(error);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
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
        const reservedMs = (calls.length - index - 1) * CHILD_BUDGET_RESERVE_MS;
        const childBudgetMs = resolveChildCallTimeoutMs(
          Math.max(MIN_CHILD_CALL_TIMEOUT_MS, remainingMs - reservedMs),
          rawChildParams.timeoutMs,
        );
        if (
          childBudgetMs !== null
          && acceptsTimeoutMs(definition)
          && childParams
          && typeof childParams === 'object'
          && !Array.isArray(childParams)
        ) {
          childParams.timeoutMs = childBudgetMs;
        }
        const result = await this.sendExtensionCommand(toolName, childParams, { budgetMs: childBudgetMs });
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

  // The three composites below pass their timeoutMs as the batch deadline only.
  // No child repeats that number as its own timeout: sendBatch gives each child
  // the budget still left when its turn comes, minus the reserve the later
  // children need, so the step carrying the payload is not starved by a slow
  // first step and the navigate step stops inheriting the extension's 45,000 ms
  // load default.
  async sendWaitClickRead(params = {}) {
    return await this.sendBatch({
      timeoutMs: params.timeoutMs,
      stopOnError: true,
      calls: [
        { tool: 'browser_wait', label: 'wait', params: { tabId: params.tabId, selector: params.waitSelector, visible: params.visible === true } },
        { tool: 'browser_click', label: 'click', params: { tabId: params.tabId, selector: params.clickSelector, ref: params.ref, activate: false } },
        { tool: 'browser_get_page_content', label: 'read', params: { tabId: params.tabId, selector: params.readSelector || '', format: params.format || 'text', maxChars: params.maxChars } },
      ],
    });
  }

  async sendNavigateWaitRead(params = {}) {
    return await this.sendBatch({
      timeoutMs: params.timeoutMs,
      stopOnError: true,
      calls: [
        { tool: 'browser_navigate', label: 'navigate', params: { tabId: params.tabId, url: params.url, activate: false } },
        { tool: 'browser_wait', label: 'wait', params: { tabId: { $ref: 'navigate.tabId' }, selector: params.waitSelector, visible: params.visible === true } },
        { tool: 'browser_get_page_content', label: 'read', params: { tabId: { $ref: 'navigate.tabId' }, selector: params.readSelector || '', format: params.format || 'text', maxChars: params.maxChars } },
      ],
    });
  }

  async sendClickWaitSelectorRead(params = {}) {
    return await this.sendBatch({
      timeoutMs: params.timeoutMs,
      stopOnError: true,
      calls: [
        { tool: 'browser_click', label: 'click', params: { tabId: params.tabId, selector: params.clickSelector, ref: params.ref, activate: false } },
        { tool: 'browser_wait', label: 'wait', params: { tabId: params.tabId, selector: params.waitSelector, visible: params.visible === true } },
        { tool: 'browser_get_page_content', label: 'read', params: { tabId: params.tabId, selector: params.readSelector || '', format: params.format || 'text', maxChars: params.maxChars } },
      ],
    });
  }

  async waitForDownload(params = {}) {
    const requestedDir = typeof params.dir === 'string' && params.dir.trim() ? params.dir.trim() : '';
    const downloadDir = requestedDir || resolveDownloadDir();
    const ledger = new FileDownloadLedger({ downloadDir });
    const timeoutMs = Number.isFinite(Number(params.timeoutMs)) && Number(params.timeoutMs) > 0
      ? Math.min(Number(params.timeoutMs), 300_000)
      : 30_000;
    if (typeof params.filename === 'string' && params.filename.trim()) {
      return await ledger.waitForExact({ filename: params.filename.trim(), timeoutMs });
    }
    return await ledger.waitForNew({
      sinceMs: Number.isFinite(Number(params.createdAfterMs)) ? Number(params.createdAfterMs) : Date.now() - 1_000,
      timeoutMs,
      extension: params.extension || '',
      nameIncludes: typeof params.pattern === 'string' && params.pattern.trim() ? [params.pattern.trim()] : [],
    });
  }

  // The Ahrefs orchestration is a local-only plugin: the published package
  // omits ahrefs-export.js, so it is resolved lazily and its absence has to
  // read as a clear message rather than a module-resolution crash at import
  // time. A checkout that has the file behaves exactly as before.
  async loadAhrefsExporter() {
    if (this.runAhrefsExport) {
      return this.runAhrefsExport;
    }
    if (!this.ahrefsExportLoad) {
      this.ahrefsExportLoad = import('./ahrefs-export.js')
        .then((module) => (typeof module.runAhrefsExport === 'function' ? module.runAhrefsExport : null))
        .catch(() => null);
    }
    return await this.ahrefsExportLoad;
  }

  async exportAhrefs(params = {}) {
    const runExport = await this.loadAhrefsExporter();
    if (typeof runExport !== 'function') {
      throw new Error('Ahrefs export plugin is not installed in this build.');
    }
    return await runExport((tool, toolParams) => this.sendCommand(tool, toolParams), params);
  }
}

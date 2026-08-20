import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { MAX_BROWSER_BATCH_CALLS, assertLocalUploadFile, getToolDefinition, isMcpLocalTool } from './tools.js';

const ENSURE_BROKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure-rust-broker.mjs');
import { resolveBatchParams } from './batch-refs.js';
import { FileDownloadLedger } from './download-ledger.mjs';
import { runAhrefsExport } from './ahrefs-export.js';

const DEFAULT_BROKER_SOCKET = '/tmp/umbra-rust-broker.sock';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_DIR = '/Users/RobertLora/Documents/Downloads';
const COMMAND_TIMEOUT_SLACK_MS = 5_000;
const MAX_COMMAND_TIMEOUT_MS = 185_000;

export function resolveBrokerRequestTimeoutMs(requestTimeoutMs, params = {}) {
  const floor = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
    ? Math.floor(Number(requestTimeoutMs))
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const toolTimeoutMs = Number(params?.timeoutMs);
  if (!Number.isFinite(toolTimeoutMs) || toolTimeoutMs <= 0) {
    return floor;
  }
  return Math.min(Math.max(floor, Math.floor(toolTimeoutMs) + COMMAND_TIMEOUT_SLACK_MS), MAX_COMMAND_TIMEOUT_MS);
}

export class RustBrokerClient extends EventEmitter {
  constructor({
    sessionId,
    socketPath = process.env.UMBRA_BROKER_SOCKET || DEFAULT_BROKER_SOCKET,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    socketFactory = null,
  } = {}) {
    super();
    if (!sessionId) {
      throw new Error('RustBrokerClient requires a sessionId.');
    }
    this.sessionId = sessionId;
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socketFactory = socketFactory;
    this.socket = null;
    this.buffer = '';
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
    this.buffer = '';

    if (this.socketFactory) {
      this.socket = await this.socketFactory(this.socketPath);
    } else {
      this.socket = await this.connectWithEnsure();
    }

    this.socket.setEncoding?.('utf8');
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

  async connectWithEnsure() {
    let lastError = new Error('Rust broker socket refused.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await new Promise((resolve, reject) => {
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
      } catch (error) {
        lastError = error;
        spawnSync(process.execPath, [ENSURE_BROKER_SCRIPT], {
          stdio: 'ignore',
          env: process.env,
        });
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
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

  async sendExtensionCommand(tool, params = {}) {
    if (tool === 'browser_file_upload') {
      params = { ...params, filePath: assertLocalUploadFile(params.filePath) };
    }
    const timeoutMs = resolveBrokerRequestTimeoutMs(this.requestTimeoutMs, params);
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

  handleData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      this.handleLine(line);
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
    return await this.sendBatch({
      timeoutMs: params.timeoutMs,
      stopOnError: true,
      calls: [
        { tool: 'browser_wait', label: 'wait', params: { tabId: params.tabId, selector: params.waitSelector, visible: params.visible === true, timeoutMs: params.timeoutMs } },
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
        { tool: 'browser_wait', label: 'wait', params: { tabId: { $ref: 'navigate.tabId' }, selector: params.waitSelector, visible: params.visible === true, timeoutMs: params.timeoutMs } },
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
        { tool: 'browser_wait', label: 'wait', params: { tabId: params.tabId, selector: params.waitSelector, visible: params.visible === true, timeoutMs: params.timeoutMs } },
        { tool: 'browser_get_page_content', label: 'read', params: { tabId: params.tabId, selector: params.readSelector || '', format: params.format || 'text', maxChars: params.maxChars } },
      ],
    });
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
    return await ledger.waitForNew({
      sinceMs: Number.isFinite(Number(params.createdAfterMs)) ? Number(params.createdAfterMs) : Date.now() - 1_000,
      timeoutMs,
      extension: params.extension || '',
      nameIncludes: typeof params.pattern === 'string' && params.pattern.trim() ? [params.pattern.trim()] : [],
    });
  }

  async exportAhrefs(params = {}) {
    return await runAhrefsExport((tool, toolParams) => this.sendCommand(tool, toolParams), params);
  }
}

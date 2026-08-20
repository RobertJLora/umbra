import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from './node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StdioServerTransport } from './node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from './node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import { createSessionId } from './auth.js';
import { LocalBridgeServer, parseEnvNumber } from './bridge-core.js';
import { RustBrokerClient } from './rust-broker-client.js';
import { TOOL_DEFINITIONS, getToolDefinition } from './tools.js';

const DEFAULT_PORT_START = 47821;
const DEFAULT_PORT_END = 47852;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BIND_TIMEOUT_MS = 5_000;
const DEFAULT_PARENT_WATCH_MS = 5_000;
const DEFAULT_SHUTDOWN_CLOSE_TIMEOUT_MS = 3_000;

function resolveScreenshotMimeType(result, args = {}) {
  const reported = typeof result?.mimeType === 'string' ? result.mimeType.trim().toLowerCase() : '';
  if (reported === 'image/jpeg' || reported === 'image/jpg') {
    return 'image/jpeg';
  }
  if (reported === 'image/png') {
    return 'image/png';
  }

  const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : '';
  if (format === 'jpeg' || format === 'jpg') {
    return 'image/jpeg';
  }
  if (format === 'png') {
    return 'image/png';
  }

  const outputPath = typeof args.outputPath === 'string' ? args.outputPath : '';
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    return 'image/jpeg';
  }

  return reported || 'image/png';
}

export function buildMcpResponse(toolName, result, args = {}) {
  if (toolName === 'browser_screenshot' && result?.data) {
    const outputPath = typeof args.outputPath === 'string' ? args.outputPath.trim() : '';
    const mimeType = resolveScreenshotMimeType(result, args);
    if (outputPath) {
      const resolvedOutputPath = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
      const imageBuffer = Buffer.from(result.data, 'base64');
      fs.writeFileSync(resolvedOutputPath, imageBuffer);
      const structuredContent = {
        tabId: result.tabId,
        activated: Boolean(result.activated),
        mimeType,
        outputPath: resolvedOutputPath,
        bytes: imageBuffer.length,
        cropped: Boolean(result.cropped),
        region: result.region || null,
        preflight: result.preflight || null,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    }

    return {
      content: [
        {
          type: 'image',
          data: result.data,
          mimeType,
        },
      ],
      structuredContent: {
        tabId: result.tabId,
        activated: Boolean(result.activated),
        cropped: Boolean(result.cropped),
        region: result.region || null,
        preflight: result.preflight || null,
      },
    };
  }

  if (typeof result === 'string') {
    return {
      content: [{ type: 'text', text: result }],
    };
  }

  const serialized = JSON.stringify(result, null, 2);
  const compactSummary = result?._compactSummary || result?.summary || '';
  return {
    content: [{
      type: 'text',
      text: compactSummary && serialized.length > 30_000 ? compactSummary : serialized,
    }],
    structuredContent: result,
  };
}

function loadSharedKey() {
  const directKey = process.env.UMBRA_SHARED_KEY?.trim();
  if (directKey) {
    return directKey;
  }

  const keyFile = process.env.UMBRA_SHARED_KEY_FILE;
  if (keyFile) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }

  throw new Error('Missing UMBRA_SHARED_KEY or UMBRA_SHARED_KEY_FILE.');
}

export async function main() {
  const sharedKey = loadSharedKey();

  const portStart = parseEnvNumber(process.env.UMBRA_PORT_START, DEFAULT_PORT_START);
  const portEnd = parseEnvNumber(process.env.UMBRA_PORT_END, DEFAULT_PORT_END);
  const requestTimeoutMs = parseEnvNumber(
    process.env.UMBRA_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const bindTimeoutMs = parseEnvNumber(
    process.env.UMBRA_BIND_TIMEOUT_MS,
    DEFAULT_BIND_TIMEOUT_MS,
  );
  const parentWatchMs = parseEnvNumber(
    process.env.UMBRA_PARENT_WATCH_MS,
    DEFAULT_PARENT_WATCH_MS,
  );
  const shutdownCloseTimeoutMs = parseEnvNumber(
    process.env.UMBRA_SHUTDOWN_CLOSE_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_CLOSE_TIMEOUT_MS,
  );
  const closeTabsOnShutdown =
    process.env.UMBRA_KEEP_TABS_OPEN !== '1' &&
    process.env.UMBRA_CLOSE_ON_SHUTDOWN !== '0';

  if (portEnd < portStart) {
    throw new Error('UMBRA_PORT_END must be >= UMBRA_PORT_START.');
  }

  const sessionId = process.env.UMBRA_SESSION_ID || createSessionId();
  const useRustBroker =
    process.env.UMBRA_MCP_SHIM_MODE === 'rust' ||
    process.env.UMBRA_BROKER_MODE === 'rust';
  const bridge = useRustBroker
    ? new RustBrokerClient({
        sessionId,
        requestTimeoutMs,
      })
    : new LocalBridgeServer({
        sharedKey,
        sessionId,
        portStart,
        portEnd,
        requestTimeoutMs,
        bindTimeoutMs,
      });

  if (useRustBroker) {
    await bridge.start();
    console.error(`[umbra] session=${sessionId} registered with Rust broker`);
  } else {
    const boundPort = await bridge.start();
    console.error(`[umbra] session=${sessionId} listening on 127.0.0.1:${boundPort}`);
  }

  const server = new Server(
    {
      name: 'umbra',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    const definition = getToolDefinition(toolName);

    if (!definition) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const result = await bridge.sendCommand(toolName, args);
    return buildMcpResponse(toolName, result, args);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  let parentWatch = null;
  const startupParentPid = process.ppid;

  const shutdown = async (reason = 'shutdown') => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (parentWatch) {
      clearInterval(parentWatch);
      parentWatch = null;
    }

    console.error(`[umbra] shutting down: ${reason}`);
    const bridgeConnected = typeof bridge.isConnected === 'function'
      ? bridge.isConnected()
      : bridge.registry.isConnected();
    if (closeTabsOnShutdown && bridgeConnected) {
      try {
        await Promise.race([
          bridge.sendCommand('browser_close_session_tabs', {}),
          delay(shutdownCloseTimeoutMs).then(() => {
            throw new Error(`Timed out after ${shutdownCloseTimeoutMs}ms.`);
          }),
        ]);
      } catch (error) {
        console.error(`[umbra] shutdown tab cleanup failed: ${error?.message || error}`);
      }
    }

    try {
      await bridge.stop();
    } catch (error) {
      console.error(`[umbra] bridge stop failed: ${error?.message || error}`);
    }
    await delay(25);
    process.exit(0);
  };

  if (parentWatchMs > 0 && startupParentPid > 1) {
    parentWatch = setInterval(() => {
      if (process.ppid === 1) {
        void shutdown('parent_process_gone');
      }
    }, parentWatchMs);
    parentWatch.unref?.();
  }

  process.stdin.on('end', () => void shutdown('stdin_end'));
  process.stdin.on('close', () => void shutdown('stdin_close'));
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') {
      void shutdown('stdout_epipe');
    }
  });
  process.on('disconnect', () => void shutdown('process_disconnect'));
  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('SIGTERM', () => void shutdown('sigterm'));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[umbra] ${error.stack || error.message}`);
    process.exit(1);
  });
}

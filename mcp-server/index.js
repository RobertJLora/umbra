import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createSessionId } from './auth.js';
import { LocalBridgeServer, parseEnvNumber } from './bridge-core.js';
import { RustBrokerClient } from './rust-broker-client.js';
import { resolveSharedKeyPath } from './config.js';
import { loadPlugins } from './plugins-loader.mjs';
// Namespace import on purpose: `buildToolDefinitions` is added by the tool-schema
// work and a named import of a not-yet-present export fails at module link time.
import * as toolCatalog from './tools.js';

const DEFAULT_PORT_START = 47821;
const DEFAULT_PORT_END = 47852;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BIND_TIMEOUT_MS = 5_000;
const DEFAULT_PARENT_WATCH_MS = 5_000;
const DEFAULT_SHUTDOWN_CLOSE_TIMEOUT_MS = 3_000;

// Above this serialized size the summary key is hoisted to the front of the
// payload so a client that truncates a long text block still reads it.
export const COMPACT_SUMMARY_THRESHOLD_BYTES = 30_000;

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

// The screenshot `outputPath` is the only value that makes this server write to
// disk, so it is validated instead of resolved blindly. A relative path lands in
// whatever working directory the MCP client happened to launch with, a literal
// '~/...' string creates a directory named '~', and '../../..' escapes the
// working directory entirely. The parent directory must already exist: creating
// it recursively turns a typo into a tree of empty directories the caller never
// asked for.
export function resolveOutputPath(outputPath) {
  const raw = typeof outputPath === 'string' ? outputPath.trim() : '';
  if (!raw) {
    throw new Error('outputPath must be a non-empty absolute path.');
  }

  let expanded = raw;
  if (raw === '~') {
    expanded = os.homedir();
  } else if (raw.startsWith('~/')) {
    expanded = path.join(os.homedir(), raw.slice(2));
  }

  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `outputPath must be an absolute path or start with "~/". Received: ${raw}`,
    );
  }

  const resolved = path.resolve(expanded);
  const parent = path.dirname(resolved);
  let parentStat = null;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    throw new Error(
      `outputPath directory does not exist: ${parent}. Create it first, or pass a path inside an existing directory.`,
    );
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`outputPath parent is not a directory: ${parent}`);
  }

  return resolved;
}

export function buildMcpResponse(toolName, result, args = {}) {
  if (toolName === 'browser_screenshot' && result?.data) {
    const outputPath = typeof args.outputPath === 'string' ? args.outputPath.trim() : '';
    const mimeType = resolveScreenshotMimeType(result, args);
    if (outputPath) {
      const resolvedOutputPath = resolveOutputPath(outputPath);
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

  // One copy on the wire. No tool declares an outputSchema, so structured
  // content is optional, and the spec wants the serialized JSON in a text block
  // whenever structured content is present. Sending both meant every result
  // crossed the transport twice and the compact escape below saved nothing.
  const serialized = JSON.stringify(result ?? null);
  const compactSummary = typeof result?._compactSummary === 'string' ? result._compactSummary : '';
  const text = compactSummary && serialized.length > COMPACT_SUMMARY_THRESHOLD_BYTES
    ? JSON.stringify({ _compactSummary: compactSummary, ...result })
    : serialized;

  const response = {
    content: [{ type: 'text', text }],
  };

  // Batches, composites, and MCP-local plugin handlers report their own failures
  // as `{ ok: false }` and resolve normally, so without this flag the same
  // failing step arrives as an error when run alone and as a success when run
  // inside a batch.
  if (result?.ok === false) {
    response.isError = true;
  }

  return response;
}

function describeValue(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function matchesSchemaType(value, type) {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function collectSchemaIssues(value, schema, label, issues, limit) {
  if (issues.length >= limit || !schema || typeof schema !== 'object') {
    return;
  }

  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (types.length > 0 && !types.some((type) => matchesSchemaType(value, type))) {
    issues.push(`${label} expected ${types.join(' or ')}, received ${describeValue(value)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push(`${label} expected one of [${schema.enum.join(', ')}], received ${JSON.stringify(value)}`);
  }

  if (matchesSchemaType(value, 'object')) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (value[key] === undefined) {
        issues.push(`${label}.${key} is required and missing`);
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const declared = Object.keys(properties);
    for (const key of declared) {
      if (value[key] !== undefined) {
        collectSchemaIssues(value[key], properties[key], `${label}.${key}`, issues, limit);
      }
    }
    if (declared.length > 0) {
      const known = new Set(declared);
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          issues.push(`${label}.${key} is not a declared property`);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length && issues.length < limit; index += 1) {
      collectSchemaIssues(value[index], schema.items, `${label}[${index}]`, issues, limit);
    }
  }
}

// Staged validation: the low-level SDK validates nothing per tool, and these
// schemas have never been enforced while the extension coerces parameters ad
// hoc, so a mismatch is reported and the call still runs. Enforcement is a
// separate decision that needs real traffic behind it first.
export function compileSchemaValidator(inputSchema, { maxIssues = 5 } = {}) {
  return function validate(args) {
    const issues = [];
    collectSchemaIssues(args ?? {}, inputSchema, 'arguments', issues, maxIssues);
    return issues;
  };
}

export function createSchemaValidators(definitions = []) {
  const validators = new Map();
  for (const definition of definitions) {
    if (definition?.name && definition.inputSchema) {
      validators.set(definition.name, compileSchemaValidator(definition.inputSchema));
    }
  }
  return validators;
}

function createSchemaMismatchLogger() {
  // Set UMBRA_SCHEMA_WARN=0 to silence the staged report.
  const enabled = process.env.UMBRA_SCHEMA_WARN !== '0';
  const seen = new Set();
  return function report(toolName, issues) {
    if (!enabled || issues.length === 0) {
      return;
    }
    for (const issue of issues) {
      const signature = `${toolName}|${issue}`;
      if (seen.has(signature)) {
        continue;
      }
      if (seen.size < 200) {
        seen.add(signature);
      }
      console.error(`[umbra] schema mismatch (not enforced) ${toolName}: ${issue}`);
    }
  };
}

// The advertised tool surface for one server build: the built-in catalog, plus
// whatever the optional local plugins in mcp-server/plugins/ register. An
// install with no plugins folder gets the built-in catalog unchanged, which is
// what the published package always sees.
export function resolveToolDefinitions({ plugins = null } = {}) {
  if (typeof toolCatalog.buildToolDefinitions === 'function') {
    return toolCatalog.buildToolDefinitions({ plugins });
  }
  return toolCatalog.TOOL_DEFINITIONS.slice();
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

  throw new Error(
    [
      'No shared key configured. The extension and this server pair on one key, so set either:',
      '  UMBRA_SHARED_KEY=<key>            the key itself',
      `  UMBRA_SHARED_KEY_FILE=<path>      a file holding it, canonically ${resolveSharedKeyPath()}`,
      'Get a key from the Generate button on the Umbra extension options page, which prints the',
      'full environment line to paste into your MCP client config, or run: umbra pair <key>',
    ].join('\n'),
  );
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

  const plugins = await loadPlugins();
  const pluginHandlers = plugins.handlers;
  const toolDefinitions = resolveToolDefinitions({ plugins });
  const toolsByName = new Map(toolDefinitions.map((definition) => [definition.name, definition]));
  const schemaValidators = createSchemaValidators(toolDefinitions);
  const reportSchemaMismatch = createSchemaMismatchLogger();

  const sessionId = process.env.UMBRA_SESSION_ID || createSessionId();
  const useRustBroker =
    process.env.UMBRA_MCP_SHIM_MODE === 'rust' ||
    process.env.UMBRA_BROKER_MODE === 'rust';
  const bridge = useRustBroker
    ? new RustBrokerClient({
        sessionId,
        requestTimeoutMs,
        pluginHandlers,
      })
    : new LocalBridgeServer({
        sharedKey,
        sessionId,
        portStart,
        portEnd,
        requestTimeoutMs,
        bindTimeoutMs,
        pluginHandlers,
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
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    const definition = toolsByName.get(toolName);

    if (!definition) {
      throw new Error(
        `Unknown tool: ${toolName}. Tools contributed by an optional local plugin appear only when that plugin is installed in mcp-server/plugins/.`,
      );
    }

    const validate = schemaValidators.get(toolName);
    if (validate) {
      reportSchemaMismatch(toolName, validate(args));
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

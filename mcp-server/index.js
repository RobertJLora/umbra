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
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { createSessionId } from './auth.js';
import { LocalBridgeServer, parseEnvNumber } from './bridge-core.js';
import { RustBrokerClient } from './rust-broker-client.js';
import { expandUserPath, resolveSharedKeyPath } from './config.js';
import { assertAllowedFsPath } from './fs-guard.js';
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

// Tools whose result carries image bytes and which therefore write a file when
// the caller names one. Everything else returns JSON, so this set is what gates
// the only disk write in the server.
const FILE_WRITING_TOOLS = new Set(['browser_screenshot', 'browser_gif']);

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

// The recorder is the only producer of a type the screenshot resolver has never
// had to know about, so it is answered here and everything else falls through
// to the resolver unchanged.
function resolveFileWritingMimeType(result, args = {}) {
  const reported = typeof result?.mimeType === 'string' ? result.mimeType.trim().toLowerCase() : '';
  if (reported === 'image/gif') {
    return 'image/gif';
  }
  return resolveScreenshotMimeType(result, args);
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

  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    throw new Error(`outputPath directory does not exist: ${parent}. Create it first, or pass a path inside an existing directory.`);
  }
  assertAllowedFsPath(realParent, { kind: 'directory' });

  const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error(`outputPath refuses to overwrite a symlink: ${resolved}`);
    }
    if (!existing.isFile()) {
      throw new Error(`outputPath exists and is not a regular file: ${resolved}`);
    }
  }

  return resolved;
}

export function buildMcpResponse(toolName, result, args = {}) {
  if (FILE_WRITING_TOOLS.has(toolName) && result?.data) {
    const outputPath = typeof args.outputPath === 'string' ? args.outputPath.trim() : '';
    const mimeType = resolveFileWritingMimeType(result, args);
    if (outputPath) {
      const resolvedOutputPath = resolveOutputPath(outputPath);
      const imageBuffer = Buffer.from(result.data, 'base64');
      // Overwriting stays the behaviour, because re-capturing to a fixed path is
      // the normal way this tool is used. What was missing is any signal that a
      // file was replaced, so a caller that clobbered something had no way to
      // know from the result.
      const replaced = fs.statSync(resolvedOutputPath, { throwIfNoEntry: false });
      fs.writeFileSync(resolvedOutputPath, imageBuffer);
      const structuredContent = toolName === 'browser_gif'
        ? {
          tabId: result.tabId,
          mimeType,
          outputPath: resolvedOutputPath,
          bytes: imageBuffer.length,
          replacedExistingFile: Boolean(replaced),
          replacedBytes: replaced ? replaced.size : null,
          frameCount: result.frameCount ?? null,
          droppedFrames: result.droppedFrames ?? 0,
          failedCaptures: result.failedCaptures ?? 0,
          truncatedFrames: Boolean(result.truncatedFrames),
          durationMs: result.durationMs ?? null,
          fps: result.fps ?? null,
          width: result.width ?? null,
          height: result.height ?? null,
        }
        : {
          tabId: result.tabId,
          activated: Boolean(result.activated),
          mimeType,
          outputPath: resolvedOutputPath,
          bytes: imageBuffer.length,
          replacedExistingFile: Boolean(replaced),
          replacedBytes: replaced ? replaced.size : null,
          cropped: Boolean(result.cropped),
          region: result.region || null,
          preflight: result.preflight || null,
        };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    }

    if (toolName === 'browser_gif') {
      // An animation returned inline is the whole file in model context, which
      // is the mistake the disk-write branch above exists to avoid. The call
      // handler refuses an export with no outputPath before the frames are ever
      // encoded; this is the same rule for any other caller of this function.
      throw new Error('browser_gif export requires outputPath so the animation is written to disk instead of returned inline.');
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
  // A non-finite number is still `typeof number`, so reporting the bare typeof
  // produced "expected number, received number", which tells a caller nothing.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? 'NaN' : (value > 0 ? 'Infinity' : '-Infinity');
  }
  return typeof value;
}

export const REQUIRED_ISSUE_SUFFIX = ' is required and missing';

export function missingRequiredIssues(issues) {
  return issues.filter((issue) => issue.endsWith(REQUIRED_ISSUE_SUFFIX));
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

// Every unusable key state gets the same actionable block, because the fix is
// the same in all of them and the differences only matter as one extra line
// naming what went wrong.
export class StartupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StartupError';
  }
}

function pairingGuidance(problem) {
  return new StartupError(
    [
      problem,
      'The extension and this server pair on one key, so set either:',
      '  UMBRA_SHARED_KEY=<key>            the key itself',
      `  UMBRA_SHARED_KEY_FILE=<path>      a file holding it, canonically ${path.join(os.homedir(), '.umbra', 'shared-key')}`,
      'Get a key from the Generate button on the Umbra extension options page, which prints the',
      'full environment line to paste into your MCP client config, or run: umbra pair',
    ].join('\n'),
  );
}

export function loadSharedKey(env = process.env) {
  const directKey = env.UMBRA_SHARED_KEY?.trim();
  if (directKey) {
    return directKey;
  }

  // An unset variable falls back to the canonical key file, which is where
  // `umbra pair` writes. Without this, `node index.js` reported "no shared key"
  // while the key sat at the very path the message calls canonical. A leading
  // tilde is expanded here for the same reason config.js expands it: an MCP
  // client config is JSON, so `~/.umbra/shared-key` arrives literally.
  const configured = env.UMBRA_SHARED_KEY_FILE?.trim();
  const keyFile = configured ? path.resolve(expandUserPath(configured)) : resolveSharedKeyPath();

  let contents;
  try {
    contents = fs.readFileSync(keyFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !configured) {
      throw pairingGuidance('No shared key configured.');
    }
    const expandedNote = configured && configured !== keyFile
      ? ` (from UMBRA_SHARED_KEY_FILE=${configured})`
      : '';
    throw pairingGuidance(
      `UMBRA_SHARED_KEY_FILE points at ${keyFile}${expandedNote}, which could not be read (${error?.code || error?.message}).`,
    );
  }

  const key = contents.trim();
  if (!key) {
    // A blank key file is a truncated write or a half-finished install, not a
    // request for a zero-length HMAC key that every local process can guess.
    throw pairingGuidance(`The shared key file ${keyFile} is empty.`);
  }
  return key;
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
  const unavailableToolReasons = new Map();
  for (const entry of plugins.unavailable || []) {
    for (const toolName of entry.toolNames || []) {
      unavailableToolReasons.set(toolName, entry.reason);
    }
  }
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
        sharedKey,
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
      // A plugin that is present but reported itself unavailable is a different
      // situation with a different fix, and its reason is the one the caller can
      // act on. Saying "not installed" there sends them to install something
      // that is already there.
      const unavailable = unavailableToolReasons.get(toolName);
      if (unavailable) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${toolName} is installed but unavailable: ${unavailable}`,
        );
      }
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${toolName}. Tools contributed by an optional local plugin appear only when that plugin is installed in mcp-server/plugins/.`,
      );
    }

    const validate = schemaValidators.get(toolName);
    if (validate) {
      const issues = validate(args);
      // A missing required parameter is a caller error, so it comes back as one
      // instead of being forwarded to the extension without the parameter and
      // reported as a connection failure. Type and unknown-property mismatches
      // stay staged and logged, because the extension coerces those already.
      const missing = missingRequiredIssues(issues);
      if (missing.length > 0) {
        throw new McpError(ErrorCode.InvalidParams, `${toolName}: ${missing.join('; ')}`);
      }
      reportSchemaMismatch(toolName, issues);
    }

    // Checked before the call rather than after it: an export with nowhere to go
    // would encode the whole animation, cross the transport, and then fail on
    // the way out with the work already spent.
    if (toolName === 'browser_gif' && String(args.action || '') === 'export') {
      const requested = typeof args.outputPath === 'string' ? args.outputPath.trim() : '';
      if (!requested) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'browser_gif: export requires outputPath, an absolute path the animation is written to.',
        );
      }
    }

    try {
      const result = await bridge.sendCommand(toolName, args);
      return buildMcpResponse(toolName, result, args);
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      // The extension's own error code reaches a batch child but used to be
      // dropped on a single call, so a caller could branch on it only inside a
      // batch. Both lanes now expose the same field.
      const code = typeof error?.code === 'string' ? error.code : '';
      throw new McpError(
        ErrorCode.InternalError,
        error?.message || String(error),
        code ? { extensionCode: code } : undefined,
      );
    }
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
    // A configuration problem is a message to read and fix, so it prints as one.
    // A stack still comes out for anything unexpected, which is a bug report.
    if (error instanceof StartupError) {
      console.error(`[umbra] ${error.message}`);
    } else {
      console.error(`[umbra] ${error.stack || error.message}`);
    }
    process.exit(1);
  });
}

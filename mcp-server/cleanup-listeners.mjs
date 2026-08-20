import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'index.js');
const DEFAULT_HEALTH_TIMEOUT_MS = 500;

function parseArgs(argv) {
  const options = {
    portStart: Number(process.env.UMBRA_PORT_START || 47821),
    portEnd: Number(process.env.UMBRA_PORT_END || 47852),
    preservePorts: new Set(),
    dryRun: false,
    onlyDisconnected: false,
    minAgeSeconds: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port-start') {
      options.portStart = Number(argv[++index]);
    } else if (arg.startsWith('--port-start=')) {
      options.portStart = Number(arg.slice('--port-start='.length));
    } else if (arg === '--port-end') {
      options.portEnd = Number(argv[++index]);
    } else if (arg.startsWith('--port-end=')) {
      options.portEnd = Number(arg.slice('--port-end='.length));
    } else if (arg === '--preserve-port') {
      options.preservePorts.add(Number(argv[++index]));
    } else if (arg.startsWith('--preserve-port=')) {
      options.preservePorts.add(Number(arg.slice('--preserve-port='.length)));
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--only-disconnected') {
      options.onlyDisconnected = true;
    } else if (arg === '--min-age-seconds') {
      options.minAgeSeconds = Number(argv[++index]);
    } else if (arg.startsWith('--min-age-seconds=')) {
      options.minAgeSeconds = Number(arg.slice('--min-age-seconds='.length));
    } else {
      throw new Error(`Unknown cleanup-listeners option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.portStart) || !Number.isFinite(options.portEnd) || options.portStart > options.portEnd) {
    throw new Error(`Invalid port range: ${options.portStart}-${options.portEnd}`);
  }
  if (!Number.isFinite(options.minAgeSeconds) || options.minAgeSeconds < 0) {
    throw new Error(`Invalid min age: ${options.minAgeSeconds}`);
  }

  return options;
}

async function run(command, args) {
  try {
    return await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      code: error.code || 1,
    };
  }
}

async function commandForPid(pid) {
  const { stdout } = await run('ps', ['-p', String(pid), '-o', 'command=']);
  return stdout.trim();
}

export function parseElapsedSeconds(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return null;
  }

  const [daysPart, timePart] = value.includes('-') ? value.split('-', 2) : ['0', value];
  const parts = timePart.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  let seconds = Number(daysPart) * 24 * 60 * 60;
  if (parts.length === 3) {
    seconds += parts[0] * 60 * 60 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds += parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    seconds += parts[0];
  } else {
    return null;
  }

  return seconds;
}

async function ageSecondsForPid(pid) {
  const { stdout } = await run('ps', ['-p', String(pid), '-o', 'etime=']);
  return parseElapsedSeconds(stdout);
}

async function listListeners({ portStart, portEnd }) {
  const { stdout } = await run('lsof', ['-nP', `-iTCP:${portStart}-${portEnd}`, '-sTCP:LISTEN']);
  return stdout.split('\n').slice(1).filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/);
    const name = parts.find((part) => /:(\d+)$/.test(part) || /:(\d+)->/.test(part)) || '';
    const match = name.match(/:(\d+)(?:->|$)/);
    return {
      commandName: parts[0],
      pid: Number(parts[1]),
      port: match ? Number(match[1]) : null,
      raw: line,
    };
  }).filter((listener) => Number.isInteger(listener.pid) && Number.isInteger(listener.port));
}

function isBridgeServerCommand(command) {
  return command.includes(serverPath)
    || command.includes('/umbra/mcp-server/index.js')
    || /\bnode\s+(?:\.\/)?index\.js\b/.test(command);
}

export function isBridgeHealth(health) {
  return health?.ok === true && health.name === 'umbra';
}

function healthExtensionConnected(health) {
  return health?.extensionConnected === true || health?.extension_connected === true;
}

async function healthForPort(port, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
  return await new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/healthz',
      timeout: timeoutMs,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8192) {
          request.destroy(new Error('Health response too large.'));
        }
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve({ ok: false, error: `status_${response.statusCode}` });
          return;
        }

        try {
          resolve({ ok: true, ...JSON.parse(body) });
        } catch (error) {
          resolve({ ok: false, error: error?.message || 'invalid_health_json' });
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('health_timeout'));
    });
    request.on('error', (error) => {
      resolve({ ok: false, error: error?.message || 'health_failed' });
    });
  });
}

async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePid(pid, dryRun) {
  if (dryRun) {
    return 'dry-run';
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'already-exited';
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await delay(100);
    if (!await isAlive(pid)) {
      return 'terminated';
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
    return 'killed';
  } catch {
    return 'already-exited';
  }
}

function decideCleanupAction({ isBridgeServer, preserved, options, health, ageSeconds }) {
  if (!isBridgeServer) {
    return { allowed: false, reason: 'not_bridge_server' };
  }

  if (preserved) {
    return { allowed: false, reason: 'preserved_port' };
  }

  if (options.onlyDisconnected) {
    if (!health?.ok) {
      return { allowed: false, reason: 'health_unavailable' };
    }

    if (healthExtensionConnected(health) !== false) {
      return { allowed: false, reason: 'extension_connected' };
    }
  }

  if (options.minAgeSeconds > 0) {
    if (!Number.isFinite(ageSeconds)) {
      return { allowed: false, reason: 'age_unknown' };
    }

    if (ageSeconds < options.minAgeSeconds) {
      return { allowed: false, reason: 'too_young' };
    }
  }

  return { allowed: true, reason: 'cleanup_allowed' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const listeners = await listListeners(options);
  const results = [];

  for (const listener of listeners) {
    const command = await commandForPid(listener.pid);
    const preserved = options.preservePorts.has(listener.port);
    const commandMatchesBridge = isBridgeServerCommand(command);
    const health = !preserved && (options.onlyDisconnected || !commandMatchesBridge)
      ? await healthForPort(listener.port)
      : null;
    const isBridgeServer = commandMatchesBridge || isBridgeHealth(health);
    const ageSeconds = options.minAgeSeconds > 0 && isBridgeServer && !preserved
      ? await ageSecondsForPid(listener.pid)
      : null;
    const decision = decideCleanupAction({ isBridgeServer, preserved, options, health, ageSeconds });
    const action = decision.allowed ? await terminatePid(listener.pid, options.dryRun) : 'skipped';

    results.push({
      pid: listener.pid,
      port: listener.port,
      command,
      isBridgeServer,
      preserved,
      health,
      ageSeconds,
      skipReason: decision.allowed ? null : decision.reason,
      action,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: options.dryRun,
    portStart: options.portStart,
    portEnd: options.portEnd,
    preservedPorts: [...options.preservePorts],
    onlyDisconnected: options.onlyDisconnected,
    minAgeSeconds: options.minAgeSeconds,
    cleaned: results.filter((result) => !result.preserved && result.isBridgeServer && result.action !== 'skipped').length,
    results,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

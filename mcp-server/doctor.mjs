import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TOOL_DEFINITIONS } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const activeExtensionDir = '/Users/RobertLora/Documents/Workspaces/Projects/Active/umbra/extension';
const defaultChromeProfilePrefs = '/Users/RobertLora/Library/Application Support/Google/Chrome/Profile 12/Secure Preferences';
const legacyExtensionId = 'kkfedeeiobahmhcgpffcelpepiljiomk';
const portStart = Number(process.env.UMBRA_PORT_START || 47821);
const portEnd = Number(process.env.UMBRA_PORT_END || 47852);
const defaultSocketPath = process.env.UMBRA_BROKER_SOCKET || '/tmp/umbra-rust-broker.sock';
const defaultIdleTtlMs = Number(process.env.UMBRA_IDLE_EMPTY_SESSION_TTL_MS || 20 * 60 * 1000);
const defaultIdleMinAgeMs = Number(process.env.UMBRA_IDLE_EMPTY_SESSION_MIN_AGE_MS || 5 * 60 * 1000);

function parseArgs(argv) {
  const options = {
    fix: false,
    dryRun: false,
    verifyHealth: false,
    ttlMs: defaultIdleTtlMs,
    minAgeMs: defaultIdleMinAgeMs,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fix') {
      options.fix = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verify-health') {
      options.verifyHealth = true;
    } else if (arg === '--ttl-ms') {
      options.ttlMs = Number(argv[++index]);
    } else if (arg.startsWith('--ttl-ms=')) {
      options.ttlMs = Number(arg.slice('--ttl-ms='.length));
    } else if (arg === '--min-age-ms') {
      options.minAgeMs = Number(argv[++index]);
    } else if (arg.startsWith('--min-age-ms=')) {
      options.minAgeMs = Number(arg.slice('--min-age-ms='.length));
    } else {
      throw new Error(`Unknown doctor option: ${arg}`);
    }
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
    throw new Error(`Invalid --ttl-ms: ${options.ttlMs}`);
  }
  if (!Number.isFinite(options.minAgeMs) || options.minAgeMs < 0) {
    throw new Error(`Invalid --min-age-ms: ${options.minAgeMs}`);
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function exists(filePath) {
  return await fsp.access(filePath).then(() => true).catch(() => false);
}

async function health(port) {
  return await new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/healthz',
      timeout: 500,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ ok: false, port, error: 'invalid_json' });
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

function normalizeHealth(status) {
  const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
  const extensionConnected = status?.extensionConnected === true || status?.extension_connected === true;
  const emptyShimSessions = sessions.filter((session) => {
    const channelId = session?.channel?.channel_id || session?.channel?.channelId || '';
    return session?.connected === true
      && channelId === 'mcp-shim'
      && Number(session?.pending_requests ?? session?.pendingRequests ?? 0) === 0
      && (session?.group_id ?? session?.groupId ?? null) === null
      && (session?.active_tab_id ?? session?.activeTabId ?? null) === null
      && Array.isArray(session?.tab_ids ?? session?.tabIds)
      && (session?.tab_ids ?? session?.tabIds).length === 0;
  });
  const pendingRequestCount = sessions.reduce(
    (sum, session) => sum + Number(session?.pending_requests ?? session?.pendingRequests ?? 0),
    0,
  );
  const diagnostics = status?.diagnostics || {};
  const idleEmptyShimSessionCount = Number(
    diagnostics.idle_empty_shim_session_count
      ?? diagnostics.idleEmptyShimSessionCount
      ?? 0,
  );
  const derivedStatus = diagnostics.status
    || (idleEmptyShimSessionCount > 0 ? 'jammed' : emptyShimSessions.length > 0 || !extensionConnected ? 'degraded' : 'ok');
  return {
    port: status?.port ?? status?.listener?.port ?? null,
    sessionId: status?.sessionId ?? status?.session_id ?? null,
    extensionConnected,
    socketPath: status?.socketPath || status?.socket_path || null,
    sessions,
    activeSessionCount: sessions.length,
    connectedSessionCount: sessions.filter((session) => session?.connected === true).length,
    emptyShimSessionCount: Number(
      diagnostics.empty_shim_session_count
        ?? diagnostics.emptyShimSessionCount
        ?? emptyShimSessions.length,
    ),
    idleEmptyShimSessionCount,
    protectedSessionCount: Number(
      diagnostics.protected_session_count
        ?? diagnostics.protectedSessionCount
        ?? sessions.length - emptyShimSessions.length,
    ),
    pendingRequestCount: Number(
      diagnostics.pending_request_count
        ?? diagnostics.pendingRequestCount
        ?? pendingRequestCount,
    ),
    status: derivedStatus,
    reasonCodes: diagnostics.reason_codes || diagnostics.reasonCodes || [],
    recommendedAction: diagnostics.recommended_action || diagnostics.recommendedAction || 'none',
    reapCandidateSessionIds: diagnostics.reap_candidate_session_ids || diagnostics.reapCandidateSessionIds || [],
  };
}

async function sendBrokerRequest(socketPath, payload, timeoutMs = 1000) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for broker socket ${socketPath}.`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      clearTimeout(timer);
      socket.destroy();
      try {
        const message = JSON.parse(buffer.slice(0, newlineIndex));
        if (message?.ok === true) {
          resolve(message.result);
        } else {
          reject(new Error(message?.error?.message || 'broker request failed'));
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function reapIdleEmptySessions(socketPath, options) {
  const first = await sendBrokerRequest(socketPath, {
    type: 'reap_idle_empty_sessions',
    id: `doctor_reap_preview_${Date.now()}`,
    ttl_ms: options.ttlMs,
    min_age_ms: options.minAgeMs,
    dry_run: true,
  });
  await delay(1500);
  const second = await sendBrokerRequest(socketPath, {
    type: 'reap_idle_empty_sessions',
    id: `doctor_reap_confirm_${Date.now()}`,
    ttl_ms: options.ttlMs,
    min_age_ms: options.minAgeMs,
    dry_run: true,
  });
  const firstIds = (first.candidates || []).map((session) => session.session_id).sort().join('\n');
  const secondIds = (second.candidates || []).map((session) => session.session_id).sort().join('\n');
  if (firstIds !== secondIds) {
    return {
      ok: false,
      skipped: true,
      reason: 'candidate_set_changed_between_health_snapshots',
      preview: first,
      confirmation: second,
    };
  }
  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: second };
  }
  const fixed = await sendBrokerRequest(socketPath, {
    type: 'reap_idle_empty_sessions',
    id: `doctor_reap_fix_${Date.now()}`,
    ttl_ms: options.ttlMs,
    min_age_ms: options.minAgeMs,
    dry_run: false,
  });
  return { ok: true, dryRun: false, preview: second, fixed };
}

async function snapshotDirByHash(dir) {
  if (!(await exists(dir))) {
    return null;
  }
  const files = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else {
        files.push(path.relative(dir, filePath));
      }
    }
  }
  await walk(dir);
  const snapshot = [];
  for (const file of files.sort()) {
    const content = await fsp.readFile(path.join(dir, file));
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    snapshot.push(`${file}:${hash}`);
  }
  return snapshot.join('\n');
}

async function chromeRegistrationStatus() {
  const prefsPath = process.env.UMBRA_CHROME_PREFS || defaultChromeProfilePrefs;
  const status = {
    profilePrefsPath: prefsPath,
    extensionId: null,
    found: false,
    registeredPath: null,
    registeredPathExists: false,
    expectedPath: activeExtensionDir,
    matchesExpectedPath: false,
  };
  try {
    const prefs = await readJson(prefsPath);
    const allSettings = prefs?.extensions?.settings || {};
    const matchedEntry = Object.entries(allSettings).find(([, settings]) => {
      if (!settings?.path) return false;
      return path.resolve(settings.path) === path.resolve(activeExtensionDir);
    });
    const fallbackSettings = allSettings[legacyExtensionId] || null;
    const extensionId = matchedEntry?.[0] || (fallbackSettings ? legacyExtensionId : null);
    const settings = matchedEntry?.[1] || fallbackSettings;
    status.extensionId = extensionId;
    status.found = settings !== null;
    if (!settings) {
      return status;
    }
    status.registeredPath = settings.path || null;
    status.registeredPathExists = status.registeredPath ? await exists(status.registeredPath) : false;
    status.matchesExpectedPath = status.registeredPath
      ? path.resolve(status.registeredPath) === path.resolve(activeExtensionDir)
      : false;
    return status;
  } catch (error) {
    status.error = error?.message || String(error);
    return status;
  }
}

const options = parseArgs(process.argv.slice(2));
const canonicalManifest = await readJson(path.join(repoRoot, 'extension', 'manifest.json'));
const activeManifestPath = path.join(activeExtensionDir, 'manifest.json');
const activeManifest = await exists(activeManifestPath) ? await readJson(activeManifestPath) : null;
const canonicalHash = await snapshotDirByHash(path.join(repoRoot, 'extension'));
const activeHash = await snapshotDirByHash(activeExtensionDir);
const chromeRegistration = await chromeRegistrationStatus();
const listeners = [];
for (let port = portStart; port <= portEnd; port += 1) {
  const status = await health(port);
  if (status) {
    listeners.push({ raw: status, normalized: normalizeHealth(status) });
  }
}
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const missingDocs = TOOL_DEFINITIONS.map((tool) => tool.name).filter((name) => !readme.includes(`\`${name}\``));

const report = {
  generatedAt: new Date().toISOString(),
  extension: {
    canonicalVersion: canonicalManifest.version,
    activeVersion: activeManifest?.version || null,
    activeExtensionDir,
    activeExists: activeManifest !== null,
    activeMatchesCanonicalByHash: canonicalHash !== null && activeHash !== null && canonicalHash === activeHash,
    chromeRegistration,
  },
  broker: {
    mode: process.env.UMBRA_BROKER_MODE || 'rust-default-via-launcher',
    socketPath: listeners.find((item) => item.normalized.socketPath)?.normalized.socketPath || defaultSocketPath,
  },
  listeners: {
    range: `${portStart}-${portEnd}`,
    count: listeners.length,
    connected: listeners.filter((item) => item.normalized.extensionConnected === true).length,
    disconnected: listeners.filter((item) => item.normalized.extensionConnected !== true).length,
    emptyShimSessions: listeners.reduce((sum, item) => sum + item.normalized.emptyShimSessionCount, 0),
    idleEmptyShimSessions: listeners.reduce((sum, item) => sum + item.normalized.idleEmptyShimSessionCount, 0),
    pendingRequests: listeners.reduce((sum, item) => sum + item.normalized.pendingRequestCount, 0),
    ports: listeners.map((item) => ({
      port: item.normalized.port,
      sessionId: item.normalized.sessionId,
      extensionConnected: item.normalized.extensionConnected,
      status: item.normalized.status,
      activeSessionCount: item.normalized.activeSessionCount,
      connectedSessionCount: item.normalized.connectedSessionCount,
      emptyShimSessionCount: item.normalized.emptyShimSessionCount,
      idleEmptyShimSessionCount: item.normalized.idleEmptyShimSessionCount,
      protectedSessionCount: item.normalized.protectedSessionCount,
      pendingRequestCount: item.normalized.pendingRequestCount,
      reasonCodes: item.normalized.reasonCodes,
      recommendedAction: item.normalized.recommendedAction,
      reapCandidateSessionIds: item.normalized.reapCandidateSessionIds,
    })),
  },
  drift: {
    missingToolDocs: missingDocs,
  },
};

if (options.fix) {
  const socketPath = report.broker.socketPath;
  report.recovery = {
    mode: options.dryRun ? 'dry-run' : 'fix',
    ttlMs: options.ttlMs,
    minAgeMs: options.minAgeMs,
    idleEmptySessionReap: null,
  };
  try {
    report.recovery.idleEmptySessionReap = await reapIdleEmptySessions(socketPath, options);
  } catch (error) {
    report.recovery.idleEmptySessionReap = {
      ok: false,
      error: error?.message || String(error),
    };
  }
  if (options.verifyHealth) {
    await delay(500);
    const refreshed = [];
    for (let port = portStart; port <= portEnd; port += 1) {
      const status = await health(port);
      if (status) {
        refreshed.push(normalizeHealth(status));
      }
    }
    report.recovery.postFixListeners = refreshed.map((item) => ({
      port: item.port,
      extensionConnected: item.extensionConnected,
      status: item.status,
      activeSessionCount: item.activeSessionCount,
      connectedSessionCount: item.connectedSessionCount,
      emptyShimSessionCount: item.emptyShimSessionCount,
      idleEmptyShimSessionCount: item.idleEmptyShimSessionCount,
      pendingRequestCount: item.pendingRequestCount,
    }));
  }
}

console.log(JSON.stringify(report, null, 2));

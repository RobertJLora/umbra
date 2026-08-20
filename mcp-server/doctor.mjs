import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describeSocketPathProblem, resolveBrokerSocketPath, resolveDownloadDir } from './config.js';
import { TOOL_DEFINITIONS } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// The extension a browser actually loaded. The default is this checkout's own
// `extension/` folder, because loading unpacked from the repository is the
// documented setup. Anyone who loaded a copy from somewhere else points
// UMBRA_EXTENSION_DIR at it and gets a real drift comparison back.
const activeExtensionDirFromEnv = process.env.UMBRA_EXTENSION_DIR?.trim() || '';
const activeExtensionDir = activeExtensionDirFromEnv
  ? path.resolve(activeExtensionDirFromEnv)
  : path.join(repoRoot, 'extension');
const activeExtensionDirSource = activeExtensionDirFromEnv ? 'UMBRA_EXTENSION_DIR' : 'repository';

// Set UMBRA_EXTENSION_ID to pin the check to one install. Left unset, the
// Chrome profile scan matches on the loaded directory instead, which is the
// only signal that works before an id exists.
const pinnedExtensionId = process.env.UMBRA_EXTENSION_ID?.trim() || '';

// Chrome's stock user data directory per platform. Every profile lives inside
// it as a subdirectory holding a `Secure Preferences` file, so the scan below
// discovers profiles rather than naming one. Point UMBRA_CHROME_USER_DATA_DIR
// at a different root for a Chromium build or a test profile, or point
// UMBRA_CHROME_PREFS straight at one `Secure Preferences` file to skip the scan.
function defaultChromeUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  return path.join(home, '.config', 'google-chrome');
}

const chromeUserDataDir = process.env.UMBRA_CHROME_USER_DATA_DIR?.trim()
  ? path.resolve(process.env.UMBRA_CHROME_USER_DATA_DIR.trim())
  : defaultChromeUserDataDir();
const pinnedChromePrefs = process.env.UMBRA_CHROME_PREFS?.trim() || '';

const portStart = Number(process.env.UMBRA_PORT_START || 47821);
const portEnd = Number(process.env.UMBRA_PORT_END || 47852);
const defaultSocketPath = resolveBrokerSocketPath();
const defaultIdleTtlMs = Number(process.env.UMBRA_IDLE_EMPTY_SESSION_TTL_MS || 20 * 60 * 1000);
const defaultIdleMinAgeMs = Number(process.env.UMBRA_IDLE_EMPTY_SESSION_MIN_AGE_MS || 5 * 60 * 1000);

// A bad option is a caller mistake, not a crash. `umbra doctor` maps this exit
// status onto its own one-line error, so the diagnostic reads like every other
// subcommand instead of printing a Node stack at the user.
export const USAGE_EXIT_CODE = 2;

class DoctorUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DoctorUsageError';
  }
}

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
      throw new DoctorUsageError(`Unknown doctor option: ${arg}`);
    }
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
    throw new DoctorUsageError(`Invalid --ttl-ms: ${options.ttlMs}`);
  }
  if (!Number.isFinite(options.minAgeMs) || options.minAgeMs < 0) {
    throw new DoctorUsageError(`Invalid --min-age-ms: ${options.minAgeMs}`);
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

// Every Chrome profile that carries a `Secure Preferences` file, newest first
// so the profile a person actually uses is checked before dormant ones. An
// explicit UMBRA_CHROME_PREFS wins outright and is returned on its own.
async function discoverChromeProfilePrefs() {
  if (pinnedChromePrefs) {
    return [{ profile: path.basename(path.dirname(pinnedChromePrefs)), prefsPath: path.resolve(pinnedChromePrefs) }];
  }
  const entries = await fsp.readdir(chromeUserDataDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const prefsPath = path.join(chromeUserDataDir, entry.name, 'Secure Preferences');
    const stat = await fsp.stat(prefsPath).catch(() => null);
    if (!stat) {
      continue;
    }
    candidates.push({ profile: entry.name, prefsPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates;
}

// An unpacked extension stores an absolute `path`; a Web Store install stores a
// path relative to the profile's own `Extensions` directory. Resolve both so a
// store install is not misreported as missing.
function resolveRegisteredPath(registeredPath, prefsPath) {
  if (!registeredPath) {
    return null;
  }
  if (path.isAbsolute(registeredPath)) {
    return path.resolve(registeredPath);
  }
  return path.resolve(path.dirname(prefsPath), 'Extensions', registeredPath);
}

async function chromeRegistrationStatus() {
  const profiles = await discoverChromeProfilePrefs();
  const status = {
    userDataDir: chromeUserDataDir,
    prefsSource: pinnedChromePrefs ? 'UMBRA_CHROME_PREFS' : 'profile-scan',
    scannedProfiles: profiles.map((candidate) => candidate.profile),
    profile: null,
    profilePrefsPath: null,
    extensionId: null,
    found: false,
    registeredPath: null,
    registeredPathExists: false,
    expectedPath: activeExtensionDir,
    matchesExpectedPath: false,
    reason: null,
  };

  if (profiles.length === 0) {
    status.reason = `No Chrome profile found under ${chromeUserDataDir}. Set UMBRA_CHROME_USER_DATA_DIR if Chrome stores its profiles somewhere else.`;
    return status;
  }

  const errors = [];
  let pinnedMatch = null;
  for (const candidate of profiles) {
    let prefs = null;
    try {
      prefs = await readJson(candidate.prefsPath);
    } catch (error) {
      errors.push(`${candidate.profile}: ${error?.message || String(error)}`);
      continue;
    }
    const allSettings = prefs?.extensions?.settings || {};
    for (const [extensionId, settings] of Object.entries(allSettings)) {
      const registeredPath = resolveRegisteredPath(settings?.path, candidate.prefsPath);
      const matchesPath = registeredPath !== null && registeredPath === path.resolve(activeExtensionDir);
      const matchesPinnedId = pinnedExtensionId !== '' && extensionId === pinnedExtensionId;
      if (!matchesPath && !matchesPinnedId) {
        continue;
      }
      const hit = {
        profile: candidate.profile,
        prefsPath: candidate.prefsPath,
        extensionId,
        registeredPath,
        matchesPath,
      };
      // A directory match is the stronger signal, so take it immediately and
      // keep a pinned-id match only as the answer when no directory matches.
      if (matchesPath) {
        status.profile = hit.profile;
        status.profilePrefsPath = hit.prefsPath;
        status.extensionId = hit.extensionId;
        status.found = true;
        status.registeredPath = hit.registeredPath;
        status.registeredPathExists = await exists(hit.registeredPath);
        status.matchesExpectedPath = true;
        if (errors.length > 0) {
          status.errors = errors;
        }
        return status;
      }
      pinnedMatch = pinnedMatch || hit;
    }
  }

  if (pinnedMatch) {
    status.profile = pinnedMatch.profile;
    status.profilePrefsPath = pinnedMatch.prefsPath;
    status.extensionId = pinnedMatch.extensionId;
    status.found = true;
    status.registeredPath = pinnedMatch.registeredPath;
    status.registeredPathExists = pinnedMatch.registeredPath ? await exists(pinnedMatch.registeredPath) : false;
    status.matchesExpectedPath = false;
    status.reason = `UMBRA_EXTENSION_ID ${pinnedExtensionId} is registered in profile ${pinnedMatch.profile} from ${pinnedMatch.registeredPath || 'an unrecorded path'}, which is not ${activeExtensionDir}.`;
  } else {
    status.reason = `No Chrome profile under ${chromeUserDataDir} has ${activeExtensionDir} loaded. Load it unpacked from chrome://extensions, or point UMBRA_EXTENSION_DIR at the copy the browser loaded.`;
  }
  if (errors.length > 0) {
    status.errors = errors;
  }
  return status;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  if (error instanceof DoctorUsageError) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write('Options are --fix, --dry-run, --verify-health, --ttl-ms <ms>, and --min-age-ms <ms>.\n');
    process.exit(USAGE_EXIT_CODE);
  }
  throw error;
}
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

// Human-readable problems, so a reader does not have to know that
// `activeExists: false` means a directory is missing. Each entry names the
// thing that is wrong and the switch that fixes it.
const problems = [];
if (activeManifest === null) {
  problems.push(`Extension directory not found: no manifest.json under ${activeExtensionDir}. Set UMBRA_EXTENSION_DIR to the folder the browser loaded.`);
}
if (chromeRegistration.reason) {
  problems.push(chromeRegistration.reason);
}
if (listeners.length === 0) {
  problems.push(`No bridge listener answered on ports ${portStart}-${portEnd}. Start the companion server, or set UMBRA_PORT_START and UMBRA_PORT_END to the range it uses.`);
}

const socketPathProblem = describeSocketPathProblem(defaultSocketPath);
if (socketPathProblem) {
  problems.push(socketPathProblem);
}

const reportedSocketPath = listeners.find((item) => item.normalized.socketPath)?.normalized.socketPath || '';
if (reportedSocketPath && reportedSocketPath !== defaultSocketPath) {
  problems.push(`A listener reports its shim socket as ${reportedSocketPath} while this environment resolves ${defaultSocketPath}. Set UMBRA_BROKER_SOCKET to the path the broker actually binds, or stop the process answering on the wrong one.`);
}

const downloadDir = resolveDownloadDir();
if (!fs.existsSync(downloadDir)) {
  problems.push(`Download directory not found: ${downloadDir}. Set UMBRA_DOWNLOAD_DIR to the folder Chrome saves downloads into.`);
}

const report = {
  generatedAt: new Date().toISOString(),
  problems,
  extension: {
    canonicalVersion: canonicalManifest.version,
    activeVersion: activeManifest?.version || null,
    activeExtensionDir,
    activeExtensionDirSource,
    activeExists: activeManifest !== null,
    activeMatchesCanonicalByHash: canonicalHash !== null && activeHash !== null && canonicalHash === activeHash,
    chromeRegistration,
  },
  broker: {
    mode: process.env.UMBRA_BROKER_MODE || 'rust-default-via-launcher',
    // The resolver, never the listener's answer. `/healthz` is unauthenticated,
    // so its `socketPath` is whatever process happened to answer on a loopback
    // port, and this value decides where --fix writes session-reap commands.
    // The reported one is kept alongside it as a diagnostic.
    socketPath: defaultSocketPath,
    reportedSocketPath: listeners.find((item) => item.normalized.socketPath)?.normalized.socketPath || null,
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

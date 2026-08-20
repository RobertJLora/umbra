import os from 'node:os';
import path from 'node:path';

// Portable defaults for every path this project used to hardcode.
//
// Each resolver reads its environment variable first and otherwise derives the
// value from the running user's home directory, so no shipped source line names
// a specific machine or account. An empty or whitespace-only variable counts as
// unset, because an exported-but-blank variable is a misconfiguration rather
// than a request for an empty path.

const UMBRA_DIR_NAME = '.umbra';

function trimmedEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function umbraHome() {
  return path.join(os.homedir(), UMBRA_DIR_NAME);
}

// Chrome's stock download directory on macOS and on Linux. The extension holds
// no `downloads` permission, so it cannot read the user's real setting; anyone
// who moved their download folder sets UMBRA_DOWNLOAD_DIR.
export function resolveDownloadDir() {
  return trimmedEnv('UMBRA_DOWNLOAD_DIR') || path.join(os.homedir(), 'Downloads');
}

// Per-user socket path. The old default sat in world-writable /tmp, where
// another local account can pre-create the path and block broker startup. The
// full path stays well under the 104-byte AF_UNIX limit on macOS.
export function resolveBrokerSocketPath() {
  return trimmedEnv('UMBRA_BROKER_SOCKET') || path.join(umbraHome(), 'run', 'broker.sock');
}

// Reverse-DNS label for the optional launchd job that keeps the Rust broker
// running. Nothing bootstraps a service automatically: this label is only read
// or kicked when a matching plist already exists.
export function resolveLaunchdLabel() {
  return trimmedEnv('UMBRA_BROKER_LAUNCHD_LABEL') || 'dev.umbra.broker';
}

// The shared HMAC key file that pairs the extension with the companion server.
export function resolveSharedKeyPath() {
  return trimmedEnv('UMBRA_SHARED_KEY_FILE') || path.join(umbraHome(), 'shared-key');
}

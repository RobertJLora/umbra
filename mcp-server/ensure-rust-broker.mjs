#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RETIRED_BROKER_SOCKET_PATH,
  ensureBrokerSocketAlias,
  resolveBrokerSocketPath,
  resolveLaunchdLabel,
} from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const socketPath = resolveBrokerSocketPath();
const installedBrokerBin = path.join(os.homedir(), '.umbra', 'bin', 'Umbra Helper');
const brokerBin = process.env.UMBRA_BROKER_BIN
  || (fs.existsSync(installedBrokerBin) ? installedBrokerBin : null)
  || path.join(repoRoot, 'rust-broker', 'target', 'release', 'umbra-rust-broker');
const label = resolveLaunchdLabel();
const logPath = path.join(os.homedir(), '.umbra', 'logs', 'umbra-rust-broker.log');
const timeoutMs = Number(process.env.UMBRA_BROKER_CHECK_TIMEOUT_MS || 1500);
const waitMs = Number(process.env.UMBRA_BROKER_START_TIMEOUT_MS || 8000);

// The broker answers a health probe with one short JSON line built in
// rust-broker/src/health.rs, and this reader stops at the first newline, so the
// buffer here never grows past a few hundred bytes. No chunked framing needed.
function health() {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'health', id: 'health_check' })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newlineIndex));
        clearTimeout(timer);
        finish(message?.ok === true);
      } catch {
        finish(false);
      }
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.once('close', () => finish(false));
  });
}

function ensureDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch {
    // A concurrent starter may have created it first. A genuinely unwritable
    // path surfaces a line later as a socket bind or log redirect failure.
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function uid() {
  return process.getuid?.() ?? os.userInfo().uid;
}

function launchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function domainTarget() {
  return `gui/${uid()}`;
}

// The launchd label is only ever read or kicked. Nothing in this project writes
// a plist or bootstraps a service, so on a machine with no matching job
// isLaunchdLoaded() returns false and main() falls through to
// spawnDetachedBroker(). Installing the job is a deliberate opt-in step.
function serviceTarget() {
  return `${domainTarget()}/${label}`;
}

function isLaunchdLoaded() {
  const printed = launchctl(['print', serviceTarget()]);
  return printed.status === 0;
}

function removeStaleSocket() {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // Another starter may have already replaced the socket.
  }
}

function kickstartLaunchd() {
  if (!isLaunchdLoaded()) {
    return false;
  }
  const kicked = launchctl(['kickstart', '-k', serviceTarget()]);
  return kicked.status === 0;
}

function spawnDetachedBroker() {
  if (!fs.existsSync(brokerBin)) {
    return false;
  }
  ensureDirectory(path.dirname(logPath));
  const command = `nohup ${shellQuote(brokerBin)} >>${shellQuote(logPath)} 2>&1 &`;
  const child = spawnSync('sh', ['-c', command], {
    // Pin the socket path for the child so the broker binds exactly where this
    // script and check-rust-broker.mjs look for it, whatever default the binary
    // was compiled with.
    env: { ...process.env, UMBRA_BROKER_SOCKET: socketPath },
    encoding: 'utf8',
  });
  return child.status === 0;
}

async function waitUntilHealthy(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await health()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return health();
}

function publishRetiredAlias() {
  // Leftover MCP shims still dial the pre-move /tmp path. Point that name at
  // the live socket instead of starting a second broker there.
  ensureBrokerSocketAlias(RETIRED_BROKER_SOCKET_PATH, socketPath);
}

async function main() {
  if (await health()) {
    publishRetiredAlias();
    process.stdout.write('ok\n');
    process.exit(0);
  }

  ensureDirectory(path.dirname(socketPath));
  removeStaleSocket();
  const kicked = kickstartLaunchd();
  if (!kicked) {
    spawnDetachedBroker();
  }

  if (await waitUntilHealthy(waitMs)) {
    publishRetiredAlias();
    process.stdout.write('ok\n');
    process.exit(0);
  }

  process.stderr.write('Rust broker did not become healthy.\n');
  process.exit(1);
}

await main();

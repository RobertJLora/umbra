#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const socketPath = process.env.UMBRA_BROKER_SOCKET
  || '/tmp/umbra-rust-broker.sock';
const brokerBin = process.env.UMBRA_BROKER_BIN
  || path.join(repoRoot, 'rust-broker', 'target', 'release', 'umbra-rust-broker');
const label = process.env.UMBRA_BROKER_LAUNCHD_LABEL
  || 'com.robertlora.umbra-broker';
const timeoutMs = Number(process.env.UMBRA_BROKER_CHECK_TIMEOUT_MS || 1500);
const waitMs = Number(process.env.UMBRA_BROKER_START_TIMEOUT_MS || 8000);

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

function uid() {
  return process.getuid?.() ?? os.userInfo().uid;
}

function launchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function domainTarget() {
  return `gui/${uid()}`;
}

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
  const child = spawnSync('sh', ['-c', `nohup ${JSON.stringify(brokerBin)} >>/tmp/umbra-rust-broker.log 2>&1 &`], {
    env: process.env,
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

async function main() {
  if (await health()) {
    process.stdout.write('ok\n');
    process.exit(0);
  }

  removeStaleSocket();
  const kicked = kickstartLaunchd();
  if (!kicked) {
    spawnDetachedBroker();
  }

  if (await waitUntilHealthy(waitMs)) {
    process.stdout.write('ok\n');
    process.exit(0);
  }

  process.stderr.write('Rust broker did not become healthy.\n');
  process.exit(1);
}

await main();

#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

function loadSharedKeyFromEnv() {
  const directKey = process.env.UMBRA_SHARED_KEY || '';
  if (directKey) {
    return directKey;
  }

  const keyFile = process.env.UMBRA_SHARED_KEY_FILE;
  if (keyFile) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }

  return '';
}

function parseArgs(argv) {
  const options = {
    cdpPort: Number(process.env.UMBRA_CDP_PORT || 47840),
    sharedKey: loadSharedKeyFromEnv(),
    portStart: Number(process.env.UMBRA_PORT_START || 47821),
    portEnd: Number(process.env.UMBRA_PORT_END || 47852),
    extensionName: process.env.UMBRA_EXTENSION_NAME || 'Umbra',
    timeoutMs: Number(process.env.UMBRA_CDP_TIMEOUT_MS || 15000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--cdp-port') {
      options.cdpPort = Number(value);
      index += 1;
    } else if (arg === '--shared-key') {
      options.sharedKey = value;
      index += 1;
    } else if (arg === '--port-start') {
      options.portStart = Number(value);
      index += 1;
    } else if (arg === '--port-end') {
      options.portEnd = Number(value);
      index += 1;
    } else if (arg === '--extension-name') {
      options.extensionName = value;
      index += 1;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(value);
      index += 1;
    }
  }

  if (!options.sharedKey) {
    throw new Error('Missing --shared-key or UMBRA_SHARED_KEY.');
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0) {
    throw new Error('Invalid CDP port.');
  }
  if (!Number.isInteger(options.portStart) || !Number.isInteger(options.portEnd) || options.portEnd < options.portStart) {
    throw new Error('Invalid bridge port range.');
  }

  return options;
}

async function waitForJson(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started <= timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'unknown error'}`);
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      resolve(message.result);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    ready,
    close() {
      socket.close();
    },
    async send(method, params = {}) {
      await ready;
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(id)) {
            return;
          }
          pending.delete(id);
          reject(new Error(`Timed out waiting for CDP method ${method}.`));
        }, 5000);
      });
    },
  };
}

async function getManifestName(target) {
  const cdp = connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: 'chrome.runtime.getManifest().name',
      returnByValue: true,
    });
    return evaluated.result?.value || '';
  } finally {
    cdp.close();
  }
}

async function configureTarget(target, options) {
  const cdp = connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    const expression = `
(async () => {
  await chrome.storage.local.set({
    sharedKey: ${JSON.stringify(options.sharedKey)},
    portStart: ${options.portStart},
    portEnd: ${options.portEnd},
    bridgeEnabled: true
  });
  let reconnect = { ok: false, reason: 'chrome.offscreen API unavailable' };
  if (chrome.offscreen?.closeDocument && chrome.offscreen?.createDocument) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // The offscreen document may not exist yet.
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: 'Maintain authenticated loopback WebSocket connections to local bridge sessions during smoke tests.'
    });
    reconnect = { ok: true, method: 'offscreen_restart' };
  }
  const stored = await chrome.storage.local.get(['sharedKey', 'portStart', 'portEnd', 'bridgeEnabled', 'installId']);
  return {
    ok: stored.sharedKey === ${JSON.stringify(options.sharedKey)},
    portStart: stored.portStart,
    portEnd: stored.portEnd,
    bridgeEnabled: stored.bridgeEnabled,
    installId: stored.installId,
    reconnect
  };
})()
`;

    const evaluated = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (evaluated.exceptionDetails) {
      throw new Error(evaluated.exceptionDetails.text || 'Runtime.evaluate failed.');
    }

    return evaluated.result?.value;
  } finally {
    cdp.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = `http://127.0.0.1:${options.cdpPort}`;
  await waitForJson(`${base}/json/version`, options.timeoutMs);

  const started = Date.now();
  let targets = [];
  while (Date.now() - started <= options.timeoutMs) {
    targets = await waitForJson(`${base}/json/list`, options.timeoutMs);
    const serviceWorkers = targets.filter((target) => (
      target.type === 'service_worker' &&
      target.url?.startsWith('chrome-extension://') &&
      target.url?.endsWith('/background.js') &&
      target.webSocketDebuggerUrl
    ));

    for (const target of serviceWorkers) {
      const name = await getManifestName(target).catch(() => '');
      if (name === options.extensionName) {
        const result = await configureTarget(target, options);
        console.log(JSON.stringify({
          ok: result?.ok === true,
          extensionName: name,
          targetId: target.id,
          targetUrl: target.url,
          config: result,
        }, null, 2));
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Could not find extension service worker named "${options.extensionName}". Saw ${targets.length} CDP targets.`);
}

main().catch((error) => {
  console.error(`[configure-extension-cdp] ${error.stack || error.message}`);
  process.exit(1);
});

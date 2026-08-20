export const DEFAULT_PORT_START = 47821;
export const DEFAULT_PORT_END = 47852;
export const DEFAULT_CONFIG = {
  sharedKey: '',
  portStart: DEFAULT_PORT_START,
  portEnd: DEFAULT_PORT_END,
  bridgeEnabled: true,
  installId: '',
};

export function clampPort(port, fallback, max = 65535) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1024 || numeric > max) {
    return fallback;
  }
  return numeric;
}

export function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes = 16) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return bytesToHex(values);
}

async function importHmacKey(sharedKey) {
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(sharedKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function computeHmacHex(sharedKey, message) {
  const key = await importHmacKey(sharedKey);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToHex(new Uint8Array(signature));
}

export async function loadBridgeConfig() {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  return {
    sharedKey: String(config.sharedKey || ''),
    // The ceiling is the full port range, not DEFAULT_PORT_END. Clamping to the
    // default end silently reverted any configured port above 47852 while the
    // companion server happily bound it, so the extension scanned a range the
    // server was not listening on and the documented remedy could not fix it.
    portStart: clampPort(config.portStart, DEFAULT_PORT_START),
    portEnd: clampPort(config.portEnd, DEFAULT_PORT_END),
    bridgeEnabled: config.bridgeEnabled !== false,
    installId: String(config.installId || ''),
  };
}

export async function ensureInstallId() {
  const { installId } = await chrome.storage.local.get({ installId: '' });
  if (installId) {
    return installId;
  }

  const generated = randomHex(12);
  await chrome.storage.local.set({ installId: generated });
  return generated;
}

export async function saveBridgeConfig(partialConfig) {
  const existing = await loadBridgeConfig();
  const next = {
    ...existing,
    ...partialConfig,
  };
  next.portStart = clampPort(next.portStart, existing.portStart);
  next.portEnd = clampPort(next.portEnd, existing.portEnd);
  next.bridgeEnabled = next.bridgeEnabled !== false;
  if (next.portEnd < next.portStart) {
    next.portEnd = next.portStart;
  }

  await chrome.storage.local.set(next);
  return next;
}

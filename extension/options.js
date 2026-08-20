import { DEFAULT_PORT_END, DEFAULT_PORT_START, randomHex } from './shared.js';

// Chrome requires a literal broad host permission before an extension may
// capture a visible tab or inject into one programmatically. Umbra asks for it
// from this page, on a click, rather than taking it at install time.
const SITE_ACCESS = { origins: ['<all_urls>'] };

// 32 bytes of randomness rendered as 64 hex characters, the same shape the old
// setup instructions asked people to produce by hand.
const SHARED_KEY_BYTES = 32;

// A key generated but not yet saved. Kept so a status refresh cannot overwrite
// the field with the stored key and silently throw the new one away.
let pendingKey = '';

if (new URLSearchParams(location.search).get('reload') === '1') {
  chrome.runtime.reload();
}

function el(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = 'idle') {
  const dot = el('status-dot');
  const text = el('status-text');
  dot.classList.toggle('on', kind === 'ok');
  dot.classList.toggle('bad', kind === 'error');
  text.classList.toggle('bad', kind === 'error');
  text.textContent = message;
}

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.trim() || 'Something went wrong. Reload this page and try again.';
}

// Every click handler on this page runs through here, because an async handler
// that throws produces an unhandled rejection Chrome never shows the user.
function guarded(handler) {
  return async (event) => {
    try {
      await handler(event);
    } catch (error) {
      setStatus(describeError(error), 'error');
    }
  };
}

window.addEventListener('unhandledrejection', (event) => {
  setStatus(describeError(event.reason), 'error');
});

window.addEventListener('error', (event) => {
  setStatus(describeError(event.error || event.message), 'error');
});

async function getState() {
  const response = await chrome.runtime.sendMessage({ type: 'bridge_get_status' });
  if (response?.__error) {
    throw new Error(response.__error.message);
  }
  return response;
}

function readPort(id, fallback) {
  const value = Number(el(id).value);
  return Number.isInteger(value) && value >= 1024 ? value : fallback;
}

function buildEnvironmentLine() {
  const key = el('sharedKey').value.trim();
  if (!key) {
    throw new Error('No shared key yet. Click Generate Key first, then copy the line.');
  }
  const portStart = readPort('portStart', DEFAULT_PORT_START);
  const portEnd = readPort('portEnd', DEFAULT_PORT_END);
  return `UMBRA_SHARED_KEY=${key} UMBRA_PORT_START=${portStart} UMBRA_PORT_END=${portEnd}`;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch (clipboardError) {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) {
      throw clipboardError;
    }
  }
}

function renderHomepageLink() {
  const link = el('homepageLink');
  const url = chrome.runtime.getManifest().homepage_url;
  if (!url) {
    link.hidden = true;
    return;
  }
  link.href = url;
  link.hidden = false;
}

async function refreshSiteAccess() {
  const dot = el('perm-dot');
  const text = el('perm-text');
  const button = el('grantButton');
  let granted = false;
  try {
    granted = await chrome.permissions.contains(SITE_ACCESS);
  } catch (error) {
    dot.classList.remove('on');
    dot.classList.add('bad');
    text.textContent = describeError(error);
    return;
  }
  dot.classList.toggle('on', granted);
  dot.classList.toggle('bad', !granted);
  text.textContent = granted
    ? 'Site access granted. Sessions can drive the tabs they own.'
    : 'Site access not granted. Tools that read or drive a page will fail until you grant it.';
  button.disabled = granted;
  button.textContent = granted ? 'Site Access Granted' : 'Grant Site Access';
}

function renderState(state) {
  const { config, bridgeStatus, bridgeDebug, sessions } = state;
  const keyField = el('sharedKey');

  if (pendingKey && pendingKey !== config.sharedKey) {
    keyField.value = pendingKey;
  } else {
    pendingKey = '';
    keyField.value = config.sharedKey || '';
    keyField.type = 'password';
  }
  el('portStart').value = config.portStart;
  el('portEnd').value = config.portEnd;
  el('bridgeEnabled').checked = config.bridgeEnabled !== false;
  el('firstRunCard').hidden = Boolean(config.sharedKey);

  const connectedCount = bridgeStatus?.connectedCount || 0;
  if (pendingKey) {
    setStatus('New key generated. Click Save And Reconnect to keep it.', 'idle');
  } else if (connectedCount > 0) {
    setStatus(
      `Connected to ${connectedCount} local session${connectedCount === 1 ? '' : 's'}.`,
      'ok',
    );
  } else if (config.sharedKey) {
    setStatus('No local sessions connected yet. Start the companion server with the same key.');
  } else {
    setStatus('No shared key set. Generate one below to pair with the companion server.');
  }

  const sessionsList = el('sessionsList');
  sessionsList.innerHTML = '';
  if (!sessions.length) {
    const item = document.createElement('li');
    item.textContent = 'No active session-owned tabs yet.';
    sessionsList.appendChild(item);
  } else {
    for (const session of sessions) {
      const item = document.createElement('li');
      item.textContent = `${session.sessionId.slice(-6)} on port ${session.port ?? 'n/a'} with ${session.tabs.length} tab(s)`;
      sessionsList.appendChild(item);
    }
  }

  el('debugBox').textContent = bridgeDebug
    ? JSON.stringify(bridgeDebug, null, 2)
    : 'No bridge debug status yet.';
}

async function refresh() {
  const state = await getState();
  renderState(state);
}

el('generateButton').addEventListener(
  'click',
  guarded(async () => {
    pendingKey = randomHex(SHARED_KEY_BYTES);
    const keyField = el('sharedKey');
    keyField.value = pendingKey;
    keyField.type = 'text';
    setStatus('New key generated. Click Save And Reconnect to keep it.');
  }),
);

el('copyButton').addEventListener(
  'click',
  guarded(async () => {
    await copyText(buildEnvironmentLine());
    setStatus('Environment line copied. Paste it into your MCP client config for Umbra.');
  }),
);

el('saveButton').addEventListener(
  'click',
  guarded(async () => {
    const config = {
      sharedKey: el('sharedKey').value.trim(),
      portStart: Number(el('portStart').value),
      portEnd: Number(el('portEnd').value),
      bridgeEnabled: el('bridgeEnabled').checked,
    };
    if (!config.sharedKey) {
      throw new Error('A shared key is required. Click Generate Key to create one.');
    }
    const response = await chrome.runtime.sendMessage({ type: 'bridge_save_config', config });
    if (response?.__error) {
      throw new Error(response.__error.message);
    }
    pendingKey = '';
    await refresh();
  }),
);

el('reconnectButton').addEventListener(
  'click',
  guarded(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'bridge_reconnect' });
    if (response?.__error) {
      throw new Error(response.__error.message);
    }
    await refresh();
  }),
);

el('reloadButton').addEventListener('click', () => {
  chrome.runtime.reload();
});

el('refreshButton').addEventListener('click', guarded(refresh));

el('grantButton').addEventListener(
  'click',
  guarded(async () => {
    const granted = await chrome.permissions.request(SITE_ACCESS);
    await refreshSiteAccess();
    if (!granted) {
      setStatus('Site access was declined. Umbra can pair, but page tools will fail.', 'error');
    }
  }),
);

// Pure DOM: flips the key field between masked and visible so the value can be
// checked before copying. A status refresh re-masks it via renderState, which
// is the intended resting state.
el('revealButton').addEventListener('click', () => {
  const field = el('sharedKey');
  const button = el('revealButton');
  const shown = field.type === 'text';
  field.type = shown ? 'password' : 'text';
  button.textContent = shown ? 'Reveal' : 'Hide';
});

chrome.permissions.onAdded.addListener(() => {
  void refreshSiteAccess();
});

chrome.permissions.onRemoved.addListener(() => {
  void refreshSiteAccess();
});

renderHomepageLink();
void refreshSiteAccess();
void refresh().catch((error) => setStatus(describeError(error), 'error'));

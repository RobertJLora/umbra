import { DEFAULT_PORT_END, DEFAULT_PORT_START, randomHex } from './shared.js';

// Chrome requires a literal broad host permission before an extension may
// capture a visible tab or inject into one programmatically. The popup reports
// whether that grant exists and sends the user to the settings page to make it.
// The request itself does not belong here: a permission dialog raised from a
// browser action popup dismisses the popup that asked for it, so the click
// resolves to nothing the user can see.
const SITE_ACCESS = { origins: ['<all_urls>'] };

// 32 bytes of randomness rendered as 64 hex characters, matching the key the
// settings page generates so either surface can pair an install.
const SHARED_KEY_BYTES = 32;

// A key generated but not yet saved. Kept so a status refresh cannot overwrite
// the field with the stored key and silently throw the new one away.
let pendingKey = '';
let settingsHydrated = false;

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
  return message.trim() || 'Something went wrong. Reopen this popup and try again.';
}

// Every click handler runs through here, because an async handler that throws
// produces an unhandled rejection Chrome never shows the user.
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
    throw new Error('No shared key yet. Click Generate first, then copy the line.');
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

function openSettings() {
  chrome.runtime.openOptionsPage();
  window.close();
}

function renderLinks() {
  const settingsLink = el('settingsLink');
  settingsLink.href = chrome.runtime.getURL('options.html');
  settingsLink.addEventListener('click', (event) => {
    // Following the href would navigate the popup itself into the settings
    // page inside a 360px frame. Open the real options page instead.
    event.preventDefault();
    openSettings();
  });

  const homepageLink = el('homepageLink');
  const url = chrome.runtime.getManifest().homepage_url;
  if (!url) {
    homepageLink.hidden = true;
    return;
  }
  homepageLink.href = url;
  homepageLink.hidden = false;
}

async function refreshSiteAccess() {
  const dot = el('perm-dot');
  const text = el('perm-text');
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
}

function renderSessions(sessions) {
  const sessionsList = el('sessionsList');
  sessionsList.textContent = '';
  if (!sessions.length) {
    const item = document.createElement('li');
    item.textContent = 'No owned tab groups yet.';
    sessionsList.appendChild(item);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = session.sessionId.slice(-6);
    item.appendChild(label);
    const tabSummary = session.tabs.length
      ? session.tabs.map((tab) => `${tab.id}: ${tab.title || tab.url || '(untitled)'}`).join(', ')
      : 'No tabs';
    // textContent rather than innerHTML: tab titles come from pages a session
    // visited, so they are untrusted strings.
    item.appendChild(
      document.createTextNode(` on port ${session.port ?? 'n/a'} with ${tabSummary}`),
    );
    sessionsList.appendChild(item);
  }
}

function renderState(state) {
  const { config, bridgeStatus, sessions } = state;
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
  settingsHydrated = true;
  el('firstRunPanel').hidden = Boolean(config.sharedKey);

  const connectedCount = bridgeStatus?.connectedCount || 0;
  if (pendingKey) {
    setStatus('New key generated. Click Save And Reconnect to keep it.');
  } else if (connectedCount > 0) {
    setStatus(
      `Connected to ${connectedCount} local session${connectedCount === 1 ? '' : 's'}.`,
      'ok',
    );
  } else if (config.sharedKey) {
    setStatus('No local sessions connected yet. Start the companion server with the same key.');
  } else {
    setStatus('No shared key set. Click Generate to pair with the companion server.');
  }

  renderSessions(sessions);
}

async function refreshState() {
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
    setStatus('Line copied. Paste it into your MCP client config for Umbra.');
  }),
);

el('saveButton').addEventListener(
  'click',
  guarded(async () => {
    // Do not refreshState() here. That paints stored checkbox values over a
    // click the user already made, then this handler persists the old false.
    const stored = (await getState()).config || {};
    const typedKey = el('sharedKey').value.trim();
    const config = {
      sharedKey: typedKey || stored.sharedKey || '',
      portStart: Number(el('portStart').value),
      portEnd: Number(el('portEnd').value),
      bridgeEnabled: settingsHydrated
        ? el('bridgeEnabled').checked
        : stored.bridgeEnabled !== false,
    };
    if (!config.sharedKey) {
      throw new Error('A shared key is required. Click Generate to create one.');
    }

    const response = await chrome.runtime.sendMessage({ type: 'bridge_save_config', config });
    if (response?.__error) {
      throw new Error(response.__error.message);
    }

    pendingKey = '';
    await refreshState();
  }),
);

el('refreshButton').addEventListener(
  'click',
  guarded(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'bridge_reconnect' });
    if (response?.__error) {
      throw new Error(response.__error.message);
    }
    await refreshState();
  }),
);

el('settingsButton').addEventListener('click', () => {
  openSettings();
});

renderLinks();
void refreshSiteAccess();
void refreshState().catch((error) => setStatus(describeError(error), 'error'));

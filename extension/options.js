async function getState() {
  const response = await chrome.runtime.sendMessage({ type: 'bridge_get_status' });
  if (response?.__error) {
    throw new Error(response.__error.message);
  }
  return response;
}

if (new URLSearchParams(location.search).get('reload') === '1') {
  chrome.runtime.reload();
}

function renderState(state) {
  const { config, bridgeStatus, bridgeDebug, sessions } = state;
  document.getElementById('sharedKey').value = config.sharedKey || '';
  document.getElementById('portStart').value = config.portStart;
  document.getElementById('portEnd').value = config.portEnd;
  document.getElementById('bridgeEnabled').checked = config.bridgeEnabled !== false;

  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if ((bridgeStatus?.connectedCount || 0) > 0) {
    dot.classList.add('on');
    text.textContent = `Connected to ${bridgeStatus.connectedCount} local session${bridgeStatus.connectedCount === 1 ? '' : 's'}.`;
  } else {
    dot.classList.remove('on');
    text.textContent = config.sharedKey
      ? 'No local bridge sessions connected yet.'
      : 'Enter the shared key and reconnect.';
  }

  const sessionsList = document.getElementById('sessionsList');
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

  const debugBox = document.getElementById('debugBox');
  debugBox.textContent = bridgeDebug ? JSON.stringify(bridgeDebug, null, 2) : 'No bridge debug status yet.';
}

async function refresh() {
  const state = await getState();
  renderState(state);
}

document.getElementById('saveButton').addEventListener('click', async () => {
  const config = {
    sharedKey: document.getElementById('sharedKey').value.trim(),
    portStart: Number(document.getElementById('portStart').value),
    portEnd: Number(document.getElementById('portEnd').value),
    bridgeEnabled: document.getElementById('bridgeEnabled').checked,
  };
  if (!config.sharedKey) {
    throw new Error('Shared key is required. Generate a random key with: openssl rand -hex 32');
  }
  const response = await chrome.runtime.sendMessage({ type: 'bridge_save_config', config });
  if (response?.__error) {
    throw new Error(response.__error.message);
  }
  await refresh();
});

document.getElementById('reconnectButton').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'bridge_reconnect' });
  if (response?.__error) {
    throw new Error(response.__error.message);
  }
  await refresh();
});

document.getElementById('reloadButton').addEventListener('click', () => {
  chrome.runtime.reload();
});

document.getElementById('refreshButton').addEventListener('click', refresh);

void refresh();

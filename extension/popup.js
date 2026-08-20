async function getState() {
  const response = await chrome.runtime.sendMessage({ type: 'bridge_get_status' });
  if (response?.__error) {
    throw new Error(response.__error.message);
  }
  return response;
}

function renderState(state) {
  const { config, bridgeStatus, sessions } = state;
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
      : 'Set a shared key to enable local bridge pairing.';
  }

  const sessionsList = document.getElementById('sessionsList');
  if (!sessions.length) {
    sessionsList.innerHTML = '<li>No owned tab groups yet.</li>';
    return;
  }

  sessionsList.innerHTML = sessions
    .map((session) => {
      const tabSummary = session.tabs.length
        ? session.tabs.map((tab) => `${tab.id}: ${tab.title || tab.url || '(untitled)'}`).join(', ')
        : 'No tabs';
      return `<li><strong>${session.sessionId.slice(-6)}</strong> on port ${session.port ?? 'n/a'} – ${tabSummary}</li>`;
    })
    .join('');
}

async function refreshState() {
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

  const response = await chrome.runtime.sendMessage({
    type: 'bridge_save_config',
    config,
  });
  if (response?.__error) {
    throw new Error(response.__error.message);
  }

  await refreshState();
});

document.getElementById('refreshButton').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'bridge_reconnect' });
  if (response?.__error) {
    throw new Error(response.__error.message);
  }
  await refreshState();
});

void refreshState();

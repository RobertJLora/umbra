const STORAGE_KEY = 'bridgeSessionState';

function makeSession(sessionId, port = null) {
  return {
    sessionId,
    port,
    groupId: null,
    activeTabId: null,
    tabIds: [],
    connected: false,
    lastSeenAt: Date.now(),
  };
}

export class SessionStateStore {
  constructor(storageArea = chrome.storage.session ?? chrome.storage.local) {
    this.storageArea = storageArea;
    this.sessions = new Map();
  }

  async load() {
    const { [STORAGE_KEY]: raw } = await this.storageArea.get({ [STORAGE_KEY]: [] });
    this.sessions = new Map(
      Array.isArray(raw)
        ? raw
            .filter((entry) => entry?.sessionId)
            .map((entry) => [
              entry.sessionId,
              {
                sessionId: entry.sessionId,
                port: entry.port ?? null,
                groupId: entry.groupId ?? null,
                activeTabId: entry.activeTabId ?? null,
                tabIds: Array.isArray(entry.tabIds) ? [...new Set(entry.tabIds)] : [],
                connected: entry.connected === true,
                lastSeenAt: entry.lastSeenAt ?? Date.now(),
              },
            ])
        : [],
    );
    return this;
  }

  async persist() {
    await this.storageArea.set({
      [STORAGE_KEY]: [...this.sessions.values()].map((session) => ({
        ...session,
        tabIds: [...new Set(session.tabIds)],
      })),
    });
  }

  ensureSession(sessionId, port = null, options = {}) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, makeSession(sessionId, port));
    }

    const session = this.sessions.get(sessionId);
    if (port !== null) {
      session.port = port;
    }
    if (options.touch !== false) {
      session.lastSeenAt = Date.now();
    }
    return session;
  }

  listSessions() {
    return [...this.sessions.values()];
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  markConnected(sessionId, port) {
    const existed = this.sessions.has(sessionId);
    const session = this.ensureSession(sessionId);
    const previousPort = session.port;
    const wasConnected = session.connected === true;
    if (port !== null) {
      session.port = port;
    }
    session.connected = true;
    session.lastSeenAt = Date.now();
    return !existed || !wasConnected || previousPort !== session.port;
  }

  markDisconnected(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    session.connected = false;
    session.lastSeenAt = Date.now();
    return session;
  }

  setGroup(sessionId, groupId) {
    const session = this.ensureSession(sessionId);
    session.groupId = groupId;
  }

  claimTab(sessionId, tabId) {
    const session = this.ensureSession(sessionId);
    const owner = this.findOwner(tabId);
    if (owner && owner !== sessionId) {
      throw new Error(`Tab ${tabId} is already owned by session ${owner}.`);
    }

    if (!session.tabIds.includes(tabId)) {
      session.tabIds.push(tabId);
    }
    if (session.activeTabId === null) {
      session.activeTabId = tabId;
    }
  }

  setActiveTab(sessionId, tabId) {
    this.assertOwned(sessionId, tabId);
    this.ensureSession(sessionId).activeTabId = tabId;
  }

  listTabIds(sessionId) {
    return [...this.ensureSession(sessionId).tabIds];
  }

  assertOwned(sessionId, tabId) {
    if (!this.ownsTab(sessionId, tabId)) {
      throw new Error(`Tab ${tabId} is not owned by session ${sessionId}.`);
    }
  }

  ownsTab(sessionId, tabId) {
    return this.findOwner(tabId) === sessionId;
  }

  findOwner(tabId) {
    for (const session of this.sessions.values()) {
      if (session.tabIds.includes(tabId)) {
        return session.sessionId;
      }
    }
    return null;
  }

  releaseTab(tabId) {
    const owner = this.findOwner(tabId);
    if (!owner) {
      return null;
    }

    const session = this.ensureSession(owner);
    session.tabIds = session.tabIds.filter((candidate) => candidate !== tabId);
    if (session.activeTabId === tabId) {
      session.activeTabId = session.tabIds[0] ?? null;
    }
    return owner;
  }

  detachSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { groupId: null, tabIds: [] };
    }

    this.sessions.delete(sessionId);
    return {
      groupId: session.groupId,
      tabIds: [...session.tabIds],
    };
  }
}

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
    // Stays false until load() has read stored state back. persist() refuses to
    // write while it is false, which is the backstop described on persist().
    this.loaded = false;
  }

  async load() {
    const { [STORAGE_KEY]: raw } = await this.storageArea.get({ [STORAGE_KEY]: [] });

    // A stored value of the wrong shape is corruption, not an empty map. Reading
    // it as empty and then persisting walked straight past the `loaded` guard
    // and destroyed exactly the tab ownership that guard exists to protect, so
    // the store stays unloaded until a clean read succeeds and persist() keeps
    // refusing to write.
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
      console.error(
        `[bridge] stored session state is ${Array.isArray(raw) ? 'an array' : typeof raw}, not an array; refusing to load or overwrite it`,
      );
      return this;
    }

    // One tab belongs to one session. A stored map that hands the same tab to
    // two sessions breaks the isolation boundary claimTab enforces at runtime,
    // and browser_close_session_tabs would then close another session's tab.
    // First claim wins; later duplicates are dropped and reported.
    const claimed = new Map();
    const entries = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (!entry?.sessionId) {
        continue;
      }
      const sessionId = String(entry.sessionId);
      const tabIds = [];
      for (const candidate of Array.isArray(entry.tabIds) ? entry.tabIds : []) {
        // Chrome tab ids are integers. A stored string compares unequal to the
        // number a runtime call carries, which let a second session claim a tab
        // the first already held.
        const tabId = Number(candidate);
        if (!Number.isInteger(tabId)) {
          continue;
        }
        const owner = claimed.get(tabId);
        if (owner !== undefined && owner !== sessionId) {
          console.error(`[bridge] stored tab ${tabId} was claimed by both ${owner} and ${sessionId}; keeping ${owner}`);
          continue;
        }
        claimed.set(tabId, sessionId);
        if (!tabIds.includes(tabId)) {
          tabIds.push(tabId);
        }
      }
      const activeTabId = Number.isInteger(Number(entry.activeTabId)) ? Number(entry.activeTabId) : null;
      entries.push([
        sessionId,
        {
          sessionId,
          port: entry.port ?? null,
          groupId: entry.groupId ?? null,
          activeTabId: activeTabId !== null && tabIds.includes(activeTabId) ? activeTabId : (tabIds[0] ?? null),
          tabIds,
          connected: entry.connected === true,
          lastSeenAt: entry.lastSeenAt ?? Date.now(),
        },
      ]);
    }

    this.sessions = new Map(entries);
    this.loaded = true;
    return this;
  }

  // persist() overwrites the whole stored map, so a write that lands before the
  // first load() replaces every session's tab ownership with an empty list and
  // orphans the tabs. A service worker woken by a message can reach a persist()
  // call before load() resolves, so refuse the write instead of destroying
  // state. Returns true when the write happened and false when it was skipped.
  async persist() {
    if (!this.loaded) {
      return false;
    }

    await this.storageArea.set({
      [STORAGE_KEY]: [...this.sessions.values()].map((session) => ({
        ...session,
        tabIds: [...new Set(session.tabIds)],
      })),
    });
    return true;
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

  // A read never creates a record. Routing this through ensureSession meant a
  // typo in a session id added a permanent entry that the next persist() wrote
  // to storage.
  listTabIds(sessionId) {
    return [...(this.sessions.get(sessionId)?.tabIds ?? [])];
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

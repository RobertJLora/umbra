export class TabOwnershipStore {
  constructor() {
    this.sessions = new Map();
    this.tabToSession = new Map();
  }

  ensureSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        groupId: null,
        activeTabId: null,
        tabIds: new Set(),
      });
    }

    return this.sessions.get(sessionId);
  }

  setGroup(sessionId, groupId) {
    const session = this.ensureSession(sessionId);
    session.groupId = groupId;
  }

  claimTab(sessionId, tabId) {
    const currentOwner = this.tabToSession.get(tabId);
    if (currentOwner && currentOwner !== sessionId) {
      throw new Error(`Tab ${tabId} is already owned by session ${currentOwner}.`);
    }

    const session = this.ensureSession(sessionId);
    session.tabIds.add(tabId);
    this.tabToSession.set(tabId, sessionId);

    if (session.activeTabId === null) {
      session.activeTabId = tabId;
    }
  }

  setActiveTab(sessionId, tabId) {
    this.assertOwned(sessionId, tabId);
    const session = this.ensureSession(sessionId);
    session.activeTabId = tabId;
  }

  getActiveTab(sessionId) {
    return this.ensureSession(sessionId).activeTabId;
  }

  ownsTab(sessionId, tabId) {
    return this.tabToSession.get(tabId) === sessionId;
  }

  assertOwned(sessionId, tabId) {
    if (!this.ownsTab(sessionId, tabId)) {
      throw new Error(`Tab ${tabId} is not owned by session ${sessionId}.`);
    }
  }

  listTabs(sessionId) {
    return [...this.ensureSession(sessionId).tabIds];
  }

  releaseTab(tabId) {
    const sessionId = this.tabToSession.get(tabId);
    if (!sessionId) {
      return null;
    }

    const session = this.ensureSession(sessionId);
    session.tabIds.delete(tabId);
    if (session.activeTabId === tabId) {
      session.activeTabId = session.tabIds.values().next().value ?? null;
    }
    this.tabToSession.delete(tabId);
    return sessionId;
  }

  detachSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { groupId: null, tabIds: [] };
    }

    for (const tabId of session.tabIds) {
      this.tabToSession.delete(tabId);
    }

    this.sessions.delete(sessionId);
    return {
      groupId: session.groupId,
      tabIds: [...session.tabIds],
    };
  }

  getSessionState(sessionId) {
    const session = this.ensureSession(sessionId);
    return {
      groupId: session.groupId,
      activeTabId: session.activeTabId,
      tabIds: [...session.tabIds],
    };
  }
}

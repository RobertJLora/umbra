import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateStore } from '../../extension/session-state.js';

function createStorage(initialState = {}) {
  const state = { ...initialState };
  return {
    state,
    setCalls: 0,
    async get(defaults) {
      return { ...defaults, ...state };
    },
    async set(values) {
      this.setCalls += 1;
      Object.assign(state, values);
    },
  };
}

// Storage whose get() stays pending until the test releases it, so a persist
// can be attempted while load() is still in flight.
function createBlockingStorage(initialState = {}) {
  const storage = createStorage(initialState);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const inner = storage.get.bind(storage);
  storage.get = async (defaults) => {
    await gate;
    return inner(defaults);
  };
  storage.release = release;
  return storage;
}

test('extension session state persists owned tabs and active tab', async () => {
  const storage = createStorage();
  const store = await new SessionStateStore(storage).load();

  store.claimTab('sess_a', 101);
  store.claimTab('sess_a', 102);
  store.setActiveTab('sess_a', 102);
  await store.persist();

  const reloaded = await new SessionStateStore(storage).load();
  assert.deepEqual(reloaded.listTabIds('sess_a'), [101, 102]);
  assert.equal(reloaded.getSession('sess_a').activeTabId, 102);
});

test('extension session state refuses to persist before load resolves', async () => {
  const storage = createBlockingStorage({
    bridgeSessionState: [
      { sessionId: 'sess_a', tabIds: [101, 102], activeTabId: 102, groupId: 55, connected: true },
    ],
  });
  const store = new SessionStateStore(storage);
  const loading = store.load();

  store.claimTab('sess_b', 900);
  const wrote = await store.persist();

  assert.equal(wrote, false);
  assert.equal(storage.setCalls, 0);
  assert.deepEqual(storage.state.bridgeSessionState, [
    { sessionId: 'sess_a', tabIds: [101, 102], activeTabId: 102, groupId: 55, connected: true },
  ]);

  storage.release();
  await loading;

  assert.deepEqual(store.listTabIds('sess_a'), [101, 102]);
});

test('extension session state persists the full map once load has resolved', async () => {
  const storage = createStorage();
  const store = await new SessionStateStore(storage).load();

  store.claimTab('sess_a', 101);
  store.claimTab('sess_b', 202);
  store.setGroup('sess_b', 77);
  const wrote = await store.persist();

  assert.equal(wrote, true);
  assert.equal(storage.setCalls, 1);
  assert.deepEqual(
    storage.state.bridgeSessionState.map((entry) => [entry.sessionId, entry.tabIds, entry.groupId]),
    [
      ['sess_a', [101], null],
      ['sess_b', [202], 77],
    ],
  );
});

test('extension session state rejects cross-session tab claims', async () => {
  const store = await new SessionStateStore(createStorage()).load();

  store.claimTab('sess_a', 101);

  assert.throws(() => store.claimTab('sess_b', 101), /already owned/);
  assert.throws(() => store.setActiveTab('sess_b', 101), /not owned/);
});

test('extension session detach releases ownership metadata', async () => {
  const store = await new SessionStateStore(createStorage()).load();
  store.claimTab('sess_a', 101);
  store.claimTab('sess_a', 102);
  store.setGroup('sess_a', 55);

  const released = store.detachSession('sess_a');

  assert.deepEqual(released, { groupId: 55, tabIds: [101, 102] });
  assert.equal(store.findOwner(101), null);
  assert.deepEqual(store.listTabIds('sess_a'), []);
});

test('extension session disconnect preserves tabs and group for reconnect reuse', async () => {
  const store = await new SessionStateStore(createStorage()).load();
  assert.equal(store.markConnected('sess_a', 47821), true);
  store.claimTab('sess_a', 101);
  store.claimTab('sess_a', 102);
  store.setActiveTab('sess_a', 102);
  store.setGroup('sess_a', 55);

  const disconnected = store.markDisconnected('sess_a');

  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.port, 47821);
  assert.equal(disconnected.groupId, 55);
  assert.equal(disconnected.activeTabId, 102);
  assert.deepEqual(disconnected.tabIds, [101, 102]);
  assert.equal(store.findOwner(101), 'sess_a');

  assert.equal(store.markConnected('sess_a', 47822), true);
  const reconnected = store.getSession('sess_a');
  assert.equal(reconnected.connected, true);
  assert.equal(reconnected.port, 47822);
  assert.equal(reconnected.groupId, 55);
  assert.equal(reconnected.activeTabId, 102);
  assert.deepEqual(reconnected.tabIds, [101, 102]);
  assert.equal(store.markConnected('sess_a', 47822), false);
});

test('stored state of the wrong shape is never loaded and never overwritten', async () => {
  for (const corrupt of ['[{"sessionId":"a"}]', { sess_a: { tabIds: [101] } }, 42, 'truncated {']) {
    const storage = createStorage({ bridgeSessionState: corrupt });
    const store = await new SessionStateStore(storage).load();

    assert.equal(store.listSessions().length, 0);
    // The `loaded` guard exists to stop a write that lands before a successful
    // read from wiping tab ownership. A wrong-shaped value walked past it and
    // destroyed the same state.
    assert.equal(await store.persist(), false, 'persist wrote over unreadable stored state');
    assert.deepEqual(storage.state.bridgeSessionState, corrupt);
  }
});

test('a stored map that hands one tab to two sessions keeps only the first owner', async () => {
  const storage = createStorage({
    bridgeSessionState: [
      { sessionId: 'sess_a', tabIds: [101, 102], activeTabId: 101 },
      { sessionId: 'sess_b', tabIds: [101, 999], activeTabId: 999 },
    ],
  });
  const store = await new SessionStateStore(storage).load();

  assert.equal(store.findOwner(101), 'sess_a');
  assert.deepEqual(store.listTabIds('sess_b'), [999], 'sess_b kept a tab sess_a owns');
  assert.equal(store.ownsTab('sess_b', 101), false);
});

test('a stored tab id that arrived as a string still blocks a second claim', async () => {
  const storage = createStorage({
    bridgeSessionState: [{ sessionId: 'sess_a', tabIds: ['101'], activeTabId: '101' }],
  });
  const store = await new SessionStateStore(storage).load();

  assert.deepEqual(store.listTabIds('sess_a'), [101]);
  assert.throws(() => store.claimTab('sess_b', 101), /already owned/);
});

test('reading a session that does not exist never creates one', async () => {
  const storage = createStorage();
  const store = await new SessionStateStore(storage).load();

  assert.deepEqual(store.listTabIds('sess_typo'), []);
  assert.equal(store.listSessions().length, 0, 'a read created a session record');
  await store.persist();
  assert.deepEqual(storage.state.bridgeSessionState, []);
});

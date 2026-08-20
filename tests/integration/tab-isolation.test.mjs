import test from 'node:test';
import assert from 'node:assert/strict';
import { TabOwnershipStore } from '../../mcp-server/tab-ownership.js';

test('a session only lists its own tabs', () => {
  const store = new TabOwnershipStore();
  store.claimTab('sess_a', 101);
  store.claimTab('sess_a', 102);
  store.claimTab('sess_b', 201);

  assert.deepEqual(store.listTabs('sess_a').sort((left, right) => left - right), [101, 102]);
  assert.deepEqual(store.listTabs('sess_b'), [201]);
});

test('a second session cannot claim another sessions tab', () => {
  const store = new TabOwnershipStore();
  store.claimTab('sess_a', 101);

  assert.throws(() => store.claimTab('sess_b', 101), /already owned/);
});

test('active tab follows ownership changes', () => {
  const store = new TabOwnershipStore();
  store.claimTab('sess_a', 101);
  store.claimTab('sess_a', 102);
  store.setActiveTab('sess_a', 102);

  assert.equal(store.getActiveTab('sess_a'), 102);
  store.releaseTab(102);
  assert.equal(store.getActiveTab('sess_a'), 101);
});

test('detaching a session releases all of its tabs', () => {
  const store = new TabOwnershipStore();
  store.claimTab('sess_a', 101);
  store.claimTab('sess_a', 102);
  store.setGroup('sess_a', 55);

  const released = store.detachSession('sess_a');
  assert.deepEqual(released, { groupId: 55, tabIds: [101, 102] });
  assert.equal(store.ownsTab('sess_a', 101), false);
  assert.deepEqual(store.listTabs('sess_a'), []);
});

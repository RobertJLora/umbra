import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackHostHeader } from '../../mcp-server/loopback-host.js';

describe('loopback Host-header allowlist', () => {
  it('accepts loopback names with and without a port', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.1:47821',
      'localhost',
      'localhost:47821',
      '[::1]',
      '[::1]:47821',
      '::1',
      'LOCALHOST',
    ]) {
      assert.equal(isLoopbackHostHeader(host), true, host);
    }
  });

  it('refuses DNS-rebinding and other non-loopback names', () => {
    for (const host of [
      '',
      'evil.test',
      '127.0.0.1.evil.test',
      'localhost.evil.test',
      '127.0.0.1:47821.evil.test',
      '0.0.0.0',
      '127.0.0.2',
    ]) {
      assert.equal(isLoopbackHostHeader(host), false, host);
    }
  });
});

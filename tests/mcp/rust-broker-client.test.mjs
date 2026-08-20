import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { resolveBrokerRequestTimeoutMs, RustBrokerClient } from '../../mcp-server/rust-broker-client.js';

function createFakeBrokerSocket(handler) {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.buffer = '';
    }

    setEncoding() {}

    write(chunk, _encoding, callback) {
      this.buffer += String(chunk);
      for (;;) {
        const newlineIndex = this.buffer.indexOf('\n');
        if (newlineIndex < 0) {
          break;
        }
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        const request = JSON.parse(line);
        const response = handler(request);
        if (response) {
          queueMicrotask(() => this.emit('data', `${JSON.stringify(response)}\n`));
        }
      }
      callback?.();
      return true;
    }

    end() {
      this.destroyed = true;
      this.emit('close');
    }

    destroy() {
      this.end();
    }

    destroySoon() {
      this.end();
    }
  }

  return new FakeSocket();
}

describe('resolveBrokerRequestTimeoutMs', () => {
  it('honors tool timeoutMs above the 15s broker floor', () => {
    assert.equal(resolveBrokerRequestTimeoutMs(15_000, { timeoutMs: 90_000 }), 95_000);
    assert.equal(resolveBrokerRequestTimeoutMs(15_000, {}), 15_000);
    assert.equal(resolveBrokerRequestTimeoutMs(15_000, { timeoutMs: 1_000 }), 15_000);
  });
});

describe('RustBrokerClient', () => {
  it('registers a shim session and sends commands over the broker socket', async () => {
    const seen = [];
    await withFakeBroker((request) => {
      seen.push(request);
      if (request.type === 'register_session') {
        return {
          type: 'response',
          id: request.id,
          ok: true,
          result: { sessionId: request.session_id },
        };
      }
      if (request.type === 'command') {
        return {
          type: 'response',
          id: request.id,
          ok: true,
          result: { tabId: 12, echoedSessionId: request.session_id },
        };
      }
      return {
        type: 'response',
        id: request.id,
        ok: true,
        result: {},
      };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({
        sessionId: 'sess_client',
        socketFactory,
        requestTimeoutMs: 500,
      });
      await client.start();
      const result = await client.sendCommand('browser_create_tab', { url: 'https://example.com' });
      await client.stop();

      assert.equal(result.tabId, 12);
      assert.equal(result.echoedSessionId, 'sess_client');
      assert.equal(seen[0].type, 'register_session');
      assert.equal(seen[0].session_id, 'sess_client');
      assert.equal(seen[1].type, 'command');
      assert.equal(seen[1].tool, 'browser_create_tab');
    });
  });

  it('keeps browser_batch local while routing child tools through Rust', async () => {
    const seen = [];
    await withFakeBroker((request) => {
      seen.push(request);
      if (request.type === 'register_session') {
        return { type: 'response', id: request.id, ok: true, result: {} };
      }
      if (request.tool === 'browser_create_tab') {
        return {
          type: 'response',
          id: request.id,
          ok: true,
          result: { tabId: 321 },
        };
      }
      return {
        type: 'response',
        id: request.id,
        ok: true,
        result: { ok: true, tool: request.tool, tabId: request.params?.tabId },
      };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({
        sessionId: 'sess_batch',
        socketFactory,
        requestTimeoutMs: 500,
      });
      await client.start();
      const result = await client.sendCommand('browser_batch', {
        calls: [
          { tool: 'browser_create_tab', label: 'create', params: { url: 'https://example.com' } },
          { tool: 'browser_wait', label: 'wait', params: { tabId: { $ref: 'create.tabId' }, selector: 'main' } },
          { tool: 'browser_get_page_content', label: 'read', params: { tabId: '$prev.tabId', format: 'text' } },
        ],
      });
      await client.stop();

      assert.equal(result.ok, true);
      assert.equal(result.results.length, 3);
      assert.equal(result.results[1].result.tabId, 321);
      assert.equal(result.results[2].result.tabId, 321);
      assert.deepEqual(
        seen.filter((request) => request.type === 'command').map((request) => request.params?.tabId),
        [undefined, 321, 321],
      );
    });
  });

  it('reconnects and re-registers after a logical broker disconnect', async () => {
    const seen = [];
    await withFakeBroker((request) => {
      seen.push(request);
      if (request.type === 'register_session') {
        return { type: 'response', id: request.id, ok: true, result: {} };
      }
      if (request.type === 'command' && seen.filter((item) => item.type === 'command').length === 1) {
        return {
          type: 'response',
          id: request.id,
          ok: false,
          error: {
            code: 'broker_command_failed',
            message: 'session sess_reconnect is not connected',
          },
        };
      }
      if (request.type === 'command') {
        return {
          type: 'response',
          id: request.id,
          ok: true,
          result: { ok: true, tabId: 99 },
        };
      }
      return { type: 'response', id: request.id, ok: true, result: {} };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({
        sessionId: 'sess_reconnect',
        socketFactory,
        requestTimeoutMs: 500,
      });
      await client.start();
      const result = await client.sendCommand('browser_create_tab', { url: 'https://example.com' });
      await client.stop();

      assert.equal(result.tabId, 99);
      assert.equal(seen.filter((request) => request.type === 'register_session').length, 2);
      assert.equal(seen.filter((request) => request.type === 'command').length, 2);
    });
  });
});

async function withFakeBroker(handler, testBody) {
  const socketFactory = async () => createFakeBrokerSocket(handler);
  await testBody(socketFactory);
}

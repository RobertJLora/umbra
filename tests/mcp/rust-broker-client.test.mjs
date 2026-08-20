import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { resolveBrokerRequestTimeoutMs, RustBrokerClient } from '../../mcp-server/rust-broker-client.js';

const CLIENT_SOURCE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'mcp-server',
  'rust-broker-client.js',
);
const CLIENT_SOURCE = fs.readFileSync(CLIENT_SOURCE_PATH, 'utf8');

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

function createOfflineClient(overrides = {}) {
  return new RustBrokerClient({
    sessionId: 'sess_offline',
    socketFactory: async () => createFakeBrokerSocket(() => null),
    ...overrides,
  });
}

function capturePending(client, id) {
  const settled = { resolved: [], rejected: [] };
  client.pending.set(id, {
    type: 'command',
    timer: setTimeout(() => {}, 60_000),
    resolve: (value) => settled.resolved.push(value),
    reject: (error) => settled.rejected.push(error),
  });
  return settled;
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
        sharedKey: 'test-shared-key',
      });
      await client.start();
      const result = await client.sendCommand('browser_create_tab', { url: 'https://example.com' });
      await client.stop();

      assert.equal(result.tabId, 12);
      assert.equal(result.echoedSessionId, 'sess_client');
      assert.equal(seen[0].type, 'register_session');
      assert.equal(seen[0].session_id, 'sess_client');
      assert.equal(typeof seen[0].mac, 'string');
      assert.match(seen[0].mac, /^[0-9a-f]{64}$/);
      assert.equal(seen[1].type, 'command');
      assert.equal(seen[1].tool, 'browser_create_tab');
    });
  });

  it('refuses browser_reload_extension unless the unpack flag is set', async () => {
    const client = createOfflineClient();
    await assert.rejects(
      () => client.sendCommand('browser_reload_extension', {}),
      /UMBRA_ALLOW_EXTENSION_RELOAD/,
    );
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

describe('RustBrokerClient framing', () => {
  it('accepts a Buffer chunk and settles the pending request', () => {
    const client = createOfflineClient();
    const settled = capturePending(client, 'buffered_1');

    client.handleData(Buffer.from('{"id":"buffered_1","ok":true,"result":{"tabId":41}}\n', 'utf8'));

    assert.equal(settled.rejected.length, 0);
    assert.deepEqual(settled.resolved, [{ tabId: 41 }]);
  });

  it('still accepts a string chunk, which is what the fake socket emits', () => {
    const client = createOfflineClient();
    const settled = capturePending(client, 'string_1');

    client.handleData('{"id":"string_1","ok":true,"result":{"tabId":42}}\n');

    assert.deepEqual(settled.resolved, [{ tabId: 42 }]);
  });

  it('frames several lines out of one chunk and holds a partial line back', () => {
    const client = createOfflineClient();
    const first = capturePending(client, 'multi_1');
    const second = capturePending(client, 'multi_2');
    const third = capturePending(client, 'multi_3');

    client.handleData(Buffer.from(
      '{"id":"multi_1","ok":true,"result":1}\n{"id":"multi_2","ok":true,"result":2}\n{"id":"multi_3",',
      'utf8',
    ));

    assert.deepEqual(first.resolved, [1]);
    assert.deepEqual(second.resolved, [2]);
    assert.deepEqual(third.resolved, []);

    client.handleData(Buffer.from('"ok":true,"result":3}\n', 'utf8'));
    assert.deepEqual(third.resolved, [3]);
    assert.equal(client.chunks.length, 0);
  });

  it('decodes a multi-byte character split across two chunks', () => {
    const client = createOfflineClient();
    const settled = capturePending(client, 'utf8_1');
    const line = Buffer.from('{"id":"utf8_1","ok":true,"result":{"text":"café ok"}}\n', 'utf8');
    const splitAt = line.indexOf(Buffer.from('é', 'utf8')) + 1;

    client.handleData(line.subarray(0, splitAt));
    client.handleData(line.subarray(splitAt));

    assert.deepEqual(settled.resolved, [{ text: 'café ok' }]);
  });

  it('frames a 5 MB single-line response without quadratic re-flattening', () => {
    // This test exists to catch an O(n^2) framing regression, not to police the
    // machine's scheduler. A hard 20 ms wall-clock budget left under 2x headroom
    // on the fastest hardware available, so contention from the sibling suites
    // failed it at random and, because it runs inside npm test, took the whole
    // release gate down with it before the identity report ever printed.
    const frame = (megabytes) => {
      const client = createOfflineClient();
      const id = `big_${megabytes}`;
      const settled = capturePending(client, id);
      const line = Buffer.from(
        `${JSON.stringify({ id, ok: true, result: { data: 'a'.repeat(megabytes * 1024 * 1024) } })}\n`,
        'utf8',
      );
      const chunks = [];
      for (let offset = 0; offset < line.length; offset += 8192) {
        chunks.push(line.subarray(offset, offset + 8192));
      }

      // Best of three: one scheduling hiccup should not decide the verdict.
      let bestMs = Infinity;
      for (let run = 0; run < 3; run += 1) {
        const replay = createOfflineClient();
        const replaySettled = capturePending(replay, id);
        const startedAt = process.hrtime.bigint();
        for (const chunk of chunks) {
          replay.handleData(chunk);
        }
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        bestMs = Math.min(bestMs, elapsedMs);
        assert.equal(replaySettled.resolved.length, 1);
      }

      for (const chunk of chunks) {
        client.handleData(chunk);
      }
      assert.equal(settled.resolved.length, 1);
      assert.equal(settled.resolved[0].data.length, megabytes * 1024 * 1024);
      assert.ok(chunks.length > 120 * megabytes, `expected a chunked payload, saw ${chunks.length} chunks`);
      return bestMs;
    };

    const oneMegabyteMs = frame(1);
    const fiveMegabytesMs = frame(5);

    // Linear framing scales about 5x from 1 MB to 5 MB. Quadratic framing scales
    // about 25x, which this catches with room for measurement noise on a small
    // baseline. The absolute ceiling still fails a catastrophic regression.
    const baselineMs = Math.max(oneMegabyteMs, 1);
    assert.ok(
      fiveMegabytesMs < baselineMs * 12,
      `5 MB took ${fiveMegabytesMs.toFixed(1)}ms against ${oneMegabyteMs.toFixed(1)}ms for 1 MB, which is superlinear`,
    );
    assert.ok(fiveMegabytesMs < 500, `framing a 5 MB line took ${fiveMegabytesMs.toFixed(1)}ms`);
  });
});

describe('RustBrokerClient broker startup', () => {
  it('starts the broker through an awaited child process, never spawnSync', () => {
    assert.doesNotMatch(CLIENT_SOURCE, /spawnSync/);
    assert.match(CLIENT_SOURCE, /import \{ spawn \} from 'node:child_process'/);
    assert.match(CLIENT_SOURCE, /child\.once\('exit'/);
  });

  it('shares one deadline across connect attempts and never ensures after the last one', () => {
    assert.match(CLIENT_SOURCE, /const deadlineAt = Date\.now\(\) \+ this\.connectDeadlineMs;/);
    assert.match(CLIENT_SOURCE, /attempt === MAX_CONNECT_ATTEMPTS - 1/);
  });

  it('resolves its socket and download directory from config.js, with no author paths', () => {
    assert.match(CLIENT_SOURCE, /from '\.\/config\.js'/);
    assert.doesNotMatch(CLIENT_SOURCE, /\/Users\//);
    assert.doesNotMatch(CLIENT_SOURCE, /\/tmp\/umbra/);
    const client = createOfflineClient();
    assert.ok(client.socketPath.length > 0);
    assert.doesNotMatch(client.socketPath, /^\/tmp\//);
  });
});

describe('RustBrokerClient batch budgets', () => {
  it('gives every composite child its own slice, strictly below the batch budget', async () => {
    const commands = [];
    await withFakeBroker((request) => {
      if (request.type === 'register_session') {
        return { type: 'response', id: request.id, ok: true, result: {} };
      }
      if (request.type === 'command') {
        commands.push(request);
        return { type: 'response', id: request.id, ok: true, result: { tabId: 7 } };
      }
      return { type: 'response', id: request.id, ok: true, result: {} };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({
        sessionId: 'sess_composite',
        socketFactory,
        requestTimeoutMs: 500,
      });
      await client.start();
      const result = await client.sendCommand('browser_navigate_wait_read', {
        url: 'https://example.com',
        waitSelector: 'main',
        timeoutMs: 15_000,
      });
      await client.stop();

      assert.equal(result.ok, true);
      const navigate = commands.find((command) => command.tool === 'browser_navigate');
      const wait = commands.find((command) => command.tool === 'browser_wait');
      const read = commands.find((command) => command.tool === 'browser_get_page_content');

      assert.ok(navigate.params.timeoutMs > 0, 'the navigate child must carry an explicit budget');
      assert.ok(
        navigate.params.timeoutMs < 15_000,
        `navigate budget ${navigate.params.timeoutMs} must stay below the 15000ms composite budget`,
      );
      assert.ok(wait.params.timeoutMs > 0 && wait.params.timeoutMs < 15_000);
      assert.notEqual(navigate.params.timeoutMs, wait.params.timeoutMs);
      // browser_get_page_content declares no timeoutMs, so the budget stays on
      // the transport instead of being invented as a schema parameter.
      assert.equal(read.params.timeoutMs, undefined);
    });
  });

  it('fills an absent child timeout and clamps a child that asks for more than the batch has', async () => {
    const commands = [];
    await withFakeBroker((request) => {
      if (request.type === 'register_session') {
        return { type: 'response', id: request.id, ok: true, result: {} };
      }
      if (request.type === 'command') {
        commands.push(request);
        return { type: 'response', id: request.id, ok: true, result: { ok: true } };
      }
      return { type: 'response', id: request.id, ok: true, result: {} };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({
        sessionId: 'sess_budget',
        socketFactory,
        requestTimeoutMs: 60_000,
      });
      await client.start();
      const result = await client.sendCommand('browser_batch', {
        timeoutMs: 5_000,
        calls: [
          { tool: 'browser_wait', label: 'greedy', params: { selector: 'main', timeoutMs: 90_000 } },
          { tool: 'browser_wait', label: 'silent', params: { selector: 'footer' } },
        ],
      });
      await client.stop();

      assert.equal(result.ok, true);
      const [greedy, silent] = commands;
      assert.ok(
        greedy.params.timeoutMs <= 5_000 && greedy.params.timeoutMs > 0,
        `a 90000ms child inside a 5000ms batch was left at ${greedy.params.timeoutMs}`,
      );
      assert.ok(
        silent.params.timeoutMs > 0 && silent.params.timeoutMs <= 5_000,
        'a child that omits timeoutMs is filled from the remaining budget',
      );
    });
  });
});

async function withFakeBroker(handler, testBody) {
  const socketFactory = async () => createFakeBrokerSocket(handler);
  await testBody(socketFactory);
}

describe('RustBrokerClient budget fairness', () => {
  it('keeps the trailing-child reserve from starving the first child of a long batch', async () => {
    const commands = [];
    await withFakeBroker((request) => {
      if (request.type === 'command') {
        commands.push(request);
      }
      return { type: 'response', id: request.id, ok: true, result: { tabId: 1 } };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({ sessionId: 'sess_reserve', socketFactory, requestTimeoutMs: 60_000 });
      await client.start();
      // Sixteen calls used to reserve 30,000 ms out of a 30,000 ms deadline, so
      // child 0 collapsed to the 1,000 ms floor and abandoned its navigation.
      const calls = Array.from({ length: 16 }, () => ({ tool: 'browser_wait', params: { tabId: 1, selector: 'main' } }));
      await client.sendCommand('browser_batch', { calls, timeoutMs: 30_000, stopOnError: false });
      await client.stop();

      assert.ok(
        commands[0].params.timeoutMs >= 10_000,
        `first child got ${commands[0].params.timeoutMs} ms of a 30,000 ms batch`,
      );
    });
  });

  it('forwards a deliberately short child timeout instead of raising it to the floor', async () => {
    const commands = [];
    await withFakeBroker((request) => {
      if (request.type === 'command') {
        commands.push(request);
      }
      return { type: 'response', id: request.id, ok: true, result: {} };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({ sessionId: 'sess_short', socketFactory, requestTimeoutMs: 60_000 });
      await client.start();
      await client.sendCommand('browser_batch', {
        timeoutMs: 20_000,
        calls: [{ tool: 'browser_wait', params: { tabId: 1, selector: 'main', timeoutMs: 200 } }],
      });
      await client.stop();

      assert.equal(commands[0].params.timeoutMs, 200);
    });
  });

  it('never writes a child budget into an earlier step it was referenced from', async () => {
    const commands = [];
    await withFakeBroker((request) => {
      if (request.type === 'command') {
        commands.push(request);
        if (request.tool === 'browser_create_tab') {
          return {
            type: 'response',
            id: request.id,
            ok: true,
            result: { tabId: 9, cfg: { selector: 'main', visible: true } },
          };
        }
      }
      return { type: 'response', id: request.id, ok: true, result: {} };
    }, async (socketFactory) => {
      const client = new RustBrokerClient({ sessionId: 'sess_ref', socketFactory, requestTimeoutMs: 60_000 });
      await client.start();
      const batch = await client.sendCommand('browser_batch', {
        timeoutMs: 20_000,
        calls: [
          { tool: 'browser_create_tab', label: 'create' },
          { tool: 'browser_wait', label: 'wait', params: { $ref: 'create.cfg' } },
        ],
      });
      await client.stop();

      assert.equal(
        Object.hasOwn(batch.results[0].result.cfg, 'timeoutMs'),
        false,
        'the batch report shows a timeoutMs the extension never returned',
      );
    });
  });
});

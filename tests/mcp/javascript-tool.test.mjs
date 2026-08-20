import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getToolDefinition } from '../../mcp-server/tools.js';
import {
  JAVASCRIPT_RESULT_MAX_CHARS,
  blockedSensitiveResult,
  looksLikeSensitiveResult,
  serializeJavascriptResult,
} from '../../extension/javascript-safety.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('browser_javascript tool', () => {
  it('exposes a required code schema with activate defaulting to false', () => {
    const tool = getToolDefinition('browser_javascript');
    assert.ok(tool);
    assert.equal(tool.name, 'browser_javascript');
    assert.ok(tool.description.length >= 20);
    assert.deepEqual(tool.inputSchema.required, ['code']);
    assert.equal(tool.inputSchema.properties.code.type, 'string');
    assert.equal(tool.inputSchema.properties.tabId.type, 'number');
    assert.equal(tool.inputSchema.properties.timeoutMs.type, 'number');
    assert.equal(tool.inputSchema.properties.activate.type, 'boolean');
    assert.match(tool.inputSchema.properties.activate.description, /Defaults to false/);
    assert.match(tool.inputSchema.properties.timeoutMs.description, /Defaults to 10000/);
    const serialized = JSON.stringify(tool);
    for (const pattern of [/cookie/i, /token/i, /password/i, /storage/i, /captcha/i]) {
      assert.equal(pattern.test(serialized), false, `tool schema should not advertise ${pattern}`);
    }
  });

  it('wires an owned-tab page-world handler and content-agent execute action', () => {
    const background = read('extension/background.js');
    const agent = read('extension/content-agent.js');
    const start = background.indexOf("if (tool === 'browser_javascript')");
    const next = background.indexOf('\n  if (tool ===', start + 1);
    const block = background.slice(start, next);
    assert.ok(start >= 0, 'background handler should exist');
    assert.match(block, /getOrCreateSessionTab/);
    assert.match(block, /activate: params\.activate === true/);
    assert.match(block, /requireJavascriptCode/);
    assert.match(block, /executeJavascriptViaAgent/);
    assert.match(background, /world: 'MAIN'/);
    assert.match(background, /executeJavascriptWithWorldFallback/);
    assert.match(background, /Runtime\.evaluate/);
    assert.match(agent, /execute_javascript/);
    assert.match(agent, /async function executeJavascript/);
    assert.doesNotMatch(agent, /eval\(|new Function/);
  });

  it('evaluates caller-supplied code only through the debugger', () => {
    const background = read('extension/background.js');
    const agent = read('extension/content-agent.js');

    // Compiling a code string inside the page is a catalogued eval-evasion
    // pattern and contradicts the script-src 'self' CSP in the manifest, so
    // Runtime.evaluate is the only route and there is no second world to fall
    // back into.
    assert.doesNotMatch(background, /AsyncFunction/);
    assert.doesNotMatch(agent, /AsyncFunction/);
    assert.doesNotMatch(background, /executeJavascriptInPage/);

    // A page exception is the caller's own code throwing. Retrying it anywhere
    // would submit the same form twice.
    const guard = background.slice(
      background.indexOf('function isDebuggerAccessFailure'),
      background.indexOf('async function executeJavascriptWithWorldFallback'),
    );
    assert.match(guard, /error\?\.code === 'javascript_error'/);
    assert.match(guard, /debugger/i);
    assert.match(background, /debugger_busy/);
  });

  it('blocks cookie headers, Set-Cookie, and long query-string secrets', () => {
    assert.equal(looksLikeSensitiveResult('ok'), false);
    assert.equal(looksLikeSensitiveResult({ title: 'Dashboard' }), false);
    assert.equal(looksLikeSensitiveResult('Set-Cookie: sid=abc'), true);
    assert.equal(looksLikeSensitiveResult('cookie: session=abc'), true);
    assert.equal(looksLikeSensitiveResult('https://cdn.example.com/img.webp?url=abcdefghijklmnopqrstuvwxyz'), true);
    assert.equal(
      looksLikeSensitiveResult('https://app.example.com/site-explorer/organic-keywords?hiddenColumns=AIContentLevel%7C%7CPageType%7C%7CStatus%7C%7CValue&country=us'),
      false,
    );
    assert.equal(
      looksLikeSensitiveResult('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      true,
    );
    assert.deepEqual(blockedSensitiveResult('safe'), null);
    const blocked = blockedSensitiveResult('Set-Cookie: sid=abc');
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.code, 'javascript_result_blocked');
  });

  it('caps serialized results and flags truncation', () => {
    const small = serializeJavascriptResult({ ok: true, n: 1 });
    assert.equal(small.truncated, false);
    assert.deepEqual(small.result, { ok: true, n: 1 });

    const oversized = 'x'.repeat(JAVASCRIPT_RESULT_MAX_CHARS + 25);
    const truncated = serializeJavascriptResult(oversized);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.result.length, JAVASCRIPT_RESULT_MAX_CHARS);
    assert.equal(truncated.originalLength, oversized.length);

    assert.throws(
      () => serializeJavascriptResult('Set-Cookie: sid=secret'),
      /blocked because it looks like a credential or query-string secret/,
    );
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPACT_SUMMARY_THRESHOLD_BYTES,
  buildMcpResponse,
  compileSchemaValidator,
  createSchemaValidators,
  resolveOutputPath,
  resolveToolDefinitions,
} from '../../mcp-server/index.js';
import { loadPlugins } from '../../mcp-server/plugins-loader.mjs';
import { TOOL_DEFINITIONS } from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const indexSource = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'index.js'), 'utf8');

describe('MCP response envelope', () => {
  it('ships a generic result exactly once with no structuredContent', () => {
    const result = { ok: true, tabId: 7, title: 'Example' };
    const response = buildMcpResponse('browser_read_page', result, {});

    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, 'text');
    assert.equal(response.structuredContent, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), result);
    assert.equal(response.content[0].text, JSON.stringify(result));
    assert.equal(response.isError, undefined);
  });

  it('drops the pretty-print indent so one copy is also a smaller copy', () => {
    const controls = Array.from({ length: 40 }, (_, index) => ({
      ref: `ref-${index}`,
      role: 'button',
      name: `Control ${index}`,
    }));
    const response = buildMcpResponse('browser_read_interactive', { controls }, {});

    assert.ok(response.content[0].text.length < JSON.stringify({ controls }, null, 2).length);
    assert.equal(response.content[0].text.includes('\n'), false);
  });

  it('keeps the summary and the whole object together on a compact-summary result', () => {
    const controls = Array.from({ length: 900 }, (_, index) => ({
      ref: `ref-${index}`,
      role: 'button',
      name: `Control number ${index} with a long accessible name for padding`,
      selector: `#control-${index} > span.label`,
    }));
    const result = {
      _compactSummary: `Interactive controls: ${controls.length} on Example`,
      controls,
    };

    assert.ok(JSON.stringify(result).length > COMPACT_SUMMARY_THRESHOLD_BYTES);

    const response = buildMcpResponse('browser_read_interactive', result, {});
    assert.equal(response.structuredContent, undefined);

    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed._compactSummary, result._compactSummary);
    assert.equal(parsed.controls.length, 900);
    assert.deepEqual(parsed.controls[0], controls[0]);
    assert.ok(response.content[0].text.startsWith('{"_compactSummary":'));
  });

  it('ignores a plain summary key, which no tool produces', () => {
    const result = { summary: 'short', body: 'x'.repeat(COMPACT_SUMMARY_THRESHOLD_BYTES + 10) };
    const response = buildMcpResponse('browser_get_page_content', result, {});

    assert.deepEqual(JSON.parse(response.content[0].text), result);
  });

  it('marks an ok:false result as an error', () => {
    const failed = { ok: false, error: 'batch_timeout', results: [] };
    const response = buildMcpResponse('browser_batch', failed, {});

    assert.equal(response.isError, true);
    assert.deepEqual(JSON.parse(response.content[0].text), failed);
  });

  it('leaves a successful batch unflagged', () => {
    const response = buildMcpResponse('browser_batch', { ok: true, results: [] }, {});
    assert.equal(response.isError, undefined);
  });

  it('passes a plain string result straight through', () => {
    const response = buildMcpResponse('browser_wait', 'done', {});
    assert.deepEqual(response, { content: [{ type: 'text', text: 'done' }] });
  });

  it('keeps structuredContent on the screenshot branches', () => {
    const inline = buildMcpResponse('browser_screenshot', {
      tabId: 3,
      activated: false,
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64'),
    }, {});

    assert.equal(inline.content[0].type, 'image');
    assert.equal(inline.structuredContent.tabId, 3);
  });
});

describe('outputPath validation', () => {
  it('refuses a relative path', () => {
    assert.throws(() => resolveOutputPath('shot.png'), /absolute path/);
    assert.throws(() => resolveOutputPath('../../../../etc/x.png'), /absolute path/);
  });

  it('refuses an empty path', () => {
    assert.throws(() => resolveOutputPath('   '), /non-empty absolute path/);
  });

  it('expands a leading tilde through the home directory', () => {
    const probeDir = fs.mkdtempSync(path.join(os.homedir(), '.umbra-outputpath-test-'));
    try {
      const resolved = resolveOutputPath(`~/${path.basename(probeDir)}/shot.png`);
      assert.equal(resolved, path.join(probeDir, 'shot.png'));
      assert.equal(resolved.startsWith('~'), false);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });

  it('refuses a path whose parent directory does not exist instead of creating it', () => {
    const missingParent = path.join(os.tmpdir(), `umbra-missing-${Date.now()}`, 'nested');
    assert.throws(() => resolveOutputPath(path.join(missingParent, 'shot.png')), /does not exist/);
    assert.equal(fs.existsSync(missingParent), false);
  });

  it('returns an absolute path unchanged when its parent exists', () => {
    const target = path.join(os.tmpdir(), 'umbra-existing-parent.png');
    assert.equal(resolveOutputPath(target), target);
  });

  it('is the only write path, and it never creates directories recursively', () => {
    assert.equal(indexSource.includes('mkdirSync'), false);
    assert.equal(indexSource.match(/fs\.writeFileSync/g).length, 1);
  });
});

describe('module resolution', () => {
  it('imports the SDK through bare specifiers, not a node_modules path', () => {
    assert.equal(indexSource.includes('./node_modules/'), false);
    assert.ok(indexSource.includes("from '@modelcontextprotocol/sdk/server/index.js'"));
    assert.ok(indexSource.includes("from '@modelcontextprotocol/sdk/server/stdio.js'"));
    assert.ok(indexSource.includes("from '@modelcontextprotocol/sdk/types.js'"));
  });
});

describe('optional local plugins', () => {
  it('loads nothing when the plugins folder does not exist', async () => {
    const plugins = await loadPlugins({ dir: path.join(os.tmpdir(), 'umbra-no-such-plugin-dir') });
    assert.deepEqual(plugins.toolDefinitions, []);
    assert.deepEqual(plugins.pageActions, []);
    assert.deepEqual(plugins.handlers, {});
    assert.deepEqual(plugins.modules, []);
  });

  it('registers a plugin tool, its page actions, and its handler', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'umbra-plugin-'));
    await fsp.writeFile(
      path.join(dir, 'sample.plugin.mjs'),
      [
        "export const toolDefinitions = [{ name: 'browser_export_vendor', description: 'x', inputSchema: { type: 'object', properties: {} } }];",
        "export const pageActions = ['vendor_open_export'];",
        "export const mcpLocalToolNames = ['browser_export_vendor'];",
        'export const handlers = { browser_export_vendor: async () => ({ ok: true }) };',
        '',
      ].join('\n'),
      'utf8',
    );

    const plugins = await loadPlugins({ dir });
    assert.deepEqual(plugins.toolDefinitions.map((tool) => tool.name), ['browser_export_vendor']);
    assert.deepEqual(plugins.mcpLocalToolNames, ['browser_export_vendor']);
    assert.equal(typeof plugins.handlers.browser_export_vendor, 'function');

    const withPlugin = resolveToolDefinitions({ plugins }).map((tool) => tool.name);
    const withoutPlugin = resolveToolDefinitions().map((tool) => tool.name);
    assert.ok(withPlugin.includes('browser_export_vendor'));
    assert.equal(withoutPlugin.includes('browser_export_vendor'), false);
    assert.deepEqual(withPlugin.filter((name) => name !== 'browser_export_vendor'), withoutPlugin);

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('skips a plugin that reports itself unavailable', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'umbra-plugin-'));
    await fsp.writeFile(
      path.join(dir, 'unavailable.plugin.mjs'),
      [
        "export function isAvailable() { return { ok: false, reason: 'no download directory' }; }",
        "export const toolDefinitions = [{ name: 'browser_export_vendor', description: 'x', inputSchema: { type: 'object', properties: {} } }];",
        '',
      ].join('\n'),
      'utf8',
    );

    const messages = [];
    const plugins = await loadPlugins({ dir, log: (message) => messages.push(message) });
    assert.deepEqual(plugins.toolDefinitions, []);
    assert.match(messages.join(' '), /no download directory/);

    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('staged schema validation', () => {
  it('compiles a validator for every declared tool', () => {
    const validators = createSchemaValidators(TOOL_DEFINITIONS);
    assert.equal(validators.size, TOOL_DEFINITIONS.length);
  });

  it('reports a missing required argument, a wrong type, a bad enum, and an unknown key', () => {
    const validate = compileSchemaValidator({
      type: 'object',
      properties: {
        url: { type: 'string' },
        tabId: { type: 'number' },
        color: { type: 'string', enum: ['blue', 'green'] },
      },
      required: ['url'],
    });

    assert.deepEqual(validate({ url: 'https://example.com' }), []);
    assert.equal(validate({}).length, 1);
    assert.match(validate({}).join(' '), /url is required/);
    assert.match(validate({ url: 'x', tabId: '4' }).join(' '), /tabId expected number, received string/);
    assert.match(validate({ url: 'x', color: 'teal' }).join(' '), /color expected one of/);
    assert.match(validate({ url: 'x', nope: 1 }).join(' '), /nope is not a declared property/);
  });

  it('accepts the shapes the real schemas declare', () => {
    const validators = createSchemaValidators(TOOL_DEFINITIONS);
    assert.deepEqual(validators.get('browser_navigate')({ url: 'https://example.com', activate: false }), []);
    assert.deepEqual(validators.get('browser_list_tabs')({}), []);
    assert.deepEqual(
      validators.get('browser_screenshot')({ outputPath: '/tmp/shot.png', format: 'png' }),
      [],
    );
  });

  it('stops collecting after a handful of issues so one bad call cannot flood the log', () => {
    const properties = {};
    const args = {};
    for (let index = 0; index < 20; index += 1) {
      properties[`field${index}`] = { type: 'string' };
      args[`field${index}`] = index;
    }
    const validate = compileSchemaValidator({ type: 'object', properties });
    assert.equal(validate(args).length, 5);
  });
});

describe('caller errors reach the caller', () => {
  it('names a non-finite number instead of reporting the same type on both sides', async () => {
    const { compileSchemaValidator } = await import('../../mcp-server/index.js');
    const validate = compileSchemaValidator({
      type: 'object',
      properties: { tabId: { type: 'integer', minimum: 1 } },
    });
    // "expected number, received number" told a caller nothing at all.
    assert.match(validate({ tabId: Infinity })[0], /received Infinity/);
    assert.match(validate({ tabId: Number.NaN })[0], /received NaN/);
  });

  it('separates a missing required parameter from every other staged mismatch', async () => {
    const { compileSchemaValidator, missingRequiredIssues } = await import('../../mcp-server/index.js');
    const validate = compileSchemaValidator({
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' }, activate: { type: 'boolean' } },
    });

    // A required-field violation is a caller error, so it is enforced; a type
    // mismatch stays staged and logged because the extension coerces those.
    const missing = missingRequiredIssues(validate({ activate: true }));
    assert.equal(missing.length, 1);
    assert.match(missing[0], /arguments\.url is required and missing/);
    assert.deepEqual(missingRequiredIssues(validate({ url: 'https://example.com', activate: 'yes' })), []);
  });

  it('reports a replaced screenshot file rather than clobbering it silently', async () => {
    const { buildMcpResponse } = await import('../../mcp-server/index.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-shot-'));
    try {
      const target = path.join(dir, 'shot.png');
      fs.writeFileSync(target, 'PRIOR CONTENT');
      const response = buildMcpResponse(
        'browser_screenshot',
        { data: Buffer.from('x').toString('base64'), tabId: 1 },
        { outputPath: target },
      );
      assert.equal(response.structuredContent.replacedExistingFile, true);
      assert.equal(response.structuredContent.replacedBytes, 'PRIOR CONTENT'.length);

      const fresh = buildMcpResponse(
        'browser_screenshot',
        { data: Buffer.from('x').toString('base64'), tabId: 1 },
        { outputPath: path.join(dir, 'new.png') },
      );
      assert.equal(fresh.structuredContent.replacedExistingFile, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

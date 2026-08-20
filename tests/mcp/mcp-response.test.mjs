import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPACT_SUMMARY_THRESHOLD_BYTES,
  buildMcpResponse,
  compileSchemaValidator,
  createSchemaValidators,
  loadAhrefsPlugin,
  resolveOutputPath,
  resolveToolDefinitions,
} from '../../mcp-server/index.js';
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

describe('optional Ahrefs plugin', () => {
  it('resolves the plugin from this checkout', async () => {
    const plugin = await loadAhrefsPlugin();
    assert.equal(typeof plugin?.runAhrefsExport, 'function');
  });

  it('returns null when the plugin file is absent from the package', async () => {
    const plugin = await loadAhrefsPlugin('./ahrefs-export-not-in-this-package.js');
    assert.equal(plugin, null);
  });

  it('lists browser_export_ahrefs only when the plugin loaded', () => {
    const withPlugin = resolveToolDefinitions({ ahrefs: true }).map((tool) => tool.name);
    const withoutPlugin = resolveToolDefinitions({ ahrefs: false }).map((tool) => tool.name);

    assert.ok(withPlugin.includes('browser_export_ahrefs'));
    assert.equal(withoutPlugin.includes('browser_export_ahrefs'), false);
    assert.deepEqual(
      withPlugin.filter((name) => name !== 'browser_export_ahrefs'),
      withoutPlugin,
    );
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

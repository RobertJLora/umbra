import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_LOCAL_TOOL_NAMES,
  TOOL_DEFINITIONS,
  buildMcpLocalToolNames,
  buildToolDefinitions,
  getToolDefinition,
} from '../../mcp-server/tools.js';
import { AUTHOR_SITE_RE } from '../identity-needles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const toolsSource = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'tools.js'), 'utf8');

test('V0 tool surface includes create/list/navigate/read primitives', () => {
  for (const name of [
    'browser_create_tab',
    'browser_find_tabs',
    'browser_adopt_tab',
    'browser_group_tabs',
    'browser_list_tabs',
    'browser_navigate',
    'browser_batch',
    'browser_close_session_tabs',
    'browser_freeze_session_tabs',
    'browser_get_bridge_pressure',
    'browser_get_page_content',
    'browser_get_technical_snapshot',
    'browser_run_page_action',
    'browser_javascript',
    'browser_read_page',
    'browser_find',
    'browser_form_input',
    'browser_tabs_context',
    'browser_file_upload',
    'browser_shortcut',
    'browser_click_text',
  ]) {
    assert.ok(getToolDefinition(name), `${name} should be exposed`);
  }
});

test('V1.6 tool surface excludes sensitive extraction and browser downloads permissions', () => {
  const blockedPatterns = [
    /cookie/i,
    /storage/i,
    /token/i,
    /password/i,
    /captcha/i,
  ];

  for (const tool of TOOL_DEFINITIONS) {
    const serialized = JSON.stringify(tool);
    for (const pattern of blockedPatterns) {
      assert.equal(
        pattern.test(serialized),
        false,
        `${tool.name} should not expose ${pattern}`,
      );
    }
  }

  assert.ok(getToolDefinition('browser_wait_for_download'), 'ledger-backed download wait should be exposed');
  assert.match(
    getToolDefinition('browser_wait_for_download').description,
    /file ledger/i,
  );
});

test('a build with no local plugin advertises exactly the built-in surface', () => {
  const plugins = {
    toolDefinitions: [{ name: 'browser_export_vendor', description: 'x', inputSchema: { type: 'object', properties: {} } }],
    pageActions: ['vendor_open_export', 'vendor_export_csv'],
    mcpLocalToolNames: ['browser_export_vendor'],
  };
  const withPlugin = buildToolDefinitions({ plugins });
  const withoutPlugin = buildToolDefinitions();

  assert.ok(!withoutPlugin.some((tool) => tool.name === 'browser_reload_extension'));
  const publicCatalog = TOOL_DEFINITIONS.filter((tool) => tool.name !== 'browser_reload_extension');
  assert.deepEqual(withoutPlugin, publicCatalog, 'the default build should hide the unpacked-only reload tool');
  assert.deepEqual(buildToolDefinitions({ plugins: null }), publicCatalog);

  const addedNames = withPlugin
    .map((tool) => tool.name)
    .filter((name) => !withoutPlugin.some((tool) => tool.name === name));
  assert.deepEqual(addedNames, ['browser_export_vendor']);
  assert.equal(withPlugin.length, publicCatalog.length + 1);

  const localWithout = buildMcpLocalToolNames();
  assert.equal(localWithout.has('browser_export_vendor'), false);
  assert.equal(localWithout.has('browser_batch'), true);
  assert.deepEqual([...localWithout], [...MCP_LOCAL_TOOL_NAMES]);
  assert.equal(buildMcpLocalToolNames({ plugins }).has('browser_export_vendor'), true);

  // A plugin's page actions are implemented by the matching extension recipe,
  // so they only appear when that plugin is installed.
  const pageActionWith = withPlugin.find((tool) => tool.name === 'browser_run_page_action');
  const pageActionWithout = withoutPlugin.find((tool) => tool.name === 'browser_run_page_action');
  assert.ok(pageActionWith.inputSchema.properties.action.enum.includes('vendor_export_csv'));
  assert.equal(pageActionWithout.inputSchema.properties.action.enum.includes('vendor_export_csv'), false);

  // Extending the enum must not edit the shared catalog, or a second build
  // would inherit the first build's plugin actions.
  assert.deepEqual(
    buildToolDefinitions().find((tool) => tool.name === 'browser_run_page_action').inputSchema.properties.action.enum,
    pageActionWithout.inputSchema.properties.action.enum,
  );
});

test('browser_reload_extension is advertised only when the unpack flag is set', () => {
  const previous = process.env.UMBRA_ALLOW_EXTENSION_RELOAD;
  try {
    delete process.env.UMBRA_ALLOW_EXTENSION_RELOAD;
    assert.equal(
      buildToolDefinitions().some((tool) => tool.name === 'browser_reload_extension'),
      false,
    );
    process.env.UMBRA_ALLOW_EXTENSION_RELOAD = '1';
    assert.equal(
      buildToolDefinitions().some((tool) => tool.name === 'browser_reload_extension'),
      true,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.UMBRA_ALLOW_EXTENSION_RELOAD;
    } else {
      process.env.UMBRA_ALLOW_EXTENSION_RELOAD = previous;
    }
  }
});

test('the download-directory override exists on the tool that waits for a file', () => {
  const wait = getToolDefinition('browser_wait_for_download').inputSchema;
  assert.equal(wait.properties.dir.type, 'string');
  assert.match(wait.properties.dir.description, /UMBRA_DOWNLOAD_DIR/);
  assert.match(wait.properties.dir.description, /Absolute path/);
});

test('schema descriptions state the real limits and requirements', () => {
  const maxChars = getToolDefinition('browser_get_page_content').inputSchema.properties.maxChars;
  assert.match(maxChars.description, /Defaults to 500000/);
  assert.doesNotMatch(maxChars.description, /the extension limit/i);

  const outputPath = getToolDefinition('browser_screenshot').inputSchema.properties.outputPath;
  assert.match(outputPath.description, /Must be absolute/);
  assert.match(outputPath.description, /relative path is refused/i);
});

test('composite recipes and browser_batch document the ok failure contract', () => {
  for (const name of [
    'browser_wait_click_read',
    'browser_navigate_wait_read',
    'browser_click_wait_selector_read',
    'browser_batch',
  ]) {
    const description = getToolDefinition(name).description;
    assert.match(description, /ok flag/, `${name} should document the ok flag`);
    assert.match(description, /ok is false/, `${name} should say what a failure looks like`);
    assert.match(description, /marked as an error/, `${name} should say the MCP response is an error`);
  }
});

test('tool schemas carry no personal site as an example', () => {
  assert.doesNotMatch(toolsSource, AUTHOR_SITE_RE);
  assert.match(
    getToolDefinition('browser_navigate').inputSchema.properties.url.description,
    /Destination URL/,
  );
});

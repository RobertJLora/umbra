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

test('a build without the Ahrefs plugin advertises every tool except browser_export_ahrefs', () => {
  const withAhrefs = buildToolDefinitions({ ahrefs: true });
  const withoutAhrefs = buildToolDefinitions({ ahrefs: false });

  assert.deepEqual(withAhrefs, TOOL_DEFINITIONS, 'the ahrefs build should match the full surface');
  assert.deepEqual(buildToolDefinitions(), TOOL_DEFINITIONS, 'the default build should match the full surface');

  const droppedNames = withAhrefs
    .map((tool) => tool.name)
    .filter((name) => !withoutAhrefs.some((tool) => tool.name === name));
  assert.deepEqual(droppedNames, ['browser_export_ahrefs']);
  assert.equal(withoutAhrefs.length, TOOL_DEFINITIONS.length - 1);

  const localWithout = buildMcpLocalToolNames({ ahrefs: false });
  assert.equal(localWithout.has('browser_export_ahrefs'), false);
  assert.equal(localWithout.has('browser_batch'), true);
  assert.deepEqual([...buildMcpLocalToolNames({ ahrefs: true })], [...MCP_LOCAL_TOOL_NAMES]);

  // The extension owns the ahrefs_ page actions and reports its own clear error
  // when the recipe file is absent, so the enum stays identical in both builds.
  const pageAction = withoutAhrefs.find((tool) => tool.name === 'browser_run_page_action');
  assert.ok(pageAction.inputSchema.properties.action.enum.includes('ahrefs_export_csv'));
});

test('download-directory overrides exist on both tools that wait for a file', () => {
  const wait = getToolDefinition('browser_wait_for_download').inputSchema;
  assert.equal(wait.properties.dir.type, 'string');
  assert.match(wait.properties.dir.description, /UMBRA_DOWNLOAD_DIR/);
  assert.match(wait.properties.dir.description, /Absolute path/);

  const exportAhrefs = getToolDefinition('browser_export_ahrefs').inputSchema;
  assert.equal(exportAhrefs.properties.downloadDir.type, 'string');
  assert.match(exportAhrefs.properties.downloadDir.description, /UMBRA_DOWNLOAD_DIR/);
  assert.match(exportAhrefs.properties.downloadDir.description, /Absolute path/);
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
  assert.doesNotMatch(toolsSource, /travelbagexperts/i);
  assert.match(
    getToolDefinition('browser_export_ahrefs').inputSchema.properties.target.description,
    /example\.com/,
  );
});

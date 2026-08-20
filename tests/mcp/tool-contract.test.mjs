import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_BROWSER_BATCH_CALLS,
  TOOL_DEFINITIONS,
  getToolDefinition,
  isMcpLocalTool,
} from '../../mcp-server/tools.js';
import { buildMcpResponse } from '../../mcp-server/index.js';

const byName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function schemaFor(name) {
  const tool = getToolDefinition(name);
  assert.ok(tool, `${name} should exist`);
  return tool.inputSchema;
}

function implementedExtensionCommands() {
  const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');
  return [...background.matchAll(/if \(tool === '([^']+)'\)/g)].map((match) => match[1]);
}

describe('CiC MCP tool contract', () => {
  it('keeps tool names unique and browser-scoped', () => {
    assert.equal(byName.size, TOOL_DEFINITIONS.length, 'tool names should be unique');
    for (const tool of TOOL_DEFINITIONS) {
      assert.match(tool.name, /^browser_/);
      assert.equal(tool.inputSchema?.type, 'object');
      assert.ok(tool.description.length >= 20, `${tool.name} should describe its behavior`);
    }
  });

  it('exposes a read-only status tool for cleanup/reporting decisions', () => {
    const schema = schemaFor('browser_get_session_status');
    assert.deepEqual(schema.properties, {});
    assert.match(getToolDefinition('browser_get_session_status').description, /cleanup is safe/);
  });

  it('requires explicit URL input only where navigation truly needs it', () => {
    assert.deepEqual(schemaFor('browser_navigate').required, ['url']);
    assert.deepEqual(schemaFor('browser_adopt_tab').required, ['tabId']);
    assert.equal(schemaFor('browser_create_tab').required, undefined);
    assert.ok(schemaFor('browser_create_tab').properties.url);
  });

  it('keeps activation flags opt-in on all tools that can foreground Chrome', () => {
    for (const name of [
      'browser_create_tab',
      'browser_navigate',
      'browser_navigate_back',
      'browser_navigate_forward',
      'browser_run_page_action',
      'browser_javascript',
      'browser_click',
      'browser_click_text',
      'browser_fill',
      'browser_form_input',
      'browser_file_upload',
      'browser_hover',
      'browser_select_option',
      'browser_type',
      'browser_press_key',
      'browser_shortcut',
      'browser_scroll',
    ]) {
      assert.equal(schemaFor(name).properties.activate.type, 'boolean', `${name} should expose an explicit activate flag`);
      assert.match(schemaFor(name).properties.activate.description, /Defaults to false/);
    }
  });

  it('exposes predefined page actions with bounded result waiting', () => {
    const schema = schemaFor('browser_run_page_action');
    assert.deepEqual(schema.required, ['action']);
    assert.deepEqual(schema.properties.action.enum, [
      'render_wait',
      'element_positions',
      'inspect_controls',
      'click_control',
      'limit_table_rows',
      'scroll_selector',
      'restore_table_rows',
      'wait_for_text',
    ]);
    // These are the actions runPageAction in extension/background.js
    // implements itself. Anything else is a page recipe an optional local
    // plugin contributes, and it reaches this enum only when that plugin is
    // installed, so the published contract is exactly the list above.
    assert.equal(schema.properties.params.type, 'object');
    assert.equal(schema.properties.timeoutMs.type, 'number');
    assert.match(getToolDefinition('browser_run_page_action').description, /session-owned tab/);
  });

  it('exposes a bounded MCP-side browser_batch schema', () => {
    const schema = schemaFor('browser_batch');
    assert.deepEqual(schema.required, ['calls']);
    assert.equal(schema.properties.calls.type, 'array');
    assert.equal(schema.properties.calls.minItems, 1);
    assert.equal(schema.properties.calls.maxItems, MAX_BROWSER_BATCH_CALLS);
    assert.deepEqual(schema.properties.calls.items.required, ['tool']);
    assert.equal(schema.properties.calls.items.properties.tool.type, 'string');
    assert.equal(schema.properties.calls.items.properties.params.type, 'object');
    assert.equal(schema.properties.stopOnError.type, 'boolean');
    assert.equal(schema.properties.timeoutMs.type, 'number');
    assert.match(schema.properties.calls.description, new RegExp(`Maximum ${MAX_BROWSER_BATCH_CALLS}`));
    assert.equal(isMcpLocalTool('browser_batch'), true);
  });

  it('captures the updated page content, wait, pressure, and freeze schemas', () => {
    const pageContent = schemaFor('browser_get_page_content');
    assert.deepEqual(pageContent.properties.format.enum, ['text', 'html']);
    assert.deepEqual(pageContent.properties.mode.enum, ['page', 'body', 'main', 'selector']);
    assert.equal(pageContent.properties.selector.type, 'string');
    // Bounded integers, so the validator that already runs catches 0, -1 and 3.7
    // instead of forwarding them to the extension.
    assert.equal(pageContent.properties.maxChars.type, 'integer');
    assert.equal(pageContent.properties.maxChars.minimum, 1);
    assert.equal(pageContent.properties.includeImages.type, 'boolean');

    const wait = schemaFor('browser_wait');
    assert.deepEqual(wait.required, ['selector']);
    assert.equal(wait.properties.visible.type, 'boolean');
    assert.equal(wait.properties.timeoutMs.type, 'number');

    const pressure = schemaFor('browser_get_bridge_pressure');
    assert.equal(pressure.properties.includeTabs.type, 'boolean');
    assert.equal(pressure.properties.includePerformance.type, 'boolean');
    assert.equal(pressure.properties.maxTabSamples.type, 'number');

    const interactive = schemaFor('browser_read_interactive');
    assert.equal(interactive.properties.selector.type, 'string');
    assert.equal(interactive.properties.maxItems.type, 'number');

    const readPage = schemaFor('browser_read_page');
    assert.deepEqual(readPage.properties.filter.enum, ['all', 'interactive', 'landmarks']);
    assert.equal(readPage.properties.maxNodes.type, 'integer');
    assert.equal(readPage.properties.maxNodes.minimum, 1);
    assert.equal(readPage.properties.selector.type, 'string');

    const find = schemaFor('browser_find');
    assert.deepEqual(find.required, ['query']);
    assert.equal(find.properties.query.type, 'string');
    assert.equal(find.properties.limit.type, 'integer');
    assert.equal(find.properties.limit.minimum, 1);

    const formInput = schemaFor('browser_form_input');
    assert.equal(formInput.properties.ref.type, 'string');
    assert.equal(formInput.properties.selector.type, 'string');
    assert.equal(formInput.properties.value.type, 'string');
    assert.equal(formInput.properties.checked.type, 'boolean');
    assert.equal(formInput.properties.activate.type, 'boolean');
    assert.match(formInput.properties.activate.description, /Defaults to false/);

    const freeze = schemaFor('browser_freeze_session_tabs');
    assert.equal(freeze.properties.dryRun.type, 'boolean');
    assert.equal(freeze.properties.includeActive.type, 'boolean');
    assert.equal(freeze.properties.maxTabs.type, 'number');
    assert.equal(freeze.properties.tabIds.items.type, 'number');
  });

  it('lets screenshot captures write a PNG to disk for artifact workflows', () => {
    const schema = schemaFor('browser_screenshot');
    assert.equal(schema.properties.outputPath.type, 'string');
    assert.equal(schema.properties.region.type, 'object');
    assert.equal(schema.properties.ref.type, 'string');
    assert.equal(schema.properties.fullPage.type, 'boolean');
    assert.deepEqual(schema.properties.format.enum, ['png', 'jpeg']);

    // Write into a temporary directory the test creates itself: an absolute path
    // whose parent already exists, which is what the server accepts.
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-tool-contract-'));
    const outputPath = path.join(outputDir, 'test-screenshot-output.png');
    try {
      const response = buildMcpResponse('browser_screenshot', {
        tabId: 123,
        activated: true,
        mimeType: 'image/png',
        data: Buffer.from('png-bytes').toString('base64'),
      }, { outputPath });

      assert.equal(response.structuredContent.outputPath, outputPath);
      assert.equal(response.structuredContent.bytes, 9);
      assert.equal(response.content[0].type, 'text');
      assert.equal(fs.readFileSync(outputPath, 'utf8'), 'png-bytes');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('keeps group colors constrained to Chrome-supported values', () => {
    const expected = ['blue', 'green', 'yellow', 'pink', 'purple', 'cyan', 'orange'];
    for (const name of ['browser_create_tab', 'browser_navigate', 'browser_adopt_tab', 'browser_adopt_group']) {
      assert.deepEqual(schemaFor(name).properties.groupColor.enum, expected);
    }
    assert.deepEqual(schemaFor('browser_group_tabs').properties.color.enum, expected);
    assert.deepEqual(schemaFor('browser_mark_debug_group').properties.groupColor.enum, expected);
  });

  it('captures Playwright-parity tool schemas without loosening required fields', () => {
    assert.deepEqual(schemaFor('browser_resize').required, ['width', 'height']);
    assert.equal(schemaFor('browser_resize').properties.width.type, 'integer');
    assert.equal(schemaFor('browser_resize').properties.height.type, 'integer');
    assert.equal(schemaFor('browser_resize').properties.activate, undefined);

    assert.equal(schemaFor('browser_navigate_back').required, undefined);
    assert.equal(schemaFor('browser_navigate_forward').required, undefined);

    assert.equal(schemaFor('browser_hover').required, undefined);
    assert.equal(schemaFor('browser_hover').properties.selector.type, 'string');
    assert.equal(schemaFor('browser_hover').properties.ref.type, 'string');

    assert.deepEqual(schemaFor('browser_select_option').required, ['values']);
    assert.equal(schemaFor('browser_select_option').properties.values.type, 'array');
    assert.equal(schemaFor('browser_select_option').properties.values.items.type, 'string');

    assert.deepEqual(schemaFor('browser_type').required, ['text']);
    assert.equal(schemaFor('browser_type').properties.text.type, 'string');
    assert.equal(schemaFor('browser_type').properties.slowly.type, 'boolean');
    assert.equal(schemaFor('browser_type').properties.submit.type, 'boolean');

    const consoleMessages = schemaFor('browser_console_messages');
    assert.equal(consoleMessages.required, undefined);
    assert.deepEqual(consoleMessages.properties.level.enum, ['error', 'warning', 'info', 'debug']);
    assert.equal(consoleMessages.properties.all.type, 'boolean');

    assert.equal(schemaFor('browser_click').properties.doubleClick.type, 'boolean');
  });

  it('exposes V1.6 group, recipe, and ledger-backed download helpers without adding them to extension batches', () => {
    assert.deepEqual(schemaFor('browser_adopt_group').required, ['groupId']);
    assert.equal(schemaFor('browser_find_groups').properties.titleIncludes.type, 'string');
    assert.equal(schemaFor('browser_wait_for_download').properties.filename.type, 'string');
    assert.equal(schemaFor('browser_wait_for_download').properties.createdAfterMs.type, 'number');
    for (const name of ['browser_wait_click_read', 'browser_navigate_wait_read', 'browser_click_wait_selector_read', 'browser_wait_for_download']) {
      assert.equal(isMcpLocalTool(name), true, `${name} should stay MCP-local`);
    }
  });

  it('limits stale-group cleanup to narrow matchers and capped modes', () => {
    const schema = schemaFor('browser_cleanup_groups');
    assert.deepEqual(schema.properties.mode.enum, ['closeTabs', 'ungroupOnly']);
    assert.ok(schema.properties.title);
    assert.ok(schema.properties.titlePrefix);
    assert.ok(schema.properties.dryRun);
    assert.equal(schema.properties.includeConnected, undefined);
    assert.ok(schema.properties.maxGroups);
    assert.equal(schema.required, undefined, 'runtime should enforce title/titlePrefix so dry-run probes can share one schema');
  });

  it('keeps extension command handlers schema-backed while browser_batch stays MCP-local', () => {
    const implementedTools = implementedExtensionCommands();
    for (const toolName of implementedTools) {
      assert.ok(getToolDefinition(toolName), `${toolName} should have a public MCP schema`);
      assert.equal(isMcpLocalTool(toolName), false, `${toolName} should not be marked MCP-local`);
    }
    assert.equal(implementedTools.includes('browser_batch'), false, 'browser_batch should not be a raw extension command');
  });

  it('keeps the benchmark matrix aligned with performance gates', () => {
    const benchmark = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'benchmark-performance.mjs'), 'utf8');

    for (const scenario of [
      'create-read-text',
      'navigate-loop',
      'wait-loop',
      'screenshot',
      'multi-tab-fanout',
      'large-payload-html',
      'technical-snapshot',
      'workflow-separate',
      'workflow-batch',
      'export-like-workflow',
      'read-interactive',
      'read-interactive-ref-click',
      'recipe-workflow',
      'cached-second-read',
      'group-find-adopt-overhead',
    ]) {
      assert.match(benchmark, new RegExp(`name: '${scenario}'`));
    }
    assert.match(benchmark, /browser_batch/);
    assert.match(benchmark, /browser_screenshot/);
    assert.match(benchmark, /export-status/);
    assert.match(benchmark, /function isGoogleChromeProcess/);
    assert.doesNotMatch(benchmark, /\|--type=/);
  });

  it('keeps sensitive extraction and broad browser-control concepts out of public tool definitions', () => {
    const forbidden = [
      /cookie/i,
      /local\s*storage/i,
      /session\s*storage/i,
      /token/i,
      /password/i,
      /captcha/i,
      /(?<!position[-_])history/i,
      /debugger/i,
      /all tabs/i,
    ];

    for (const tool of TOOL_DEFINITIONS) {
      const serialized = JSON.stringify(tool);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(serialized), false, `${tool.name} should not advertise ${pattern}`);
      }
    }
  });
});

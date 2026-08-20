import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, getToolDefinition } from '../../mcp-server/tools.js';

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

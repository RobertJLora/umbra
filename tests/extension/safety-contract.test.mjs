import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFINITIONS, isMcpLocalTool } from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const backgroundPath = path.join(repoRoot, 'extension', 'background.js');
const manifestPath = path.join(repoRoot, 'extension', 'manifest.json');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

function getToolBlock(source, toolName) {
  const start = source.indexOf(`if (tool === '${toolName}')`);
  assert.ok(start >= 0, `${toolName} handler should exist`);
  const next = source.indexOf('\n  if (tool ===', start + 1);
  return source.slice(start, next === -1 ? source.indexOf('\n  throw new Error', start) : next);
}

describe('CiC extension safety contract', () => {
  it('implements every advertised MCP tool in the background worker', () => {
    const background = read('extension/background.js');

    for (const tool of TOOL_DEFINITIONS) {
      if (isMcpLocalTool(tool.name)) {
        continue;
      }
      assert.match(background, new RegExp(`if \\(tool === '${tool.name}'\\)`), `${tool.name} needs a background handler`);
    }
  });

  it('does not implement unadvertised browser tools that bypass the MCP schema', () => {
    const background = read('extension/background.js');
    const implementedTools = [...background.matchAll(/if \(tool === '([^']+)'\)/g)].map((match) => match[1]);
    const advertisedTools = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

    assert.deepEqual(
      implementedTools.filter((tool) => !advertisedTools.has(tool)),
      [],
      'background should not carry private browser_* command handlers',
    );
  });

  it('keeps all mutating and reading tab tools behind owned-tab resolution', () => {
    const background = read('extension/background.js');
    for (const toolName of [
      'browser_switch_tab',
      'browser_close_tab',
      'browser_screenshot',
      'browser_get_page_content',
      'browser_read_interactive',
      'browser_read_page',
      'browser_find',
      'browser_form_input',
      'browser_get_technical_snapshot',
      'browser_run_page_action',
      'browser_javascript',
      'browser_click',
      'browser_click_text',
      'browser_fill',
      'browser_press_key',
      'browser_scroll',
      'browser_wait',
      'browser_resize',
      'browser_navigate_back',
      'browser_navigate_forward',
      'browser_hover',
      'browser_select_option',
      'browser_type',
      'browser_console_messages',
      'browser_file_upload',
      'browser_shortcut',
    ]) {
      const block = getToolBlock(background, toolName);
      assert.match(block, /getOwnedTab|getOrCreateSessionTab/, `${toolName} should resolve only a session-owned tab`);
      assert.doesNotMatch(block, /chrome\.tabs\.query\(\{\}\)/, `${toolName} should not query the whole browser`);
    }

    const tabsContextBlock = getToolBlock(background, 'browser_tabs_context');
    assert.match(tabsContextBlock, /chrome\.tabs\.query\(\{\}\)/, 'browser_tabs_context may query open tabs because listing is the point');
    assert.match(tabsContextBlock, /createIfEmpty/);
    assert.match(tabsContextBlock, /includeInternal/);
    assert.match(tabsContextBlock, /owned/);
    assert.doesNotMatch(tabsContextBlock, /adoptExistingTab/);
    assert.doesNotMatch(tabsContextBlock, /chrome\.tabs\.remove/);
    assert.doesNotMatch(getToolBlock(background, 'browser_list_tabs'), /chrome\.tabs\.query\(\{\}\)/);

    const resizeBlock = getToolBlock(background, 'browser_resize');
    assert.match(resizeBlock, /assertWindowOwnedExclusively/);
    assert.match(resizeBlock, /focused: false/);
    const exclusiveWindowHelper = background.slice(
      background.indexOf('async function assertWindowOwnedExclusively'),
      background.indexOf('function requirePositiveInteger'),
    );
    assert.match(exclusiveWindowHelper, /unowned|mixed/);
  });

  it('keeps the content agent owned-tab scoped and free of sensitive browser powers', () => {
    const background = read('extension/background.js');
    const agent = read('extension/content-agent.js');
    const readBlock = getToolBlock(background, 'browser_get_page_content');
    const waitBlock = getToolBlock(background, 'browser_wait');

    assert.match(readBlock, /getOrCreateSessionTab\(sessionId/);
    assert.match(readBlock, /createIfMissing: false/);
    assert.match(readBlock, /readPageContentViaAgent\(sessionId, tab\.id/);
    assert.match(waitBlock, /getOrCreateSessionTab\(sessionId/);
    assert.match(waitBlock, /createIfMissing: false/);
    assert.match(waitBlock, /waitForSelectorViaAgent\(tab\.id/);
    assert.match(background, /chrome\.runtime\.onConnect\.addListener/);
    assert.match(background, /port\.sender\?\.tab\?\.id/);
    assert.match(background, /invalidateSessionContentAgents/);
    assert.doesNotMatch(agent, /cookies|password|token|localStorage|sessionStorage|indexedDB|chrome\.tabs|chrome\.debugger|chrome\.downloads/);
  });

  it('keeps routine create, navigate, and DOM tools background-first by default', () => {
    const background = read('extension/background.js');

    for (const toolName of [
      'browser_create_tab',
      'browser_navigate',
      'browser_run_page_action',
      'browser_javascript',
      'browser_click',
      'browser_click_text',
      'browser_fill',
      'browser_form_input',
      'browser_file_upload',
      'browser_shortcut',
      'browser_hover',
      'browser_select_option',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_navigate_back',
      'browser_navigate_forward',
    ]) {
      const block = getToolBlock(background, toolName);
      assert.match(block, /activate: params\.activate === true|const activate = params\.activate === true/, `${toolName} should require explicit activation`);
      assert.doesNotMatch(block, /activate: params\.activate !== false/, `${toolName} must not activate by default`);
    }
  });

  it('treats screenshot as the only intentionally activating read tool', () => {
    const background = read('extension/background.js');
    const screenshotBlock = getToolBlock(background, 'browser_screenshot');

    assert.match(screenshotBlock, /activate: silent \? false : true/);
    assert.match(screenshotBlock, /if \(silent\)/);
    for (const toolName of ['browser_get_page_content', 'browser_read_interactive', 'browser_read_page', 'browser_find', 'browser_get_technical_snapshot', 'browser_wait']) {
      assert.match(getToolBlock(background, toolName), /activate: false/);
    }
  });

  it('keeps V1.6 group adoption conservative and ref tools owned-tab scoped', () => {
    const background = read('extension/background.js');
    const adoptBlock = getToolBlock(background, 'browser_adopt_group');
    const findBlock = getToolBlock(background, 'browser_find_groups');
    const clickBlock = getToolBlock(background, 'browser_click');

    assert.match(adoptBlock, /adoptChromeGroup\(sessionId, params\)/);
    assert.match(background, /ownerSession\?\.connected === true/);
    assert.match(background, /browser-internal tabs/);
    assert.doesNotMatch(adoptBlock, /force/);
    assert.match(findBlock, /findChromeGroups\(sessionId, params\)/);
    assert.match(background, /cleanupGroups\(sessionId, params\)/);
    assert.match(background, /ownedByCaller/);
    assert.match(background, /ownedByOther/);
    assert.match(background, /owned_by_other_session/);
    assert.doesNotMatch(background, /owners: foreignOwners/);
    assert.doesNotMatch(background, /ownerSessionIds/);
    assert.doesNotMatch(background, /includeConnected/);
    assert.match(background, /isTrustedExtensionSender/);
    assert.match(background, /update_url/);
    assert.match(background, /groupId is not owned by this session/);
    assert.match(clickBlock, /sendContentAgentCommand\(tab\.id, 'click_interactive_ref'/);
    assert.match(clickBlock, /getOrCreateSessionTab\(sessionId/);
  });

  it('keeps predefined page actions behind owned-tab resolution and JSON-safe results', () => {
    const background = read('extension/background.js');
    const helper = background.slice(
      background.indexOf('function toBridgeSafeValue'),
      background.indexOf('function getTechnicalSnapshot'),
    );
    const block = getToolBlock(background, 'browser_run_page_action');

    assert.match(block, /getOrCreateSessionTab/);
    assert.match(block, /activate: params\.activate === true/);
    assert.match(block, /runPageAction/);
    assert.match(helper, /maxDepth/);
    assert.match(helper, /maxArrayLength/);
    assert.match(helper, /Page action timed out after/);
    assert.doesNotMatch(helper, /https:\/\/cdnjs/);
    assert.doesNotMatch(helper, /html2canvas/);
  });

  it('blocks dangerous navigation schemes at the extension boundary', () => {
    const background = read('extension/background.js');

    assert.match(background, /function normalizeBridgeUrl/);
    assert.match(background, /\['http:', 'https:', 'file:'\]\.includes\(parsed\.protocol\)/);
    assert.match(background, /Unsupported URL scheme for navigation/);
    assert.match(getToolBlock(background, 'browser_create_tab'), /normalizeBridgeUrl/);
    assert.match(getToolBlock(background, 'browser_navigate'), /normalizeBridgeUrl/);
  });

  it('never exposes cookies, token, history, password, or downloads permissions in the manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const serialized = JSON.stringify([
      manifest.permissions || [],
      manifest.optional_permissions || [],
      manifest.host_permissions || [],
    ]);

    for (const forbidden of ['cookies', 'history', 'downloads', 'password', 'tokens']) {
      assert.equal(serialized.includes(forbidden), false, `manifest must not request ${forbidden}`);
    }
    assert.equal(
      (manifest.permissions || []).includes('debugger'),
      true,
      'silent screenshot and owned-tab file upload may request debugger',
    );
  });

  it('uses debugger only to attach and detach for silent screenshot and owned-tab file upload', () => {
    const background = read('extension/background.js');
    const fileBlock = getToolBlock(background, 'browser_file_upload');
    const screenshotBlock = getToolBlock(background, 'browser_screenshot');
    const helperStart = background.indexOf('async function withOwnedTabDebugger');
    const helperEnd = background.indexOf('\nasync function ', helperStart + 1);
    const helper = background.slice(helperStart, helperEnd === -1 ? undefined : helperEnd);

    assert.match(fileBlock, /getOrCreateSessionTab|getOwnedTab/);
    assert.match(fileBlock, /setOwnedTabFileInput/);
    assert.match(screenshotBlock, /captureSilentScreenshot/);
    assert.match(helper, /chrome\.debugger\.attach/);
    assert.match(helper, /chrome\.debugger\.detach/);
    assert.match(helper, /finally/);

    const fileHelperStart = background.indexOf('async function setOwnedTabFileInput');
    const fileHelperEnd = background.indexOf('\nfunction ', fileHelperStart + 1);
    const fileHelper = background.slice(fileHelperStart, fileHelperEnd === -1 ? undefined : fileHelperEnd);
    assert.match(fileHelper, /DOM\.setFileInputFiles/);
    assert.match(fileHelper, /withOwnedTabDebugger/);

    for (const toolName of [
      'browser_tabs_context',
      'browser_shortcut',
      'browser_press_key',
      'browser_click',
    ]) {
      assert.doesNotMatch(getToolBlock(background, toolName), /chrome\.debugger/, `${toolName} must not attach the debugger`);
    }
  });

  it('keeps visible cleanup ownership-based and preserves unowned tabs in mixed windows', () => {
    const background = read('extension/background.js');
    const block = background.slice(
      background.indexOf('async function closeOwnedSessionWindows'),
      background.indexOf('async function closeSessionTabs'),
    );

    assert.match(block, /tabs\.every\(\(tab\) => tabIdSet\.has\(tab\.id\) && sessionStore\.findOwner\(tab\.id\) === sessionId\)/);
    assert.match(block, /preservedWindows\.push/);
    assert.doesNotMatch(block, /about:blank|chrome:\/\/newtab|isBlankResidueTab/);
  });

  it('session status is read-only and reports cleanup blast radius before close', () => {
    const background = read('extension/background.js');
    const helper = background.slice(
      background.indexOf('async function buildSessionStatus'),
      background.indexOf('async function handleBridgeCommand'),
    );
    const block = getToolBlock(background, 'browser_get_session_status');

    assert.match(helper, /removableWindowIds/);
    assert.match(helper, /preservedWindowIds/);
    assert.match(helper, /ownedTabsCanClose/);
    assert.doesNotMatch(block, /chrome\.tabs\.remove|chrome\.windows\.remove|chrome\.tabs\.create|chrome\.tabs\.update/);
  });

  it('does not persist session state on high-frequency read-only commands unless metadata changes', () => {
    const background = read('extension/background.js');
    const commandPreamble = background.slice(
      background.indexOf('async function handleBridgeCommand'),
      background.indexOf("if (tool === 'browser_get_session_status')"),
    );
    const listBlock = getToolBlock(background, 'browser_list_tabs');

    assert.match(commandPreamble, /const connectionChanged = sessionStore\.markConnected/);
    assert.match(commandPreamble, /if \(connectionChanged\) \{\n    await sessionStore\.persist\(\);/);
    assert.match(listBlock, /let releasedMissingTab = false/);
    assert.match(listBlock, /if \(releasedMissingTab\) \{\n      await sessionStore\.persist\(\);/);

    for (const toolName of ['browser_get_page_content', 'browser_get_technical_snapshot', 'browser_wait']) {
      const block = getToolBlock(background, toolName);
      assert.match(block, /updateActive: false/);
      assert.match(block, /persist: false/);
    }
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getToolDefinition } from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');
const contentAgent = fs.readFileSync(path.join(repoRoot, 'extension', 'content-agent.js'), 'utf8');

function getToolBlock(source, toolName) {
  const start = source.indexOf(`if (tool === '${toolName}')`);
  assert.ok(start >= 0, `${toolName} handler should exist`);
  const next = source.indexOf('\n  if (tool ===', start + 1);
  return source.slice(start, next === -1 ? source.indexOf('\n  throw new Error', start) : next);
}

function getFunctionBlock(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.ok(start >= 0, `${functionName} should exist`);
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  return source.slice(start, nextFn === -1 ? source.length : start + 1 + nextFn);
}

function schemaFor(name) {
  const tool = getToolDefinition(name);
  assert.ok(tool, `${name} should exist`);
  return tool.inputSchema;
}

describe('keyboard default actions and navigation waits', () => {
  it('emulates the Enter default action instead of dispatching an inert key event', () => {
    const block = getFunctionBlock(background, 'pressKey');

    // A synthetic KeyboardEvent is untrusted, and a key event has no activation
    // behavior, so implicit form submission never ran. clickSelector's
    // element.click() did submit, because activation behavior runs whatever
    // isTrusted says. Enter therefore has to be emulated in the page.
    assert.match(block, /default_button_click/);
    assert.match(block, /requestSubmit\(/);
    assert.match(block, /enter_inserts_newline/);
    assert.match(block, /multiple_fields_block_implicit_submission/);

    // Legacy fields were all zero, so any page handler branching on
    // event.keyCode or event.which ignored the key before default actions even
    // entered the picture, and a missing composed flag stopped it crossing a
    // shadow boundary.
    assert.match(block, /keyCode:/);
    assert.match(block, /which:/);
    assert.match(block, /composed: true/);

    // Three guards against a double submit: a submit listener installed before
    // dispatch, the dispatchEvent return value, and a URL comparison.
    assert.match(block, /addEventListener\('submit', onSubmitCapture, \{ capture: true \}\)/);
    assert.match(block, /page_prevented_default/);
    assert.match(block, /page_submitted/);
    assert.match(block, /page_navigated/);

    // Input.dispatchKeyEvent is not an option: it would need a new CDP command
    // and the tab-activating path, which is the focus theft Umbra promises not
    // to do.
    assert.doesNotMatch(block, /Input\.dispatchKeyEvent/);
    assert.doesNotMatch(background, /Input\.dispatchKeyEvent/);
  });

  it('routes every key path through dispatchKeyInTab without touching the debugger', () => {
    const helper = getFunctionBlock(background, 'dispatchKeyInTab');
    // A working submit navigates the frame, and Chrome can tear the frame down
    // before chrome.scripting returns. That rejection is evidence the key did
    // something, so it is reported rather than thrown.
    assert.match(helper, /KEY_NAVIGATION_TEARDOWN_RE/);
    assert.match(helper, /navigationTeardown: true/);

    const pressKeyBlock = getToolBlock(background, 'browser_press_key');
    assert.match(pressKeyBlock, /dispatchKeyInTab/);
    assert.match(pressKeyBlock, /activate: params\.activate === true/);
    assert.doesNotMatch(pressKeyBlock, /chrome\.debugger/);

    const shortcutBlock = getToolBlock(background, 'browser_shortcut');
    assert.match(shortcutBlock, /dispatchKeyInTab/);
    assert.doesNotMatch(shortcutBlock, /chrome\.debugger/);

    // browser_type used to fire a blind Enter at document.activeElement and
    // report typed: true whether or not anything was submitted.
    const typeBlock = getToolBlock(background, 'browser_type');
    assert.match(typeBlock, /submit: pressed/);
    assert.match(typeBlock, /selector: ref \? '' : selector/);
  });

  it('lets browser_wait observe a navigation rather than a selector that was already there', () => {
    const waitBlock = getToolBlock(background, 'browser_wait');
    assert.match(waitBlock, /waitForTabUrl/);
    assert.match(waitBlock, /requires selector, urlContains, urlChanged, or durationMs/);
    // The selector path stays byte-identical for callers that pass one.
    assert.match(waitBlock, /waitForSelectorViaAgent\(tab\.id/);

    const helper = getFunctionBlock(background, 'waitForTabUrl');
    // The wait lives in the worker, not the page: a page-side wait dies with the
    // document the navigation replaces, which is the event being observed.
    assert.match(helper, /chrome\.tabs\.onUpdated/);
    assert.match(helper, /wait_timeout/);
    assert.doesNotMatch(helper, /chrome\.debugger/);
  });

  it('advertises the new keyboard and wait parameters as optional', () => {
    assert.equal(schemaFor('browser_wait').required, undefined);
    assert.equal(schemaFor('browser_wait').properties.urlContains.type, 'string');
    assert.equal(schemaFor('browser_wait').properties.urlChanged.type, 'boolean');
    assert.equal(schemaFor('browser_press_key').properties.defaultAction.type, 'boolean');
    assert.equal(schemaFor('browser_press_key').properties.selector.type, 'string');
    assert.equal(schemaFor('browser_shortcut').properties.defaultAction.type, 'boolean');
    assert.equal(schemaFor('browser_type').properties.defaultAction.type, 'boolean');
    // Enter now submits, which is the fix, so it is announced rather than
    // shipped silently, and defaultAction false restores pure dispatch.
    assert.match(schemaFor('browser_press_key').properties.defaultAction.description, /Defaults to true/);
  });

  it('gives slowly-typed characters the legacy key fields a page handler reads', () => {
    assert.match(getFunctionBlock(background, 'typeSelector'), /keyCode: legacy/);
    assert.match(contentAgent, /keyCode: legacy/);
  });
});

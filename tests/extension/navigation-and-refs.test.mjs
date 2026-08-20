import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTHOR_NAME_RE, AUTHOR_SURNAME_RE, HOME_PATH_RE } from '../identity-needles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');

function functionBlock(source, header, nextHeader) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} should exist`);
  const end = source.indexOf(nextHeader, start + 1);
  assert.ok(end > start, `${header} should be bounded by ${nextHeader}`);
  return source.slice(start, end);
}

describe('navigation waits, ref resolution, and page recipes', () => {
  it('treats a load that lands anywhere other than the pre-navigation URL as arrived', () => {
    const block = functionBlock(background, 'async function waitForTabComplete', 'function normalizeBridgeUrl');

    // A redirect, an http to https upgrade, an added tracking parameter, or a
    // login bounce all end somewhere other than the requested href. Requiring
    // an href-identical match burned the whole 45-second timeout on every one
    // of them and answered loadTimedOut.
    assert.match(block, /const preNavUrl = existing\.url \|\| ''/);
    assert.match(block, /tabUrlMatchesExpected\(url, expectedUrl\) \|\| url !== preNavUrl/);

    // Both settle paths, the interval poll and the onUpdated listener, use the
    // same condition.
    assert.equal((block.match(/arrived\(tab\.url \|\| ''\)/g) || []).length, 2);

    // Re-navigating to the URL a tab already sits on has to wait for the new
    // load: chrome.tabs.update resolves before the tab leaves `complete` on the
    // old document, so returning early handed back pre-navigation state.
    assert.match(block, /options\.navigationPending !== true/);
    assert.match(background, /waitForTabComplete\(tab\.id, clampTimeoutMs\(params\.timeoutMs\), url, \{\n\s*navigationPending: true,\n\s*\}\)/);
  });

  it('awaits the session-state load before any handler touches session state', () => {
    // A message can wake a cold worker. Persisting before the stored map is read
    // back wrote an empty map over chrome.storage.session and orphaned every
    // owned tab; bridge_session_disconnected persisted unconditionally, so it
    // wiped every session rather than only the caller's.
    assert.match(background, /const sessionStoreReady = sessionStore\.load\(\)/);

    const listener = functionBlock(
      background,
      'chrome.runtime.onMessage.addListener',
      'chrome.tabs.onRemoved.addListener',
    );
    const awaitIndex = listener.indexOf('await sessionStoreReady;');
    const switchIndex = listener.indexOf('switch (message?.type)');
    assert.ok(awaitIndex > 0, 'the message handler should await the session-state load');
    assert.ok(awaitIndex < switchIndex, 'the await should come before any branch runs');

    // Awaiting all of initialize() here would put offscreen document creation
    // on the critical path of every command.
    assert.doesNotMatch(listener, /await initialize\(/);

    // The one-minute wake alarm must not re-read session state, because that
    // replaces the live map and discards any tab an in-flight command claimed.
    const initialize = functionBlock(background, 'async function initialize', 'chrome.alarms?.onAlarm.addListener');
    assert.match(initialize, /if \(!bootstrapped\)/);
    assert.match(initialize, /await ensureOffscreenDocument\(\);/);
    assert.doesNotMatch(initialize, /await sessionStore\.load\(\)/);
  });

  it('reuses a live content agent instead of re-injecting the ax tree helpers', () => {
    const block = functionBlock(background, 'async function ensureContentAgent', 'async function sendContentAgentCommand');
    const healthy = block.slice(0, block.indexOf('\n  try {'));

    // Re-injecting ax-tree.js on every content-agent command reset the shared
    // element ref store, so a ref minted by browser_read_interactive failed on
    // the very next call.
    assert.ok(healthy.includes('if (existing && !existing.disconnected)'));
    assert.doesNotMatch(healthy, /executeScript/);
    assert.doesNotMatch(healthy, /agent_probe/);

    // The liveness signal that re-injection used to provide is replaced by an
    // invalidate and one retry, so a dead-but-not-yet-disconnected port does not
    // surface as "Attempting to use a disconnected port object".
    const send = functionBlock(background, 'async function sendContentAgentCommand', 'function useOneShotContentFallback');
    assert.match(send, /content_agent_port_dead/);
    assert.match(send, /invalidateContentAgent\(tabId, 'stale'\)/);
    assert.match(send, /retried: true/);
  });

  it('reads element text only for the samples it returns and serializes the document once', () => {
    const block = functionBlock(background, '\nfunction getTechnicalSnapshot', '\nfunction clickSelector');

    // Every href, rel, sameHost flag, and heading level feeds a count, so the
    // full pass stays. Only the innerText read is capped, which on a page with
    // 6,567 anchors is the difference between 25.2 ms and 0.1 ms.
    assert.match(block, /const SAMPLE_LIMIT = 80/);
    assert.match(block, /index < SAMPLE_LIMIT \? elementText\(heading, 240\) : ''/);
    assert.match(block, /index < SAMPLE_LIMIT \? elementText\(link, 160\) : ''/);

    // outerHTML used to be serialized twice with includeHtml set and once
    // without it, purely to read a length.
    assert.equal((block.match(/documentElement\.outerHTML/g) || []).length, 1);
    assert.match(block, /htmlLength: html\.length/);
  });

  it('returns one copy of the page payload and bounds maxChars', () => {
    const block = functionBlock(background, '\nfunction readPageContent(', '\nfunction readInteractive(');

    // html and content were byte-identical on every html read, and bodyText and
    // content were byte-identical on every read at the default
    // includeImages: false, which is the default.
    assert.doesNotMatch(block, /\n\s*html: html\.value,/);
    assert.match(block, /const bodyText = rawContent === rawBodyText \? null : truncate\(rawBodyText\)/);
    assert.match(block, /\.\.\.\(bodyText \? \{ bodyText: bodyText\.value/);

    // Zero used to mean unbounded, and nothing downstream bounds a page read.
    assert.match(block, /const MAX_CHARS_LIMIT = 500_000/);
    assert.match(block, /: MAX_CHARS_LIMIT;/);
    assert.doesNotMatch(block, /maxChars: maxChars \|\| null/);
  });

  it('resolves interactive refs against the same visibility-filtered list that minted them', () => {
    const block = functionBlock(background, 'function resolveInteractiveRef', 'function clickInteractiveRef');

    // readInteractive numbers controls after filtering for visibility, so any
    // hidden element earlier in document order shifted an unfiltered lookup by
    // one and returned a real but wrong element.
    assert.match(block, /\[\.\.\.document\.querySelectorAll\(current\.selector\)\]\.filter\(isVisible\)\[parsed\.index\]/);
    assert.doesNotMatch(block, /document\.querySelectorAll\(current\.selector\)\[parsed\.index\]/);

    // browser_screenshot cropped to whatever that wrong element was. It now
    // resolves through the content agent, which owns the ref store.
    const screenshot = background.slice(
      background.indexOf("if (tool === 'browser_screenshot')"),
      background.indexOf("if (tool === 'browser_get_page_content')"),
    );
    assert.match(screenshot, /resolveScreenshotRefRect\(tab\.id, params\.ref/);
    assert.doesNotMatch(screenshot, /executeInTab\(tab\.id, scrollInteractiveRef/);

    const resolver = functionBlock(background, 'async function resolveScreenshotRefRect', 'async function buildScreenshotPreflight');
    assert.match(resolver, /sendContentAgentCommand\(tabId, 'scroll_interactive_ref'/);

    // chrome.scripting serializes an injected function without its scope, so a
    // one-shot copy of the resolver cannot reach the helpers it is built from.
    // browser_scroll and browser_click take the agent-only path for the same
    // reason, and this matches them.
    assert.doesNotMatch(resolver, /executeInTab/);
  });

  it('encodes screenshot bytes in chunks and stops wrapping base64 it immediately strips', () => {
    const encoder = functionBlock(background, 'function base64FromBytes', 'async function encodeCanvasBase64');

    // A per-byte append costs 389 ms on a 10 MB image against 54 ms chunked,
    // for byte-identical output.
    assert.match(encoder, /const chunkSize = 32_768/);
    assert.match(encoder, /String\.fromCharCode\.apply\(null, bytes\.subarray/);
    assert.match(encoder, /btoa\(chunks\.join\(''\)\)/);
    assert.doesNotMatch(encoder, /binary \+= String\.fromCharCode/);

    // Page.captureScreenshot already returns base64.
    const silent = functionBlock(background, 'async function captureSilentScreenshot', '// Accepts either a full data URL');
    assert.match(silent, /return result\.data;/);
    assert.doesNotMatch(silent, /`data:\$\{mime\};base64,/);
  });

  it('ships no author identity and no unrelated vendor name in the worker', () => {
    assert.doesNotMatch(background, AUTHOR_NAME_RE);
    assert.doesNotMatch(background, AUTHOR_SURNAME_RE);
    assert.doesNotMatch(background, HOME_PATH_RE);
    assert.doesNotMatch(background, /codex/i);
    assert.match(background, /BRIDGE_WAKE_ALARM_NAME = 'umbra_bridge_wake'/);
    assert.match(background, /__umbraPageConsole/);
    assert.match(background, /__umbraContentAgent/);
    assert.match(background, /your everyday Chrome window/);
  });

  it('keeps the offscreen document off an unconfigured install and opens options on first run', () => {
    const ensure = functionBlock(background, 'async function ensureOffscreenDocument', 'async function ensureBridgeWakeAlarm');

    // A keyless install used to run a permanently resident offscreen document
    // whose two-second tick pinned the worker awake and wrote storage forever.
    assert.match(ensure, /if \(!\(await bridgeIsConfigured\(\)\)\)/);
    assert.match(ensure, /await closeOffscreenDocument\(\);/);
    assert.match(background, /config\.bridgeEnabled === true && Boolean\(config\.sharedKey\)/);
    assert.match(background, /chrome\.storage\.onChanged\.addListener/);
    assert.match(ensure, /No Reason enum value covers holding a raw WebSocket/);

    assert.match(background, /details\?\.reason !== 'install'/);
    assert.match(background, /chrome\.runtime\.openOptionsPage\(\)/);
  });

  it('shares one debugger attachment per tab and names a foreign holder', () => {
    const block = functionBlock(background, 'async function withOwnedTabDebugger', 'chrome.debugger?.onDetach');

    // Detaching while a concurrent call was still issuing commands made every
    // one of that call's sendCommand rejections look like a page failure.
    assert.match(block, /entry\.refCount \+= 1/);
    assert.match(block, /entry\.refCount > 0/);
    assert.match(block, /chrome\.debugger\.detach\(target\)/);
    assert.match(background, /const tabDebuggerAttachments = new Map\(\)/);
    assert.match(background, /chrome\.debugger\?\.onDetach\?\.addListener/);

    const claim = functionBlock(background, 'async function claimTabDebugger', 'async function withOwnedTabDebugger');
    assert.match(claim, /busy\.code = 'debugger_busy'/);
  });

  it('sends browser_javascript straight to the debugger', () => {
    const block = functionBlock(background, 'async function executeJavascriptViaAgent', 'async function ensureAxTreeHelpers');

    // The agent request always set pageWorld, and the agent answers that flag
    // by returning without running anything, so the round trip carried the
    // whole code string and a 24 KB injection to execute nothing.
    assert.doesNotMatch(block, /sendContentAgentCommand/);
    assert.match(block, /executeJavascriptWithWorldFallback\(tabId, code, timeoutMs\)/);
    assert.match(block, /version: agent\.version \|\| ''/);
  });

  it('dispatches namespaced page actions through an injected recipe it does not name', () => {
    // Site-specific DOM automation used to live inside runPageAction. It moved
    // behind a seam so a build can ship without it, and the seam names no site:
    // the namespace comes from the action name, so background.js carries no
    // list of the recipes a checkout might install.
    const runner = functionBlock(background, 'async function runPageAction', 'function getTechnicalSnapshot');
    // Own-property lookup, so an action named after an inherited Object member
    // (constructor_x, valueOf_x) cannot resolve as a namespace.
    assert.match(runner, /Object\.hasOwn\(registry, namespace\)/);
    assert.match(runner, /globalThis\.__umbraPageRecipes/);
    assert.match(runner, /Page recipe not installed in this build/);
    assert.doesNotMatch(runner, /const fireReact =/);
    assert.doesNotMatch(runner, /openTableExport/);
    assert.doesNotMatch(runner, /collectModalState/);

    // wait_for_text is not site-specific and stays inline.
    assert.match(runner, /if \(action === 'wait_for_text'\)/);

    // The injection result is kept, so a recipe that is present but broken
    // reports why instead of reading as absent.
    assert.match(background, /const recipe = await ensurePageRecipe\(tab\.id, params\.action\)/);
    assert.match(runner, /failed to inject/);
    const ensure = functionBlock(background, 'async function ensurePageRecipe', 'async function runPageAction');
    assert.match(ensure, /recipes\/\$\{namespace\}-actions\.js/);
    assert.match(ensure, /chrome\.scripting\.executeScript\(\{ target: \{ tabId \}, files: \[file\] \}\)/);
  });

  it('derives the recipe namespace from the action name and leaves built-ins alone', () => {
    // pageRecipeNamespace is the whole reason no recipe has to be listed. Run
    // the real function rather than matching its source, so a rewrite that
    // reintroduces a hardcoded list still has to keep this behavior.
    const block = functionBlock(background, 'const BUILTIN_PAGE_ACTIONS', 'async function ensurePageRecipe');
    const context = vm.createContext({});
    vm.runInContext(`${block}\nglobalThis.pageRecipeNamespace = pageRecipeNamespace;`, context);
    const namespaceFor = vm.runInContext('pageRecipeNamespace', context);

    assert.equal(namespaceFor('wait_for_text'), '', 'a built-in action needs no recipe file');
    assert.equal(namespaceFor('limit_table_rows'), '');
    assert.equal(namespaceFor('vendor_open_export'), 'vendor');
    assert.equal(namespaceFor('vendor_export_csv'), 'vendor');
    assert.equal(namespaceFor(''), '');
    assert.equal(namespaceFor('../escape_attempt'), '', 'a namespace that is not plain lowercase is refused');
  });

  it('carries no page recipe of its own in the tracked tree', () => {
    // extension/recipes/ is local-only and gitignored. A build with nothing in
    // it is the public build, and it has to be the normal case rather than a
    // broken one.
    assert.doesNotMatch(background, /recipes\/[a-z0-9]+-actions\.js['"]/);
  });

  it('does not persist an unhydrated Enable-scanning checkbox as false', () => {
    const optionsJs = fs.readFileSync(path.join(repoRoot, 'extension', 'options.js'), 'utf8');
    const optionsHtml = fs.readFileSync(path.join(repoRoot, 'extension', 'options.html'), 'utf8');
    const popupJs = fs.readFileSync(path.join(repoRoot, 'extension', 'popup.js'), 'utf8');
    const popupHtml = fs.readFileSync(path.join(repoRoot, 'extension', 'popup.html'), 'utf8');
    assert.match(optionsHtml, /id="onboardingCard"/);
    assert.doesNotMatch(optionsHtml, /id="onboardingCard"[^>]*hidden/);
    assert.doesNotMatch(optionsHtml, /id="firstRunCard"/);
    assert.match(optionsHtml, /<h2>How this works<\/h2>/);
    assert.doesNotMatch(optionsJs, /firstRunCard/);
    assert.match(optionsHtml, /id="bridgeEnabled"[^>]*checked/);
    assert.match(popupHtml, /id="bridgeEnabled"[^>]*checked/);
    assert.match(optionsJs, /let settingsHydrated = false/);
    assert.match(popupJs, /let settingsHydrated = false/);
    // The previous fix awaited refresh() before reading the checkbox. That
    // painted stored false over a click the user already made, then Save wrote
    // false and killed the scanner. Save must merge with stored config instead.
    assert.doesNotMatch(optionsJs, /if \(!settingsHydrated\) \{\s*await refresh\(\);/);
    assert.doesNotMatch(popupJs, /if \(!settingsHydrated\) \{\s*await refreshState\(\);/);
    assert.match(optionsJs, /typedKey \|\| stored\.sharedKey/);
    assert.match(popupJs, /typedKey \|\| stored\.sharedKey/);
    assert.match(optionsJs, /settingsHydrated\s*\n\s*\? el\('bridgeEnabled'\)\.checked\s*\n\s*: stored\.bridgeEnabled !== false/);
    assert.match(popupJs, /settingsHydrated\s*\n\s*\? el\('bridgeEnabled'\)\.checked\s*\n\s*: stored\.bridgeEnabled !== false/);
    const sharedJs = fs.readFileSync(path.join(repoRoot, 'extension', 'shared.js'), 'utf8');
    assert.match(sharedJs, /if \(!String\(next\.sharedKey \|\| ''\)\.trim\(\)\) \{\s*next\.sharedKey = existing\.sharedKey;/);
  });
});

# Umbra Distribution Plan

Turning Umbra from a private tool into a public Chrome Web Store extension plus a public npm companion server, without losing a single capability and without shipping anything that identifies its author.

Baseline on 2026-08-20: `cd mcp-server && npm test` passes 131 tests across 15 suites. `~/.cargo/bin/cargo test --manifest-path rust-broker/Cargo.toml` passes 10 tests with 1 ignored live-socket test. Every acceptance proof below assumes those two commands stay green.

---

## How to read this plan

**File ownership is global across Phases A, B, and C.** Every source file belongs to exactly one implementation unit for the whole span of those three phases. Two units never edit the same file, so units inside a phase run fully in parallel and units across phases never collide on a merge.

That rule has one consequence worth stating plainly: when a Phase B or Phase C goal needs a change inside a file that a Phase A unit owns, the change is listed inside the owning Phase A unit and tagged with the phase it serves. The clearest case is `extension/background.js`. It is 5,797 lines, eleven findings land in it, and the Ahrefs carve-out that Phase B depends on has to happen there. All of it belongs to unit A1.

**A1 is the critical path.** It carries the largest share of the work and the two changes other units build on (the Ahrefs recipe carve-out and the content-agent injection fix). Start A1 first, give it the strongest implementer, and let its items land as separate commits inside the unit.

**Every unit lists three things**: the files it owns, the findings it fixes with file and line, and an acceptance proof that is a command or an observable result. A unit is not done until its proof runs clean and the two baseline test commands still pass.

**Capability preservation is a hard gate.** Nothing in this plan removes a tool, a page action, or an argument. The Ahrefs work moves code and changes how it is packaged; it never deletes the capability. Robert's install keeps everything because he runs the extension unpacked from this repo and the server from this checkout, both of which include the files the public packages exclude.

---

## Phase A: Core hardening

Performance, resilience, and correctness fixes on the shared codebase. These land before any packaging work so the public build and the private install inherit the same hardened core.

### Unit A0: Shared config and package manifests

**Files owned**
- `mcp-server/config.js` (new)
- `mcp-server/timeouts.js` (new)
- `mcp-server/package.json`
- `package.json`
- `tests/mcp/config.test.mjs` (new)

**Work**

Create `mcp-server/config.js` exporting `resolveDownloadDir()`, `resolveBrokerSocketPath()`, `resolveLaunchdLabel()`, and `resolveSharedKeyPath()`. Each reads its environment variable first and falls back to a portable value derived from `os.homedir()`. `resolveDownloadDir()` returns `process.env.UMBRA_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads')`, which is Chrome's stock macOS and Linux default. `resolveBrokerSocketPath()` returns `process.env.UMBRA_BROKER_SOCKET || path.join(os.homedir(), '.umbra', 'run', 'broker.sock')`, moving the socket off world-writable `/tmp`. `resolveLaunchdLabel()` returns `process.env.UMBRA_BROKER_LAUNCHD_LABEL || 'dev.umbra.broker'`.

Create `mcp-server/timeouts.js` holding `resolveBrokerRequestTimeoutMs` (moved from `mcp-server/rust-broker-client.js:20`) plus a new `resolveChildCallTimeoutMs(remainingMs, requestedMs)` that returns the smaller of the two and never returns a value below 1,000 ms. The existing helper uses `Math.max(floor, ...)` at `mcp-server/rust-broker-client.js:26`, which means a caller can never lower a per-call timeout below the 60,000 ms floor. The batch fixes in units A5 and A6 need a helper that clamps downward, so they get a separate function rather than a change in meaning to the existing one.

In `mcp-server/package.json`, register the new test files from every Phase A unit in the `test` script up front, so units can land in any order without touching this file again. `node --test ../tests` fails on this tree, so keep the explicit file list.

Tagged Phase B and Phase C, in this same file because no other unit may edit it: drop `"private": true`, rename to a scoped public package name, add a `files` allowlist covering only `index.js`, `cli.js`, `tools.js`, `bridge-core.js`, `rust-broker-client.js`, `timeouts.js`, `config.js`, `auth.js`, `session-registry.js`, `tab-ownership.js`, `batch-refs.js`, `download-ledger.mjs`, `ensure-rust-broker.mjs`, `check-rust-broker.mjs`, and `launch-mcp.sh`, and add `"bin": { "umbra": "./cli.js" }`. The allowlist deliberately omits `ahrefs-export.js`, which is what makes the Ahrefs orchestration a local-only plugin in the published package. It also omits every development harness script, which is what keeps the client-specific ones from ever reaching npm.

**Findings addressed**
- `mcp-server/bridge-core.js:14`, `mcp-server/rust-broker-client.js:16`, `mcp-server/ahrefs-export.js:556`: three copies of `'/Users/RobertLora/Documents/Downloads'` as the shipped default, which both leaks a home path and points every other user at a directory that does not exist. This unit supplies the replacement; the owning units perform their own one-line swap.
- `rust-broker/src/broker.rs:22` and the five JavaScript sites that mirror it: `/tmp/umbra-rust-broker.sock` sits in a world-writable directory where another local account can pre-create the path and block startup.
- `mcp-server/ensure-rust-broker.mjs:16`: the launchd label `'com.robertlora.umbra-broker'` is the author's surname as a shipped code default.
- `mcp-server/package.json:4`: `"private": true` with no `bin` and no `files` allowlist means there is no npx companion and publishing as-is would ship the client-specific one-off scripts sitting in the same folder.

**Acceptance proof**

`cd mcp-server && node --test ../tests/mcp/config.test.mjs` passes, asserting that each resolver honours its environment variable, that the unset fallback contains no literal `/Users/`, and that `resolveChildCallTimeoutMs(3000, 60000)` returns 3000 rather than 60000. Then `npm pack --dry-run` from `mcp-server/` lists exactly the allowlisted files and does not list `ahrefs-export.js` or any `capture-`, `export-`, `benchmark-`, or `smoke` script.

---

### Unit A1: Extension service worker

**Files owned**
- `extension/background.js`
- `extension/recipes/ahrefs-actions.js` (new)
- `tests/extension/background-lifecycle.test.mjs`
- `tests/extension/safety-contract.test.mjs`
- `tests/mcp/javascript-tool.test.mjs`
- `tests/extension/navigation-and-refs.test.mjs` (new)

**Work, in the order it should land**

**1. Session store boot race.** `handleBridgeCommand` at `extension/background.js:4877` calls `sessionStore.markConnected` at `:4879` and `await sessionStore.persist()` at `:4881` as its first act, with no await on `initialize()`. The only `sessionStore.load()` is at `:5770`, sitting behind three storage round trips inside a fire-and-forget `void initialize('worker_boot')` at `:5797`. On a message-woken worker the persist lands before the load, writing an empty map over `chrome.storage.session`, and the load then reads back the wiped state. The `bridge_session_disconnected` handler at `:5689` is worse, because it persists unconditionally and so wipes every session's tabs, not just the caller's. Introduce a module-level `const sessionStoreReady = sessionStore.load()` that is never nulled, have `initialize()` await that same promise instead of calling `load()` itself, and await it as the first statement of the `chrome.runtime.onMessage` handler at `:5678` so it covers `bridge_command`, `bridge_session_connected`, and `bridge_session_disconnected`. Do not await all of `initialize()` there, because that would put `ensureOffscreenDocument()` on the critical path of every command.

**2. Alarm reload race.** `initialize()` at `:5755` runs its whole body on every one-minute wake alarm at `:5779`, and `sessionStore.load()` at `:5770` replaces `this.sessions` wholesale. Any claim made by an in-flight command is discarded, which is how a tab created by `browser_create_tab` at `:1033` ends up in Chrome, inside the session's tab group, and owned by nobody. Guard the load behind a module-scope `loaded` flag so the alarm only ensures the offscreen document and the wake alarm. Keep `ensureOffscreenDocument()` unguarded, because resurrecting a dead offscreen document is the alarm's entire purpose.

**3. Content agent re-injection.** `ensureContentAgent` at `:1674` calls `chrome.scripting.executeScript({ files: [AX_TREE_SCRIPT] })` at `:1678` on every content-agent command. Combined with the unguarded IIFE in `extension/ax-tree.js`, that resets the shared element ref store before every command, so every ref-based tool fails with a stale ref. Delete the executeScript call and the unanswered `agent_probe` postMessage at `:1682`, and replace the liveness signal they provided with an invalidate-and-retry-once in the postMessage catch at `:1726`. Without that replacement, a dead-but-not-yet-disconnected port throws "Attempting to use a disconnected port object", which matches no pattern in `useOneShotContentFallback` at `:1734` and surfaces raw. This change pairs with the version guard in unit A2; neither half is sufficient alone.

**4. Navigation redirects.** `waitForTabComplete` at `:381` resolves only when `tabUrlMatchesExpected` at `:359` reports an href-identical match, in both the interval poll at `:407` and the onUpdated listener at `:421`. Any http to https upgrade, added tracking parameter, login bounce, or path normalization therefore burns the full 45,000 ms default and returns `loadTimedOut`. `browser_navigate_wait_read` is worse: its navigate child at `mcp-server/bridge-core.js:490` passes no timeout, so the navigate burns 45 seconds against a 30,000 ms batch budget and the composite returns `batch_timeout` with no page content at all. Capture the pre-navigation URL from the `existing` read at `:382` and resolve on `status === 'complete' && (tabUrlMatchesExpected(tab.url, expectedUrl) || tab.url !== preNavUrl)` in both paths. Keep a URL condition, because `chrome.tabs.update` at `:5024` resolves before the tab leaves `complete` on the old document and the extension holds no `webNavigation` permission to observe a commit. While in here, fix the pre-check at `:383` so re-navigating to the URL a tab already sits on waits for the new load instead of returning pre-navigation state.

**5. Debugger lifecycle.** `withOwnedTabDebugger` at `:1452` swallows "already attached" at `:1465` without distinguishing "this extension already attached" from "DevTools is attached". With DevTools open on a tab, `attached` stays false, `fn(target)` runs anyway, and every `chrome.debugger.sendCommand` fails. Two concurrent Umbra calls on one tab produce the same failure through a different route, because the first call's `finally` at `:1471` detaches while the second is still issuing commands. Replace the boolean with a module-level `Map<tabId, { refCount, attachPromise }>`, detach only when the count reaches zero, add a `chrome.debugger.onDetach` listener so a user dismissing the debugging banner clears the cache, and raise a coded `debugger_busy` error when the attach failure was a foreign client rather than our own.

**6. Debugger fallback guard.** `executeJavascriptWithWorldFallback` at `:1861` tests `error.code` against `/debugger/i`, but the only code matching that pattern is `debugger_unavailable`, set at `:1454` solely when `chrome.debugger` is absent. Since `debugger` is a required permission in the manifest, that never happens, so the MAIN and ISOLATED fallback at `:1863` is unreachable and `browser_javascript` hard-fails on any tab with DevTools open. Widen the test to accept the new `debugger_busy` code and any uncoded error, and explicitly exclude `error.code === 'javascript_error'` (set at `:1854` from `exceptionDetails.text`) so a page exception whose text contains the word "debugger" is never re-run in a second world. Re-running caller code means double form submits.

**7. Remote code policy.** `executeJavascriptInPage` at `:2692` builds `Object.getPrototypeOf(async function(){}).constructor` and calls `new AsyncFunction(String(code || ''))()`. That idiom is a catalogued eval-evasion pattern that Chrome Web Store scanners flag on presence, and it contradicts the `script-src 'self'` CSP the manifest already declares at `extension/manifest.json:35`. Because item 6 makes the fallback reachable only through explicit codes, and because `chrome.debugger` is always present on a normal install, delete the constructor and let the debugger path be the only route for caller-supplied code. Do not add the `userScripts` permission: it buys nothing here and requires the user to enable Developer Mode on Chrome below 138.

**8. Screenshot base64.** `encodeCanvasDataUrl` at `:4634` builds the base64 payload with a per-byte string append loop at `:4641` to `:4644`. Measured on 10 MB in the same V8: 389 ms for the current loop against 54 ms for chunked `String.fromCharCode.apply` over 32,768-byte windows joined once, with byte-identical output. A full-page stitch can reach a 2880 by 32000 canvas because `stitchScreenshotSlices` at `:4783` multiplies by device pixel ratio against `FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX = 16_000` at `:17`. Ship the chunked encoder. Do not flip the fullPage format default to jpeg: `mcp-server/tools.js:299` documents png, and `mcp-server/index.js:55` writes bytes to the caller's `outputPath` verbatim with no rename, so a caller asking for `shot.png` would receive JPEG bytes in a `.png` file. While in this function, collapse the pointless base64 round trip: `captureOnce` at `:4669` wraps raw CDP base64 into a data URL, `dataUrlToBlob` at `:4723` immediately strips it back off once per slice, and `stripScreenshotDataUrl` at `:1568` strips the prefix a third time at the return on `:5165`.

**9. Page content duplication.** `browser_get_page_content` returns `bodyText` at `:2428` and `content` at `:2430`, byte-identical whenever `includeImages` is false, which is the default set at `:5186`. The html branch at `:2407` returns `html` and `content` holding the same string on 100 percent of html reads. Return `content` alone, and add `bodyText` only when `rawContent !== rawBodyText`. The only consumers anywhere are `mcp-server/ahrefs-export.js:306` and `:475`, both of which already fall through to `content`. Give `maxChars` a real default in place of the `0 = unbounded` fallback at `:2292` to `:2295`, because nothing downstream bounds it: the Rust broker frames responses with an unbounded `BufReader::lines()` at `rust-broker/src/runtime.rs:799`.

**10. Technical snapshot.** `getTechnicalSnapshot` builds `linkData` at `:3681` reading `link.innerText` at `:3691` for every anchor, and heading text at `:3676` for every heading, while only the first 80 of each survive at `:3764` and `:3771`. Measured on a 6,567-anchor page, the full innerText pass costs 25.2 ms against 0.1 ms for a text read limited to 80. The full href, rel, and level pass must stay, because `links.internal` at `:3768`, `links.nofollow` at `:3770`, and `headings.counts` at `:3760` need every element. Keep the full pass and read text only for the first 80 entries. The larger win in the same function is at `:3733` and `:3742`, where `document.documentElement.outerHTML` is serialized twice when `includeHtml` is true and once even when it is false just to read a length; serialize once into a local and read `.length` off it.

**11. JavaScript round trip.** `executeJavascriptViaAgent` at `:1888` always sends `pageWorld: true` at `:1896`, and `extension/content-agent.js:879` returns without executing anything, so `:1904` always routes to the debugger path. The wasted round trip carries the whole code string and, through `ensureContentAgent`, a 24,654-byte script injection. Call `executeJavascriptWithWorldFallback` directly and read the agent version from the local `contentAgents` record so the `contentAgent.version` field in the response survives.

**12. Interactive ref resolution.** `resolveInteractiveRef` at `:4000` indexes `document.querySelectorAll(current.selector)[parsed.index]` with an index that `readInteractive` produced after `.filter(isVisible)` at `:2510`, so any hidden element earlier in document order shifts the result and the `!element` guard at `:4001` almost never fires. `browser_screenshot` reaches this through `executeInTab(tab.id, scrollInteractiveRef, ...)` at `:5081` on every ref-based capture, which means the crop region belongs to the wrong element. Route `browser_screenshot` ref resolution through `sendContentAgentCommand(tab.id, 'scroll_interactive_ref', ...)` exactly as `browser_scroll` already does at `:5440`, and fix the visibility filter in the one-shot fallback so it stays correct as a fallback.

**13. Author identity in a user-facing string.** `assertWindowOwnedExclusively` at `:1290` throws `'Window has mixed/unowned tabs. Resize is refused so Robert\'s everyday Chrome window is not changed.'` That message reaches every user through `serializeError` at `:77`. Rewrite it to say "your everyday Chrome window". Note the exact literal uses a slash in "mixed/unowned".

**14. Vendor identifiers.** `BRIDGE_WAKE_ALARM_NAME = 'codex_bridge_wake'` at `:7` and `'__codexChromeBridgePageConsole'` at `:4365` carry an unrelated vendor's product name into a submitted package, along with roughly ten reads of `__codexChromeBridgeContentAgent` at `:1963`, `:2001`, `:2033`, `:2442`, and `:3992`. Rename to `umbra_bridge_wake` and `__umbraPageConsole`. The matching agent-side keys live in unit A3 and must be renamed in the same phase.

**15. Offscreen document creation, tagged Phase C.** `chrome.offscreen.createDocument` at `:264` declares `reasons: ['DOM_SCRAPING']` while `extension/offscreen.js` never embeds an iframe or scrapes a DOM. No enum value covers a raw WebSocket, and moving the connection loop into a worker would put a postMessage relay on the round trip of every tool call, which is the opposite of the speed goal. Leave the enum and add a code comment at `:266` recording that no Reason value fits a loopback WebSocket and that the justification string is the accurate description. Also gate the call: read the config first and only create the document when `bridgeEnabled` and `sharedKey` are both set. A default install currently runs a permanently resident offscreen document whose two-second tick keeps the service worker pinned and writes to `chrome.storage.local` every two seconds while doing nothing. Apply the same gate to `restartOffscreenDocument` at `:336`, which is reached from `bridge_save_config` at `:5706` and currently recreates the document even when the user just unchecked the enable toggle, and add a `chrome.storage.onChanged` handler that calls `chrome.offscreen.closeDocument()` when the key is cleared.

**16. First run, tagged Phase C.** `chrome.runtime.onInstalled` at `:5789` only calls `initialize()`. A Web Store install lands on a popup reading "Set a shared key to enable local bridge pairing" with no explanation of what a shared key is. Branch on `reason === 'install'` and call `chrome.runtime.openOptionsPage()`. The options page itself is unit C2.

**17. Ahrefs carve-out, tagged Phase B.** Roughly 720 lines inside `runPageAction` are Ahrefs-only, running from `fireReact` at `:2925` through the end of the `ahrefs_export_csv` branch at `:3643`, including `openTableExport` at `:3141`, `selectSheetsRadio` at `:3175`, `includeTop10` at `:3210`, `updateIfEmpty` at `:3234`, `unhideColumns` at `:3247`, `pasteKeywords` at `:3294`, `submitTableExport` at `:3369`, and `exportPositionHistory` at `:3406`. Move them into `extension/recipes/ahrefs-actions.js`, which sets `globalThis.__umbraPageRecipes = { ahrefs: { ... } }`. The mechanism matters: `runPageAction` is passed as the `func` argument to `chrome.scripting.executeScript` through `executeInTabWithRetry` at `:5302`, so Chrome stringifies it and free identifiers resolve in the injected world, not the service worker. A module import cannot work. Inject the recipe file with `chrome.scripting.executeScript({ target: { tabId }, files: ['recipes/ahrefs-actions.js'] })` before the call, which lands in the default ISOLATED world, the same world `executeInTab` at `:1269` uses when no world option is passed. Have the ten `ahrefs_*` dispatch branches at `:3507` through `:3543` read `globalThis.__umbraPageRecipes?.ahrefs?.[action]` and throw a clear "page recipe not installed in this build" error when the file is absent, because the public store package will not contain it.

**Findings addressed**

Each numbered item above states its own finding inline. The roll-up, in the order the items appear:

- `extension/background.js:4879`: the first bridge command after a worker restart persists an empty session map before `load()` runs, permanently orphaning every owned tab.
- `extension/background.js:5770`: `sessionStore.load()` runs on every one-minute wake alarm and replaces the session map wholesale, discarding any claim an in-flight command just made.
- `extension/background.js:1678`: every content-agent command re-injects `ax-tree.js`, which resets the shared ref store and breaks every ref-based tool.
- `extension/background.js:359`: navigation waits resolve only on an href-identical URL, so any redirect burns the full 45-second timeout and returns `loadTimedOut`.
- `extension/background.js:1459`: `withOwnedTabDebugger` has no refcount, so a concurrent call or an open DevTools window detaches out from under an in-flight command.
- `extension/background.js:1861`: the debugger fallback tests a code that is never set on a normal install, so `browser_javascript` hard-fails instead of falling back.
- `extension/background.js:2692`: an `AsyncFunction` constructor compiles caller-supplied code outside the two APIs Google sanctions for it.
- `extension/background.js:4640`: full-page screenshots base64-encode through a per-byte string append loop, measured at 389 ms per 10 MB against 54 ms chunked.
- `extension/background.js:2428`: `browser_get_page_content` returns the page text twice, and `maxChars` defaults to unbounded.
- `extension/background.js:3680`: the technical snapshot reads `innerText` for every anchor and heading while only the first 80 of each survive, and serializes `outerHTML` twice.
- `extension/background.js:1896`: every `browser_javascript` call pays a content-agent round trip and a 24 KB script injection that execute nothing.
- `extension/background.js:4000`: the one-shot ref resolver indexes an unfiltered node list with an index produced from a visibility-filtered one, so `browser_screenshot` crops the wrong element.
- `extension/background.js:1290`: the author's first name ships in a user-facing error string.
- `extension/background.js:7` and `:4365`: an unrelated vendor's product name in shipped identifiers.
- `extension/background.js:266`: the offscreen document declares `DOM_SCRAPING` while holding a WebSocket, and it is created unconditionally so a keyless install runs a permanently resident document.
- `extension/background.js:5789`: `onInstalled` opens nothing, so a store install lands on a form demanding a key it never explains.
- `extension/background.js:2925` through `:3643`: roughly 720 lines of Ahrefs-only DOM automation welded into `runPageAction`, which needs a packaging boundary rather than a deletion.

**Acceptance proof**

`cd mcp-server && npm test` stays at 131 passing with the existing `tests/extension/background-lifecycle.test.mjs`, `tests/extension/safety-contract.test.mjs`, and `tests/mcp/javascript-tool.test.mjs` green after their assertions are updated for the renamed identifiers. New `tests/extension/navigation-and-refs.test.mjs` asserts: `waitForTabComplete` resolves on a URL that differs from both the expected and the pre-navigation URL; `handleBridgeCommand` awaits a ready promise before its first `sessionStore` call; the healthy branch of `ensureContentAgent` contains no `executeScript`; `getTechnicalSnapshot` serializes `outerHTML` at most once; `browser_get_page_content` never emits `bodyText` and `content` together on an `includeImages: false` read; the file contains no `AsyncFunction`; the file contains no case-insensitive match for `robert`; and the `ahrefs_` dispatch branches reference `__umbraPageRecipes`.

Live proof, run against the loaded unpacked extension: `browser_read_interactive` followed by `browser_click` with a returned ref on a static page clicks the element instead of returning "Stale element ref". `browser_navigate` to a bare `http://` URL that upgrades to https returns in under two seconds with `loadTimedOut` absent. `browser_screenshot` with a `ref` on a page holding hidden buttons crops the element that was reported.

---

### Unit A2: Accessibility tree walker

**Files owned**
- `extension/ax-tree.js`
- `tests/extension/ax-tree.test.mjs`

**Work**

Add a version constant to the `api` object built at `extension/ax-tree.js:840` and guard the file with `if (globalThis.UmbraAxTree?.version === AX_TREE_VERSION) return globalThis.UmbraAxTree;` before the IIFE body runs. A bare truthiness guard is too blunt for a public extension, because it would pin stale helper code in any live isolated world until that page navigates, which breaks `browser_reload_extension`. `extension/content-agent.js:9` already uses this guard shape, so this matches house style.

Delete the `text` property at `:599`. It runs `normalize()` over the full `innerText` of every visited element, which means a full whitespace-collapsing regex pass over the entire page text at the walk root, and the value is read nowhere. `shouldIncludeAxNode` at `:261` reads only role, tag, attrs, and name; the axNode literal at `:606` has no text field.

Note the consequence and decide it deliberately: `scoreFindMatch` at `:444` scores `node?.text || node?.description`, and `rankFindMatches` at `:479` is fed the axNodes that carry neither field, so the text term in `browser_find` ranking is permanently the empty string today. `accessibleName` at `:278` already uses inner text as its fifth fallback, so for any element without an aria-label, aria-labelledby, associated label, or alt, `node.name` already is the truncated inner text. Delete the dead field, leave ranking on name, role, and tag, and record the decision in a comment at `:444`.

Move `elementValue` at `:595`, `elementChecked` at `:596`, `elementDisabled` at `:597`, and `elementRect` at `:598` inside the `if (include)` block at `:604` so excluded elements never pay them. `elementDisabled` calls `element.closest('[disabled], [aria-disabled="true"]')` at `:368`, which is O(depth) per element. Collapse the double rect read by having `hasBox` at `:412` consume `candidate.rect` instead of calling `getBoundingClientRect` a second time on an element `:598` already measured. Hoist `document.querySelectorAll('label[for]')` into one map per walk in place of the per-element `document.querySelector` at `:306`.

For filters `interactive` and `landmarks`, run the role tests on tag and attributes before calling `computeAccessibleName` at `:589`, so the name is computed only for survivors. Leave the `all` filter computing the name up front: inclusion for that filter terminates at `:275` on `Boolean(normalize(node.name))`, so gating the name computation there would change which nodes `browser_find` returns.

Do not swap `element.innerText` at `:325` for `textContent`. That is a behaviour change, not an optimization: innerText excludes `display: none` subtrees, and textContent would pull hidden menu, tooltip, and screen-reader-only text into accessible names that agents match against.

**Findings addressed**
- `extension/ax-tree.js:1` and `:861`: the unguarded IIFE builds a fresh `sharedRefStore` at `:505` and reassigns `globalThis.UmbraAxTree` at `:861` on every injection, so a ref minted seconds earlier fails at `:551` with `stale_interactive_ref`.
- `extension/ax-tree.js:599`: `element.innerText` is read a second time per element and discarded, on top of the read `computeAccessibleName` already performs at `:325`.
- `extension/ax-tree.js:584`: every surviving element pays value, checked, disabled, rect, and a `label[for]` query before `shouldIncludeAxNode` at `:601` decides whether to keep it, and `hasBox` at `:602` measures the same element twice.

**Acceptance proof**

`cd mcp-server && node --test ../tests/extension/ax-tree.test.mjs` passes with a new case that loads `extension/ax-tree.js` twice into one `node:vm` context and asserts `getSharedRefStore()` returns the same object, `store.domVersion` is unchanged, and a ref minted before the second load still resolves. Existing cases at `:252` through `:327` stay green unmodified. A second new case asserts the walked node objects contain no `text` key.

---

### Unit A3: Content agent

**Files owned**
- `extension/content-agent.js`
- `tests/extension/content-agent-payload.test.mjs` (new)

**Work**

Delete the duplicated payload fields. `extension/content-agent.js:274` returns `html` and `:275` returns `content` holding the same `html.value` on every html read. `:288` returns `bodyText` and `:290` returns `content`, which are byte-identical whenever `includeImages` is false, because `collectRenderedImages` returns empty at `:247`, so `renderedImageSummary` is empty at `:248` and `rawContent === rawBodyText` at `:280`. This is the primary read path: `readPageContentViaAgent` at `extension/background.js:1759` tries the content agent first and only falls back to the in-page function. Return `content` alone and emit `bodyText` only when the two genuinely differ. `renderedImageSummary` is carried a third time in `base` at `:258` alongside its copy inside `content`; drop the standalone copy.

Give `maxChars` a real default at `:224` in place of `0 = unbounded`.

Delete `new AsyncFunction(String(code || ''))()` at `:935` to `:937` along with the now-orphaned timer and `jsonSafe` scaffolding inside `executeJavascript`. This code is unreachable: the only sender is `extension/background.js:1893`, which hardcodes `pageWorld: true`, and `:878` short-circuits on that flag before touching `code`. Keep the pageWorld short-circuit at `:878` to `:887` intact. Deleting unreachable code loses no capability, which matters because the store goal forbids capability loss.

Loosen the stale-ref short-circuit at `:449`. Today `if (resolved.code === 'stale_interactive_ref' || ...) return resolved;` means the working index-based fallback at `:451` through `:476` is never reached when the ax store has been reset. With unit A2's guard in place the reset stops happening, but the fallback should still be reachable so a genuine DOM mutation does not lose the ref outright.

Rename `AGENT_KEY = '__codexChromeBridgeContentAgent'` at `:2` and `CONSOLE_STORE_KEY = '__codexChromeBridgeConsole'` at `:3` to `__umbraContentAgent` and `__umbraConsole`, matching the background-side rename in unit A1.

**Constraint**: keep `tests/extension/safety-contract.test.mjs` and `tests/mcp/javascript-tool.test.mjs` green without editing them, since unit A1 owns both. Their agent-side assertions are `assert.match(agent, /execute_javascript/)`, `assert.match(agent, /async function executeJavascript/)`, `assert.doesNotMatch(agent, /eval\(|new Function/)`, and a `doesNotMatch` against sensitive browser APIs. All four survive this work, because `/new Function/` does not match `new AsyncFunction`.

**Findings addressed**
- `extension/content-agent.js:274` and `:288`: the page payload is emitted twice on the primary read path, which then crosses the JSON-RPC frame twice more because `mcp-server/index.js:99` serializes into `content[0].text` and `:106` attaches `structuredContent`.
- `extension/content-agent.js:935`: an `AsyncFunction` constructor in a submitted package, which reads as remotely hosted code execution outside the two APIs Google sanctions for it.
- `extension/content-agent.js:224`: `maxChars` defaults to unbounded, contradicting the schema text at `mcp-server/tools.js:320` and leaving one runaway page able to buffer an unbounded single line in the broker.
- `extension/content-agent.js:449`: the index-based fallback is unreachable for the exact error code both ref-reset paths produce.

**Acceptance proof**

`cd mcp-server && node --test ../tests/extension/content-agent-payload.test.mjs` passes, asserting the source contains no `AsyncFunction`, that the text branch emits `bodyText` only inside a conditional, that the html branch emits one of `html` or `content` rather than both, and that `maxChars` resolves to a finite default. Then `cd mcp-server && npm test` shows 131 passing with `tests/extension/safety-contract.test.mjs` and `tests/mcp/javascript-tool.test.mjs` unmodified.

---

### Unit A4: Offscreen scanner and session store

**Files owned**
- `extension/offscreen.js`
- `extension/session-state.js`
- `tests/extension/session-state.test.mjs`
- `tests/extension/offscreen-lifecycle.test.mjs` (new)

**Work**

Add a `loaded` flag to `SessionStateStore` and have `persist()` at `extension/session-state.js:44` refuse to write before a successful `load()`. This is the backstop for the boot race unit A1 fixes at the call site; roughly twenty `persist()` call sites exist in `extension/background.js`, and a flag makes it impossible for any of them to write an empty map over stored state.

Implement an application-level keepalive in `extension/offscreen.js`. `closeExpiredConnection` at `:140` reaps only CONNECTING past four seconds, unauthenticated OPEN past six seconds, and CLOSING or CLOSED. An authenticated socket that is OPEN but dead is never reaped, and `resyncConnections` at `:245` skips redialing any port whose socket is OPEN, so the dead socket blocks its own replacement forever. `state.lastMessageAt` is declared at `:289` and written at `:311` and read nowhere. Send `{ type: 'ping' }` every fifteen seconds and `destroyConnection` when `now - lastMessageAt` exceeds forty-five seconds.

Order matters and getting it wrong destroys healthy sessions. Browser JavaScript cannot send WebSocket protocol pings and never surfaces pong frames to a message listener, so a server-side ping cannot advance `lastMessageAt`. The application-level `ping` and `pong` handlers in `mcp-server/bridge-core.js` (unit A6) and `rust-broker/src/runtime.rs` (unit A7) must land before the teardown timer here, because both servers currently drop any message whose type they do not recognise. Land the ping sender and the `lastMessageAt` read in the same commit, gated behind a check that a pong was ever received on that socket, so an older server on the other end degrades to today's behaviour rather than a forty-five-second disconnect loop.

Change `publishStatus({ force: true })` at `:220` to `publishStatus()`. The `force` flag bypasses the `STATUS_UPDATE_MIN_INTERVAL_MS` throttle declared at `:6` and applied at `:108` to `:113`, so the unconfigured idle branch writes to `chrome.storage.local` every two seconds forever.

Drop the network-switch justification from any comment or doc text. Both endpoints are loopback (`ws://127.0.0.1:${port}` at `:273`, and `mcp-server/bridge-core.js:142` rejects anything that is not 127.0.0.1 or ::1), so a WiFi, Ethernet, or VPN change cannot break these sockets. The reachable triggers are sleep and wake, and a peer process that is alive but not servicing its socket.

**Findings addressed**
- `extension/session-state.js:44`: `persist()` is a full-map overwrite with no guard, so a cold-worker write lands before the first `load()` and silently destroys tab ownership for every session.
- `extension/offscreen.js:140`: neither side sends keepalives and neither reaps a socket that reports OPEN but is dead, so a sleep and wake wedges the session until a human clicks Reconnect in the popup, which an agent cannot do.
- `extension/offscreen.js:220`: a forced status publish on every two-second tick pins the service worker and writes storage continuously on a default install with no key configured.

**Acceptance proof**

`cd mcp-server && node --test ../tests/extension/session-state.test.mjs ../tests/extension/offscreen-lifecycle.test.mjs` passes. New session-state cases assert `persist()` is a no-op before `load()` resolves and that a post-load persist writes the full map. New offscreen cases assert the source sends a `ping` frame on an interval, reads `lastMessageAt` in a teardown condition, and calls `publishStatus` without `force` in the idle branch.

---

### Unit A5: Rust broker shim client

**Files owned**
- `mcp-server/rust-broker-client.js`
- `tests/mcp/rust-broker-client.test.mjs`

**Work**

Replace the string framing in `handleData` at `mcp-server/rust-broker-client.js:251`. Today `this.buffer += chunk` builds a V8 ConsString and `this.buffer.indexOf('\n')` flattens the whole buffer on every chunk. With `socket.setEncoding('utf8')` at `:72`, every data event over a real AF_UNIX socket on this machine is exactly 8,192 bytes, so a 9.8 MB screenshot arrives as roughly 1,200 chunks and burns 742 ms of synchronous event-loop time. Drop the `setEncoding` call, push raw Buffers into an array, scan only the newest chunk for `0x0A`, and `Buffer.concat` plus `toString('utf8')` once per complete line. Measured on the same payloads: 0.4 ms to 2.1 ms, a 98 to 99 percent reduction, and the curve flattens rather than growing quadratically.

Do not add a `searchOffset`. Measured, the offset variant saves 11 to 18 percent, because `indexOf` flattens the subject regardless of start index. It adds state and buys nothing.

Accept both Buffer and string chunks in `handleData`, because `tests/mcp/rust-broker-client.test.mjs:15` stubs `setEncoding()` as a no-op and `:30` emits a template string. Use `Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')`.

Replace the `spawnSync` at `:104` with an awaited `child_process.spawn`. `spawnSync(process.execPath, [ENSURE_BROKER_SCRIPT])` runs `mcp-server/ensure-rust-broker.mjs`, whose `waitUntilHealthy` defaults to 8,000 ms. Measured with a nonexistent socket, binary, and launchd label: 8,074 ms blocked with zero timer ticks. No timers fire, `SIGINT` and `SIGTERM` handlers registered at `mcp-server/index.js:269` cannot run, and the parent-watch interval at `:253` stalls. Worst case across the three attempts is about 25.4 seconds, and a broker that accepts the connection but never answers pushes past 33 seconds through the 1,500 ms probes at `ensure-rust-broker.mjs:115` and `:119`. Share one deadline across attempts, retry as soon as the ensure child reports healthy rather than sleeping the escalating `setTimeout(200 * (attempt + 1))` at `:108`, and restructure so the third ensure does not run at all: today the loop exits at `:110` after the last ensure without ever retrying the connect.

The mid-session path is what makes this load-bearing. `mcp-server/launch-mcp.sh:80` runs the ensure script before the server starts, so a normal cold start never reaches this code. A broker crash or restart during a session does: `sendExtensionCommand` at `:158` matches a broker error at `:170`, calls `forceReconnect` at `:173`, and retries into `ensureConnected` at `:218`.

Import `resolveDownloadDir` from `mcp-server/config.js` and delete the literal at `:16`. Import `resolveBrokerRequestTimeoutMs` and `resolveChildCallTimeoutMs` from `mcp-server/timeouts.js` and delete the local copy at `:20`, keeping a re-export so `tests/mcp/rust-broker-client.test.mjs:4` continues to import it from here. Import `resolveBrokerSocketPath` and delete the literal at `:13`.

Fix the batch budget. `sendBatch` at `:314` sets one whole-batch deadline and checks `remainingMs` only between children at `:330`, while each child gets its own full timeout at `:162`. Pass the remaining budget into the child call, filling only when the child omits a timeout and clamping only downward, using `resolveChildCallTimeoutMs` so the 60-second floor in `resolveBrokerRequestTimeoutMs` cannot silently restore the full value. In the three composites at `:429`, `:441`, and `:453`, give each child its own slice rather than handing the same `params.timeoutMs` to both the batch deadline and one child, and give the navigate child an explicit budget so it stops inheriting the extension's 45-second load default.

**Findings addressed**
- `mcp-server/rust-broker-client.js:252`: quadratic scanning and rope flattening on every response line, on the default shipped path, because `mcp-server/launch-mcp.sh:9` defaults `BROKER_MODE` to `rust` and `:101` exports `UMBRA_MCP_SHIM_MODE=rust`.
- `mcp-server/rust-broker-client.js:104`: the MCP server's event loop freezes for up to 8 seconds per attempt inside an async retry loop.
- `mcp-server/rust-broker-client.js:16` and `:13`: an author home path and a `/tmp` socket path as shipped defaults.
- `mcp-server/rust-broker-client.js:314` and `:429`: composite recipes report `batch_timeout` on the step that carries the payload after an earlier step consumed the budget.

**Acceptance proof**

`cd mcp-server && node --test ../tests/mcp/rust-broker-client.test.mjs` passes with the existing cases unmodified plus new ones asserting that `handleData` accepts a Buffer chunk, that a 5 MB single-line response parses in under 20 ms, that `connectWithEnsure` never calls `spawnSync`, and that a composite with `timeoutMs: 15000` gives its navigate child a budget strictly below 15,000 ms. A micro-benchmark script comparing the old and new framing on a 9.8 MB line, run once and recorded in the commit message, shows the reduction.

---

### Unit A6: Legacy loopback bridge

**Files owned**
- `mcp-server/bridge-core.js`
- `tests/mcp/bridge-core.test.mjs`
- `tests/mcp/bridge-hardening.test.mjs`

**Work**

Honour per-call timeouts in `sendExtensionCommand` at `mcp-server/bridge-core.js:302`. It always arms `this.requestTimeoutMs` and ignores `params.timeoutMs`, while both the Rust broker client and the Rust broker itself honour the per-call value. The concrete break: `mcp-server/ahrefs-export.js:461` issues `browser_run_page_action` with `timeoutMs: 95000` and `:452` with `65000`, and the extension legitimately waits up to 90,000 ms because `extension/background.js:3495` clamps `wait_for_text` to `Math.min(Number(params.timeoutMs) || 20_000, 90_000)`. The bridge aborts at 60,000 ms, and `ahrefs-export.js:465` catches the abort into `result.waitError` and continues against a page that never finished rendering. Import `resolveBrokerRequestTimeoutMs` from `mcp-server/timeouts.js` rather than from `mcp-server/rust-broker-client.js`, so the legacy lane does not pull `node:net` and `spawnSync` into its import graph.

Apply the same batch budget fix as unit A5: pass the remaining budget into the child at `:410`, filling only when absent and clamping only downward, and split the composite budgets at `:451`, `:487`, and `:522`. `sendNavigateWaitRead` at `:487` currently passes `params.timeoutMs` as both the batch deadline at `:519` and the wait child's own timeout at `:505`, and gives the navigate child no timeout at all at `:490`. Keep the raw `browser_batch` contract as it stands, including the assertions at `tests/mcp/bridge-hardening.test.mjs:127` that codify a caller-owned budget; the defect is the three composites reusing one number for two meanings.

Accept a `ping` frame and answer with `pong`. The post-auth path at `:217` routes every message into `registry.settleRequest`, which returns false for anything without a known pending id, so an application-level ping from the offscreen document is silently dropped today. This handler must land before unit A4 enables its teardown timer.

Fix the duplicate-connection rejection at `:147`. When a stale socket still reports OPEN, a fresh extension connection is closed with 4005 `session_already_connected` and the extension redials every two seconds forever. `mcp-server/session-registry.js:14` already closes a superseded socket with 4000 `superseded`, but that path is unreachable because `:147` returns before `setChannel` is called at `:157`. Reorder so the replacement wins. The replacement is already HMAC-gated by `validateHelloQuery` at `:105` before `handleConnection` runs, so accepting it introduces no auth gap.

Import `resolveDownloadDir` from `mcp-server/config.js` and delete the literal at `:14`.

Accept an injected `runAhrefsExport` in the constructor instead of importing it statically at `:7`, and have `exportAhrefs` at `:579` throw a clear "Ahrefs export plugin is not installed" error when the injection is absent. This is the seam that makes the export module optional in the published npm package, tagged Phase B. Robert's checkout supplies it, so nothing changes for him.

**Findings addressed**
- `mcp-server/bridge-core.js:302`: `params.timeoutMs` is ignored on this lane while both other lanes honour it, so the same tool call behaves differently depending on whether the Rust broker was available at startup.
- `mcp-server/bridge-core.js:338` and `:487`: a single whole-batch deadline checked only between children, while each child independently gets the full request timeout.
- `mcp-server/bridge-core.js:147`: a stale-but-OPEN socket makes the server reject the extension's replacement connection in an unbounded redial loop.
- `mcp-server/bridge-core.js:14`: an author home path as the shipped download directory default.

**Acceptance proof**

`cd mcp-server && node --test ../tests/mcp/bridge-core.test.mjs ../tests/mcp/bridge-hardening.test.mjs` passes with the existing overrun assertion at `tests/mcp/bridge-hardening.test.mjs:127` unchanged, plus new cases asserting that a child call with `timeoutMs: 95000` arms a 95,000 ms timer, that `sendNavigateWaitRead` gives its navigate child an explicit budget, that a `ping` frame receives a `pong`, and that a second authenticated connection supersedes the first rather than being closed with 4005.

---

### Unit A7: Rust broker crate

**Files owned**
- `rust-broker/src/runtime.rs`
- `rust-broker/src/broker.rs`
- `rust-broker/src/lib.rs`
- `rust-broker/Cargo.toml`
- `rust-broker/tests/runtime.rs`
- `rust-broker/tests/session_registry.rs`
- `rust-broker/tests/pressure.rs`

**Work**

**Extension handle generation.** `handle_extension_socket` installs the handle at `rust-broker/src/runtime.rs:748` with no check for an existing one and clears it at `:768` with `= None` regardless of which socket owns it, then `reject_all_pending` at `:1028` takes the entire pending map process-wide. When a second socket binds and the first one's exit path runs, the broker is permanently convinced no extension is connected, and every command fails `ExtensionNotConnected` at `:255`. Nothing recovers: `extension/offscreen.js:245` skips redialing any port whose socket is OPEN, and `mcp-server/rust-broker-client.js:210` only destroys the shim's own socket to the same wedged broker. The previous implementation had both guards this port dropped, at `mcp-server/bridge-core.js:220` and `:147`. Add an `AtomicU64` generation id to `ExtensionHandle` at `:38`, compare it at `:768` before clearing, gate the `detach_channel` at `:770` on the same check, and reject or displace a duplicate bind at `:748` rather than silently overwriting. The reachable trigger for a public release is two Chrome profiles with the same pasted key: the key is machine-wide from `rust-broker/src/broker.rs:316` and both profiles scan the same default port range.

**Tab gate removal.** `route_extension_command` at `:238` routes any command carrying a scalar `tabId` through `route_tab_command`, which calls `assert_owned` against a `HashMap` that is never persisted. After a broker restart, or after `browser_adopt_group` (which returns a `tabs` array at `extension/background.js:1179` that `observe_tool_result` at `:378` never observes), the first explicit-tabId command fails with a misleading `TabNotOwned` even though the extension still owns the tab. The broker's map is a non-authoritative copy of state that lives correctly elsewhere: `getOwnedTab` at `extension/background.js:882` calls `sessionStore.assertOwned`, in the process that owns the tabs, backed by `chrome.storage.session` which survives restarts. Delete the gate so everything routes through `route_session_command`, and keep the ownership map populated for status and health reporting by adding a `browser_adopt_group` arm to `observe_tool_result` that walks `result.tabs` and calls `set_active_tab` on the first entry, matching what `extension/background.js:1170` already does. Do not fold `browser_adopt_group` into the arm at `:394`: `browser_group_tabs` has its own arm at `:409` that records the group id, and the `:394` arm deliberately sets no active tab.

**Dead struct removal.** `RoutedCommand`'s `tool` and `params` fields are written and never read anywhere in the crate or its tests. `route_tab_command` at `rust-broker/src/broker.rs:233` and `route_session_command` at `:210` each deep-clone `params` and allocate a `tool` String per command for a value the caller discards at `runtime.rs:242` and `:249`. Return `RoutingTarget` instead and drop the `RoutedCommand` re-export at `lib.rs:12`. `rust-broker/tests/pressure.rs:64` asserts on `command.target.channel_id` and needs the matching update. `Cargo.toml` sets `publish = false`, so nothing external depends on the type. Treat this as a dead-code deletion, not a performance fix: `json!` at `runtime.rs:274` expands to `serde_json::to_value(&params)`, a full serializer round trip that is strictly more expensive than the clone this removes.

**Result move.** Replace `message.get("result").cloned()` at `:353` with a move. `settle_extension_message` at `:328` owns `message`, so `match message { Value::Object(mut map) => map.remove("result").unwrap_or(Value::Null), _ => Value::Null }` compiles with no borrow conflict against `message_type` at `:329` or the `message.get("error")` branch at `:355`. Measured on a 3.9 MB screenshot envelope, the clone costs 0.27 ms out of a 2.44 ms broker JSON budget, so this is not a latency fix. It matters for peak resident memory under concurrent multi-agent screenshots, and it is one line. Do not take the `RawValue` rework: it retypes `ShimResponse.result` at `:161` plus six construction sites, and it breaks `observe_tool_result`, which needs a parsed `&Value` to drive the tab-ownership invariants.

**Socket permissions and location.** `prepare_unix_socket` at `:1069` only creates the parent directory and removes a stale socket; nothing sets a mode anywhere in the crate. The live socket is currently `srwxr-xr-x` purely because of the ambient umask. A user with umask 002 or a Linux port gets a world-connectable socket, and the shim's `RegisterSession` at `:893` calls `authenticate_session(&session_id, None, ...)` at `:919` with no HMAC proof, so anyone who can connect can drive the signed-in browser. `/tmp` is also world-writable, so an unprivileged local account can pre-create the path and make `remove_file` fail under the sticky bit, which is a startup denial of service today. Call `std::fs::set_permissions(path, Permissions::from_mode(0o600))` immediately after the bind at `:190`, and change `DEFAULT_BROKER_SOCKET_PATH` at `broker.rs:22` to a per-user path under `$XDG_RUNTIME_DIR` falling back to `~/.umbra/run/broker.sock`, matching `resolveBrokerSocketPath()` in `mcp-server/config.js`.

**Keepalive.** Accept an application-level `ping` in the `handle_extension_socket` loop and answer with `pong`. Today `:329` drops anything whose type is not `result` or `error`. This must land before unit A4 enables its teardown timer.

**Findings addressed**
- `rust-broker/src/runtime.rs:768`: an old socket's exit path unconditionally clears the live extension handle, wedging every MCP session on the machine until a human clicks Reconnect.
- `rust-broker/src/runtime.rs:380`: `browser_adopt_group` returns a tabs array that is never observed, so the documented resume path fails on its first explicit-tabId call.
- `rust-broker/src/runtime.rs:239`: the tab map is in-memory only and is never rehydrated after a restart, and the resulting error does not match the reconnect pattern at `mcp-server/rust-broker-client.js:170`, so it surfaces raw.
- `rust-broker/src/runtime.rs:242` and `rust-broker/src/broker.rs:210`: `params` is deep-cloned and a `tool` String allocated per command to build a struct the caller immediately discards.
- `rust-broker/src/runtime.rs:353`: the result subtree is deep-cloned when it could be moved.
- `rust-broker/src/runtime.rs:190`: the shim socket is created with no explicit mode in a world-writable directory, and the shim registration path requires no key.

**Acceptance proof**

`~/.cargo/bin/cargo test --manifest-path rust-broker/Cargo.toml` passes with `rust-broker/tests/pressure.rs:64` updated and new cases asserting: a second extension bind does not let the first socket's teardown clear the handle; `observe_tool_result` claims every tab from a `browser_adopt_group` result and sets the first as active; and a command carrying a `tabId` the broker has never seen is forwarded to the extension rather than rejected. Then `~/.cargo/bin/cargo build --release --manifest-path rust-broker/Cargo.toml` exits 0, and `ls -l "$(node -e "import('./mcp-server/config.js').then(m=>console.log(m.resolveBrokerSocketPath()))")"` on a running broker shows mode `srw-------`.

---

### Unit A8: Broker lifecycle scripts

**Files owned**
- `mcp-server/ensure-rust-broker.mjs`
- `mcp-server/check-rust-broker.mjs`
- `mcp-server/launch-mcp.sh`
- `tests/mcp/launch-script.test.mjs`

**Work**

Import `resolveLaunchdLabel` and `resolveBrokerSocketPath` from `mcp-server/config.js` and delete the literals at `mcp-server/ensure-rust-broker.mjs:16` and `:12`, and at `mcp-server/check-rust-broker.mjs:3`. The label default becomes `dev.umbra.broker`.

Understand what the label does before changing it, because the finding as originally written overstates it: `serviceTarget()` at `ensure-rust-broker.mjs:70` is used only by `isLaunchdLoaded()` at `:74` and `kickstartLaunchd()` at `:92`, both of which read or kick an existing service. Nothing creates or bootstraps one. On a machine with no matching plist, `isLaunchdLoaded()` returns false and `main()` falls through to `spawnDetachedBroker()` at `:127`. The harm is the author's surname in shipped source, not an author-named service appearing on a stranger's machine.

Leave the `health()` framing at `ensure-rust-broker.mjs:38` alone. That socket only ever carries a `health` response from `rust-broker/src/health.rs:29`, a few hundred bytes in one chunk, and the loop exits at the first newline. The same is true at `check-rust-broker.mjs:27`. No change is needed in either.

Fix the cargo assumption in `mcp-server/launch-mcp.sh:75`. It calls bare `cargo build --quiet --release`, and cargo lives at `~/.cargo/bin/cargo`, which is not on a login PATH on this machine and will not be on most users' either. Probe `command -v cargo`, then `$HOME/.cargo/bin/cargo`, and when neither exists skip the build and fall through to the legacy bridge with a clear message rather than failing the whole launcher.

Export `UMBRA_DOWNLOAD_DIR` guidance in the launcher comments so the private setup record in unit B3 has a single place to point at.

**Findings addressed**
- `mcp-server/ensure-rust-broker.mjs:16`: the launchd label `'com.robertlora.umbra-broker'` is a hardcoded author-named default in a file that runs on every broker start.
- `mcp-server/ensure-rust-broker.mjs:12` and `mcp-server/check-rust-broker.mjs:3`: the `/tmp` socket path, which must move in lockstep with `rust-broker/src/broker.rs:22`.
- `mcp-server/launch-mcp.sh:75`: a bare `cargo` invocation that fails on any machine where cargo is installed but not on the login PATH, which is the common case.

**Acceptance proof**

`cd mcp-server && node --test ../tests/mcp/launch-script.test.mjs` passes with new cases asserting the launcher probes for cargo in more than one location and that neither `ensure-rust-broker.mjs` nor `check-rust-broker.mjs` contains a case-insensitive match for `robert` or the string `/tmp/umbra`. Then, with the broker stopped, `node mcp-server/ensure-rust-broker.mjs` starts it and `node mcp-server/check-rust-broker.mjs` exits 0 against the new socket path.

---

### Unit A9: MCP entry point

**Files owned**
- `mcp-server/index.js`
- `tests/mcp/mcp-response.test.mjs` (new)

**Work**

**Stop shipping every result twice.** `buildMcpResponse` at `mcp-server/index.js:99` serializes the result into `content[0].text` and attaches the same object again as `structuredContent` at `:106`. The compact-summary escape at `:104` shrinks only the text copy, so it saves nothing on the wire. Emit a single compact text copy and drop `structuredContent` on the generic path. This is spec-legal because zero tools declare an output schema: `grep -c outputSchema mcp-server/tools.js` returns 0, and structured content is mandatory only when a schema is declared. Do not take the inverse option of keeping `structuredContent` with a short text summary: the spec says a server returning structured content should also return the serialized JSON as a text block, so a client reading only `content` would silently receive nothing.

Handle the compact branch carefully, because the naive fix loses data. Today the compact path emits a 30-byte summary as text plus the full object as structured content, so a structured-content-aware client still receives the controls array. Emitting the summary alone would drop it. The compact branch must emit the summary and the compact-serialized object together, either as a prefix line or as `{ _compactSummary, ...result }` compact-stringified.

Drop the `|| result?.summary` fallback at `:100`. No tool anywhere returns a top-level `summary` key; only `_compactSummary` fires the path, produced at `extension/background.js:2550` and `extension/content-agent.js:433`, both from `browser_read_interactive`. The dead fallback can only ever misfire on a future result that happens to carry a `summary` field, silently replacing the whole payload with it.

Drop the two-space indent argument. On array-shaped results such as `browser_read_interactive` with 400 controls, measured pretty output is 193,230 bytes against 123,956 compact, a 1.56x saving. On page reads the indent costs 61 bytes total and is irrelevant; the doubling there comes from the payload duplication units A1 and A3 fix.

Leave both screenshot branches at `:51` through `:91` exactly as they are. `tests/mcp/tool-contract.test.mjs:177` asserts on `structuredContent` for the screenshot-with-outputPath branch.

**Mark failures as failures.** `runAhrefsExport` catches every internal failure at `mcp-server/ahrefs-export.js:605` and returns `{ ok: false }`, and `sendBatch` returns the same shape from `mcp-server/bridge-core.js:366`, `:391`, and `:428` and from `mcp-server/rust-broker-client.js` at the mirrored sites. Nothing anywhere sets `isError`: the string appears zero times in the repo. So an Ahrefs login redirect and a failed navigate-wait-read both arrive as successful tool calls, while every single-shot tool's failure arrives as an error. Add `isError: true` to the response when `result?.ok === false`. Doing it here rather than by rethrowing in `ahrefs-export.js` keeps every diagnostic field intact, needs no change to `mcp-server/export-organic-keywords.mjs:114` which does `Object.assign(result, exported)` inside a try, and fixes `browser_batch` and the three composites in the same ten lines. This server uses the low-level `Server` with `setRequestHandler`, not `McpServer.registerTool`, so a thrown error becomes a JSON-RPC protocol error rather than `isError: true`, which is why rethrowing is the wrong shape here.

**Validate the one path that writes to disk.** `path.resolve(outputPath)` at `:55` followed by `fs.mkdirSync(..., { recursive: true })` at `:56` and `fs.writeFileSync` at `:58` is the only filesystem write in the server, and the value is unvalidated. Verified in a scratch directory: `outputPath: 'shot.png'` lands in whatever working directory the MCP client launched with, `'~/Desktop/shot.png'` creates a literal directory named `~`, and `'../../../../etc/x.png'` escapes the working directory entirely. Add a `resolveOutputPath()` helper that rejects relative paths, expands a leading `~` through `os.homedir()`, and refuses a path whose resolved parent does not already exist rather than creating it recursively. Note this is not the same shape as `assertLocalUploadFile` at `mcp-server/tools.js:808`, which requires the target to exist; an output file must not.

**Stage schema validation.** The low-level SDK performs no per-tool validation: `grep -n inputSchema` in `@modelcontextprotocol/sdk@1.28.0`'s `dist/esm/server/index.js` returns nothing, and `CallToolRequestParamsSchema` types arguments as `z.record(z.string(), z.unknown())`. The handler at `:195` fetches `definition` and uses it only as an existence check. Compile the schemas once and log mismatches without rejecting, in Phase A. Enforcement is a Phase C decision, because 60-plus hand-written schemas have never been enforced and `extension/background.js:4884` coerces parameters ad hoc, so a stringified `tabId` that works today could start failing.

**Fix the SDK imports.** `:6` through `:11` import through relative paths into `./node_modules/@modelcontextprotocol/sdk/dist/esm/...`. Reproduced in a hoisted layout, the current form throws `ERR_MODULE_NOT_FOUND` while bare specifiers resolve cleanly through the package's exports map, which includes `"./*": { "import": "./dist/esm/*" }`. Change to `@modelcontextprotocol/sdk/server/index.js`, `/server/stdio.js`, and `/types.js`. Verified working in the current nested layout too, so there is no regression risk. `mcp-server/bridge-core.js:2` already uses the correct bare form for `ws`.

**Load the Ahrefs plugin optionally, tagged Phase B.** Resolve `./ahrefs-export.js` through a guarded dynamic import at startup and pass the result into whichever bridge is constructed at `:157`, and pass an `{ ahrefs: Boolean(module) }` flag into the tool-definition builder from `mcp-server/tools.js`. The published npm package omits `ahrefs-export.js` through the `files` allowlist, so the import resolves to null and the tool disappears from the list. Robert's checkout has the file, so nothing changes for him.

**Findings addressed**
- `mcp-server/index.js:99`: every non-screenshot result ships twice on one JSON-RPC message and the 30,000-byte compact fallback is defeated because the full object still travels in `structuredContent`.
- `mcp-server/index.js:99`: a batch or composite that stops on a child error resolves as a normal successful tool result with no `isError`, while the single-shot equivalent of the same failing step errors.
- `mcp-server/index.js:52`: an unvalidated `outputPath` is resolved and written by the server itself.
- `mcp-server/index.js:195`: `request.params.arguments` is dispatched with no validation against the tool's declared input schema.
- `mcp-server/index.js:6`: relative `node_modules` imports that break under npm hoisting and npx.

**Acceptance proof**

`cd mcp-server && node --test ../tests/mcp/mcp-response.test.mjs` passes, asserting: a generic result produces exactly one copy on the wire with no `structuredContent`; a result carrying `_compactSummary` over 30,000 bytes produces both the summary and the compact object; a `{ ok: false }` result sets `isError: true`; `resolveOutputPath('shot.png')` throws; `resolveOutputPath('~/Desktop/shot.png')` expands through the home directory; and the file contains no `./node_modules/` import specifier. `tests/mcp/tool-contract.test.mjs` stays green unmodified. Then `node -e "import('./mcp-server/index.js')"` from a temporary hoisted `node_modules` layout resolves without `ERR_MODULE_NOT_FOUND`.

---

### Unit A10: Ahrefs export runner and download ledger

**Files owned**
- `mcp-server/ahrefs-export.js`
- `mcp-server/download-ledger.mjs`
- `tests/extension/ahrefs-export-contract.test.mjs`
- `tests/mcp/download-ledger.test.mjs`

**Work**

**Replace the Python subprocess.** `parseDelimitedTable` at `mcp-server/ahrefs-export.js:227` shells out to the literal path `/opt/homebrew/bin/python3`, which exists only on Apple Silicon machines with Homebrew Python. On any other machine `spawnSync` returns `status: null` with undefined stdout and stderr, so the guard at `:239` throws and the fallback chain at `:240` produces the literal string "CSV parse failed: unknown python error". The download has already succeeded and the CSV is on disk at that point, but `result.destPath` and `result.sourceDownloadPath` are assigned at `:592` after the parse call at `:581`, so the caller gets a useless message and no file path. This also breaks `npm test` for every contributor, because `tests/extension/ahrefs-export-contract.test.mjs:192` and `:214` call the function directly.

Write a quote-aware CSV reader in Node, not a naive splitter. The Python uses `csv.DictReader`, which honours RFC 4180 quoting, and real Ahrefs exports contain quoted fields with embedded commas and newlines. A verified example: line 547 of `adaptivesecurity.com-organic-keywords-subdo_2026-08-20_09-06-33.csv` begins `"tactics, techniques, and procedures",US,...`. A naive line count inflates `rowCount`, which is not cosmetic: it gates the ok verdict at `:599` and is returned to the agent as evidence. Roughly thirty lines: strip the UTF-8 BOM, detect tab against comma on the first physical record, track in-quote state with doubled-quote escaping, and count parsed records rather than lines with the trailing blank line dropped. Preserve the exact output shape, including the twelve-header cap and the pipe-joined `columnLine`, because `headersMatch` at `:246` and the chart-CSV rejection at `:583` both depend on it.

Move the `result.destPath` and `result.sourceDownloadPath` assignments above the parse call so any future parse failure still returns the file location.

Import `resolveDownloadDir` from `mcp-server/config.js` and delete the inline literal at `:556`. That line is the recovery branch inside the catch around the download wait at `:547`, so today the primary wait and the fallback both point at the same nonexistent directory on any non-author machine.

Export an `isAvailable` marker so `mcp-server/index.js` can report a clean reason when the plugin is present but broken, tagged Phase B.

**Fix the ledger's silent failure.** `findNew` at `mcp-server/download-ledger.mjs:115` does `readdir(...).catch(() => [])`, which makes a missing directory indistinguishable from an empty one. `waitForNew` at `:87` therefore polls a nonexistent path for the full timeout, which is 30,000 ms for `browser_wait_for_download` and 90,000 ms for `browser_export_ahrefs`, before throwing at `:111`. Validate the directory once at construction or at wait entry with a clear "download directory not found" message naming `UMBRA_DOWNLOAD_DIR`, and leave `findNew` itself tolerant, because `mcp-server/ahrefs-export.js:557` calls it as the recovery inside a catch and a throw there would replace the original error and lose the real cause.

Scrub the absolute path from the throw messages at `:83` and `:111`. Both currently print the resolved directory back to the user, which is how the author's home path reaches every user as a runtime tool error, not just as a repo string.

**Add cross-session download attribution.** `findNew` matches on a filename substring and an mtime window with no link to the tab or session that started the download, and `waitForNew` returns `matches[0]`. Two sessions on the same domain, or a `keywords-explorer` export with more than one keyword (where `ahrefsDownloadNeedle` at `mcp-server/ahrefs-export.js:134` returns the literal string `overview`), can silently swap results. So can a file the human downloads during the 90-second wait window, because Umbra drives the person's own signed-in profile. Note the mechanism carefully before implementing: `chrome.downloads.DownloadItem` has no `tabId` field, so filtering `chrome.downloads.search` by owning tab is not implementable. The tab-linked signal is CDP `Page.downloadWillBegin`, reachable through the `debugger` permission the extension already declares and already uses per owned tab. Implement the attribution behind the existing ledger interface so it degrades to today's filename-and-mtime match when the CDP signal is unavailable, and do not add the `downloads` permission, which draws extra Web Store scrutiny for no gain here.

**Findings addressed**
- `mcp-server/ahrefs-export.js:227`: a hardcoded Apple Silicon Homebrew Python path is the only CSV validator, so the export tool reports failure on every other machine and the repo's test suite fails on a clean checkout.
- `mcp-server/ahrefs-export.js:556`: the author's home directory as the download recovery fallback.
- `mcp-server/ahrefs-export.js:592`: the file location is assigned after the parse, so a parse failure returns no path.
- `mcp-server/download-ledger.mjs:115`: a missing directory reads as "no files yet", turning a misconfiguration into a full-length timeout with no diagnosable cause.
- `mcp-server/download-ledger.mjs:83` and `:111`: the resolved absolute path is printed in user-facing errors.
- `mcp-server/download-ledger.mjs:114`: downloads are attributed by filename substring and mtime with no session link.

**Acceptance proof**

`cd mcp-server && node --test ../tests/extension/ahrefs-export-contract.test.mjs ../tests/mcp/download-ledger.test.mjs` passes with new cases asserting: the file contains no `spawnSync` and no `/opt/homebrew`; the parser returns 2 rows for a fixture containing one quoted embedded newline and 1 row for a fixture with a trailing blank line; a header containing a quoted comma parses as one column; `findNew` against a nonexistent directory raises a named error at wait entry within 500 ms rather than after the full timeout; and no throw message in either file contains a leading `/Users/`. Add the two fixtures under `tests/fixtures/`.

---

### Unit A11: Tool schemas

**Files owned**
- `mcp-server/tools.js`
- `tests/mcp/tools.test.mjs`
- `tests/mcp/tool-contract.test.mjs`
- `tests/mcp/tabs-context.test.mjs`
- `tests/extension/computer-parity.test.mjs`

**Work**

Make `maxChars` truthful at `mcp-server/tools.js:320`. It currently reads "Defaults to the extension limit", and there is no extension limit; the extension treats zero as unbounded. State the real number that units A1 and A3 install.

Add a `dir` property to `browser_wait_for_download` at `:749` and an equivalent to `browser_export_ahrefs` at `:689`. Chrome's download directory is user-configurable, the extension holds no `downloads` permission to read it, and today a caller cannot work around a wrong default per call. Environment-variable configuration alone still strands anyone who moved their download folder.

State the absolute-path requirement for `outputPath` at `:288`, matching the validation unit A9 installs.

Document the failure contract for the composites at `:640`, `:657`, and `:673` and for `browser_batch` at `:781`. None of them mentions the `ok` flag today, and `mcp-server/index.js` will now mark them with `isError`.

Replace the `travelbagexperts.com` example at `:694` with a neutral placeholder. That is the author's own site.

Convert `TOOL_DEFINITIONS` into a `buildToolDefinitions({ ahrefs })` function that omits the `browser_export_ahrefs` entry and its `MCP_LOCAL_TOOL_NAMES` membership at `:23` when the flag is false, tagged Phase B. Keep the existing `TOOL_DEFINITIONS` export as the full list so `tests/mcp/tools.test.mjs` and `tests/mcp/tool-contract.test.mjs` continue to assert against the complete surface.

Leave the ten `ahrefs_*` values in the `browser_run_page_action` enum at `:431` in place. Those actions live in the extension and the extension's own dispatch reports cleanly when the recipe file is absent, so removing them from the schema would lose capability for Robert's install without helping the public one.

**Findings addressed**
- `mcp-server/tools.js:320`: the schema description states a limit that does not exist.
- `mcp-server/tools.js:749` and `:689`: no per-call download directory override exists, so a wrong default cannot be worked around.
- `mcp-server/tools.js:288`: `outputPath` is described with no path requirement, which invites the relative and tilde paths that produce wrong results today.
- `mcp-server/tools.js:640`, `:657`, `:673`, `:781`: the composite and batch failure contract is undocumented.
- `mcp-server/tools.js:694`: the author's personal site is the schema example.

**Acceptance proof**

`cd mcp-server && node --test ../tests/mcp/tools.test.mjs ../tests/mcp/tool-contract.test.mjs ../tests/mcp/tabs-context.test.mjs ../tests/extension/computer-parity.test.mjs` passes with new cases asserting: `buildToolDefinitions({ ahrefs: false })` omits `browser_export_ahrefs` and every other tool survives; `buildToolDefinitions({ ahrefs: true })` matches `TOOL_DEFINITIONS` exactly; `browser_wait_for_download` declares a `dir` property; and the file contains no `travelbagexperts`.

---

### Phase A gate

Before Phase B starts, all of the following must hold.

`cd mcp-server && npm test` passes with no fewer than 131 tests plus every new suite. `~/.cargo/bin/cargo test --manifest-path rust-broker/Cargo.toml` passes. A live end-to-end run against the unpacked extension proves the joint fixes that no single unit can prove alone: `browser_read_interactive` then `browser_click` by ref succeeds (units A1 and A2 together); `browser_navigate_wait_read` against a redirecting URL returns page content rather than `batch_timeout` (units A1, A5, and A6 together); and `browser_get_page_content` on a 500 KB page returns a payload whose serialized size is under 60 percent of today's (units A1, A3, and A9 together).

---

## Phase B: Sanitize and externalize

Remove every trace of the author and of client work from what ships, move personal defaults behind configuration, and draw the plugin boundary. Phase A already installed the configuration mechanism and the plugin seams inside the files it owns; Phase B owns everything that exists only to be sanitized, plus the packaging boundary and the record of Robert's private values.

### Unit B1: Repository hygiene and artifact removal

**Files owned**
- `.gitignore`
- `reports/` (283 tracked files, removed)
- `extension/assets/` (6 files, removed)
- `launchd/com.robertlora.umbra-broker.plist` (removed)
- `launchd/dev.umbra.broker.plist.template` (new)
- `mcp-server/capture-bos-keyword-overviews.mjs` (removed)
- `mcp-server/capture-bos-target-sweep.mjs` (removed)
- `mcp-server/export-bos-supplier-research.mjs` (removed)
- `mcp-server/export-adaptive-keyword-changes.mjs` (removed)
- `mcp-server/demo-cic-lane.mjs` (removed)
- Git history

**Work**

`git ls-files reports/ | wc -l` returns 283 out of 415 tracked files, so 71 percent of this repository is test reports, and `.gitignore` contains only four lines with `reports/` absent. Those reports carry third-party client data, not just author paths: `reports/adaptive-keyword-changes-20260425080738/Adaptive_Security_Keyword_Changes_Export.md:5` embeds a private Google Sheet id, `reports/bos-supplier-research-20260428152925/manifest.json:5` embeds a client project path, `reports/atp-ahrefs-call-prep/summary.json:4` embeds client Ahrefs URLs, and `reports/main-social-research-retest-20260424235905/Full_Bridge_Test_Report.md:45` plus its sibling under `reports/subagent-social-research-20260424235323/` contain the author's real name and X handle scraped from a logged-in session. Move the whole tree to a local path outside the repository so Robert keeps the evidence, then remove it from tracking and add `reports/` to `.gitignore`.

Untracking is not enough. `git rev-list --count HEAD` returns 2, both commits dated today, and `reports/` is in the initial commit `361eda8`. Both commits are authored and committed by `RobertJLora <rjlora@gmail.com>`, and `.git/config` has no `[user]` section, so the identity resolves from `~/.gitconfig` and would keep leaking back in on every future commit. `git remote -v` is empty and nothing has been pushed, so the cheapest correct fix is a fresh history: set `user.name` and `user.email` in the repository's local `.git/config` first, then create an orphan commit. A filter-repo rewrite is unnecessary for two commits.

Delete `extension/assets/`. Measured, `zip -r extension` produces 4,762,373 bytes and the same tree without `assets/` produces 82,731 bytes, so those six files are 98.3 percent of the submission package and the real extension is 81 KB. Four of them are named after an unrelated vendor's product, and `extension/assets/chrome-bridge-icon-source.jpg` additionally embeds C2PA provenance metadata naming a second unrelated vendor. Nothing references any of them: grepping for `assets` across `extension/`, `scripts/`, `mcp-server/`, `docs/`, and `README.md` returns zero hits. The current icons under `extension/icons/` and the newer set under `branding/icons/` are the live artwork. Any future icon sourced from an image generator needs its metadata stripped before it enters `extension/icons/`.

Replace the launchd plist. The author's surname is in the filename, in the `Label` at line 6, and in five absolute paths at lines 9, 12, 16, 27, and 29, two of which point into `~/.claude/logs`, a directory a public installer has no reason to have. Ship `launchd/dev.umbra.broker.plist.template` with `__HOME__` placeholders, logs under `__HOME__/.umbra/logs/`, and a label matching `resolveLaunchdLabel()` in `mcp-server/config.js`. The rendered filename must match the Label, and the render step must create the log directory, because launchd fails a job whose `StandardOutPath` directory does not exist.

Delete the five client-specific scripts. `mcp-server/capture-bos-target-sweep.mjs:8`, `capture-bos-keyword-overviews.mjs:8`, and `export-bos-supplier-research.mjs:9` all hardcode a named client engagement path, and `export-adaptive-keyword-changes.mjs:22` hardcodes a client domain and a live Google Sheet URL. These are one-off job scripts, not generic tooling. Move them to Robert's own workspace rather than parameterizing them.

**Findings addressed**
- `reports/Codex_Chrome_Bridge_Full_Test_Report_2026-04-24.md:31` and 282 sibling files: client domains, client project paths, a private Sheet id, and the author's name and X handle, all in tracked files and in the initial commit.
- `.git/config`: no local identity, so every commit carries the author's personal email from the global configuration.
- `launchd/com.robertlora.umbra-broker.plist:6`: the author's surname in the service label, plus five author home paths.
- `extension/manifest.json` package scope: 4.5 MB of unreferenced source artwork carrying two unrelated vendors' names inside the submitted zip.
- `mcp-server/capture-bos-target-sweep.mjs:8` and four siblings: named client engagement paths and client domains in tracked source.

**Acceptance proof**

`git ls-files | wc -l` drops from 415 to roughly 120. `git log --format='%an <%ae> | %cn <%ce>'` shows the chosen public identity on every commit and no personal email. `git grep -il 'robert\|rjlora'` returns zero. `git ls-files reports/ extension/assets/` returns nothing, and `git check-ignore -v reports/` confirms the ignore rule. `zip -r /tmp/ext.zip extension && stat -f%z /tmp/ext.zip` reports under 200,000 bytes.

---

### Unit B2: Development harness sanitize

**Files owned**
- `mcp-server/doctor.mjs`
- `mcp-server/release-check.mjs`
- `mcp-server/reload-extension.mjs`
- `mcp-server/benchmark-performance.mjs`
- `mcp-server/full-suite-runner.mjs`
- `mcp-server/required-smoke.mjs`
- `mcp-server/export-organic-keywords.mjs`
- `mcp-server/export-click-fixture-smoke.mjs`
- `mcp-server/smoke-test.mjs`
- `mcp-server/rust-broker-smoke.mjs`
- `mcp-server/group-stress-smoke.mjs`
- `mcp-server/auth-reuse-smoke.mjs`
- `scripts/configure-extension-cdp.mjs`
- `scripts/run-automated-smoke.sh`
- `scripts/run-headless-export-click.sh`
- `scripts/launch-test-profile.sh`

**Work**

Every file here imports `resolveDownloadDir`, `resolveSharedKeyPath`, and `resolveBrokerSocketPath` from `mcp-server/config.js` in place of a hardcoded literal. Nine of them hardcode `/Users/RobertLora/.umbra/shared-key`: `benchmark-performance.mjs:19`, `export-click-fixture-smoke.mjs:16`, `export-organic-keywords.mjs:56`, `full-suite-runner.mjs:19`, `reload-extension.mjs:12`, and the rest. Four hardcode the author's Downloads path.

`mcp-server/doctor.mjs` needs the most work and matters most, because `README.md:192` points users at it as the first diagnostic. `:13` hardcodes `/Users/RobertLora/Documents/Workspaces/Projects/Active/umbra/extension`, which is both an author path and a stale one, since the canonical tree is `System/Umbra`. Resolve it from the repository root instead. `:14` hardcodes `/Users/RobertLora/Library/Application Support/Google/Chrome/Profile 12/Secure Preferences`, a named personal Chrome profile; discover the profile by scanning the platform default user data directory. `:15` pins a machine-specific legacy extension id; drop it or move it behind an environment variable. `:18` carries the `/tmp` socket path. Today, for any user other than the author, doctor reports `activeExists: false` and `chromeRegistration.found: false` on a healthy install, so it says a working setup is broken.

`mcp-server/release-check.mjs:9` repeats the same stale extension directory, so `compareExtensionDirs` reports full drift on every run.

`mcp-server/full-suite-runner.mjs:41` defaults `ahrefsTarget` to a client domain, and `:214` prints the author's download path into generated reports. `mcp-server/reload-extension.mjs:7` pins an extension id and `:110` asserts a specific version string, both of which break for any other install.

`scripts/configure-extension-cdp.mjs:170` repeats the `reasons: ['DOM_SCRAPING']` declaration that unit A1 annotates in `extension/background.js`; keep the two consistent so the repository does not ship two contradictory statements.

Add a repository-wide identity gate to `mcp-server/release-check.mjs` so this class cannot regress: fail the release when `git grep -iE 'robert|lora|rjlora'` or `git grep -E '/Users/[A-Za-z]'` returns anything, excluding `.git` and `node_modules`. Run the grep from a relative path so it cannot match its own invocation.

**Findings addressed**
- `mcp-server/doctor.mjs:13`, `:14`, and `:15`: the first-line diagnostic hardcodes the author's unpacked extension directory, a named personal Chrome profile, and a machine-specific extension id, so it reports a healthy foreign install as broken.
- `mcp-server/release-check.mjs:9`: the same stale author path makes the release gate report full drift every run.
- Nine harness scripts hardcode `/Users/RobertLora/.umbra/shared-key` and four hardcode the author's Downloads path.

**Acceptance proof**

`git grep -inE 'robert|lora|/Users/[A-Za-z]' -- mcp-server scripts` returns zero. `npm run doctor` from the repository root reports `activeExists: true` and a resolved Chrome profile on this machine, and reports a clear "extension directory not found" rather than a silent false on a machine with no unpacked install. `npm run release:check` exits non-zero when a test string containing the author's name is added to any tracked file, and exits zero once it is removed.

---

### Unit B3: Documentation sanitize and private setup record

**Files owned**
- `README.md`
- `docs/install.md`
- `docs/smoke-test.md`
- `docs/architecture.md`
- `docs/permissions.md`
- `docs/performance/CiC_Performance_Goal.md`
- `docs/private-setup.md` (new)
- `SECURITY_REVIEW.md`
- `THREAT_MODEL.md`
- `MCP_PROTOCOL.md`
- `IMPROVEMENT_PLAN_V1.5.md`
- `rust-broker/README.md`
- `rust-broker/LEGACY_FALLBACK.md`

**Work**

Remove every author path and personal reference. `docs/smoke-test.md` has 16 matches, `README.md` has 14, `IMPROVEMENT_PLAN_V1.5.md` has 13, and `docs/install.md` has 8, including "This does not touch Robert's daily Chrome profile" and five hardcoded absolute repository paths at lines 16, 27, 47, 59, and 77. `README.md:21` names the launchd label and `README.md:55` and `:62` name a client domain as export evidence, as do `docs/smoke-test.md:25` and `:29`.

Rewrite `docs/install.md` as a path a stranger can follow: clone, `npm install` in `mcp-server`, load the extension unpacked or install from the store, generate a key in the options page, paste the printed environment line into the MCP client config. Document every environment variable in one table: `UMBRA_SHARED_KEY`, `UMBRA_SHARED_KEY_FILE`, `UMBRA_DOWNLOAD_DIR`, `UMBRA_BROKER_SOCKET`, `UMBRA_BROKER_LAUNCHD_LABEL`, `UMBRA_PORT_START`, `UMBRA_PORT_END`, `UMBRA_BROKER_MODE`, `UMBRA_REQUEST_TIMEOUT_MS`, `UMBRA_KEEP_TABS_OPEN`, and `UMBRA_CLOSE_ON_SHUTDOWN`. `UMBRA_DOWNLOAD_DIR` appears in exactly three places in the current codebase, all of them the fallback expressions themselves, and in no document at all, which is why the hardcoded default was load-bearing rather than decorative.

Write `docs/private-setup.md` as the single record of Robert's continuity. It states the exact environment block for his MCP client config (`UMBRA_DOWNLOAD_DIR=/Users/RobertLora/Documents/Downloads`, `UMBRA_SHARED_KEY_FILE=/Users/RobertLora/.umbra/shared-key`), the launchd re-bootstrap commands for the new `dev.umbra.broker` label, where the moved `reports/` tree now lives, and the note that his install keeps `extension/recipes/ahrefs-actions.js` and `mcp-server/ahrefs-export.js` because he runs unpacked from this checkout while the published packages exclude both. This file is git-ignored, so it records the values without shipping them.

`SECURITY_REVIEW.md:30`, `THREAT_MODEL.md:5`, `MCP_PROTOCOL.md:20`, `docs/architecture.md`, `docs/performance/CiC_Performance_Goal.md:157`, and `rust-broker/README.md:5` each carry one or two author paths. `IMPROVEMENT_PLAN_V1.5.md` is a 2026-05 planning document with 13 matches; either sanitize it or move it out of the tracked tree, since its items are largely superseded by this plan.

**Findings addressed**
- `docs/install.md:13` and `:16`: the install path a new user is told to follow hardcodes the author's absolute repository path and names him directly.
- `README.md:21`, `:52`, `:55`, `:62`, `:80`, `:135`: author paths, the author-named launchd label, the author's primary Chrome profile, and a client domain as export evidence.
- `UMBRA_DOWNLOAD_DIR` and the other environment overrides exist in code and appear in no document, so the portable configuration is undiscoverable.

**Acceptance proof**

`git grep -inE 'robert|lora|rjlora|/Users/[A-Za-z]' -- '*.md'` returns zero, with `docs/private-setup.md` git-ignored. A fresh reader following `docs/install.md` on a machine with no prior Umbra state reaches a connected session, which is also the Phase C reviewer walkthrough.

---

## Phase C: Public package

Build the artifact, fix the manifest for a public listing, make first run work without a terminal, and give the companion server a one-command story.

### Unit C1: Extension manifest

**Files owned**
- `extension/manifest.json`

**Work**

Rewrite the description at `extension/manifest.json:5`. It currently reads "Drive signed-in Chrome from the shadow. Ahrefs exports, owned tabs, no focus theft." That puts a third-party trademark in the store listing text a reviewer reads first. Describe the capability without naming any vendor.

Move `<all_urls>` from `host_permissions` at `:17` into a new `optional_host_permissions` array. MV3 accepts `<all_urls>` there, while `optional_permissions` does not accept URL patterns. Nothing needs site access until a session drives a tab: the manifest declares no `content_scripts` key, all injection is on-demand through `chrome.scripting`, and `grep -n "fetch(" extension/*.js` returns zero hits. This removes the install-time "Read and change all your data on all websites" warning.

Be honest about what that buys. It does not take the item out of the powerful-permission review bucket, because `debugger` at `:14` is still required, cannot be declared optional, needs no host permission, and already carries the most sensitive capabilities through `Runtime.evaluate` at `extension/background.js:1849`, `DOM.setFileInputFiles` at `:1521`, and `Page.captureScreenshot` at `:4661`. Sell the change as removing the install warning, not as escaping review.

Delete `http://127.0.0.1/*` and `http://localhost/*` at `:18` and `:19`. They are dead weight and removing them drops two more install warnings. `<all_urls>` never matched a `ws://` URL, and the extension's only network activity is the WebSocket at `extension/offscreen.js:273`, which is gated by the CSP `connect-src` directive already declared at `:44`, not by host permissions. There is no fetch or XHR anywhere that would need a CORS origin.

Add `homepage_url` so the popup and options page are not a dead end for a reviewer or a user.

Note the coupling that must ship together: in the un-granted state `chrome.tabs.captureVisibleTab` at `extension/background.js:5124` fails, because Chrome requires a literal broad host permission for programmatic visible-tab screenshots and `activeTab` is not enough without a user gesture. `docs/permissions.md:95` records this. A granted optional host permission satisfies it identically, but the grant flow in unit C2 and the single clear `host_permission_missing` error path must land in the same release, or a first-run agent session fails with five different opaque errors from five call sites.

**Findings addressed**
- `extension/manifest.json:5`: a third-party trademark in the store listing description.
- `extension/manifest.json:17`: `<all_urls>` granted at install time, when nothing needs site access until a session drives a tab.
- `extension/manifest.json:18` and `:19`: loopback host permissions that grant nothing the CSP does not already allow.

**Acceptance proof**

Load the built package unpacked in a clean Chrome profile. The install prompt shows no "all websites" warning. Clicking Grant in the options page adds the permission and `browser_screenshot` succeeds afterwards; before granting it, every tool that needs site access returns one `host_permission_missing` error naming the grant button, not a raw Chrome error.

---

### Unit C2: Onboarding and options flow

**Files owned**
- `extension/options.html`
- `extension/options.js`
- `extension/popup.html`
- `extension/popup.js`

**Work**

Add Generate and Copy buttons beside the shared key input at `extension/options.html:94` and at `extension/popup.html:116`. Today both surfaces are a bare password field, one with the placeholder "Paste the shared install key", which presupposes a key the user does not have. Nothing in the extension can produce one, and no code anywhere creates the `~/.umbra/shared-key` file that `README.md:21` names as canonical: grepping the tree finds only readers. `mcp-server/launch-mcp.sh:78` creates `$HOME/.umbra/bin` and stops. Generate the key with `crypto.getRandomValues`, show it once, and offer a Copy button that copies the whole environment line the companion needs, so the user pastes in one direction instead of typing a 64-character string into two places.

Nothing validates the key format anywhere. `extension/shared.js:50` does `String(config.sharedKey || '')` and `mcp-server/auth.js:17` feeds whatever arrives to `createHmac`, so any non-empty string pairs. The generator can therefore pick a readable format freely.

Surface errors. `extension/options.js:62` throws `'Shared key is required. Generate a random key with: openssl rand -hex 32'` from inside an async click handler registered at `:55` with no catch, and the page has no error element and no `unhandledrejection` listener. That string is the only place in the shipping extension that tells anyone how to make a key, and it never renders: a user who clicks Save with an empty field sees nothing at all. `extension/popup.js:49` does not even have the empty-key check. Render every error in the existing `#status-text` element at `extension/options.js:20`.

Add the permission grant. `grep -rn "chrome.permissions"` across the extension returns zero hits, so there is no grant surface today. Add a button calling `chrome.permissions.request({ origins: ['<all_urls>'] })` with a plain sentence explaining that Umbra reads and drives only tabs a session owns, and reflect the granted state in the status panel.

Add a first-run card that appears when no key is set, walking the three steps in order: generate the key, paste the printed line into the MCP client config, grant site access. Unit A1 opens this page on install.

Delete the "Expected Test Values" card at `extension/options.html:127`, which tells a public user to use port range 47821-47852 for "the current local smoke test". That is developer leftover sitting in what will be the settings screen.

Both surfaces are dead ends for a reviewer. Neither `extension/popup.html` nor `extension/options.html` contains a single `href`, and the manifest has no `homepage_url`. Unit C1 adds the manifest field; link to it from both pages here.

**Findings addressed**
- `extension/options.html:94` and `extension/popup.html:116`: pairing requires inventing a key out of band and typing the identical string into two places, with no generate button, no copy button, and no code that ever creates the file the README calls canonical.
- `extension/options.js:62`: the only key-generation hint in the extension is thrown into an unhandled rejection and never rendered.
- `extension/popup.html:1`: a reviewer who installs the packaged extension sees a form demanding a shared key and can exercise zero functionality, with no in-page explanation and no link out.
- `extension/options.html:127`: smoke-test instructions shipped as user-facing settings copy.

**Acceptance proof**

In a clean Chrome profile with the built package installed, the options page opens automatically on install, Generate produces a key, Copy places a complete environment line on the clipboard, pasting that line into an MCP client config and starting the server produces a connected status dot within fifteen seconds, and Grant flips the site-access indicator. Clicking Save with an empty field renders a visible error rather than failing silently. This walkthrough is the screencast that ships with the store submission.

---

### Unit C3: Build and package verification

**Files owned**
- `scripts/package-extension.sh` (new)
- `scripts/verify-package.mjs` (new)
- `tests/packaging/package-extension.test.mjs` (new)

**Work**

Write a packaging script that zips from an explicit allowlist rather than the whole directory: `manifest.json`, `background.js`, `content-agent.js`, `ax-tree.js`, `session-state.js`, `shared.js`, `javascript-safety.js`, `offscreen.html`, `offscreen.js`, `options.html`, `options.js`, `popup.html`, `popup.js`, and `icons/`. The allowlist deliberately omits `recipes/`, which is what makes the Ahrefs page automation local-only in the public build. Unit A1 wrote the dispatch so a missing recipe file produces a clear error rather than a crash, and Robert loads unpacked from this repository so his install still has it.

An allowlist rather than an exclude list is the point. No packaging script exists today, so a submission built now is a zip of the whole folder, and stray files re-enter silently under an exclude list.

Write `scripts/verify-package.mjs` as the pre-submission gate, run against the built zip: assert the total size is under 500 KB; assert no entry matches `robert`, `lora`, or `/Users/` case-insensitively; assert no entry name or file content contains a competitor product name; assert `manifest.json` declares `optional_host_permissions` and not a required `<all_urls>`; assert no source file contains `AsyncFunction`, `new Function(`, or `eval(`; and assert the zip contains no `recipes/` entry and no `assets/` entry.

**Findings addressed**
- `extension/manifest.json:25` package scope: with no packaging script, the submission zip is the whole `extension/` folder, which today is 4,762,373 bytes of which 4.5 MB is unreferenced artwork.
- The Ahrefs page automation at `extension/background.js:2925` through `:3643` needs a mechanical exclusion boundary, not a code deletion, so the capability survives locally.

**Acceptance proof**

`bash scripts/package-extension.sh` produces `dist/umbra-<version>.zip` under 200 KB, and `node scripts/verify-package.mjs dist/umbra-<version>.zip` exits 0 on every assertion. `cd mcp-server && node --test ../tests/packaging/package-extension.test.mjs` passes, asserting the allowlist matches the manifest's declared resources plus the icons and that adding a stray file to `extension/` does not change the zip contents.

---

### Unit C4: Companion server command line

**Files owned**
- `mcp-server/cli.js` (new)
- `tests/mcp/cli.test.mjs` (new)

**Work**

Write a single entry point with four subcommands. `umbra pair` prints the environment block and, when given a key, writes it to `resolveSharedKeyPath()` with mode 0600, which is the file `README.md:21` calls canonical and that nothing currently creates. `umbra start` is what an MCP client invokes and is equivalent to running `index.js`. `umbra doctor` runs the sanitized diagnostic. `umbra broker install` renders `launchd/dev.umbra.broker.plist.template` with the running user's home directory, creates the log directory, and bootstraps the service.

The `bin` entry that makes `npx umbra` work lives in `mcp-server/package.json`, owned by unit A0, so this unit writes only the executable.

Print an actionable error when the shared key is missing rather than the current bare `'Missing UMBRA_SHARED_KEY or UMBRA_SHARED_KEY_FILE.'` thrown from `loadSharedKey` at `mcp-server/index.js:121`, and name the options-page Generate button as the source.

**Findings addressed**
- `mcp-server/package.json:4`: no `bin` entry means there is no npx-style companion, so a public user has no one-command path from install to a running server.
- `README.md:21` names `~/.umbra/shared-key` as canonical while no code anywhere writes it.

**Acceptance proof**

`npx --prefix mcp-server umbra pair` prints a complete environment block and writes the key file with mode `-rw-------`. `npx --prefix mcp-server umbra doctor` reports the same result as `npm run doctor`. `cd mcp-server && node --test ../tests/mcp/cli.test.mjs` passes, asserting each subcommand exits 0 on a valid invocation and non-zero with a named message on a missing key.

---

### Phase C gate

`bash scripts/package-extension.sh && node scripts/verify-package.mjs dist/umbra-*.zip` exits 0. The zip loads in a clean Chrome profile, the onboarding walkthrough in unit C2 completes end to end, and `cd mcp-server && npm test` plus `~/.cargo/bin/cargo test --manifest-path rust-broker/Cargo.toml` both stay green. Robert's own install, running unpacked from this repository with `docs/private-setup.md` applied, still exports an Ahrefs CSV successfully, which is the single proof that no capability was lost.

---

## Phase D: Store submission package

Written material and assets for the listing. These are new files with no code overlap, so they can be drafted in parallel with Phase C.

### D1: Listing copy

`store-listing/listing-copy.md` carrying the store name, the short description under 132 characters, the full description, and the category. Every line must be free of third-party trademarks, because the current manifest description at `extension/manifest.json:5` names one. State the external dependency plainly in the description: Umbra requires a local companion server, and the extension does nothing without it. Google's documented path for an extension with an external dependency is disclosure in the description plus test instructions in the reviewer field, which is why that disclosure is a listing requirement rather than a nice-to-have.

### D2: Privacy policy

`store-listing/privacy-policy.md`, published at a public URL and linked from the listing and from `homepage_url`. It must state what is provably true of the code: the extension makes no network request to any host except a loopback WebSocket at `extension/offscreen.js:273`, it has no analytics and no telemetry, it stores only the shared key, the port range, the enabled flag, and an install id in `chrome.storage.local` per `extension/shared.js:3`, and session tab ownership in `chrome.storage.session` per `extension/session-state.js:16`. Page content is read only from tabs a session owns and is returned only to the local companion over loopback. Nothing is transmitted off the machine.

### D3: Permission justifications

`store-listing/permission-justifications.md`, one paragraph per declared permission, each naming the concrete code path so a reviewer can verify rather than take the claim on trust.

- `debugger`: silent screenshots without focus theft at `extension/background.js:4661`, file input population at `:1521`, and page-world JavaScript at `:1849`. This is the permission that will draw the most scrutiny; explain that `Runtime.evaluate` replaced an `AsyncFunction` constructor precisely so caller-supplied code runs only through the API Google sanctions for it.
- `tabs` and `tabGroups`: per-session tab ownership and the group that makes owned tabs visually distinct, enforced at `extension/session-state.js:129`.
- `scripting`: on-demand injection of the content agent and accessibility helpers, with no `content_scripts` key in the manifest.
- `offscreen`: the document that holds the loopback WebSocket, since an MV3 service worker cannot hold a long-lived connection.
- `alarms`: the one-minute wake alarm at `extension/background.js:8` that resurrects a dead offscreen document.
- `storage`: the four configuration values and session state named in the privacy policy.
- `optional_host_permissions` for `<all_urls>`: requested at grant time, not install time, and needed because `chrome.tabs.captureVisibleTab` requires a literal broad host permission for programmatic screenshots without a user gesture, as recorded at `docs/permissions.md:95`.

### D4: Reviewer notes and testability

`store-listing/reviewer-notes.md`. This is the item most likely to cause a rejection, because a reviewer who installs the package sees a configuration form and can exercise nothing. Provide: a screencast of the unit C2 walkthrough from install through three tool calls driving tabs; the exact `npx` command from unit C4 that starts the companion; and the public URL of the sanitized `docs/install.md`. Say "a local Node companion server", not "a server plus a Rust broker". The Rust broker is optional and `mcp-server/index.js:154` defaults to the pure-Node bridge when `UMBRA_BROKER_MODE` is unset, so overstating the setup burden to Google is self-harm.

### D5: Asset list

`store-listing/assets/README.md` recording every required artifact and its source.

- Store icon at 128 by 128, from `branding/icons/icon128.png`.
- Promotional tile at 440 by 280, from `branding/icons/icon440.png`.
- At least one screenshot at 1280 by 800 or 640 by 400: the options page after a successful pairing, showing a connected status and an owned session.
- A second screenshot showing an owned tab group in Chrome, which is the clearest visual explanation of the ownership model.
- The screencast from D4.

Every image must be checked for embedded provenance metadata before submission. `extension/assets/chrome-bridge-icon-source.jpg` carries C2PA blocks naming an image generator and its vendor, and the `branding/` icons come from the same generator, so strip metadata as a packaging step rather than a one-time cleanup.

---

## Risks worth naming

**A1 is a single large unit on a 5,797-line file.** The disjoint-ownership rule forces it, and splitting the file first would be a bigger risk than the work itself. Mitigate by landing its seventeen items as separate commits in the listed order, running the two baseline test commands after each.

**The keepalive spans three units and one wrong order destroys sessions.** The `ping` and `pong` handlers in units A6 and A7 must merge before unit A4 enables its teardown timer, because both servers currently drop unrecognised message types and a forty-five-second teardown against a server that never answers would disconnect every idle session on a loop. Unit A4's gate on "a pong was seen on this socket" makes the ordering safe rather than merely advisable.

**Dropping `structuredContent` changes what some MCP clients see.** Claude Code reads `structuredContent` and discards the text block, which is why the 30,000-byte compact guard has been inert. Verify against the actual client before merging unit A9, and keep the compact branch emitting both the summary and the compact object so no client loses the payload.

**Schema enforcement can break working calls.** Sixty-plus schemas have never been enforced while `extension/background.js:4884` coerces parameters ad hoc. Ship the log-only pass in Phase A, read the real traffic, and only then decide whether to enforce.

**History rewrite is one-way.** Move `reports/` to its local home and confirm the copy before the orphan commit, because the rewrite is what makes the client data unrecoverable from this tree, which is the point.

# Umbra

Drive your own signed-in Chrome from an AI agent, one session at a time, without handing the agent your cookies.

Umbra is two pieces that pair on a shared key you generate: a Chrome extension (Manifest V3) that is the only process allowed to call Chrome, and a local MCP server that gives any MCP client a browser tool list. They talk only over an authenticated WebSocket on 127.0.0.1. Nothing leaves the machine.

## Why this exists

Remote-debugging a browser gives an agent everything at once: every tab, every cookie jar, every profile. Umbra takes the opposite position. The agent gets a tab group it created, the tabs inside it, and nothing else. Ask it to read a tab it does not own and the extension refuses before Chrome is ever touched.

Two tools sit outside that boundary on purpose, and both are listed as such in `docs/permissions.md`: `browser_find_tabs` and `browser_find_groups` report the title and URL of tabs a session does not own, which is how you hand one over, and `browser_cleanup_groups` matches tab groups by title across the whole profile so it can clear groups left behind by a session that is gone. Give `browser_cleanup_groups` a title prefix your own groups do not share, or run it with `dryRun: true` first.

That boundary is what makes it usable against a browser you are already logged into. The agent can read a dashboard you are signed into, fill a form, export a CSV, and close its own tabs when it finishes, while your other windows stay untouched and unreadable.

The project is deliberately boring:

- real Chrome, real profile, real signed-in state, chosen by you
- many concurrent agent sessions in one browser, each isolated to its own tab group
- per-session tab ownership enforced on every action
- no cookie export, no token extraction, no CAPTCHA solving, no generic background fetch
- loopback-only transport with an HMAC handshake in both directions

## Install

Five steps, about five minutes, on macOS or Linux with Node.js 20+ and Chrome 121+. The full walkthrough with every option lives in `docs/install.md`. If you installed the extension from the Chrome Web Store, skip step 2; everything else is the same.

1. Get the code and install the companion:

   ```bash
   git clone https://github.com/RobertJLora/umbra
   cd umbra/mcp-server
   npm install
   ```

2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension/` folder inside the clone from step 1. The options page opens by itself; if it does not, click Details on the Umbra card, then Extension options.

3. Run `node cli.js pair`. It prints the key and a ready-made client config block. Paste the key into the options page and click **Save And Reconnect**; paste the config block into your MCP client's config.

4. Click **Grant Site Access** on the options page. Chrome asks once; without it, page reads and screenshots fail.

5. Restart your MCP client. The options page status dot turns green within about fifteen seconds and the tools appear. If it does not, `node cli.js doctor` says why.

Dependencies live in `mcp-server/`, not at the repository root, so `npm install` at the root installs nothing. Once step 1 has run, `npm test`, `npm run doctor`, and `npm run release:check` all work from the root. The public checkout carries no optional local plugins.

## Tool surface

**Session and tabs**
`browser_create_tab`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_close_session_tabs`, `browser_freeze_session_tabs`, `browser_group_tabs`, `browser_cleanup_groups`, `browser_mark_debug_group`, `browser_tabs_context`, `browser_get_session_status`, `browser_get_bridge_pressure`

**Adopting tabs you already opened**
`browser_find_tabs`, `browser_adopt_tab`, `browser_find_groups`, `browser_adopt_group`

**Navigation**
`browser_navigate`, `browser_navigate_back`, `browser_navigate_forward`, `browser_wait`, `browser_resize`

**Reading**
`browser_get_page_content`, `browser_read_page`, `browser_read_interactive`, `browser_find`, `browser_get_technical_snapshot`, `browser_screenshot`, `browser_console_messages`, `browser_read_network_requests`

**Interaction**
`browser_click`, `browser_click_text`, `browser_type`, `browser_fill`, `browser_form_input`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_shortcut`, `browser_scroll`, `browser_file_upload`, `browser_upload_image`, `browser_cursor`

**Recording**
`browser_gif`

**Composites that save round trips**
`browser_batch`, `browser_wait_click_read`, `browser_navigate_wait_read`, `browser_click_wait_selector_read`

**Escape hatches**
`browser_javascript`, `browser_run_page_action`, `browser_wait_for_download`

`browser_reload_extension` exists for unpacked developer installs only. It is advertised when `UMBRA_ALLOW_EXTENSION_RELOAD=1`, and store installs refuse it. The options-page Reload button covers the same workflow without exposing a cross-session tool.

The list above is the whole surface of every published build. A checkout can carry optional local page-recipe plugins, which are not part of any published build: a module in `mcp-server/plugins/` paired with a page recipe in `extension/recipes/`. Both folders are untracked and unpublished, and a plugin adds its own tools and its own `browser_run_page_action` values to the list only in the install that holds it.

Notes worth knowing before you call these:

- `browser_get_page_content` defaults to text-only and supports selector scoping plus a `maxChars` cap. Pass `includeImages: true` only when you need the visible-image inventory.
- `browser_batch` runs a bounded create, navigate, wait, read, click, fill, press, scroll, close workflow in one MCP call. Child params can reference earlier results with `{"$ref":"prev.tabId"}` for the last successful step, `{"$ref":"0.tabId"}` for a step by index, or `{"$ref":"create.tabId"}` when that earlier call set `label: "create"`.
- `browser_read_interactive` returns a compact list of visible controls with short-lived refs tied to the current DOM version. `browser_click`, `browser_fill`, `browser_scroll`, and `browser_screenshot` accept those refs; a stale ref returns an error telling the caller to read again.
- `browser_get_bridge_pressure` reports one session's pressure: its owned tab count and a sample of those tabs, connected listener counts, and content-agent queue depth. It also reaps ownership records for tabs that no longer exist, so it is not purely read-only.
- `browser_freeze_session_tabs` discards owned inactive tabs with `chrome.tabs.discard` to release renderer memory. It defaults to `dryRun: true` and never targets a tab another session owns.
- `browser_run_page_action` runs predefined, named page actions and returns JSON-safe output. It is not an arbitrary script tool; `browser_javascript` is, and it routes through the debugger on the owned tab.
- The three composites default to leaving Chrome in the background and report which it was as `activated`. A child result reporting `active: true` means the tab is the active tab of its own window, not that Chrome came forward; `activated` and a screenshot preflight's `windowFocused` are the fields that answer the focus question.
- `browser_find` treats `selector` as a constraint rather than a single search root: every element it matches, and everything inside those elements, is searched. Its accessibility walk now filters for find rather than walking everything, so an existing caller gets a different candidate set than it did before.
- `browser_wait` takes a selector, `urlContains`, `urlChanged`, or a plain `durationMs` sleep. Use a URL predicate after a submit or a click, because a selector that is already on the un-navigated page matches instantly and hides the failure. `durationMs` on its own never touches the page, and combined with a predicate it settles first and then checks.
- `browser_click` takes `button`, `clickCount` 1 to 3, and `modifiers` for ctrl, shift, alt and meta. Omit all three and the call is the single unmodified left click it was before they existed.
- `browser_drag` drags between two points, refs, or selectors. It fires the pointer and mouse sequence every custom slider and sortable list reads, and adds the HTML5 drag family with one shared `DataTransfer` when the source carries `draggable="true"`, which is what a native drop target needs.
- `browser_upload_image` has two modes. Naming a file input with `ref` or `selector` hands Chrome the path and has no size limit; dropping at `x` and `y` sends the bytes through the server and is capped at 700 KB, so prefer the input mode whenever the page has one.
- `browser_press_key` takes a space-separated sequence such as `Tab Tab Enter` plus a `repeat` of 1 to 100, capped at 400 dispatches for one call. A single key with no repeat still dispatches one chord, but an unmodified Enter now also performs the browser default action, which is the "Enter is emulated" entry under Known limitations: it clicks the form's default submit button, or submits the form when there is none. Pass `defaultAction: false` to get the raw key dispatch and nothing else. The same true-by-default `defaultAction` applies to `browser_type` with `submit: true` and to `browser_shortcut`.
- `browser_scroll` takes `direction` with `amount` in roughly 100-pixel clicks, and `atX` with `atY` to scroll the inner pane under that point instead of the window. `x` and `y` keep their pixel-delta meaning.
- `browser_get_page_content` `mode: "article"` scores the page for body-text density and returns the winning block without the navigation, sidebars and related-link rails that `mode: "main"` leaves in. When the content agent served the read it reports the node it chose as `articleRootSelector`, so a disagreement is one `selector` read away; the one-shot fallback, which runs when the agent is unreachable, omits that field, and `contentAgent.fallback` says which path answered.
- Clicks, typing, scrolling and hovers draw a cursor inside the page: a pointer glides to the target, then a ripple, caret or chevron marks the action. It is painted in the tab, so a background tab stays in the background, and `browser_screenshot` clears the pointer and every ripple, caret and chevron before it captures. The glide is started rather than waited on, so the animation overlaps the real dispatch instead of delaying it. `browser_cursor` turns the drawing off or on for one session; the options page holds the install-wide default. The empty `<umbra-cursor-layer>` host is present on every driven page either way, and is stripped from HTML reads.
- `browser_read_network_requests` logs one owned tab's HTTP requests: URL, method, resource type, status, MIME type and timing. Filter with `urlPattern` and `types`, and pass `stop: true` when you are done. No request or response body is captured, and no header is returned. URLs keep their query strings, up to 600 characters, so a page that signs its URLs or carries a token in a query string puts that value in the log.
- `browser_tabs_context` returns `url` exactly as Chrome reports it. Pass `urlMaxLength` with a positive number to collapse the query and fragment to a marker and cap the length; those rows carry `urlTruncated: true` and their `url` is no longer navigable.
- `browser_gif` cannot run as a `browser_batch` child with `action: "export"`: inside a batch neither `outputPath` guard applies, so the encoded animation would come back inline. Call it directly.
- `browser_gif` records one owned tab: `start`, then the work, then `stop` and `export` with an `outputPath`. Frames come from the same background capture `browser_screenshot silent: true` uses, so recording never pulls the tab forward. Interval frames arrive at `fps`, four a second by default, and each click, drag, keystroke and scroll adds a frame before and after the action. The export writes the file and returns only metadata, never the animation itself. A recording stops on its own after three minutes.

## How it fits together

1. Your MCP client talks to the local server over stdio.
2. The server registers a session, either directly on a loopback bridge listener or through the Rust broker.
3. The Chrome extension's offscreen document holds the WebSocket and keeps it alive across service worker churn.
4. The extension authenticates every connection with an HMAC challenge over the shared key plus per-session nonces.
5. The background service worker assigns each session its own tab group and checks ownership before every Chrome call.

Two transports exist. The pure-Node bridge is what you get after a normal install. The Rust broker is what the launcher uses only after you build it: one extension WebSocket, many lightweight MCP shims registering sessions behind it over a local Unix socket, with the broker owning routing, auth, pressure counters, and request cleanup. Legacy mode gives each session its own loopback listener and is one setting away with `UMBRA_BROKER_MODE=legacy`. Either way the extension is the only thing that touches a Chrome API.

## Concurrency and ownership

- One Chrome profile hosts many sessions at once.
- Each session gets one session id, one named cyan Chrome tab group, and its own view of the browser.
- Opening, navigating, and DOM interaction default to inactive tabs, so routine work never pulls Chrome to the foreground. Pass `activate: true` when you actually need focus.
- Umbra remembers a dedicated Chrome window for its tabs and routes new session tabs there. It refuses to reuse that window while it is focused, so it never adds tabs to the window you are working in.
- Navigation is scheme-limited at the extension boundary: `http:`, `https:`, `file:`, and `about:blank` are allowed, and risky schemes such as `javascript:` and `data:` are rejected before Chrome sees them.
- At task completion the agent should call `browser_close_session_tabs`, which closes the whole owned group. It closes a whole window only when every tab in that window belongs to the session, so unowned blank tabs survive.
- Clean server shutdown runs the same cleanup by default. Set `UMBRA_KEEP_TABS_OPEN=1` or `UMBRA_CLOSE_ON_SHUTDOWN=0` when a run should leave tabs open for inspection.
- The default port range is `47821-47852`, which is wide enough that ordinary multi-agent work never runs out of room. The extension clamps a configured port to `1024-65535`; set the same range on both sides.

## What Umbra will not do

- dump or sync cookies
- extract tokens
- expose storage read and write as tools
- fetch in the background on a page's behalf
- solve CAPTCHAs
- touch bookmarks, history, or the clipboard
- use native messaging
- auto-update, auto-pull, or auto-install anything

## Known limitations

- Default screenshots activate the session-owned tab before capture. `silent: true` avoids that by attaching `chrome.debugger` to the owned tab for one `Page.captureScreenshot`, which makes Chrome show its automation banner.
- Site access is an optional permission, requested from the Grant Site Access button on the options page rather than at install. Until it is granted, page reads, clicks, and screenshots fail with a message naming that button. `docs/permissions.md` justifies every permission the extension declares.
- Download completion is detected by watching the filesystem, because the extension does not request Chrome's `downloads` permission. Point `UMBRA_DOWNLOAD_DIR` at your browser's download folder if you moved it.
- A recording is cancelled when the bridge is disabled or the shared key is cleared. Both close the offscreen document, and that document is where the frames are held, so an in-flight recording dies with it. Chrome allows one offscreen document per extension, so there is no second place to hold them.
- The request log starts on the first read rather than being always on, so that first call usually returns nothing: act on the page and read again. Capture needs a debugger attachment, which shows Chrome's automation banner, and Umbra will not hold one on every tab for traffic nobody asked to see. Logging ends on `stop: true`, when the tab closes, when the session disconnects, and after five idle minutes.
- `browser_read_interactive` is intentionally compact. Umbra does not expose a full accessibility-tree dump.
- Generic text clicks can hit the wrong control on dense app UIs such as search pagination. Use `browser_read_interactive` with refs, or `browser_run_page_action` with `inspect_controls` then `click_control`, instead of guessing.
- Enter is emulated. Umbra clicks a form's default submit button, or submits the form when it has none, and skips that when the page handled Enter itself. Pass `defaultAction: false` for raw key dispatch. Chrome only performs implicit form submission for a real keypress, so a dispatched Enter on its own reaches page listeners and does nothing else.
- A right click is synthetic. The page gets a `contextmenu` event and renders its own menu if it has one, but Chrome's native context menu does not open, because no event a page can receive opens it. Use `browser_shortcut` when the native menu is the point.
- Back navigation can fall through to the page's own history. Chrome hides history entries left behind by clicks that had no user gesture, so the tab-level back call reports an empty stack on a tab that plainly has one. Umbra retries in the page and reports which path moved it as `via`.
- Changing the port range needs both sides to reload: restart the MCP client so new server processes inherit the environment, and reload the unpacked extension so persisted extension storage is normalized.

## Layout

- `extension/` - MV3 extension: background worker, offscreen bridge, content agent, options page, popup
- `extension/recipes/` - optional site-specific page recipes, injected on demand and absent from the published package
- `extension/vendor/` - third-party code shipped as is, currently the MIT-licensed GIF encoder the recorder uses
- `mcp-server/` - stdio MCP server, loopback bridge, Rust broker shim client, and the local development harness
- `rust-broker/` - Tokio broker runtime that multiplexes sessions over one extension WebSocket
- `tests/` - auth, ownership, session isolation, extension lifecycle, and packaging coverage
- `scripts/` - isolated Chrome test-profile launcher and smoke wrappers
- `launchd/` - template for the optional macOS job that keeps the broker running
- `docs/` - install, architecture, permissions, and smoke-test notes

## Documentation

- `docs/install.md` - setup from clone to a connected session, plus every environment variable
- `docs/branding-and-icons.md` - mark lineage, the four icon surfaces, dark-mode icon switching, and the store update flow
- `docs/architecture.md` - components, flow, and the reasoning behind the offscreen and background split
- `docs/permissions.md` - each Chrome permission with its risk and its mitigation
- `docs/smoke-test.md` - automated and manual verification paths
- `docs/performance/performance-work.md` - what the performance pass changed and what it measured
- `MCP_PROTOCOL.md` - the wire protocol between extension and server
- `THREAT_MODEL.md` - assets, trust boundaries, attackers, and mitigations
- `SECURITY_REVIEW.md` - review stance, the keep and remove matrix, and upstream audit findings
- `rust-broker/README.md` - broker scope and how to run it
- `rust-broker/LEGACY_FALLBACK.md` - rollback triggers and the cutover shape

Read `THREAT_MODEL.md` and `SECURITY_REVIEW.md` before pointing this at a browser that holds anything you care about.

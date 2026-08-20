# Umbra

Drive your own signed-in Chrome from an AI agent, one session at a time, without handing the agent your cookies.

Umbra is two pieces that pair on a shared key you generate: an MV3 Chrome extension that owns every Chrome API call, and a local MCP server that exposes a browser tool surface to any MCP client. They talk only over an authenticated loopback WebSocket. Nothing leaves the machine.

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

Full walkthrough, with every variable a normal install needs, is in `docs/install.md`. The short version:

```bash
git clone <this-repo> umbra
cd umbra/mcp-server
npm install
npm test
```

Dependencies live in `mcp-server/`, not at the repository root, so `npm install` at the root installs nothing and `npm test` there fails until the command above has run once. After it has, `npm test`, `npm run doctor`, and `npm run release:check` all work from the root.

Load `extension/` unpacked at `chrome://extensions` with Developer mode on, open the extension options page, click Generate Key, then click Copy Environment Line and paste that line into your MCP client config. Restart the client and the tools appear. Click Grant Site Access on the same page before the first page read, because Umbra requests no site access at install time.

The package is not on npm yet and the extension is not in the Chrome Web Store yet, so a checkout is the only install path today. From one, `node mcp-server/cli.js pair` generates the key, writes it to `~/.umbra/shared-key`, and prints the client config block. Once `@umbra-mcp/server` is published the same command runs as `npx -y @umbra-mcp/server pair`, and that published package will carry no optional local plugins.

## Tool surface

**Session and tabs**
`browser_create_tab`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_close_session_tabs`, `browser_freeze_session_tabs`, `browser_group_tabs`, `browser_cleanup_groups`, `browser_mark_debug_group`, `browser_tabs_context`, `browser_get_session_status`, `browser_get_bridge_pressure`

**Adopting tabs you already opened**
`browser_find_tabs`, `browser_adopt_tab`, `browser_find_groups`, `browser_adopt_group`

**Navigation**
`browser_navigate`, `browser_navigate_back`, `browser_navigate_forward`, `browser_wait`, `browser_resize`

**Reading**
`browser_get_page_content`, `browser_read_page`, `browser_read_interactive`, `browser_find`, `browser_get_technical_snapshot`, `browser_screenshot`, `browser_console_messages`

**Interaction**
`browser_click`, `browser_click_text`, `browser_type`, `browser_fill`, `browser_form_input`, `browser_select_option`, `browser_hover`, `browser_press_key`, `browser_shortcut`, `browser_scroll`, `browser_file_upload`

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

## How it fits together

1. Your MCP client talks to the local server over stdio.
2. The server registers a session, either directly on a loopback bridge listener or through the Rust broker.
3. The Chrome extension's offscreen document holds the WebSocket and keeps it alive across service worker churn.
4. The extension authenticates every connection with an HMAC challenge over the shared key plus per-session nonces.
5. The background service worker assigns each session its own tab group and checks ownership before every Chrome call.

Two transports exist. The Rust broker is the launcher default: one extension WebSocket, many lightweight MCP shims registering sessions behind it over a local Unix socket, with the broker owning routing, auth, pressure counters, and request cleanup. Legacy mode gives each session its own loopback listener and is one setting away with `UMBRA_BROKER_MODE=legacy`. Either way the extension is the only thing that touches a Chrome API.

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
- Site access is an optional permission, requested from the Grant Site Access button on the options page rather than at install. Until it is granted, page reads and screenshots fail with Chrome's own permission error, because Chrome requires a literal broad host permission for programmatic visible-tab capture. `docs/permissions.md` justifies every permission the extension declares.
- Download completion is detected by watching the filesystem, because the extension does not request Chrome's `downloads` permission. Point `UMBRA_DOWNLOAD_DIR` at your browser's download folder if you moved it.
- `browser_read_interactive` is intentionally compact. Umbra does not expose a full accessibility-tree dump.
- Generic text clicks can hit the wrong control on dense app UIs such as search pagination. Use `browser_read_interactive` with refs, or `browser_run_page_action` with `inspect_controls` then `click_control`, instead of guessing.
- Changing the port range needs both sides to reload: restart the MCP client so new server processes inherit the environment, and reload the unpacked extension so persisted extension storage is normalized.

## Layout

- `extension/` - MV3 extension: background worker, offscreen bridge, content agent, options page, popup
- `extension/recipes/` - optional site-specific page recipes, injected on demand and absent from the published package
- `mcp-server/` - stdio MCP server, loopback bridge, Rust broker shim client, and the local development harness
- `rust-broker/` - Tokio broker runtime that multiplexes sessions over one extension WebSocket
- `tests/` - auth, ownership, session isolation, extension lifecycle, and packaging coverage
- `scripts/` - isolated Chrome test-profile launcher and smoke wrappers
- `launchd/` - template for the optional macOS job that keeps the broker running
- `docs/` - install, architecture, permissions, and smoke-test notes

## Documentation

- `docs/install.md` - setup from clone to a connected session, plus every environment variable
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

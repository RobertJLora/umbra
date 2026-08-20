# Umbra

Drive your own signed-in Chrome from an AI agent, one session at a time, without handing the agent your cookies.

Umbra is two pieces that pair on a shared key you generate: an MV3 Chrome extension that owns every Chrome API call, and a local MCP server that exposes a browser tool surface to any MCP client. They talk only over an authenticated loopback WebSocket. Nothing leaves the machine.

## Why this exists

Remote-debugging a browser gives an agent everything at once: every tab, every cookie jar, every profile. Umbra takes the opposite position. The agent gets a tab group it created, the tabs inside it, and nothing else. Ask it to read a tab it does not own and the extension refuses before Chrome is ever touched.

That boundary is what makes it usable against a browser you are already logged into. The agent can read a dashboard you are signed into, fill a form, export a CSV, and close its own tabs when it finishes, while your other windows stay untouched and unreadable.

The project is deliberately boring:

- real Chrome, real profile, real signed-in state, chosen by you
- many concurrent agent sessions in one browser, each isolated to its own tab group
- per-session tab ownership enforced on every action
- no cookie export, no token extraction, no CAPTCHA solving, no generic background fetch
- loopback-only transport with an HMAC handshake in both directions

## Install

Full walkthrough with every environment variable is in `docs/install.md`. The short version:

```bash
git clone <this-repo> umbra
cd umbra/mcp-server
npm install
npm test
```

Load `extension/` unpacked at `chrome://extensions` with Developer mode on, open the extension options page, generate a shared key, and paste the printed environment line into your MCP client config. Restart the client and the tools appear.

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
`browser_javascript`, `browser_run_page_action`, `browser_wait_for_download`, `browser_reload_extension`

`browser_export_ahrefs` is an optional local plugin rather than part of the published package. It appears in the tool list only when `mcp-server/ahrefs-export.js` and `extension/recipes/ahrefs-actions.js` are both present in the checkout you run. Everything else above ships in every build.

Notes worth knowing before you call these:

- `browser_get_page_content` defaults to text-only and supports selector scoping plus a `maxChars` cap. Pass `includeImages: true` only when you need the visible-image inventory.
- `browser_batch` runs a bounded create, navigate, wait, read, click, fill, press, scroll, close workflow in one MCP call. Child params can reference earlier results with `{"$ref":"prev.tabId"}`, `{"$ref":"0.tabId"}`, or `{"$ref":"create.tabId"}`.
- `browser_read_interactive` returns a compact list of visible controls with short-lived refs tied to the current DOM version. `browser_click`, `browser_fill`, `browser_scroll`, and `browser_screenshot` accept those refs; a stale ref returns an error telling the caller to read again.
- `browser_get_bridge_pressure` is read-only. It reports sessions, owned tabs and windows, connected listeners, content-agent counts, storage-write counters, discard candidates, and cleanup suggestions.
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
- The default port range is `47821-47852`, which is wide enough that ordinary multi-agent work never runs out of room.

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
- Broad host permissions are required for arbitrary signed-in browsing and for programmatic visible-tab capture. `docs/permissions.md` justifies each one.
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
- `MCP_PROTOCOL.md` - the wire protocol between extension and server
- `THREAT_MODEL.md` - assets, trust boundaries, attackers, and mitigations
- `SECURITY_REVIEW.md` - review stance, the keep and remove matrix, and upstream audit findings
- `rust-broker/README.md` - broker scope and how to run it
- `rust-broker/LEGACY_FALLBACK.md` - rollback triggers and the cutover shape

Read `THREAT_MODEL.md` and `SECURITY_REVIEW.md` before pointing this at a browser that holds anything you care about.

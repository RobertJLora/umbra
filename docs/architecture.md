# Architecture

## Design summary

Umbra is an MV3 Chrome extension plus a local companion server. The server is the agent-facing surface and speaks MCP over stdio. The extension is the Chrome-facing surface and is the only thing in the system that calls a Chrome API. They meet over an authenticated loopback WebSocket and nowhere else.

Everything else in this document follows from that split. The server never touches Chrome, so a compromised or careless MCP client cannot reach past the tool surface. The extension never talks to a remote host, so nothing it reads can leave the machine.

## Components

**Companion MCP server** (`mcp-server/`)
Exposes the browser tool surface over stdio, registers one session, and forwards commands to the extension. It holds no Chrome state and enforces no ownership; it asks and the extension decides.

**Offscreen document** (`extension/offscreen.js`)
Holds the long-lived WebSocket. An MV3 service worker is killed after roughly thirty seconds idle, so it cannot own a persistent connection. The offscreen document survives that churn, redials when a socket dies, and sends an application-level `ping` every fifteen seconds so a socket that reports OPEN but is dead gets torn down and replaced instead of wedging the session.

**Background service worker** (`extension/background.js`)
Owns tab creation, grouping, navigation, reads, and DOM interaction, and checks session ownership before every one of them. Ownership state is persisted in `chrome.storage.session`, so a worker restart does not lose track of which session owns which tab.

**Content agent** (`extension/content-agent.js`)
An on-demand injection into an owned tab that keeps a long-lived `chrome.runtime.connect` port for repeated reads and selector waits. It tracks a DOM version and disconnects on navigation, tab close, or session disconnect. When injection is blocked by the page, the extension falls back to a one-shot `chrome.scripting.executeScript`.

**Accessibility walker** (`extension/ax-tree.js`)
Builds the compact control list behind `browser_read_interactive` and `browser_find`, and mints the short-lived element refs that `browser_click`, `browser_fill`, `browser_scroll`, and `browser_screenshot` accept. It is version-guarded, so re-injecting it into a live page reuses the existing ref store rather than resetting it.

**Options page and popup**
Generate and store the shared key, set the loopback port range, request site access, and report connection status.

**Rust broker** (`rust-broker/`), optional
One process holding one extension WebSocket, with many lightweight MCP shims registering sessions behind it over a Unix socket. It owns routing, authentication, pressure counters, and request cleanup.

## Flow

```text
MCP client
  |  stdio
companion server
  |  loopback WebSocket, HMAC in both directions
offscreen document
  |  chrome.runtime messaging
background service worker
  |  chrome.tabs, chrome.tabGroups, chrome.scripting, chrome.debugger
Chrome tabs inside the session's tab group
```

With the broker in the path, the middle hop changes shape and nothing else does: every shim connects to the broker over a Unix socket, and the broker holds the single WebSocket to the extension.

## Two transports

**Legacy** is protocol v1. Each session starts its own loopback listener inside its own server process, and the extension scans the configured port range and connects to each one. It needs no extra binary and is the fallback whenever the broker is unavailable. Force it with `UMBRA_BROKER_MODE=legacy`.

**Broker** is protocol v2. One extension WebSocket carries every session, tagged by `sessionId`. This is the mode worth running when several agents share one browser, because each new session costs a Unix socket registration rather than a fresh WebSocket handshake and a port bind.

Both modes enforce the same authentication, the same ownership rules, and the same cleanup. The extension is the only Chrome API layer in either one. `MCP_PROTOCOL.md` carries the wire format for both.

## Why offscreen plus background

The service worker is the right place for tab and extension API access, and the wrong place for a socket. Splitting them means a worker restart costs a reconnect at worst, never a lost connection, and the one-minute wake alarm can resurrect a dead offscreen document without disturbing anything the worker was doing.

The offscreen document is deliberately thin. It holds sockets, authenticates, and relays; it makes no Chrome API call and holds no ownership state. Every command it receives is passed to the worker, which decides whether the calling session is allowed to run it.

## Session ownership

- Each session gets one session id and one named Chrome tab group.
- Every tab a session creates or adopts is mapped to that session id.
- Every action resolves the tab through the ownership map before Chrome is touched.

Which means `browser_list_tabs` returns only the caller's tabs, one session cannot close, read, or switch to another session's tab, and a tab nobody owns is invisible to every session. Adoption is the only way in: `browser_find_tabs` and `browser_adopt_tab` let a session take over a tab that was opened by hand.

Cleanup is ownership-based too. `browser_close_session_tabs` closes the session's whole group, and closes a window only when every tab in that window belongs to the session, so an unowned blank tab keeps the window alive. Clean server shutdown runs the same cleanup by default, and `UMBRA_KEEP_TABS_OPEN=1` leaves the tabs open for inspection.

## DOM interaction

There is no persistent content script and no `content_scripts` key in the manifest. Everything is injected on demand through `chrome.scripting` into a tab the session already owns, which keeps the audit surface per action rather than per page.

Caller-supplied JavaScript runs through `chrome.debugger` and `Runtime.evaluate` on the owned tab. That is the API Chrome sanctions for it, and it replaced an `AsyncFunction` constructor that compiled caller code inside the extension's own world. `browser_run_page_action` is the opposite kind of tool: a fixed set of named actions with JSON-safe output, not arbitrary script.

Site-specific automation lives in `extension/recipes/`, injected into the owned tab only when a matching action is called, and into the same isolated world the rest of the page actions run in. The published store package omits that directory, so those actions report `Page recipe not installed in this build` instead of failing halfway through a page.

## Background-first operation

Opening, navigating, and DOM interaction default to inactive tabs, so routine work never pulls Chrome to the foreground. `browser_create_tab`, `browser_navigate`, `browser_click`, `browser_click_text`, `browser_fill`, `browser_press_key`, and `browser_scroll` all take `activate: true` when focus is genuinely needed.

Umbra remembers a dedicated window for its tabs and routes new session tabs there. It refuses to reuse that window while it is focused and creates a fresh unfocused one instead, so it never adds tabs to the window a person is working in.

## Screenshots

Two paths, and the difference is visible to the user.

The default activates the session-owned tab and calls `chrome.tabs.captureVisibleTab`. It is simple, needs no debugger attach, and steals focus for the moment of capture. Chrome requires a literal broad host permission for it, which is why site access has to be granted before the first screenshot.

`silent: true` attaches `chrome.debugger` to the owned tab for one `Page.captureScreenshot` and detaches straight after. Nothing is activated and nothing is focused, and Chrome shows its automation banner for as long as the attach lasts. The banner is the honest signal that something is driving the browser, so the quieter path is also the more visible one.

Full-page capture stitches slices and is capped by height, because a tall page multiplied by the device pixel ratio can otherwise build a canvas large enough to fail inside Chrome rather than in any code here.

# Security Review

## Review stance

Default deny. Other browser-bridge projects are reference material, not trusted code, and nothing was forked.

The project is only acceptable while all four of these hold:

- the extension acts only on session-owned tabs, with the two named carve-outs below
- the `/bridge` WebSocket accepts only authenticated loopback clients
- no feature exposes cookies, tokens, storage values, or generic background fetch
- permissions stay small and each one has a written justification in `docs/permissions.md`

Anything that breaks one of them is a release blocker, not a trade-off.

Two things sit outside those lines on purpose, and both are documented rather than quietly true:

- `/healthz` on the loopback listener is unauthenticated. It answers any local process with the broker's session ids, socket path, extension instance id, and pressure counters. It exists so `doctor` can diagnose a broker it holds no key for. `/bridge`, the only route that can drive the browser, requires the HMAC proof and rejects anything else with 401. Anything that reads `/healthz` treats its contents as advisory, never as a source of a path to write to.
- `browser_find_tabs`, `browser_find_groups`, and `browser_cleanup_groups` reach past the ownership map by design. The first two return title and URL for unowned tabs and groups so a user can hand one over; the third matches groups by caller-supplied title so a group left by an ended session can still be cleared. None of the acting tools reach a tab the calling session does not own.

## What the code does today

- Authentication is an HMAC challenge and response in both directions over a loopback WebSocket, keyed on a shared install key. No static default key exists; setup requires generating one.
- Session ownership is enforced in the background service worker before any Chrome API call, and persisted in `chrome.storage.session` so a worker restart does not lose it.
- The offscreen document holds sockets only. It makes no Chrome API call and holds no ownership state; it asks the background worker for config and debug writes over `chrome.runtime` messaging.
- Site access is an optional permission requested from the options page rather than granted at install.
- `chrome.debugger` is declared and used for exactly three things: silent screenshots, owned-tab file input population, and caller-supplied JavaScript. Each attaches, sends its commands, and detaches. Contract tests pin that shape.
- Caller-supplied JavaScript runs through `Runtime.evaluate` on the owned tab. The `AsyncFunction` constructor that used to compile it inside the extension is gone from both the service worker and the content agent.
- The DevTools Protocol appears in one place outside the extension: a test harness that configures an unpacked extension in a throwaway profile. It is not the control model.
- The published packages exclude the site-specific page recipes and the export plugin that drives them, so the store build cannot run site automation that the source tree can.

Production sign-off is not complete. The checklist below is the gate.

## Keep, remove, rewrite

### Keep

- one session per agent, each isolated to its own tab group
- the offscreen document for long-lived connection management
- tab-group-based session ownership as the isolation primitive
- session cleanup and reconnect as first-class behavior rather than an afterthought

### Remove

- cookie read and write helpers
- storage read and write helpers exposed as tools
- token extraction flows
- generic background fetch on a page's behalf
- CAPTCHA helpers
- provider-specific authentication plumbing
- auto-update, auto-pull, and auto-install behavior

### Rewrite

- **Loopback discovery and handshake.** Keep loopback-only discovery, replace blind trust with an authenticated challenge and response.
- **Session state persistence.** Keep the ownership model, persist enough metadata to survive worker suspend and resume, and refuse to persist before the first load so a cold worker cannot overwrite stored state with an empty map.
- **Screenshot capture.** Prefer the path that steals the least focus. The default activates the owned tab and uses `chrome.tabs.captureVisibleTab`; `silent: true` attaches the debugger for one `Page.captureScreenshot` and accepts Chrome's automation banner as the honest signal.

## Required review checklist

- [ ] Review every extension permission
- [ ] Review every network egress path
- [ ] Review loopback binding and handshake logic
- [ ] Review all filesystem writes
- [ ] Review all sensitive tool surfaces
- [ ] Review session cleanup and reconnect behavior
- [ ] Review service worker suspend and resume behavior
- [ ] Review the debugger attach, command, and detach paths
- [ ] Verify one session cannot inspect or mutate another session's tabs
- [ ] Verify no auto-update or auto-install path remains
- [ ] Verify the packaged build excludes the recipes directory and the export plugin

## Standing findings

**Broad page reach is unavoidable for arbitrary signed-in browsing.** It is mitigated by making it optional and revocable rather than install-time, and by shipping no tool that exports what the reach could reach. A future allowlist mode that constrains it to named domains is worth planning for higher-value workflows.

**Any port-range discovery is a local attack surface.** The range is narrow and configurable, the listener binds only to `127.0.0.1`, and no session metadata is exposed before the HMAC bind step succeeds.

**The Unix socket the broker exposes to MCP shims is the sharpest edge in the system.** Shim registration carries no HMAC proof, so anyone who can connect to that socket can drive the browser. The socket is created with mode `0600` in a per-user directory rather than in world-writable `/tmp`, which is what keeps that from being reachable by another local account.

**Screenshot capture is the least settled part of the tool surface.** Chrome rejects programmatic capture with `activeTab` alone, which is why the broad host permission exists at all. If an allowlist mode ever lands, capture is the path that will need the most thought.

## Prior art

Four projects were read before writing this one. None was forked, and the reasons are worth recording so a reviewer can see what was deliberate.

**Agent360 Browser MCP.** Worth borrowing: the extension plus local server split, the offscreen document for long-lived connections, tab-group ownership as the isolation primitive. Not adopted because its startup path updates code automatically through `git pull`, conditional installs, and `@latest`; its manifest requests `cookies`, `notifications`, `webNavigation`, and `debugger`; its offscreen document scans a loopback range and trusts open local ports with no authenticated handshake; credential and second-factor prompting is injected into page DOM; and its tool surface includes fetch, cookie, local-storage, and token helpers. The architecture shape carried over; the trust model and tool surface were written from scratch.

**OpenChrome.** Worth borrowing: the session manager and tab-group manager split, per-session request queues, lifecycle-aware coordination, and audit and redaction patterns. Not adopted as a base because its manifest includes `nativeMessaging`, `debugger`, a global content script on `<all_urls>`, and `externally_connectable`; it adds a native messaging host as a second privileged local surface; its CLI performs cached registry checks and clears the npx cache automatically; and it carries authentication, tenanting, CAPTCHA, stealth, and orchestration subsystems that multiply the review surface. Its concurrency and audit ideas informed the server side.

**Playwright MCP extension mode.** Worth borrowing: extension-mediated pairing instead of raw debugger attach against a daily browser, and explicit browser-profile integration. Not the base because local testing showed it page-centric rather than session-centric, with a single connected page model and failures during new-tab flows.

**Chrome DevTools MCP.** Worth borrowing: auto-connect ergonomics. Not the base because it centers raw debugger attachment against the real browser profile, which does not solve the approval friction or the session isolation problem for concurrent signed-in use.

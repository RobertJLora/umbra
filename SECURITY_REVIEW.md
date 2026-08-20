# Security Review

## Review Stance

Default deny. Upstream repos are reference material, not trusted code.

This project is only acceptable if:

- the extension acts only on session-owned tabs
- the bridge accepts only authenticated loopback clients
- no V1 feature exposes cookies, tokens, storage, or generic background fetch
- permissions stay small and each one has a written justification

## Current Status

- Threat model written
- Minimal V1 scope locked
- Local bridge authentication designed
- Upstream audits completed and summarized
- Local scaffold implemented and syntax-tested
- Static default test key removed; setup now requires an explicit random shared key
- New Codex-local copy created under `System/Codex/umbra`
- Local MCP server tests passed on 2026-04-24
- Isolated Chrome test-profile launcher and V0 smoke flow added on 2026-04-24
- Automated isolated-profile smoke passed on 2026-04-24 with Chrome for Testing: extension loaded, HMAC-authenticated to the local server, created/listed/navigated/read/closed a session-owned tab, then shut down without leftover listeners
- CDP is allowed only as an isolated-profile test harness for configuring the unpacked extension; it is not the daily control model
- Offscreen document storage access was removed; offscreen now requests config/debug writes from the background worker over `chrome.runtime` messaging
- Extension is loaded unpacked in Robert's selected signed-in Chrome profile as `kkfedeeiobahmhcgpffcelpepiljiomk`
- Signed-in reuse validated against Ahrefs dashboard on 2026-04-24 with URL/title-only smoke
- Controlled download behavior validated on 2026-04-24: a bridge-initiated CSV landed in `/Users/RobertLora/Documents/Downloads/`
- Group stress validated on 2026-04-24: five sessions, eight tabs each, forty total tabs, five Chrome tab groups, all owned tab titles readable, cross-session reads denied
- MCP server lifecycle guard validated on 2026-04-24: closed stdio triggers shutdown and releases the listener port
- Production sign-off not complete

## Keep / Remove / Rewrite Matrix

## Keep

- multi-session model with one local session listener per Codex session
- offscreen document for long-lived connection management
- tab-group-based session ownership
- session cleanup and reconnect handling as first-class behavior

## Remove

- cookie read/write helpers
- storage read/write helpers exposed as tools
- token extraction flows
- generic background fetch
- CAPTCHA helpers
- provider-specific auth plumbing
- auto-update, auto-pull, and auto-install behavior

## Rewrite

- localhost discovery and handshake
  - keep loopback-only discovery idea
  - replace blind trust with authenticated challenge-response
- session state persistence
  - keep ownership model
  - persist enough metadata to survive worker suspend/resume safely
- screenshot capture
  - prefer a path that minimizes focus stealing
  - currently activates a session-owned tab and uses broad host permission for `chrome.tabs.captureVisibleTab`
  - does not request Chrome `debugger`

## Required Review Checklist

- [ ] Review every extension permission
- [ ] Review every network egress path
- [ ] Review loopback binding and handshake logic
- [ ] Review all filesystem writes
- [ ] Review all sensitive tool surfaces
- [ ] Review session cleanup and reconnect behavior
- [ ] Review service worker suspend/resume behavior
- [ ] Review screenshot implementation and any debugger attach behavior
- [ ] Decide whether downloads belong in bridge V1 or remain delegated to `download-browser`
- [ ] Verify one session cannot inspect or mutate another session's tabs
- [ ] Verify no auto-update or auto-install paths remain

## Initial Findings From The Design

1. Broad host permissions are likely unavoidable for arbitrary signed-in browsing.
   They must remain visible in `docs/permissions.md`, and a future allowlist mode is worth planning.

2. Any port-range discovery is a local attack surface.
   The design keeps the range narrow, binds only to `127.0.0.1`, and requires HMAC authentication before exposing session metadata.

3. Screenshot capture is the least-settled part of V1.
   The first full-suite run showed Chrome rejects programmatic screenshots with only `activeTab`. V1 now documents the broader host permission needed for `chrome.tabs.captureVisibleTab`; the implementation still activates a session-owned tab and intentionally avoids `debugger`.

## Upstream Audit Notes

This section will be updated with concrete findings from:

- Agent360 Browser MCP
- OpenChrome
- Playwright MCP extension mode
- Chrome DevTools MCP

## Direct Upstream Findings

## Agent360 Browser MCP

What looks worth borrowing:

- extension plus local server split
- offscreen document for long-lived session connections
- tab-group ownership as the isolation primitive

Concrete reasons not to fork blindly:

- startup behavior updates code automatically via `git pull`, conditional `npm install`, `@latest`, and auto-copy paths
- `extension/manifest.json` requests `cookies`, `notifications`, `webNavigation`, and `debugger` on top of `tabs`, `tabGroups`, `scripting`, `storage`, and `offscreen`
- `extension/offscreen.js` scans a hard-coded loopback range and trusts open local ports without an authenticated handshake
- credential and 2FA prompting flows are injected into page DOM rather than kept in a trusted extension surface
- `mcp-server/tools.js` exposes `browser_fetch`, cookie tools, local-storage tools, response capture, token helpers, and a much wider tool surface than V1 needs
- session isolation depends partly on weak identities and global tab tracking rather than a strict per-session capability model
- persistent action logging stores serialized call params locally, which can retain sensitive values

Bottom line:

- borrow the architecture shape
- rewrite the trust model and tool surface from scratch

## OpenChrome

What looks worth borrowing:

- explicit session manager and tab-group manager split
- stronger attention to lifecycle, persistence, and concurrency as first-class concerns
- per-session request queues and lifecycle-aware worker/session coordination
- audit and redaction patterns that can carry over to a smaller local-only design
- small defense-in-depth helpers like domain guards and content sanitization

Concrete reasons not to use it as the base:

- `extension/manifest.json` includes `nativeMessaging`, `debugger`, a global content script on `<all_urls>`, and `externally_connectable`
- `native-host/host.js` adds a native messaging bridge and another privileged local surface to review
- `cli/update-check.ts` performs cached registry checks and clears npx cache automatically, which is exactly the sort of background update behavior we do not want in V1
- the codebase includes auth, tenanting, CAPTCHA, stealth, cookie, and orchestration subsystems that materially increase review scope
- the broader system now includes HTTP transport, tunnel, and desktop-side surfaces that are outside the minimal local-only trust model
- default context behavior is tuned for reuse and power, not maximum isolation, so it is the wrong default to inherit unchanged

Bottom line:

- mine it for server-side concurrency and audit ideas
- do not inherit the codebase whole

## Playwright MCP Extension Mode

What looks worth borrowing:

- extension-mediated pairing rather than raw daily-browser debugger attach
- explicit browser-profile integration

Concrete reason it is not the primary base:

- local verification already showed it remaining page-centric rather than session-centric, with a single connected page/session model and `_page` failures during new-tab flows

## Chrome DevTools MCP

What looks worth borrowing:

- auto-connect ergonomics

Concrete reason it is not the primary base:

- it still centers raw debugger attachment against the real browser profile, which does not solve the approval-friction or session-isolation problem for concurrent signed-in use

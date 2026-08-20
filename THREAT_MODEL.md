# Threat Model

## Goal

Provide a minimal bridge that lets Codex control Robert's real Chrome state without inheriting raw remote-debugging approval pain, cross-session tab leakage, or dangerous data-extraction tools.

## Protected Assets

- authenticated browser state in the real Chrome profile
- tab contents and DOM data inside session-owned tabs
- session ownership metadata
- local bridge secrets and handshake material
- Codex-issued commands and bridge responses

## Trust Boundaries

1. Codex session -> local MCP server
   - trusted transport: stdio
   - risk: malformed MCP calls or unexpected concurrency

2. Local MCP server -> Chrome extension
   - trusted transport: authenticated WebSocket on `127.0.0.1`
   - risk: another local process attempts to impersonate the extension or bind the port first

3. Chrome extension -> Chrome tab/page
   - trusted API surface: `tabs`, `tabGroups`, `scripting`, `offscreen`, `storage`
   - risk: page scripts influence injected automation logic or race navigation state

4. Extension internal boundary
   - offscreen document keeps local bridge connections alive
   - service worker owns tab actions and persisted session metadata
   - risk: worker suspend/resume loses ownership state or reconnect logic

## Assumed Attackers

- a malicious local process on the same machine trying to connect to the bridge
- a compromised or careless upstream browser-bridge codebase
- a web page attempting to trick injected code paths into unsafe behavior
- stale or zombie sessions that leave tabs or permissions in an ambiguous state

## Explicit Non-Goals

- exporting cookies, tokens, or storage values
- generic network egress from the extension on behalf of the page
- bypassing CAPTCHA or anti-bot checks
- silent background changes to tabs outside session ownership

## Main Risks And Mitigations

## Loopback bridge spoofing

- Bind the bridge only to `127.0.0.1`.
- Use a shared install key plus challenge-response HMAC.
- Issue a per-session nonce and reject commands until the session is authenticated.
- Keep the scannable port range narrow and configurable.

## Cross-session tab leakage

- Give every session a unique session ID and tab group.
- Record owned tab IDs per session.
- Reject any action on a tab not owned by the caller session.
- Return only session-owned tabs from `browser_list_tabs`.

## Privileged data exposure

- Ship no cookie, token, storage, history, bookmark, or background fetch tools.
- Keep permissions minimal and document each one.
- Log privileged actions locally for auditability.

## Service worker suspend/resume

- Persist ownership state in extension storage.
- Treat the offscreen bridge as reconnectable, not authoritative.
- Reconcile live Chrome tab/group state after reconnect.

## Dangerous update behavior

- No auto-update logic in repo code.
- No auto-pull, `@latest`, or background installer flows.
- All dependency changes should be explicit and reviewable.

## Open Questions

- Whether `chrome.debugger` is needed for non-focus-stealing screenshots, or whether the first release can tolerate a visible-tab fallback.
- Whether V1 can avoid content scripts entirely and rely only on `chrome.scripting.executeScript`.
- Whether a future allowlist mode should constrain host permissions to explicit domains for higher-value workflows.

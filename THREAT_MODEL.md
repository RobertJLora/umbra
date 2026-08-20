# Threat Model

## Goal

Let an agent drive a real, signed-in Chrome profile without inheriting the blast radius of raw remote debugging, without leaking one session's tabs into another, and without shipping a single data-extraction tool.

## Protected assets

- authenticated browser state in the profile the extension is loaded into
- page content and DOM data inside session-owned tabs
- session ownership metadata
- the shared install key and the handshake material derived from it
- the commands an agent issues and the responses it gets back

## Trust boundaries

**1. MCP client to companion server.** Transport is stdio, inherited from whatever launched the server. Risk: malformed calls, unexpected concurrency, or a client that dispatches arguments the schema never described.

**2. Companion server to extension.** Transport is an authenticated WebSocket on `127.0.0.1`. Risk: another local process impersonating the extension, binding the port first, or replaying a handshake.

**3. Broker to MCP shims.** Transport is a Unix socket, used only when the optional Rust broker is running. Risk: any local process that can open the socket can register a session and drive the browser, because registration carries no HMAC proof. The socket is created with mode `0600` in a per-user directory for exactly that reason.

**4. Extension to page.** API surface is `tabs`, `tabGroups`, `scripting`, `debugger`, `offscreen`, `alarms`, and `storage`. Risk: page scripts influencing injected automation, or a navigation racing a read.

**5. Inside the extension.** The offscreen document holds connections; the service worker owns tab actions and persisted ownership. Risk: worker suspend and resume losing ownership state, or a cold worker writing an empty map over stored state before it loads.

## Assumed attackers

- a malicious local process trying to connect to the bridge or the broker socket
- a web page trying to trick injected code into acting outside its session
- a second Chrome profile on the same machine holding the same key, since the key is machine-wide
- stale or zombie sessions leaving tabs and permissions in an ambiguous state
- a careless MCP client sending well-formed calls with wrong arguments

Not in scope: an attacker who already has the user's shell. Anyone with that has the key file, the profile, and the browser itself.

## Explicit non-goals

- exporting cookies, tokens, or storage values
- generic network egress from the extension on a page's behalf
- bypassing CAPTCHA or anti-bot checks
- touching tabs outside session ownership, silently or otherwise

## Risks and mitigations

### Loopback bridge spoofing

- Bind only to `127.0.0.1`, and reject any connection whose remote address is not `127.0.0.1` or `::1`.
- Require a shared install key and an HMAC challenge and response in both directions.
- Issue a per-session nonce and refuse every command until the bind step succeeds.
- Keep the scannable port range narrow and configurable.

### Broker socket abuse

- Create the socket with mode `0600` under a per-user directory, never in world-writable `/tmp`, where another local account could also pre-create the path and stall every broker start.
- Bind each shim socket to the session it registered, and reject a command or disconnect that names a different session.

### Cross-session tab leakage

- Give every session a unique id and its own tab group.
- Record owned tab ids per session and check them before every Chrome call.
- Return only session-owned tabs from `browser_list_tabs`.
- Make adoption explicit: a tab enters a session through `browser_adopt_tab` or `browser_adopt_group` and no other way.

### Privileged data exposure

- Ship no cookie, token, storage, history, bookmark, or background fetch tool.
- Keep permissions minimal, make site access optional and revocable, and document each one.
- Keep caller-supplied JavaScript on the debugger path, so it is visible in Chrome's own automation banner rather than hidden inside the extension.

### Service worker suspend and resume

- Persist ownership state in extension storage and refuse to persist before the first successful load.
- Treat the offscreen connection as reconnectable, never authoritative.
- Reconcile live tab and group state after a reconnect.

### Dead but open sockets

- Send an application-level ping on an interval and tear down a socket that stops answering, because a sleep and wake can leave a socket reporting OPEN with nothing on the other end.
- Gate that teardown on having seen at least one answer, so an older peer that does not know the frame degrades to the previous behavior instead of disconnecting on a loop.

### Dangerous update behavior

- No auto-update logic anywhere in the tree.
- No auto-pull, no `@latest`, no background installer.
- Dependency changes are explicit and reviewable.

## Open questions

- Whether an allowlist mode should constrain site access to named domains for higher-value profiles, and what that costs in usability.
- Whether the shim registration path should require its own proof rather than relying on socket permissions alone.
- Whether per-tool schema validation should reject mismatched arguments or keep only logging them, given that the extension coerces some parameters today.

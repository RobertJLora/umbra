# Local Bridge Protocol

This protocol is used between the local MCP server and the Chrome extension over a loopback WebSocket.

## Transport

- WebSocket over `ws://127.0.0.1:<port>/bridge`
- extension initiates the connection
- server listens on a narrow configured port range
- no non-loopback binding

## Versioning

Legacy mode is protocol v1 and remains available via `UMBRA_BROKER_MODE=legacy`. The legacy server sends `protocolVersion: 1` in `hello_ack`, then forwards one browser command per WebSocket message.

Protocol v2 is broker mode, where a Node prototype or the opt-in Rust broker can multiplex command streams while preserving the same authentication, ownership, and cleanup rules. A client must not assume v2 unless the server explicitly replies with `protocolVersion: 2` and broker metadata in `hello_ack`.

MCP-only orchestration tools, such as `browser_batch`, are not raw extension commands in v1. The MCP server expands them into ordinary owned-tab browser commands before anything reaches the extension. Batch child params can reference earlier step results with `{"$ref":"prev.tabId"}`, `{"$ref":"0.tabId"}`, or `{"$ref":"create.tabId"}`.

The Node mux work remains a tested prototype in `mcp-server/node-mux-prototype.js`. The Rust broker is now the launcher default, having passed live smoke, focused-suite, safety, and benchmark parity against the legacy bridge under concurrent multi-agent load. The lightweight MCP shim path lives in `mcp-server/rust-broker-client.js`; legacy protocol v1 remains the rollback, one setting away.

## Authentication

The extension and server share one install key configured manually during setup.

Handshake:

1. Extension opens `ws://127.0.0.1:<port>/bridge?ts=...&nonce=...&mac=...`
2. `mac = HMAC(shared_key, "hello:" + port + ":" + ts + ":" + nonce)`
3. Server verifies freshness and HMAC.
4. Server replies with:
   - `sessionId`
   - `serverNonce`
   - `protocolVersion`
5. Extension responds with:
   - `extensionInstanceId`
   - `proof = HMAC(shared_key, "bind:" + sessionId + ":" + nonce + ":" + serverNonce)`
6. Server marks the channel authenticated and ready.

The shared key never travels in plaintext. All command handling is disabled until the bind step succeeds.

## Message Types

## `hello`

Sent by the extension during connection setup.

```json
{
  "type": "hello",
  "extensionInstanceId": "install-123",
  "version": "0.1.0"
}
```

## `hello_ack`

Sent by the server after verifying the opening query parameters.

```json
{
  "type": "hello_ack",
  "sessionId": "sess_abc123",
  "serverNonce": "nonce_2",
  "protocolVersion": 1
}
```

Legacy-compatible extensions should ignore unknown fields on `hello_ack`.

Protocol v2 broker-mode golden example:

```json
{
  "type": "hello_ack",
  "sessionId": "sess_abc123",
  "serverNonce": "nonce_2",
  "protocolVersion": 2,
  "broker": {
    "mode": "node-mux",
    "legacyFallback": true,
    "maxInFlight": 16,
    "supportsBatch": true
  }
}
```

Opt-in Rust broker runtime example:

```json
{
  "type": "hello_ack",
  "sessionId": "umbra-rust-broker",
  "serverNonce": "nonce_2",
  "protocolVersion": 2,
  "broker": true,
  "supportsSessionRouting": true
}
```

## `bind`

Sent by the extension to complete authentication.

```json
{
  "type": "bind",
  "extensionInstanceId": "install-123",
  "proof": "base64url-hmac"
}
```

## `bind_ack`

Sent by the server after successful authentication.

```json
{
  "type": "bind_ack",
  "sessionId": "sess_abc123",
  "ready": true
}
```

## `command`

Sent by the server to request a browser action.

```json
{
  "type": "command",
  "id": "req_123",
  "tool": "browser_navigate",
  "params": {
    "url": "https://example.com"
  }
}
```

Protocol v2 broker-mode command golden example:

```json
{
  "type": "command",
  "id": "req_124",
  "sequence": 7,
  "sessionId": "sess_abc123",
  "deadlineMs": 15000,
  "tool": "browser_get_page_content",
  "params": {
    "tabId": 321,
    "format": "text",
    "selector": "main",
    "maxChars": 12000,
    "includeImages": false
  }
}
```

The extension must use `message.sessionId` for protocol v2 routed commands. If absent, it may fall back to the authenticated channel session for protocol v1 compatibility.

## `session_disconnected`

Sent by a v2 broker to tell the extension that a shim session disconnected. This releases the live connection state for that specific session without closing the single broker WebSocket.

```json
{
  "type": "session_disconnected",
  "sessionId": "sess_abc123",
  "reason": "shim_disconnected"
}
```

## `ping` and `pong`

Sent by the extension's offscreen document on an interval, and answered by whichever server holds the other end.

```json
{ "type": "ping", "ts": 1767225600000 }
```

```json
{ "type": "pong", "ts": 1767225600004 }
```

This is an application-level keepalive, not a WebSocket protocol ping. Browser JavaScript cannot send a protocol ping and never surfaces a protocol pong to a message listener, so a socket that is OPEN but dead is otherwise invisible to the extension and blocks its own replacement.

Both the legacy bridge and the Rust broker answer it. A server that does not is not a failure case: the extension only tears a socket down for silence after it has seen at least one `pong` on that socket, so an older peer degrades to the previous behavior rather than disconnecting on a loop.

## MCP Shim Socket

The Rust broker also listens on a local Unix socket for lightweight MCP shims. This is not a Chrome extension protocol and never carries browser credentials.

Register a session:

```json
{
  "type": "register_session",
  "id": "shim_1",
  "session_id": "sess_abc123",
  "mac": "<hex HMAC-SHA256 of register:{session_id} using the shared key>"
}
```

Route a command:

```json
{
  "type": "command",
  "id": "shim_2",
  "session_id": "sess_abc123",
  "tool": "browser_navigate",
  "params": {
    "url": "https://example.com",
    "activate": false
  }
}
```

Responses are newline-delimited JSON:

```json
{
  "type": "response",
  "id": "shim_2",
  "ok": true,
  "result": {
    "tabId": 321
  }
}
```

## Content Agent

The extension can inject `content-agent.js` into session-owned tabs only. It uses
a long-lived `chrome.runtime.connect` port for repeated page reads and selector
waits, tracks a simple DOM version, and disconnects on navigation, tab close, or
session disconnect. If injection is blocked by the page, the extension falls
back to the existing one-shot `chrome.scripting.executeScript` path.

## `result`

Sent by the extension when a command succeeds.

```json
{
  "type": "result",
  "id": "req_123",
  "ok": true,
  "result": {
    "tabId": 321
  }
}
```

Protocol v2 broker-mode result golden example:

```json
{
  "type": "result",
  "id": "req_124",
  "sequence": 7,
  "ok": true,
  "result": {
    "tabId": 321,
    "title": "Example",
    "url": "https://example.com/",
    "content": "Example Domain"
  }
}
```

## `error`

Sent by either side when a request fails.

```json
{
  "type": "error",
  "id": "req_123",
  "ok": false,
  "error": {
    "code": "not_owned",
    "message": "Tab 555 is not owned by this session."
  }
}
```

## Ownership Rules

- A session may list only its own tabs.
- A session may mutate only its own tabs.
- Tabs created by a session are assigned to that session immediately.
- On disconnect, ownership is either detached cleanly or cleaned up according to the configured policy.

# Rust Broker

The Tokio broker runtime. One process holds one WebSocket to the Chrome extension and multiplexes every MCP session behind it over a local Unix socket, instead of each session binding its own loopback listener.

It is optional. The launcher prefers it and falls back to the pure-Node bridge when it is not built, not running, or not wanted. Rolling back is one setting.

## Scope

- HMAC helpers for the `hello` and `bind` proof messages, matching `mcp-server/auth.js`.
- Async session routing with session-owned tab checks.
- HTTP `/healthz` and WebSocket `/bridge` on loopback for the extension.
- A local Unix socket for lightweight MCP shims, created with mode `0600` under `$HOME/.umbra/run/` so no other local account can connect or pre-create the path.
- Protocol v2 session routing over the single extension WebSocket, with each shim socket bound to the session it registered.
- An application-level `ping` and `pong` keepalive, so a dead-but-open socket is detectable from the extension side.
- Health and status structs that serialize to the same shape the legacy `/healthz` returns.
- Pressure counters for pending requests, routed and rejected commands, authentication failures, and byte accounting.
- A live integration test with a mock extension WebSocket and two shim sessions.

## Run

```bash
cargo test
```

The live parity test binds real loopback sockets, so it is ignored by default:

```bash
cargo test --test runtime -- --ignored --nocapture
```

Run the broker directly:

```bash
UMBRA_SHARED_KEY_FILE="$HOME/.umbra/shared-key" cargo run
```

Or through the normal launcher, which builds it when the sources are newer than the binary, starts or reuses it, and then runs the MCP shim:

```bash
../mcp-server/launch-mcp.sh
```

Roll back to the legacy per-session Node bridge:

```bash
UMBRA_BROKER_MODE=legacy ../mcp-server/launch-mcp.sh
```

Set `UMBRA_BROKER_REQUIRED=1` when a fallback to legacy should be a hard failure rather than a quiet degrade, which is what you want in a test run.

## Non-goals

- No Chrome permission of any kind. The broker never calls a Chrome API; the extension remains the only Chrome API layer, and moving any of that into Rust is out of scope.
- No cookie, token, password, CAPTCHA, download, native messaging, or browser-storage handling. The broker routes commands and never inspects what they carry beyond the fields it needs to route and account for them.
- No network egress. It listens on loopback and on a Unix socket, and connects to nothing.

`LEGACY_FALLBACK.md` carries the rollback triggers and the parity checks that keep this the default.

# Rust Broker

This directory contains the Tokio broker runtime for CiC Performance V2.
The launcher now prefers Rust first after live smoke, focused-suite, and
benchmark parity passed on Robert's local Chrome extension. The legacy Node
bridge remains available as a one-setting rollback.

## Current Scope

- HMAC helpers for the existing hello and bind proof messages.
- Async session routing primitives with session-owned tab checks.
- HTTP `/healthz` and WebSocket `/bridge` on loopback for the Chrome extension.
- Local Unix socket for lightweight MCP shims.
- Protocol v2 session routing over one extension WebSocket.
- Health and status structs that serialize cleanly for `/healthz` parity.
- Pressure counters for pending requests, routed/rejected commands, auth failures,
  and byte accounting.
- Live integration test with a mock extension WebSocket plus two shim sessions.

## Run

```bash
cargo test
```

Run the live broker parity test, which binds loopback sockets:

```bash
cargo test --test runtime -- --ignored --nocapture
```

Run the broker directly:

```bash
UMBRA_SHARED_KEY_FILE="$HOME/.codex/umbra/shared-key" cargo run
```

Use the Rust broker through the normal MCP launcher:

```bash
../mcp-server/launch-mcp.sh
```

Roll back to the legacy bridge:

```bash
UMBRA_BROKER_MODE=legacy ../mcp-server/launch-mcp.sh
```

Set `UMBRA_BROKER_REQUIRED=1` if fallback to legacy should be
treated as a hard failure during tests.

## Non-Goals In This Phase

- No cookie, token, password, CAPTCHA, debugger, downloads, native messaging, or
  browser-storage permissions.
- No Chrome API move into Rust; the extension remains the Chrome API layer.

See `LEGACY_FALLBACK.md` for the rollback and parity plan.

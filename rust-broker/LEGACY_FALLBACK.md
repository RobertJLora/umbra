# Legacy Fallback Plan

Rust is the preferred broker after passing protocol, safety, smoke,
focused-suite, and benchmark parity against the legacy Node bridge. Legacy mode
stays available as the rollback path.

## Default Path

The default launcher path remains:

```text
../mcp-server/launch-mcp.sh
```

`launch-mcp.sh` starts or reuses the Rust broker by default, then runs the
lightweight Node MCP shim. Set `UMBRA_BROKER_MODE=legacy` to use
the old per-session Node bridge path.

## Fallback Triggers

Keep or return to the legacy broker if any of these happen:

- Rust HMAC validation differs from `mcp-server/auth.js`.
- Session ownership or duplicate-channel behavior differs from the Node tests.
- Health/status output cannot represent the existing `/healthz` fields.
- The Rust broker cannot start or reuse its Unix shim socket, or that socket is created with any mode other than `0600`.
- A second extension connection lets the first one's teardown clear the live extension handle, which wedges every session on the machine.
- The extension cannot complete protocol v2 `sessionId` command routing.
- The broker stops answering the application-level `ping` frame, which makes the extension tear down healthy sockets on its keepalive timer.
- Pressure counters hide pending requests or rejected commands.
- `cargo test` fails.
- Node `npm test`, smoke, required smoke, group smoke, or benchmark gates regress.
- Rust adds a permission, storage, auth, or foreground behavior the legacy bridge
  does not already allow.

## Cutover Shape

The integration is explicit and reversible:

1. Rust is the launcher default.
2. Use `UMBRA_BROKER_MODE=legacy` to roll back.
3. Run Rust and Node protocol golden tests against the same fixtures.
4. Run both broker modes through the smoke, focused-suite, and benchmark paths.
5. Keep the default on Rust only while those checks stay green.

Rollback is one setting change back to legacy mode, with no extension reload
required unless extension code changed in a separate phase.

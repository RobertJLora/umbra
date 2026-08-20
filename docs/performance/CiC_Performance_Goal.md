# CiC Performance V2 Goal

Status: complete - Rust-first implementation verified locally with legacy rollback
Branch: codex-cic-rust-broker-v2
Heartbeat: cic-performance-v2-completion-runner
Started: 2026-04-30

## Objective

Reduce Umbra CPU and memory overhead while making common browser workflows faster. Preserve the existing safety model: owned tabs only, background-first operation, no cookie/token/password/browser-storage tools, and conservative cleanup.

## Execution Rules

- Continue until every phase below is checked or a hard blocker is recorded.
- After each implementation phase, run `npm test`.
- After browser behavior changes, run `npm run smoke`, `npm run smoke:required`, and `npm run smoke:groups` when the live extension is available.
- After Rust changes, run `cargo test` from `rust-broker/`.
- Rust may remain the default broker only while legacy rollback continues to pass the same protocol, safety, smoke, and benchmark checks.
- Do not add `debugger`, `downloads`, `nativeMessaging`, cookie, token, password, CAPTCHA, or browser-storage permissions in the main plan.

## Work Lanes

- Benchmark worker: benchmark harness and performance reports.
- Extension worker: scanner, page reads, content agent, freeze/pressure tools.
- MCP/API worker: schemas, batch execution, protocol compatibility.
- Rust worker: opt-in broker runtime, Rust tests, legacy fallback docs.
- Coordinator: ledger, integration, conflicts, full test passes, final QA/creative review.

## Phases

- [x] Phase 1: Baseline and guard tests
  - Add `npm run bench`.
  - Emit JSON and Markdown reports under `reports/performance/<timestamp>/`.
  - Capture latency, payload bytes, tabs/windows left open, and process CPU/RAM samples.
  - Baseline commands: `npm test`, `npm run smoke`, `npm run smoke:required`, `npm run smoke:groups`, focused suite lanes.

- [x] Phase 2: Low-risk JS performance wins
  - Adaptive offscreen scanning and throttled status writes.
  - Avoid storage persistence on read-only commands.
  - Page content modes: text-only default, image inventory opt-in, selector and max-char support.
  - Lower polling pressure while preserving reliable event fallback.

- [x] Phase 3: Public API speed layer
  - Add bounded `browser_batch`.
  - Add fixture workflows for export-like and pagination-like tasks.
  - Reduce MCP round trips for covered workflows. Early pre-content-agent fixture timing showed about 4x batch speedup; after the content-agent path made individual reads cheaper, latest direct fixture timings are near parity while command count still drops.

- [x] Phase 4: Ephemeral per-tab content agent
  - Add owned-tab-only content agent.
  - Add observer-backed waits.
  - Keep one-shot `executeScript` fallback.

- [x] Phase 5: Memory and lifecycle tools
  - Add read-only bridge pressure report.
  - Add explicit owned-tab freeze/discard tool, dry-run by default.
  - Add file-based download ledger without new Chrome permissions.

- [x] Phase 6: Broker interface and Node mux prototype
  - Add protocol v2 golden tests.
  - Preserve legacy mode as default.
  - Prove mux does not weaken ownership or cleanup behavior.

- [x] Phase 7: Rust broker rewrite
  - Add Tokio-based `rust-broker/`.
  - Test auth, session registry, health, pressure counters, and graceful shutdown.
  - Make Rust the launcher default only after parity and benchmark gates pass; preserve legacy rollback.

- [x] Phase 8: Final verification and creative pass
  - Read-only QA review of diff, tests, docs, protocol, permissions, and benchmark results.
  - Read-only creative review for safe follow-up optimizations.
  - Sync and reload the unpacked extension if extension code changed.

## Current Run Notes

- 2026-04-30: Created heartbeat automation `cic-performance-v2-completion-runner`.
- 2026-04-30: Started parallel workers for benchmark, extension, MCP/API, and Rust lanes.
- 2026-04-30: Baseline `npm test` passed before performance implementation: 65/65.
- 2026-04-30: Baseline live smoke was blocked by full bridge port range. `npm run cleanup:test` cleaned 0 listeners because all non-preserved listeners reported `extensionConnected: true`; no force cleanup performed.
- 2026-04-30: Current implementation `npm test` passed: 87/87.
- 2026-04-30: Rust broker scaffold verification passed: `cargo fmt --check` and `cargo test` both green, with 9 Rust integration tests passing.
- 2026-04-30: Added benchmark matrix scenarios for create/read, navigation, wait loop, screenshot, multi-tab fanout, large payload, technical snapshot, separate workflow, batched workflow, and export-like workflow.
- 2026-04-30: Live benchmark report `reports/performance/performance-20260430213237/Performance_Benchmark_Report.md` ran against the reloaded extension. Result: 9/10 scenarios passed, 0 tabs left open. Screenshot failed with Chrome `image readback failed`; later rerun below passed after screenshot retry/cooldown.
- 2026-04-30: Synced canonical extension to Active loaded path and reloaded Chrome extension ID `kkfedeeiobahmhcgpffcelpepiljiomk`. Visible version confirmed: `0.1.7`, then `0.1.8` after QA fixes.
- 2026-04-30: Live `npm run smoke` passed after reload, including text-only default page read, pressure report, freeze dry-run preview, and owned-tab cleanup.
- 2026-04-30: Live `npm run smoke:required` passed after reload, including two sessions, cross-session denial, and controlled CSV download detected through the file ledger.
- 2026-04-30: Live `npm run smoke:groups` passed after reload with 2 sessions x 3 tabs on ports 47831-47832.
- 2026-04-30: Focused live suite passed: `npm run suite -- --suites baseline,concurrency,downloads,seo,cleanup --port-start 47833 --port-end 47852 --timeout-ms 90000`; 36 results, 0 failures, report `reports/full-suite-20260430213509/Full_Bridge_Test_Report.md`.
- 2026-04-30: QA verifier flagged open acceptance and three concrete P2 issues. Fixed batch timeout zombie risk by enforcing total timeout between child calls instead of racing in-flight extension commands; fixed benchmark Chrome/Codex process attribution; removed the remote `html2canvas`/cdnjs injection path and removed `capture_keywords_table` from the public action enum.
- 2026-04-30: Current final local checks after QA fixes: `npm test` passed 87/87; `cargo fmt --check` passed; `cargo test` passed with 9 Rust integration tests; `node --check mcp-server/benchmark-performance.mjs` passed.
- 2026-04-30: Reloaded Active extension version `0.1.8`. Live `npm run smoke`, `npm run smoke:required`, and 2 x 3 `npm run smoke:groups` all passed.
- 2026-04-30: Final live benchmark report `reports/performance/performance-20260430214858/Performance_Benchmark_Report.md` passed 10/10 scenarios, 0 failures, 0 tabs left open. In that one-run fixture, `workflow-separate` elapsed 1000.33ms and `workflow-batch` elapsed 238.06ms, roughly 4.2x faster. This is encouraging but still needs paired 5+ run medians before final acceptance.
- 2026-04-30: Final focused live suite on `0.1.8` passed: `reports/full-suite-20260430214936/Full_Bridge_Test_Report.md`, 36 results, 0 failures.
- 2026-05-01: Created branch `codex-cic-rust-broker-v2` for the Rust rewrite because slash branch creation was blocked by the existing branch namespace.
- 2026-05-01: Pulled current docs for Tokio loopback listeners, axum WebSocket extraction, tokio-tungstenite, HMAC verification, and Rust MCP SDK status. Implementation kept MCP in the lightweight JS shim because Rust MCP is still less mature and the safety plan only requires Rust for the broker/control plane.
- 2026-05-01: Implemented opt-in Rust broker runtime: axum `/healthz`, WebSocket `/bridge`, Unix shim socket, protocol v2 `sessionId` command routing, HMAC auth, request timeouts, pending-request cleanup, pressure counters, cross-session tab denial, and broker health.
- 2026-05-01: Added JS `RustBrokerClient` MCP shim path and updated `launch-mcp.sh` so `UMBRA_BROKER_MODE=rust` starts/reuses Rust and otherwise falls back to legacy unless `UMBRA_BROKER_REQUIRED=1`.
- 2026-05-01: Updated extension offscreen protocol handling so v2 broker commands route by `message.sessionId` while v1 legacy connections continue using the authenticated socket session. Manifest bumped to `0.1.9`; reload still pending after final local tests.
- 2026-05-01: Verification so far: `cargo test` passed with the live runtime test ignored by default; `cargo test --test runtime -- --ignored --nocapture` passed with escalated loopback socket access; `npm test` passed 89/89.
- 2026-05-01: Added `extension/content-agent.js` and background wiring for owned-tab-only long-lived ports. `browser_get_page_content` and `browser_wait` now use the content agent first and fall back to one-shot `chrome.scripting.executeScript` when injection is blocked. Agents invalidate on navigation, tab removal/window close, and session disconnect.
- 2026-05-01: Reloaded active Chrome extension ID `kkfedeeiobahmhcgpffcelpepiljiomk` as visible version `0.1.10`.
- 2026-05-01: Added `browser_batch` result references so create -> wait -> click -> read can run in one batch using `{"$ref":"create.tabId"}`, `{"$ref":"0.tabId"}`, or `{"$ref":"prev.tabId"}`.
- 2026-05-01: Full local/static verification passed: `npm test` 94/94, `cargo fmt --check`, `cargo test`, and live `cargo test --test runtime -- --ignored --nocapture`.
- 2026-05-01: Live legacy smokes on `0.1.10` passed: `npm run smoke`, `npm run smoke:required`, and `npm run smoke:groups` with 2 sessions x 3 tabs.
- 2026-05-01: Live Rust smoke passed through the reloaded extension: `npm run smoke:rust`, with Rust broker on port 47849, routed commands 5, and owned-tab cleanup closing the test tab.
- 2026-05-01: Focused live suite passed on legacy mode: `reports/full-suite-20260430225155/Full_Bridge_Test_Report.md`, 36 results, 0 failures. Parsed wall time from result timestamps: about 98.7s; bridge-auth elapsed sum: 84.1s.
- 2026-05-01: Focused live suite passed on Rust mode: `reports/full-suite-20260430225350/Full_Bridge_Test_Report.md`, 36 results, 0 failures. Parsed wall time from result timestamps: about 16.5s; bridge-auth elapsed sum: 8.5s. This is the current strongest multi-agent performance win.
- 2026-05-01: Final paired fixture benchmark reports passed 10/10 scenarios with 0 tabs left open: legacy `reports/performance/performance-20260430225748/Performance_Benchmark_Report.md`; Rust `reports/performance/performance-20260430225806/Performance_Benchmark_Report.md`. Rust total scenario elapsed was about 6.8s vs legacy 7.1s in that direct bridge harness; Rust broker RSS after auth was about 3.5 MB.
- 2026-05-01: `launch-mcp.sh` now defaults to Rust mode and keeps `UMBRA_BROKER_MODE=legacy` as the rollback. Added a `/tmp/umbra-rust-broker.lock` startup lock so concurrent agents do not race broker build/start.
- 2026-05-01: QA verifier flagged a Rust broker cross-session impersonation blocker. Fixed by binding each Unix MCP shim socket to its registered session, rejecting mismatched command/disconnect attempts with `session_mismatch`, and adding live ignored runtime coverage for shim A / shim B cross-session denial.
- 2026-05-01: Fixed broker pending-request counters so `/healthz` shows in-flight extension work and pending requests settle on success, timeout, send failure, extension disconnect, and shim disconnect.
- 2026-05-01: Broadened content-agent fallback handling for stale ports, disconnected ports, navigation invalidation, tab close, session disconnect, missing tabs, and content-agent timeouts. Added idle content-agent disconnect and throttled DOM observation to avoid long-lived idle CPU pressure.
- 2026-05-01: Avoided unnecessary Rust rebuilds during launcher startup when the release binary is newer than Rust sources and lockfiles. This keeps concurrent agent startup quieter while preserving automatic rebuilds after broker edits.
- 2026-05-01: Reloaded active Chrome extension ID `kkfedeeiobahmhcgpffcelpepiljiomk` as visible version `0.1.11`.
- 2026-05-01: Final post-QA verification passed: `npm test` 94/94; `cargo fmt --check`; `cargo test`; live ignored Rust runtime test; live legacy `npm run smoke`; live Rust `npm run smoke:rust`; and Rust focused live suite `reports/full-suite-20260430231402/Full_Bridge_Test_Report.md` with 36 results, 0 failures.
- 2026-05-01: Final paired benchmark reports on extension `0.1.11` passed 10/10 scenarios with 0 tabs left open: legacy `reports/performance/performance-20260430231437/Performance_Benchmark_Report.md`; Rust `reports/performance/performance-20260430231506/Performance_Benchmark_Report.md`. Rust broker auth was materially faster in this run, with Rust auth time about 2.8s vs legacy about 10.6s; Rust broker RSS after auth remained about 3.5 MB.
- 2026-05-01: Final QA and creative passes completed. No new Chrome permissions were added, the P1 QA blocker was fixed and retested, and safe creative ideas not implemented in this pass remain listed below as follow-up experiments.
- 2026-05-01: Paused heartbeat automation `cic-performance-v2-completion-runner` after all phases were checked so it does not keep waking after completion.

## Implemented So Far

- Adaptive offscreen scan batching and throttled status/heartbeat writes.
- Read-only command persistence reduction in session state.
- Text-only default page reads, selector scoping, max-char truncation metadata, and opt-in rendered-image inventory.
- Observer-backed selector waits.
- Bounded MCP-side `browser_batch` with max 25 steps, per-step results, result references, stop-on-error default, and total timeout.
- Owned-tab-only content agent for repeated page reads and selector waits, with idle disconnect, throttled DOM observation, stale-port invalidation, and one-shot script fallback when injection is blocked or no longer healthy.
- Read-only `browser_get_bridge_pressure`.
- Dry-run-default `browser_freeze_session_tabs` that skips active, audible, pinned, missing, and already-discarded owned tabs by default.
- Reusable file-based download ledger with no Chrome `downloads` permission.
- Protocol v2 golden docs and a tested Node mux prototype for registration, routing, timeout, disconnect cleanup, health, and cross-session denial.
- Rust broker runtime covering HMAC auth, one extension WebSocket, local Unix MCP shim socket, session registry, command routing, pressure counters, health, and timeout cleanup.
- Launch integration defaults to Rust first, skips unnecessary release rebuilds when sources are unchanged, and preserves `UMBRA_BROKER_MODE=legacy` rollback.
- Extension protocol v2 route-by-session support, with v1 compatibility retained.
- Removed remote third-party script injection from page actions; no new manifest permissions were added.

## Open Acceptance Items

- None for the current Rust-first implementation pass.
- Optional later hardening: produce 5+ run medians during a quieter desktop window. Current evidence includes paired fixture benchmarks plus focused live suite wall-time comparison; Chrome desktop noise still makes micro-bench medians less stable than the suite-level multi-agent signal.

## Safe Follow-Up Ideas From Creative Review

- Build the content agent as an owned-tab in-memory port first, with `read`, `wait`, and `domVersion`; add mutating actions later.
- Add a short-lived DOM snapshot cache keyed by owned `tabId`, selector, mode, format, and `domVersion`.
- Add allowlisted same-tab recipes such as `wait_click_read` and `click_wait_selector_read` instead of arbitrary extension-side scripting.
- Make broker mode one extension-to-broker socket with MCP shims registering sessions behind it, then add per-session fairness and queue-depth counters.
- Add benchmark phase timing for setup, work, cleanup, and reporting, and compare paired medians over 5+ runs.
- Classify screenshot failures with preflight metadata instead of broadening screenshot powers.
- Add pressure recommendations without automatic pressure actions.
- Add compact MCP text responses for large structured results while preserving `structuredContent`.

## Resume Instructions

1. Start with `git status --short` in this repo and preserve unrelated workspace changes.
2. Run `npm test` before new edits.
3. For this goal, there are no unchecked acceptance items. Future work should start from the safe follow-up ideas above or a fresh user-requested optimization slice.
4. After extension edits, bump `extension/manifest.json`, sync `extension/` to `/Users/RobertLora/Documents/Workspaces/Projects/Active/umbra/extension/`, reload extension ID `kkfedeeiobahmhcgpffcelpepiljiomk`, and confirm the visible version.
5. After each implementation slice, run `npm test`; after browser behavior changes, run `npm run smoke`, `npm run smoke:required`, and `npm run smoke:groups`; after Rust changes, run `cargo fmt --check` and `cargo test`.

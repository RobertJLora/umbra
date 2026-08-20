# Performance Work

What the performance passes changed, what they measured, and the rules that keep the next change from undoing it. Status: the broker rewrite is complete and is the launcher default, with the legacy bridge as a one-setting rollback.

## Objective

Cut CPU, memory, and wall-clock cost per agent round trip without touching the safety model. Owned tabs only, background-first operation, no cookie, token, password, or browser-storage tools, and conservative cleanup. Every optimization below had to leave those intact or be dropped.

## What shipped

**Offscreen scanning and status writes.** Adaptive scan batching, and status publishes that respect their throttle instead of forcing through it. The unconfigured idle branch used to force a status write every two seconds forever, which pinned the service worker and wrote to `chrome.storage.local` continuously on an install that was doing nothing.

**Cheaper page reads.** Text-only by default, selector scoping, a real `maxChars` cap with truncation metadata, and rendered-image inventory only when asked for. The payload used to be emitted twice in the same response, once as `bodyText` and once as `content`, byte-identical on every default read.

**Observer-backed waits.** Selector waits ride a `MutationObserver` rather than a poll loop.

**Bounded batching.** `browser_batch` runs up to 25 steps in one MCP call, with per-step results, result references, stop-on-error by default, and a whole-batch timeout that is now divided among the children rather than handed to each one in full.

**Owned-tab content agent.** A long-lived port per owned tab for repeated reads and selector waits, with idle disconnect, throttled DOM observation, stale-port invalidation, and a one-shot script fallback when injection is blocked. It used to re-inject a 24 KB helper script before every command, which also reset the element ref store and broke every ref-based tool.

**Lifecycle tools.** A read-only `browser_get_bridge_pressure` report, and a dry-run-by-default `browser_freeze_session_tabs` that discards idle owned tabs to release renderer memory and skips active, audible, pinned, missing, and already-discarded tabs.

**Download ledger.** File-based completion detection, so no `downloads` permission was needed.

**Rust broker.** One extension WebSocket with every session multiplexed behind it over a Unix socket, covering HMAC auth, session registry, routing, pressure counters, health, and timeout cleanup. The launcher prefers it, skips rebuilds when sources are unchanged, and falls back to legacy.

**Framing and encoding.** Buffer-based line framing on the broker client, chunked base64 for screenshots, and one compact copy of each result on the wire instead of a pretty copy plus a duplicate structured copy.

## What it measured

Broker versus legacy, on the same focused live suite of 36 cases with 0 failures:

| Measure | Legacy bridge | Rust broker |
| --- | --- | --- |
| Suite wall time | about 98.7s | about 16.5s |
| Bridge auth, summed | 84.1s | 8.5s |
| Auth on a later paired run | about 10.6s | about 2.8s |
| Broker resident memory after auth | not applicable | about 3.5 MB |

Paired fixture benchmarks ran 10 of 10 scenarios with 0 tabs left open in both modes, and total scenario time was close: about 6.8s for the broker against about 7.1s for legacy. The broker's win is concentrated in connection setup, which is exactly what multi-agent work pays over and over.

Batching, on one fixture workflow: 1000.33 ms unbatched against 238.06 ms batched, roughly 4.2 times faster. That was a single run rather than a median, and it predates the content agent, which made individual reads cheap enough that the gap narrowed. Command count still drops, which is the durable part.

Hot paths measured during the hardening pass, each in the same V8 or the same process:

| Path | Before | After |
| --- | --- | --- |
| Base64 encoding a 10 MB screenshot | 389 ms per-byte append | 54 ms chunked |
| Framing a 9.8 MB broker response | 742 ms of synchronous event-loop time | 0.4 ms to 2.1 ms |
| Reading anchor text on a 6,567-anchor page | 25.2 ms for every anchor | 0.1 ms for the 80 that survive |
| Serializing a 400-control interactive read | 193,230 bytes pretty | 123,956 bytes compact |

The framing number is the one that mattered most in practice. String concatenation plus `indexOf` per chunk flattened a rope on every one of roughly 1,200 chunks, and the cost grew quadratically with payload size rather than linearly.

## Rules for the next change

- Run `npm test` after every implementation slice, and `cargo test` from `rust-broker/` after every Rust change.
- Run `npm run smoke`, `npm run smoke:required`, and `npm run smoke:groups` after any change to browser behavior.
- The broker stays the default only while the legacy bridge keeps passing the same protocol, safety, smoke, and benchmark checks.
- No optimization adds a permission. If a faster path needs `debugger`, `downloads`, `nativeMessaging`, a cookie API, or browser storage, it is not a faster path, it is a different product.
- Benchmarks write to `reports/performance/`, which is git-ignored, because a run captures whatever pages it drove.

## Follow-ups worth taking

- A short-lived DOM snapshot cache keyed by owned tab id, selector, mode, format, and DOM version.
- More allowlisted same-tab recipes in the shape of `wait_click_read` and `click_wait_selector_read`, rather than widening arbitrary scripting.
- Per-session fairness and queue-depth counters in the broker.
- Benchmark phase timing split into setup, work, cleanup, and reporting, compared as paired medians over five or more runs. Desktop noise makes single-run micro-benchmarks less trustworthy than the suite-level signal, which is why the numbers above lead with the suite.
- Screenshot failure classification from preflight metadata, instead of broadening what screenshots are allowed to do.
- Pressure recommendations without automatic pressure actions.

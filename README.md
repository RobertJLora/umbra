# Umbra

Grok's signed-in Chrome lane. The toolbar name is Umbra. Canonical tree is `System/Umbra`. The loaded extension is `Projects/Active/umbra`. The MCP id is `umbra`. The broker socket is `/tmp/umbra-rust-broker.sock`.

The rest of this file is implementation history from the original scaffold. Codex agents should still use the official Codex Chrome Extension for Codex work. This tree is the live Umbra extension Grok drives.

The commands and behavior notes below document the retired implementation. They are not runnable task guidance and must not be imported into active skills or routing instructions.

Minimal, security-reviewed bridge between Codex and a visible Chrome profile chosen for the test or workflow.

The project is intentionally boring:

- real Chrome and explicitly chosen browser state
- multiple concurrent Codex sessions
- per-session tab ownership
- no cookie export, token extraction, CAPTCHA helpers, or generic background fetch in V1
- loopback-only local transport with an authenticated extension-to-server handshake

## Current State

Grok's live signed-in Chrome lane. Toolbar name Umbra `0.4.7`. MCP id `umbra` in `~/.grok/config.toml`. launchd `com.robertlora.umbra-broker` runs `~/.umbra/bin/umbra-rust-broker` and binds `/tmp/umbra-rust-broker.sock`. Shared key is `~/.umbra/shared-key`.

Proved 2026-08-16 from a Grok chat with the `umbra` MCP. Background load of travelbagexperts.com. Official Ahrefs organic-keywords export wrote 18 rows (`Keyword` header, modal `All 18`). Rust now claims owned tabs from `browser_tabs_context` and `browser_get_session_status`. 2026-08-17: tab create and group no longer target Meet or other non-normal windows.

Codex still uses the official Codex Chrome Extension. Do not register this tree as a Codex task browser lane.

## Pending

Load unpacked from `Projects/Active/umbra/extension`, then delete the compatibility copy at `Projects/Active/codex-chrome-bridge`. KE list plus `includeTop10` is patched in 0.4.6. Exact-URL organic-keywords CSV wait plus Sheets submit is patched in 0.4.7. Batch-analysis, content-gap, and sheets destination are still unproved live.

## Last Updated

2026-08-17. Tab create and group stay in normal Chrome windows when Meet or an app window is front. Renamed everywhere to Umbra on 2026-08-16.

## Historical Notes

This repo started as an internal V0/V1 scaffold created for the 2026-04-24 signed-in browser review.
It is designed to be auditable first and featureful second.

Older notes below may still mention Codex MCP registration. That is history. The live Grok registration is `umbra` in `~/.grok/config.toml`.

As of 2026-05-12, CiC keeps the Rust broker default and adds broker-aware jam diagnostics plus safe idle-empty shim recovery. `/healthz` reports connected empty MCP shim pressure, `npm run doctor` normalizes Rust and legacy health, and `npm run recover` safely reaps only idle `mcp-shim` sessions with no tabs, no group, no active tab, and no pending requests. Inactive CiC tabs still open in a separate grouped lane without changing the macOS frontmost app, completed successful work closes its own session-owned tabs at task finish, and safe listener cleanup no longer kills connected agent bridge sessions.

Current verification:

- MCP server dependency install completed locally.
- Unit/integration tests pass with `npm test` (`99` tests on 2026-05-12).
- Smoke test starts the loopback server, waits for the extension, then exercises create tab, list tabs, navigate, read title/URL/body text, and close tab against a local fixture page.
- A disposable Chrome profile launcher is available at `scripts/launch-test-profile.sh`.
- An automated isolated-profile smoke harness passes at `scripts/run-automated-smoke.sh`; it uses Chrome for Testing when available and CDP only to configure the unpacked extension for the test run.
- The MV3 offscreen bridge was fixed to request config/debug writes through the background worker. Chrome's offscreen document context does not expose the full extension API surface, so the background worker owns `chrome.storage`.
- Required smoke passed on 2026-04-24: two concurrent sessions on separate loopback ports, three owned tabs, correct title reads, cross-session access denied, and a controlled CSV landed in `/Users/RobertLora/Documents/Downloads/`.
- Signed-in reuse smoke passed on 2026-04-24 with `npm run smoke:auth`: the bridge reached `https://app.ahrefs.com/dashboard`, read title `Dashboard - Ahrefs`, and closed the test tab. The smoke only checks URL/title so it does not dump signed-in page content.
- Group stress smoke passed on 2026-04-24 with five concurrent sessions, eight tabs per session, forty total tabs, five visible Chrome tab groups, clean group labels, correct title reads from every owned tab, and cross-session reads denied.
- Ahrefs signed-in CSV export passed on 2026-04-24 through the bridge in Robert's primary Chrome: Top Pages for `adaptivesecurity.com`, CSV UTF-8, all 138 rows, saved to `/Users/RobertLora/Documents/Downloads/` in about 10 seconds.
- The MCP server exits on stdio/client disconnect and parent-process loss to reduce abandoned listener buildup when subagents or Codex sessions close.
- Apr 27 safe-recovery patch passed in both canonical and loaded Active trees (`npm test`, 31/31): each listener now exposes `GET /healthz`, the launcher uses guarded low-port cleanup only when ports are scarce, and active or unknown listeners are preserved instead of broad-killing the full `47821-47852` range.
- Cleanup now has separate lanes: `npm run cleanup:test` preserves the registered `47821` listener and clears only disconnected bridge test listeners, `npm run cleanup:test:force` clears all non-`47821` bridge listeners, and `npm run cleanup:headless` removes only stale headless automation Chrome roots from known Codex/Browser Use profile paths.
- Active-agent cleanup regression passed on 2026-04-29: a real connected `node index.js` bridge on `47824` survived `npm run cleanup:test`, was skipped with `skipReason: extension_connected`, and remained connected after cleanup.
- Full-suite runner added on 2026-04-24: `npm run suite -- --suites baseline,concurrency,ahrefs,social,research,downloads,seo,cleanup`.
- Focused full-suite lanes passed on 2026-04-24: baseline/SEO, downloads, concurrency, social/research, Ahrefs exports, and cleanup. The clean report folders are under `reports/main-*-final-*`, `reports/main-ahrefs-retest2-*`, `reports/full-suite-20260424214958`, and `reports/subagent-concurrency-*`.
- Ahrefs focused export retest passed on 2026-04-24 for `adaptivesecurity.com`: Overview text/html, Top Pages CSV, Organic Keywords CSV, and Refdomains CSV landed in `/Users/RobertLora/Documents/Downloads/`.
- A single all-in-one stress run after repeated Ahrefs exports hit CSV timeouts. Treat rapid repeated Ahrefs export bursts as a Chrome/Ahrefs download-throttling risk; use focused lanes or add cooldowns for heavy export testing.
- The extension is loaded unpacked from the canonical Active path. Its current Chrome ID is discovered from the registered path instead of treated as a permanent identifier.
- The loaded extension path is `/Users/RobertLora/Documents/Workspaces/Projects/Active/umbra/extension`; the Active bridge directory is a real loaded copy synced from this canonical `System/Codex` bridge. A symlinked loaded path was rejected after a live Chrome reload got stuck/off on 2026-04-25.
- When changing extension code, bump `extension/manifest.json`, sync both the code and manifest into the loaded Active extension path, then reload the matching unpacked extension yourself with Computer Use when that surface is exposed and safe. Locate it by the registered Active path, click the extension card reload control, and verify the visible version. Ask Robert to reload only when Computer Use is unavailable or the foreground is unsafe.
- On 2026-04-25 the visible workflow was renamed to Umbra (`CiC`), with `Codex Bridge` retained only as an accepted alias.
- New session groups are named by default, including one-tab sessions, and use Chrome's `cyan` group color unless explicitly overridden.
- Successful task completion should close the session's whole owned tab group. Clean MCP shutdown also closes owned session tabs by default as a safety net to reduce Chrome CPU/RAM buildup. Set `UMBRA_KEEP_TABS_OPEN=1` or `UMBRA_CLOSE_ON_SHUTDOWN=0` only when a run should leave tabs visible for inspection.
- Cleanup defaults are conservative: clear stale test listeners/processes automatically where safe, but close visible Chrome tabs only by session ownership at workflow finish. Same-title stale group cleanup is manual/opt-in because another agent may be paused in a similarly named group.
- `browser_close_session_tabs` is the normal successful-task cleanup path: it closes every tab owned by the current session through the extension. It closes a whole window only when every tab in that window is owned by the session, so unowned blank tabs are preserved.
- Live focus smoke passed on 2026-04-29: a local fixture opened as an inactive tab in a collapsed `CiC Focus Test` group, page-content read succeeded, `browser_close_session_tabs` removed the owned tab/group, and macOS frontmost app stayed `ghostty` before auth, after create, after read, and after close.
- If Chrome gets stuck with CiC disabled after an extension reload, use Chrome `Load unpacked` against the Active extension folder to recover the original ID. Avoid symlinked loaded paths and avoid direct Chrome profile preference edits.
- Apr 26 crash investigation: a normal Chrome launch from automation died in macOS app registration (`HIServices` / `TransformProcessType`) before the page or extension layer meaningfully ran. Treat that class of crash as a launch-path issue first, not an extension regression. For CiC, prefer already-running signed-in Chrome; for automated tests, use Chrome for Testing or a fresh isolated profile.
- Rust broker verification passed on 2026-05-01: `cargo fmt --check`, `cargo test`, and the live ignored Rust runtime test all passed. The final Rust focused suite passed with 36/36 checks in `reports/full-suite-20260430231402/`.
- Final paired benchmarks on extension `0.1.11` passed 10/10 scenarios with 0 leftover tabs: legacy `reports/performance/performance-20260430231437/`, Rust `reports/performance/performance-20260430231506/`. Rust broker auth was materially faster in that run, and Rust broker RSS after auth stayed around 3.5 MB.
- V1.6 verification passed on 2026-05-06: `npm test` 98/98, `cargo fmt --check`, `cargo test`, `npm run doctor`, `npm run release:check`, `npm run smoke`, `npm run smoke:required`, reduced `npm run smoke:groups`, `npm run smoke:rust`, and `npm run bench` 15/15 with 0 leftover tabs. A clean custom focus smoke kept the macOS frontmost app on Codex through create, interactive read, ref click, recipe, and cleanup.
- Rust-broker robustness verification passed on 2026-05-12: `npm test` 99/99, `cargo fmt --check`, `cargo test`, `npm run doctor`, `npm run doctor -- --fix --verify-health --ttl-ms=0 --min-age-ms=0`, `npm run smoke:rust`, and a local broker-client Leica search read/close. The direct registered CiC MCP tools were not exposed in this turn, so the Leica verification used the local broker client instead of the in-chat registered tool surface. The recovery proof reaped only connected empty `mcp-shim` sessions and left the protected extension session plus visible tabs intact.

The bridge is now viable for signed-in tab control in Robert's primary Chrome profile. Download handling remains file-ledger based: initiated downloads can land in `/Users/RobertLora/Documents/Downloads/`, and `browser_wait_for_download` can wait for stable files without adding Chrome's `downloads` permission.

## V1 Tool Surface

- `browser_navigate`
- `browser_list_tabs`
- `browser_find_tabs`
- `browser_adopt_tab`
- `browser_find_groups`
- `browser_adopt_group`
- `browser_get_session_status`
- `browser_create_tab`
- `browser_group_tabs`
- `browser_switch_tab`
- `browser_close_tab`
- `browser_close_session_tabs`
- `browser_freeze_session_tabs`
- `browser_cleanup_groups`
- `browser_screenshot` (`outputPath` optionally saves the PNG locally and returns the path/byte count)
- `browser_get_page_content`
- `browser_read_interactive`
- `browser_get_bridge_pressure`
- `browser_get_technical_snapshot`
- `browser_batch`
- `browser_run_page_action`
- `browser_click`
- `browser_click_text`
- `browser_fill`
- `browser_press_key`
- `browser_scroll`
- `browser_wait`
- `browser_wait_click_read`
- `browser_navigate_wait_read`
- `browser_click_wait_selector_read`
- `browser_wait_for_download`
- `browser_mark_debug_group`

`browser_get_page_content` defaults to text-only reads and supports selector scoping plus `maxChars` truncation. Set `includeImages: true` only when the compact visible-image inventory is needed.

`browser_batch` runs bounded create/navigate/wait/read/click/fill/press/scroll/close-style workflows locally in one MCP call. It supports result references such as `{"$ref":"prev.tabId"}`, `{"$ref":"0.tabId"}`, and `{"$ref":"create.tabId"}`.

`browser_get_bridge_pressure` is read-only and reports current sessions, owned tabs/windows, connected listeners, content-agent counts, storage-write counters, discard candidates, and cleanup/freeze suggestions.

`browser_freeze_session_tabs` discards owned inactive tabs with `chrome.tabs.discard` to release renderer memory. It defaults to `dryRun: true` and never targets unowned tabs.

`browser_get_session_status` is a read-only ownership and cleanup report. Use it when an agent needs to tell Robert which group/tabs it owns and whether closing owned tabs would remove whole CiC windows or preserve mixed windows.

`browser_find_tabs` lists existing Chrome tabs by title or URL without claiming ownership. `browser_adopt_tab` claims a specific non-internal tab into the current session so normal session-owned read tools can inspect an already-open page. Use this for Robert-created research tabs when opening a duplicate URL does not hydrate the same state.

`browser_find_groups` lists visible Chrome tab groups with session ownership status. `browser_adopt_group` adopts an existing group only when its tabs are not owned by another live session. This is the resume path for paused visible CiC groups without adding cross-session adoption by default.

`browser_read_interactive` returns a compact list of visible controls with short-lived refs tied to the current DOM version. `browser_click`, `browser_fill`, `browser_scroll`, and `browser_screenshot` can use those refs; stale refs return an error that tells the caller to read again.

`browser_wait_click_read`, `browser_navigate_wait_read`, and `browser_click_wait_selector_read` are MCP-local recipes built from existing safe tools. They reduce round trips without exposing arbitrary JavaScript.

`browser_wait_for_download` is MCP-local and uses the existing file ledger under `/Users/RobertLora/Documents/Downloads/`; the Chrome extension still does not request the `downloads` permission.

`browser_mark_debug_group` renames the current group with a `Debug` suffix for failed workflow inspection. Successful workflows still close owned tabs by default.

`browser_run_page_action` runs predefined JavaScript actions in a session-owned page and returns JSON-safe output. Use it for render-state probes, Ahrefs element-position discovery, table row limiting, table scrolling, control inspection/clicking, and row restoration. It stays background-first unless `activate: true` is passed. It intentionally does not expose arbitrary JavaScript or the older remote html2canvas keyword-table capture path.

## Non-Goals For V1

- cookie dump or sync
- token extraction
- storage read/write tools
- background network fetch
- CAPTCHA automation
- bookmarks, history, clipboard helpers
- native messaging
- auto-update, auto-pull, or auto-install behavior

## Layout

- `extension/` - MV3 extension with background worker, offscreen bridge, and minimal popup
- `mcp-server/` - local stdio MCP server plus authenticated local WebSocket bridge
- `tests/` - auth, ownership, and session-isolation coverage
- `scripts/` - local helpers, including the isolated Chrome test-profile launcher
- `docs/` - architecture, permissions, and install notes
- `THREAT_MODEL.md` - security assumptions and attacker model
- `SECURITY_REVIEW.md` - findings, decisions, and review checklist
- `MCP_PROTOCOL.md` - local bridge protocol between the extension and the MCP server

## Current Architecture

1. Codex talks to the local MCP server over stdio.
2. Each Codex session starts one local bridge server on `127.0.0.1` inside a narrow configured port range.
3. The Chrome extension offscreen document scans only that configured range on loopback.
4. The extension authenticates each connection with an HMAC challenge using a shared install key plus per-session nonces.
5. The background worker assigns each session its own tab group and enforces tab ownership checks before every action.

## Concurrency Model

- One signed-in Chrome profile can host many bridge sessions at once.
- Each Codex agent/session gets one local MCP server process, one session ID, one loopback port, and one named cyan Chrome tab group in the dedicated CiC Chrome window.
- In Rust broker mode, the extension uses one broker WebSocket while local MCP shims register sessions behind it over a local Unix socket. The broker owns routing, auth, pressure counters, and request cleanup; the JS extension still owns all Chrome APIs and tab-ownership enforcement.
- The extension remembers a dedicated CiC Chrome window and routes new session tabs there. Background CiC refuses to reuse that remembered window if it is currently focused, so it does not add tabs to Robert's active Chrome window.
- Opening, navigating, and DOM interaction tools are background-first. `browser_create_tab`, `browser_navigate`, `browser_run_page_action`, `browser_click`, `browser_click_text`, `browser_fill`, `browser_press_key`, and `browser_scroll` default to inactive tabs; callers must pass `activate: true` when foreground focus is intentionally needed.
- `browser_run_page_action` includes `inspect_controls` and `click_control` for pages where generic selector/text clicks are ambiguous. Use `inspect_controls` to list candidate controls with text, aria label, selector hint, and rect, then click the returned `domIndex` with `click_control`.
- Navigation is scheme-limited at the extension boundary. CiC allows `http:`, `https:`, `file:`, and `about:blank`; it rejects risky schemes such as `javascript:` or `data:` before Chrome navigation.
- Avoid foregrounding Robert's active Chrome window for routine work. Prefer DOM/page-content reads before screenshots, because screenshot capture still needs the session-owned tab to be visible.
- For screenshot artifact workflows, pass `outputPath` to `browser_screenshot`. Without it, MCP-compatible responses expose the screenshot as image content and keep only lightweight structured metadata, which is not enough for scripts that need a saved PNG.
- Normal CiC work should not use timer-based tab cleanup, but it should close owned tabs/windows at true task completion.
- At task finish, the owning agent should call `browser_close_session_tabs` unless the task explicitly needs a debug/inspection group left open. This closes the whole owned group without requiring Robert to ask for cleanup.
- For failed workflows that need inspection, use `browser_mark_debug_group` to make the visible group obvious, then leave it open intentionally.
- If tabs must remain visible, use the keep-open escape hatch for that run and report the group name clearly. Long-lived visible groups should be exceptional because too many open CiC windows can bloat Chrome CPU/RAM.
- The extension scans the configured port range and connects to every authenticated session it finds.
- `browser_list_tabs` returns only the tabs owned by that session.
- Mutating or reading another session's tab is rejected by ownership checks.
- The registered MCP server may legitimately occupy `47821` while Codex is running; ad hoc smoke tests should let the bridge auto-select inside the configured range.
- Default configured range is `47821-47852`. This gives normal multi-agent work enough room that CiC should not become artificially "full" during ordinary use.
- Avoid listener cleanup as a routine recovery step. Use `npm run listeners` first and only clear listeners when they are confirmed stale. Each listener exposes `GET /healthz`; the launcher uses that to recycle only old disconnected listeners when free ports are low. `npm run cleanup:test` preserves the normal `47821` registered MCP listener and clears only disconnected non-`47821` listeners so active agent bridge sessions stay alive. Use `npm run cleanup:test:force` only when deliberately clearing all non-`47821` bridge listeners. `npm run cleanup` kills every bridge listener in `47821-47852`.
- Use `npm run doctor` for read-only bridge health. It reports Rust broker sessions, connected empty shim pressure, pending requests, and the recommended recovery action. Use `npm run recover` for safe recovery: it runs `doctor --fix --verify-health` and reaps only idle empty `mcp-shim` sessions that have no pending requests, no owned tabs, no group, and no active tab. It does not close visible tabs. Use a hard process refresh only when the broker itself is stale or unreachable, and expect any current Codex MCP handle to need a fresh session afterward.
- CiC should use visible Chrome, never a headless Chrome lane. If old automation runs leave high-CPU hidden Chrome processes behind, first run `npm run cleanup:headless:dry`, then `npm run cleanup:headless` only when the matches are stale automation roots from `agent-browser-profile-*`, `.chrome-cdp-profile12-lanes/`, or `browser-use-user-data-dir-*`.
- Port-range changes require both sides to reload: restart Codex so new MCP server processes inherit the updated env, and reload the unpacked Chrome extension so persisted extension storage is normalized by the latest `extension/shared.js`.

## Known Limitations

- Screenshots activate the session-owned tab before capture. The extension uses broad host permission for this instead of Chrome's `debugger` permission.
- Slack search pagination is a known case where generic text clicks can hit the wrong control. Use `inspect_controls` / `click_control` and page-content reads instead of screenshots or broad foreground clicks.
- Broad host permissions are still required for arbitrary signed-in browsing and visible-tab screenshots; they are documented and must be explicitly justified.
- Download detection remains file-ledger based without Chrome's `downloads` permission.
- `browser_read_interactive` is intentionally compact; CiC does not expose a full accessibility-tree dump.
- The automated smoke uses a fresh isolated profile by default to avoid Chrome profile-version collisions.
- Normal `/Applications/Google Chrome.app` ignored command-line unpacked-extension loading in local tests; Chrome for Testing worked for automation.
- This scaffold is not yet a full production sign-off. Read `SECURITY_REVIEW.md` before real use.

## Pending

No active focus/cleanup, connected-agent availability, Rust-broker acceptance, V1.6 benchmark, or idle-empty shim recovery blocker remains after the 2026-05-12 robustness verification. Remaining backlog:

- In a fresh Codex/MCP session, confirm the direct registered CiC tools expose the current surface again. This turn proved Leica read/close through the local broker client because the registered tools were not exposed in-chat.
- V1.6 implements conservative group find/adopt. Future work should only broaden adoption if a real workflow needs it.
- Produce 5+ run medians during a quieter desktop window if tighter performance trend evidence is needed beyond the current paired benchmark, focused-suite, and V1.6 benchmark reports.
- Consider only benchmark-proven follow-up optimizations; V1.6 already includes the short-lived read cache, same-tab recipes, and queue-depth/fairness counters.

## Last Updated

2026-04-29 - Captured safe disconnected-only listener cleanup plus live CiC focus smoke as the current bridge state.
2026-04-29 - Added CiC hardening tests, read-only session status reporting, URL scheme guards, and an env parsing fix. `npm test` now covers 62 passing tests across MCP, extension, cleanup, lifecycle, and integration contracts.
2026-04-30 - Added control-inspection page actions for ambiguous UI controls such as Slack pagination. Reloaded the unpacked extension to version `0.1.5`; `npm test` passed 65 tests.
2026-04-30 - Added existing-tab find/adopt tools for cases where Robert already has a hydrated Chrome tab and duplicate background URLs do not recreate that state. Reloaded the unpacked extension to version `0.1.6`; `npm test` passed 65 tests.
2026-05-01 - Completed CiC Performance V2: Rust broker default with legacy rollback, owned-tab content agent, batch refs, pressure/freeze/download-ledger tools, extension `0.1.11`, `npm test` 94/94, Rust tests, live legacy/Rust smokes, focused suite 36/36, and final paired benchmarks.
2026-05-06 - Completed CiC V1.6 verification on extension `0.1.12`: `npm test` 98/98, Rust checks, doctor/release checks, live smokes, clean focus smoke, and `npm run bench` 15/15 with 0 leftover tabs.
2026-05-12 - Hardened Rust broker lifecycle after connected empty shim sessions jammed CiC. Added session activity metadata, `/healthz` diagnostics, safe idle-empty shim reaping, `npm run recover`, doctor Rust-health normalization, JS shim reconnect, and tests for preserving tabs/pending sessions. Direct registered CiC MCP tools were not exposed in this turn, so final Leica read/close proof used the local broker client.

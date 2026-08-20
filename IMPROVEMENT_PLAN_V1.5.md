# Umbra (CiC) – Improvement Plan V1.5 → V2.0

**Author**: Claude (Opus 4.7, ultrathink pass)
**Date**: 2026-05-06
**Audience**: Robert + senior engineer review
**Scope**: `umbra` repo at `System/Codex/umbra/`. Improving the working extension/MCP-server/broker stack, not greenfielding.
**Status**: Plan, not ready-to-execute. Several proposals are gated on explicit yes/no calls.

---

## TL;DR

CiC nailed the trust boundary in V1: per-session tab ownership, HMAC-authenticated loopback, Rust broker, no cookie/token/fetch tools, 94 passing tests, real signed-in Chrome, 27 tools live. The next leverage is not more capability – it's **closing the agent's per-round-trip cost**. Today every Codex round-trip spends tokens re-finding elements, rescreenshotting whole tabs, and rebuilding state the bridge already had a moment ago. V1.5 should attack that loop with five changes, in priority order: (1) accessibility-tree reads with stable element refs, (2) idempotent batch contracts and replay tokens, (3) debugger-based screenshot path that doesn't steal focus, (4) reattach/resume for named groups across Codex sessions, (5) opt-in scoped console + same-origin network capture under the existing ownership rules. Nothing in this plan expands the credential blast radius beyond what V1 already documents. Three of the five lift directly from CiC's own backlog.

---

## What I read before proposing

- `README.md` (state-of-the-bridge as of 2026-05-01, V1.11 extension, 94 tests)
- `MCP_PROTOCOL.md` (v1 legacy + v2 broker handshake, broker shim socket)
- `THREAT_MODEL.md` (assumed attackers, explicit non-goals, open questions)
- `SECURITY_REVIEW.md` (keep/remove/rewrite matrix, upstream audit findings)
- `docs/architecture.md`, `docs/permissions.md`
- `extension/manifest.json` (current permissions, CSP, version)
- `mcp-server/tools.js` (24 tool registrations + `browser_batch` MCP-local)
- `Codex_Browser_Recommendation.md` (the strategic recommendation that scoped V1)
- For comparison: Anthropic's Claude in Chrome tool surface (read_page, find, form_input, file_upload, javascript_tool, read_console_messages, read_network_requests, gif_creator, list/select/switch_browser, shortcuts_list/execute, hover, scroll_to ref). Plus the issue tracker for OpenAI Codex feature request #8953 and the Chromex / loltek bridge designs.

This plan is shaped to the bridge that exists, not the one I wish existed.

---

## Diagnostic – evidence-based pain points

Pulled from the README, `Codex_Browser_Recommendation.md`, the threat model, and the public Codex+Chrome conversation. Each pain point is something the agent or operator hits during real workflows, not a hypothetical.

| # | Pain | Evidence | Cost shape |
|---|------|----------|-----------|
| 1 | Screenshot focus theft | README L141, L156. `chrome.tabs.captureVisibleTab` activates the session-owned tab. `debugger` rejected for V0. | UX (steals macOS frontmost), agent loop (forced foreground side effects) |
| 2 | Element targeting brittleness | `browser_run_page_action` + `inspect_controls` + `click_control` exist precisely because generic text/selector clicks are ambiguous (Slack pagination, Ahrefs controls). README L138, L157. | Tokens (multi-round inspect-then-click), reliability |
| 3 | Page content reads are text-only | `browser_get_page_content` defaults text, supports `selector` + `maxChars`. No accessibility tree, no role/aria info, no stable element references for follow-up actions. README L87. | Tokens (raw text vs structured), determinism |
| 4 | No reattach/resume of named groups | Listed in README "Pending" L168. A second Codex session cannot reconnect to a paused or earlier visible CiC group as if it were a fresh task. | Workflow (operator restart = lost context) |
| 5 | Ahrefs export throttling | README L43 + L160. Rapid all-in-one stress run after repeated Ahrefs exports hit new-CSV timeouts. Use focused lanes or cooldowns. | Reliability (test runs flake) |
| 6 | Download detection is file-ledger | README L58. Extension doesn't request `downloads` permission, no first-class completion event. | Reliability (timeouts, race conditions) |
| 7 | DOM reads are not cached | "Consider safe follow-up optimizations: short-lived DOM snapshot cache" - README L170. | Tokens, latency |
| 8 | No same-tab recipes | "Same-tab recipes like `wait_click_read`" - README L170. Each agent round-trip is one tool. | Tokens (3 calls vs 1), latency |
| 9 | Single-profile assumption | Whole bridge targets Robert's primary signed-in Chrome. No story for client-isolated profiles (TBE personal vs uSERP work vs client tabs). His own auto-memory `reference_chrome_clone_janitor.md` documents Chrome profile clone leaks; cs1/cs2 swap is a documented daily routine. | Workflow (client mixing risk) |
| 10 | Idempotency is implicit | Protocol carries `id` but commands aren't deterministically replayable. A retried navigate could double-fire if the prior result was lost. | Reliability under flake |
| 11 | No console / scoped network read | Both V1 non-goals. But for frontend debugging on session-owned tabs (not generic egress), agents currently work blind. | Capability gap |
| 12 | Cleanup is operator-aware, not Codex-aware | `browser_close_session_tabs` is the documented success-finish hook, but if Codex stops mid-task the cleanup contract isn't tied into Codex's own approval/lifecycle. | UX (leftover tabs + bloat) |
| 13 | Permission scope is binary | `<all_urls>` or nothing. Future allowlist mode "is worth planning" - threat model L86. | Defense-in-depth |
| 14 | Install/upgrade is manual | Extension reload by hand at `chrome://extensions/?id=…`, sync between canonical and Active path, version bump dance. README L46. | Operator burden, regression risk |
| 15 | No first-class metric for round-trip cost | Paired benchmarks compare legacy vs Rust broker on auth + RSS, but there's no per-workflow metric like "MCP round-trips per Ahrefs Top Pages export." | Improvement is hard to measure |

These map to five themes. Themes become pillars below.

---

## Architectural thesis

> CiC's trust boundary is well-drawn. Its ownership model is sound. The remaining cost is concentrated in the **agent's round-trip economy** – how much work each MCP call does, how stable the references between calls are, and how the lifecycle survives churn. The right V1.5 doesn't add capability surface; it makes each existing primitive carry more state forward.

This thesis matters because it tells the senior engineer what we are *not* doing: not a feature land grab, not an "every Claude in Chrome tool ported," not a rewrite. It's a sharpening pass.

A second-order claim: every proposal below is auditable as a strict subset of operations the bridge already mediates on session-owned tabs. None of them give the extension new credential-adjacent reach. The V1 non-goals (cookies, tokens, storage, generic fetch, native messaging, auto-update, CAPTCHA) all stay out.

---

## Top 3 keystones (the bet)

If only three changes ship, ship these. Everything else in the plan composes off them.

### Keystone A – Accessibility-tree page reads with stable element refs

A new `browser_read_page` tool that returns a structured AX tree (filterable to `interactive` only), each node carrying a stable `ref_xx` ID that subsequent tools (`browser_click`, `browser_fill`, `browser_run_page_action`) can target by ref instead of selector or visible text. Refs survive within the same DOM version; they invalidate cleanly on navigation or DOM-version change.

Why it's keystone:
- Eliminates the Slack-pagination and Ahrefs-control class of bug structurally, not case-by-case.
- Every other proposal becomes cheaper (find-by-ref is one round-trip; find-by-NL becomes opt-in).
- No new permissions: the AX tree is already accessible to scripts that the extension is allowed to inject, and only on session-owned tabs.

### Keystone B – Idempotent commands with replay tokens + true batch ergonomics

Each command optionally carries an `idempotency_key`. The extension keeps a small per-session ring buffer mapping `idempotency_key → result`. A retried command with the same key returns the prior result without re-executing. `browser_batch` already exists, but its $ref system stops at the params layer; extend it so batched steps emit `idempotency_key`s automatically, and let the broker degrade gracefully – if the WebSocket drops mid-batch, the next reconnect can fast-forward through completed steps.

Why it's keystone:
- The known Ahrefs export flake (pain #5) becomes safe to retry instead of needing manual cooldowns.
- Service-worker suspend/resume (threat model risk) becomes a non-event for in-flight batches.
- Sets up the resume/reattach work in keystone… not C, but Pillar 3.

### Keystone C – Debugger-attached screenshot path with explicit consent banner

Today: `chrome.tabs.captureVisibleTab` requires the tab to be foregrounded, which steals macOS focus. V1 explicitly defers `chrome.debugger`. Proposal: add an opt-in `browser_screenshot_silent` that, on first use per Chrome session, asks Robert to accept the standard "Chrome is being controlled" debugger banner, then never steals focus again for capture. The banner is the security signal; it's actually *more* visible than the silent foreground-tab activation we have today.

Why it's keystone:
- Pain #1 is the most-cited UX wart in the README. Operators stop trusting "background-first" if screenshots break that promise.
- Without it, every "verify the result" round-trip is forced to the foreground.
- Bounded: only screenshots, not arbitrary debugger commands. Existing visible-tab fallback stays as the default.

---

## Five pillars

Each pillar bundles 2-5 concrete proposals. Each proposal carries:
- **Problem** (the specific pain it addresses)
- **Proposal** (what to build)
- **Effort** (S = days, M = 1-2 weeks, L = month+)
- **Impact** (Low/Med/High on agent loop or operator UX)
- **Security delta** (none/low/med – low or higher requires a callout)
- **Metric** (how we'll know it worked)

### Pillar 1 – Element grounding

Today's brittlest layer. Pillar 1 makes element targeting deterministic.

#### 1.1 `browser_read_page` (Keystone A)
- **Problem**: Pain #2, #3. No structured AX tree.
- **Proposal**: New tool returning `{ root, nodes: [{ ref, role, name, value, rect, attrs, childrenRefs }], domVersion }`. Modes: `all` / `interactive` / `landmarks`. `maxNodes` and `selector` scoping. Optional `includeText: true` for body-text passthrough.
- **Effort**: M. Reuses `chrome.scripting.executeScript` plus an AX walker; piggybacks on the existing content-agent connection where available.
- **Impact**: High.
- **Security delta**: None. Same data as `getPageContent` + DOM, structured. Session-owned tabs only.
- **Metric**: Median MCP round-trips for a "click the third row in this Ahrefs table" task drops from 3-4 (inspect_controls → click_control → verify) to 1-2 (read_page filtered + click_ref).

#### 1.2 `browser_find` – natural-language element search
- **Problem**: When AX tree is large, agents waste tokens scanning it.
- **Proposal**: Tool takes a query like "the Export CSV button" plus a `tabId`. Server-side runs a small ranking pass over the AX tree (role + name + visible text + proximity to landmark). Returns up to N candidate refs. Pure read, no model call needed inside the bridge.
- **Effort**: S (heuristic ranker; we are not embedding-grading).
- **Impact**: Med (mostly token saving on large pages).
- **Security delta**: None.
- **Metric**: Tokens spent in element-targeting < 50% of `read_page` payload on a sample of 5 workflows.

#### 1.3 Ref-aware `browser_click`, `browser_fill`, `browser_run_page_action`
- **Problem**: Existing tools take selectors or text; refs are strictly stronger.
- **Proposal**: Add optional `ref` param to existing tools. Selector stays as fallback. On stale ref (DOM-version mismatch) return a typed error so the agent knows to re-read.
- **Effort**: S (additive).
- **Impact**: High when paired with 1.1.
- **Security delta**: None.
- **Metric**: Stale-ref retry rate < 5% on stable apps; failure-recovery is one round-trip not three.

#### 1.4 Hover + scroll_to_ref
- **Problem**: Tooltips, drop-down reveals, and "scroll element into view before click" are all common.
- **Proposal**: `browser_hover(ref|coordinate)` and `browser_scroll_to(ref)`. Both background-first.
- **Effort**: S.
- **Impact**: Med.
- **Security delta**: None.
- **Metric**: Workflows that today use `browser_run_page_action` with `inspect_controls` to hover-reveal collapse to one tool call.

### Pillar 2 – Round-trip economy

Make each call carry more weight forward; don't pay twice for the same state.

#### 2.1 Idempotency keys + result replay (Keystone B)
- **Problem**: Pain #5, #10. Retries are unsafe.
- **Proposal**: Extend `command` envelope with `idempotency_key`. Per-session ring buffer (default size 64) maps key → cached result for 60s. On retry: same key returns cached result. Distinct key = re-execute. `browser_batch` auto-generates keys per child step.
- **Effort**: M.
- **Impact**: High.
- **Security delta**: None (the cache holds only what the agent already has). Memory bounded.
- **Metric**: Mid-flight reconnect during an Ahrefs export does not duplicate the export.

#### 2.2 Same-tab recipe primitives (`wait_click_read`, `fill_submit_wait`, `navigate_wait_read`)
- **Problem**: Pain #8.
- **Proposal**: Three composed tools that the broker resolves locally without a per-step round-trip. Each has typed params; under the hood they reduce to existing primitives.
- **Effort**: S each (reuse `browser_batch` plumbing).
- **Impact**: High on workflows with deterministic shape.
- **Security delta**: None (same primitives, repackaged).
- **Metric**: Median round-trips per "open page, click X, read Y" workflow drops from 4 to 1.

#### 2.3 Short-lived DOM snapshot cache (already in backlog)
- **Problem**: Pain #7. Every read re-pays for the same snapshot.
- **Proposal**: Per-tab DOM-version-keyed cache, default 1.5s TTL, invalidated on any mutation tool, on `browser_navigate`, or on detected `MutationObserver` activity over a threshold. Cache stores AX tree, page text, and element rects.
- **Effort**: M.
- **Impact**: High.
- **Security delta**: None (memory-bounded, session-scoped).
- **Metric**: P50 latency of `read_page` after first read on the same DOM-version drops 5-10x.

#### 2.4 Region-of-interest screenshot
- **Problem**: Sending a 1440×900 PNG when a 200×200 region tells the story burns tokens.
- **Proposal**: `browser_screenshot` accepts `ref` or `region: {x, y, w, h}`. Crop happens in the extension before encoding. Default keeps full-tab.
- **Effort**: S.
- **Impact**: Med.
- **Security delta**: None.
- **Metric**: Median screenshot bytes per call drops 70% on a sample of 5 verification workflows.

#### 2.5 Network-aware `browser_wait`
- **Problem**: `browser_wait` is time-based today (implicit from naming). Time-waits flake.
- **Proposal**: Wait predicates: `wait_for_ref_visible`, `wait_for_url_match`, `wait_for_dom_idle` (no mutations for N ms), `wait_for_response_count_increase` (network-scoped only on owned tabs - see 5.2 for the network reads).
- **Effort**: M.
- **Impact**: High on flakey SPAs.
- **Security delta**: Low. Pre-requires Pillar 5.2 if the network predicate is wanted.
- **Metric**: Ahrefs export flake rate (currently real per pain #5) drops to near zero with `wait_for_response_count_increase` on the export endpoint.

### Pillar 3 – Resilient lifecycle

Make sessions and tab groups survive churn the way the threat model already promised they would.

#### 3.1 Resume / reclaim named groups (already in backlog)
- **Problem**: Pain #4.
- **Proposal**: New tool `browser_attach_to_group({ groupName | groupId })`. The extension adopts every tab in that group into the calling session, taking ownership atomically. Refuses if any tab is currently owned by another live session. Ownership transfer is logged. Pairs with a new MCP server config flag `UMBRA_REATTACH_ON_START` to make resumption automatic.
- **Effort**: M.
- **Impact**: High on long workflows.
- **Security delta**: Low – cross-session adoption needs a clear consent step. Recommend the rule "only adopt a group whose name matches the new session's prefix."
- **Metric**: Successful resume after Codex CLI restart in 5/5 manual scenarios.

#### 3.2 Service-worker watchdog with structured restart
- **Problem**: Threat model "service worker suspend/resume" risk; offscreen + background do best-effort but aren't measured.
- **Proposal**: Heartbeat between offscreen and background every 15s. If background dies, offscreen logs a structured restart event (sequence number, last-known sessionIds, last-known tab ownership). On wake, background re-reads ownership from `chrome.storage` and reconciles. Reconciliation result surfaces in `browser_get_session_status`.
- **Effort**: M.
- **Impact**: Med.
- **Security delta**: None.
- **Metric**: Suspend/resume test (force-suspend the SW via `chrome://serviceworker-internals`) returns to ready in < 3s with full ownership preserved across 10 trials.

#### 3.3 Ahrefs/3p throttle-aware retry
- **Problem**: Pain #5.
- **Proposal**: A small "burst-aware" wait helper specifically for repeated CSV exports. It is just a politeness layer: detect "previous export within 8s on same domain" and inject a 5s cooldown on the *next* export call. Configurable per host. Not a full rate limiter; just stops the known Ahrefs throttle from biting tests.
- **Effort**: S.
- **Impact**: Med (only affects test runs and stress sessions).
- **Security delta**: None.
- **Metric**: Stress runs that previously timed out finish; retry budget shrinks.

#### 3.4 Multi-profile awareness
- **Problem**: Pain #9. Bridge addresses a single signed-in Chrome.
- **Proposal**: Bridge identifies the Chrome profile it is loaded into (use a deterministic profile fingerprint such as `userInfo()` email + `chrome.identity.getProfileUserInfo` if available, plus extension install path). MCP tool `browser_describe_profile()` returns it. Codex side can then pick which CiC instance to address (e.g., "uSERP work" vs "personal"). The lateral piece is a second loaded copy of the extension in a second Chrome profile, listening on a different port range. Pure config.
- **Effort**: M.
- **Impact**: High for agency workflows; Med for solo users.
- **Security delta**: Low. Surface stays the same per profile; cross-profile adoption is not allowed.
- **Metric**: Two CiC instances run side-by-side without touching each other's tabs in 5/5 trials.

### Pillar 4 – Targeted observability and rollout safety

This pillar is what lets the senior engineer review, not just operate.

#### 4.1 Structured action audit log surfaced as MCP tool
- **Problem**: Threat model implies action logging exists; it isn't surfaced.
- **Proposal**: `browser_audit_log({ since, sessionId? })` returns a JSON list of executed actions with timestamps, args (with auto-redaction of values typed into password fields and any `value=` for inputs of `type=password`), tab, and result code. Persistent on disk under `~/.codex/umbra/audit/<session>.ndjson` with rotation.
- **Effort**: M.
- **Impact**: High for forensics; Med for daily.
- **Security delta**: Low – needs care with redaction. Default redact pass: any `<input type="password">` value, any param value matching credit-card/SSN regex.
- **Metric**: Reproducible postmortem for any flaky workflow within 1 minute.

#### 4.2 Per-domain allowlist mode (already noted in threat model)
- **Problem**: Pain #13. `<all_urls>` is broad.
- **Proposal**: Optional `UMBRA_ALLOWLIST=ahrefs.com,app.ahrefs.com,…` env. When set, every tool call's `tabId` is checked against the resolved tab origin. Mismatches refuse with a typed error. Default unset = current behavior.
- **Effort**: S.
- **Impact**: Med (defense in depth, mostly for sensitive client lanes).
- **Security delta**: Reduces surface, doesn't expand.
- **Metric**: When allowlist is set, attempting an out-of-list action errors clearly in logs.

#### 4.3 Round-trip and token telemetry
- **Problem**: Pain #15. Hard to measure improvement without a metric.
- **Proposal**: Each MCP server logs per-tool latency, payload bytes, and result code in JSONL. A small `npm run report:rounds` aggregates over the last N runs. No external telemetry endpoint – pure local file.
- **Effort**: S.
- **Impact**: Med (enables every other proposal to be evaluated).
- **Security delta**: None (local only).
- **Metric**: Self-evident.

#### 4.4 Pre-deploy smoke gate for extension version bumps
- **Problem**: Pain #14. Extension reload dance is manual; regressions can land silently.
- **Proposal**: `npm run release:check` script that (a) refuses to bump version if `npm test` is red, (b) syncs canonical → Active extension dir, (c) writes a release-notes stub keyed on the new version. Reload is still manual (Chrome won't accept programmatic reloads of unpacked extensions safely without `chrome.management`); but the release record is automated.
- **Effort**: S.
- **Impact**: Med.
- **Security delta**: None.
- **Metric**: Zero version bumps without green tests.

### Pillar 5 – Capability fills, scoped tightly

These are the items the V1 non-goal list deliberately excluded. Reopen each as an explicit yes/no decision; do not silently bring them back.

#### 5.1 `browser_upload_file` (file inputs only) ✋ DECISION GATE
- **Problem**: Bridge can download (V0) but cannot upload. Common in dashboards (CSV imports to Ahrefs, etc).
- **Proposal**: Restricted to `<input type="file">` elements. Path must live inside an explicit env-configured allowlisted folder (default: `~/Documents/Downloads/`). No drag-drop file emulation in V1.5 (that needs `chrome.debugger`).
- **Effort**: M.
- **Impact**: Med.
- **Security delta**: Low. Filesystem read scope is narrow and operator-configured.
- **Decision gate**: Robert/senior eng must explicitly accept that the bridge can read local files. Default = ship behind a feature flag, off.

#### 5.2 `browser_read_console`, `browser_read_network` for OWNED tabs ✋ DECISION GATE
- **Problem**: Pain #11. Frontend debugging is blind.
- **Proposal**: Strictly scoped to session-owned tabs. Network capture limited to *same-origin requests originating from the page the agent is acting on* – no cross-origin leakage, no headers (specifically: strip `Authorization`, `Cookie`, `Set-Cookie` before returning). Console capture redacts password-field-derived strings using the same heuristic as the audit log. Both implemented via `chrome.debugger` attach (Network + Console domains) on demand, detach on idle.
- **Effort**: L (debugger attach lifecycle is non-trivial).
- **Impact**: High when needed; Low average use.
- **Security delta**: Med. Headers are the obvious risk – defense is the same-origin restriction + header strip + the existing "this is a session-owned tab the agent already controls" baseline. Still, this is the most-discussable proposal in the plan.
- **Decision gate**: Robert/senior eng to confirm the scoping rules are enough. If not, drop to `browser_read_console` only (no network), which sidesteps the header risk entirely.

#### 5.3 `chrome.downloads` permission for completion events
- **Problem**: Pain #6.
- **Proposal**: Add `downloads` to manifest. New tool `browser_wait_for_download({ filename | pattern, timeoutMs })`. Replaces today's file-ledger polling.
- **Effort**: S.
- **Impact**: Med.
- **Security delta**: Low (permission lets us see download state, not initiate beyond what the page does).
- **Decision gate**: SECURITY_REVIEW already lists "decide whether downloads belong in bridge V1." This is the answer: yes, behind a focused review, with the new MCP tool clearly bounded.

#### 5.4 GIF recording for evidence artifacts
- **Problem**: KPI screenshots and audit demos benefit from short GIFs.
- **Proposal**: `browser_record_start` / `browser_record_stop` returning a saved GIF path. Implementation: capture frames via the existing screenshot path at 4 fps, encode with a JS gif encoder. Bounded to 30s max.
- **Effort**: M.
- **Impact**: Low daily, Med for client deliverables.
- **Security delta**: None.
- **Decision gate**: Wait until 5.1/5.2 are decided. Lower priority than everything in pillars 1-4.

---

## Dependency graph

```
              ┌──────────────────────────────────────────────┐
              │ 1.1 read_page (AX tree + refs)                │
              └─────────┬────────────────────────────────────┘
                        │ unlocks
        ┌───────────────┼─────────────┬───────────────┐
        ▼               ▼             ▼               ▼
   1.2 find       1.3 ref-aware    1.4 hover     2.3 DOM cache
                  click/fill/run                  (key: domVersion)
                                                       │ unlocks
                                                       ▼
                                                  2.5 wait_for_*
                                                       │
   2.1 idempotency keys ◀───────── pre-req for ──────► 2.2 recipes
        │                                              wait_click_read
        │                                              fill_submit_wait
        ▼
   3.1 reattach groups   3.2 SW watchdog   3.3 throttle helper   3.4 multi-profile

   4.1 audit log    4.2 allowlist    4.3 telemetry    4.4 release gate

   5.1 upload (gated)   5.2 console+net (gated)   5.3 downloads (gated)   5.4 GIF (gated)
```

Read top to bottom. Anything in Pillar 5 should land *after* Pillar 1's grounding work, because audit and ref discipline matter more once the bridge can read more.

---

## Phased rollout

### V1.5 (target: 2-3 week effort, the "round-trip economy" release)
1. 1.1 `browser_read_page` (Keystone A)
2. 1.3 ref-aware click/fill/run
3. 2.1 idempotency keys + replay (Keystone B)
4. 2.3 DOM snapshot cache
5. 4.3 telemetry (lands first if you want to measure 1-3 honestly)
6. 4.1 audit log

Test bar: full suite green, plus a new round-trip benchmark that proves median MCP calls drop on the existing Ahrefs/SEO/baseline lanes. Cut a release at extension `0.2.x`.

### V2.0 (target: another 2-3 weeks, the "lifecycle and recipes" release)
1. 2.2 same-tab recipes
2. 1.2 find-by-NL
3. 1.4 hover + scroll_to_ref
4. 3.1 reattach/resume named groups
5. 3.2 SW watchdog
6. 4.4 release gate
7. 5.3 downloads permission + `wait_for_download` (low risk, high value)

Cut at extension `0.3.x`.

### V2.5 (gated decisions)
1. Keystone C – debugger-based screenshot path (after senior eng signoff on the banner trade-off)
2. 3.4 multi-profile awareness
3. 4.2 per-domain allowlist
4. 3.3 throttle-aware retry
5. 5.1 file upload (decision gate)
6. 5.2 console + network reads (decision gate)
7. 5.4 GIF recording

Cut at extension `0.4.x`.

Estimated total effort: 6-9 weeks of focused work. Reasonable for one engineer with Robert as design partner.

---

## Risks, rejected alternatives, anti-recommendations

### Risks I'm carrying

- **Debugger-based screenshot is Keystone C but lives in V2.5.** This is a deliberate ordering: the V1 team made this an open question; they should resolve it before screenshots dominate the agent loop. If a senior eng pushes for it sooner, I'd accept moving it to V1.5 with a tighter consent banner UX, *not* removing the consent.
- **Network capture (5.2) is the most-likely-rejected proposal.** Its security delta is genuinely "Med." If the answer is "no," the rest of the plan stands. Console capture (5.2 reduced) is much easier to greenlight on its own.
- **Ref-IDs invalidate on DOM-version change.** Some highly-dynamic sites (Google Sheets, Linear) churn fast enough that refs go stale within one round-trip. Mitigation: 2.3 DOM cache reduces re-read cost, 1.3 returns typed errors, 2.5 `wait_for_dom_idle` lets the agent settle before targeting.
- **Multi-profile awareness adds operational complexity.** Two extensions, two port ranges. Not free. Worth it only if the agency-workflow argument lands.

### Rejected alternatives I considered

- **Native messaging.** Chromex uses it; CiC explicitly excludes it. I keep that. Native messaging is harder to install, harder to revoke, and adds a privileged local surface review that doesn't pay for itself once loopback WebSocket works.
- **Arbitrary JS execution tool (`javascript_tool` analog).** Claude in Chrome has it. CiC's `browser_run_page_action` deliberately restricts to predefined actions. Don't break that. The senior eng review will appreciate that restraint.
- **Cookie/storage/token tools.** Stays out of scope, full stop. Even read-only is a Pandora's box for an agency-grade signed-in bridge.
- **Auto-update of the extension or MCP server.** Out of scope per threat model. Manual upgrade path with `release:check` (4.4) is the answer.
- **Full Playwright / CDP general control.** README and Codex_Browser_Recommendation already evaluated this. Page-centric, not session-centric. Don't relitigate.
- **Embeddings-based element matching for `browser_find`.** Tempting; rejected. Heuristic ranker is faster, free, deterministic, and keeps the bridge offline-capable. Embeddings can come later if heuristics genuinely fall down.
- **Going to the OpenAI Codex App / Codex Cloud's in-app browser instead.** Different runtime; doesn't reuse Robert's signed-in primary Chrome. Orthogonal solution, not a replacement.
- **Letting the bridge run cross-session adoption automatically.** Risky. Reattach (3.1) requires explicit prefix match or operator-confirmed groupId.

### What I'm explicitly NOT recommending

- New tools that duplicate existing Codex skills/agents. The bridge is plumbing; Codex skills are the workflow layer.
- A web UI. Popup is enough; if Robert wants a dashboard, that's a different project.
- Telemetry to any external endpoint. Local files only.
- Changing the WebSocket protocol incompatibly. v1 + v2 broker mode coexist – stay on that path.

---

## Metrics that should move

If we ship V1.5 + V2.0 and the senior eng reviews this in 9 weeks, these are the metrics that should have changed materially:

| Metric | Today (estimate) | V2.0 target | How measured |
|--------|------------------|-------------|--------------|
| Median MCP round-trips per "click row N in Ahrefs Top Pages" | 3-4 | 1-2 | Telemetry (4.3) |
| P50 latency, second `read_page` on same DOM version | full read | < 50ms | Telemetry |
| Ahrefs export stress run flake rate | non-zero (README L43) | 0 | Suite reports |
| Workflows interrupted by SW suspend | rare but unrecoverable | recoverable | 3.2 watchdog logs |
| Time to reproduce a flaky workflow from logs | minutes-hours | < 1 min | 4.1 audit log |
| Macos frontmost app stolen during a screenshot | every screenshot | 0 if Keystone C ships | 4.3 + manual |
| Cross-session tab access attempts that succeed | 0 (already) | 0 (preserved) | Tests |

If any of these don't move, the corresponding pillar didn't earn its place.

---

## Open questions for the senior engineer review

These are honest unknowns I'd like a senior eng to push back on. Pre-empting their critiques here so the conversation starts higher.

1. **Is the AX-tree dump considered "data extraction"?** Threat model excludes generic background fetch; doesn't address structured page reads. My read: same content as today's `getPageContent`, just structured. Want this confirmed.
2. **Is replaying a stale-but-cached idempotency result safer than re-execution?** If the page state has changed under us, the cached result is now wrong. My answer: 60s TTL + DOM-version invalidation handles this. Want a sharper attacker model.
3. **Should reattach (3.1) require a manual confirmation step in the popup, even when the prefix matches?** Defaults to no in this plan; a senior eng might push for yes.
4. **Is the same-origin restriction enough for network capture (5.2)?** I think yes plus header strip. A senior eng might insist on response-body redaction too.
5. **Is multi-profile worth the operational complexity in V2.5?** I lean yes for Robert's specific use case (5+ client profiles, daily). For a solo developer it's YAGNI.
6. **Should the audit log live in Codex's session memory rather than a local NDJSON?** Cross-cuts with Codex skills. Probably both.
7. **How should the debugger banner be reset?** Closing Chrome resets it. If Robert leaves Chrome open for days, the banner persists – is that a security feature (yes, visible) or a UX bug (yes, subtle)?
8. **Does the V1 non-goal list need an update?** "Native messaging," "auto-update," "CAPTCHA helpers" stay banned. "Downloads" should move from non-goal to scoped permission per 5.3. "Storage tools" stays banned. "Background fetch" stays banned. "Cookies/tokens" stays banned.

---

## Pre-emptive responses to likely senior engineer critiques

| Likely critique | Response |
|-----------------|----------|
| "30 features. Pick 5." | Top 3 keystones (1.1, 2.1, Keystone C). Add 2.3 + 3.1 to round to 5. Everything else composes off those. |
| "Where's the data?" | Pain table cites README line numbers; metrics table specifies before/after; telemetry (4.3) is in scope before any optimization claim. |
| "Why not Playwright MCP?" | README's own audit found it page-centric; doesn't fit signed-in primary Chrome model. Already decided. |
| "Why bother given Codex App's in-app browser?" | Different runtime; doesn't reuse Robert's signed-in Chrome state. Orthogonal. |
| "What's the maintenance cost?" | Most proposals are additive on existing primitives; tool count grows by ~7 net. Each change has a metric so we can drop ones that don't pay off. |
| "How does this regress security?" | Annotated per proposal. None expand credential blast radius. Three (5.1/5.2/5.3) are explicit decision gates. |
| "Rust broker is already done. What more is there?" | Rust broker optimized the wire. This plan optimizes the agent loop – the layer above. Different cost surface. |
| "Multi-profile is YAGNI." | Robert's documented daily routine: cs1/cs2 swap, 5+ client Chrome profiles, per-client tab isolation. Not YAGNI for this user. |
| "Idempotency keys add latency." | Negligible: lookup is a Map.get on at most 64 entries. Saves entire re-executions on retry. Win is asymmetric. |
| "Why not write tests first?" | Plan is structured so 4.3 (telemetry) lands first inside V1.5; benchmarks become the actual test. Existing 94-test suite remains the green-bar gate. |

---

## Final note

The strongest signal in CiC's existing repo is restraint. The V1 non-goals are right, and the security review's keep/remove/rewrite matrix is the kind of artifact a senior eng will recognize. This plan sharpens what's there. It doesn't try to make CiC into Claude in Chrome. It doesn't try to make CiC into Playwright. It tries to make CiC into the bridge that makes Codex feel native against Robert's signed-in Chrome – with the same trust boundary, just less round-trip slop.

If only one paragraph gets read: ship Keystone A (read_page with refs), Keystone B (idempotency + replay), and Pillar 4.3 (telemetry) first. Everything else earns its way in against the metric.

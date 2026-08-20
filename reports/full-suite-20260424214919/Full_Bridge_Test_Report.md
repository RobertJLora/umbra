# Codex Chrome Bridge Full Suite Report

Generated: 2026-04-24T21:49:33.809Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260424214919`

## Run Configuration

| Field | Value |
|---|---|
| Suites | baseline, downloads, seo |
| Port range | 47829-47836 |
| Timeout | 90000ms |
| Cleanup mode | closeTabs |
| Downloads | /Users/RobertLora/Documents/Downloads |
| Shared key source | /Users/RobertLora/.codex/codex-chrome-bridge/shared-key |

## Summary

| Metric | Count |
|---|---:|
| Pass | 8 |
| Warn | 0 |
| Fail | 1 |
| Total results | 9 |
| Failure records | 1 |

## Suite Matrix

| Suite | Verdict | Pass | Warn | Fail | Logged elapsed |
|---|---|---:|---:|---:|---:|
| baseline | Pass | 3 | 0 | 0 | 2.4s |
| downloads | Fail | 1 | 0 | 1 | 8.1s |
| seo | Pass | 4 | 0 | 0 | 16.8s |

## Failure Log

| Suite | Task | Session | Tab | Error | Proposed fix |
|---|---|---|---:|---|---|
| downloads | suite-error |  |  | Error: Session suite_downloads_files_20260424214919 does not own any tabs to group.     at SessionRegistry.settleRequest (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/session-registry.js:99:21)     at WebSocket.<anonymous> (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:191:21)     at WebSocket.emit (node:events:509:20)     at Receiver.receiverOnM | Inspect the suite-specific result rows and patch the narrow bridge behavior that failed. |

## Evidence Trail

| Suite | Task | Status | URL | File | Note |
|---|---|---|---|---|---|
| baseline | create-group-read-click-screenshot-close | pass | http://127.0.0.1:64019/baseline | /Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260424214919/screenshots/baseline-baseline-1777067361097.png | Clicked text and saw Codex Bridge Baseline. |
| downloads | suite-error | fail |  |  | Session suite_downloads_files_20260424214919 does not own any tabs to group. |
| seo | local-rendered-technical-snapshot | pass | http://127.0.0.1:64044/seo |  | H1=1, links=2, images=3. |
| seo | public-rendered-vs-raw-status | pass | https://travelbagexperts.com/best-luggage-for-suits/?_verify=1777045074000 |  | Bridge captures rendered DOM state; curl/Firecrawl/Screaming Frog remain better for raw HTTP/header audits at scale. |

## Daily Use Recommendation

- Use Codex Chrome Bridge for signed-in Chrome state, tab groups, concurrent browser sessions, and Chrome-initiated downloads.
- Use Browser Use for fast public/in-app browsing where persistent auth and local downloads do not matter.
- Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.
- Use Firecrawl, curl, or Screaming Frog for public raw HTTP status, headers, large crawls, and repeatable technical SEO at scale.
- Keep password manager, cookies, tokens, OTP, passkeys, and account-security pages out of the bridge.

## Generated Files

- Results JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260424214919/results.jsonl`
- Failures JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260424214919/failures.jsonl`

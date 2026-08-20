# Codex Chrome Bridge Full Suite Report

Generated: 2026-04-24T21:46:20.990Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260424214434`

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
| Pass | 7 |
| Warn | 0 |
| Fail | 2 |
| Total results | 9 |
| Failure records | 2 |

## Suite Matrix

| Suite | Verdict | Pass | Warn | Fail | Logged elapsed |
|---|---|---:|---:|---:|---:|
| baseline | Fail | 1 | 0 | 1 | 9s |
| downloads | Fail | 2 | 0 | 1 | 99.6s |
| seo | Pass | 4 | 0 | 0 | 13.6s |

## Failure Log

| Suite | Task | Session | Tab | Error | Proposed fix |
|---|---|---|---:|---|---|
| baseline | suite-error |  |  | Error: Either the '<all_urls>' or 'activeTab' permission is required.     at SessionRegistry.settleRequest (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/session-registry.js:99:21)     at WebSocket.<anonymous> (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:191:21)     at WebSocket.emit (node:events:509:20)     at Receiver.receiverOnMessage (/Users | Inspect the suite-specific result rows and patch the narrow bridge behavior that failed. |
| downloads | suite-error |  |  | Error: Timed out waiting for download: /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260424214434-sample.xlsx     at waitForDownload (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/full-suite-runner.mjs:752:9)     at async runDownloads (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/full-suite-runner.mjs:1014:25)     at async safeSuite (file:///Users/ | Inspect the suite-specific result rows and patch the narrow bridge behavior that failed. |

## Evidence Trail

| Suite | Task | Status | URL | File | Note |
|---|---|---|---|---|---|
| baseline | suite-error | fail |  |  | Either the '<all_urls>' or 'activeTab' permission is required. |
| downloads | download-csv | pass | http://127.0.0.1:62824/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260424214434-sample.csv | Detected with filesystem polling; Chrome downloads permission not required for this fixture. |
| downloads | suite-error | fail |  |  | Timed out waiting for download: /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260424214434-sample.xlsx |
| seo | local-rendered-technical-snapshot | pass | http://127.0.0.1:63188/seo |  | H1=1, links=2, images=3. |
| seo | public-rendered-vs-raw-status | pass | https://travelbagexperts.com/best-luggage-for-suits/?_verify=1777045074000 |  | Bridge captures rendered DOM state; curl/Firecrawl/Screaming Frog remain better for raw HTTP/header audits at scale. |

## Daily Use Recommendation

- Use Codex Chrome Bridge for signed-in Chrome state, tab groups, concurrent browser sessions, and Chrome-initiated downloads.
- Use Browser Use for fast public/in-app browsing where persistent auth and local downloads do not matter.
- Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.
- Use Firecrawl, curl, or Screaming Frog for public raw HTTP status, headers, large crawls, and repeatable technical SEO at scale.
- Keep password manager, cookies, tokens, OTP, passkeys, and account-security pages out of the bridge.

## Generated Files

- Results JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260424214434/results.jsonl`
- Failures JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260424214434/failures.jsonl`

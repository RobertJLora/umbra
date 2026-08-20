# Codex Chrome Bridge Full Suite Report

Generated: 2026-04-24T21:53:40.461Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/subagent-social-research-20260424235323`

## Run Configuration

| Field | Value |
|---|---|
| Suites | social, research |
| Port range | 47830-47830 |
| Timeout | 120000ms |
| Cleanup mode | closeTabs |
| Downloads | /Users/RobertLora/Documents/Downloads |
| Shared key source | /Users/RobertLora/.codex/codex-chrome-bridge/shared-key |

## Summary

| Metric | Count |
|---|---:|
| Pass | 6 |
| Warn | 0 |
| Fail | 1 |
| Total results | 7 |
| Failure records | 1 |

## Suite Matrix

| Suite | Verdict | Pass | Warn | Fail | Logged elapsed |
|---|---|---:|---:|---:|---:|
| social | Pass | 5 | 0 | 0 | 25.7s |
| research | Fail | 1 | 0 | 1 | 6.9s |

## Failure Log

| Suite | Task | Session | Tab | Error | Proposed fix |
|---|---|---|---:|---|---|
| research | suite-error |  |  | Error: Frame with ID 0 is showing error page     at SessionRegistry.settleRequest (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/session-registry.js:99:21)     at WebSocket.<anonymous> (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:191:21)     at WebSocket.emit (node:events:509:20)     at Receiver.receiverOnMessage (/Users/RobertLora/Documents/Cla | Inspect the suite-specific result rows and patch the narrow bridge behavior that failed. |

## Evidence Trail

| Suite | Task | Status | URL | File | Note |
|---|---|---|---|---|---|
| social | readonly-x | pass | https://x.com/search?q=%22GPT-5.5%22&src=typed_query&f=live |  | To view keyboard shortcuts, press question mark View keyboard shortcuts Home Explore Notifications Chat Grok Bookmarks Creator Studio Premium 50% off Profile More Post Robert Lora @RJLora88 Top Latest People Media Lists See new posts Search |
| social | readonly-reddit | pass | https://www.reddit.com/search/?q=%22GPT-5.5%22&sort=new |  | Skip to main content "GPT-5.5" - Reddit Search! Advertise on Reddit Create Create post Expand user menu Posts Communities Comments Media People back forward New GPT-5.5 with 1M context Window r/cursor · 14m ago GPT-5.5 with 1M context Windo |
| social | readonly-linkedin | pass | https://www.linkedin.com/search/results/content/?keywords=%22GPT-5.5%22 |  | 0 notifications Skip to main content Home 15 My Network Jobs 6 Messaging 6 Notifications Me For Business  Retry for €0  Posts Sort by Date posted Content type From member All filters Feed post  OpenAI     1d •   Introducing GPT-5.5  A new c |
| research | suite-error | fail |  |  | Frame with ID 0 is showing error page |

## Daily Use Recommendation

- Use Codex Chrome Bridge for signed-in Chrome state, tab groups, concurrent browser sessions, and Chrome-initiated downloads.
- Use Browser Use for fast public/in-app browsing where persistent auth and local downloads do not matter.
- Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.
- Use Firecrawl, curl, or Screaming Frog for public raw HTTP status, headers, large crawls, and repeatable technical SEO at scale.
- Keep password manager, cookies, tokens, OTP, passkeys, and account-security pages out of the bridge.

## Generated Files

- Results JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/subagent-social-research-20260424235323/results.jsonl`
- Failures JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/subagent-social-research-20260424235323/failures.jsonl`

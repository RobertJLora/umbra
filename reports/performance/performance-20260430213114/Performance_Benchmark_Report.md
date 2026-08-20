# CiC Performance Benchmark

Generated: 2026-04-30T21:31:35.022Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213114`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | fail |
| Scenarios | 4 |
| Passed | 3 |
| Failed | 1 |
| Commands measured | 27 |
| Payload bytes measured | 10.4 KB |
| Tabs left open | 0 |
| Fixture requests | 12 |
| Fixture response bytes | 10.1 KB |
| Bridge auth latency | 2878.59ms |
| Bridge port | 47829 |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 1 | 7 | 8.21 | 252.43 | 2.9 KB | 0 | 186.2 | 16635.5 |
| navigate-loop | pass | 1 | 8 | 14.24 | 305.67 | 3.4 KB | 0 | 214.4 | 16768.8 |
| wait-loop | pass | 1 | 6 | 6.32 | 233.28 | 2.1 KB | 0 | 219.1 | 16754.5 |
| screenshot | fail | 1 | 6 | 11.87 | 15002.01 | 2 KB | 0 | 61.3 | 16849.8 |

## Command Counts

| Command | Count |
|---|---:|
| browser_cleanup_groups | 4 |
| browser_close_session_tabs | 4 |
| browser_create_tab | 4 |
| browser_get_page_content | 2 |
| browser_list_tabs | 8 |
| browser_navigate | 2 |
| browser_run_page_action | 1 |
| browser_screenshot | 1 |
| browser_wait | 1 |

## Failures

| Scenario | Error |
|---|---|
| screenshot | Error: Timed out waiting for browser_screenshot result from the extension.     at Timeout._onTimeout (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:286:16)     at listOnTimeout (node:internal/timers:605:17)     at process.processTimers (node:internal/timers:541:7) |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213114/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213114/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213114/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213114/process-samples.json`

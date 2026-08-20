# CiC Performance Benchmark

Generated: 2026-04-30T21:32:07.863Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213157`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | fail |
| Scenarios | 10 |
| Passed | 9 |
| Failed | 1 |
| Commands measured | 71 |
| Payload bytes measured | 582.3 KB |
| Tabs left open | 0 |
| Fixture requests | 27 |
| Fixture response bytes | 154.2 KB |
| Bridge auth latency | 5233.91ms |
| Bridge port | 47829 |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 1 | 7 | 4.61 | 324.43 | 2.9 KB | 0 | 136 | 16952.4 |
| navigate-loop | pass | 1 | 8 | 13.34 | 309.38 | 3.4 KB | 0 | 193.6 | 16953.6 |
| wait-loop | pass | 1 | 6 | 6.87 | 209.11 | 2.1 KB | 0 | 200.3 | 16951.1 |
| screenshot | fail | 1 | 6 | 8.23 | 310.02 | 2 KB | 0 | 210.4 | 16943.5 |
| multi-tab-fanout | pass | 1 | 9 | 7.32 | 230.41 | 5.9 KB | 0 | 237.5 | 16979.2 |
| large-payload-html | pass | 1 | 7 | 5.93 | 209.93 | 547.3 KB | 0 | 220.6 | 16973.4 |
| technical-snapshot | pass | 1 | 6 | 6.53 | 270.84 | 3.3 KB | 0 | 186.6 | 16975.4 |
| workflow-separate | pass | 1 | 8 | 4.87 | 312.17 | 2.9 KB | 0 | 179.8 | 16979.3 |
| workflow-batch | pass | 1 | 6 | 6.16 | 215.19 | 3.4 KB | 0 | 188.9 | 16980 |
| export-like-workflow | pass | 1 | 8 | 5.67 | 320.87 | 9 KB | 0 | 184.7 | 16981.2 |

## Command Counts

| Command | Count |
|---|---:|
| browser_batch | 1 |
| browser_cleanup_groups | 10 |
| browser_click | 2 |
| browser_close_session_tabs | 10 |
| browser_create_tab | 11 |
| browser_get_page_content | 9 |
| browser_get_technical_snapshot | 1 |
| browser_list_tabs | 21 |
| browser_navigate | 2 |
| browser_run_page_action | 1 |
| browser_screenshot | 1 |
| browser_wait | 2 |

## Failures

| Scenario | Error |
|---|---|
| screenshot | Error: Failed to capture tab: image readback failed     at SessionRegistry.settleRequest (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/session-registry.js:99:21)     at WebSocket.<anonymous> (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:213:21)     at WebSocket.emit (node:events:509:20)     at Receiver.receiverOnMessage (/Users/RobertLora/Docume |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213157/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213157/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213157/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213157/process-samples.json`

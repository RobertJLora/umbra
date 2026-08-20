# CiC Performance Benchmark

Generated: 2026-04-30T21:32:46.647Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213237`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | fail |
| Scenarios | 10 |
| Passed | 9 |
| Failed | 1 |
| Commands measured | 72 |
| Payload bytes measured | 550.4 KB |
| Tabs left open | 0 |
| Fixture requests | 27 |
| Fixture response bytes | 154.2 KB |
| Bridge auth latency | 3980.53ms |
| Bridge port | 47829 |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 1 | 7 | 9.62 | 254.18 | 2.9 KB | 0 | 217.8 | 16901.8 |
| navigate-loop | pass | 1 | 8 | 20.23 | 233.45 | 3.4 KB | 0 | 300 | 17145.9 |
| wait-loop | pass | 1 | 6 | 7.29 | 302.32 | 2.1 KB | 0 | 202.7 | 17149.3 |
| screenshot | fail | 1 | 7 | 13.85 | 300.12 | 2.1 KB | 0 | 97 | 17152.9 |
| multi-tab-fanout | pass | 1 | 9 | 9.09 | 212.4 | 5.9 KB | 0 | 244.8 | 17170.6 |
| large-payload-html | pass | 1 | 7 | 9.12 | 217.28 | 515.3 KB | 0 | 218.2 | 17178.5 |
| technical-snapshot | pass | 1 | 6 | 6.86 | 268.09 | 3.3 KB | 0 | 189.4 | 17175.5 |
| workflow-separate | pass | 1 | 8 | 6.75 | 224.17 | 2.9 KB | 0 | 185.2 | 17176.8 |
| workflow-batch | pass | 1 | 6 | 6.7 | 205.97 | 3.3 KB | 0 | 200.4 | 17177.4 |
| export-like-workflow | pass | 1 | 8 | 4.69 | 216.07 | 9 KB | 0 | 210.5 | 17193.1 |

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
| browser_screenshot | 2 |
| browser_wait | 2 |

## Failures

| Scenario | Error |
|---|---|
| screenshot | Error: Failed to capture tab: image readback failed     at SessionRegistry.settleRequest (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/session-registry.js:99:21)     at WebSocket.<anonymous> (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:213:21)     at WebSocket.emit (node:events:509:20)     at Receiver.receiverOnMessage (/Users/RobertLora/Docume |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213237/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213237/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213237/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213237/process-samples.json`

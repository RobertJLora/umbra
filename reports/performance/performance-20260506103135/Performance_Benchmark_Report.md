# CiC Performance Benchmark

Generated: 2026-05-06T10:31:49.696Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103135`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | fail |
| Scenarios | 15 |
| Passed | 14 |
| Failed | 1 |
| Commands measured | 149 |
| Payload bytes measured | 1.3 MB |
| Tabs left open | 0 |
| Fixture requests | 80 |
| Fixture response bytes | 332.3 KB |
| Broker mode | legacy |
| Bridge auth latency | 1784.95ms |
| Bridge port | 47829 |
| Rust broker socket | - |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 9.37 | 246.59 | 5 KB | 0 | 220.3 | 15694 | 0 | 5.5 |
| navigate-loop | pass | 2 | 12 | 49.44 | 221.55 | 6 KB | 0 | 253.8 | 15643.4 | 0 | 5.5 |
| wait-loop | pass | 2 | 8 | 6.18 | 375.59 | 3.2 KB | 0 | 184.7 | 15667.2 | 0 | 5.5 |
| screenshot | pass | 2 | 8 | 61.3 | 285.58 | 176.7 KB | 0 | 226.3 | 15737.7 | 0 | 5.5 |
| multi-tab-fanout | pass | 2 | 22 | 8.77 | 325.51 | 22 KB | 0 | 317.7 | 15385.7 | 0 | 4.5 |
| large-payload-html | pass | 2 | 10 | 9.05 | 271.08 | 1.04 MB | 0 | 330.8 | 15396.5 | 0 | 4.5 |
| technical-snapshot | pass | 2 | 8 | 3.01 | 283.03 | 5.4 KB | 0 | 292 | 15395 | 0 | 4.5 |
| workflow-separate | pass | 2 | 12 | 7.86 | 252.38 | 4.8 KB | 0 | 301.5 | 15431.3 | 0 | 4.5 |
| workflow-batch | pass | 2 | 6 | 8.55 | 243.87 | 5.8 KB | 0 | 274.5 | 15435.3 | 0 | 4.5 |
| export-like-workflow | pass | 2 | 12 | 4.68 | 253.64 | 11.3 KB | 0 | 239.6 | 15425.8 | 0 | 4.5 |
| read-interactive | pass | 2 | 8 | 8.17 | 248.38 | 7.2 KB | 0 | 216.1 | 15462.3 | 0 | 4.5 |
| read-interactive-ref-click | fail | 2 | 7 | 6.21 | 214.26 | 3 KB | 0 | 187 | 15435.2 | 0 | 4.5 |
| recipe-workflow | pass | 2 | 8 | 12.02 | 230.65 | 5 KB | 0 | 239.1 | 15428.2 | 0 | 4.5 |
| cached-second-read | pass | 2 | 10 | 3.84 | 242.69 | 6.1 KB | 0 | 230.8 | 15434.5 | 0 | 4.5 |
| group-find-adopt-overhead | pass | 2 | 8 | 1.86 | 246.39 | 4.2 KB | 0 | 209.8 | 15442.2 | 0 | 4.5 |

## Command Counts

| Command | Count |
|---|---:|
| browser_batch | 2 |
| browser_cleanup_groups | 15 |
| browser_click | 5 |
| browser_close_session_tabs | 15 |
| browser_create_tab | 33 |
| browser_find_groups | 2 |
| browser_get_page_content | 26 |
| browser_get_technical_snapshot | 2 |
| browser_list_tabs | 32 |
| browser_navigate | 4 |
| browser_read_interactive | 3 |
| browser_run_page_action | 2 |
| browser_screenshot | 2 |
| browser_wait | 4 |
| browser_wait_click_read | 2 |

## Failures

| Scenario | Error |
|---|---|
| read-interactive-ref-click | Error: Stale interactive ref. Run browser_read_interactive again.     at SessionRegistry.settleRequest (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/session-registry.js:99:21)     at WebSocket.<anonymous> (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:216:21)     at WebSocket.emit (node:events:509:20)     at Receiver.receiverOnMessage (/Users/Rob |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103135/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103135/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103135/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103135/process-samples.json`

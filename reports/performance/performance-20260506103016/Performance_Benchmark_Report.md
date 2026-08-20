# CiC Performance Benchmark

Generated: 2026-05-06T10:30:30.664Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103016`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | fail |
| Scenarios | 15 |
| Passed | 14 |
| Failed | 1 |
| Commands measured | 153 |
| Payload bytes measured | 1.27 MB |
| Tabs left open | 0 |
| Fixture requests | 82 |
| Fixture response bytes | 333.8 KB |
| Broker mode | legacy |
| Bridge auth latency | 506.6ms |
| Bridge port | 47829 |
| Rust broker socket | - |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 6.3 | 221.14 | 5 KB | 0 | 243.3 | 14238.6 | 0 | 4.9 |
| navigate-loop | pass | 2 | 12 | 49.19 | 232.5 | 6 KB | 0 | 262.4 | 14250 | 0 | 4.9 |
| wait-loop | pass | 2 | 8 | 8.88 | 388.72 | 3.2 KB | 0 | 230.1 | 14264.1 | 0 | 4.9 |
| screenshot | pass | 2 | 8 | 60.67 | 283.52 | 176.7 KB | 0 | 260.4 | 14386.2 | 0 | 4.9 |
| multi-tab-fanout | pass | 2 | 22 | 7.56 | 249.96 | 22 KB | 0 | 264.3 | 14446.2 | 0 | 4.9 |
| large-payload-html | pass | 2 | 10 | 6.03 | 294.91 | 1.01 MB | 0 | 221 | 14484.5 | 0 | 4.9 |
| technical-snapshot | pass | 2 | 8 | 6.64 | 307.33 | 5.4 KB | 0 | 207.5 | 14472 | 0 | 4.9 |
| workflow-separate | pass | 2 | 12 | 5.22 | 219.58 | 4.8 KB | 0 | 213 | 14477 | 0 | 4.9 |
| workflow-batch | pass | 2 | 6 | 7.9 | 254.74 | 5.8 KB | 0 | 244.6 | 14478.6 | 0 | 4.9 |
| export-like-workflow | pass | 2 | 12 | 6.22 | 321.3 | 11.3 KB | 0 | 251 | 14456.6 | 0 | 4.9 |
| read-interactive | pass | 2 | 8 | 6.58 | 287.97 | 7.2 KB | 0 | 291 | 14516.5 | 0 | 4.9 |
| read-interactive-ref-click | fail | 2 | 11 | 6.41 | 231.99 | 5.5 KB | 0 | 384.8 | 14558.1 | 0 | 4.9 |
| recipe-workflow | pass | 2 | 8 | 12.67 | 232.5 | 5 KB | 0 | 388.5 | 14899.5 | 0 | 4.9 |
| cached-second-read | pass | 2 | 10 | 6.37 | 226.67 | 6.1 KB | 0 | 308.8 | 14865 | 0 | 4.9 |
| group-find-adopt-overhead | pass | 2 | 8 | 2.77 | 315.71 | 4.1 KB | 0 | 315.8 | 14837.3 | 0 | 4.9 |

## Command Counts

| Command | Count |
|---|---:|
| browser_batch | 2 |
| browser_cleanup_groups | 15 |
| browser_click | 6 |
| browser_close_session_tabs | 15 |
| browser_create_tab | 34 |
| browser_find_groups | 2 |
| browser_get_page_content | 27 |
| browser_get_technical_snapshot | 2 |
| browser_list_tabs | 32 |
| browser_navigate | 4 |
| browser_read_interactive | 4 |
| browser_run_page_action | 2 |
| browser_screenshot | 2 |
| browser_wait | 4 |
| browser_wait_click_read | 2 |

## Failures

| Scenario | Error |
|---|---|
| read-interactive-ref-click | Error: Stale interactive ref. Run browser_read_interactive again.     at SessionRegistry.settleRequest (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/session-registry.js:99:21)     at WebSocket.<anonymous> (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:216:21)     at WebSocket.emit (node:events:509:20)     at Receiver.receiverOnMessage (/Users/Rob |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103016/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103016/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103016/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103016/process-samples.json`

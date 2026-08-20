# CiC Performance Benchmark

Generated: 2026-04-30T22:58:15.815Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225806`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 10 |
| Passed | 10 |
| Failed | 0 |
| Commands measured | 108 |
| Payload bytes measured | 1.25 MB |
| Tabs left open | 0 |
| Fixture requests | 62 |
| Fixture response bytes | 318.6 KB |
| Broker mode | rust |
| Bridge auth latency | 1761.76ms |
| Bridge port | 47849 |
| Rust broker socket | /tmp/codex-chrome-bridge-rust-bench-67130-performance-20260430225806.sock |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 4.94 | 215.03 | 5 KB | 0 | 158.8 | 15169.3 | 0 | 3.7 |
| navigate-loop | pass | 2 | 12 | 42.99 | 210.51 | 6 KB | 0 | 244.3 | 15155.2 | 0.4 | 3.8 |
| wait-loop | pass | 2 | 8 | 5.7 | 220.21 | 3.2 KB | 0 | 184.4 | 15175.6 | 0 | 3.8 |
| screenshot | pass | 2 | 8 | 66.15 | 225.06 | 181.6 KB | 0 | 215.8 | 15193.9 | 0 | 4.3 |
| multi-tab-fanout | pass | 2 | 22 | 4.31 | 223.28 | 22 KB | 0 | 238.7 | 15189.3 | 0 | 4.4 |
| large-payload-html | pass | 2 | 10 | 7.89 | 235.18 | 1.01 MB | 0 | 185.2 | 15202.9 | 0.2 | 6.7 |
| technical-snapshot | pass | 2 | 8 | 3.76 | 262.2 | 5.4 KB | 0 | 191.4 | 15206.5 | 0.1 | 6.7 |
| workflow-separate | pass | 2 | 12 | 4.72 | 199.75 | 4.8 KB | 0 | 190 | 15208.2 | 0 | 6.7 |
| workflow-batch | pass | 2 | 6 | 7.22 | 219.94 | 5.8 KB | 0 | 203 | 15204.9 | 0.1 | 6.7 |
| export-like-workflow | pass | 2 | 12 | 5.15 | 209.77 | 11.3 KB | 0 | 231.1 | 15194.5 | 0.2 | 6.7 |

## Command Counts

| Command | Count |
|---|---:|
| browser_batch | 2 |
| browser_cleanup_groups | 10 |
| browser_click | 4 |
| browser_close_session_tabs | 10 |
| browser_create_tab | 24 |
| browser_get_page_content | 22 |
| browser_get_technical_snapshot | 2 |
| browser_list_tabs | 22 |
| browser_navigate | 4 |
| browser_run_page_action | 2 |
| browser_screenshot | 2 |
| browser_wait | 4 |

## Failures

| Scenario | Error |
|---|---|
| - | None |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225806/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225806/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225806/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225806/process-samples.json`

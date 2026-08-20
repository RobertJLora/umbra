# CiC Performance Benchmark

Generated: 2026-04-30T22:55:17.821Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225505`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 10 |
| Passed | 10 |
| Failed | 0 |
| Commands measured | 110 |
| Payload bytes measured | 1.28 MB |
| Tabs left open | 0 |
| Fixture requests | 62 |
| Fixture response bytes | 318.6 KB |
| Broker mode | rust |
| Bridge auth latency | 4269.69ms |
| Bridge port | 47849 |
| Rust broker socket | /tmp/codex-chrome-bridge-rust-bench-59495-performance-20260430225505.sock |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 4.34 | 226.75 | 5 KB | 0 | 183.9 | 14517.2 | 0 | 3.7 |
| navigate-loop | pass | 2 | 12 | 44.43 | 230.11 | 6 KB | 0 | 230 | 14503.5 | 0 | 3.8 |
| wait-loop | pass | 2 | 8 | 5.38 | 200.59 | 3.2 KB | 0 | 230.4 | 14504.9 | 0 | 3.8 |
| screenshot | pass | 2 | 8 | 58.53 | 234.19 | 181.6 KB | 0 | 225.7 | 14517.4 | 0.1 | 4.6 |
| multi-tab-fanout | pass | 2 | 22 | 4.85 | 236.45 | 22 KB | 0 | 245.9 | 14544.1 | 0 | 4.7 |
| large-payload-html | pass | 2 | 10 | 7.59 | 221.86 | 1.04 MB | 0 | 181.1 | 14559.3 | 0.1 | 6.7 |
| technical-snapshot | pass | 2 | 8 | 3.18 | 251.83 | 5.4 KB | 0 | 209.5 | 14560 | 0.2 | 6.7 |
| workflow-separate | pass | 2 | 12 | 2.88 | 232.54 | 4.8 KB | 0 | 196.1 | 14546.4 | 0 | 6.7 |
| workflow-batch | pass | 2 | 8 | 11.12 | 234.32 | 5.6 KB | 0 | 206.1 | 14549.9 | 0 | 6.7 |
| export-like-workflow | pass | 2 | 12 | 6.21 | 232.3 | 11.3 KB | 0 | 196.3 | 14524.5 | 0.2 | 6.7 |

## Command Counts

| Command | Count |
|---|---:|
| browser_batch | 2 |
| browser_cleanup_groups | 10 |
| browser_click | 4 |
| browser_close_session_tabs | 10 |
| browser_create_tab | 26 |
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

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225505/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225505/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225505/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225505/process-samples.json`

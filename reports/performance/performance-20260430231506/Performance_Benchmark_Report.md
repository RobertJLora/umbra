# CiC Performance Benchmark

Generated: 2026-04-30T23:15:17.798Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231506`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 10 |
| Passed | 10 |
| Failed | 0 |
| Commands measured | 108 |
| Payload bytes measured | 1.28 MB |
| Tabs left open | 0 |
| Fixture requests | 62 |
| Fixture response bytes | 318.6 KB |
| Broker mode | rust |
| Bridge auth latency | 2764.84ms |
| Bridge port | 47849 |
| Rust broker socket | /tmp/codex-chrome-bridge-rust-bench-97781-performance-20260430231506.sock |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 5.32 | 258.01 | 5 KB | 0 | 204.4 | 15621.1 | 0.1 | 3.7 |
| navigate-loop | pass | 2 | 12 | 42.46 | 227.62 | 6 KB | 0 | 241.6 | 15626.1 | 0.1 | 3.8 |
| wait-loop | pass | 2 | 8 | 5.53 | 240.63 | 3.2 KB | 0 | 181.6 | 15630.6 | 0 | 3.8 |
| screenshot | pass | 2 | 8 | 61.72 | 241.69 | 181.6 KB | 0 | 215.6 | 15661.7 | 0.2 | 4.6 |
| multi-tab-fanout | pass | 2 | 22 | 5.36 | 242.01 | 22.1 KB | 0 | 205.3 | 15665 | 0 | 4.7 |
| large-payload-html | pass | 2 | 10 | 8.26 | 241.92 | 1.04 MB | 0 | 244.9 | 15698.2 | 0.5 | 6.3 |
| technical-snapshot | pass | 2 | 8 | 4.46 | 317.69 | 5.4 KB | 0 | 162.8 | 15683.9 | 0 | 6.4 |
| workflow-separate | pass | 2 | 12 | 5.34 | 233.34 | 4.8 KB | 0 | 173.7 | 15696.5 | 0 | 6.4 |
| workflow-batch | pass | 2 | 6 | 6.43 | 252.13 | 5.8 KB | 0 | 177.7 | 15698.6 | 0 | 6.4 |
| export-like-workflow | pass | 2 | 12 | 5.57 | 240.34 | 11.3 KB | 0 | 193.6 | 15674.9 | 0 | 6.4 |

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

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231506/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231506/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231506/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231506/process-samples.json`

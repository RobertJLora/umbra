# CiC Performance Benchmark

Generated: 2026-04-30T23:14:57.050Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231437`

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
| Broker mode | legacy |
| Bridge auth latency | 10607.86ms |
| Bridge port | 47845 |
| Rust broker socket | - |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 6.39 | 261.74 | 5 KB | 0 | 172.3 | 15401.5 | 0 | 0 |
| navigate-loop | pass | 2 | 12 | 47 | 285.25 | 6 KB | 0 | 307.4 | 15553.3 | 0 | 0 |
| wait-loop | pass | 2 | 8 | 5.57 | 231.72 | 3.2 KB | 0 | 194.8 | 15569.8 | 0 | 0 |
| screenshot | pass | 2 | 8 | 69.64 | 222 | 181.6 KB | 0 | 203.4 | 15593.3 | 0 | 0 |
| multi-tab-fanout | pass | 2 | 22 | 3.62 | 240.59 | 22 KB | 0 | 209.8 | 15608.5 | 0 | 0 |
| large-payload-html | pass | 2 | 10 | 6.61 | 234.2 | 1.01 MB | 0 | 205.9 | 15646.9 | 0 | 0 |
| technical-snapshot | pass | 2 | 8 | 2.95 | 350.8 | 5.4 KB | 0 | 174.6 | 15621.6 | 0 | 0 |
| workflow-separate | pass | 2 | 12 | 4.53 | 270.47 | 4.8 KB | 0 | 191.6 | 15637.7 | 0 | 0 |
| workflow-batch | pass | 2 | 6 | 6.13 | 265.55 | 5.8 KB | 0 | 181.9 | 15616 | 0 | 0 |
| export-like-workflow | pass | 2 | 12 | 4.33 | 254.53 | 11.3 KB | 0 | 176.7 | 15618.4 | 0 | 0 |

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

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231437/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231437/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231437/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430231437/process-samples.json`

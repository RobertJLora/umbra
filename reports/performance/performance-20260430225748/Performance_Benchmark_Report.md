# CiC Performance Benchmark

Generated: 2026-04-30T22:57:57.302Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225748`

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
| Bridge auth latency | 856.93ms |
| Bridge port | 47845 |
| Rust broker socket | - |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 6.48 | 281.25 | 5 KB | 0 | 335.9 | 15066.6 | 0 | 0 |
| navigate-loop | pass | 2 | 12 | 44.59 | 237.16 | 6 KB | 0 | 279.1 | 15158.8 | 0 | 0 |
| wait-loop | pass | 2 | 8 | 4.75 | 195.19 | 3.2 KB | 0 | 197.9 | 15163.9 | 0 | 0 |
| screenshot | pass | 2 | 8 | 57.98 | 193.93 | 181.6 KB | 0 | 221.4 | 15192.1 | 0 | 0 |
| multi-tab-fanout | pass | 2 | 22 | 4.14 | 231.92 | 22 KB | 0 | 245.6 | 15183.8 | 0 | 0 |
| large-payload-html | pass | 2 | 10 | 6.67 | 237.8 | 1.01 MB | 0 | 186.6 | 15214.3 | 0 | 0 |
| technical-snapshot | pass | 2 | 8 | 3.87 | 296.72 | 5.4 KB | 0 | 169.3 | 15186.7 | 0 | 0 |
| workflow-separate | pass | 2 | 12 | 6.49 | 218.39 | 4.8 KB | 0 | 189.6 | 15219.2 | 0 | 0 |
| workflow-batch | pass | 2 | 6 | 6.66 | 247.88 | 5.8 KB | 0 | 196.7 | 15204.8 | 0 | 0 |
| export-like-workflow | pass | 2 | 12 | 4.33 | 226.72 | 11.3 KB | 0 | 204.3 | 15195.8 | 0 | 0 |

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

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225748/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225748/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225748/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225748/process-samples.json`

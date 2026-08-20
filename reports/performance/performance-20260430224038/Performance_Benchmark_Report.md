# CiC Performance Benchmark

Generated: 2026-04-30T22:40:59.724Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224038`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 10 |
| Passed | 10 |
| Failed | 0 |
| Commands measured | 110 |
| Payload bytes measured | 1.27 MB |
| Tabs left open | 0 |
| Fixture requests | 62 |
| Fixture response bytes | 318.6 KB |
| Broker mode | legacy |
| Bridge auth latency | 7320.79ms |
| Bridge port | 47845 |
| Rust broker socket | - |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 2.93 | 198.05 | 4.9 KB | 0 | 163.6 | 16369.8 | 0 | 0 |
| navigate-loop | pass | 2 | 12 | 47.37 | 946.33 | 5.9 KB | 0 | 178.5 | 16367.5 | 0 | 0 |
| wait-loop | pass | 2 | 8 | 3.58 | 934.14 | 3.1 KB | 0 | 120.8 | 16387.2 | 0 | 0 |
| screenshot | pass | 2 | 8 | 59.51 | 934.67 | 181.6 KB | 0 | 169.9 | 16650.1 | 0 | 0 |
| multi-tab-fanout | pass | 2 | 22 | 3.72 | 921.16 | 21.6 KB | 0 | 256.5 | 16662.4 | 0 | 0 |
| large-payload-html | pass | 2 | 10 | 6.16 | 1000.68 | 1.04 MB | 0 | 137.6 | 16658 | 0 | 0 |
| technical-snapshot | pass | 2 | 8 | 3.7 | 260.39 | 5.4 KB | 0 | 184.9 | 16618.9 | 0 | 0 |
| workflow-separate | pass | 2 | 12 | 3.39 | 960.01 | 4.5 KB | 0 | 39.1 | 16625 | 0 | 0 |
| workflow-batch | pass | 2 | 8 | 11.3 | 190.09 | 5.3 KB | 0 | 180.5 | 16637.2 | 0 | 0 |
| export-like-workflow | pass | 2 | 12 | 4.25 | 194.08 | 11.1 KB | 0 | 201.1 | 16628.5 | 0 | 0 |

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

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224038/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224038/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224038/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224038/process-samples.json`

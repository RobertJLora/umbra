# CiC Performance Benchmark

Generated: 2026-05-06T10:32:27.634Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103214`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 15 |
| Passed | 15 |
| Failed | 0 |
| Commands measured | 156 |
| Payload bytes measured | 1.3 MB |
| Tabs left open | 0 |
| Fixture requests | 82 |
| Fixture response bytes | 333.8 KB |
| Broker mode | legacy |
| Bridge auth latency | 227.94ms |
| Bridge port | 47829 |
| Rust broker socket | - |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 5.36 | 234.89 | 5 KB | 0 | 218.8 | 15701.3 | 0 | 5.3 |
| navigate-loop | pass | 2 | 12 | 49.72 | 232.92 | 6 KB | 0 | 280.4 | 15555.4 | 0 | 5.3 |
| wait-loop | pass | 2 | 8 | 5.24 | 217.01 | 3.2 KB | 0 | 237 | 15565.9 | 0 | 5.3 |
| screenshot | pass | 2 | 8 | 66.14 | 209.95 | 176.7 KB | 0 | 235.3 | 15575.1 | 0 | 5.3 |
| multi-tab-fanout | pass | 2 | 22 | 7.64 | 252.96 | 22.1 KB | 0 | 238.1 | 15442.8 | 0 | 5.2 |
| large-payload-html | pass | 2 | 10 | 8 | 244.23 | 1.04 MB | 0 | 194.2 | 15481.3 | 0 | 5.2 |
| technical-snapshot | pass | 2 | 8 | 7.35 | 276.3 | 5.4 KB | 0 | 211.6 | 15474.5 | 0 | 5.2 |
| workflow-separate | pass | 2 | 12 | 5.01 | 255.02 | 4.8 KB | 0 | 225.2 | 15459.8 | 0 | 5.2 |
| workflow-batch | pass | 2 | 6 | 5.02 | 287.13 | 5.8 KB | 0 | 247.5 | 15430.5 | 0 | 5.2 |
| export-like-workflow | pass | 2 | 12 | 6.86 | 239.35 | 11.3 KB | 0 | 248.7 | 15453.6 | 0 | 5.2 |
| read-interactive | pass | 2 | 8 | 5.89 | 238.43 | 7.2 KB | 0 | 266.4 | 15453.6 | 0 | 5.2 |
| read-interactive-ref-click | pass | 2 | 14 | 3.52 | 240.56 | 7.3 KB | 0 | 226.4 | 15453.9 | 0 | 5.2 |
| recipe-workflow | pass | 2 | 8 | 13.4 | 258.45 | 5 KB | 0 | 233.8 | 15453.6 | 0 | 5.2 |
| cached-second-read | pass | 2 | 10 | 5.34 | 318.38 | 6.1 KB | 0 | 214 | 15452 | 0 | 5.2 |
| group-find-adopt-overhead | pass | 2 | 8 | 3.59 | 240.11 | 4.2 KB | 0 | 249 | 15455 | 0 | 5.2 |

## Command Counts

| Command | Count |
|---|---:|
| browser_batch | 2 |
| browser_cleanup_groups | 15 |
| browser_click | 7 |
| browser_close_session_tabs | 15 |
| browser_create_tab | 34 |
| browser_find_groups | 2 |
| browser_get_page_content | 28 |
| browser_get_technical_snapshot | 2 |
| browser_list_tabs | 32 |
| browser_navigate | 4 |
| browser_read_interactive | 5 |
| browser_run_page_action | 2 |
| browser_screenshot | 2 |
| browser_wait | 4 |
| browser_wait_click_read | 2 |

## Failures

| Scenario | Error |
|---|---|
| - | None |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103214/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103214/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103214/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260506103214/process-samples.json`

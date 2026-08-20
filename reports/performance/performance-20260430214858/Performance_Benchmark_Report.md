# CiC Performance Benchmark

Generated: 2026-04-30T21:49:08.079Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430214858`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 10 |
| Passed | 10 |
| Failed | 0 |
| Commands measured | 71 |
| Payload bytes measured | 638 KB |
| Tabs left open | 0 |
| Fixture requests | 27 |
| Fixture response bytes | 154.2 KB |
| Bridge auth latency | 3965.05ms |
| Bridge port | 47829 |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 1 | 7 | 3.7 | 224.41 | 3.1 KB | 0 | 73.6 | 16263.5 |
| navigate-loop | pass | 1 | 8 | 10.94 | 199.95 | 3.6 KB | 0 | 210.6 | 16267.5 |
| wait-loop | pass | 1 | 6 | 5.35 | 208.03 | 2.2 KB | 0 | 165.3 | 16274.4 |
| screenshot | pass | 1 | 6 | 5.38 | 218.48 | 91.7 KB | 0 | 197.2 | 16283.3 |
| multi-tab-fanout | pass | 1 | 9 | 3.44 | 239.08 | 6.2 KB | 0 | 189.1 | 16316.8 |
| large-payload-html | pass | 1 | 7 | 4.63 | 231.07 | 515.7 KB | 0 | 162.1 | 16307.6 |
| technical-snapshot | pass | 1 | 6 | 3.76 | 280.63 | 3.3 KB | 0 | 166.3 | 16314.1 |
| workflow-separate | pass | 1 | 8 | 4.3 | 951.17 | 2.9 KB | 0 | 28.7 | 16296.7 |
| workflow-batch | pass | 1 | 6 | 5.27 | 201.66 | 3.3 KB | 0 | 115.4 | 16313.3 |
| export-like-workflow | pass | 1 | 8 | 2.42 | 965.43 | 6.2 KB | 0 | 36.6 | 16301.7 |

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
| browser_screenshot | 1 |
| browser_wait | 2 |

## Failures

| Scenario | Error |
|---|---|
| - | None |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430214858/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430214858/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430214858/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430214858/process-samples.json`

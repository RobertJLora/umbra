# CiC Performance Benchmark

Generated: 2026-04-30T22:54:55.896Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225446`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 10 |
| Passed | 10 |
| Failed | 0 |
| Commands measured | 110 |
| Payload bytes measured | 1.25 MB |
| Tabs left open | 0 |
| Fixture requests | 62 |
| Fixture response bytes | 318.6 KB |
| Broker mode | legacy |
| Bridge auth latency | 965.99ms |
| Bridge port | 47845 |
| Rust broker socket | - |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 4.36 | 228.99 | 5 KB | 0 | 201 | 14643.2 | 0 | 0 |
| navigate-loop | pass | 2 | 12 | 43.04 | 208.95 | 6 KB | 0 | 258.7 | 14619.8 | 0 | 0 |
| wait-loop | pass | 2 | 8 | 6.45 | 308.03 | 3.2 KB | 0 | 279.9 | 14747.6 | 0 | 0 |
| screenshot | pass | 2 | 8 | 61.33 | 204.47 | 181.6 KB | 0 | 230.4 | 14764.9 | 0 | 0 |
| multi-tab-fanout | pass | 2 | 22 | 4.48 | 224.13 | 22 KB | 0 | 230.1 | 14505.5 | 0 | 0 |
| large-payload-html | pass | 2 | 10 | 6.72 | 254.96 | 1.01 MB | 0 | 189.3 | 14531.3 | 0 | 0 |
| technical-snapshot | pass | 2 | 8 | 4.87 | 272.58 | 5.4 KB | 0 | 220.3 | 14502.8 | 0 | 0 |
| workflow-separate | pass | 2 | 12 | 4.64 | 195.03 | 4.8 KB | 0 | 207.4 | 14530.5 | 0 | 0 |
| workflow-batch | pass | 2 | 8 | 12.51 | 266.62 | 5.6 KB | 0 | 206.8 | 14531 | 0 | 0 |
| export-like-workflow | pass | 2 | 12 | 5.06 | 261.24 | 11.3 KB | 0 | 200.7 | 14497.6 | 0 | 0 |

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

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225446/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225446/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225446/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430225446/process-samples.json`

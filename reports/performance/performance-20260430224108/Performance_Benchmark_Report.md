# CiC Performance Benchmark

Generated: 2026-04-30T22:41:21.368Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224108`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | pass |
| Scenarios | 10 |
| Passed | 10 |
| Failed | 0 |
| Commands measured | 110 |
| Payload bytes measured | 1.24 MB |
| Tabs left open | 0 |
| Fixture requests | 62 |
| Fixture response bytes | 318.6 KB |
| Broker mode | rust |
| Bridge auth latency | 2518.99ms |
| Bridge port | 47849 |
| Rust broker socket | /tmp/codex-chrome-bridge-rust-bench-33160-performance-20260430224108.sock |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after | Rust CPU % after | Rust RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| create-read-text | pass | 2 | 10 | 5.49 | 962.73 | 4.9 KB | 0 | 127.7 | 16628.2 | 0.2 | 3.7 |
| navigate-loop | pass | 2 | 12 | 46.07 | 185.27 | 5.9 KB | 0 | 240.3 | 16617.4 | 0.2 | 3.7 |
| wait-loop | pass | 2 | 8 | 5.94 | 941.17 | 3.1 KB | 0 | 33.1 | 16620.9 | 0 | 3.8 |
| screenshot | pass | 2 | 8 | 61.17 | 185.41 | 181.6 KB | 0 | 211.4 | 16649.8 | 0.2 | 4.5 |
| multi-tab-fanout | pass | 2 | 22 | 3.36 | 203.67 | 21.6 KB | 0 | 256.2 | 16645.6 | 0.2 | 4.7 |
| large-payload-html | pass | 2 | 10 | 4.92 | 206.36 | 1.01 MB | 0 | 198.3 | 16663.4 | 0.5 | 7.4 |
| technical-snapshot | pass | 2 | 8 | 4.94 | 279.84 | 5.4 KB | 0 | 174.6 | 16649.7 | 0 | 7.4 |
| workflow-separate | pass | 2 | 12 | 4.77 | 189.24 | 4.5 KB | 0 | 200.9 | 16666 | 0.1 | 7.4 |
| workflow-batch | pass | 2 | 8 | 11.94 | 943.29 | 5.3 KB | 0 | 132.7 | 16611.3 | 0.2 | 7.5 |
| export-like-workflow | pass | 2 | 12 | 4.17 | 192.64 | 11.1 KB | 0 | 195.9 | 16474.1 | 0 | 7.5 |

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

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224108/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224108/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224108/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430224108/process-samples.json`

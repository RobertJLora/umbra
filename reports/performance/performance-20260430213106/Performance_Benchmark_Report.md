# CiC Performance Benchmark

Generated: 2026-04-30T21:31:06.961Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213106`

Benchmark kind: local HTTP fixture, no external account-auth pages.

## Summary

| Metric | Value |
|---|---:|
| Status | fail |
| Scenarios | 1 |
| Passed | 0 |
| Failed | 1 |
| Commands measured | 0 |
| Payload bytes measured | 0 B |
| Tabs left open | 0 |
| Fixture requests | 0 |
| Fixture response bytes | 0 B |
| Bridge auth latency | nullms |
| Bridge port | null |

## Benchmark Matrix

| Scenario | Status | Runs | Commands | p50 ms | p95 ms | Payload | Tabs left | Chrome CPU % after | Chrome RSS MB after |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bridge-start | fail | 0 | 0 | 0 | 0 | 0 B | 0 | 0 | 0 |

## Command Counts

| Command | Count |
|---|---:|


## Failures

| Scenario | Error |
|---|---|
| bridge-start | Error: listen EPERM: operation not permitted 127.0.0.1     at Server.setupListenHandle [as _listen2] (node:net:1986:21)     at listenInCluster (node:net:2065:12)     at node:net:2274:7     at process.processTicksAndRejections (node:internal/process/task_queues:90:21) |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213106/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213106/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213106/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430213106/process-samples.json`

# CiC Performance Benchmark

Generated: 2026-04-30T21:15:58.275Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430211558`

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
| bridge-start | fail | 0 | 0 | 0 | 0 | 0 B | 0 | 32 | 14763.5 |

## Command Counts

| Command | Count |
|---|---:|


## Failures

| Scenario | Error |
|---|---|
| bridge-start | Error: No free bridge port found in 47829-47852.     at LocalBridgeServer.start (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/bridge-core.js:56:11)     at process.processTicksAndRejections (node:internal/process/task_queues:104:5)     at async main (file:///Users/RobertLora/Documents/Claude%20Code%20Projects/System/Codex/codex-chrome-bridge/mcp-server/benchmark-performance.mjs:956:20) |

## Artifacts

- Results JSON: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430211558/results.json`
- Scenario JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430211558/results.jsonl`
- Command JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430211558/commands.jsonl`
- Process samples: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/performance/performance-20260430211558/process-samples.json`

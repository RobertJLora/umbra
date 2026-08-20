# Codex Chrome Bridge Full Suite Report

Generated: 2026-04-30T23:14:24.056Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430231402`

## Run Configuration

| Field | Value |
|---|---|
| Suites | baseline, concurrency, downloads, seo, cleanup |
| Port range | 47845-47852 |
| Timeout | 90000ms |
| Cleanup mode | closeTabs |
| Broker mode | rust |
| Downloads | /Users/RobertLora/Documents/Downloads |
| Shared key source | /Users/RobertLora/.codex/codex-chrome-bridge/shared-key |

## Summary

| Metric | Count |
|---|---:|
| Pass | 35 |
| Warn | 0 |
| Fail | 1 |
| Total results | 36 |
| Failure records | 0 |

## Suite Matrix

| Suite | Verdict | Pass | Warn | Fail | Logged elapsed |
|---|---|---:|---:|---:|---:|
| baseline | Pass | 3 | 0 | 0 | 8.8s |
| concurrency | Pass | 20 | 0 | 0 | 16.6s |
| downloads | Pass | 7 | 0 | 0 | 9s |
| seo | Pass | 4 | 0 | 0 | 3.7s |
| cleanup | Fail | 1 | 0 | 1 | 1.3s |

## Failure Log

| Suite | Task | Session | Tab | Error | Proposed fix |
|---|---|---|---:|---|---|
| - | - | - | - | None recorded. | - |

## Evidence Trail

| Suite | Task | Status | URL | File | Note |
|---|---|---|---|---|---|
| baseline | create-group-read-click-screenshot-close | pass | http://127.0.0.1:51944/baseline | /Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430231402/screenshots/baseline-baseline-1777590846930.png | Clicked text and saw Codex Bridge Baseline. |
| downloads | download-csv | pass | http://127.0.0.1:51993/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430231402-download-csv-sample.csv | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | download-xlsx | pass | http://127.0.0.1:52000/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430231402-download-xlsx-sample.xlsx | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | download-pdf | pass | http://127.0.0.1:52005/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430231402-download-pdf-sample.pdf | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | download-blob | pass | http://127.0.0.1:52011/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430231402-download-blob-blob.csv | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | rendered-pdf | pass | http://127.0.0.1:52021/files/codex-bridge-suite-20260430231402-rendered-pdf-inline.pdf | /Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430231402/screenshots/downloads-rendered-pdf-1777590860862.png | Rendered inline PDF can be opened and screenshot; DOM text may be unavailable in Chrome PDF viewer. |
| seo | local-rendered-technical-snapshot | pass | http://127.0.0.1:52025/seo |  | H1=1, links=2, images=3. |
| seo | public-rendered-vs-raw-status | pass | https://travelbagexperts.com/best-luggage-for-suits/?_verify=1777045074000 |  | Bridge captures rendered DOM state; curl/Firecrawl/Screaming Frog remain better for raw HTTP/header audits at scale. |
| cleanup | listeners-and-stdio-shutdown | fail |  |  | New listeners remain: 47852/96332 |

## Daily Use Recommendation

- Use Codex Chrome Bridge for signed-in Chrome state, tab groups, concurrent browser sessions, and Chrome-initiated downloads.
- Use Browser Use for fast public/in-app browsing where persistent auth and local downloads do not matter.
- Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.
- Use Firecrawl, curl, or Screaming Frog for public raw HTTP status, headers, large crawls, and repeatable technical SEO at scale.
- Keep password manager, cookies, tokens, OTP, passkeys, and account-security pages out of the bridge.

## Generated Files

- Results JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430231402/results.jsonl`
- Failures JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430231402/failures.jsonl`

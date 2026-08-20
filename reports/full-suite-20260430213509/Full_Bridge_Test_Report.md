# Codex Chrome Bridge Full Suite Report

Generated: 2026-04-30T21:36:50.934Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430213509`

## Run Configuration

| Field | Value |
|---|---|
| Suites | baseline, concurrency, downloads, seo, cleanup |
| Port range | 47833-47852 |
| Timeout | 90000ms |
| Cleanup mode | closeTabs |
| Downloads | /Users/RobertLora/Documents/Downloads |
| Shared key source | /Users/RobertLora/.codex/codex-chrome-bridge/shared-key |

## Summary

| Metric | Count |
|---|---:|
| Pass | 36 |
| Warn | 0 |
| Fail | 0 |
| Total results | 36 |
| Failure records | 0 |

## Suite Matrix

| Suite | Verdict | Pass | Warn | Fail | Logged elapsed |
|---|---|---:|---:|---:|---:|
| baseline | Pass | 3 | 0 | 0 | 11.5s |
| concurrency | Pass | 20 | 0 | 0 | 227.2s |
| downloads | Pass | 7 | 0 | 0 | 20.9s |
| seo | Pass | 4 | 0 | 0 | 8.4s |
| cleanup | Pass | 2 | 0 | 0 | 1s |

## Failure Log

| Suite | Task | Session | Tab | Error | Proposed fix |
|---|---|---|---:|---|---|
| - | - | - | - | None recorded. | - |

## Evidence Trail

| Suite | Task | Status | URL | File | Note |
|---|---|---|---|---|---|
| baseline | create-group-read-click-screenshot-close | pass | http://127.0.0.1:50262/baseline | /Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430213509/screenshots/baseline-baseline-1777584914773.png | Clicked text and saw Codex Bridge Baseline. |
| downloads | download-csv | pass | http://127.0.0.1:50589/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430213509-download-csv-sample.csv | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | download-xlsx | pass | http://127.0.0.1:50597/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430213509-download-xlsx-sample.xlsx | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | download-pdf | pass | http://127.0.0.1:50605/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430213509-download-pdf-sample.pdf | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | download-blob | pass | http://127.0.0.1:50610/downloads | /Users/RobertLora/Documents/Downloads/codex-bridge-suite-20260430213509-download-blob-blob.csv | Detected with filesystem polling on a fresh localhost origin; Chrome downloads permission not required for this fixture. |
| downloads | rendered-pdf | pass | http://127.0.0.1:50618/files/codex-bridge-suite-20260430213509-rendered-pdf-inline.pdf | /Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430213509/screenshots/downloads-rendered-pdf-1777585005725.png | Rendered inline PDF can be opened and screenshot; DOM text may be unavailable in Chrome PDF viewer. |
| seo | local-rendered-technical-snapshot | pass | http://127.0.0.1:50623/seo |  | H1=1, links=2, images=3. |
| seo | public-rendered-vs-raw-status | pass | https://travelbagexperts.com/best-luggage-for-suits/?_verify=1777045074000 |  | Bridge captures rendered DOM state; curl/Firecrawl/Screaming Frog remain better for raw HTTP/header audits at scale. |

## Daily Use Recommendation

- Use Codex Chrome Bridge for signed-in Chrome state, tab groups, concurrent browser sessions, and Chrome-initiated downloads.
- Use Browser Use for fast public/in-app browsing where persistent auth and local downloads do not matter.
- Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.
- Use Firecrawl, curl, or Screaming Frog for public raw HTTP status, headers, large crawls, and repeatable technical SEO at scale.
- Keep password manager, cookies, tokens, OTP, passkeys, and account-security pages out of the bridge.

## Generated Files

- Results JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430213509/results.jsonl`
- Failures JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/full-suite-20260430213509/failures.jsonl`

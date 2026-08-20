# Codex Chrome Bridge Full Suite Report

Generated: 2026-04-24T22:02:24.930Z

Report folder: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/subagent-ahrefs-20260424235317`

## Run Configuration

| Field | Value |
|---|---|
| Suites | ahrefs |
| Port range | 47829-47829 |
| Timeout | 180000ms |
| Cleanup mode | closeTabs |
| Downloads | /Users/RobertLora/Documents/Downloads |
| Shared key source | /Users/RobertLora/.codex/codex-chrome-bridge/shared-key |

## Summary

| Metric | Count |
|---|---:|
| Pass | 3 |
| Warn | 3 |
| Fail | 3 |
| Total results | 9 |
| Failure records | 3 |

## Suite Matrix

| Suite | Verdict | Pass | Warn | Fail | Logged elapsed |
|---|---|---:|---:|---:|---:|
| ahrefs | Fail | 3 | 3 | 3 | 1092.8s |

## Failure Log

| Suite | Task | Session | Tab | Error | Proposed fix |
|---|---|---|---:|---|---|
| ahrefs | top-pages-csv-export | suite_ahrefs_exports_20260424215317 | 574072952 | Timed out waiting for a new Ahrefs CSV for adaptivesecurity.com. | Retest the Ahrefs export modal selector flow; if the modal changed, patch browser_click_text or add a narrow export helper. |
| ahrefs | organic-keywords-csv-export | suite_ahrefs_exports_20260424215317 | 574072983 | Timed out waiting for a new Ahrefs CSV for adaptivesecurity.com. | Retest the Ahrefs export modal selector flow; if the modal changed, patch browser_click_text or add a narrow export helper. |
| ahrefs | referring-domains-csv-export | suite_ahrefs_exports_20260424215317 | 574072998 | Timed out waiting for a new Ahrefs CSV for adaptivesecurity.com. | Retest the Ahrefs export modal selector flow; if the modal changed, patch browser_click_text or add a narrow export helper. |

## Evidence Trail

| Suite | Task | Status | URL | File | Note |
|---|---|---|---|---|---|
| ahrefs | overview-readable-text-html | pass | https://app.ahrefs.com/site-explorer/overview?target=adaptivesecurity.com&mode=subdomains&country=us |  | All tools Dashboard Brand Radar AI Content Helper SMM Site Explorer Keywords Explorer Content Explorer Site Audit uSERP, LLC http + https Subdomains Settings Looker Studio ? About Team Our data Blog Robot Jobs Plans & pricing API Help Contact us English © 2026 |
| ahrefs | top-pages-csv-option | warn | https://app.ahrefs.com/v2-site-explorer/top-pages?target=adaptivesecurity.com&mode=subdomains&country=us&compareDate=prevMonth |  | Could not explicitly select CSV UTF-8; proceeding with the currently selected export option. |
| ahrefs | top-pages-csv-export | fail | https://app.ahrefs.com/v2-site-explorer/top-pages?target=adaptivesecurity.com&mode=subdomains&country=us&compareDate=prevMonth |  | Timed out waiting for a new Ahrefs CSV for adaptivesecurity.com. |
| ahrefs | organic-keywords-csv-option | warn | https://app.ahrefs.com/v2-site-explorer/organic-keywords?target=adaptivesecurity.com&mode=subdomains&country=us&compareDate=prevMonth |  | Could not explicitly select CSV UTF-8; proceeding with the currently selected export option. |
| ahrefs | organic-keywords-csv-export | fail | https://app.ahrefs.com/v2-site-explorer/organic-keywords?target=adaptivesecurity.com&mode=subdomains&country=us&compareDate=prevMonth |  | Timed out waiting for a new Ahrefs CSV for adaptivesecurity.com. |
| ahrefs | referring-domains-csv-option | warn | https://app.ahrefs.com/v2-site-explorer/refdomains?target=adaptivesecurity.com&mode=subdomains |  | Could not explicitly select CSV UTF-8; proceeding with the currently selected export option. |
| ahrefs | referring-domains-csv-export | fail | https://app.ahrefs.com/v2-site-explorer/refdomains?target=adaptivesecurity.com&mode=subdomains |  | Timed out waiting for a new Ahrefs CSV for adaptivesecurity.com. |

## Daily Use Recommendation

- Use Codex Chrome Bridge for signed-in Chrome state, tab groups, concurrent browser sessions, and Chrome-initiated downloads.
- Use Browser Use for fast public/in-app browsing where persistent auth and local downloads do not matter.
- Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.
- Use Firecrawl, curl, or Screaming Frog for public raw HTTP status, headers, large crawls, and repeatable technical SEO at scale.
- Keep password manager, cookies, tokens, OTP, passkeys, and account-security pages out of the bridge.

## Generated Files

- Results JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/subagent-ahrefs-20260424235317/results.jsonl`
- Failures JSONL: `/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/subagent-ahrefs-20260424235317/failures.jsonl`

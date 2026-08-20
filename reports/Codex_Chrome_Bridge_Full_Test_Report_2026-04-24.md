# Codex Chrome Bridge Full Test Report

Date: 2026-04-24

## Bottom Line

The Codex Chrome Bridge is working for the core purpose: signed-in primary Chrome control with session-owned tab groups, concurrent agents, rendered DOM/HTML reads, screenshots, clicks, and local downloads.

It is viable as Robert's default signed-in browser lane when Browser Use cannot provide primary Chrome auth or local downloads.

The one caveat is Ahrefs export bursts: focused Ahrefs lanes passed, but a later all-in-one stress run after several rapid exports hit CSV timeouts. Use focused lanes or cooldowns for heavy Ahrefs export testing until repeated-download throttling is better characterized.

## Final Evidence Matrix

| Lane | Status | Evidence |
|---|---|---|
| Unit/integration tests | Pass | `npm test` passed 17/17 in `mcp-server`. |
| Extension reload | Pass | Reloaded unpacked extension `kkfedeeiobahmhcgpffcelpepiljiomk` in primary Chrome after manifest permission change. |
| Baseline browser control | Pass | `reports/main-baseline-seo-final-20260425001652/results.jsonl`: create, group, read text, read HTML, screenshot, click text, close. |
| Concurrency | Pass | `reports/subagent-concurrency-20260424235059/results.jsonl`: 3, 5, and 8 sessions; separate groups; 48 cross-session denials across read/click/close checks. |
| Ahrefs | Pass | `reports/main-ahrefs-retest2-20260425000618/results.jsonl`: Overview text/html plus Top Pages, Organic Keywords, Refdomains CSV exports. |
| Social read-only | Pass | `reports/main-social-research-retest-20260424235905/results.jsonl`: X, Reddit, LinkedIn read-only checks passed. |
| Public research | Pass with warning | Same report: Wikipedia and Hacker News passed; `example.com` produced Chrome error-page DOM warning and suite continued. |
| Downloads | Pass | `reports/full-suite-20260424214958/results.jsonl`: CSV, XLSX, PDF, rendered PDF screenshot, blob CSV. |
| Tech SEO snapshot | Pass | `reports/main-baseline-seo-final-20260425001652/results.jsonl`: rendered snapshot fields and Travel Bag Experts raw/rendered status 200 comparison. |
| Cleanup | Pass | `reports/main-cleanup-retest-20260425000742/results.jsonl`: only `47821` remained before/after; stdio shutdown probe exited. |
| All-in-one stress | Known risk | `reports/final-full-suite-20260425000813/failures.jsonl`: rapid repeated Ahrefs CSV exports timed out after prior export bursts. |

## Ahrefs Downloads Produced

- `/Users/RobertLora/Documents/Downloads/adaptivesecurity.com-top-pages-subdomains-u_2026-04-25_00-06-23.csv` - 21,046 bytes, 139 lines.
- `/Users/RobertLora/Documents/Downloads/adaptivesecurity.com-organic-keywords-subdo_2026-04-25_00-06-26.csv` - 345,110 bytes, 1,028 lines.
- `/Users/RobertLora/Documents/Downloads/adaptivesecurity.com-refdomains-subdomains_2026-04-25_00-06-28.csv` - 94,106 bytes, 1,301 lines.

## Bridge Changes Made

- Added `mcp-server/full-suite-runner.mjs` with named suites: `baseline`, `concurrency`, `ahrefs`, `social`, `research`, `downloads`, `seo`, `cleanup`.
- Added `npm run suite`, `npm run listeners`, and `npm run cleanup:test`.
- Patched active and canonical extension manifests to use literal `<all_urls>` host permission for screenshots.
- Hardened Ahrefs export suite with modal-scoped Export clicks and report-specific CSV filename matching.
- Hardened research suite so one error-page DOM logs a warning instead of aborting the lane.
- Hardened downloads suite with fresh localhost origins per file type.
- Fixed cleanup listener parsing.
- Updated README, smoke docs, permissions/security docs, and `~/.codex/skills/signed-browser/SKILL.md`.

## Security Notes

- No cookie, token, password-manager, passkey, OTP, local storage, browser history, or CAPTCHA tooling was added.
- No Chrome `downloads`, `debugger`, `nativeMessaging`, or background fetch permission was added.
- Screenshots activate a session-owned tab and use broad host permission; this is documented in `docs/permissions.md`.
- Local transport remains loopback-only with shared-key HMAC binding.
- `cleanup:test` preserves the registered `47821` MCP listener and clears test listeners on `47822-47836`.

## Daily Use Recommendation

Use the bridge for signed-in primary Chrome workflows: Ahrefs exports, authenticated app pages, grouped multi-tab research, screenshots, and downloads into `/Users/RobertLora/Documents/Downloads/`.

Use Browser Use for quick public/in-app browsing where auth and local downloads do not matter.

Use Google Sheets MCP for durable Ahrefs exports that need to be reopened by later agents.

Use Firecrawl, curl, Screaming Frog, or PageSpeed for public raw HTTP status, headers, crawls, and large-scale technical SEO checks.

## Commands

Run focused full-suite lanes:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/mcp-server"
CODEX_CHROME_BRIDGE_SHARED_KEY_FILE="/Users/RobertLora/.codex/codex-chrome-bridge/shared-key" npm run suite -- --suites baseline,downloads,seo --port-start 47829 --port-end 47836 --timeout-ms 90000
CODEX_CHROME_BRIDGE_SHARED_KEY_FILE="/Users/RobertLora/.codex/codex-chrome-bridge/shared-key" npm run suite -- --suites concurrency --port-start 47829 --port-end 47836 --timeout-ms 90000
CODEX_CHROME_BRIDGE_SHARED_KEY_FILE="/Users/RobertLora/.codex/codex-chrome-bridge/shared-key" npm run suite -- --suites ahrefs --port-start 47835 --port-end 47835 --timeout-ms 180000
```

Check and clean test listeners:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/mcp-server"
npm run listeners
npm run cleanup:test
```

Failure log:

```text
/Users/RobertLora/Documents/Workspaces/System/Codex/codex-chrome-bridge/reports/Full_Suite_Failure_Log_2026-04-24.jsonl
```

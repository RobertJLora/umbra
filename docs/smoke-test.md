# Smoke Tests

Use these paths for V0 validation. The isolated-profile path avoids touching Robert's primary Chrome profile; the primary-profile path proves the bridge can use already-signed-in Chrome state.

## What The Smoke Test Covers

- extension authenticates to the local bridge server over loopback
- `browser_create_tab` creates one session-owned tab
- `browser_list_tabs` returns only the session-owned tab set
- `browser_navigate` moves that owned tab to a local fixture page
- `browser_get_page_content` reads title, URL, and body text from the fixture
- `browser_close_tab` closes the smoke tab
- `browser_get_session_status` reports owned tabs and cleanup blast radius without mutating Chrome

The smoke test does not cover downloads, cookies, storage, tokens, passwords, CAPTCHA handling, or signed-in third-party sites.

## Primary Chrome Results

Verified on 2026-04-24 after loading the unpacked extension into Robert's signed-in Chrome profile:

- `npm run smoke` passed create/list/navigate/read/close against local fixture pages.
- `npm run smoke:auth` reached `https://app.ahrefs.com/dashboard` and returned title `Dashboard - Ahrefs` without dumping page body content.
- `npm run smoke:required` passed two concurrent sessions, three owned tabs, cross-session denial, and a controlled CSV download to `/Users/RobertLora/Documents/Downloads/`.
- `npm run smoke:groups` passed with five concurrent sessions, eight tabs per session, forty total tabs, five visible Chrome tab groups, clean group names, and all owned tab titles read back correctly.
- Bridge-driven Ahrefs export passed on 2026-04-24: Top Pages for `adaptivesecurity.com`, CSV UTF-8, all 138 rows, saved to `/Users/RobertLora/Documents/Downloads/adaptivesecurity.com-top-pages-subdomains-u_2026-04-24_23-25-21.csv`.
- Full-suite baseline passed on 2026-04-24 after manifest reload: create, group, read text, read HTML, screenshot, click visible text, and close.
- Full-suite downloads passed on 2026-04-24 for CSV, XLSX, PDF, rendered PDF screenshot, and blob CSV using filesystem polling. The runner uses a fresh localhost origin for each file case to avoid Chrome's multiple-automatic-download guardrail.
- Full-suite SEO passed on 2026-04-24 for rendered DOM technical snapshot, public page rendered status, and raw `HEAD` comparison.
- Full-suite Ahrefs focused retest passed on 2026-04-24 for `adaptivesecurity.com`: Overview text/html, Top Pages CSV, Organic Keywords CSV, and Refdomains CSV.
- Full-suite social/research retest passed on 2026-04-24 for read-only X, Reddit, LinkedIn, Wikipedia, and Hacker News. `example.com` returned a Chrome error-page DOM warning and the runner continued.
- Full-suite cleanup retest passed on 2026-04-24: only the legitimate `47821` listener remained after safe test cleanup.
- A single all-in-one stress run after repeated Ahrefs exports hit CSV timeouts. Use focused lanes or cooldowns for heavy Ahrefs export testing until repeated-download throttling is better characterized.
- Stdio shutdown probe passed on 2026-04-24: a server launched with closed stdin opened a test port, exited with `stdin_end`, and left no listener behind.

Run the heavier group test:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra/mcp-server"
UMBRA_SHARED_KEY_FILE="/Users/RobertLora/.umbra/shared-key" \
UMBRA_SMOKE_TIMEOUT_MS=90000 \
UMBRA_STRESS_SESSIONS=5 \
UMBRA_STRESS_TABS=8 \
npm run smoke:groups
```

Expected result:

- one local bridge server per fake Codex session
- one Chrome tab group per session
- every session sees only its own group and tabs
- cross-session reads fail with an ownership error
- all created tabs are closed before exit
- no listener remains from the stress sessions; the registered Codex MCP server may still legitimately occupy `47821`

When the registered MCP server is active, `47821` may already be occupied. The stress smoke defaults to `47829` so it can run beside the active MCP server. Override only when needed:

```bash
UMBRA_STRESS_PORT_START=47829 npm run smoke:groups
```

## Full-Suite Runner

Use this when validating the primary signed-in Chrome bridge after code or extension changes:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra/mcp-server"
UMBRA_SHARED_KEY_FILE="/Users/RobertLora/.umbra/shared-key" \
npm run suite -- --suites baseline,concurrency,ahrefs,social,research,downloads,seo,cleanup --port-start 47829 --port-end 47852 --timeout-ms 90000
```

Each run writes a dated folder under:

```text
/Users/RobertLora/Documents/Workspaces/System/Umbra/reports/
```

Expected artifacts:

- `Full_Bridge_Test_Report.md`
- `results.jsonl`
- `failures.jsonl`
- `screenshots/` when a suite captures visible tabs or PDFs

The runner closes owned test tabs and stops its own bridge listeners by default. If a failure needs visual debugging, rerun with `--keep-open-on-fail` and document any listener/port left open.

Safe listener cleanup that preserves the registered `47821` MCP listener and active agent sessions:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra/mcp-server"
npm run listeners
npm run cleanup:test
```

`cleanup:test` only removes disconnected non-`47821` bridge listeners. Use `npm run cleanup:test:force` only when you intentionally want to clear every non-`47821` bridge listener, including active ad hoc agent sessions. Use `npm run cleanup` only when you intentionally want to kill every bridge listener in `47821-47852`, including the registered MCP listener on `47821`.

## Automated Path

Use this first. It launches a separate Chrome profile, configures the unpacked extension through Chrome DevTools Protocol, runs the MCP smoke test, and then closes that test Chrome process.

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra"
./scripts/run-automated-smoke.sh
```

On Robert's machine, this script automatically uses the Playwright-managed Chrome for Testing binary when present:

```text
/Users/RobertLora/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

It creates a fresh ignored profile under `.local/chrome-automated-smoke-profile-*` by default. Reusing a profile across different Chrome builds can crash or hang the test browser.

Verified result on 2026-04-24:

- extension target found and configured
- local bridge authenticated
- `browser_create_tab` returned a session-owned tab
- `browser_list_tabs` returned that owned tab
- `browser_navigate` reached the local fixture URL
- `browser_get_page_content` returned the expected title, URL, and body text
- wrapper exited with no listener left on the bridge/CDP ports

This CDP usage is a test harness only. It is not the recommended daily browser-control architecture.

## Manual Path

### 1. Generate A Test Key

```bash
openssl rand -hex 32
```

Keep the value in your terminal. Do not commit it.

### 2. Launch An Isolated Chrome Profile

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra"
./scripts/launch-test-profile.sh
```

By default this uses:

```text
/Users/RobertLora/Documents/Workspaces/System/Umbra/.local/chrome-test-profile
```

That directory is ignored by git. The launcher refuses to use the normal Chrome profile root under `~/Library/Application Support/Google/Chrome`.

### 3. Configure The Extension

In the test Chrome window:

1. Confirm the unpacked `Umbra` extension is loaded.
2. Open the extension popup or options page.
3. Paste the shared key from step 1.
4. Set the port range to `47821-47852`.
5. Keep loopback session scanning enabled.
6. Save and reconnect.

Chrome still has to visibly load the unpacked extension. That is intentional for V0 review.

### 4. Run The Smoke Test

In a terminal:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra/mcp-server"
UMBRA_SHARED_KEY="paste-key-here" \
UMBRA_SMOKE_TIMEOUT_MS=60000 \
npm run smoke
```

Expected result:

- the bridge logs the chosen loopback port
- the extension authenticates
- Chrome opens a local fixture page in the isolated profile
- the command exits with JSON containing `"ok": true`

## Download Permission Decision

V0 keeps Chrome's `downloads` API permission out of this bridge. Full-suite local testing shows filesystem polling can detect normal CSV, XLSX, PDF, and blob downloads after a bridge-initiated click. If future Ahrefs or Google Drive exports need exact download failure/completion events per tab/session, review `downloads` separately before adding it.

## Hardening Tests

`npm test` includes contract tests that pin the current CiC safety posture:

- every advertised MCP tool must have a background handler, and no private `browser_*` handlers can bypass the schema
- tab read/mutate tools must resolve session-owned tabs before touching Chrome
- routine open, navigation, and DOM interaction tools must stay background-first unless `activate: true`
- screenshot remains the only intentionally activating read path
- visible cleanup must close whole windows only when every tab in that window is owned by the session
- the manifest must not request cookies, history, debugger, downloads, password, or token-style permissions
- navigation must reject risky URL schemes such as `javascript:` and `data:`

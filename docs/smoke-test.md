# Verification

Four ways to prove an install works, from cheapest to most thorough. Run the unit tests on every change, the isolated smoke before touching a signed-in profile, and the full suite before a release.

None of these paths reads or exports cookies, tokens, storage values, or passwords, and none of them solves a CAPTCHA. The heavier lanes do drive real pages in whatever profile you point them at, so read the profile note in each one.

## 1. Unit and contract tests

```bash
cd mcp-server
npm test
```

No browser, no network, no Chrome. This is the gate every change has to pass.

The suite includes contract tests that pin the safety posture, so a change that widens the boundary fails here rather than in review:

- every advertised MCP tool has a background handler, and no unadvertised `browser_*` handler bypasses the schema
- every tab read and mutate tool resolves a session-owned tab before touching Chrome
- routine open, navigation, and DOM tools stay background-first unless `activate: true`
- screenshot is the only intentionally activating read path
- group adoption stays conservative and ref-based tools stay owned-tab scoped
- predefined page actions stay behind owned-tab resolution and return JSON-safe results
- navigation rejects risky URL schemes such as `javascript:` and `data:`
- the manifest requests no cookie, token, history, password, or downloads permission
- `chrome.debugger` is used only to attach, run one command, and detach, for silent screenshots, owned-tab file upload, and caller-supplied JavaScript
- cleanup closes a window only when every tab in it belongs to the session

Rust changes have their own gate:

```bash
cargo test --manifest-path rust-broker/Cargo.toml
cargo test --manifest-path rust-broker/Cargo.toml --test runtime -- --ignored --nocapture
```

The second command binds real loopback sockets, which is why it is ignored by default.

## 2. Automated isolated-profile smoke

Run this before pointing anything at a profile you are signed into. It launches a separate Chrome with a throwaway profile, configures the unpacked extension over the DevTools Protocol, runs the MCP smoke test, and closes that Chrome.

```bash
./scripts/run-automated-smoke.sh
```

It prefers a Chrome for Testing binary when one is installed and falls back to the system Chrome. It creates a fresh ignored profile under `.local/chrome-automated-smoke-profile-*` each run, because reusing one profile across different Chrome builds can hang or crash the test browser.

Expect `"ok": true` and no listener left behind on the bridge port range or the DevTools port.

The DevTools Protocol here is a test harness for configuring an unpacked extension without a human clicking through the options page. It is not how Umbra drives a browser in normal use.

## 3. Manual smoke in a test profile

**Generate a throwaway key.**

```bash
openssl rand -hex 32
```

**Launch an isolated profile.**

```bash
./scripts/launch-test-profile.sh
```

It uses `.local/chrome-test-profile` by default, a git-ignored directory, and refuses to run against the normal Chrome profile root.

**Configure the extension.** In the test window, confirm the unpacked extension loaded, open its options page, paste the key, set the port range to `47821-47852`, keep loopback scanning enabled, then save and reconnect.

**Run the smoke test.**

```bash
cd mcp-server
UMBRA_SHARED_KEY="paste-key-here" UMBRA_SMOKE_TIMEOUT_MS=60000 npm run smoke
```

It creates a session-owned tab, lists owned tabs, navigates to a local fixture page, reads the title, URL, and body text, and closes the tab. Expect the bridge to log its chosen loopback port, the extension to authenticate, and the command to exit with `"ok": true`.

Other lanes, all reading the key from `UMBRA_SHARED_KEY_FILE` when you do not want it in shell history:

| Command | What it proves |
| --- | --- |
| `npm run smoke` | create, list, navigate, read, close on one session |
| `npm run smoke:rust` | the same path through the Rust broker |
| `npm run smoke:auth` | a signed-in page returns its title without dumping body content. Set `UMBRA_AUTH_CHECK_URL` to a page this browser profile is already signed into; there is no default, because which page proves session reuse depends on the account |
| `npm run smoke:required` | two concurrent sessions, cross-session denial, one download |
| `npm run smoke:groups` | five sessions, eight tabs each, one visible group per session |

The stress lane defaults to port `47829` so it can run beside a registered MCP server already holding `47821`. Override with `UMBRA_STRESS_PORT_START`.

```bash
cd mcp-server
UMBRA_SMOKE_TIMEOUT_MS=90000 UMBRA_STRESS_SESSIONS=5 UMBRA_STRESS_TABS=8 npm run smoke:groups
```

Expect one group per session, every session seeing only its own tabs, cross-session reads failing with an ownership error, every created tab closed at exit, and no listener left from the stress sessions.

## 4. Full-suite runner

The heaviest lane, and the one to run against a signed-in profile after code or extension changes. It drives real pages, so use a profile whose signed-in state you are comfortable automating.

```bash
cd mcp-server
npm run suite -- --suites baseline,concurrency,downloads,seo,cleanup --port-start 47833 --port-end 47852 --timeout-ms 90000
```

Each run writes a dated folder under `reports/` at the repository root containing `Full_Bridge_Test_Report.md`, `results.jsonl`, `failures.jsonl`, and a `screenshots/` directory when a suite captured anything. That whole path is git-ignored, because a run captures whatever pages it drove.

The runner closes its own tabs and stops its own listeners by default. Add `--keep-open-on-fail` when a failure needs visual debugging, and note any port left open.

Download cases each use a fresh localhost origin, because Chrome throttles multiple automatic downloads from one origin.

## Cleaning up after a run

```bash
cd mcp-server
npm run listeners        # what is currently bound in the range
npm run cleanup:test     # remove only disconnected listeners, preserving 47821
```

`npm run cleanup:test:force` clears every non-`47821` bridge listener including live ad hoc sessions. `npm run cleanup` clears the whole range including the registered MCP listener. Reach for either one deliberately.

## Diagnosing a failure

```bash
cd mcp-server
npm run doctor
```

It reports the extension directory it resolved, whether Chrome has that unpacked extension registered, which bridge listeners answered, and a plain-language `problems` list naming the switch that fixes each one. `npm run recover` runs the same diagnostic with its repair steps enabled.

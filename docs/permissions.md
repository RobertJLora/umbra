# Permissions

## Extension Permissions

## `tabs`

Needed to create, update, query, and close session-owned tabs.

Risk:

- access to metadata for tabs the extension can see

Mitigation:

- session ownership checks gate every action

## `tabGroups`

Needed to isolate each Codex session into its own tab group.

Risk:

- can regroup tabs if misused

Mitigation:

- grouping is done only for session-owned tabs

## `scripting`

Needed for one-shot DOM reads and interactions without a persistent content script.

Risk:

- code runs inside visited pages

Mitigation:

- only explicit tool actions inject code
- no page-wide resident content script in V1

## `storage`

Needed for local extension config and persisted ownership metadata.

Risk:

- stores secrets and session metadata locally

Mitigation:

- keep only the shared install key and session metadata
- avoid durable sensitive browsing data

## `offscreen`

Needed to keep long-lived loopback WebSocket connections stable in MV3.

Risk:

- adds another privileged extension surface

Mitigation:

- offscreen document is narrowly scoped to bridge connectivity only

## `debugger`

Needed for silent screenshots that must not activate the tab, and for owned-tab file input uploads.

Risk:

- Chrome shows a user-facing "controlled by automated test software" banner
- the API can do far more than screenshots and file inputs if misused

Mitigation:

- attach only to the session-owned tab
- one helper attaches, runs the command, then detaches in `finally`
- silent screenshots send only `Page.captureScreenshot`
- file upload sends only `DOM.getDocument`, `DOM.querySelector`, and `DOM.setFileInputFiles`
- if attach fails, return an error instead of falling back to `captureVisibleTab`
- no generic debugger command tool

## Host Permissions

- `<all_urls>`
- `http://127.0.0.1/*`
- `http://localhost/*`

Why:

- loopback WebSocket connectivity
- arbitrary browsing and DOM interaction against real signed-in sites
- Chrome requires a literal broad host permission for programmatic visible-tab screenshots; `activeTab` is not enough without a user gesture

Risk:

- broad page reach
- visible-tab screenshots can capture the active browser viewport for the session-owned tab

Mitigation:

- V1 ships no cookie/storage export tools
- all actions are session-scoped and explicit
- default screenshots activate a session-owned tab and use `chrome.tabs.captureVisibleTab`
- `silent: true` captures without activating, using `chrome.debugger` attach plus `Page.captureScreenshot` on the session-owned tab only, then detach. It does not fall back to `captureVisibleTab`
- `debugger` is also attached only for owned-tab file input uploads and is detached in the same call
- a future allowlist mode is planned for higher-security workflows

## Permissions Deliberately Not Requested In V0

## `cookies`

Rejected for V0. Cookie read/write is outside the safety boundary and would turn the bridge into a credential-adjacent data extractor.

## `debugger`

Used only for silent screenshots (`Page.captureScreenshot`) and `browser_file_upload` (`DOM.setFileInputFiles`). The background worker attaches to the owned tab, runs that one command, then detaches in a `finally` block. It is not used for cookies or generic page control.

## `downloads`

Deferred for V0. Chrome's downloads API can initiate, monitor, search, and manipulate browser downloads, which is useful for completion detection but expands the extension's visibility into local file transfers.

Current recommendation:

- keep robust downloads in the existing `download-browser` Playwright lane for now
- add `downloads` only after a focused review that proves bridge-side mapping from tab/session to download is worth the added permission

# Permissions

Every permission the extension declares, why it is there, what it costs, and what stops it being abused. The manifest is `extension/manifest.json`, and it is short enough to read in a minute.

## Declared permissions

### `storage`

Holds the shared key, the loopback port range, the enabled flag, and an install id in `chrome.storage.local`, plus per-session tab ownership in `chrome.storage.session`.

Risk: a local secret sits in extension storage.

Mitigation: nothing else is written. No page content, no browsing history, no credentials. Session ownership lives in `chrome.storage.session`, which Chrome clears when the browser closes.

### `tabs`

Creates, updates, queries, and closes session-owned tabs, and reads the title and URL of the tabs a session owns.

Risk: the API can see metadata for every tab in the profile.

Mitigation: every tool resolves its target through the session ownership map before Chrome is called, and `browser_list_tabs` filters to the caller's own tabs. A tab no session owns is invisible to every session.

### `activeTab`

Covers the visible-tab capture path in the ordinary case where the session's tab is the active one.

Risk: minimal. The grant is per user gesture and per tab.

Mitigation: it is not sufficient on its own for programmatic capture, which is why site access exists as a separate optional grant.

### `tabGroups`

Gives each session its own named tab group, which is what makes an agent's tabs visually distinct from a person's.

Risk: the API can regroup tabs if misused.

Mitigation: grouping only ever touches tabs the session already owns.

### `scripting`

Injects the content agent, the accessibility walker, and one-shot read and interaction functions into owned tabs.

Risk: code runs inside visited pages.

Mitigation: injection happens only as part of an explicit tool call against an owned tab. The manifest declares no `content_scripts` key, so nothing is resident on any page, and nothing is injected into a tab the caller does not own.

### `offscreen`

Runs the document that holds the loopback WebSocket, because an MV3 service worker is killed after about thirty seconds idle and cannot hold a long-lived connection.

Risk: another privileged extension surface to review.

Mitigation: the document does one job. It holds sockets, authenticates, relays messages, and sends a keepalive. It makes no Chrome API call and holds no ownership state. It is created only when the bridge is enabled and a shared key is set, and it is closed when the key is cleared.

### `alarms`

One wake alarm, once a minute, that resurrects the offscreen document if it died.

Risk: none beyond a periodic worker wake.

Mitigation: the alarm ensures the offscreen document exists and does nothing else.

### `debugger`

Three jobs: silent screenshots that do not activate the tab (`Page.captureScreenshot`), file input population (`DOM.setFileInputFiles`), and caller-supplied JavaScript (`Runtime.evaluate`).

Risk: this is the widest permission in the manifest. The API can do far more than these three things, and Chrome shows a "controlled by automated test software" banner whenever it is attached.

Mitigation:

- attach only to a tab the calling session owns
- one helper owns attach and detach, refcounted so two concurrent calls on one tab cannot detach out from under each other, and released when the count reaches zero
- a foreign attach, such as a person having DevTools open, raises a `debugger_busy` error rather than running commands that would silently fail
- caller-supplied JavaScript runs here rather than through an `AsyncFunction` constructor inside the extension, which is the reason this permission is worth its cost: it keeps arbitrary code inside the API Chrome sanctions for it
- there is no generic "send any debugger command" tool

## Optional host permission

`<all_urls>` is declared under `optional_host_permissions`, so it is not granted at install. The options page asks for it with the Grant Site Access button.

Why it is needed at all:

- reading and driving arbitrary signed-in pages, which is the entire point of the extension
- Chrome requires a literal broad host permission for programmatic visible-tab screenshots, and `activeTab` is not enough without a user gesture

Risk: broad page reach once granted, and visible-tab capture of the session-owned tab.

Mitigation:

- nothing is granted until a person clicks the button, and Chrome lets them revoke it at any time
- until it is granted, page reads, interaction, and screenshots fail with Chrome's own permission error, so the first thing to check when everything fails at once is the Site Access card on the options page
- every action stays session-scoped after the grant; the permission widens which pages a session may drive, never which tabs it may touch
- no cookie, token, or storage export tool exists to make the reach worth stealing

Loopback host permissions are deliberately absent. The only network activity in the extension is the WebSocket in the offscreen document, and that is allowed by the `connect-src` directive in the manifest's content security policy, not by a host permission. There is no `fetch` or `XMLHttpRequest` anywhere in the extension.

## Permissions deliberately not requested

**`cookies`** would turn the extension into a credential extractor. Reading and writing cookies is outside the boundary this project draws, and no tool needs it.

**`downloads`** could initiate, monitor, search, and cancel browser downloads. Download completion is detected by watching the filesystem instead, which is why `UMBRA_DOWNLOAD_DIR` exists. The trade is deliberate: a configuration variable in exchange for no visibility into the profile's download history. `chrome.downloads.DownloadItem` also carries no tab id, so the permission would not even buy reliable per-session attribution.

**`history`, `bookmarks`, and `topSites`** would expose durable personal data that no browser automation task here needs.

**`nativeMessaging`** would add a second privileged local surface with its own installer and its own review. The loopback WebSocket already does the job.

**`webNavigation`** would give precise navigation commit events. Navigation waits use `chrome.tabs.onUpdated` plus a URL comparison instead, which is enough to tell a completed load from a redirect.

**`clipboardRead` and `clipboardWrite`** are not requested, so nothing here can read or plant clipboard contents.

**`identity`** is not requested. The extension performs no sign-in of its own and holds no account.

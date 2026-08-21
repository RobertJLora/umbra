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

Mitigation: every tool that acts on a tab resolves its target through the session ownership map before Chrome is called, and `browser_list_tabs` filters to the caller's own tabs. Two read tools are scoped wider on purpose: `browser_find_tabs` and `browser_find_groups` return the title and URL of unowned tabs and groups, because handing a tab to a session needs a way to name it. They read nothing else, and no acting tool will touch a tab until `browser_adopt_tab` claims it.

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

Mitigation: injection happens only as part of an explicit tool call against an owned tab. The manifest declares no `content_scripts` key, so nothing is injected into a tab the caller does not own, and nothing is resident on a page except one thing: every driven page keeps a single empty `<umbra-cursor-layer>` element. The element is created whenever the overlay script is injected, which is on every driven page, whether or not the agent cursor is switched on; the setting controls whether anything is ever drawn inside it, not whether it exists. It holds every pixel of the cursor in a closed shadow root, has no text, no role and no pointer events, and it is dropped from every HTML read and from the `htmlLength` figure. Turn the drawing off per install on the options page, or per session with `browser_cursor`.

### `offscreen`

Runs the document that holds the loopback WebSocket, because an MV3 service worker is killed after about thirty seconds idle and cannot hold a long-lived connection.

Risk: another privileged extension surface to review.

Mitigation: the document holds sockets, authenticates, relays messages, and sends a keepalive, and it holds the frame buffer of a `browser_gif` recording plus the encoder that turns it into a file. It makes no Chrome API call and holds no ownership state. It is created only when the bridge is enabled and a shared key is set, and it is closed when the key is cleared, which also throws away any recording it was holding.

### `alarms`

One wake alarm, once a minute, that resurrects the offscreen document if it died.

Risk: none beyond a periodic worker wake.

Mitigation: the alarm ensures the offscreen document exists and does nothing else.

### `debugger`

Six jobs: silent screenshots that do not activate the tab (`Page.captureScreenshot`), file input population (`DOM.setFileInputFiles`), caller-supplied JavaScript (`Runtime.evaluate`), trusted clicks for download-gated controls (`Input.dispatchMouseEvent`), the frames of a `browser_gif` recording, which is the same `Page.captureScreenshot` call repeated at the recording's frame rate, and the request log behind `browser_read_network_requests` (`Network.enable`, then `Network.disable` when it stops).

Risk: this is the widest permission in the manifest. The API can do far more than these six things, and Chrome shows a "controlled by automated test software" banner whenever it is attached. A recording holds the attachment open for as long as it runs, so the banner stays up for the whole recording rather than flickering per call.

Risk, request logging specifically: it is the one job that watches traffic rather than performing an action, and it holds the attachment across many calls the way a recording does, so a caller who starts logging and never stops would leave the banner up on that tab.

Mitigation, request logging specifically:

- logging starts only on an explicit `browser_read_network_requests` call against a tab the session owns, never on install and never on any other tool
- the two commands above are the whole Network surface; no body and no header is ever read, so what the log holds is the URL, the method, the resource type, the status, the MIME type and the timing of each request
- request URLs are returned with their query strings intact, up to 600 characters, because a request log with the query stripped cannot answer what a caller asks it; a page that puts a session token or a signed URL in a query string therefore puts it in the log, and the log is capped, dropped on navigation and released on stop for exactly that reason
- the buffer is capped at 400 entries per tab, and a cross-hostname navigation drops it
- the attachment is released on `stop`, when the tab closes, when the session disconnects, and from a five-minute idle watchdog; those timers live in the service worker, so if Chrome evicts the worker while a log is open the attachment outlives them, and the recovery is a worker-boot sweep that walks `chrome.debugger.getTargets()` and detaches every attached target no live pin claims

Mitigation:

- attach only to a tab the calling session owns
- one helper owns attach and detach, refcounted so two concurrent calls on one tab cannot detach out from under each other, and released when the count reaches zero
- a recording claims one refcount on that same counter for its duration and releases it on stop, on clear, when the tab closes, when the session disconnects, and from a three-minute watchdog; the same eviction caveat and the same worker-boot sweep apply, and the recording's own control record is kept in `chrome.storage.session` so a resurrected worker can still stop and export it
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

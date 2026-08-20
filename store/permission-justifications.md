# Permission Justifications

Paste-ready text for the Privacy practices tab of the Chrome Web Store developer dashboard, one entry per field. Each entry has three parts: the field it goes in, the text to paste, and the code a reviewer can open to check the claim. The verification notes are for whoever fills the form; they do not go in the box.

Everything here is checked against `extension/manifest.json` at version 0.4.7 and the code as packaged by `scripts/package-extension.sh`. If the manifest's permission list changes, this file changes with it, or the submission contradicts itself in the one place a reviewer looks first.

---

## Field: Single purpose

**Paste the block from `store/listing.md` under the heading "Single purpose statement".** It is the canonical wording and it is written to line up with the listing description a reviewer reads immediately before this field. Do not compose a second version here: two wordings of the same field in one submission is the drift a reviewer notices first.

**Verification**

The ownership boundary that statement rests on is one function. `extension/session-state.js:143` throws before any Chrome call when a session names a tab it does not own, and `extension/session-state.js:120` refuses to claim a tab another session already holds.

---

## Field: `storage`

**Paste this**

> Umbra stores five values in chrome.storage.local: the pairing key the user generates on the options page, the two ends of the loopback port range the extension scans, an enabled flag, and a random install id that distinguishes one browser profile from another during the local handshake. Per-session tab ownership is held in chrome.storage.session, which Chrome clears when the browser closes. No page content, browsing history, or credential is written to storage.

**Verification**

The complete set of stored keys is the `DEFAULT_CONFIG` object at `extension/shared.js:3`. Session state is a single record named `bridgeSessionState` at `extension/session-state.js:1`, written through `persist()` in the same file.

---

## Field: `tabs`

**Paste this**

> Umbra creates, updates, queries, and closes the tabs a session opened, and reads their title and URL to report session state back to the user's local companion. Every tool resolves its target through the per-session ownership map before Chrome is called, and the tab listing tool filters its output to the calling session's own tabs. A tab no session owns is invisible to the entire tool surface, so the permission's reach across the profile is never exposed to a caller.

**Verification**

`extension/session-state.js:143` is the single enforcement point, called from every tab-facing path in `extension/background.js`.

---

## Field: `activeTab`

**Paste this**

> Covers visible-tab capture in the ordinary case where the session's own tab is the active one, so a screenshot of a tab the user is already looking at works without a broader grant. The permission is scoped per user gesture and per tab. It is not sufficient on its own for programmatic capture, which is why site access is offered separately as an optional permission the user grants explicitly rather than at install.

**Verification**

The two programmatic capture calls are `extension/background.js:4602` and `extension/background.js:4622`. Chrome requires a literal broad host permission for both, which is why `activeTab` alone does not cover them.

---

## Field: `tabGroups`

**Paste this**

> Each agent session gets its own named Chrome tab group. That group is the visible boundary of the product: the user can tell at a glance which tabs an automated session owns and which are their own. Grouping only ever moves tabs the session already owns, and cleanup removes only groups the extension created. Without this permission the ownership model has no visual representation and automated tabs become indistinguishable from the user's own.

**Verification**

Group creation and update run through `extension/background.js:87` and `extension/background.js:1331`; the group id is stored per session at `extension/session-state.js:6`.

---

## Field: `scripting`

**Paste this**

> Injects the content agent, the accessibility-tree walker, and one-shot read and interaction helpers into a tab the calling session owns, as part of an explicit tool call. The manifest declares no content_scripts key, so nothing is resident on any page the user visits and nothing is injected into a tab the session does not own. Every injected file ships inside the package; none is fetched from anywhere.

**Verification**

The injection call sites are `extension/background.js:1347`, `:1824`, `:2076`, and `:2800`. The manifest has no `content_scripts` key. The files argument at `:2800` names package-local paths only.

---

## Field: `offscreen`

**Paste this**

> Holds the loopback WebSocket to the user's local companion server. An MV3 service worker is terminated after roughly thirty seconds idle and cannot hold a long-lived connection, so an offscreen document is the only supported way to keep the bridge open. That document does one job: hold the socket, authenticate, and relay messages. It makes no Chrome API call and holds no state. It is created only once a pairing key is set and closed when the key is cleared.

**Verification**

`extension/background.js:317` creates the document; `extension/background.js:264` closes it. The socket itself is `extension/offscreen.js:324`, and it is the only network call in the extension.

---

## Field: `alarms`

**Paste this**

> One alarm, fired once a minute, does exactly one thing: confirm that the offscreen document holding the loopback connection still exists and recreate it if Chrome tore it down. Without it, a user's session stops responding silently after the service worker is evicted and the only fix is reloading the extension by hand. The alarm makes no network request and touches no tab.

**Verification**

`extension/background.js:7` names the alarm, `:8` sets the one-minute period, `:365` creates it, and `:5273` is the handler.

---

## Field: `debugger`

This is the entry that decides the review. Keep it specific and keep it short enough to read in one pass.

**Paste this**

> Three jobs, all against a tab the calling session owns. Page.captureScreenshot takes a screenshot without activating the tab, so an agent working in the background never steals focus from the user. DOM.setFileInputFiles populates a file input, which no other extension API can do. Runtime.evaluate runs the JavaScript the user's own local companion supplies.
>
> Umbra deliberately routes caller-supplied JavaScript through Runtime.evaluate rather than compiling a string inside the extension. The package contains no eval, no new Function, and no AsyncFunction constructor, and the manifest keeps script-src 'self'. Attach and detach run through one reference-counted helper, a foreign attachment such as an open DevTools window raises a clear error rather than running commands that would fail silently, and there is no tool that sends an arbitrary debugger command.

**Verification**

`extension/background.js:4099` is the screenshot command, `:1655` the file input, and `:2020` the evaluate. Every one of them goes through `withOwnedTabDebugger` at `:1557`, which owns attach, detach, and the reference count. `grep -rn "AsyncFunction\|new Function(\|eval(" extension/*.js` returns nothing, and `scripts/verify-package.mjs` fails the build if that ever changes.

**Why this framing rather than a shorter one**

A reviewer's worry about `debugger` is arbitrary code and hidden capture. The answer to both is in the text: three named commands, a session-scoped attach, no passthrough tool, and a visible Chrome banner whenever the attachment is live. Naming `Runtime.evaluate` as the reason the package has no `eval` turns the widest permission into evidence of restraint rather than an unexplained ask.

---

## Field: Host permission `<all_urls>` (optional)

**Paste this**

> Umbra drives pages the user picks at run time, so the set of hosts cannot be enumerated in advance. The permission is declared under optional_host_permissions rather than host_permissions, so Chrome requests nothing at install: the user grants it with the Grant Site Access button on the options page and can revoke it from chrome://extensions at any time. It is also the only way to take a programmatic screenshot, because chrome.tabs.captureVisibleTab requires a literal broad host permission and activeTab is not enough without a user gesture. After the grant, every action stays session-scoped. The permission widens which pages a session may drive, never which tabs it may touch.

**Verification**

`extension/manifest.json:17` declares it as optional. The grant button calls `chrome.permissions.request` at `extension/options.js:248`, and the granted state is read at `extension/options.js:118` and `extension/popup.js:130`. Loopback host permissions are deliberately absent, because the WebSocket is allowed by the content security policy at `extension/manifest.json:43`, not by a host permission.

---

## Field: Are you using remote code?

**Select: No, I am not using remote code.**

**Paste this into the accompanying explanation, and repeat it in the reviewer notes**

> Every line the extension executes ships inside the package. There is no remotely hosted script, no eval, no new Function, no AsyncFunction constructor, and script-src is 'self'. The one path that runs a string is browser_javascript, which passes that string to chrome.debugger Runtime.evaluate. The string originates in a process on the user's own machine that the user started, and reaches the extension over a loopback WebSocket authenticated with a key the user generated. Nothing is fetched from a network host at any point in the extension's lifetime.

**Why this needs saying twice**

Under a strict reading, a string that was not in the zip is code that was not in the zip, and a reviewer scanning for the remote-code pattern will see `Runtime.evaluate` and stop. Pre-empting it costs four sentences. Discovering it as a rejection costs a review cycle. Put the same wording in both places so the two never drift apart.

---

## Length check

Chrome Web Store justification boxes are plain text with a per-field limit. Run this before pasting, and shorten any entry that reports over 1000 characters:

```bash
awk '/^\*\*Paste this/{f=1;next} /^\*\*Verification/{f=0} f&&/^> /{gsub(/^> /,"");n[h]+=length($0)+1} /^## Field/{h=$0} END{for(k in n) printf "%5d  %s\n", n[k], k}' store/permission-justifications.md | sort -rn
```

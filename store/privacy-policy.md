# Umbra Privacy Policy

Applies to the Umbra Chrome extension and the Umbra companion server (`@umbra-mcp/server`).

Last updated: 20 August 2026.

## The short version

Umbra collects nothing. It sends nothing to us, and it sends nothing to any server on the internet. Every byte it reads stays on the machine it was read on, and the only destination it can reach is a program running on that same machine, started by you, on a loopback address.

There is no account, no sign-in, no analytics, no telemetry, no crash reporting, no remote configuration, and no advertising. We operate no server that Umbra talks to, so there is nothing for us to store, sell, or hand over.

## What Umbra is

Umbra is two pieces that pair on a key you generate yourself:

- a Chrome extension that owns every Chrome API call
- a companion server that runs on your computer and exposes a browser tool surface to an MCP client such as an AI coding assistant

They talk to each other over a WebSocket on `127.0.0.1`, authenticated with an HMAC of the key you generated. The extension does nothing at all until that pairing exists.

## What the extension can access

**Tabs a session owns.** When your agent asks Umbra to open a tab, Umbra records that tab as belonging to that session and puts it in a named tab group. Every later action resolves its target through that ownership record before Chrome is called, and an action against a tab no session owns is refused before Chrome is touched (`extension/session-state.js:143`). A tab you opened yourself cannot be read, clicked, navigated, or closed by any session. It can still appear by title and URL in a `browser_find_tabs` result, which is how you point `browser_adopt_tab` at it.

**Page content inside those tabs.** Reading text, taking a screenshot, walking the accessibility tree, filling a form, or running JavaScript all operate on owned tabs only. That content is returned to the companion server on your machine and to nowhere else.

**Tab metadata.** The `tabs` permission lets Chrome report the title and URL of any tab in the profile. `browser_list_tabs` filters to the calling session's own tabs, so routine listing shows only what that session opened. Two tools deliberately reach wider so you can hand a tab over: `browser_find_tabs` and `browser_find_groups` return the title and URL of tabs and groups the session does not own, which is the only way `browser_adopt_tab` can be pointed at one. Nothing is read from those tabs beyond title and URL, and no action can touch them until you adopt one.

## What the extension stores

**In `chrome.storage.local`,** exactly five values (`extension/shared.js:3`):

- `sharedKey`: the pairing key you generate on the options page
- `portStart` and `portEnd`: the loopback port range the extension scans
- `bridgeEnabled`: whether the bridge is on
- `installId`: a random hexadecimal string generated locally, used to tell one browser profile from another during the local handshake

**In `chrome.storage.session`,** one record named `bridgeSessionState` (`extension/session-state.js:1`) holding the per-session tab ownership map: session id, port, tab group id, and the list of tab ids. Chrome clears session storage when the browser closes.

Nothing else is written. No page content is cached, no browsing history is recorded, no credentials are stored.

## Where data goes

The extension's only network activity in the entire codebase is one WebSocket to a loopback address (`extension/offscreen.js:324`):

```
ws://127.0.0.1:<port>/bridge
```

Three independent facts back that up, and any reviewer can check all three in a few minutes:

1. The manifest's content security policy declares `connect-src 'self' ws://127.0.0.1:* ws://localhost:*` (`extension/manifest.json:43`). Chrome blocks a connection to any other host at the browser level, whatever the code tries.
2. Grepping the extension for `fetch(`, `XMLHttpRequest`, and `sendBeacon` returns zero results. There is no HTTP client anywhere in it.
3. The companion server binds to `127.0.0.1` only (`mcp-server/bridge-core.js:193`) and closes any connection whose remote address is not `127.0.0.1` or `::1` (`mcp-server/bridge-core.js:210`). It is not reachable from your network, let alone from the internet.

The companion server likewise makes no outbound request. It listens on loopback and speaks MCP over standard input and output to the client that launched it. It writes to disk in exactly two places: the key file you asked for, and a screenshot file when a caller passes `outputPath` to `browser_screenshot`.

## The one thing that is not ours to control

Umbra hands page content to the MCP client you paired it with. What that client does next is that client's behavior, not Umbra's. If you point Umbra at an assistant that runs in the cloud, that assistant's own transport carries the content off your machine, exactly as it would for a file you pasted into it.

We state this plainly because it is the honest boundary. Umbra's guarantee is that Umbra itself transmits nothing off the machine. Choosing what receives the content is your decision, made when you configure your MCP client.

## Permissions the extension deliberately does not request

- `cookies`, so it cannot read or write cookies or export a session
- `history`, `bookmarks`, and `topSites`, so durable personal data is out of reach
- `downloads`, so it has no view of the profile's download history
- `clipboardRead` and `clipboardWrite`, so it cannot read or plant clipboard contents
- `identity`, so it performs no sign-in and holds no account
- `nativeMessaging`, so it installs no second privileged local surface

## Safeguards on the sensitive paths

**The `debugger` permission** is attached only to a tab the calling session owns, through a single reference-counted helper (`extension/background.js:1557`), and it is detached when the count reaches zero. There is no tool that sends an arbitrary debugger command. Chrome displays its own "controlled by automated test software" banner whenever the attachment is live, so the state is never hidden from you.

**JavaScript results are screened before they leave the page.** A result that looks like a cookie jar, a set-cookie header, a JWT, a bearer token carrying a recognisable prefix, or a long query-string secret is blocked rather than returned (`looksLikeSensitiveResult` in `extension/javascript-safety.js`). The screen matches shapes, so it is a backstop against an accidental leak rather than a guarantee against a caller who set out to encode one.

**Site access is not granted at install.** `<all_urls>` is declared under `optional_host_permissions`, so Chrome asks for nothing at install time. You grant it with a button on the options page (`extension/options.js:248`) and Chrome lets you revoke it at any time from `chrome://extensions`.

## Children

Umbra is a developer tool. It is not directed at children and collects no data from anyone, including children.

## Removing your data

Uninstalling the extension removes everything it stored, because everything it stored lived in that extension's own Chrome storage. To clear the pairing without uninstalling, open the options page and clear the key field, which also closes the bridge. To remove the companion server's key file, delete `~/.umbra/shared-key` and any rotation backups matching `~/.umbra/shared-key.bak-*`.

## Changes to this policy

Changes are published at this URL with an updated date at the top. Because Umbra collects nothing, a change here will describe a change in what the software accesses locally, not a change in what is transmitted.

## Contact

Questions and security reports go through the issue tracker at the project homepage listed on the Chrome Web Store entry and in the extension's manifest.

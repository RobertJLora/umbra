# Save hydration can park the scanner

Dated 2026-08-20. This is the operator record for why agents said `Chrome extension is not connected to the Rust broker` after a day of options-page updates, and why the first "fix" made a later Save worse.

## What an agent sees

Every `umbra__browser_*` call fails with:

```
Chrome extension is not connected to the Rust broker
{"extensionCode":"broker_command_failed"}
```

`node mcp-server/cli.js doctor --verify-health` and a raw Unix `health` probe both report:

* `extension_connected: false`
* `auth_failures: 0`
* `reason_codes: ["extension_disconnected"]`
* broker socket healthy at `~/.umbra/run/broker.sock`
* listener bound on `127.0.0.1:47821`

`auth_failures: 0` is the tell. The scanner is not even sending a hello. A key mismatch would increment `auth_failures` on the upgrade. Zero means the offscreen document is not running.

## What Chrome actually stored

The signed-in Chrome profile loads an unpacked copy. That copy is often not `extension/` inside this repository. Doctor looking at the repository folder will say the extension is not loaded. Point `UMBRA_EXTENSION_DIR` at the folder Chrome actually loaded, or inspect Chrome's `Local Extension Settings/<id>/` LevelDB for that profile.

The last LevelDB write on 2026-08-20 was:

* `bridgeEnabled` = `false`
* `sharedKey` present (64 hex characters)

The worker's debug row then loops every minute:

```
state: bridge_not_configured
message: Set a shared key in the Umbra options page to start the local bridge scanner.
```

That message was a lie. The key was there. `bridgeIsConfigured()` is `bridgeEnabled === true && Boolean(sharedKey)`, so a false flag parks the scanner and reuses the "set a key" copy. 0.5.1 splits that message: scanning off versus no key.

## Timeline

1. Broker was redone. MCP shims needed `register_session` rebound (fixed in `cb38a66`).
2. After the rebound, health showed the extension disconnected with `auth_failures: 0`.
3. Chrome storage already had `bridgeEnabled: false` next to a valid key. The options checkbox starts checked in HTML, but the stored value was false. A Save And Reconnect before `renderState` painted that stored value wrote false over a working install and closed the offscreen document.
4. `cb38a66` tried to fix that by awaiting `refresh()` / `refreshState()` at the start of Save, then reading the checkbox.
5. That second Save path is the one that kept the extension dead after the later options/onboarding edits.

## Why awaiting refresh() on Save is worse

Sequence that killed scanning on a later Save click:

1. Options page loads. The checkbox is checked in HTML, so the control looks on.
2. Stored `bridgeEnabled` is still `false` from the earlier footgun.
3. The user turns the switch on (or believes it is already on) and clicks Save And Reconnect.
4. Old 0.5.0 Save did `if (!settingsHydrated) await refresh()`.
5. `refresh()` calls `renderState()`, which paints the stored false onto the checkbox.
6. Save then reads `el('bridgeEnabled').checked`, which is now false, and writes false again.
7. `bridge_save_config` restarts the offscreen document. `ensureOffscreenDocument` sees `bridgeIsConfigured() === false` and closes it.

The user did the documented recovery. Save erased the click.

A second, independent desync also showed up in the same LevelDB log: a generated key that did not match `~/.umbra/shared-key`. Generate Key plus Save without copying the environment line leaves the companion holding the old key. Fix scanning first; a key mismatch is `auth_failures > 0`, not zero.

## 0.5.1 product fix

Do not refresh the form at the start of Save.

* Options and popup Save merge with stored config. The typed key wins if the field has one, otherwise the stored key is kept. The checkbox is trusted only after `settingsHydrated` is true. Before that, Save keeps the stored scanning flag (default on).
* `saveBridgeConfig` refuses to persist an empty key over a stored one.
* `ensureOffscreenDocument` says "scanning is off" when a key exists and the flag is false.

Tests live in `tests/extension/navigation-and-refs.test.mjs` (`does not persist an unhydrated Enable-scanning checkbox as false`).

## Live profile recovery (this machine)

Canonical `extension/` is not what Chrome loaded. After editing, copy at least:

* `options.js`, `options.html`, `popup.js`, `shared.js`, `background.js`, `manifest.json`

into both:

* `Projects/Active/codex-chrome-bridge/extension` (the Load unpacked path on 2026-08-20)
* `Projects/Active/umbra/extension`

Unpacked MV3 does not pick up those files until the worker reloads.

If Chrome has a DevTools browser WebSocket (`DevToolsActivePort`), attaching to the Umbra service worker and running `chrome.storage.local.set({ sharedKey, bridgeEnabled: true })` plus `chrome.runtime.reload()` restores pairing without a foreground options click. Write back the key from `~/.umbra/shared-key` so it matches the already-running companion.

Do not paste the key into git. Do not add a restore file inside `extension/`.

Proof after that reload: health `extension_connected: true`, `auth_failures: 0`, empty `reason_codes`, and a `browser_tabs_context` call that returns this session's owned tab.

## What not to do

* Do not `open -a "Google Chrome"` or open `chrome-extension://` from the shell. Those yank focus, and the shell open has no handler.
* Do not route signed-in research through a fresh Chromium profile.
* Do not Generate Key as a reconnect step. That creates a new secret the companion does not have.
* Do not treat `bridge_not_configured` as a missing key until you have checked `bridgeEnabled` in storage.
* Do not assume this repository's `extension/` folder is the running worker.

## Operator reconnect after 0.5.1

If scanning is off and a key is present: turn Enable loopback scanning on, wait for the status line to finish loading, then Save And Reconnect. Reload Extension if the worker is still sitting on old files. Wait for the violet status dot. Grey means this Chrome is still dark to agents.

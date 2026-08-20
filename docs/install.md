# Install

## 1. Choose A Shared Install Key

Generate one strong key and keep it local.

```bash
openssl rand -hex 32
```

## 2. Run The Automated Isolated Smoke First

This does not touch Robert's daily Chrome profile. It uses Chrome for Testing when available, creates a fresh ignored profile, loads the unpacked extension, configures a temporary shared key, runs the MCP smoke, then exits.

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra"
./scripts/run-automated-smoke.sh
```

Expected result includes `"ok": true` and no listener left on `47821-47852` or the CDP port.

## 3. Load The Extension In A Test Profile Manually

For V0 validation, start with the isolated profile launcher instead of Robert's primary Chrome profile:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra"
./scripts/launch-test-profile.sh
```

The launcher uses `.local/chrome-test-profile` by default and refuses the normal Chrome profile root.

If Chrome does not show the unpacked extension automatically:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select the local `extension/` folder
5. Open the extension popup and paste:
   - shared key
   - port range start
   - port range end

## 4. Install MCP Server Dependencies

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra/mcp-server"
npm install
npm test
```

## 5. Add The MCP Server To Codex

Add a new entry to `~/.codex/config.toml`:

```toml
[mcp_servers.umbra]
command = "node"
args = ["/Users/RobertLora/Documents/Workspaces/System/Umbra/mcp-server/index.js"]

[mcp_servers.umbra.env]
UMBRA_SHARED_KEY = "replace-with-output-of-openssl-rand-hex-32"
UMBRA_PORT_START = "47821"
UMBRA_PORT_END = "47852"
UMBRA_LOG_LEVEL = "info"
```

## 6. Restart Codex

Restart the session so the new MCP server is picked up.

## 7. Run The V0 Smoke Test

After the isolated Chrome profile has the extension configured with the same shared key:

```bash
cd "/Users/RobertLora/Documents/Workspaces/System/Umbra/mcp-server"
UMBRA_SHARED_KEY="replace-with-output-of-openssl-rand-hex-32" \
UMBRA_SMOKE_TIMEOUT_MS=60000 \
npm run smoke
```

The smoke test creates a session-owned tab, lists owned tabs, navigates to a local fixture page, reads title/URL/body text, and closes the tab. See `docs/smoke-test.md`.

## Notes

- Keep the extension and the MCP server on the same shared key.
- Do not commit the shared key.
- The server binds only to `127.0.0.1`.
- The extension has not yet been signed off for installation in Robert's primary daily Chrome profile.
- V0 does not implement download handling.

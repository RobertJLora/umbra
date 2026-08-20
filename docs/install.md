# Install

From nothing to a connected session. Two pieces have to meet: the Chrome extension, which owns every Chrome API call, and the companion MCP server, which your agent client talks to over stdio. They pair on one shared key you generate, and they talk only over a loopback WebSocket.

## Requirements

- Chrome 121 or newer, signed in to whatever you want the agent to reach
- Node.js 20 or newer
- An MCP client that can launch a local stdio server
- Rust and cargo, only if you want the optional broker described at the end

macOS and Linux are the supported platforms. Everything below works the same on both except the launchd job, which is macOS only.

## 1. Install the extension

**From a checkout**, which is what you want while developing or if you need the optional page recipes:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click **Load unpacked** and select the `extension/` folder from this repository.

**From the Chrome Web Store**: not yet. The listing has not been created, so a checkout is the only way to install the extension today. When it goes live, installing from the store is all there is to it: that build leaves out the page recipes, so the site-specific actions report a missing recipe, and every other tool is identical.

Either way, the extension opens its options page once on a fresh install, which is where the rest of this setup happens.

## 2. Install the companion server

From a checkout of the public repository:

```bash
git clone https://github.com/RobertJLora/umbra
cd umbra/mcp-server
npm install
npm test
```

The companion runs from the checkout, and every command below runs as `node mcp-server/<script>` from the repository root (or `node <script>` from inside `mcp-server/`).

The public checkout carries no optional local page-recipe plugins, so it advertises the built-in tool list and nothing else. A checkout that installs a plugin under `mcp-server/plugins/` lists that plugin's tools as well. Every built-in tool is the same in both.

## 3. Generate the shared key

Pick one side to generate it. The key is a 64-character hex string, and the extension and the server must hold the same one.

**From the extension**: open the options page, click **Generate Key**, then click **Copy Environment Line**. That puts a complete environment line on your clipboard:

```text
UMBRA_SHARED_KEY=<key> UMBRA_PORT_START=47821 UMBRA_PORT_END=47852
```

Click **Save And Reconnect** to store it in the extension.

**From the terminal**:

```bash
node mcp-server/cli.js pair
```

That writes the key to `~/.umbra/shared-key` with mode `-rw-------`, prints the key to paste into the options page, and prints the client config block. Pass `--rotate` to replace an existing key. To adopt a key you already have, prefer `umbra pair --stdin` or `umbra pair --key-file <path>`: `umbra pair <key>` puts the secret in process listings and shell history.

Do not commit the key, and do not paste it into anything but the options page and your MCP client config.

## 4. Point your MCP client at the server

Add an entry that runs the server on stdio. Using the key file keeps the secret in one place:

```json
{
  "mcpServers": {
    "umbra": {
      "command": "node",
      "args": ["<checkout>/mcp-server/cli.js", "start"],
      "env": { "UMBRA_SHARED_KEY_FILE": "<your-home>/.umbra/shared-key" }
    }
  }
}
```

Write the real absolute paths in place of `<checkout>` and `<your-home>`. MCP client config is not a shell, so `~` and `$HOME` are not expanded. `node mcp-server/cli.js pair` prints this exact block with the resolved paths filled in for you.

From a checkout, point at the launcher instead, which starts or reuses the Rust broker when one is available and falls back to the pure-Node bridge when it is not:

```json
{
  "mcpServers": {
    "umbra": {
      "command": "/absolute/path/to/umbra/mcp-server/launch-mcp.sh",
      "env": { "UMBRA_SHARED_KEY_FILE": "<your-home>/.umbra/shared-key" }
    }
  }
}
```

For a client that cannot reference a file, set `UMBRA_SHARED_KEY` to the key itself. An explicitly set `UMBRA_SHARED_KEY` always wins over the file.

Restart the client so it picks up the new server.

## 5. Grant site access

Umbra ships with no site access. Nothing needs it until a session drives a tab, so the install prompt asks for none.

Open the options page, find the **Site Access** card, and click **Grant Site Access**. Chrome asks once. Until you do, page reads, interaction, and screenshots all fail with Chrome's own permission error, because Chrome requires a literal broad host permission for programmatic visible-tab capture and `activeTab` is not enough without a user gesture.

## 6. Verify

The options page status dot turns green within about fifteen seconds of the client starting the server, and the Session Status card lists the live session.

If it does not, run the diagnostic:

```bash
node mcp-server/doctor.mjs
```

`npm run doctor` from the repository root does the same thing, and `node mcp-server/cli.js doctor` runs it from anywhere in the checkout.

Then ask your agent for a first call. `browser_create_tab` followed by `browser_navigate` and `browser_get_page_content` proves the whole path: the client reached the server, the server reached the extension, and the extension owns a tab.

## Environment variables

Every one of these has a portable default derived from your home directory, so a stock install needs none of them. The table covers the variables a normal install touches; the server reads a handful more for timeouts and diagnostics, all of them optional and all named in `mcp-server/config.js` and `mcp-server/index.js`.

| Variable | Default | What it does |
| --- | --- | --- |
| `UMBRA_SHARED_KEY` | unset | The pairing key itself. Wins over the file when both are set. |
| `UMBRA_SHARED_KEY_FILE` | `$HOME/.umbra/shared-key` | File holding the pairing key. |
| `UMBRA_DOWNLOAD_DIR` | `$HOME/Downloads` | Directory the download-waiting tools watch. |
| `UMBRA_BROKER_SOCKET` | `$HOME/.umbra/run/broker.sock` | Unix socket the broker listens on. |
| `UMBRA_BROKER_LAUNCHD_LABEL` | `dev.umbra.broker` | launchd job the launcher kicks on macOS. |
| `UMBRA_BROKER_MODE` | `rust` in the launcher, `legacy` otherwise | `rust` uses the broker, `legacy` gives each session its own loopback listener. |
| `UMBRA_PORT_START` | `47821` | First port in the loopback scan range. |
| `UMBRA_PORT_END` | `47852` | Last port in the loopback scan range. |
| `UMBRA_REQUEST_TIMEOUT_MS` | `60000` | Floor for how long one command may take. |
| `UMBRA_KEEP_TABS_OPEN` | unset | Set to `1` to leave owned tabs open when the server shuts down. |
| `UMBRA_CLOSE_ON_SHUTDOWN` | `1` | Set to `0` for the same effect as `UMBRA_KEEP_TABS_OPEN=1`. |
| `UMBRA_BROKER_BIN` | `$HOME/.umbra/bin/Umbra Helper` | Broker binary the launchd job runs. |
| `UMBRA_BROKER_REQUIRED` | unset | Set to `1` to fail instead of falling back to the legacy bridge. |

Set `UMBRA_DOWNLOAD_DIR` if you ever moved Chrome's download folder. The extension holds no `downloads` permission, so it cannot read your real setting, and every download-waiting tool watches this directory instead. A wrong value makes `browser_wait_for_download`, and any plugin tool that waits on a download, time out with nothing to show for it.

Changing the port range needs both sides to reload: restart the MCP client so new server processes inherit the environment, and reload the extension so its stored range is normalized.

## Optional: the Rust broker

The pure-Node bridge is the default and needs nothing extra. The broker is worth installing when several agent sessions share one browser: it holds a single extension WebSocket and multiplexes every session behind it over a Unix socket, which cuts authentication time and connection churn.

Build and stage it:

```bash
cargo build --release --manifest-path rust-broker/Cargo.toml
mkdir -p ~/.umbra/bin
cp "rust-broker/target/release/umbra-rust-broker" "$HOME/.umbra/bin/Umbra Helper"
```

On macOS, keep it running under launchd:

```bash
node mcp-server/cli.js broker install
```

Add `--dry-run` to print the rendered job and the exact `launchctl` commands without touching launchd. The job writes to `~/.umbra/logs/`, and the socket lands at `~/.umbra/run/broker.sock` with mode `srw-------`.

Roll back to the pure-Node bridge at any time with `UMBRA_BROKER_MODE=legacy`. Details are in `rust-broker/README.md` and `rust-broker/LEGACY_FALLBACK.md`.

## Troubleshooting

**The status dot never turns green.** The extension and the server hold different keys, or the port range does not overlap. Regenerate the key on the options page, click Copy Environment Line, and paste it into the client config again.

**"No shared key configured".** The server found neither `UMBRA_SHARED_KEY` nor a readable key file. Run `umbra pair`, or set the variable in the client config.

**Every page tool fails with a Chrome permission error.** Site access was never granted. Click Grant Site Access on the options page.

**Downloads time out.** `UMBRA_DOWNLOAD_DIR` does not point at the folder Chrome actually saves into. Check Chrome's download setting and set the variable.

**A tool reports the tab is not owned.** Sessions can only touch tabs they created or adopted. Use `browser_find_tabs` and `browser_adopt_tab` to take ownership of a tab you opened by hand.

**Nothing works after a Chrome restart.** Tab ownership lives in `chrome.storage.session`, which Chrome clears when the browser closes, so previously owned tabs are unowned by design after a restart. Find them again with `browser_find_tabs` and hand each one back with `browser_adopt_tab`, or let the session open fresh tabs. Separately, an unpacked extension whose files changed on disk needs a reload at `chrome://extensions` or from the Reload Extension button on the options page.

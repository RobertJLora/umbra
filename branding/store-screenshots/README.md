# Umbra Chrome Web Store Screenshots

Five store screenshots for the Umbra listing, rendered from the source HTML in this folder via headless Chrome at 2x device scale.

The Chrome Web Store accepts 1280x800 PNG screenshots, up to 5 per listing. The first screenshot is the hero. The 2x renders below are 2560x1600 and downscale cleanly to the 1280x800 the store expects; if the store rejects a non-1280x800 file, re-render the same HTML at `--force-device-scale-factor=1`.

## Files

| File | Pixel dimensions | Scene | Headline |
|------|------------------|-------|----------|
| `1-hero.png` | 2560x1600 | Hero | Drive your signed-in Chrome from the terminal. |
| `2-no-focus-theft.png` | 2560x1600 | No focus theft | It runs in the background. Your focus stays where it is. |
| `3-tab-ownership.png` | 2560x1600 | Tab ownership | Every session owns only the tabs it opened. |
| `4-options-local.png` | 2560x1600 | Options / local | One paired key. Localhost only. Nothing leaves your machine. |
| `5-terminal-mcp.png` | 2560x1600 | Terminal MCP | MCP-native. Your agent, your browser, your rules. |

`contact-sheet.png` (1368x1515) stacks all five at reduced size, labeled by scene, on a `#16121f` background, for a quick review pass.

## Re-rendering

Each PNG comes from the matching `.html` file with:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 \
  --screenshot="<key>.png" --window-size=1280,800 \
  "file://<abs-path-to>/<key>.html"
```

Drop `--force-device-scale-factor=2` (or set it to 1) for a native 1280x800 copy.

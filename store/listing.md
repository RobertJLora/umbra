# Chrome Web Store Listing: Umbra

Every field the Chrome Web Store developer dashboard asks for, ready to paste. The full description also lives on its own at `store/description.txt` as plain text, because the store renders the description literally and strips nothing: markdown symbols would appear as characters on the page.

One thing is still open before submitting: both GitHub URLs in `store/description.txt` and in the manifest `homepage_url` have to resolve publicly. `store/SUBMISSION_CHECKLIST.md` section 1b carries that gate along with the npm one.

---

## Store title

**`Umbra - Browser Control for AI Agents`** (37 characters, limit 75)

The store derives the listing title from `extension/manifest.json` `name`, which already reads exactly this. Nothing to fill in here; confirm the manifest still matches before uploading, because the store shows whatever the manifest says.

The reason for the descriptor form: a brand-new item named with a single abstract noun has no search surface at all. Store search weights the name field, and "browser control" plus "AI agents" are the two phrases someone hunting for this actually types. The descriptor is a plain statement of what the item does, not a keyword string, so it stays inside the Chrome Web Store naming policy that bans keyword stuffing.

---

## Short description (summary)

Exactly 128 characters, against the store's 132 limit.

```
Let a local AI agent drive tabs it owns in your signed-in Chrome. Nothing leaves the machine. Requires a local companion server.
```

Three things are doing work in that sentence and none of them is decoration. "Tabs it owns" is the product's actual boundary. "Nothing leaves the machine" is the objection a reader has at the word "agent". "Requires a local companion server" is the external dependency, which Google expects disclosed and which stops a one-star review from someone who installed the extension alone and found a settings form.

Alternates, if the summary needs a different emphasis:

* Focus and noise angle, 127 characters: `Local AI agents drive tabs they own in your signed-in Chrome. No focus theft, loopback only. Requires a local companion server.`
* Plainest form, 119 characters: `Give a local AI agent scripted control of the tabs it owns in your signed-in Chrome. Requires a local companion server.`

---

## Category

**Developer Tools.**

The item's audience is people who run an MCP client and a local Node process, its value is a scriptable tool surface, and its listing talks about permissions, transports, and a shared key. Reviewers and browsers of that category expect exactly that shape.

Second choice if Developer Tools is ever contested: Workflow & Planning. Do not file it under Productivity-adjacent lifestyle categories; the install base there will not have a companion server and the review scores will show it.

---

## Full description

The paste-ready text is `store/description.txt`, comfortably under the store's 16,000 limit, plain ASCII with no markdown and no smart punctuation. Recount before uploading rather than trusting a number written here:

```bash
wc -m < store/description.txt
```

Its structure, and why each block is there:

* **Opening line.** States the capability and the limit in one sentence, because the summary is truncated on some surfaces and this is the first line everyone sees.
* **Requires a local companion server.** The external dependency disclosure, placed second so nobody reads three paragraphs before learning the extension does nothing alone. It carries the `npx -y @umbra-mcp/server pair` command and the install-doc link, which is also what the reviewer notes point at.
* **How the boundary works.** The ownership model, contrasted against remote debugging. This is the one idea that separates Umbra from every other agent-browser bridge, so it gets prose rather than a bullet.
* **What you get.** Six concrete capabilities, each verifiable against the shipped tool list.
* **How it talks to the companion server.** Loopback address, port range, HMAC challenge on both sides, no fetch, no remote host in the content security policy. Written so a security-minded reader can check each claim against the source.
* **What it will not do.** Nine absences. This block answers the trust question faster than any assurance sentence could.
* **Permissions.** Optional site access and the debugger permission, stated before install rather than discovered after. The debugger paragraph names all three uses and the automation banner, because a reader who finds that out from Chrome instead of from us has been misled.
* **Closing line.** Minimum Chrome version and the source link.

### Claims audit

Every factual claim in the description, checked against the code rather than against the README:

| Claim | Source |
|---|---|
| 46 browser tools | `buildToolDefinitions` with no optional local plugin installed returns 46 entries |
| Per-session tab group and ownership map | `extension/session-state.js`, ownership resolved before every Chrome call |
| Tab adoption | `browser_find_tabs`, `browser_adopt_tab`, `browser_find_groups`, `browser_adopt_group` |
| Background tabs by default | create, navigate, click, fill, press, scroll all default to inactive tabs |
| Ownership-based window cleanup | `browser_close_session_tabs` closes a window only when every tab in it is owned |
| Loopback only | the bridge refuses any address other than 127.0.0.1 or ::1 |
| HMAC challenge both directions | shared-key challenge before any command is accepted |
| No fetch, no XHR, no remote host in the CSP | `content_security_policy.extension_pages` allows `'self'` plus `ws://127.0.0.1:*` and `ws://localhost:*` only |
| Optional site access | `optional_host_permissions` in the manifest, requested from the options page |
| Debugger used for three things | silent screenshot capture, file input population, caller-supplied JavaScript |
| No cookies, downloads, history, bookmarks, clipboard, native messaging | none of those permissions is declared |
| Chrome 121 or later | `minimum_chrome_version` in the manifest |

Two claims were deliberately left out because the code does not yet support them. There is no "open source" wording anywhere in the copy, because the tree ships no license file; add the claim in the same change that adds the license, not before. There is also no uptime, speed, or benchmark number, because nothing in the listing needs a figure the store cannot verify.

---

## Single purpose statement

For the dashboard's Privacy tab. One purpose, stated so a reviewer can map it onto the permission list.

```
Umbra's single purpose is browser automation on behalf of a companion program running on the same machine. The extension exposes a fixed set of browser actions (navigate, read page content, list visible controls, click, type, fill forms, upload a file, scroll, capture a screenshot, read the console) to a local companion server over an HMAC-authenticated WebSocket bound to 127.0.0.1, and it restricts every one of those actions to tabs the requesting session created or that the user explicitly handed to it. It serves no other function: it makes no request to any remote host, collects and transmits no user data, injects nothing into pages outside an explicit action on an owned tab, and does nothing at all until the user generates a shared key and pairs it with the companion server.
```

---

## Keywords

The Chrome Web Store has no keyword field. These are the terms the listing should carry naturally in the title, summary, and description, and every one of them already appears in the copy above at least once.

```
browser automation, AI agent, MCP, Model Context Protocol, agent browser control, signed-in browser, tab ownership, session isolation, background tabs, headful automation, localhost, loopback, local server, developer tools
```

Do not append this line to the description. A visible keyword block reads as spam to both reviewers and readers, and the store ranks on the copy itself.

---

## Compliance notes

**Third-party trademarks.** The copy names two things it cannot avoid naming: Chrome, because the item is a Chrome extension, and the Model Context Protocol, because that is the interface the companion server speaks and a reader needs it to judge compatibility. Both are used nominatively to describe what the item works with. No other product, vendor, or service is named anywhere in the title, summary, or description. The SEO tool that the private build automates is absent from every field, and the store package excludes the recipe file that drives it.

**External dependency disclosure.** Google's documented path for an extension that needs a separate local program is a plain statement in the description plus test instructions in the reviewer field. The description block titled "Requires a local companion server" is that statement, and it appears above the fold rather than in a footnote. The reviewer notes carry the matching install command and screencast.

**Links to verify before submitting.** Both URLs in the description point at `robertjohnlora.com/umbra`, matching the manifest's `homepage_url`. The repository and the `docs/install.md` path on its default branch must both load publicly before the listing goes in, because a broken link in a description is a rejection reason on its own.

**Consistency check at submission time.** The tool count in the description says 47. If a tool is added or removed from the public build, that number and the "What you get" bullet change with it.

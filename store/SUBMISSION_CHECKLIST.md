# Chrome Web Store Submission Checklist

Everything between a verified package and a published listing, in the order it has to happen. The version comes from `extension/manifest.json` and the package is written to `dist/umbra-<version>.zip`; no step below pins a version number, because a pinned one goes stale on the next bump and a stale zip is the most avoidable rejection there is.

Two of these steps cost money or need a human at a keyboard with the account password. They are marked and grouped first so they are not discovered at the end.

---

## 1. Actions only the account owner can take

None of these can be automated, delegated, or done by an agent. They need the owner signed into the Google account that will publish the item.

**OWNER: register the Chrome Web Store developer account.** Go to the developer dashboard at `chrome.google.com/webstore/devconsole`, accept the developer agreement, and pay the **one-time 5 US dollar registration fee**. It is nonrefundable and it is charged once per account, not per item. Nothing can be uploaded until it clears. Budget a few minutes; a card decline here blocks the whole submission.

**OWNER: turn on 2-Step Verification for the publishing Google account.** The Chrome Web Store refuses to publish from an account without it. Do this before the fee, because the account state is checked at publish time and a locked account at that moment is a wasted day.

**OWNER: verify the publisher contact email.** The dashboard has a Contact information section; the verification mail lands in that inbox and the link expires. An unverified contact email blocks publishing even after the fee is paid.

**OWNER: declare trader status.** The dashboard requires each developer to state whether they publish as a trader or a non-trader for distribution in the European Union. Non-trader is the honest answer for an unpaid personal project; picking wrong is a compliance problem, not a formatting one, so read the definition on the form rather than guessing.

**OWNER: host the privacy policy at a public URL.** `store/privacy-policy.md` has to be reachable without a login before the listing can reference it. The URL goes in two places: the Privacy practices tab of the dashboard, and the listing itself. Any stable public host works. The lowest-effort option that stays in one place is GitHub Pages on the repository already named in `homepage_url` (`https://github.com/getumbra/umbra`). Record the final URL here once it exists:

```
Privacy policy URL: ______________________________________
```

**OWNER: confirm the item name is free.** Search the store for "Umbra" before uploading. A name collision is a rename, and a rename after the listing copy is written is rework in four files.

---

## 1b. Blockers that are still open

Two links and one command in the listing copy do not resolve yet. Each of them is a rejection on its own, so none of section 2 is worth running until all three are true:

- `https://github.com/getumbra/umbra` returns 200. It is `homepage_url` in the manifest and it is linked twice from `store/description.txt`.
- `https://github.com/getumbra/umbra/blob/main/docs/install.md` returns 200 on the default branch.
- `npm view @umbra-mcp/server version` returns a version. `store/description.txt` gives `npx -y @umbra-mcp/server pair` as the one-line install, and a 404 there leaves a reviewer with no working path at all.

Check all three in one go:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/getumbra/umbra
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/getumbra/umbra/blob/main/docs/install.md
npm view @umbra-mcp/server version
```

---

## 2. Pre-submit gate

Run all four and read the output. A submission built from a stale zip is the most avoidable rejection there is.

```bash
# from the repository root
bash scripts/package-extension.sh
node scripts/verify-package.mjs "dist/umbra-$(node -p "require('./extension/manifest.json').version").zip"
npm test
~/.cargo/bin/cargo test --manifest-path rust-broker/Cargo.toml
```

`package-extension.sh` runs the gate itself and writes `dist/umbra-<version>.zip` only when it passes, so a rejected build leaves nothing at the upload path. The explicit `verify-package.mjs` line above re-checks the file that is actually going to be uploaded.

`verify-package.mjs` is the gate that matters for the store. It asserts, and must report ok on every line: archive size under budget, every entry on the allowlist, no local-only directory shipped, no author identity in any shipped byte, no third-party product name in any shipped byte, no source file compiling a string into code, no icon carrying provenance metadata, and a store-ready manifest.

Bump `version` in `extension/manifest.json` before every resubmission, including a resubmission after a rejection. The store refuses an upload whose version is not higher than the last one it saw, and that refusal arrives after the upload, not before it.

---

## 3. Store listing tab

| Field | Value | Source |
|---|---|---|
| Item name | `store/listing.md`, Store title | Written |
| Summary | Under 132 characters, no third-party product name | `store/listing.md`, Short description |
| Description | Paste `store/description.txt` unchanged. It states plainly that Umbra requires a local companion server and does nothing without it, above the fold rather than in a footnote | Written |
| Category | `store/listing.md`, Category | Written |
| Language | English | Written |
| Store icon | 128 by 128 PNG | Assets below |
| Screenshots | At least one, five maximum | Assets below |
| Small promo tile | 440 by 280 | Assets below |
| Marquee promo tile | 1400 by 560, optional | Assets below |
| Homepage URL | `https://github.com/getumbra/umbra`, matching `extension/manifest.json:6` | Already set |
| Support URL | The repository issue tracker | `store/listing.md` |

Two consistency checks before pasting anything. The description names a tool count; if the public build gained or lost a tool since the copy was written, that number is wrong and a reviewer can count. Both URLs in the description point at the repository named in `homepage_url`, and a description link that does not load is a rejection reason by itself, so open both.

The external-dependency disclosure in the description is a requirement, not a nice-to-have. Google's documented path for an item that needs software outside the extension is disclosure in the description plus test instructions in the reviewer field. Leaving it out and letting a reviewer discover the dependency by installing the item is the fastest route to a rejection.

---

## 4. Privacy practices tab: the data-use certifications

This is the tab that gets the submission held or rejected. Fill every field, then tick every box.

**Single purpose.** Paste the block from `store/listing.md` under the heading "Single purpose statement". One field, one paragraph. Use that wording rather than composing a fresh version for this box: two wordings of one field inside a single submission is drift a reviewer notices.

**Permission justifications.** One box per permission the manifest declares. There are nine boxes to fill: `storage`, `tabs`, `activeTab`, `tabGroups`, `scripting`, `offscreen`, `alarms`, `debugger`, and the optional host permission `<all_urls>`. Every one has paste-ready text in `store/permission-justifications.md`, already length-checked against the per-field limit. An empty box is an automatic hold.

**Remote code.** Select **No, I am not using remote code**, and paste the accompanying explanation from the same file. Repeat that explanation verbatim in the reviewer notes, because a reviewer who greps for `Runtime.evaluate` needs to find the answer in the place they are already looking.

**Data collection disclosure.** Nine categories, each a yes or no. Recommended answers, with the reason for each:

| Category | Answer | Why |
|---|---|---|
| Personally identifiable information | No | Nothing identifying is read or stored. The only stored id is a random local hex string. |
| Health information | No | No such path exists. |
| Financial and payment information | No | No such path exists. |
| Authentication information | No | No `cookies` permission and no credential storage. A JavaScript result that looks like a cookie jar, a set-cookie header, a JWT, a prefixed bearer token, or a long query-string secret is blocked before it returns (`looksLikeSensitiveResult` in `extension/javascript-safety.js`). |
| Personal communications | No | Nothing reads mail, messages, or contacts as a category. |
| Location | No | No geolocation API is called. |
| Web history | No | No `history` permission. Tab URLs are read only for tabs the calling session opened. |
| User activity | No | Nothing records clicks, keystrokes, or mouse movement. Input is dispatched, never observed. |
| Website content | **Yes**, with explanation | This is the judgment call. Umbra reads text, screenshots, and DOM from tabs a session owns and hands them to a local companion. Google defines collection as transmission off the user's device, and a loopback socket is not off-device, so a No is defensible. Tick Yes anyway and explain the local-only destination. Disclosing more than strictly required costs an explanation; disclosing less than a reviewer thinks is required is a policy violation with an enforcement path behind it. |

The Website content explanation, paste-ready:

> Umbra reads page content only from tabs the calling session opened itself, and returns it over a loopback WebSocket to a companion server running on the same machine that the user started. It is never transmitted to the developer or to any host on the internet. The extension's content security policy restricts connections to 127.0.0.1 and localhost, and the extension contains no fetch, XMLHttpRequest, or sendBeacon call anywhere.

**The three certification checkboxes.** All three are truthfully checkable and all three are required:

1. I do not sell or transfer user data to third parties, outside of the approved use cases. **True.** There is no transfer to anyone.
2. I do not use or transfer user data for purposes unrelated to my item's single purpose. **True.** Content is returned to the caller that asked for it and nowhere else.
3. I do not use or transfer user data to determine creditworthiness or for lending purposes. **True.** Not applicable to any code path.

**Privacy policy URL.** The URL recorded in section 1. A listing that discloses any data handling and gives no privacy policy URL is rejected on that alone.

---

## 5. Required assets, with exact sizes

| Asset | Exact size | Format | Source in this repository | Status |
|---|---|---|---|---|
| Store icon | 128 by 128 | PNG | `branding/icons/icon128.png` | Present, verified 128 by 128, no alpha |
| Small promo tile | 440 by 280 | PNG or JPEG, no alpha | `branding/store-promo-440x280.png` | Present, verified 440 by 280, no alpha, **needs a bit-depth fix** |
| Marquee promo tile (optional, needed for any featured placement) | 1400 by 560 | PNG or JPEG, no alpha | `branding/store-marquee-1400x560.png` | Present, verified 1400 by 560, no alpha, **needs a bit-depth fix** |
| Screenshot 1 | 1280 by 800 or 640 by 400 | PNG or JPEG, no alpha | Not yet captured | **To do** |
| Screenshot 2 | 1280 by 800 or 640 by 400 | PNG or JPEG, no alpha | Not yet captured | **To do** |
| Screencast | Any length, hosted at a public URL | Video | Not yet recorded | **To do**, referenced from the reviewer notes |

**The bit-depth fix.** Both promo tiles are 16 bits per channel. The store expects ordinary 8-bit-per-channel images and a 16-bit PNG is a needless upload risk for zero visual gain. Convert in place:

```bash
python3 - <<'PY'
from PIL import Image
for path in ("branding/store-promo-440x280.png", "branding/store-marquee-1400x560.png"):
    Image.open(path).convert("RGB").save(path, optimize=True)
PY
sips -g pixelWidth -g pixelHeight -g bitsPerSample -g hasAlpha branding/store-promo-440x280.png
```

**Screenshot 1 content.** The options page after a successful pairing: a connected status dot, a session listed, and the Site Access card showing granted. That single image answers the reviewer's first question, which is whether the thing works at all.

**Screenshot 2 content.** A Chrome window with an owned tab group visibly separate from the user's own tabs. This is the clearest one-image explanation of the ownership model and it is the reason the `tabGroups` justification reads as true rather than as a claim.

**Provenance metadata.** Every image goes through a metadata strip before upload. The source artwork was generated, and generated images carry C2PA blocks naming the generator and its vendor. `scripts/verify-package.mjs` already asserts this for the icons inside the zip; the promo tiles and screenshots are uploaded separately and are not covered by that gate, so check them by hand:

```bash
for f in branding/store-promo-440x280.png branding/store-marquee-1400x560.png; do
  echo "== $f"; strings "$f" | grep -ci "c2pa\|jumb" || echo "clean"
done
```

---

## 6. Reviewer notes field

The dashboard field is free text and it is not optional in practice. It must carry three things: the public screencast URL, the exact `npx` command that starts the companion server, and the public URL of the install documentation. Say "a local Node companion server". Do not mention the Rust broker: it is optional, the server defaults to the pure-Node bridge when `UMBRA_BROKER_MODE` is unset, and describing a two-binary setup to a reviewer who then cannot reproduce it is self-inflicted.

---

## 7. Expected review friction

Plan for a slow review with at least one round trip. An extension that declares `debugger` and requests broad host access does not go through the fast automated path, whatever else is true about it.

**The `debugger` permission is the single largest factor.** It cannot be declared optional, it needs no host permission to work, and through `Runtime.evaluate`, `DOM.setFileInputFiles`, and `Page.captureScreenshot` it carries the most sensitive capabilities in the package. Moving `<all_urls>` to `optional_host_permissions` removed the install-time "read and change all your data on all websites" warning, which is a real win for users, but it does not move the item out of the manual review bucket. Expect a human to read the code.

**The likeliest rejection is not a permission. It is testability.** A reviewer installs the zip, opens it, and sees a settings form asking for a key they do not have, with no way to exercise a single feature. Without the screencast, a companion-server command that actually runs, and the disclosure in the description, that reviewer has no path to a working state and the honest outcome from their side is a rejection. Closing that gap is what the reviewer notes field and the external-dependency line in the description are for, and neither is optional here.

**The second likeliest is the remote-code question.** `Runtime.evaluate` running a caller-supplied string looks like remote code to a scanner and to a reviewer skimming. The package has no `eval`, no `new Function`, no `AsyncFunction`, and `script-src 'self'`, and the string comes from a local process the user started. That answer belongs in the dashboard field and in the reviewer notes, in the same words, before anyone asks.

**A third, cheaper one: an obfuscated-code false positive.** `background.js` is a few hundred kilobytes and several thousand lines, which is large enough to trip a size heuristic. It is plain readable source, not minified and not packed, and it ships with its comments intact. If that flag comes back, the reply is one sentence plus a line count.

**Precedents worth knowing about.** The plan itself names none, so treat these as a starting point rather than a citation, and open each live listing to confirm its current permission set before repeating any of it to anyone:

- **Automa**, browser automation with broad host access and a large install base, listed for years
- **Vimium**, `<all_urls>` on a very large install base, the standard example that broad host access alone is publishable
- **Selenium IDE**, record and playback across arbitrary sites, published by a recognised project
- **Requestly**, which uses the debugger API for network modification and is listed publicly
- **Nanobrowser**, an MV3 AI browser agent using `chrome.debugger`, the closest match to Umbra's shape and the most recent

The pattern across all of them is the same one this checklist is built around: a clearly stated single purpose, permissions justified against named code paths, and a reviewer who can reach a working state without guessing.

**If it comes back rejected.** Read the stated policy section, fix that one thing, bump the version in `extension/manifest.json`, rebuild, rerun `verify-package.mjs`, and resubmit. Do not rewrite the listing wholesale in response to a single cited clause; a second submission that changed six things is a second review that has to check six things.

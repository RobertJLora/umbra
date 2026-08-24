# Umbra release process (Robert 24 Aug 2026)

## Same-cycle Chrome Web Store

Whenever `main` ships a version bump (especially important fixes such as FOREGROUND / focus):

1. **Ash** owns the product: bump `extension/manifest.json`, land on GitHub `RobertJLora/umbra` main, build the zip, update store listing/description as needed.
2. **Same cycle** (same day / same release): hand Rex the zip + paste packet. Do not defer CWS to a later cycle.
3. **Rex** owns CWS Developer Dashboard GUI only (signed-in Chrome as rjlora@gmail.com). FOREGROUND HARD BLOCK still applies: prefer background; only front the dashboard if Robert allows that step or it is impossible otherwise.
4. Unpacked reload/proof on Robert’s Mac is useful and should run in parallel, but it must not become a reason to skip or delay same-cycle CWS for a version already on main.

## Roles

| Role | Owns |
|------|------|
| Ash (code) | GitHub main, version bump, zip, listing text |
| Rex (Mac) | CWS upload/submit GUI |
| Kit (staff) | Roster/process bake only |

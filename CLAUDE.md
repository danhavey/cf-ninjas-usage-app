# CF Ninjas AI Usage Widget - build & distribution notes

An Electron desktop widget, signed and notarized on macOS, distributed from
Cloudflare R2 behind a Worker at `usage.cfninjas.com`, with auto-update.

Use this repo as the starting point for the next desktop app. The setup below
took a lot of dead ends to get right; the "gotchas" section is the part worth
re-reading before repeating any of it.

---

## Shipping a release

```
git tag v1.2.0
git push origin v1.2.0
```

That's the whole process. GitHub Actions builds Mac (x64 + arm64) and Windows,
signs and notarizes the Mac builds, and uploads everything to R2. The version in
`package.json` is derived from the tag automatically - never hand-edit it.

## Layout

| Path | Purpose |
|---|---|
| `main.js` | Electron main process: window, tray, login, polling, updater |
| `preload.js` | contextBridge surface for the renderer |
| `widget.*` | Renderer (HTML/CSS/JS + jQuery) |
| `build/icon.png` | 1024x1024 app icon, transparent corners |
| `build/background.png` | DMG window artwork (+ `@2x`) |
| `build/entitlements.mac.plist` | Hardened-runtime entitlements |
| `.github/workflows/release.yml` | Build, sign, notarize, publish |

The download page Worker lives in a **separate** repo/folder
(`cf-ninjas-download-worker`), deployed with `npx wrangler deploy`.

## Required GitHub secrets

| Secret | Where it comes from |
|---|---|
| `CSC_LINK` | Developer ID Application cert as `.p12`, base64-encoded |
| `CSC_KEY_PASSWORD` | Password set when exporting that `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com > Sign-In and Security |
| `APPLE_TEAM_ID` | developer.apple.com > Membership |
| `CLOUDFLARE_API_TOKEN` | Scoped to **Workers R2 Storage: Edit** only |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard |

Getting the cert: Keychain Access > Certificate Assistant > Request a
Certificate from a Certificate Authority (saved to disk) > upload the CSR at
developer.apple.com > download the `.cer` > double-click to install > export
from **My Certificates** as `.p12` > `base64 -i cert.p12 | pbcopy`.

If the cert shows "not trusted", install Apple's intermediate:
`curl -o ~/Downloads/DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && open ~/Downloads/DeveloperIDG2CA.cer`

Verify signing works: `security find-identity -v -p codesigning`

---

## Gotchas (each of these cost real debugging time)

**No Dock icon.** `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
silently demotes the app to macOS "accessory" status, which removes the Dock
icon. A window can float above other apps' fullscreen spaces, or the app can
have a Dock icon - not both. Dropping `visibleOnFullScreen` fixes it. This is
NOT a signing, packaging, quarantine, or LaunchServices problem, though it
looks like all of them.

**`contextBridge.exposeInMainWorld("chrome", ...)` throws.** Electron's Chromium
already defines `window.chrome`, so the call fails and takes the renderer's
init with it, silently. Expose under a different key
(`__cfninjas_chrome`) and reassign `window.chrome` from a plain inline script in
the HTML, which isn't subject to that restriction.

**Authenticated API calls must run in page context.** `net.fetch` from the main
process with manually attached cookies gets rejected by claude.ai. Use
`authWindow.webContents.executeJavaScript(...)` so the fetch originates from the
real logged-in page.

**Never nest startup UI inside `did-finish-load`.** If the page fails to load,
the event never fires and the app launches completely invisible. Always have an
unconditional timeout fallback that shows *something*.

**Notarization config.** electron-builder 24 needs an explicit
`mac.notarize` key. Leaving it out crashes with
`Cannot destructure property 'appBundleId' of 'options'`. Setting **both**
`dmg.background` and `dmg.backgroundColor` is a hard error - pick one.

**DMG background.** Put it at `build/background.png` (+ `background@2x.png`)
and do NOT set `dmg.background` explicitly; auto-detection is the reliable path.
Finder draws icon labels in the *viewer's* system text color and there is no way
to override it, so design the artwork with a light band where the labels land.
A DMG cannot request Dark Mode.

**Icon.** Corners must be genuinely transparent - a rounded icon drawn on white
renders as a white square in the Dock. Inset the artwork to 824x824 inside a
1024x1024 canvas to match Apple's grid. Menu-bar icons stay full-bleed.

**Auto-update.** Squirrel.Mac updates from a `.zip`, never a `.dmg`, so the mac
target must build both. `package.json`'s version must actually increment or the
updater always concludes it is current - derive it from the git tag. Upload the
zips *before* `latest-mac.yml`, and serve the manifest with `cache-control:
no-cache`. Auto-update requires a signed build; it cannot work unsigned.

**Windows** has no auto-update here (needs NSIS, and an unsigned NSIS installer
trips SmartScreen harder than a zip). Windows code signing is a separate paid
certificate.

**Cross-building.** Both Mac and Windows targets can be built from Linux, but
Windows resource embedding needs `wine` plus `wine32:i386` (enable i386
multiarch first). Signing and notarizing still require macOS, hence the
`macos-latest` runner.

**R2 vs Workers Static Assets.** Static Assets caps at 25 MiB per file on every
plan. These builds are ~100 MB, so R2 is mandatory.

**Custom domain on a Worker** needs zone-level **Workers Routes: Edit** on the
API token, on top of the account-level Workers permissions.

**Cloudflare bot protection blocks auto-update.** Bot Fight Mode challenges any
non-browser client, and an updater can never solve a challenge - it gets an HTML
interstitial instead of `latest-mac.yml` and fails with a 403. On the Free plan
this cannot be skipped per-path. The fix here: keep `workers_dev: true` so the
update feed is served from the `workers.dev` hostname, which sits outside the
zone, while humans keep downloading from the custom domain. Recognise it by a
403 whose headers include `cf-mitigated: challenge`.

**Prepaid credit balance is a separate endpoint.** `/usage` returns
`spend.balance: null`; the real balance is at
`/api/organizations/{id}/prepaid/credits` as `amount` in cents. Spend (used
against your own monthly cap) and balance (what you still hold) are different
numbers - show both.

**The `usage` response carries a `limits` array** with `is_active` marking which
limit is currently binding. Most decision-useful field in the payload, and
neither claude.ai nor ClaudeKarma surfaces it. Do NOT use its `severity` field
for colours if you already interpolate a gradient from the percentage - three
buckets is coarser than what you have.

**Ignore the codename buckets** in that response (`nimbus_quill`, `tangelo`,
`iguana_necktie`, `cinder_cove`, `amber_ladder`, `seven_day_opus`, ...). They are
null on consumer plans and can change without notice.

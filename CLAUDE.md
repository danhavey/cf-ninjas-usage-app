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

**Notarization config - and it changed between major versions.**
electron-builder **24** wants an object: `"notarize": { "teamId": "XXXX" }`.
Omitting it entirely crashes with
`Cannot destructure property 'appBundleId' of 'options'`.
electron-builder **26** wants a **boolean**: `"notarize": true`, taking the team
id from the `APPLE_TEAM_ID` env var instead. Passing the v24 object to v26 fails
schema validation with `configuration.mac.notarize should be a boolean` and the
build dies in about 3 seconds, before signing. Check this first after any
electron-builder major upgrade.

Also: setting **both** `dmg.background` and `dmg.backgroundColor` is a hard
error - pick one.

**DMG background image never applied here - use `backgroundColor`.** Four
attempts failed: an explicit `dmg.background` path, the conventional
`build/background.png`, letting auto-detection find it, and supplying a
`background.tiff` (which electron-builder checks first). Icon positions and
window size from the same `.DS_Store` always applied, so the mechanism works and
only the image does not. Whatever the cause, `dmg.backgroundColor` is reliable -
use it and skip the artwork. Note the two are mutually exclusive: removing
`backgroundColor` to try an image leaves you with a WHITE window, not a fallback.
Also: Finder draws icon labels in the *viewer's* system text colour and there is
no way to override it, and a DMG cannot request Dark Mode.

**Icon.** Corners must be genuinely transparent - a rounded icon drawn on white
renders as a white square in the Dock. Inset the artwork to 824x824 inside a
1024x1024 canvas to match Apple's grid. Menu-bar icons stay full-bleed.

**Auto-update.** Squirrel.Mac updates from a `.zip`, never a `.dmg`, so the mac
target must build both. `package.json`'s version must actually increment or the
updater always concludes it is current - derive it from the git tag. Upload the
zips *before* `latest-mac.yml`, and serve the manifest with `cache-control:
no-cache`. Auto-update requires a signed build; it cannot work unsigned.

**A tray icon can carry live text on macOS - `tray.setTitle()`.** For a status
widget this is the highest-value surface in the app: the numbers are readable
without opening anything, in every space and over fullscreen apps. Pass
`{ fontType: "monospacedDigit" }` or the menu bar shifts sideways every time a
digit changes width, which is very visible on a per-minute poll. `setTitle` is
macOS-only - on Windows the tooltip is the only place text can go, so set both.

Blank the title on a failed fetch rather than leaving the last good numbers:
in a menu bar there is no timestamp beside them, so a stale percentage and a
current one look identical. Offer an opt-out too; not everyone has room in
their menu bar.

**Update cadence: 15s after launch, on window show/focus, then every 6h.**
The background interval alone is too slow to notice a release you just pushed -
and worse, a check that fires during the ~10 minutes CI spends building and
uploading correctly finds nothing, then waits another six hours. The show/focus
hook covers the case that matters: opening the widget is when you care whether
it is current. Throttled to once per 10 minutes, because a single tray click
fires both `show` and `focus`.

**Never use `actions/upload-artifact` just to move files between jobs.** The
first version of this workflow built on macOS and Windows runners, uploaded
~300MB of output as artifacts, then downloaded it all again in a third job that
pushed it to R2. GitHub artifact storage is a *quota*, not scratch space, and
every release consumed it permanently - so after enough releases every build
died at the upload step with "Artifact storage quota has been hit. Unable to
upload any new artifacts." Nothing about the code had changed.

Artifacts are for things a human wants to download from the Actions UI. If a
job can write to the real destination, have it write to the real destination.
Each build job now uploads its own output to R2, which removes the quota
dependency entirely and skips a 300MB round trip. Side effect worth knowing:
the platforms are independent now, so a failing Windows build no longer blocks
a good macOS release.

If you hit the quota anyway, note the error says usage is recalculated every
6-12 hours - deleting old artifacts does not free it immediately. Removing the
uploads is the fix that works now.

**Windows** has no auto-update here (needs NSIS, and an unsigned NSIS installer
trips SmartScreen harder than a zip). Windows code signing is a separate paid
certificate.

Because of that, a Windows "Check for Updates" button would always fail: the
release workflow publishes `latest-mac.yml` and no `latest.yml`, so the check
404s and pops an error dialog. Worse than no button. `AUTO_UPDATE_SUPPORTED`
gates it - Windows gets "Get the Latest Version…" which opens the download
page, and the background checks are skipped entirely rather than erroring into
the console every six hours.

Do not confuse this with the **usage poll**, which is plain `setInterval` +
`fetch` and behaves identically on every platform. "No auto-update on Windows"
means app versions, not data.

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

**Polling never started for returning users - a guard that meant the wrong
thing.** `startPolling()` was called from exactly one place, inside
`checkLoggedInFromAuthWindow()`, behind
`if (mainWindow && !mainWindow.isDestroyed()) return; // already in`. That
guard was correct when it was written. It broke silently later, when returning
users started getting the widget shown at startup: `createMainWindow()` now ran
*before* the login check, so the guard tripped and the function returned before
ever reaching `startPolling()`. The app polled only on first-ever login; every
launch after that refreshed only when the user pressed the button.

Two lessons. First, **guard on the condition you actually mean** - "already in"
meant "polling is running" (`if (pollTimer) return`), not "a window exists";
the two were the same thing for one release and then were not. Second, an early
return that guards several unrelated actions at once is a trap: the guard was
about window creation, but it also gated polling, which nothing about the line
suggested.

Worth noting how long this hid. The symptom was a stale timestamp, which looks
exactly like a network or throttling problem, and a previous real throttling bug
in the same area (below) made that diagnosis feel confirmed. Check whether the
work is being *scheduled* before investigating why it might be failing.

**A hidden BrowserWindow gets its renderer throttled, and that silently
freezes polling.** Every usage fetch runs inside the hidden claude.ai auth
window via `executeJavaScript`. Chromium throttles and eventually suspends
timers and network in hidden/occluded renderers, so `fetch()` there simply
never settles. Combined with a `claudeApiFetch` that had no timeout, the result
was the worst possible failure mode: a stale reading, no error, no retry -
"Updated 15m ago" on a widget that polls every 60s. Fix is three parts, all
needed: `backgroundThrottling: false` on that window, `AbortSignal.timeout` in
the page-side fetch, and an outer `Promise.race` timeout for when the renderer
is wedged badly enough that the page-side abort timer never fires either. Plus
a `fetchInFlight` guard so a slow call can't stack up behind the next tick.

**Compact view is a body class, not a second page.** `body.compact` restyles
the one layout - title bar splits into two rows, rings stack, the credits bar
and the heatmap drop out. **Window width is the only thing that decides which
view shows** (`COMPACT_BREAKPOINT`, 300px); the toggle button does not set a
mode, it just resizes the window and the layout follows.

The first version also kept a sticky user preference that could override the
width. That was wrong, and the bug it caused is instructive: once you toggled
to compact, dragging the window wider left you stretched-compact with no way
back except the button, because the preference outranked the width. Two
sources of truth for one piece of state, and the less obvious one won. Deriving
the mode from width alone is simpler, matches what the drag gesture implies,
and still survives a restart because window bounds are persisted anyway.

**A `::after` set to `display: block` is as wide as its *parent*, not its
grandparent.** The compact "ACTIVE" badge hangs off `.ring-label::after`, and
`.ring-card` centres its children - but that centres the *label*, and the
pseudo-element's box then spans only the label's width, leaving the shorter
word left-aligned inside it. Looks like a stray misalignment, is actually
correct CSS. Needs its own `text-align: center`.

**`limits[].is_active` marks the binding limit - confirmed by observation.**
The flag was seen on the 5-hour ring at 100% utilisation, and later on the
7-day ring while the 5-hour sat at 25%. It moves, so it means "this is the
limit that will stop you first", not "a session window is open". The visible
`ACTIVE` badge was removed anyway - the signal is sound but the word did not
explain itself, and an unexplained badge is worse than none. The amber card
edge still marks it. Any future label needs to say what it means.

**Render changes before shipping them.** `playwright` + a stubbed
`window.__cfninjas_chrome` loads widget.html straight from disk with fake stats
and screenshots it at any width - no build, no notarization, no release cycle.
Two rounds of that caught a clipped credits block that would otherwise have
cost a full tag-build-install loop to find.

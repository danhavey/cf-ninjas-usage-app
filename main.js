// CF Ninjas AI - Claude Usage Widget (desktop)
// Main process: owns the always-on-top window, the login flow, and polling
// claude.ai's own usage endpoints - the same ones its Settings > Usage page
// calls - using a session you log into once, right here in this app.

const { app, BrowserWindow, Tray, Menu, session, ipcMain, nativeImage, nativeTheme, dialog, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const PARTITION = "persist:cfninjas-claude-usage";
// The widget loads only local files and makes no network requests, so it has
// no business sharing a cookie jar with the authenticated claude.ai session.
// Separate partitions cost nothing and remove a whole class of "the privileged
// window and the remote origin can see each other's storage" problems.
const WIDGET_PARTITION = "persist:cfninjas-widget";
const POLL_MS = 60 * 1000;
// Backing off on repeated failures matters more here than in a web app: this
// process runs all day on every install, so a claude.ai outage would otherwise
// mean every copy retrying once a minute forever. Jitter stops a fleet of
// installs settling into a synchronised burst.
const POLL_MAX_MS = 15 * 60 * 1000;
const STORE_PATH = path.join(app.getPath("userData"), "store.json");
const ACTIVITY_MAX_DAYS = 35;
const MIN_WINDOW_WIDTH = 210;
const DEFAULT_WINDOW_WIDTH = 340;

let mainWindow = null;
let authWindow = null; // stays alive (hidden once logged in) - it's our
                        // real claude.ai page context, used both to let the
                        // user log in and to make authenticated API calls.
let tray = null;
let pollTimer = null;
let pollingActive = false;
let pollFailures = 0;
let saveBoundsHandle = null;
let loginCheckRetryTimer = null;

// -----------------------------------------------------------------------
// Tiny local JSON store (stands in for chrome.storage.local)
// -----------------------------------------------------------------------

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveStore(store) {
  try {
    // Write-then-rename. A plain writeFileSync that is interrupted (crash,
    // force quit, full disk) leaves a truncated file, and loadStore swallows
    // the resulting SyntaxError and returns {} - silently wiping the heatmap
    // history, window bounds, theme and hasAuthedBefore all at once. rename is
    // atomic on the same filesystem, so a reader sees either the old file or
    // the new one, never a half-written one.
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("Failed to write store:", e);
  }
}

function setStoreValues(obj) {
  const store = loadStore();
  Object.assign(store, obj);
  saveStore(store);
  Object.keys(obj).forEach((key) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("storage-changed", key, obj[key]);
    }
  });
}

// -----------------------------------------------------------------------
// claude.ai usage fetching - run as real fetch() calls INSIDE the
// authenticated claude.ai page (authWindow), not from the main process.
// This matters: claude.ai's API can tell the difference between a request
// made by its own page's JS (real Origin/Referer/CORS context, ambient
// cookies) and a bare network request assembled by hand, and rejects the
// latter. Running the fetch through executeJavaScript makes it identical
// to what the real site itself does.
// -----------------------------------------------------------------------

function round(n) {
  return typeof n === "number" ? Math.round(n * 10) / 10 : null;
}

function centsToDollars(v) {
  return typeof v === "number" ? v / 100 : null;
}

// Two layers of timeout, because they fail differently. AbortSignal aborts a
// request the page is genuinely waiting on; the outer race covers the case
// where the renderer itself is wedged, so nothing page-side - the abort timer
// included - ever runs. Without the outer one a stuck fetch hangs forever and
// the widget shows a stale number with no error at all, which is worse than
// showing the error.
const API_TIMEOUT_MS = 20 * 1000;

async function claudeApiFetch(url) {
  if (!authWindow || authWindow.isDestroyed()) throw new Error("no_auth_window");
  // executeJavaScript runs in whatever document currently occupies this
  // webContents. Checking that it is still claude.ai - by ORIGIN, not by a
  // substring of the URL - is what stops the app injecting its script into,
  // and trusting JSON from, a page it was redirected to. It also turns a
  // failed page load (chrome-error://) into a visible error instead of a
  // permanently silent fetch failure.
  let origin = "";
  try {
    origin = new URL(authWindow.webContents.getURL()).origin;
  } catch (e) {
    throw new Error("no_page");
  }
  if (origin !== "https://claude.ai") throw new Error("off_origin");
  const script = `
    fetch(${JSON.stringify(url)}, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(${API_TIMEOUT_MS - 2000})
    })
      .then(function (r) {
        if (!r.ok) { throw new Error("http_" + r.status); }
        return r.json();
      })
  `;
  let timer;
  try {
    return await Promise.race([
      authWindow.webContents.executeJavaScript(script),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), API_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function findConsumerOrgUuid() {
  const orgs = await claudeApiFetch("https://claude.ai/api/organizations");
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("no_orgs");
  const chatOrg = orgs.find(
    (o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")
  );
  return (chatOrg || orgs[0]).uuid;
}

// Guards against a slow fetch overlapping the next poll tick and stacking up
// requests against a page that is already struggling.
// Holds the promise for the fetch currently running, so a manual Refresh can
// wait on it instead of being told "no" and leaving the button looking inert.
let inFlightFetch = null;
let fetchInFlight = false;
let lastFetchCompletedAt = 0;
let lastSuccessAt = 0;
// Bumped whenever the session changes (logout). A fetch that was already in
// flight when the user signed out would otherwise resolve afterwards and write
// live usage numbers - and repaint the menu bar - for the account they just
// left.
let sessionEpoch = 0;

function fetchUsage() {
  // A poll can take up to 20s. Pressing Refresh during one used to return null
  // immediately, so the spinner stopped and nothing changed - the app looked
  // broken while working correctly. Hand back the running promise instead.
  if (fetchInFlight && inFlightFetch) return inFlightFetch;
  inFlightFetch = runFetchUsage().finally(() => {
    inFlightFetch = null;
  });
  return inFlightFetch;
}

async function runFetchUsage() {
  if (fetchInFlight) return null;
  fetchInFlight = true;
  const epoch = sessionEpoch;
  try {
    const orgUuid = await findConsumerOrgUuid();
    const data = await claudeApiFetch(`https://claude.ai/api/organizations/${orgUuid}/usage`);

    const fiveHour = (data && data.five_hour) || {};
    const sevenDay = (data && data.seven_day) || {};
    const extra = (data && data.extra_usage) || {};

    // If the payload no longer carries the numbers, say so. Reporting ok:true
    // with null percentages renders a confident, perfectly-fresh-looking
    // widget full of "--" and no error - the exact silent failure this app has
    // been bitten by twice.
    if (typeof fiveHour.utilization !== "number" || typeof sevenDay.utilization !== "number") {
      throw new Error("unexpected_response_shape");
    }

    // `limits` grades each limit and flags which one is currently binding.
    // Knowing that weekly (not the 5-hour) is what will actually stop you is
    // the single most useful thing in this response.
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const activeKind = (limits.find((l) => l && l.is_active) || {}).kind || null;

    // Prepaid credit balance lives on a separate endpoint from usage. It is a
    // different concept from spend: `used_credits` is what you have spent
    // against your own monthly cap, while this is the money you still hold.
    // Treated as best-effort - a failure here must not take the widget down.
    let balanceDollars = null;
    try {
      const prepaid = await claudeApiFetch(
        `https://claude.ai/api/organizations/${orgUuid}/prepaid/credits`
      );
      if (prepaid && typeof prepaid.amount === "number") {
        balanceDollars = prepaid.amount / 100;
      }
    } catch (e) {
      // No prepaid credits on this account, or the endpoint moved. Either way
      // the balance is simply omitted rather than shown wrong.
    }

    const stats = {
      ok: true,
      fetchedAt: Date.now(),
      fiveHour: {
        percent: round(fiveHour.utilization),
        resetsAt: fiveHour.resets_at || null,
        isActive: activeKind === "session"
      },
      weekly: {
        percent: round(sevenDay.utilization),
        resetsAt: sevenDay.resets_at || null,
        isActive: activeKind === "weekly_all"
      },
      credits: extra.is_enabled
        ? {
            enabled: true,
            percent: round(extra.utilization),
            usedDollars: centsToDollars(extra.used_credits),
            limitDollars: extra.monthly_limit != null ? extra.monthly_limit / 100 : null,
            balanceDollars: balanceDollars,
            limitReached: extra.spend_limit_reached === true,
            currency: extra.currency || "USD"
          }
        : {
            enabled: false,
            // Distinguish "you switched this off" from "never set up", so the
            // widget can say something useful instead of just "off".
            userDisabled: extra.user_disabled === true,
            everEnabled: extra.credits_ever_enabled === true
          }
    };

    await recordActivitySample(stats.fiveHour.percent);
    // Remember that this machine has successfully authenticated at least once.
    // Startup uses this to go straight to the widget instead of flashing the
    // claude.ai login window at someone who is already signed in.
    if (epoch !== sessionEpoch) return null; // signed out while this was in flight
    lastSuccessAt = stats.fetchedAt;
    pollFailures = 0;
    setStoreValues({ claudeUsageStats: stats, hasAuthedBefore: true });
    updateTrayTitle(stats);
    return stats;
  } catch (err) {
    const stats = {
      ok: false,
      fetchedAt: Date.now(),
      // The renderer needs to distinguish "your session expired" from "the
      // network is down" from "you signed out" - they need different actions.
      error: String(err && err.message ? err.message : err),
      // So the widget can say how old the numbers on screen actually are,
      // rather than stamping a failure with "Updated just now".
      lastSuccessAt: lastSuccessAt || null
    };
    if (epoch !== sessionEpoch) return null;
    pollFailures = Math.min(pollFailures + 1, 4); // caps the delay at POLL_MAX_MS
    setStoreValues({ claudeUsageStats: stats });
    updateTrayTitle(stats);
    return stats;
  } finally {
    fetchInFlight = false;
    lastFetchCompletedAt = Date.now();
  }
}

// -----------------------------------------------------------------------
// Local activity tracking (same approach as the Chrome extension build)
// -----------------------------------------------------------------------

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// The heatmap stores the PEAK 5-hour utilisation observed in each local hour,
// not a count of pings. Storing the percentage is what lets the UI put a real
// number in the hover tooltip ("Wed Aug 26 16:00 - 68%") and bucket the cell
// into one of five 20% levels. An hour can be sampled many times as the poller
// runs; the highest reading wins, because that is the moment that hour actually
// mattered. Note the 5-hour window resets on its own, so a later sample in the
// same hour can legitimately be LOWER - taking the max is deliberate.
//
// Schema note: an earlier build wrote `claudeActivity` as small increment
// counts (1, 2, 3...). Those would render as an absurd 1-3% here, so this uses
// a new key and drops the old one rather than trying to reinterpret it.
async function recordActivitySample(newPercent) {
  if (typeof newPercent !== "number" || !isFinite(newPercent)) return;
  const store = loadStore();
  store.lastFiveHourPercent = newPercent;

  if (store.claudeActivity) delete store.claudeActivity;

  const now = new Date();
  const dateKey = localDateKey(now);
  const hour = now.getHours();

  const data = store.claudeHeatmap || {};
  data[dateKey] = data[dateKey] || {};
  const prev = data[dateKey][hour];
  const pct = Math.max(0, Math.min(100, Math.round(newPercent)));
  data[dateKey][hour] = typeof prev === "number" ? Math.max(prev, pct) : pct;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ACTIVITY_MAX_DAYS);
  const cutoffKey = localDateKey(cutoff);
  Object.keys(data).forEach((k) => {
    if (k < cutoffKey) delete data[k];
  });

  store.claudeHeatmap = data;
  saveStore(store);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("storage-changed", "claudeHeatmap", store.claudeHeatmap);
  }
}

// -----------------------------------------------------------------------
// Windows
// -----------------------------------------------------------------------

function getSavedBounds() {
  const store = loadStore();
  const b = store.windowBounds || { width: DEFAULT_WINDOW_WIDTH, height: 600 };
  // v1.4.0 briefly forced a 430px minimum so the heatmap's fixed 14px cells
  // would fit. The cells flex now, so undo that widening once - otherwise
  // anyone who ran 1.4.0 is stuck with a window they never asked for. The
  // flag makes this a one-time correction, not a permanent width cap.
  if (!store.widthRevert140) {
    // Mark the migration done whether or not it fired. Setting the flag only
    // when it fires leaves it armed forever on a fresh install, so someone who
    // later widens the window past 430px on purpose gets it yanked back to 340
    // on the next launch.
    if (b.width >= 430) b.width = DEFAULT_WINDOW_WIDTH;
    store.widthRevert140 = true;
    store.windowBounds = b;
    saveStore(store);
  }
  if (!b.width || b.width < MIN_WINDOW_WIDTH) b.width = DEFAULT_WINDOW_WIDTH;
  return b;
}

function saveBoundsDebounced() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(saveBoundsHandle);
  saveBoundsHandle = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    const store = loadStore();
    store.windowBounds = b;
    saveStore(store);
  }, 400);
}

// The widget window carries the preload bridge, so anything loaded into it can
// read and write the whole store, open external URLs and quit the app. It only
// ever needs widget.html from disk, so pin it there: no navigation, no popups.
//
// Deliberately NOT applied to the claude.ai window. That one has no preload,
// and blocking its navigation would break third-party SSO sign-in (Google,
// Apple), which redirects off claude.ai by design. The protection there is the
// origin check in claudeApiFetch, which is what actually matters: the app will
// not run its script in, or trust JSON from, a page that is not claude.ai.
function lockDownWidgetWindow(wc) {
  const denyNavigation = (e, url) => {
    if (!url.startsWith("file://")) e.preventDefault();
  };
  wc.on("will-navigate", denyNavigation);
  wc.on("will-redirect", denyNavigation);
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function iconPath() {
  return path.join(__dirname, "icons", "icon128.png");
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const bounds = getSavedBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: 420,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    show: false,
    backgroundColor: "#17150f",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      partition: WIDGET_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // Explicit rather than relying on the default, so a later edit cannot
      // silently regress it.
      sandbox: true
    }
  });

  lockDownWidgetWindow(mainWindow.webContents);

  // NOTE: `visibleOnFullScreen: true` is deliberately NOT set here. On macOS a
  // window can only float above *other* apps' fullscreen spaces if the app
  // demotes itself to accessory (LSUIElement-style) status, and accessory apps
  // get no Dock icon. Joining all workspaces is fine on its own; it is the
  // fullscreen option specifically that costs the Dock icon.
  mainWindow.setVisibleOnAllWorkspaces(true);
  // Re-assert the Dock icon after the window exists, in case any window-level
  // call above nudged the activation policy.
  if (process.platform === "darwin" && app.dock) app.dock.show();
  mainWindow.loadFile("widget.html");
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.on("show", () => { maybeCheckForUpdates(); refreshOnFocus(); });
  mainWindow.on("focus", () => { maybeCheckForUpdates(); refreshOnFocus(); });

  mainWindow.on("moved", saveBoundsDebounced);
  mainWindow.on("resized", saveBoundsDebounced);
  mainWindow.on("close", (e) => {
    // Hide instead of quitting - the tray icon is the way back in.
    if (!app.isQuittingForReal) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// The auth window is a real claude.ai page, kept alive (hidden once logged
// in) for the lifetime of the app so claudeApiFetch always has a live,
// authenticated page context to run fetch() calls inside of.
function getOrCreateAuthWindow(show) {
  if (authWindow && !authWindow.isDestroyed()) {
    if (show) {
      authWindow.show();
      authWindow.focus();
    }
    return authWindow;
  }

  authWindow = new BrowserWindow({
    width: 480,
    height: 720,
    title: "Log into claude.ai",
    icon: iconPath(),
    show: !!show,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      // CRITICAL: this window is hidden for the life of the app, and Chromium
      // throttles - eventually suspends - timers and network in hidden or
      // occluded renderers. Every usage fetch runs inside this page, so a
      // suspended renderer means fetch() never settles and the widget silently
      // freezes on a stale reading. Symptom: "Updated 15m ago" with no error.
      backgroundThrottling: false
    }
  });

  authWindow.setMenuBarVisibility(false);
  authWindow.loadURL("https://claude.ai/login");

  authWindow.webContents.on("did-navigate", scheduleLoginCheck);
  authWindow.webContents.on("did-navigate-in-page", scheduleLoginCheck);

  // Without this, launching while the network is still coming up leaves the
  // window parked on chrome-error:// forever. Every later fetch then runs from
  // an error-page origin and fails, and the watchdog cannot tell - it sees a
  // healthy cadence of failures. Same for a renderer crash.
  const reloadClaude = () => {
    if (!authWindow || authWindow.isDestroyed()) return;
    setTimeout(() => {
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.loadURL("https://claude.ai/login");
      }
    }, 5000);
  };
  authWindow.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) reloadClaude(); // -3 = user-aborted
  });
  authWindow.webContents.on("render-process-gone", reloadClaude);
  authWindow.on("closed", () => {
    authWindow = null;
    if (loginCheckRetryTimer) clearTimeout(loginCheckRetryTimer);
  });

  return authWindow;
}

function scheduleLoginCheck() {
  checkLoggedInFromAuthWindow();
  // The redirect away from /login can land before the session is fully
  // usable for API calls, so retry shortly after in case the first check
  // races that. This is cheap and self-cancels once we're in.
  if (loginCheckRetryTimer) clearTimeout(loginCheckRetryTimer);
  loginCheckRetryTimer = setTimeout(checkLoggedInFromAuthWindow, 1500);
}

async function checkLoggedInFromAuthWindow() {
  if (!authWindow || authWindow.isDestroyed()) return;
  // "Already in" means polling is running, NOT that a window exists. Those
  // came apart the moment returning users started getting their widget shown
  // at startup: createMainWindow() had already run, so a `mainWindow` guard
  // here returned before reaching startPolling() and the app never polled at
  // all for anyone who had logged in before. It only ever refreshed when the
  // user pressed the button. Guard on the thing you actually mean.
  // Polling running means we are already signed in and set up. One exception:
  // if the user opened the login window by hand it is still on screen, so hide
  // it before bailing out - otherwise a full claude.ai browser window stays
  // parked on their desktop with no way to dismiss it except closing it, which
  // breaks fetching entirely.
  if (pollingActive) {
    if (authWindow.isVisible() && !/\/login/.test(authWindow.webContents.getURL())) {
      authWindow.hide();
    }
    return;
  }
  const url = authWindow.webContents.getURL();
  if (/\/login/.test(url)) return; // still sitting on the login page itself

  try {
    const orgs = await claudeApiFetch("https://claude.ai/api/organizations");
    if (Array.isArray(orgs) && orgs.length > 0) {
      authWindow.hide();
      startPolling();
      // Unconditional: createMainWindow already shows and focuses an existing
      // window. Guarding on "no window exists" meant that after Log out (which
      // hides rather than destroys) a successful re-login left BOTH windows
      // hidden, with no sign anything had happened.
      createMainWindow();
    }
  } catch (e) {
    // Not logged in yet (or a transient hiccup) - the next navigation event
    // or the retry timer above will try again.
  }
}

// -----------------------------------------------------------------------
// Polling
// -----------------------------------------------------------------------

function nextPollDelay() {
  const base =
    pollFailures === 0
      ? POLL_MS
      : Math.min(POLL_MS * Math.pow(2, pollFailures), POLL_MAX_MS);
  return Math.round(base * (0.85 + Math.random() * 0.3)); // +/-15% jitter
}

function scheduleNextPoll() {
  if (!pollingActive) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(runPoll, nextPollDelay());
}

async function runPoll() {
  await fetchUsage(); // updates pollFailures itself, so a manual refresh counts too
  scheduleNextPoll();
}

function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollingActive = true;
  pollFailures = 0;
  // Stamp now so the watchdog does not fire against a first fetch still in
  // flight and restart a timer that is working fine.
  lastFetchCompletedAt = Date.now();
  runPoll();
}

// A silent freeze is the worst failure this widget has: it looks like it is
// working and quietly shows you an old number. If the interval ever stops
// producing - for any reason, including ones not yet understood - restart it
// rather than sitting there looking fine.
function startPollWatchdog() {
  setInterval(() => {
    if (!pollingActive) return; // not logged in yet; nothing to heal
    if (Date.now() - lastFetchCompletedAt > 3 * POLL_MS) {
      console.warn("[poll] no completed fetch in 3 cycles - restarting timer");
      startPolling();
    }
  }, POLL_MS);
}

function stopPolling() {
  sessionEpoch += 1;
  pollingActive = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

// -----------------------------------------------------------------------
// Tray
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Auto-update
//
// Updates are served from the same R2 bucket as the download page, under
// /updates. electron-builder writes latest-mac.yml there alongside a .zip of
// the app; Squirrel.Mac can only apply updates from a zip, which is why the
// build produces both a .dmg (what a human downloads) and a .zip (what the
// updater consumes).
//
// This only works on a signed build: macOS refuses to swap in an update whose
// signature does not match the running app. Unsigned dev runs are skipped.
// -----------------------------------------------------------------------

let autoUpdater = null;
let updateCheckInFlight = false;
let updateStuckTimer = null;
let lastUpdateCheckAt = 0;

// Opening the widget is the moment you are most likely to care whether it is
// current, so showing or focusing the window triggers a check. Throttled,
// because "show" and "focus" both fire for a single click on the tray icon,
// and because a window you are tabbing in and out of would otherwise hit the
// update feed continuously.
const FOCUS_CHECK_MIN_GAP_MS = 10 * 60 * 1000;

function maybeCheckForUpdates() {
  if (Date.now() - lastUpdateCheckAt < FOCUS_CHECK_MIN_GAP_MS) return;
  checkForUpdates(false);
}

// Looking at the widget is the moment the number matters most, so don't make
// the user wait out the rest of the poll interval for it.
function refreshOnFocus() {
  if (!pollingActive) return;
  if (Date.now() - lastFetchCompletedAt < 15 * 1000) return;
  fetchUsage();
}

function getAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    autoUpdater = require("electron-updater").autoUpdater;
  } catch (err) {
    return null;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", async (info) => {
    clearTimeout(updateStuckTimer);
    updateCheckInFlight = false;
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Version ${info && info.version ? info.version : ""} is ready to install.`.trim(),
      detail: "The widget will restart to finish updating. It only takes a moment."
    });
    if (response === 0) {
      app.isQuittingForReal = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    clearTimeout(updateStuckTimer);
    updateCheckInFlight = false;
    console.error("[updater]", err && err.message ? err.message : err);
  });

  return autoUpdater;
}

// `interactive` is true when the user picked "Check for Updates…" themselves,
// in which case silence would look broken - so we report "you're up to date"
// and surface errors. Background checks stay quiet.
// electron-updater cannot update the Windows build here: it needs NSIS (or
// Squirrel.Windows), and this ships a plain .zip. The update feed is also
// mac-only - the workflow publishes latest-mac.yml and no latest.yml - so a
// Windows check would 404 and pop an error. Rather than leave a button that
// always fails, Windows gets an honest one that opens the download page.
const AUTO_UPDATE_SUPPORTED = process.platform === "darwin";
const DOWNLOAD_PAGE = "https://usage.cfninjas.com";

// electron-updater reports whatever the feed says. Comparing with !== treats
// an OLDER remote version as "an update available", so a rolled-back feed - or
// a locally built higher version - would prompt the user to downgrade, and
// autoDownload would fetch it before anyone noticed.
function isNewerVersion(remote, current) {
  const parse = (v) => {
    const [core, pre] = String(v || "").trim().replace(/^v/, "").split("-");
    const nums = core.split(".").map((n) => parseInt(n, 10));
    return { nums, pre: pre || "", ok: nums.length >= 2 && nums.every((n) => !isNaN(n)) };
  };
  const r = parse(remote);
  const c = parse(current);
  // Unparseable on either side: fall back to "different means newer" rather
  // than silently refusing every future update.
  if (!r.ok || !c.ok) return String(remote) !== String(current);

  for (let i = 0; i < 3; i++) {
    const a = r.nums[i] || 0;
    const b = c.nums[i] || 0;
    if (a !== b) return a > b;
  }
  // Same core version: a real release beats a prerelease of it.
  if (r.pre && !c.pre) return false;
  if (!r.pre && c.pre) return true;
  return r.pre > c.pre;
}

function checkForUpdates(interactive) {
  if (!AUTO_UPDATE_SUPPORTED) {
    if (interactive) shell.openExternal(DOWNLOAD_PAGE);
    return;
  }

  const updater = getAutoUpdater();

  if (!updater || !app.isPackaged) {
    if (interactive) {
      dialog.showMessageBox({
        type: "info",
        message: "Updates are unavailable in this build",
        detail: "Automatic updates only run in the installed, signed app."
      });
    }
    return;
  }

  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  lastUpdateCheckAt = Date.now();
  // If a download stalls without ever firing update-downloaded or error, this
  // flag would otherwise stay true for the life of the process and no further
  // check would run until the app restarted. Updates would silently stop.
  clearTimeout(updateStuckTimer);
  updateStuckTimer = setTimeout(() => {
    updateCheckInFlight = false;
  }, 30 * 60 * 1000);

  updater
    .checkForUpdates()
    .then((result) => {
      const available =
        result &&
        result.updateInfo &&
        isNewerVersion(result.updateInfo.version, app.getVersion());
      if (!available) {
        clearTimeout(updateStuckTimer);
        updateCheckInFlight = false;
        if (interactive) {
          dialog.showMessageBox({
            type: "info",
            message: "You're up to date",
            detail: `Version ${app.getVersion()} is the latest release.`
          });
        }
      }
      // If an update *is* available it downloads on its own and the
      // "update-downloaded" handler above takes it from here.
    })
    .catch((err) => {
      clearTimeout(updateStuckTimer);
      updateCheckInFlight = false;
      if (interactive) {
        dialog.showMessageBox({
          type: "warning",
          message: "Could not check for updates",
          detail: err && err.message ? err.message : String(err)
        });
      }
    });
}

// Theme moved out of the widget's title bar and into the tray, so the header
// can be just the window controls and the centred app name.
// Matches initTheme() in widget.js, which applies the OS preference when
// nothing is stored.
function systemTheme() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function setTheme(mode) {
  setStoreValues({ theme: mode });
  refreshTrayMenu();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip("CF Ninjas AI - Claude Usage");
  refreshTrayMenu();
  // Paint the last known numbers immediately so the menu bar is populated
  // before the first poll comes back.
  updateTrayTitle(loadStore().claudeUsageStats);
  tray.on("click", () => {
    createMainWindow();
  });
}

// macOS lets a tray icon carry live text beside it, which is the whole point
// of a usage widget: the two numbers that matter are readable without opening
// anything. `monospacedDigit` stops the menu bar shuffling sideways every time
// a digit changes width - without it the text jitters on every poll.
//
// setTitle is macOS-only. On Windows the tooltip carries the same information,
// since there is nowhere in the taskbar to put text.
function updateTrayTitle(stats) {
  if (!tray || tray.isDestroyed()) return;
  // Opt-out, default on. Some people keep a crowded menu bar.
  if (loadStore().showTrayPercents === false) {
    if (process.platform === "darwin") tray.setTitle("");
    tray.setToolTip("CF Ninjas AI - Claude Usage");
    return;
  }

  const ok = stats && stats.ok;
  const fh = ok && stats.fiveHour ? stats.fiveHour.percent : null;
  const wk = ok && stats.weekly ? stats.weekly.percent : null;

  if (fh == null || wk == null) {
    // Deliberately blank rather than showing the last good numbers: a stale
    // percentage in the menu bar is indistinguishable from a current one.
    if (process.platform === "darwin") tray.setTitle("");
    // Before the first successful login there is nothing wrong with
    // claude.ai - the user simply has not signed in. Saying otherwise is the
    // first thing a new user hovers, and it points them at the wrong problem.
    let tip;
    if (ok) tip = "CF Ninjas AI - Claude Usage";
    else if (!loadStore().hasAuthedBefore) tip = "CF Ninjas AI - not signed in yet";
    else tip = "CF Ninjas AI - could not reach claude.ai";
    tray.setToolTip(tip);
    return;
  }

  const label = `${Math.round(fh)}% / ${Math.round(wk)}%`;
  if (process.platform === "darwin") {
    tray.setTitle(` ${label}`, { fontType: "monospacedDigit" });
  }
  tray.setToolTip(`Claude usage - 5-hour ${Math.round(fh)}%, 7-day ${Math.round(wk)}%`);
}

function refreshTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: "Show widget", click: () => createMainWindow() },
    { label: "Refresh now", click: () => fetchUsage() },
    { type: "separator" },
    {
      label: "Appearance",
      submenu: ["dark", "light"].map((mode) => ({
        label: mode === "dark" ? "Dark" : "Light",
        type: "radio",
        // With no stored preference the widget follows the OS, so the tray has
        // to as well. Defaulting to "dark" here meant a fresh install on a
        // light-mode Mac showed a light widget with Dark ticked - the app
        // disagreeing with itself on first launch.
        checked: (loadStore().theme || systemTheme()) === mode,
        click: () => setTheme(mode)
      }))
    },
    {
      label: "Show percentages in menu bar",
      type: "checkbox",
      visible: process.platform === "darwin",
      checked: loadStore().showTrayPercents !== false,
      click: (item) => {
        const store = loadStore();
        store.showTrayPercents = item.checked;
        saveStore(store);
        updateTrayTitle(loadStore().claudeUsageStats);
        refreshTrayMenu();
      }
    },
    { type: "separator" },
    {
      label: AUTO_UPDATE_SUPPORTED ? "Check for Updates…" : "Get the Latest Version…",
      click: () => checkForUpdates(true)
    },
    { type: "separator" },
    { label: "Log in to claude.ai…", click: () => getOrCreateAuthWindow(true) },
    {
      label: "Log out",
      click: async () => {
        stopPolling();
        await session.fromPartition(PARTITION).clearStorageData({ storages: ["cookies"] });
        setStoreValues({
          claudeUsageStats: { ok: false, fetchedAt: Date.now(), error: "logged_out" },
          // Leaving this true meant the next launch showed the widget and so
          // never surfaced the login window, stranding the user on a dead
          // widget with no way in.
          hasAuthedBefore: false
        });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.loadURL("https://claude.ai/login");
        }
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuittingForReal = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

// -----------------------------------------------------------------------
// IPC (the preload shim's chrome.storage / chrome.runtime.sendMessage)
// -----------------------------------------------------------------------

// Only the widget window may drive these. Cheap insurance: if anything else
// ever ends up in a webContents carrying the preload, it gets nothing.
function fromWidget(event) {
  return (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents
  );
}

ipcMain.handle("storage-get", (event, keys) => {
  if (!fromWidget(event)) return {};
  const store = loadStore();
  if (typeof keys === "string") return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    const result = {};
    keys.forEach((k) => (result[k] = store[k]));
    return result;
  }
  return store;
});

ipcMain.handle("storage-set", (event, obj) => {
  if (!fromWidget(event)) return false;
  setStoreValues(obj);
  return true;
});

ipcMain.handle("runtime-message", async (event, msg) => {
  if (!fromWidget(event)) return {};
  if (!msg) return {};
  if (msg.type === "refresh-now") {
    const stats = await fetchUsage();
    return { stats };
  }
  if (msg.type === "hide-window") {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    return {};
  }
  if (msg.type === "open-login") {
    getOrCreateAuthWindow(true);
    return {};
  }
  if (msg.type === "resize-window") {
    const hasW = Number.isFinite(msg.width);
    const hasH = Number.isFinite(msg.height);
    if (mainWindow && !mainWindow.isDestroyed() && (hasW || hasH)) {
      const b = mainWindow.getBounds();
      // Never taller than the screen the window is actually on - the month
      // calendar is tall, and on a laptop "fit the content" could otherwise
      // ask for a window that runs off the bottom.
      const work = screen.getDisplayMatching(b).workAreaSize;
      mainWindow.setBounds({
        x: b.x,
        y: b.y,
        width: hasW ? Math.max(MIN_WINDOW_WIDTH, Math.round(msg.width)) : b.width,
        height: hasH
          ? Math.max(320, Math.min(Math.round(msg.height), work.height - 40))
          : b.height
      });
      // "resized" only fires at the end of a USER drag, so without this the
      // compact toggle's new size is never written and the view silently
      // reverts on restart.
      saveBoundsDebounced();
    }
    return {};
  }
  if (msg.type === "minimize-window") {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return {};
  }
  if (msg.type === "open-external") {
    // Hand only https URLs to the OS browser - never file:// or a custom
    // scheme, which is how a renderer could otherwise launch something local.
    if (typeof msg.url === "string" && /^https:\/\//i.test(msg.url)) {
      shell.openExternal(msg.url);
    }
    return {};
  }
  if (msg.type === "quit-app") {
    app.isQuittingForReal = true;
    app.quit();
    return {};
  }
  return {};
});

// -----------------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------------

// On macOS, an app run from ~/Downloads is subject to App Translocation (it
// runs from a randomized read-only path), which breaks updates and generally
// misbehaves. Offer to move ourselves into /Applications on first launch.
// moveToApplicationsFolder() relaunches the app on success, so nothing after
// it in this function will run in that case.
function offerMoveToApplications() {
  if (process.platform !== "darwin") return;
  if (!app.isPackaged) return;
  if (app.isInApplicationsFolder()) return;

  const { response } = dialog.showMessageBoxSync
    ? { response: dialog.showMessageBoxSync({
        type: "question",
        buttons: ["Move to Applications", "Not Now"],
        defaultId: 0,
        cancelId: 1,
        title: "Move to Applications?",
        message: "Move CF Ninjas AI Usage Widget to your Applications folder?",
        detail:
          "Keeping the app in Applications lets macOS run and update it properly. " +
          "This takes a second and the app will reopen by itself."
      }) }
    : { response: 1 };

  if (response !== 0) return;

  try {
    app.moveToApplicationsFolder({
      conflictHandler: (conflict) => {
        if (conflict === "existsAndRunning") {
          dialog.showMessageBoxSync({
            type: "info",
            message: "Already running from Applications",
            detail:
              "A copy is already open from your Applications folder. Quit that " +
              "copy first, then try again."
          });
          return false;
        }
        return true;
      }
    });
  } catch (err) {
    dialog.showMessageBoxSync({
      type: "warning",
      message: "Could not move the app",
      detail:
        "Drag CF Ninjas AI Usage Widget into your Applications folder manually. " +
        "(" + (err && err.message ? err.message : String(err)) + ")"
    });
  }
}

// Two copies share one userData directory, so both read-modify-write
// store.json every 60s and whichever writes last silently discards the other's
// heatmap sample or window bounds. They also each add a tray icon and a menu
// bar string. offerMoveToApplications already knows two copies can coexist -
// this makes sure they don't.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createMainWindow();
  });
}

app.whenReady().then(async () => {
  offerMoveToApplications();

  createTray();

  // Make sure we get a normal Dock icon (right-click it -> Quit, or Cmd+Q,
  // both work as a backup to the X button and the tray menu) and a real
  // app menu, rather than relying on Electron's implicit default one.
  if (app.dock) {
    app.dock.show();
    // A packaged build gets its Dock icon from the bundled .icns, but `npm
    // start` runs the stock Electron binary and would otherwise show the
    // generic Electron logo. Setting it explicitly keeps dev and production
    // looking the same.
    try {
      const dockIcon = nativeImage.createFromPath(
        path.join(__dirname, "icons", "icon512.png")
      );
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    } catch (e) {
      // Cosmetic only - never let this stop startup.
    }
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "CF Ninjas AI Usage Widget",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Quit",
            accelerator: "Cmd+Q",
            click: () => {
              app.isQuittingForReal = true;
              app.quit();
            }
          }
        ]
      },
      { role: "editMenu" }
    ])
  );

  // A returning user should land on the widget, not watch a claude.ai window
  // appear and vanish. If we have authenticated on this machine before, show
  // the widget immediately with the last known numbers and re-check the
  // session quietly in the background.
  const returningUser = loadStore().hasAuthedBefore === true;
  if (returningUser) createMainWindow();

  getOrCreateAuthWindow(false);
  // Try the fast path as soon as the page settles - covers the case where a
  // session cookie already exists and claude.ai redirects straight past
  // /login. This is a nice-to-have, not load-bearing: if the page never
  // finishes loading (a slow network moment, a DNS hiccup, whatever), this
  // listener would simply never fire, and relying on it alone meant the app
  // could end up with nothing on screen at all and no way to tell why.
  authWindow.webContents.once("did-finish-load", () => {
    setTimeout(checkLoggedInFromAuthWindow, 300);
  });
  // The actual guarantee: no matter what happened above (page loaded fine,
  // failed to load, is still loading, whatever), show *something* within a
  // few seconds so the app is never silently invisible.
  // Last-resort visibility: if nothing at all is on screen after a few
  // seconds, surface the login window so the app is never silently invisible.
  // A returning user already has the widget up, so this stays out of the way.
  setTimeout(() => {
    if (authWindow && !authWindow.isDestroyed() && (!mainWindow || mainWindow.isDestroyed())) {
      authWindow.show();
      authWindow.focus();
    }
  }, returningUser ? 12000 : 3000);

  // Quiet background update checks: once shortly after launch (not instantly,
  // so it never competes with the login flow), then every six hours for
  // machines that stay up for days.
  // claude.ai needs none of these, and denying them means a page loaded into
  // the session partition cannot prompt the user with THIS app's name on the
  // dialog - which is a materially more trustworthy-looking prompt than a
  // browser's.
  const claudeSession = session.fromPartition(PARTITION);
  claudeSession.setPermissionRequestHandler((_wc, _perm, done) => done(false));
  claudeSession.setPermissionCheckHandler(() => false);

  startPollWatchdog();
  if (AUTO_UPDATE_SUPPORTED) {
    setTimeout(() => checkForUpdates(false), 15 * 1000);
    setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
  }
});

// Clicking the Dock icon of an app with no visible windows fires "activate".
// Without a handler nothing happens, and the tray is the only way back in -
// which nobody guesses.
app.on("activate", () => createMainWindow());

app.on("window-all-closed", () => {
  // Stay resident in the tray - do not quit when the widget window closes.
});

app.on("before-quit", () => {
  app.isQuittingForReal = true;
});

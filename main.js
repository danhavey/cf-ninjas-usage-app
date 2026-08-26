// CF Ninjas AI - Claude Usage Widget (desktop)
// Main process: owns the always-on-top window, the login flow, and polling
// claude.ai's own usage endpoints - the same ones its Settings > Usage page
// calls - using a session you log into once, right here in this app.

const { app, BrowserWindow, Tray, Menu, session, ipcMain, nativeImage, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const PARTITION = "persist:cfninjas-claude-usage";
const POLL_MS = 60 * 1000;
const STORE_PATH = path.join(app.getPath("userData"), "store.json");
const ACTIVITY_MAX_DAYS = 35;
const MIN_WINDOW_WIDTH = 300;
const DEFAULT_WINDOW_WIDTH = 340;

let mainWindow = null;
let authWindow = null; // stays alive (hidden once logged in) - it's our
                        // real claude.ai page context, used both to let the
                        // user log in and to make authenticated API calls.
let tray = null;
let pollTimer = null;
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
    fs.writeFileSync(STORE_PATH, JSON.stringify(store));
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

async function claudeApiFetch(url) {
  if (!authWindow || authWindow.isDestroyed()) throw new Error("no_auth_window");
  const script = `
    fetch(${JSON.stringify(url)}, { credentials: "include", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) { throw new Error("http_" + r.status); }
        return r.json();
      })
  `;
  return authWindow.webContents.executeJavaScript(script);
}

async function findConsumerOrgUuid() {
  const orgs = await claudeApiFetch("https://claude.ai/api/organizations");
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("no_orgs");
  const chatOrg = orgs.find(
    (o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")
  );
  return (chatOrg || orgs[0]).uuid;
}

async function fetchUsage() {
  try {
    const orgUuid = await findConsumerOrgUuid();
    const data = await claudeApiFetch(`https://claude.ai/api/organizations/${orgUuid}/usage`);

    const fiveHour = data.five_hour || {};
    const sevenDay = data.seven_day || {};
    const extra = data.extra_usage || {};

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
    setStoreValues({ claudeUsageStats: stats, hasAuthedBefore: true });
    return stats;
  } catch (err) {
    const stats = {
      ok: false,
      fetchedAt: Date.now(),
      error: String(err && err.message ? err.message : err)
    };
    setStoreValues({ claudeUsageStats: stats });
    return stats;
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
  if (!store.widthRevert140 && b.width >= 430) {
    b.width = DEFAULT_WINDOW_WIDTH;
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
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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
      contextIsolation: true
    }
  });

  authWindow.setMenuBarVisibility(false);
  authWindow.loadURL("https://claude.ai/login");

  authWindow.webContents.on("did-navigate", scheduleLoginCheck);
  authWindow.webContents.on("did-navigate-in-page", scheduleLoginCheck);
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
  if (mainWindow && !mainWindow.isDestroyed()) return; // already in
  const url = authWindow.webContents.getURL();
  if (/\/login/.test(url)) return; // still sitting on the login page itself

  try {
    const orgs = await claudeApiFetch("https://claude.ai/api/organizations");
    if (Array.isArray(orgs) && orgs.length > 0) {
      authWindow.hide();
      startPolling();
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

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  fetchUsage();
  pollTimer = setInterval(fetchUsage, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
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
    updateCheckInFlight = false;
    console.error("[updater]", err && err.message ? err.message : err);
  });

  return autoUpdater;
}

// `interactive` is true when the user picked "Check for Updates…" themselves,
// in which case silence would look broken - so we report "you're up to date"
// and surface errors. Background checks stay quiet.
function checkForUpdates(interactive) {
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

  updater
    .checkForUpdates()
    .then((result) => {
      const available =
        result && result.updateInfo && result.updateInfo.version !== app.getVersion();
      if (!available) {
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
function setTheme(mode) {
  setStoreValues({ theme: mode });
  refreshTrayMenu();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip("CF Ninjas AI - Claude Usage");
  refreshTrayMenu();
  tray.on("click", () => {
    createMainWindow();
  });
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
        checked: (loadStore().theme || "dark") === mode,
        click: () => setTheme(mode)
      }))
    },
    { type: "separator" },
    { label: "Check for Updates…", click: () => checkForUpdates(true) },
    { type: "separator" },
    { label: "Log in to claude.ai…", click: () => getOrCreateAuthWindow(true) },
    {
      label: "Log out",
      click: async () => {
        stopPolling();
        await session.fromPartition(PARTITION).clearStorageData({ storages: ["cookies"] });
        setStoreValues({
          claudeUsageStats: { ok: false, fetchedAt: Date.now(), error: "logged_out" }
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

ipcMain.handle("storage-get", (event, keys) => {
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
  setStoreValues(obj);
  return true;
});

ipcMain.handle("runtime-message", async (event, msg) => {
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
  setTimeout(() => checkForUpdates(false), 15 * 1000);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
});

app.on("window-all-closed", () => {
  // Stay resident in the tray - do not quit when the widget window closes.
});

app.on("before-quit", () => {
  app.isQuittingForReal = true;
});

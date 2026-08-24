// CF Ninjas AI - Claude Usage Widget (desktop)
// Main process: owns the always-on-top window, the login flow, and polling
// claude.ai's own usage endpoints - the same ones its Settings > Usage page
// calls - using a session you log into once, right here in this app.

const { app, BrowserWindow, Tray, Menu, session, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

const PARTITION = "persist:cfninjas-claude-usage";
const POLL_MS = 60 * 1000;
const STORE_PATH = path.join(app.getPath("userData"), "store.json");
const ACTIVITY_MAX_DAYS = 35;

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

    const stats = {
      ok: true,
      fetchedAt: Date.now(),
      fiveHour: { percent: round(fiveHour.utilization), resetsAt: fiveHour.resets_at || null },
      weekly: { percent: round(sevenDay.utilization), resetsAt: sevenDay.resets_at || null },
      credits: extra.is_enabled
        ? {
            enabled: true,
            percent: round(extra.utilization),
            usedDollars: centsToDollars(extra.used_credits),
            limitDollars: extra.monthly_limit != null ? extra.monthly_limit / 100 : null,
            currency: extra.currency || "USD"
          }
        : { enabled: false }
    };

    await recordActivityIfIncreased(stats.fiveHour.percent);
    setStoreValues({ claudeUsageStats: stats });
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

async function recordActivityIfIncreased(newPercent) {
  if (typeof newPercent !== "number") return;
  const store = loadStore();
  const lastFiveHourPercent = store.lastFiveHourPercent;
  store.lastFiveHourPercent = newPercent;

  if (typeof lastFiveHourPercent === "number" && newPercent > lastFiveHourPercent) {
    const now = new Date();
    const dateKey = localDateKey(now);
    const hour = now.getHours();

    const data = store.claudeActivity || {};
    data[dateKey] = data[dateKey] || {};
    data[dateKey][hour] = (data[dateKey][hour] || 0) + 1;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ACTIVITY_MAX_DAYS);
    const cutoffKey = localDateKey(cutoff);
    Object.keys(data).forEach((k) => {
      if (k < cutoffKey) delete data[k];
    });

    store.claudeActivity = data;
  }

  saveStore(store);
  if (mainWindow && !mainWindow.isDestroyed() && store.claudeActivity) {
    mainWindow.webContents.send("storage-changed", "claudeActivity", store.claudeActivity);
  }
}

// -----------------------------------------------------------------------
// Windows
// -----------------------------------------------------------------------

function getSavedBounds() {
  const store = loadStore();
  return store.windowBounds || { width: 340, height: 600 };
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
    minWidth: 300,
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

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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

app.whenReady().then(async () => {
  createTray();

  // Make sure we get a normal Dock icon (right-click it -> Quit, or Cmd+Q,
  // both work as a backup to the X button and the tray menu) and a real
  // app menu, rather than relying on Electron's implicit default one.
  if (app.dock) app.dock.show();
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
  setTimeout(() => {
    if (authWindow && !authWindow.isDestroyed() && (!mainWindow || mainWindow.isDestroyed())) {
      authWindow.show();
      authWindow.focus();
    }
  }, 3000);
});

app.on("window-all-closed", () => {
  // Stay resident in the tray - do not quit when the widget window closes.
});

app.on("before-quit", () => {
  app.isQuittingForReal = true;
});

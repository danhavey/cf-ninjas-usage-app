// Exposes a minimal chrome.storage / chrome.runtime shim so the SAME
// widget.html/widget.css/widget.js from the Chrome extension build can run
// here completely unmodified - it talks to "chrome.*" either way, it just
// doesn't know (or need to know) that this copy is backed by IPC to the
// Electron main process instead of the real extension APIs.
//
// Electron's Chromium renderer already defines its own built-in
// window.chrome (an empty compatibility object), so contextBridge won't let
// us expose anything directly under the name "chrome" - it throws rather
// than overwrite an existing property. We expose our shim under a private
// name instead, and widget.html assigns it onto window.chrome itself with a
// tiny inline script (ordinary page-context JS, not subject to that
// contextBridge restriction) before widget.js ever runs.

const { contextBridge, ipcRenderer } = require("electron");

const changeListeners = [];

ipcRenderer.on("storage-changed", (_event, key, newValue) => {
  const changes = {};
  changes[key] = { newValue };
  changeListeners.forEach((fn) => {
    try {
      fn(changes, "local");
    } catch (e) {
      console.error(e);
    }
  });
});

contextBridge.exposeInMainWorld("__cfninjas_chrome", {
  storage: {
    local: {
      // Every invoke gets a catch: an IPC handler that throws would otherwise
      // leave the callback un-called forever, and the caller has no way to
      // know. The visible symptom is the refresh button spinning for the rest
      // of the session.
      get: (keys, cb) => {
        ipcRenderer
          .invoke("storage-get", keys)
          .then((result) => cb(result || {}))
          .catch((err) => {
            console.error("storage-get failed:", err);
            cb({});
          });
      },
      set: (obj, cb) => {
        ipcRenderer
          .invoke("storage-set", obj)
          .then(() => { if (cb) cb(); })
          .catch((err) => {
            console.error("storage-set failed:", err);
            if (cb) cb();
          });
      }
    },
    onChanged: {
      addListener: (fn) => changeListeners.push(fn)
    }
  },
  runtime: {
    sendMessage: (msg, cb) => {
      ipcRenderer
        .invoke("runtime-message", msg)
        .then((resp) => { if (cb) cb(resp || {}); })
        .catch((err) => {
          console.error("runtime-message failed:", err);
          if (cb) cb({});
        });
    }
  },
  // widget.js calls these no-ops in the Electron build - polling is driven
  // by the main process's own setInterval instead of chrome.alarms.
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} }
  }
});

contextBridge.exposeInMainWorld("__isElectron", true);

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
      get: (keys, cb) => {
        ipcRenderer.invoke("storage-get", keys).then((result) => cb(result || {}));
      },
      set: (obj, cb) => {
        ipcRenderer.invoke("storage-set", obj).then(() => {
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
      ipcRenderer.invoke("runtime-message", msg).then((resp) => {
        if (cb) cb(resp || {});
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

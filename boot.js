// Runs before widget.js in BOTH builds - the Electron app and the Chrome
// extension - and is a separate file rather than an inline <script> because
// MV3 extension pages refuse inline scripts outright. Keeping it external also
// lets the page's CSP drop 'unsafe-inline'.
(function () {
  // Electron: preload.js cannot expose anything named "chrome" directly
  // (Chromium's renderer already defines one), so it hands us the real shim
  // under a private name and we assign it here. No-op in the extension, where
  // window.chrome is already the genuine extension API.
  if (window.__cfninjas_chrome) {
    window.chrome = window.__cfninjas_chrome;
  }

  // Can the host resize its own window on request? Electron does it from the
  // main process; the extension does it with chrome.windows.update from the
  // service worker. The renderer only needs to know that ASKING is worthwhile -
  // it should not care which one is listening.
  window.__canResizeWindow = !!(
    window.__isElectron ||
    (window.chrome && window.chrome.runtime && window.chrome.runtime.id)
  );
})();

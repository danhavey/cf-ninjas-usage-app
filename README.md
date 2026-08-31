# CF Ninjas AI - Claude Usage Widget (desktop)

A real always-on-top desktop app version of the widget: a small frameless
window that floats above every other app, plus a menu bar (tray) icon to
bring it back or quit. It polls the same claude.ai usage endpoints the
Chrome extension does, using a session you log into once, right here in
the app - not your browser's session, since a desktop app can't reach into
Chrome's cookie store.

I built and packaged this from a Linux machine, so I can't hand you a
pre-built .app directly (way over what I can send through chat, and it
needs to be built per-architecture anyway). Building it yourself on your
Mac takes about a minute and means it's built natively for your machine.

## Build it (one-time)

Requires [Node.js](https://nodejs.org) - you already have this if `node -v`
works in Terminal.

```bash
cd claude-usage-app
npm install
npm run dist
```

That downloads Electron (~100MB, one-time) and produces:

```
dist/mac/CF Ninjas AI Usage Widget.app          (Intel)
dist/mac-arm64/CF Ninjas AI Usage Widget.app    (Apple Silicon)
```

Use whichever matches the Mac it's running on. Drag it into
`/Applications`.

## First launch

The app is signed with an Apple Developer ID and notarized by Apple, so it
opens with a normal double-click. If macOS ever asks you to right-click and
choose Open to get past Gatekeeper, something is wrong with that copy - it is
not from us, or it was damaged in transit. Re-download it from
https://usage.cfninjas.com rather than clicking through the warning.

## What happens on first run

1. A small login window opens to claude.ai's normal login page. Log in
   like you would in a browser.
2. Once it detects you're logged in, that window closes and the floating
   widget appears - drag it anywhere by its title bar, it'll stay on top
   of everything.
3. A tray icon appears in your menu bar (the same ring mark as the
   widget). Click it to show the widget again if you close/hide it, force
   a refresh, log out, or quit.

Your login is remembered between launches (stored the same way any
desktop app remembers you're logged in), so this is a one-time thing
unless you explicitly log out from the tray menu.

## Updating later

If I send you new `main.js` / `widget.*` files, drop them into this
folder (overwriting the old ones) and run `npm run dist` again.

## Sharing this with someone else

Send them this whole project folder (or just the built `.app` if you'd
rather not hand over source) plus these instructions. They'll need Node
installed to build it themselves, or you can zip up your own built `.app`
and send that directly - no source needed on their end, just the
right-click-Open step above.

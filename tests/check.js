#!/usr/bin/env node
// Fast, dependency-free checks. Runs before the browser tests so an obvious
// breakage fails in a second rather than after a browser launch.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
let failures = 0;
const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { failures++; console.log("  FAIL " + m); };

// --- 1. every shipped script actually parses -------------------------------
// Cheap, and the only thing standing between a stray typo and a signed,
// notarized, auto-installed blank window.
const scripts = ["main.js", "preload.js", "widget.js", "boot.js"];
for (const f of scripts) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, f)], { stdio: "pipe" });
    ok(`${f} parses`);
  } catch (e) {
    bad(`${f} has a syntax error:\n${e.stderr}`);
  }
}

// --- 2. package.json and the lockfile agree --------------------------------
// `npm ci` enforces this too, but only after it has already been installing
// for a while - and a mismatch here once broke two releases in a row while
// looking like a workflow problem.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lockRoot = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
  .packages[""];
for (const key of ["dependencies", "devDependencies"]) {
  const a = JSON.stringify(pkg[key] || {});
  const b = JSON.stringify(lockRoot[key] || {});
  a === b
    ? ok(`package.json ${key} match the lockfile`)
    : bad(`package.json ${key} disagree with package-lock.json\n    package.json: ${a}\n    lock:         ${b}`);
}

// --- 3. everything widget.html loads is actually packaged ------------------
// electron-builder ships only what `build.files` lists. A script referenced by
// the page but missing from that list produces an app that launches to a blank
// window, and only in the packaged build - never in development.
const html = fs.readFileSync(path.join(root, "widget.html"), "utf8");
const packaged = pkg.build.files;
const refs = [...html.matchAll(/<script src="([^"]+)"|<link[^>]+href="([^"]+)"/g)]
  .map((m) => m[1] || m[2])
  .filter((u) => !/^https?:/.test(u));
for (const ref of refs) {
  fs.existsSync(path.join(root, ref))
    ? ok(`${ref} exists`)
    : bad(`widget.html references ${ref}, which is not in the repo`);
  packaged.includes(ref)
    ? ok(`${ref} is in build.files`)
    : bad(`widget.html loads ${ref} but build.files does not ship it - the packaged app would break`);
}

// --- 4. no inline <script> ------------------------------------------------
// The same widget.html is loaded by the Chrome extension, and MV3 refuses
// inline scripts outright.
/<script(?![^>]*\bsrc=)[^>]*>/.test(html)
  ? bad("widget.html has an inline <script>; MV3 will refuse to run it")
  : ok("no inline <script> in widget.html");

console.log(failures ? `\n${failures} check(s) failed` : "\nall static checks passed");
process.exit(failures ? 1 : 0);

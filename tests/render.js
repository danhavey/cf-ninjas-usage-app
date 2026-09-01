#!/usr/bin/env node
// Renders widget.html in a real browser and asserts what the user actually
// sees. `node --check` proves a file parses; it says nothing about whether the
// page draws. Every assertion here corresponds to a bug that actually shipped.
const path = require("path");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const PAGE = "file://" + path.join(root, "widget.html");

let failures = 0;
const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { failures++; console.log("  FAIL " + m); };
const eq = (actual, expected, label) =>
  actual === expected ? ok(label) : bad(`${label}\n    expected: ${expected}\n    actual:   ${actual}`);

const now = Date.now();
const HEALTHY = {
  ok: true,
  fetchedAt: now,
  fiveHour: { percent: 54, resetsAt: new Date(now + 3.6e6).toISOString(), isActive: true },
  weekly: { percent: 30, resetsAt: new Date(now + 1.7e8).toISOString(), isActive: false },
  credits: { enabled: true, percent: 82.2, usedDollars: 82.24, limitDollars: 100, balanceDollars: 52.61 }
};
const EXPIRED = { ok: false, fetchedAt: now, error: "http_401", lastSuccessAt: now - 9 * 60000 };

function heatmapFixture() {
  const key = (back) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  // 3% deliberately: light usage used to render identical to "no usage".
  return { [key(0)]: { 9: 3, 14: 68 }, [key(1)]: { 16: 95 } };
}

async function open(browser, { stats, electron, width = 340, height = 620 }) {
  const page = await browser.newPage({ viewport: { width, height } });
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (/Refused to|Content Security Policy/i.test(m.text())) problems.push("CSP: " + m.text());
  });
  await page.addInitScript(({ stats, heat, electron }) => {
    const api = {
      runtime: {
        id: electron ? undefined : "testextensionid",
        sendMessage: (m, cb) => { (window.__asks = window.__asks || []).push(m); if (cb) cb({}); }
      },
      storage: {
        local: { get: (k, cb) => cb({ claudeUsageStats: stats, claudeHeatmap: heat }), set: (o, cb) => cb && cb() },
        onChanged: { addListener: () => {} }
      },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
    };
    if (electron) { window.__isElectron = true; window.__cfninjas_chrome = api; }
    else { window.chrome = api; }
  }, { stats, heat: heatmapFixture(), electron });
  await page.goto(PAGE);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(500);
  return { page, problems };
}

(async () => {
  const browser = await chromium.launch();

  // --- desktop, healthy ----------------------------------------------------
  {
    const { page, problems } = await open(browser, { stats: HEALTHY, electron: true });
    eq(problems.length, 0, "desktop: no page errors or CSP violations" + (problems.length ? "\n    " + problems.join("\n    ") : ""));
    eq(await page.evaluate(() => typeof window.jQuery), "function", "desktop: jQuery loaded");
    eq(await page.textContent("#pct-five-hour"), "54", "desktop: 5-hour ring shows 54");
    eq(await page.textContent("#pct-weekly"), "30", "desktop: 7-day ring shows 30");
    eq((await page.textContent("#stat-credits .stat-value")).trim(), "$82.24 / $100.00", "desktop: credits render");
    eq((await page.textContent("#stat-credits .stat-balance")).trim(), "$52.61", "desktop: balance renders");
    eq(await page.evaluate(() => document.querySelectorAll(".activity-cell").length), 168, "desktop: heatmap is 7x24");

    // Light usage must be visible. 3% once rendered identical to an empty cell.
    const lightVisible = await page.evaluate(() => {
      const c = [...document.querySelectorAll(".activity-cell")].find((x) => / 3%$/.test(x.getAttribute("data-tip") || ""));
      return c ? c.style.background !== "var(--heatmap-0)" : null;
    });
    eq(lightVisible, true, "desktop: a 3% hour is drawn as used, not empty");

    // Month view must not render the same picture as week view.
    await page.click('.toggleBtn[data-range="month"]');
    await page.waitForTimeout(300);
    eq(await page.evaluate(() => document.querySelectorAll(".month-cell").length), 35, "desktop: month view is a 35-day calendar");
    await page.close();
  }

  // --- desktop, failed fetch ----------------------------------------------
  {
    const { page } = await open(browser, { stats: EXPIRED, electron: true });
    const box = (await page.textContent("#errorBox")).trim();
    box.includes("session expired") ? ok("desktop: expired session names the real cause") : bad("desktop: expired session shows '" + box + "'");
    eq(await page.evaluate(() => document.getElementById("app").classList.contains("is-stale")), true,
       "desktop: stale numbers are marked stale");
    const stamp = (await page.textContent("#updatedAt")).trim();
    /Last good reading/.test(stamp) ? ok("desktop: failure dates the last good reading") : bad("desktop: failure shows '" + stamp + "'");
    await page.close();
  }

  // --- compact mode is driven by width ------------------------------------
  {
    const { page } = await open(browser, { stats: HEALTHY, electron: true, width: 210, height: 560 });
    eq(await page.evaluate(() => document.body.classList.contains("compact")), true, "compact: engages at 210px");
    await page.setViewportSize({ width: 340, height: 620 });
    await page.waitForTimeout(250);
    eq(await page.evaluate(() => document.body.classList.contains("compact")), false, "compact: releases when widened");
    await page.close();
  }

  // --- the same page under the extension (no Electron shim) ---------------
  {
    const { page, problems } = await open(browser, { stats: HEALTHY, electron: false });
    eq(problems.length, 0, "extension: no page errors or CSP violations" + (problems.length ? "\n    " + problems.join("\n    ") : ""));
    eq(await page.textContent("#pct-five-hour"), "54", "extension: renders the same data");
    eq(await page.evaluate(() => document.getElementById("windowControls").classList.contains("hidden")), true,
       "extension: no Electron traffic lights");
    eq(await page.evaluate(() => !document.getElementById("themeBtn").classList.contains("hidden")), true,
       "extension: theme toggle is available");
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} render check(s) failed` : "\nall render checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

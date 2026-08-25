// CF Ninjas AI - Claude Usage Widget - popup window script (jQuery)

var RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in widget.html/css

// ---------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#iconMoon").toggleClass("hidden", theme === "dark");
  $("#iconSun").toggleClass("hidden", theme !== "dark");
}

function initTheme() {
  // Apply a synchronous best guess immediately to avoid a flash, then
  // correct it once the stored preference (if any) comes back.
  var systemGuess =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  applyTheme(systemGuess);

  chrome.storage.local.get("theme", function (result) {
    if (result.theme) applyTheme(result.theme);
  });
}

$("#themeBtn").on("click", function () {
  var current = document.documentElement.getAttribute("data-theme") || "light";
  var next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  chrome.storage.local.set({ theme: next });
});

// ---------------------------------------------------------------------
// Timezone helpers (used for the peak-hours indicator)
// ---------------------------------------------------------------------

var WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getZonedParts(date, timeZone) {
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  var parts = {};
  dtf.formatToParts(date).forEach(function (p) {
    if (p.type !== "literal") parts[p.type] = p.value;
  });
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: +parts.hour,
    minute: +parts.minute,
    second: +parts.second,
    weekdayIndex: WEEKDAY_INDEX[parts.weekday]
  };
}

function getOffsetMinutes(date, timeZone) {
  var p = getZonedParts(date, timeZone);
  var asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function fmtClock(totalMinutes) {
  var m = ((totalMinutes % 1440) + 1440) % 1440;
  var h24 = Math.floor(m / 60);
  var mins = m % 60;
  var ampm = h24 < 12 ? "AM" : "PM";
  var h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return h12 + (mins ? ":" + String(mins).padStart(2, "0") : ":00") + " " + ampm;
}

// Anthropic reduces Claude session limits on weekdays 5am-11am Pacific Time.
// https://www.anthropic.com (announced March 2026) - see widget README for sources.
function updatePeakIndicator() {
  var now = new Date();
  var pt = getZonedParts(now, "America/Los_Angeles");
  var isWeekday = pt.weekdayIndex >= 1 && pt.weekdayIndex <= 5;
  var isPeak = isWeekday && pt.hour >= 5 && pt.hour < 11;

  var localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var laOffset = getOffsetMinutes(now, "America/Los_Angeles");
  var localOffset = getOffsetMinutes(now, localTz);
  var diff = localOffset - laOffset;
  var startLocal = 5 * 60 + diff;
  var endLocal = 11 * 60 + diff;

  var $dot = $("#peakDot");
  var $label = $("#peakLabel");

  if (isPeak) {
    $dot.removeClass("off-peak").addClass("peak");
    $label.text("Peak hours · " + fmtClock(startLocal) + " – " + fmtClock(endLocal));
  } else {
    $dot.removeClass("peak").addClass("off-peak");
    $label.text("Off-peak · standard rates apply");
  }
}

// ---------------------------------------------------------------------
// Usage stats (rings + credits bar)
// ---------------------------------------------------------------------

// Severity gradient: shades of green at low usage, sliding through
// yellow-green, then amber/orange, and finally red as you approach 100%.
// (Claude's own settings page uses blue -> amber -> presumably red; this
// mirrors ClaudeKarma's green-based scheme instead, per request.)
var RING_STOPS = [
  { at: 0, c: [22, 163, 74] }, // deep green
  { at: 40, c: [132, 204, 22] }, // lime / yellow-green
  { at: 65, c: [245, 158, 11] }, // amber
  { at: 85, c: [234, 88, 12] }, // orange
  { at: 100, c: [220, 38, 38] } // red
];

function ringRgb(pct) {
  if (pct == null) return [22, 163, 74];
  var p = Math.min(100, Math.max(0, pct));
  for (var i = 0; i < RING_STOPS.length - 1; i++) {
    var a = RING_STOPS[i];
    var b = RING_STOPS[i + 1];
    if (p >= a.at && p <= b.at) {
      var t = (p - a.at) / (b.at - a.at || 1);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * t),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * t),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * t)
      ];
    }
  }
  return [22, 163, 74];
}

function ringColor(pct) {
  var c = ringRgb(pct);
  return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
}

function ringGlow(pct, alpha) {
  var c = ringRgb(pct);
  return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")";
}

function fmtResetsIn(iso) {
  if (!iso) return "--";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  var diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "resets soon";
  var mins = Math.round(diffMs / 60000);
  if (mins < 60) return "Resets in " + mins + "m";
  var hours = Math.floor(mins / 60);
  var rem = mins % 60;
  return "Resets in " + hours + "h " + rem + "m";
}

function fmtResetsDayTime(iso) {
  if (!iso) return "--";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  var day = d.toLocaleDateString(undefined, { weekday: "long" });
  var time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return "Resets " + day + " · " + time;
}

function setRing($svgCircle, $pctEl, pct) {
  var clamped = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  var offset = RING_CIRCUMFERENCE * (1 - clamped / 100);
  $svgCircle.css({
    "stroke-dashoffset": offset,
    stroke: ringColor(pct)
  });
  $svgCircle.closest(".ring").css("filter", "drop-shadow(0 0 6px " + ringGlow(pct, 0.35) + ")");
  $pctEl.text(pct != null ? Math.round(pct) : "--");
}

function fmtAgo(ts) {
  if (!ts) return "";
  var secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return "Updated just now";
  if (secs < 60) return "Updated " + secs + "s ago";
  var mins = Math.round(secs / 60);
  return "Updated " + mins + "m ago";
}

function renderStats(stats) {
  if (!stats) return;

  if (!stats.ok) {
    $("#errorBox").removeClass("hidden");
    if (window.__isElectron) {
      $("#errorBox").html(
        'Could not reach claude.ai. <a href="#" id="loginLink">Log in again</a>'
      );
    }
    $("#updatedAt").text(fmtAgo(stats.fetchedAt) || "Not connected");
    return;
  }
  $("#errorBox").addClass("hidden");

  var fh = stats.fiveHour || {};
  setRing($("#ring-five-hour"), $("#pct-five-hour"), fh.percent);
  $("#sub-five-hour").text(fmtResetsIn(fh.resetsAt));

  var wk = stats.weekly || {};
  setRing($("#ring-weekly"), $("#pct-weekly"), wk.percent);
  $("#sub-weekly").text(fmtResetsDayTime(wk.resetsAt));

  // Flag whichever limit is actually binding right now - the one that will
  // stop you first. claude.ai knows this but does not surface it.
  $(".stat-card").removeClass("is-binding");
  if (fh.isActive) $("#card-five-hour").addClass("is-binding");
  if (wk.isActive) $("#card-weekly").addClass("is-binding");

  var cr = stats.credits || {};
  var $credits = $("#stat-credits");
  $credits.removeClass("limit-reached");

  if (cr.enabled) {
    var used = cr.usedDollars != null ? "$" + cr.usedDollars.toFixed(2) : "--";
    var limit = cr.limitDollars != null ? "$" + cr.limitDollars.toFixed(2) : "--";
    $credits.find(".stat-value").text(used + " / " + limit);

    var sub = cr.percent != null ? cr.percent + "% used" : "";
    if (cr.limitReached) {
      sub = "monthly spend limit reached";
      $credits.addClass("limit-reached");
    }
    $credits.find(".stat-sub").text(sub);

    // Prepaid balance is a different number from spend: what you still hold,
    // rather than what you have spent against your own cap.
    var $bal = $credits.find(".stat-balance");
    if (cr.balanceDollars != null) {
      $bal.text("$" + cr.balanceDollars.toFixed(2) + " left").removeClass("hidden");
    } else {
      $bal.addClass("hidden");
    }

    var $fill = $credits.find(".bar-fill");
    $fill.css("width", (cr.percent == null ? 0 : Math.min(100, cr.percent)) + "%");
    $fill.css("background", ringColor(cr.percent));
  } else {
    $credits.find(".stat-value").text("off");
    $credits.find(".stat-sub").text(
      cr.userDisabled
        ? "you turned usage credits off"
        : cr.everEnabled
        ? "usage credits are turned off"
        : "usage credits not set up"
    );
    $credits.find(".stat-balance").addClass("hidden");
    $credits.find(".bar-fill").css("width", "0%");
  }

  $("#updatedAt").text(fmtAgo(stats.fetchedAt));
}

function loadStatsFromStorage() {
  chrome.storage.local.get("claudeUsageStats", function (result) {
    renderStats(result.claudeUsageStats);
  });
}

// ---------------------------------------------------------------------
// Activity heatmap
// ---------------------------------------------------------------------

var DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];
var activityRange = "week";

function buildActivityGrid() {
  var $grid = $("#activityGrid");
  $grid.empty();

  // corner spacer
  $grid.append('<div class="activity-hourlabel"></div>');
  for (var h = 0; h < 24; h++) {
    var label = HOUR_TICKS.indexOf(h) !== -1
      ? (h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : (h - 12) + "p")
      : "";
    $grid.append('<div class="activity-hourlabel">' + label + "</div>");
  }

  for (var d = 0; d < 7; d++) {
    $grid.append('<div class="activity-daylabel">' + DAY_LABELS[d] + "</div>");
    for (var hh = 0; hh < 24; hh++) {
      $grid.append(
        '<div class="activity-cell" data-day="' + d + '" data-hour="' + hh + '"></div>'
      );
    }
  }
}

function localDateKey(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function renderActivity(activity) {
  var data = activity || {};
  // counts[day][hour] = number of active pings observed
  var counts = [[], [], [], [], [], [], []];
  for (var d = 0; d < 7; d++) counts[d] = new Array(24).fill(0);

  var today = new Date();
  var daysBack = activityRange === "week" ? 7 : 30;
  var any = false;

  for (var i = 0; i < daysBack; i++) {
    var day = new Date(today);
    day.setDate(day.getDate() - i);
    var key = localDateKey(day);
    var dayData = data[key];
    if (!dayData) continue;
    var weekdayIndex = day.getDay();
    for (var hourStr in dayData) {
      var hour = +hourStr;
      counts[weekdayIndex][hour] += dayData[hourStr];
      any = true;
    }
  }

  var max = 1;
  counts.forEach(function (row) {
    row.forEach(function (v) {
      if (v > max) max = v;
    });
  });

  $("#activityGrid .activity-cell").each(function () {
    var $cell = $(this);
    var day = +$cell.attr("data-day");
    var hour = +$cell.attr("data-hour");
    var v = counts[day][hour];
    if (v === 0) {
      $cell.css("background", "var(--track)");
    } else {
      var intensity = Math.min(1, v / max);
      // Keep the heatmap in shades of green (mirroring ClaudeKarma) rather
      // than crossing into the amber/red "danger" end of the scale, which
      // is reserved for the usage rings actually nearing a limit.
      $cell.css("background", ringColor(intensity * 40));
    }
  });

  $("#activityEmpty").toggleClass("hidden", any);
  $("#activityGrid").toggleClass("hidden", !any);
}

function loadActivityFromStorage() {
  chrome.storage.local.get("claudeActivity", function (result) {
    renderActivity(result.claudeActivity);
  });
}

$(".toggleBtn").on("click", function () {
  $(".toggleBtn").removeClass("active");
  $(this).addClass("active");
  activityRange = $(this).data("range");
  loadActivityFromStorage();
});

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

$(function () {
  initTheme();
  buildActivityGrid();

  loadStatsFromStorage();
  loadActivityFromStorage();
  updatePeakIndicator();

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.claudeUsageStats) renderStats(changes.claudeUsageStats.newValue);
    if (changes.claudeActivity) loadActivityFromStorage();
  });

  setInterval(loadStatsFromStorage, 15000);
  setInterval(updatePeakIndicator, 30000);

  $("#refreshBtn").on("click", function () {
    var $btn = $(this).addClass("spinning");
    chrome.runtime.sendMessage({ type: "refresh-now" }, function (resp) {
      $btn.removeClass("spinning");
      if (resp && resp.stats) renderStats(resp.stats);
    });
  });

  // Electron desktop build only - the Chrome extension shim never sets this
  // flag, so none of this runs there.
  if (window.__isElectron) {
    // Traffic-light controls replace the lone X, and the theme toggle moves
    // to the tray menu where the rest of the app-level actions already live.
    $("#windowControls").removeClass("hidden");
    $("#themeBtn").addClass("hidden");

    $("#closeBtn").on("click", function () {
      chrome.runtime.sendMessage({ type: "quit-app" });
    });
    $("#minBtn").on("click", function () {
      chrome.runtime.sendMessage({ type: "minimize-window" });
    });
    // A plain href would navigate the widget itself away from the app, so in
    // the desktop build the link is handed to the OS browser instead.
    $(document).on("click", "#brandLink", function (e) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "open-external", url: this.href });
    });
    $(document).on("click", "#loginLink", function (e) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "open-login" });
    });
  }
});

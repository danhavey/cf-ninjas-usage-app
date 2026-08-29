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

// Reset times read as a clock time, not a countdown. A countdown forces you
// to do arithmetic to answer the only question that matters - "can I start
// something at 4?" - and it is stale the moment it is rendered, whereas
// "Resets 8:27pm" stays true between polls.
function fmtTimeOfDay(d) {
  var s = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // "8:27 PM" -> "8:27pm". 24-hour locales ("20:27") are left untouched.
  return s.replace(/\s*([AP])\.?M\.?$/i, function (_m, ap) {
    return ap.toLowerCase() + "m";
  });
}

function fmtResetsIn(iso) {
  if (!iso) return "--";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  if (d.getTime() - Date.now() <= 0) return "resets soon";
  // A 5-hour window can roll past midnight, and a bare "1:15am" would look
  // like it already passed.
  var prefix = d.toDateString() !== new Date().toDateString() ? "tomorrow " : "";
  return "Resets " + prefix + fmtTimeOfDay(d);
}

function fmtResetsDayTime(iso, shortDay) {
  if (!iso) return "--";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  var day = d.toLocaleDateString(undefined, { weekday: shortDay ? "short" : "long" });
  return "Resets " + day + " · " + fmtTimeOfDay(d);
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
    // Different causes need different actions from the user, so say which one
    // it is instead of blaming the network for everything - including for
    // their own deliberate sign-out.
    var err = String(stats.error || "");
    var msg, offerLogin = true;
    if (err === "logged_out") {
      msg = "Signed out.";
    } else if (/^http_(401|403)$/.test(err)) {
      msg = "Your claude.ai session expired.";
    } else if (err === "unexpected_response_shape") {
      msg = "claude.ai returned something unexpected. This usually means the app needs an update.";
      offerLogin = false;
    } else {
      msg = "Could not reach claude.ai.";
    }

    $("#errorBox").removeClass("hidden");
    $("#errorBox").text(msg);
    if (window.__isElectron && offerLogin) {
      $("#errorBox").append(' <a href="#" id="loginLink">Log in again</a>');
    }

    // The rings still show the last good numbers, so mark them as not current
    // and date them honestly. Stamping a failure "Updated just now" - which is
    // what fetchedAt gives you - reads as though these figures are live.
    $("#app").addClass("is-stale");
    $("#updatedAt").text(
      stats.lastSuccessAt ? "Last good reading " + fmtAgo(stats.lastSuccessAt).replace(/^Updated /, "") : "Not connected"
    );
    return;
  }
  $("#errorBox").addClass("hidden");
  $("#app").removeClass("is-stale");

  var fh = stats.fiveHour || {};
  setRing($("#ring-five-hour"), $("#pct-five-hour"), fh.percent);
  $("#sub-five-hour").attr("data-iso", fh.resetsAt || "");

  var wk = stats.weekly || {};
  setRing($("#ring-weekly"), $("#pct-weekly"), wk.percent);
  $("#sub-weekly").attr("data-iso", wk.resetsAt || "");
  paintResets();

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
    var $balRow = $credits.find(".stat-balance-row");
    if (cr.balanceDollars != null) {
      $balRow.find(".stat-balance").text("$" + cr.balanceDollars.toFixed(2));
      $balRow.removeClass("hidden");
    } else {
      $balRow.addClass("hidden");
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
    $credits.find(".stat-balance-row").addClass("hidden");
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
var MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];
var activityRange = "week";

function localDateKey(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// Level 0 is reserved for NO usage - no sample at all, or a sampled 0%.
// Real usage spans levels 1-5, each covering 20%: 1-20% -> 1, 21-40% -> 2,
// and so on to 81-100% -> 5. The earlier version bucketed with floor(pct/20),
// which put everything under 20% on the empty colour - so a 3% hour was
// recorded correctly and drawn as though nothing had happened.
function heatmapLevel(pct) {
  if (typeof pct !== "number" || pct <= 0) return 0;
  return Math.min(5, Math.ceil(pct / 20));
}

function fmtHour(h) {
  return String(h).padStart(2, "0") + ":00";
}

function hourTick(h) {
  if (HOUR_TICKS.indexOf(h) === -1) return "";
  if (h === 0) return "12a";
  if (h < 12) return h + "a";
  if (h === 12) return "12p";
  return (h - 12) + "p";
}

// Peak usage for one calendar day, across every hour we sampled.
function dayPeak(data, key) {
  var d = data[key];
  if (!d) return null;
  var peak = null;
  for (var h in d) {
    var v = d[h];
    if (typeof v !== "number") continue;
    if (peak === null || v > peak) peak = v;
  }
  return peak;
}

function fmtDayLong(d) {
  return DAY_LABELS[d.getDay()] + " " + MONTH_LABELS[d.getMonth()] + " " + d.getDate();
}

// --- Week: hours across, days down ------------------------------------
// Seven actual dates, so the tooltip can name the day and hour.
function renderWeek(data, $grid) {
  var today = new Date();
  var any = false;

  $grid.append('<div class="activity-hourlabel"></div>');
  for (var h = 0; h < 24; h++) {
    $grid.append('<div class="activity-hourlabel">' + hourTick(h) + "</div>");
  }

  for (var i = 6; i >= 0; i--) {
    var d = new Date(today);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    var key = localDateKey(d);
    $grid.append('<div class="activity-daylabel">' + DAY_LABELS[d.getDay()] + "</div>");

    for (var hh = 0; hh < 24; hh++) {
      var dayData = data[key];
      var peak = dayData && typeof dayData[hh] === "number" ? dayData[hh] : null;
      if (peak !== null) any = true;

      $grid.append(
        $('<div class="activity-cell"></div>')
          .attr("data-tip", fmtDayLong(d) + " " + fmtHour(hh) + " · " +
                            (peak === null ? "no data" : peak + "%"))
          .css("background", "var(--heatmap-" + heatmapLevel(peak) + ")")
      );
    }
  }
  return any;
}

// --- Month: a real calendar, one square per day -----------------------
// Folding 30 days onto seven weekday rows - what this used to do - produced a
// grid indistinguishable from the week view: same seven labels, and with less
// than a week of data literally the same squares. A toggle whose output looks
// identical reads as broken. Days across and weeks down answers a different
// question ("which DAYS were heavy?") and always looks different.
function renderMonth(data, $grid) {
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var any = false;

  for (var w = 0; w < 7; w++) {
    $grid.append('<div class="month-daylabel">' + DAY_LABELS[w] + "</div>");
  }

  // Five whole weeks ending with the week containing today, so the columns
  // line up under their weekday labels the way a wall calendar does.
  var start = new Date(today);
  start.setDate(start.getDate() - (28 + today.getDay()));

  for (var i = 0; i < 35; i++) {
    var d = new Date(start);
    d.setDate(d.getDate() + i);

    if (d > today) {
      // Later this week. Not "no usage" - hasn't happened yet.
      $grid.append('<div class="month-cell is-future"></div>');
      continue;
    }

    var peak = dayPeak(data, localDateKey(d));
    if (peak !== null) any = true;

    $grid.append(
      $('<div class="month-cell"></div>')
        .attr("data-level", heatmapLevel(peak))
        .attr("data-tip", fmtDayLong(d) + " · " +
                          (peak === null ? "no data" : "peak " + peak + "%"))
        .css("background", "var(--heatmap-" + heatmapLevel(peak) + ")")
        .text(d.getDate())
    );
  }
  return any;
}

function renderActivity(activity) {
  var data = activity || {};
  var $grid = $("#activityGrid");
  var month = activityRange === "month";

  // The grid is rebuilt wholesale every time new data arrives. jQuery removing
  // the hovered cell does not fire mouseleave, and the tooltip lives outside
  // the grid, so without this it freezes on screen showing a stale reading.
  $("#heatmapTooltip").addClass("hidden");

  $grid.empty().toggleClass("month-grid", month);
  var any = month ? renderMonth(data, $grid) : renderWeek(data, $grid);

  $("#activityEmpty").toggleClass("hidden", any);
  $("#heatmapLegend").toggleClass("hidden", !any);
  $grid.toggleClass("hidden", !any);
}

function loadActivityFromStorage() {
  // Compact mode hides the heatmap entirely; rebuilding 200 nodes a minute
  // into a display:none container is pure waste. applyCompact() re-renders on
  // the way back to full view.
  if (typeof isCompact === "function" && isCompact()) return;
  chrome.storage.local.get("claudeHeatmap", function (result) {
    renderActivity(result.claudeHeatmap);
  });
}

// Tooltip. Positioned against #activity and clamped to it, so a cell in the
// far-left or far-right hour column can't push the bubble off the widget.
$(document)
  .on("mouseenter", ".activity-cell, .month-cell:not(.is-future)", function () {
    var $cell = $(this);
    var $tip = $("#heatmapTooltip");
    var $anchor = $("#activity");

    $tip.text($cell.attr("data-tip")).removeClass("hidden");

    var cellTop = $cell.offset().top - $anchor.offset().top;
    var cellLeft = $cell.offset().left - $anchor.offset().left;

    var left = cellLeft + $cell.outerWidth() / 2 - $tip.outerWidth() / 2;
    var maxLeft = $anchor.innerWidth() - $tip.outerWidth();
    if (left < 0) left = 0;
    if (left > maxLeft) left = Math.max(0, maxLeft);

    var top = cellTop - $tip.outerHeight() - 5;
    if (top < 0) top = cellTop + $cell.outerHeight() + 5;

    $tip.css({ left: left + "px", top: top + "px" });
  })
  .on("mouseleave", ".activity-cell, .month-cell", function () {
    $("#heatmapTooltip").addClass("hidden");
  });

$(".toggleBtn").on("click", function () {
  $(".toggleBtn").removeClass("active");
  $(this).addClass("active");
  activityRange = $(this).data("range");
  $("#heatmapTooltip").addClass("hidden");
  loadActivityFromStorage();
});

// ---------------------------------------------------------------------
// Compact view
// ---------------------------------------------------------------------

// Window width is the single source of truth for which view is showing.
// An earlier version also kept a sticky user preference that could override
// the width - which meant that once you had toggled to compact, dragging the
// window wider left you in a stretched compact layout with no way back except
// the button. Width-only is both simpler and what the drag gesture implies:
// the toggle button does not set a mode, it just resizes the window, and the
// layout follows. Window bounds are persisted, so the view still survives a
// restart.
var COMPACT_BREAKPOINT = 300;
var COMPACT_WIDTH = 210;
var COMPACT_HEIGHT = 550;
var FULL_WIDTH = 340;
var FULL_HEIGHT = 600;

function isCompact() {
  return window.innerWidth < COMPACT_BREAKPOINT;
}

function paintResets() {
  var compact = isCompact();
  $("#sub-five-hour").text(fmtResetsIn($("#sub-five-hour").attr("data-iso")));
  $("#sub-weekly").text(fmtResetsDayTime($("#sub-weekly").attr("data-iso"), compact));
}

// Resize fires continuously while dragging, so do the work only when the mode
// actually flips.
var lastCompactState = null;

function applyCompact() {
  var compact = isCompact();
  if (compact === lastCompactState) return;
  lastCompactState = compact;
  $("body").toggleClass("compact", compact);
  $("#iconCompact").toggleClass("hidden", compact);
  $("#iconExpand").toggleClass("hidden", !compact);
  $("#compactBtn").attr("title", compact ? "Full view" : "Compact view");
  paintResets();
  // The heatmap sizes its cells off the container, so it has to re-measure
  // after the layout changes - and it is hidden in compact, so skip the work.
  if (!compact) loadActivityFromStorage();
}

$("#compactBtn").on("click", function () {
  var goCompact = !isCompact();
  if (!window.__isElectron) {
    // No window to resize in the browser build - flip the class directly.
    $("body").toggleClass("compact", goCompact);
    return;
  }
  chrome.runtime.sendMessage({
    type: "resize-window",
    width: goCompact ? COMPACT_WIDTH : FULL_WIDTH,
    height: goCompact ? COMPACT_HEIGHT : FULL_HEIGHT
  });
  // The resize event that follows drives applyCompact.
});

$(window).on("resize", applyCompact);

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

$(function () {
  initTheme();
  applyCompact();

  loadStatsFromStorage();
  loadActivityFromStorage();
  updatePeakIndicator();

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.claudeUsageStats) renderStats(changes.claudeUsageStats.newValue);
    if (changes.claudeHeatmap) loadActivityFromStorage();
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
    $("#compactBtn").removeClass("hidden");

    $("#closeBtn").on("click", function () {
      chrome.runtime.sendMessage({ type: "quit-app" });
    });
    $("#minBtn").on("click", function () {
      chrome.runtime.sendMessage({ type: "minimize-window" });
    });
    // A plain href would navigate the widget itself away from the app, so in
    // the desktop build the link is handed to the OS browser instead.
    $(document).on("click", ".extLink", function (e) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "open-external", url: this.href });
    });
    $(document).on("click", "#loginLink", function (e) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "open-login" });
    });
  }
});

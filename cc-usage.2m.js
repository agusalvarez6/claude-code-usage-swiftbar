#!/bin/sh
':' //; for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$n" ] && exec "$n" "$0" "$@"; done; echo "Claude ⚠ (node not found)"; exit 0
/*
 * SwiftBar plugin: Claude Code usage in the menu bar.
 *
 * Lines 1 and 2 form a shell and Node.js polyglot. SwiftBar launches plugins
 * with a minimal GUI PATH. The shell locates Node.js and executes this file.
 * Node.js treats line 2 as a string literal followed by a comment.
 *
 * The plugin reads rolling 5-hour and 7-day plan usage from Anthropic's
 * /api/oauth/usage endpoint. It authenticates with the access token that Claude
 * Code stores in the macOS Keychain. The plugin reads but never refreshes it.
 *
 * The crab reflects the highest-usage window. The 5-hour row estimates when the
 * measured pace will reach the limit. SwiftBar sends one notification each time
 * a window crosses 90%.
 *
 * The filename sets SwiftBar's refresh interval to two minutes. After a failed
 * request, the plugin shows the last successful value from a temporary cache.
 * It labels the value as cached once it is older than STALE_AFTER_MS.
 *
 * The plugin uses Node.js built-ins and no background service.
 *
 * SwiftBar reads the following metadata from the raw file for its About entry.
 * The block keeps the tags valid JavaScript.
 *
 * <xbar.title>Claude Code Usage</xbar.title>
 * <xbar.version>v1.0.0</xbar.version>
 * <xbar.author>Agustin Alvarez</xbar.author>
 * <xbar.author.github>agusalvarez6</xbar.author.github>
 * <xbar.desc>Claude Code 5-hour and 7-day usage limits in the menu bar.</xbar.desc>
 * <xbar.image>https://raw.githubusercontent.com/agusalvarez6/claude-code-usage-swiftbar/main/docs/menubar.png</xbar.image>
 * <xbar.dependencies>node</xbar.dependencies>
 * <xbar.abouturl>https://github.com/agusalvarez6/claude-code-usage-swiftbar</xbar.abouturl>
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CACHE = path.join(os.tmpdir(), "cc-usage-swiftbar.json");
const STALE_AFTER_MS = 10 * 60 * 1000; // flag cached data only once it is this old
const ALERT_AT = 90; // notify once when a window crosses this percent
const FETCH_TIMEOUT_MS = 10 * 1000; // abort the usage call so a hung socket cannot stall the run
const MIN_ELAPSED_MIN = 10; // project a pace only once a window holds this much history

// The Claude Code pixel pet as small embedded PNGs (22x18) so the plugin stays a
// single self-contained file. Three expressions, picked by the worst window.
const PET_CALM =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAASCAYAAABfJS4tAAAAPUlEQVR42mNggIKb5eH/qYEZ0MGowTgN1laQAGNcBuCSHzUY02BqRRqGBaMG0yysR8sK3AajW0Aun+YGAwA7BjtuIudVLwAAAABJRU5ErkJggg==";
const PET_WORRIED =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAASCAYAAABfJS4tAAAASElEQVR42mNggIKb5eH/qYEZ0MGowTgN1laQAGNcBuCSHzoG55/4Csa0N5hakQYzGB4kg95gjEikmcGjWZp+BqNbQC6f5gYDACO8P5a6BKXCAAAAAElFTkSuQmCC";
const PET_ALARMED =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAASCAYAAABfJS4tAAAARUlEQVR42mNggIKnHr7/qYEZ0MGowRgGaytIoGBcBuBSR3+D0TUSMpjkMKbYYGpFGoYFowbTLKxHywrcBqNbQC6f5gYDAKyH/TfWteLeAAAAAElFTkSuQmCC";

function petFor(percent, severity) {
  if (severity === "critical" || severity === "exceeded" || percent >= 90) return PET_ALARMED;
  if (severity === "warning" || percent >= 75) return PET_WORRIED;
  return PET_CALM;
}

// Token
// Read the access token that Claude Code stores in the Keychain. Refreshing would
// rotate the token without persisting the result because each run is a separate
// process. Claude Code owns token renewal.
function readToken() {
  return new Promise((resolve, reject) => {
    execFile("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: 5000 }, (err, out) => {
      if (err) return reject(new Error("Not logged in to Claude Code"));
      try {
        const parsed = JSON.parse(out.trim());
        const creds = parsed.claudeAiOauth || parsed;
        if (!creds.accessToken) return reject(new Error("Not logged in to Claude Code"));
        if (creds.expiresAt && creds.expiresAt <= Date.now()) {
          return reject(new Error("Token expired. Open Claude Code"));
        }
        resolve(creds.accessToken);
      } catch {
        reject(new Error("Couldn't read the Keychain credentials"));
      }
    });
  });
}

async function fetchUsage() {
  const token = await readToken();
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error("Token rejected. Open Claude Code");
  if (!res.ok) throw new Error("Usage request failed with HTTP " + res.status);
  return res.json();
}

// Normalize
// Read each window from the `limits` array or its legacy top-level object.
function windowFrom(raw, kind, fallbackKey) {
  const limit = Array.isArray(raw.limits) ? raw.limits.find((x) => x.kind === kind) : null;
  if (limit) return { percent: Math.round(limit.percent ?? 0), resetsAt: limit.resets_at || null, severity: limit.severity || "normal" };
  const fallback = raw[fallbackKey];
  if (fallback) return { percent: Math.round(fallback.utilization ?? 0), resetsAt: fallback.resets_at || null, severity: "normal" };
  return { percent: 0, resetsAt: null, severity: "normal" };
}

// Convert extra usage credits to dollars. The legacy response enables extra usage
// when it reports a nonzero amount.
function spendFrom(raw) {
  const eu = raw.extra_usage;
  if (eu) return { dollars: (typeof eu.used_credits === "number" ? eu.used_credits : 0) / 100, enabled: !!eu.is_enabled };
  const minor = raw.spend && raw.spend.used && typeof raw.spend.used.amount_minor === "number" ? raw.spend.used.amount_minor : 0;
  return { dollars: minor / 100, enabled: minor > 0 };
}

// Presentation
// Usage-level color as basic ANSI SGR codes (31 red, 33 yellow, 32 green).
// SwiftBar maps them to dynamic system colors. Basic ANSI has no orange, so the
// scale uses three levels.
function ansiFor(win) {
  const p = win.percent;
  if (win.severity === "critical" || win.severity === "exceeded" || p >= 90) return 31; // red
  if (win.severity === "warning" || p >= 50) return 33; // yellow
  return 32; // green
}

// Text progress bar, for example "███████░░░░".
function bar(pct, width = 11) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtDur(hours) {
  const mins = Math.max(1, Math.round(hours * 60));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h${m > 0 ? m + "m" : ""}` : `${m}m`;
}

// Estimate when the measured average pace will reach 100%. Suppress the estimate
// until enough history exists to limit distortion from short bursts. The same
// guard covers clock skew and windows longer than expected.
function timeToCap(win, windowMinutes) {
  if (!win.resetsAt || win.percent <= 0 || win.percent >= 100) return null;
  const timeLeftMin = (new Date(win.resetsAt).getTime() - Date.now()) / 60000;
  if (timeLeftMin <= 0) return null;
  const elapsedMin = windowMinutes - timeLeftMin;
  if (elapsedMin < MIN_ELAPSED_MIN) return null;
  const minsToCap = (elapsedMin * (100 - win.percent)) / win.percent;
  const resetsFirst = minsToCap >= timeLeftMin;
  return {
    text: `At this pace, limit in ${fmtDur(minsToCap / 60)}${resetsFirst ? " (resets first)" : ""}`,
    icon: resetsFirst ? "checkmark.circle" : "flame",
  };
}

// Compact two-unit countdown, such as "5d20h", "3h21m", or "21m".
function timeLeft(iso) {
  if (!iso) return "?";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const m = Math.floor(diff / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

// Color one segment and let the rest inherit the menu's default text color.
// ANSI white is static and appears grey through the translucent menu.
const ESC = String.fromCharCode(27);
function tint(code, text) {
  return `${ESC}[${code}m${text}${ESC}[0m`;
}

// Emit one SwiftBar line: "text" or "text | key=value ...".
function print(text, params) {
  if (!params) return console.log(text);
  console.log(`${text} | ` + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" "));
}

// All dropdown lines share one font size so the text reads as one block.
const SIZE = 13;

// Render a window with the menu's dynamic text color. The refresh action keeps
// the row enabled. A window without a reset time appears as "Idle."
function row(label, icon, win) {
  const reset = win.resetsAt ? `Resets in ${timeLeft(win.resetsAt)}` : "Idle";
  const text = `${label.padEnd(8)}${bar(win.percent)}  ${String(win.percent).padStart(3)}%   ${reset}`;
  print(text, { refresh: "true", sfimage: icon, font: "Menlo", size: SIZE });
}

function render(data, stale) {
  const { five, seven, spend, fetchedAt } = data;
  const worstPercent = Math.max(five.percent, seven.percent);
  const rank = (s) => (s === "exceeded" ? 4 : s === "critical" ? 3 : s === "warning" ? 2 : 1);
  const worstSeverity = rank(five.severity) >= rank(seven.severity) ? five.severity : seven.severity;
  const pet = petFor(worstPercent, worstSeverity);

  print(`5h ${tint(ansiFor(five), `${five.percent}%`)} · 7d ${tint(ansiFor(seven), `${seven.percent}%`)}`, { image: pet, ansi: "true", size: SIZE });
  print("---");

  const when = fetchedAt ? new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  print(`Claude Code${when ? `  ·  updated ${when}` : ""}`, { image: pet, refresh: "true", size: SIZE });
  print("---");

  row("5 Hours", "clock", five);
  const cap = timeToCap(five, 5 * 60); // the 5-hour window is 300 minutes
  if (cap) print(cap.text, { refresh: "true", sfimage: cap.icon, size: SIZE });
  row("7 Days", "calendar", seven);

  if (spend && spend.enabled && spend.dollars > 0) {
    print("---");
    print(`Extra usage   $${spend.dollars.toFixed(2)}`, { refresh: "true", sfimage: "creditcard", size: SIZE });
  }

  print("---");
  if (stale) print("Showing cached data after a failed request", { refresh: "true", sfimage: "exclamationmark.triangle", size: SIZE });
  print("Refresh", { refresh: "true", sfimage: "arrow.clockwise", size: SIZE });
}

function renderError(msg) {
  print(tint(31, "⚠"), { image: PET_ALARMED, ansi: "true", size: SIZE });
  print("---");
  print(tint(31, `Error: ${msg}`), { ansi: "true", sfimage: "exclamationmark.triangle", size: SIZE });
  print("Check Claude Code and your network, then refresh.", { refresh: "true", size: SIZE });
  print("---");
  print("Refresh", { refresh: "true", sfimage: "arrow.clockwise", size: SIZE });
}

// Notify once when a window crosses ALERT_AT. A reset below the threshold arms
// the next notification. SwiftBar requires macOS notification permission.
function notify(title, body) {
  const name = path.basename(__filename);
  const url = `swiftbar://notify?plugin=${encodeURIComponent(name)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  execFile("open", [url], () => {});
}
function crossed(prev, cur) {
  return typeof prev === "number" && prev < ALERT_AT && cur >= ALERT_AT;
}

async function main() {
  let prior = {};
  try {
    prior = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {}

  try {
    const raw = await fetchUsage();
    const five = windowFrom(raw, "session", "five_hour");
    const seven = windowFrom(raw, "weekly_all", "seven_day");

    const data = { five, seven, spend: spendFrom(raw), fetchedAt: Date.now() };
    fs.writeFileSync(CACHE, JSON.stringify(data));

    if (prior.five && crossed(prior.five.percent, five.percent)) notify("5-hour limit almost reached", `Usage is ${five.percent}%. Resets in ${timeLeft(five.resetsAt)}.`);
    if (prior.seven && crossed(prior.seven.percent, seven.percent)) notify("Weekly limit almost reached", `Usage is ${seven.percent}% of your 7-day limit.`);

    render(data, false);
  } catch (e) {
    if (prior && prior.five) {
      const stale = !prior.fetchedAt || Date.now() - prior.fetchedAt > STALE_AFTER_MS;
      render(prior, stale);
    } else {
      renderError(e.message);
    }
  }
}

main();

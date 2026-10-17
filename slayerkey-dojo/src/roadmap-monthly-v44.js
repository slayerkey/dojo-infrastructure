import {
  buildRoadmapLeaderboard,
  buildLeaderboardMessage,
} from "./roadmap-leaderboard-v43.js";

const TZ = "America/Phoenix";
const MONTH_PREFIX = "roadmap:v44:month:";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ALIASES = new Map(MONTH_NAMES.flatMap((name, i) => [
  [name.toLowerCase(), i + 1],
  [name.slice(0, 3).toLowerCase(), i + 1],
]));
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function localPhoenixTime(date = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const monthNumber = Number(parts.month);
  return {
    year,
    monthNumber,
    month: String(year) + "-" + String(monthNumber).padStart(2, "0"),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function monthLabel(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ""));
  if (!match) throw new Error("Invalid archived month.");
  return MONTH_NAMES[Number(match[2]) - 1] + " " + match[1];
}

export function resolveLeaderboardMonth(value, now = new Date()) {
  const today = localPhoenixTime(now).month;
  const input = String(value || "").trim().toLowerCase();
  if (!input || input === "current" || input === "this month" || input === "now") {
    return { kind: "current", month: today, label: monthLabel(today) };
  }

  let month = "";
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(input)) {
    month = input;
  } else {
    const normalized = input.replace(/\s+/g, " ");
    if (normalized === "last month" || normalized === "previous month") {
      const current = localPhoenixTime(now);
      const year = current.monthNumber === 1 ? current.year - 1 : current.year;
      const prevMonth = current.monthNumber === 1 ? 12 : current.monthNumber - 1;
      month = String(year) + "-" + String(prevMonth).padStart(2, "0");
    } else {
      const named = /^([a-z]+)(?: (\d{4}))?$/.exec(normalized);
      if (!named || !MONTH_ALIASES.has(named[1])) {
        return { error: "Choose a month such as September or 2026-09. Leave it blank for the live leaderboard." };
      }
      const number = MONTH_ALIASES.get(named[1]);
      const current = localPhoenixTime(now);
      const year = named[2] ? Number(named[2]) : (number > current.monthNumber ? current.year - 1 : current.year);
      month = String(year) + "-" + String(number).padStart(2, "0");
    }
  }

  if (month > today) return { error: "That month is in the future. Choose the current month or an older month." };
  return { kind: month === today ? "current" : "archive", month, label: monthLabel(month) };
}

export function isPhoenixMonthEndMinute(now = new Date()) {
  const current = localPhoenixTime(now);
  return current.hour === 23 && current.minute === 59 &&
    localPhoenixTime(new Date(now.getTime() + 60000)).month !== current.month;
}

export async function readRoadmapMonth(gateway, month) {
  return gateway.ctx.storage.get(MONTH_PREFIX + month);
}

export async function saveRoadmapMonth(gateway, month, snapshot) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) throw new Error("Invalid snapshot key.");
  if (!snapshot || !Array.isArray(snapshot.rows)) throw new Error("Invalid leaderboard snapshot.");
  return gateway.ctx.storage.transaction(async (txn) => {
    const key = MONTH_PREFIX + month;
    const existing = await txn.get(key);
    if (existing) return { saved: false, snapshot: existing };
    const frozen = {
      month,
      captured_at: new Date().toISOString(),
      // Copy only the data needed to show the same standings later.
      rows: structuredClone(snapshot.rows),
      members_scored: Number(snapshot.members_scored || snapshot.rows.length),
    };
    await txn.put(key, frozen);
    return { saved: true, snapshot: frozen };
  });
}

export async function captureRoadmapMonthEnd(now, env, stub, modelBuilders) {
  if (!isPhoenixMonthEndMinute(now)) return { skipped: "not_month_end" };
  if (!stub) return { skipped: "gateway_unavailable" };
  const month = localPhoenixTime(now).month;
  if (await stub.getRoadmapMonthlySnapshot(month)) return { skipped: "already_saved", month };

  // Ignore the normal 5-minute leaderboard cache when freezing a month.
  // We only archive scores observed in the final local minute.
  const current = await buildRoadmapLeaderboard(env, stub, modelBuilders, { forceRefresh: true, now: now.getTime() });
  const result = await stub.saveRoadmapMonthlySnapshot(month, current);
  return { saved: result.saved, month, members_scored: current.members_scored };
}

export function unavailableMonthMessage(selection, currentMonth) {
  const currentLabel = monthLabel(currentMonth);
  return {
    content: "**No saved snapshot for " + selection.label + ".**\n" +
      "This leaderboard did not record an end-of-month snapshot then, so accurate historical standings aren't available. " +
      "We won't substitute today's rankings.\n" +
      "The bot will start freezing snapshots at the end of " + currentLabel + ". " +
      "Use \`/roadmap-leaderboard\` for current standings.",
    allowed_mentions: { parse: [] },
  };
}

export async function getMonthlyLeaderboardMessage(selection, env, stub, builders, userId) {
  if (selection.kind === "archive") {
    const snapshot = await stub.getRoadmapMonthlySnapshot(selection.month);
    if (!snapshot) return unavailableMonthMessage(selection, localPhoenixTime().month);
    return buildLeaderboardMessage(snapshot, userId, {
      label: selection.label,
      archived: true,
      capturedAt: snapshot.captured_at,
    });
  }
  const current = await buildRoadmapLeaderboard(env, stub, builders);
  return buildLeaderboardMessage(current, userId, { label: selection.label, archived: false });
}

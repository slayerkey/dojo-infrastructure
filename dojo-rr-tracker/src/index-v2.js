import BaseRRTracker from "./index.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export default class RRTrackerV2 extends BaseRRTracker {
  async syncDiscordUser(discordUserId) {
    const env = this.env;
    await ensureEnhancementSchema(env.DB);

    let before = null;
    try {
      before = await super.getDiscordUserStats(discordUserId);
    } catch {
      before = null;
    }

    const result = await super.syncDiscordUser(discordUserId);
    if (!result?.ok) return result;

    const beforeMonthly = before?.ok
      ? Number(before.monthly_rr || 0)
      : Number(result.monthly_rr || 0);
    const afterMonthly = Number(result.monthly_rr || 0);
    const rrDelta = afterMonthly - beforeMonthly;
    const newMatches = Number(result.new_matches_imported || 0);

    await env.DB.prepare(
      "INSERT INTO rr_sync_events (discord_user_id, synced_at, rr_delta, new_matches) VALUES (?, datetime('now'), ?, ?)",
    )
      .bind(String(discordUserId), rrDelta, newMatches)
      .run();

    return {
      ...result,
      sync_rr_change: rrDelta,
      sync_new_matches: newMatches,
    };
  }

  async getDiscordUserStatsDetailed(discordUserId) {
    const env = this.env;
    await ensureEnhancementSchema(env.DB);

    const base = await super.getDiscordUserStats(discordUserId);
    if (!base?.ok) return base;

    const discordId = String(discordUserId);
    const link = await env.DB.prepare(
      "SELECT l.player_id, p.last_synced_at FROM dojo_riot_links l JOIN players p ON p.id = l.player_id WHERE l.discord_user_id = ?",
    )
      .bind(discordId)
      .first();

    if (!link?.player_id) return base;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const recentStart = new Date(now.getTime() - 12 * HOUR_MS);

    const [recent, dailyResult, firstTracked, lastSync] = await Promise.all([
      env.DB.prepare(
        "SELECT COALESCE(SUM(rr_change), 0) AS rr, COUNT(*) AS games FROM rr_matches WHERE player_id = ? AND game_timestamp >= ? AND game_timestamp <= ?",
      )
        .bind(link.player_id, recentStart.toISOString(), now.toISOString())
        .first(),
      env.DB.prepare(
        "SELECT substr(game_timestamp, 1, 10) AS day, COUNT(*) AS games, COALESCE(SUM(rr_change), 0) AS rr FROM rr_matches WHERE player_id = ? AND game_timestamp >= ? AND game_timestamp < ? GROUP BY substr(game_timestamp, 1, 10) ORDER BY day ASC",
      )
        .bind(link.player_id, monthStart.toISOString(), monthEnd.toISOString())
        .all(),
      env.DB.prepare(
        "SELECT MIN(game_timestamp) AS first_at FROM rr_matches WHERE player_id = ?",
      )
        .bind(link.player_id)
        .first(),
      env.DB.prepare(
        "SELECT synced_at, rr_delta, new_matches FROM rr_sync_events WHERE discord_user_id = ? ORDER BY id DESC LIMIT 1",
      )
        .bind(discordId)
        .first(),
    ]);

    const dailyRows = (dailyResult?.results || []).map((row) => ({
      day: String(row.day),
      games: Number(row.games || 0),
      rr: Number(row.rr || 0),
    }));

    const daysInMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const byDay = new Map(dailyRows.map((row) => [row.day, row]));
    const activity = [];

    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const row = byDay.get(key);
      activity.push({
        day,
        date: key,
        games: row?.games || 0,
        rr: row?.rr || 0,
      });
    }

    const firstTrackedAt = firstTracked?.first_at || base.history_start_at || null;
    const trackingDays = firstTrackedAt
      ? Math.max(
          1,
          Math.floor((now.getTime() - parseUtc(firstTrackedAt).getTime()) / DAY_MS) + 1,
        )
      : 0;

    return {
      ...base,
      recent_12h_rr: Number(recent?.rr || 0),
      recent_12h_games: Number(recent?.games || 0),
      active_days: dailyRows.length,
      tracking_days: trackingDays,
      current_streak: calculateCurrentStreak(dailyRows.map((row) => row.day), now),
      activity,
      first_tracked_at: firstTrackedAt,
      last_sync: lastSync
        ? {
            synced_at: lastSync.synced_at,
            rr_delta: Number(lastSync.rr_delta || 0),
            new_matches: Number(lastSync.new_matches || 0),
          }
        : null,
    };
  }
}

async function ensureEnhancementSchema(db) {
  if (!db) throw new Error("D1 binding DB is not configured");

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS rr_sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      rr_delta INTEGER NOT NULL DEFAULT 0,
      new_matches INTEGER NOT NULL DEFAULT 0
    )`,
  ).run();

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_rr_sync_events_user_time ON rr_sync_events(discord_user_id, id DESC)",
  ).run();
}

function calculateCurrentStreak(dayStrings, now) {
  if (!dayStrings.length) return 0;

  const played = new Set(dayStrings);
  let cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayKey = toDateKey(cursor);

  if (!played.has(todayKey)) {
    cursor = new Date(cursor.getTime() - DAY_MS);
    if (!played.has(toDateKey(cursor))) return 0;
  }

  let streak = 0;
  while (played.has(toDateKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }

  return streak;
}

function toDateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseUtc(value) {
  const text = String(value || "");
  const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

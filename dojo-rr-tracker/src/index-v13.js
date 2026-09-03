import RRTrackerV12 from "./index-v12.js";

export default class RRTrackerV13 extends RRTrackerV12 {
  async linkRiot(discordUserId, riotId, requestedRegion = "na") {
    const normalized = normalizeRiotIdInput(riotId);
    if (!normalized) {
      return {
        ok: false,
        code: "INVALID_RIOT_ID",
        message: "Use your Riot ID in the format Name#Tag.",
      };
    }
    return super.linkRiot(discordUserId, normalized, requestedRegion);
  }

  async getLeaderboardSnapshot(viewerDiscordUserId = null) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };

    const month = currentMonthWindow();
    const snapshot = await getPeriodLeaderboard(db, {
      start: month.start,
      end: month.end,
      key: month.key,
      label: month.label,
      viewerDiscordUserId,
      period: "month",
    });

    const previous = previousMonthWindow();
    snapshot.previous_month = previous.label;
    snapshot.previous_month_champion = await getPeriodChampion(db, previous.start, previous.end);
    return snapshot;
  }

  async getYearLeaderboardSnapshot(viewerDiscordUserId = null) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };

    const year = currentYearWindow();
    return getPeriodLeaderboard(db, {
      start: year.start,
      end: year.end,
      key: year.key,
      label: year.label,
      viewerDiscordUserId,
      period: "year",
    });
  }
}

async function getPeriodLeaderboard(db, {
  start,
  end,
  key,
  label,
  viewerDiscordUserId,
  period,
}) {
  const viewerId = String(viewerDiscordUserId || "");
  const isMonth = period === "month";

  const rows = await db.prepare(
    `WITH period_totals AS (
       SELECT player_id,
              COALESCE(SUM(rr_change), 0) AS period_rr,
              COUNT(*) AS games_counted
       FROM rr_matches
       WHERE game_timestamp >= ? AND game_timestamp < ?
       GROUP BY player_id
     ),
     latest_ranked AS (
       SELECT player_id,
              rank_name,
              rr_after,
              game_timestamp,
              ROW_NUMBER() OVER (
                PARTITION BY player_id
                ORDER BY game_timestamp DESC
              ) AS rn
       FROM rr_matches
       WHERE rank_name IS NOT NULL
     ),
     latest AS (
       SELECT player_id, rank_name, rr_after, game_timestamp
       FROM latest_ranked
       WHERE rn = 1
     ),
     pre_period_ranked AS (
       SELECT player_id,
              rank_name,
              rr_after,
              game_timestamp,
              ROW_NUMBER() OVER (
                PARTITION BY player_id
                ORDER BY game_timestamp DESC
              ) AS rn
       FROM rr_matches
       WHERE rank_name IS NOT NULL
         AND game_timestamp < ?
     ),
     pre_period AS (
       SELECT player_id, rank_name, rr_after, game_timestamp
       FROM pre_period_ranked
       WHERE rn = 1
     ),
     period_scored AS (
       SELECT player_id,
              rank_name,
              rr_after,
              game_timestamp,
              CASE LOWER(TRIM(rank_name))
                WHEN 'iron 1' THEN 1
                WHEN 'iron 2' THEN 2
                WHEN 'iron 3' THEN 3
                WHEN 'bronze 1' THEN 4
                WHEN 'bronze 2' THEN 5
                WHEN 'bronze 3' THEN 6
                WHEN 'silver 1' THEN 7
                WHEN 'silver 2' THEN 8
                WHEN 'silver 3' THEN 9
                WHEN 'gold 1' THEN 10
                WHEN 'gold 2' THEN 11
                WHEN 'gold 3' THEN 12
                WHEN 'platinum 1' THEN 13
                WHEN 'platinum 2' THEN 14
                WHEN 'platinum 3' THEN 15
                WHEN 'diamond 1' THEN 16
                WHEN 'diamond 2' THEN 17
                WHEN 'diamond 3' THEN 18
                WHEN 'ascendant 1' THEN 19
                WHEN 'ascendant 2' THEN 20
                WHEN 'ascendant 3' THEN 21
                WHEN 'immortal 1' THEN 22
                WHEN 'immortal 2' THEN 23
                WHEN 'immortal 3' THEN 24
                WHEN 'radiant' THEN 25
                ELSE 0
              END AS rank_score
       FROM rr_matches
       WHERE rank_name IS NOT NULL
         AND game_timestamp >= ?
         AND game_timestamp < ?
     ),
     period_ranked AS (
       SELECT player_id,
              rank_name,
              rr_after,
              game_timestamp,
              rank_score,
              ROW_NUMBER() OVER (
                PARTITION BY player_id
                ORDER BY game_timestamp ASC
              ) AS start_rn,
              ROW_NUMBER() OVER (
                PARTITION BY player_id
                ORDER BY rank_score DESC,
                         COALESCE(rr_after, -1) DESC,
                         game_timestamp ASC
              ) AS peak_rn
       FROM period_scored
     ),
     period_start AS (
       SELECT player_id, rank_name, rr_after, game_timestamp
       FROM period_ranked
       WHERE start_rn = 1
     ),
     period_peak AS (
       SELECT player_id, rank_name, rr_after, game_timestamp
       FROM period_ranked
       WHERE peak_rn = 1
     ),
     ranked AS (
       SELECT l.discord_user_id,
              l.player_id,
              p.riot_name,
              p.riot_tag,
              COALESCE(t.period_rr, 0) AS period_rr,
              COALESCE(t.games_counted, 0) AS games_counted,
              latest.rank_name AS current_rank,
              latest.rr_after AS current_rr,
              CASE
                WHEN ? = 'month' THEN COALESCE(ms.history_complete, 0)
                WHEN pre_period.rank_name IS NOT NULL THEN 1
                ELSE 0
              END AS history_complete,
              COALESCE(pre_period.rank_name, period_start.rank_name) AS start_rank,
              COALESCE(pre_period.rr_after, period_start.rr_after) AS start_rr,
              COALESCE(pre_period.game_timestamp, period_start.game_timestamp) AS start_rank_at,
              CASE
                WHEN pre_period.rank_name IS NOT NULL THEN 'pre_period_snapshot'
                WHEN period_start.rank_name IS NOT NULL THEN 'first_period_match'
                ELSE NULL
              END AS start_rank_source,
              period_peak.rank_name AS peak_rank,
              period_peak.rr_after AS peak_rr,
              period_peak.game_timestamp AS peak_rank_at,
              ROW_NUMBER() OVER (
                ORDER BY COALESCE(t.period_rr, 0) DESC,
                         COALESCE(t.games_counted, 0) DESC,
                         p.riot_name COLLATE NOCASE ASC
              ) AS position,
              COUNT(*) OVER () AS total_players
       FROM dojo_riot_links l
       JOIN dojo_members dm
         ON dm.discord_user_id = l.discord_user_id
       JOIN players p ON p.id = l.player_id
       LEFT JOIN period_totals t ON t.player_id = l.player_id
       LEFT JOIN latest ON latest.player_id = l.player_id
       LEFT JOIN pre_period ON pre_period.player_id = l.player_id
       LEFT JOIN period_start ON period_start.player_id = l.player_id
       LEFT JOIN period_peak ON period_peak.player_id = l.player_id
       LEFT JOIN player_month_state ms
         ON ? = 'month'
        AND ms.player_id = l.player_id
        AND ms.month_key = ?
       WHERE dm.active = 1 OR t.player_id IS NOT NULL
     )
     SELECT *
     FROM ranked
     ORDER BY position ASC`,
  )
    .bind(
      start.toISOString(),
      end.toISOString(),
      start.toISOString(),
      start.toISOString(),
      end.toISOString(),
      period,
      period,
      isMonth ? key : "",
    )
    .all();

  const entries = (rows.results || []).map((row) => ({
    position: Number(row.position || 0),
    discord_user_id: String(row.discord_user_id),
    riot_id: `${row.riot_name}#${row.riot_tag}`,
    period_rr: Number(row.period_rr || 0),
    monthly_rr: isMonth ? Number(row.period_rr || 0) : undefined,
    yearly_rr: isMonth ? undefined : Number(row.period_rr || 0),
    games_counted: Number(row.games_counted || 0),
    current_rank: row.current_rank || null,
    current_rr: row.current_rr == null ? null : Number(row.current_rr),
    history_complete: Boolean(row.history_complete),
    start_rank: row.start_rank || null,
    start_rr: row.start_rr == null ? null : Number(row.start_rr),
    start_rank_at: row.start_rank_at || null,
    start_rank_source: row.start_rank_source || null,
    peak_rank: row.peak_rank || null,
    peak_rr: row.peak_rr == null ? null : Number(row.peak_rr),
    peak_rank_at: row.peak_rank_at || null,
  }));

  const viewerEntry = viewerId
    ? entries.find((entry) => entry.discord_user_id === viewerId)
    : null;

  return {
    ok: true,
    period,
    label,
    month: isMonth ? label : undefined,
    year: isMonth ? undefined : label,
    total_players: entries.length,
    viewer_position: viewerEntry?.position || null,
    entries,
    snapshot_at: new Date().toISOString(),
  };
}

async function getPeriodChampion(db, start, end) {
  try {
    const champion = await db.prepare(
      `WITH period_totals AS (
         SELECT player_id,
                COALESCE(SUM(rr_change), 0) AS period_rr,
                COUNT(*) AS games_counted
         FROM rr_matches
         WHERE game_timestamp >= ? AND game_timestamp < ?
         GROUP BY player_id
       )
       SELECT l.discord_user_id,
              p.riot_name,
              p.riot_tag,
              pt.period_rr,
              pt.games_counted
       FROM period_totals pt
       JOIN dojo_riot_links l ON l.player_id = pt.player_id
       JOIN players p ON p.id = pt.player_id
       ORDER BY pt.period_rr DESC,
                pt.games_counted DESC,
                p.riot_name COLLATE NOCASE ASC
       LIMIT 1`,
    )
      .bind(start.toISOString(), end.toISOString())
      .first();

    if (!champion) return null;
    return {
      discord_user_id: String(champion.discord_user_id),
      riot_id: `${champion.riot_name}#${champion.riot_tag}`,
      monthly_rr: Number(champion.period_rr || 0),
      games_counted: Number(champion.games_counted || 0),
    };
  } catch (error) {
    console.warn("Could not load historical period champion:", error);
    return null;
  }
}

function normalizeRiotIdInput(riotId) {
  const value = String(riotId || "").trim();
  const separator = value.indexOf("#");
  if (separator <= 0) return null;
  const name = value.slice(0, separator).trim();
  const tag = value.slice(separator + 1).replace(/^#+/, "").trim();
  if (!name || !tag) return null;
  return `${name}#${tag}`;
}

function currentMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    start,
    end,
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    label: start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

function previousMonthWindow(now = new Date()) {
  const current = currentMonthWindow(now);
  const start = new Date(Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1));
  return {
    start,
    end: current.start,
    label: start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

function currentYearWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year + 1, 0, 1)),
    key: String(year),
    label: String(year),
  };
}

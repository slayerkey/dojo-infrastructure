import RRTrackerV11 from "./index-v11.js";

export default class RRTrackerV12 extends RRTrackerV11 {
  async getLeaderboardSnapshot(viewerDiscordUserId = null) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };

    const month = currentMonthWindow();
    const viewerId = String(viewerDiscordUserId || "");

    const rows = await db.prepare(
      `WITH monthly AS (
         SELECT player_id,
                COALESCE(SUM(rr_change), 0) AS monthly_rr,
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
       pre_month_ranked AS (
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
       pre_month AS (
         SELECT player_id, rank_name, rr_after, game_timestamp
         FROM pre_month_ranked
         WHERE rn = 1
       ),
       month_scored AS (
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
       month_ranked AS (
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
         FROM month_scored
       ),
       month_start AS (
         SELECT player_id, rank_name, rr_after, game_timestamp
         FROM month_ranked
         WHERE start_rn = 1
       ),
       month_peak AS (
         SELECT player_id, rank_name, rr_after, game_timestamp
         FROM month_ranked
         WHERE peak_rn = 1
       ),
       ranked AS (
         SELECT l.discord_user_id,
                l.player_id,
                p.riot_name,
                p.riot_tag,
                COALESCE(m.monthly_rr, 0) AS monthly_rr,
                COALESCE(m.games_counted, 0) AS games_counted,
                latest.rank_name AS current_rank,
                latest.rr_after AS current_rr,
                COALESCE(s.history_complete, 0) AS history_complete,
                COALESCE(pre_month.rank_name, month_start.rank_name) AS start_rank,
                COALESCE(pre_month.rr_after, month_start.rr_after) AS start_rr,
                COALESCE(pre_month.game_timestamp, month_start.game_timestamp) AS start_rank_at,
                CASE
                  WHEN pre_month.rank_name IS NOT NULL THEN 'pre_month_snapshot'
                  WHEN month_start.rank_name IS NOT NULL THEN 'first_month_match'
                  ELSE NULL
                END AS start_rank_source,
                month_peak.rank_name AS peak_rank,
                month_peak.rr_after AS peak_rr,
                month_peak.game_timestamp AS peak_rank_at,
                ROW_NUMBER() OVER (
                  ORDER BY COALESCE(m.monthly_rr, 0) DESC,
                           COALESCE(m.games_counted, 0) DESC,
                           p.riot_name COLLATE NOCASE ASC
                ) AS position,
                COUNT(*) OVER () AS total_players
         FROM dojo_riot_links l
         JOIN dojo_members dm
           ON dm.discord_user_id = l.discord_user_id
          AND dm.active = 1
         JOIN players p ON p.id = l.player_id
         LEFT JOIN monthly m ON m.player_id = l.player_id
         LEFT JOIN latest ON latest.player_id = l.player_id
         LEFT JOIN pre_month ON pre_month.player_id = l.player_id
         LEFT JOIN month_start ON month_start.player_id = l.player_id
         LEFT JOIN month_peak ON month_peak.player_id = l.player_id
         LEFT JOIN player_month_state s
           ON s.player_id = l.player_id
          AND s.month_key = ?
       )
       SELECT *
       FROM ranked
       ORDER BY position ASC`,
    )
      .bind(
        month.start.toISOString(),
        month.end.toISOString(),
        month.start.toISOString(),
        month.start.toISOString(),
        month.end.toISOString(),
        month.key,
      )
      .all();

    const entries = (rows.results || []).map((row) => ({
      position: Number(row.position || 0),
      discord_user_id: String(row.discord_user_id),
      riot_id: `${row.riot_name}#${row.riot_tag}`,
      monthly_rr: Number(row.monthly_rr || 0),
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

    const totalPlayers = entries.length
      ? Number(rows.results?.[0]?.total_players || entries.length)
      : 0;
    const viewerEntry = viewerId
      ? entries.find((entry) => entry.discord_user_id === viewerId)
      : null;

    const previous = previousMonthWindow();
    let previousMonthChampion = null;
    try {
      const champion = await db.prepare(
        `WITH previous_month AS (
           SELECT player_id,
                  COALESCE(SUM(rr_change), 0) AS monthly_rr,
                  COUNT(*) AS games_counted
           FROM rr_matches
           WHERE game_timestamp >= ? AND game_timestamp < ?
           GROUP BY player_id
         )
         SELECT l.discord_user_id,
                p.riot_name,
                p.riot_tag,
                pm.monthly_rr,
                pm.games_counted
         FROM previous_month pm
         JOIN dojo_riot_links l ON l.player_id = pm.player_id
         JOIN dojo_members dm
           ON dm.discord_user_id = l.discord_user_id
          AND dm.active = 1
         JOIN players p ON p.id = pm.player_id
         ORDER BY pm.monthly_rr DESC,
                  pm.games_counted DESC,
                  p.riot_name COLLATE NOCASE ASC
         LIMIT 1`,
      )
        .bind(previous.start.toISOString(), previous.end.toISOString())
        .first();

      if (champion) {
        previousMonthChampion = {
          discord_user_id: String(champion.discord_user_id),
          riot_id: `${champion.riot_name}#${champion.riot_tag}`,
          monthly_rr: Number(champion.monthly_rr || 0),
          games_counted: Number(champion.games_counted || 0),
        };
      }
    } catch (error) {
      console.warn("Could not load previous month champion for leaderboard snapshot:", error);
    }

    return {
      ok: true,
      month: month.label,
      total_players: totalPlayers,
      viewer_position: viewerEntry?.position || null,
      entries,
      previous_month: previous.label,
      previous_month_champion: previousMonthChampion,
      snapshot_at: new Date().toISOString(),
    };
  }
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
  const start = new Date(
    Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1),
  );
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

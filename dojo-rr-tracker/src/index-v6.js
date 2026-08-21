import RRTrackerV5 from "./index-v5.js";

export default class RRTrackerV6 extends RRTrackerV5 {
  async getLeaderboard(limit = 10) {
    const base = await super.getLeaderboard(limit);
    if (!base?.ok) return base;

    try {
      const previous = previousMonthWindow();
      const row = await this.env.DB.prepare(
        `WITH previous_month AS (
           SELECT player_id,
                  COALESCE(SUM(rr_change), 0) AS monthly_rr,
                  COUNT(*) AS games_counted
           FROM rr_matches
           WHERE game_timestamp >= ? AND game_timestamp < ?
           GROUP BY player_id
         ), latest_time AS (
           SELECT player_id, MAX(game_timestamp) AS game_timestamp
           FROM rr_matches
           WHERE game_timestamp < ?
           GROUP BY player_id
         ), latest AS (
           SELECT r.player_id, r.rank_name, r.rr_after
           FROM rr_matches r
           JOIN latest_time t
             ON t.player_id = r.player_id
            AND t.game_timestamp = r.game_timestamp
         )
         SELECT l.discord_user_id,
                p.riot_name,
                p.riot_tag,
                pm.monthly_rr,
                pm.games_counted,
                latest.rank_name AS ending_rank,
                latest.rr_after AS ending_rr
         FROM previous_month pm
         JOIN dojo_riot_links l ON l.player_id = pm.player_id
         JOIN dojo_members dm
           ON dm.discord_user_id = l.discord_user_id
          AND dm.active = 1
         JOIN players p ON p.id = pm.player_id
         LEFT JOIN latest ON latest.player_id = pm.player_id
         ORDER BY pm.monthly_rr DESC,
                  pm.games_counted DESC,
                  p.riot_name COLLATE NOCASE ASC
         LIMIT 1`,
      )
        .bind(
          previous.start.toISOString(),
          previous.end.toISOString(),
          previous.end.toISOString(),
        )
        .first();

      return {
        ...base,
        previous_month: previous.label,
        previous_month_champion: row
          ? {
              discord_user_id: String(row.discord_user_id),
              riot_id: `${row.riot_name}#${row.riot_tag}`,
              monthly_rr: Number(row.monthly_rr || 0),
              games_counted: Number(row.games_counted || 0),
              ending_rank: row.ending_rank || null,
              ending_rr: row.ending_rr == null ? null : Number(row.ending_rr),
            }
          : null,
      };
    } catch (error) {
      console.warn("Could not load previous month champion:", error);
      return {
        ...base,
        previous_month: previousMonthWindow().label,
        previous_month_champion: null,
      };
    }
  }
}

function previousMonthWindow(now = new Date()) {
  const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousStart = new Date(
    Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - 1, 1),
  );

  return {
    start: previousStart,
    end: currentStart,
    label: previousStart.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

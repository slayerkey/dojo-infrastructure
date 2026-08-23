import RRTrackerV10 from "./index-v10.js";

const RANK_ORDER = new Map([
  ["iron 1", 1], ["iron 2", 2], ["iron 3", 3],
  ["bronze 1", 4], ["bronze 2", 5], ["bronze 3", 6],
  ["silver 1", 7], ["silver 2", 8], ["silver 3", 9],
  ["gold 1", 10], ["gold 2", 11], ["gold 3", 12],
  ["platinum 1", 13], ["platinum 2", 14], ["platinum 3", 15],
  ["diamond 1", 16], ["diamond 2", 17], ["diamond 3", 18],
  ["ascendant 1", 19], ["ascendant 2", 20], ["ascendant 3", 21],
  ["immortal 1", 22], ["immortal 2", 23], ["immortal 3", 24],
  ["radiant", 25],
]);

export default class RRTrackerV11 extends RRTrackerV10 {
  async getLeaderboardPage(page = 1, pageSize = 5, viewerDiscordUserId = null, jumpToViewer = false) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };

    const size = Math.min(Math.max(Number(pageSize) || 5, 1), 10);
    const month = currentMonthWindow();
    const viewerId = String(viewerDiscordUserId || "");

    const meta = await db.prepare(
      `WITH monthly AS (
         SELECT player_id,
                COALESCE(SUM(rr_change), 0) AS monthly_rr,
                COUNT(*) AS games_counted
         FROM rr_matches
         WHERE game_timestamp >= ? AND game_timestamp < ?
         GROUP BY player_id
       ), ranked AS (
         SELECT l.discord_user_id,
                ROW_NUMBER() OVER (
                  ORDER BY COALESCE(m.monthly_rr, 0) DESC,
                           COALESCE(m.games_counted, 0) DESC,
                           p.riot_name COLLATE NOCASE ASC
                ) AS position,
                COUNT(*) OVER () AS total_players
         FROM dojo_riot_links l
         JOIN dojo_members dm
           ON dm.discord_user_id = l.discord_user_id AND dm.active = 1
         JOIN players p ON p.id = l.player_id
         LEFT JOIN monthly m ON m.player_id = l.player_id
       )
       SELECT COALESCE(MAX(total_players), 0) AS total_players,
              MAX(CASE WHEN discord_user_id = ? THEN position END) AS viewer_position
       FROM ranked`,
    )
      .bind(month.start.toISOString(), month.end.toISOString(), viewerId)
      .first();

    const totalPlayers = Number(meta?.total_players || 0);
    const viewerPosition = meta?.viewer_position == null ? null : Number(meta.viewer_position);
    const totalPages = Math.max(1, Math.ceil(totalPlayers / size));

    let selectedPage = Math.max(1, Number(page) || 1);
    if (jumpToViewer && viewerPosition) {
      selectedPage = Math.ceil(viewerPosition / size);
    }
    selectedPage = Math.min(selectedPage, totalPages);
    const offset = (selectedPage - 1) * size;

    const rows = await db.prepare(
      `WITH monthly AS (
         SELECT player_id,
                COALESCE(SUM(rr_change), 0) AS monthly_rr,
                COUNT(*) AS games_counted
         FROM rr_matches
         WHERE game_timestamp >= ? AND game_timestamp < ?
         GROUP BY player_id
       ), latest_time AS (
         SELECT player_id, MAX(game_timestamp) AS game_timestamp
         FROM rr_matches
         GROUP BY player_id
       ), latest AS (
         SELECT r.player_id, r.rank_name, r.rr_after
         FROM rr_matches r
         JOIN latest_time t
           ON t.player_id = r.player_id
          AND t.game_timestamp = r.game_timestamp
       )
       SELECT l.discord_user_id,
              l.player_id,
              p.riot_name,
              p.riot_tag,
              COALESCE(m.monthly_rr, 0) AS monthly_rr,
              COALESCE(m.games_counted, 0) AS games_counted,
              latest.rank_name AS current_rank,
              latest.rr_after AS current_rr,
              COALESCE(s.history_complete, 0) AS history_complete
       FROM dojo_riot_links l
       JOIN dojo_members dm
         ON dm.discord_user_id = l.discord_user_id AND dm.active = 1
       JOIN players p ON p.id = l.player_id
       LEFT JOIN monthly m ON m.player_id = l.player_id
       LEFT JOIN latest ON latest.player_id = l.player_id
       LEFT JOIN player_month_state s
         ON s.player_id = l.player_id AND s.month_key = ?
       ORDER BY monthly_rr DESC,
                games_counted DESC,
                p.riot_name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`,
    )
      .bind(
        month.start.toISOString(),
        month.end.toISOString(),
        month.key,
        size,
        offset,
      )
      .all();

    const entries = await Promise.all((rows.results || []).map(async (row, index) => {
      const progression = await getMonthlyProgression(
        db,
        String(row.player_id),
        month.start.toISOString(),
        month.end.toISOString(),
      );

      return {
        position: offset + index + 1,
        discord_user_id: String(row.discord_user_id),
        riot_id: `${row.riot_name}#${row.riot_tag}`,
        monthly_rr: Number(row.monthly_rr || 0),
        games_counted: Number(row.games_counted || 0),
        current_rank: row.current_rank || null,
        current_rr: row.current_rr == null ? null : Number(row.current_rr),
        history_complete: Boolean(row.history_complete),
        start_rank: progression.start?.rank_name || null,
        start_rr: progression.start?.rr_after == null ? null : Number(progression.start.rr_after),
        start_rank_at: progression.start?.game_timestamp || null,
        start_rank_source: progression.startSource,
        peak_rank: progression.peak?.rank_name || null,
        peak_rr: progression.peak?.rr_after == null ? null : Number(progression.peak.rr_after),
        peak_rank_at: progression.peak?.game_timestamp || null,
      };
    }));

    let previousMonthChampion = null;
    let previousMonth = previousMonthWindow().label;
    if (selectedPage === 1) {
      const previous = previousMonthWindow();
      previousMonth = previous.label;
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
             ON dm.discord_user_id = l.discord_user_id AND dm.active = 1
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
        console.warn("Could not load previous month champion for paginated leaderboard:", error);
      }
    }

    return {
      ok: true,
      month: month.label,
      page: selectedPage,
      page_size: size,
      total_pages: totalPages,
      total_players: totalPlayers,
      viewer_position: viewerPosition,
      viewer_page: viewerPosition ? Math.ceil(viewerPosition / size) : null,
      entries,
      previous_month: previousMonth,
      previous_month_champion: previousMonthChampion,
    };
  }
}

async function getMonthlyProgression(db, playerId, monthStart, monthEnd) {
  const [beforeMonth, monthRowsResult] = await Promise.all([
    db.prepare(
      `SELECT rank_name, rr_after, game_timestamp
       FROM rr_matches
       WHERE player_id = ?
         AND rank_name IS NOT NULL
         AND game_timestamp < ?
       ORDER BY game_timestamp DESC
       LIMIT 1`,
    )
      .bind(playerId, monthStart)
      .first(),
    db.prepare(
      `SELECT rank_name, rr_after, game_timestamp
       FROM rr_matches
       WHERE player_id = ?
         AND rank_name IS NOT NULL
         AND game_timestamp >= ?
         AND game_timestamp < ?
       ORDER BY game_timestamp ASC`,
    )
      .bind(playerId, monthStart, monthEnd)
      .all(),
  ]);

  const monthRows = monthRowsResult?.results || [];
  const start = beforeMonth?.rank_name
    ? beforeMonth
    : monthRows[0]?.rank_name
      ? monthRows[0]
      : null;

  let peak = null;
  for (const row of monthRows) {
    const score = rankScore(row.rank_name);
    if (!score) continue;
    const rr = row.rr_after == null ? -1 : Number(row.rr_after);
    if (!peak) {
      peak = { ...row, score };
      continue;
    }
    const peakRr = peak.rr_after == null ? -1 : Number(peak.rr_after);
    if (score > peak.score || (score === peak.score && rr > peakRr)) {
      peak = { ...row, score };
    }
  }

  return {
    start,
    startSource: beforeMonth?.rank_name ? "pre_month_snapshot" : (start ? "first_month_match" : null),
    peak,
  };
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

function rankScore(rankName) {
  return RANK_ORDER.get(String(rankName || "").trim().toLowerCase()) || 0;
}

import RRTrackerV8 from "./index-v8.js";

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

export default class RRTrackerV9 extends RRTrackerV8 {
  async getLeaderboard(limit = 10) {
    const base = await super.getLeaderboard(limit);
    if (!base?.ok || !Array.isArray(base.entries)) return base;

    const { start, end } = currentMonthWindow();
    const entries = [];

    for (const entry of base.entries) {
      try {
        const link = await getPlayerLink(this.env.DB, entry.discord_user_id);
        if (!link?.player_id) {
          entries.push(entry);
          continue;
        }

        const progression = await getMonthlyProgression(
          this.env.DB,
          link.player_id,
          start.toISOString(),
          end.toISOString(),
        );

        entries.push({
          ...entry,
          // The leaderboard is a monthly competition, so its transformation line
          // resets automatically each month. Personal /rr keeps the all-time
          // lowest tracked -> all-time peak view from V8/V7.
          start_rank: progression.start?.rank_name || entry.current_rank || null,
          start_rr:
            progression.start?.rr_after == null
              ? (entry.current_rr == null ? null : Number(entry.current_rr))
              : Number(progression.start.rr_after),
          start_rank_at: progression.start?.game_timestamp || null,
          start_rank_source: progression.start?.source || "monthly_start",
          peak_rank: progression.peak?.rank_name || entry.current_rank || null,
          peak_rr:
            progression.peak?.rr_after == null
              ? (entry.current_rr == null ? null : Number(entry.current_rr))
              : Number(progression.peak.rr_after),
          peak_rank_at: progression.peak?.game_timestamp || null,
        });
      } catch (error) {
        console.warn(`Could not load monthly progression for ${entry.discord_user_id}:`, error);
        entries.push(entry);
      }
    }

    return { ...base, entries };
  }
}

async function getPlayerLink(db, discordUserId) {
  return db.prepare(
    "SELECT player_id FROM dojo_riot_links WHERE discord_user_id = ?",
  )
    .bind(String(discordUserId))
    .first();
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

  // Best possible month baseline:
  // 1) their last recorded rank before the month began, if we have it;
  // 2) otherwise their first recorded rank inside the month.
  const start = beforeMonth?.rank_name
    ? { ...beforeMonth, source: "pre_month_snapshot" }
    : monthRows[0]?.rank_name
      ? { ...monthRows[0], source: "first_month_match" }
      : null;

  let peak = start ? { ...start, score: rankScore(start.rank_name) } : null;
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

  return { start, peak };
}

function currentMonthWindow(now = new Date()) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function rankScore(rankName) {
  return RANK_ORDER.get(String(rankName || "").trim().toLowerCase()) || 0;
}

import RRTrackerV7 from "./index-v7.js";

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

export default class RRTrackerV8 extends RRTrackerV7 {
  async getDiscordUserStatsDetailed(discordUserId) {
    const base = await super.getDiscordUserStatsDetailed(discordUserId);
    if (!base?.ok) return base;

    try {
      const link = await getPlayerLink(this.env.DB, discordUserId);
      if (!link?.player_id) return base;

      // "Start rank" now represents the lowest competitive rank we have actually
      // observed for the account in stored RR history. This makes late links more
      // representative of the tracked improvement window instead of freezing the
      // baseline at whatever rank the player happened to have when they linked.
      const low = await getLowestTrackedRank(this.env.DB, link.player_id);
      if (!low?.rank_name) return base;

      return {
        ...base,
        start_rank: low.rank_name,
        start_rr: low.rr_after == null ? null : Number(low.rr_after),
        start_rank_at: low.game_timestamp || null,
        start_rank_source: "lowest_tracked",
      };
    } catch (error) {
      console.warn("Could not load lowest tracked start rank:", error);
      return base;
    }
  }

  async getLeaderboard(limit = 10) {
    const base = await super.getLeaderboard(limit);
    if (!base?.ok || !Array.isArray(base.entries)) return base;

    const entries = [];
    for (const entry of base.entries) {
      try {
        const link = await getPlayerLink(this.env.DB, entry.discord_user_id);
        if (!link?.player_id) {
          entries.push(entry);
          continue;
        }

        const low = await getLowestTrackedRank(this.env.DB, link.player_id);
        entries.push({
          ...entry,
          start_rank: low?.rank_name || entry.start_rank || entry.current_rank || null,
          start_rr:
            low?.rr_after == null
              ? (entry.start_rr == null ? (entry.current_rr == null ? null : Number(entry.current_rr)) : Number(entry.start_rr))
              : Number(low.rr_after),
          start_rank_at: low?.game_timestamp || entry.start_rank_at || null,
          start_rank_source: low?.rank_name ? "lowest_tracked" : (entry.start_rank_source || null),
        });
      } catch (error) {
        console.warn(`Could not load lowest tracked rank for ${entry.discord_user_id}:`, error);
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

async function getLowestTrackedRank(db, playerId) {
  const rows = await db.prepare(
    `SELECT rank_name, rr_after, game_timestamp
     FROM rr_matches
     WHERE player_id = ? AND rank_name IS NOT NULL
     ORDER BY game_timestamp ASC`,
  )
    .bind(playerId)
    .all();

  let lowest = null;
  for (const row of rows.results || []) {
    const score = rankScore(row.rank_name);
    if (!score) continue;
    const rr = row.rr_after == null ? Number.POSITIVE_INFINITY : Number(row.rr_after);

    if (!lowest) {
      lowest = { ...row, score };
      continue;
    }

    const lowestRr = lowest.rr_after == null
      ? Number.POSITIVE_INFINITY
      : Number(lowest.rr_after);

    if (score < lowest.score || (score === lowest.score && rr < lowestRr)) {
      lowest = { ...row, score };
    }
  }

  return lowest;
}

function rankScore(rankName) {
  return RANK_ORDER.get(String(rankName || "").trim().toLowerCase()) || 0;
}

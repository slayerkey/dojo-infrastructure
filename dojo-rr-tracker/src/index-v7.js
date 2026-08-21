import RRTrackerV6 from "./index-v6.js";

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

export default class RRTrackerV7 extends RRTrackerV6 {
  async getDiscordUserStatsDetailed(discordUserId) {
    const base = await super.getDiscordUserStatsDetailed(discordUserId);
    if (!base?.ok) return base;

    try {
      const link = await getPlayerLink(this.env.DB, discordUserId);
      if (!link?.player_id) return base;

      // Start rank is still the first manual /sync baseline. Peak tracked is the
      // highest competitive rank in all match history we have stored for the
      // linked account, matching the original tracker behavior.
      const peak = await getPeakTrackedRank(this.env.DB, link.player_id);

      return {
        ...base,
        peak_rank: peak?.rank_name || base.current_rank || null,
        peak_rr:
          peak?.rr_after == null
            ? (base.current_rr == null ? null : Number(base.current_rr))
            : Number(peak.rr_after),
        peak_rank_at: peak?.game_timestamp || null,
      };
    } catch (error) {
      console.warn("Could not load all tracked peak rank:", error);
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

        const [start, peak] = await Promise.all([
          this.env.DB.prepare(
            "SELECT start_rank_name, start_rr, started_at, source FROM player_start_rank WHERE player_id = ?",
          )
            .bind(link.player_id)
            .first(),
          getPeakTrackedRank(this.env.DB, link.player_id),
        ]);

        entries.push({
          ...entry,
          start_rank: start?.start_rank_name || null,
          start_rr: start?.start_rr == null ? null : Number(start.start_rr),
          start_rank_at: start?.started_at || null,
          start_rank_source: start?.source || null,
          peak_rank: peak?.rank_name || entry.current_rank || null,
          peak_rr:
            peak?.rr_after == null
              ? (entry.current_rr == null ? null : Number(entry.current_rr))
              : Number(peak.rr_after),
          peak_rank_at: peak?.game_timestamp || null,
        });
      } catch (error) {
        console.warn(`Could not enrich leaderboard entry ${entry.discord_user_id}:`, error);
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

async function getPeakTrackedRank(db, playerId) {
  const rows = await db.prepare(
    `SELECT rank_name, rr_after, game_timestamp
     FROM rr_matches
     WHERE player_id = ? AND rank_name IS NOT NULL
     ORDER BY game_timestamp ASC`,
  )
    .bind(playerId)
    .all();

  let best = null;
  for (const row of rows.results || []) {
    const score = rankScore(row.rank_name);
    const rr = row.rr_after == null ? -1 : Number(row.rr_after);

    if (!best) {
      best = { ...row, score };
      continue;
    }

    const bestRr = best.rr_after == null ? -1 : Number(best.rr_after);
    if (score > best.score || (score === best.score && rr > bestRr)) {
      best = { ...row, score };
    }
  }

  return best;
}

function rankScore(rankName) {
  return RANK_ORDER.get(String(rankName || "").toLowerCase()) || 0;
}

import RRTrackerV4 from "./index-v4.js";

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

export default class RRTrackerV5 extends RRTrackerV4 {
  async getDiscordUserStatsDetailed(discordUserId) {
    const base = await super.getDiscordUserStatsDetailed(discordUserId);
    if (!base?.ok) return base;

    try {
      const link = await this.env.DB.prepare(
        "SELECT player_id FROM dojo_riot_links WHERE discord_user_id = ?",
      )
        .bind(String(discordUserId))
        .first();

      if (!link?.player_id) return base;

      const startAt = normalizeTime(base.start_rank_at);
      const peak = await getPeakSinceStart(this.env.DB, link.player_id, startAt);

      return {
        ...base,
        peak_rank: peak?.rank_name || base.current_rank || null,
        peak_rr:
          peak?.rr_after == null
            ? (base.current_rr == null ? null : Number(base.current_rr))
            : Number(peak.rr_after),
        peak_rank_at: peak?.game_timestamp || base.start_rank_at || null,
      };
    } catch (error) {
      console.warn("Could not refine peak tracked rank:", error);
      return base;
    }
  }
}

async function getPeakSinceStart(db, playerId, startAt) {
  const query = startAt
    ? `SELECT rank_name, rr_after, game_timestamp
       FROM rr_matches
       WHERE player_id = ? AND rank_name IS NOT NULL AND game_timestamp >= ?
       ORDER BY game_timestamp ASC`
    : `SELECT rank_name, rr_after, game_timestamp
       FROM rr_matches
       WHERE player_id = ? AND rank_name IS NOT NULL
       ORDER BY game_timestamp ASC`;

  const statement = db.prepare(query);
  const rows = startAt
    ? await statement.bind(playerId, startAt).all()
    : await statement.bind(playerId).all();

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

function normalizeTime(value) {
  if (!value) return null;
  const text = String(value);
  if (text.includes("T")) return text;
  return `${text.replace(" ", "T")}Z`;
}

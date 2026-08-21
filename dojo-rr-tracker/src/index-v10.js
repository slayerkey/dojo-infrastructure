import RRTrackerV9 from "./index-v9.js";

export default class RRTrackerV10 extends RRTrackerV9 {
  async getLeaderboard(limit = 10) {
    const base = await super.getLeaderboard(limit);
    if (!base?.ok || !Array.isArray(base.entries)) return base;

    const monthStart = currentMonthStart().toISOString();
    const entries = [];

    for (const entry of base.entries) {
      try {
        const link = await this.env.DB.prepare(
          "SELECT player_id FROM dojo_riot_links WHERE discord_user_id = ?",
        )
          .bind(String(entry.discord_user_id))
          .first();

        if (!link?.player_id) {
          entries.push(entry);
          continue;
        }

        const beforeMonth = await this.env.DB.prepare(
          `SELECT rank_name, rr_after, game_timestamp
           FROM rr_matches
           WHERE player_id = ?
             AND rank_name IS NOT NULL
             AND game_timestamp < ?
           ORDER BY game_timestamp DESC
           LIMIT 1`,
        )
          .bind(link.player_id, monthStart)
          .first();

        if (!beforeMonth?.rank_name) {
          entries.push(entry);
          continue;
        }

        entries.push({
          ...entry,
          start_rank: beforeMonth.rank_name,
          start_rr: beforeMonth.rr_after == null ? null : Number(beforeMonth.rr_after),
          start_rank_at: beforeMonth.game_timestamp || null,
          start_rank_source: "pre_month_snapshot",
        });
      } catch (error) {
        console.warn(`Could not load pre-month baseline for ${entry.discord_user_id}:`, error);
        entries.push(entry);
      }
    }

    return { ...base, entries };
  }
}

function currentMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

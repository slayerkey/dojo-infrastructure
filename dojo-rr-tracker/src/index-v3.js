import RRTrackerV2 from "./index-v2.js";

export default class RRTrackerV3 extends RRTrackerV2 {
  async linkRiot(discordUserId, riotId, requestedRegion = "na") {
    const result = await super.linkRiot(discordUserId, riotId, requestedRegion);
    if (!result?.ok) return result;

    try {
      await ensureStartRankSchema(this.env.DB);
      const link = await getPlayerLink(this.env.DB, discordUserId);
      if (link?.player_id) {
        await this.env.DB.prepare(
          `INSERT OR IGNORE INTO player_start_rank
            (player_id, start_rank_name, start_rr, started_at, source)
           VALUES (?, ?, ?, datetime('now'), 'link')`,
        )
          .bind(
            link.player_id,
            result.current_rank || null,
            result.current_rr == null ? null : Number(result.current_rr),
          )
          .run();
      }
    } catch (error) {
      console.warn("Could not save starting rank:", error);
    }

    return result;
  }

  async getDiscordUserStatsDetailed(discordUserId) {
    const base = await super.getDiscordUserStatsDetailed(discordUserId);
    if (!base?.ok) return base;

    try {
      await ensureStartRankSchema(this.env.DB);
      const link = await getPlayerLink(this.env.DB, discordUserId);
      if (!link?.player_id) return base;

      let start = await this.env.DB.prepare(
        "SELECT start_rank_name, start_rr, started_at, source FROM player_start_rank WHERE player_id = ?",
      )
        .bind(link.player_id)
        .first();

      if (!start) {
        const earliest = await this.env.DB.prepare(
          `SELECT rank_name, rr_after, game_timestamp
           FROM rr_matches
           WHERE player_id = ?
           ORDER BY game_timestamp ASC
           LIMIT 1`,
        )
          .bind(link.player_id)
          .first();

        if (earliest) {
          await this.env.DB.prepare(
            `INSERT OR IGNORE INTO player_start_rank
              (player_id, start_rank_name, start_rr, started_at, source)
             VALUES (?, ?, ?, ?, 'earliest_tracked')`,
          )
            .bind(
              link.player_id,
              earliest.rank_name || base.current_rank || null,
              earliest.rr_after == null ? null : Number(earliest.rr_after),
              earliest.game_timestamp || new Date().toISOString(),
            )
            .run();
        } else {
          await this.env.DB.prepare(
            `INSERT OR IGNORE INTO player_start_rank
              (player_id, start_rank_name, start_rr, started_at, source)
             VALUES (?, ?, ?, datetime('now'), 'current_fallback')`,
          )
            .bind(
              link.player_id,
              base.current_rank || null,
              base.current_rr == null ? null : Number(base.current_rr),
            )
            .run();
        }

        start = await this.env.DB.prepare(
          "SELECT start_rank_name, start_rr, started_at, source FROM player_start_rank WHERE player_id = ?",
        )
          .bind(link.player_id)
          .first();
      }

      return {
        ...base,
        start_rank: start?.start_rank_name || null,
        start_rr: start?.start_rr == null ? null : Number(start.start_rr),
        start_rank_at: start?.started_at || null,
        start_rank_source: start?.source || null,
      };
    } catch (error) {
      console.warn("Could not load starting rank:", error);
      return base;
    }
  }
}

async function getPlayerLink(db, discordUserId) {
  return db.prepare(
    "SELECT player_id FROM dojo_riot_links WHERE discord_user_id = ?",
  )
    .bind(String(discordUserId))
    .first();
}

async function ensureStartRankSchema(db) {
  if (!db) throw new Error("D1 binding DB is not configured");

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS player_start_rank (
      player_id TEXT PRIMARY KEY,
      start_rank_name TEXT,
      start_rr INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'link'
    )`,
  ).run();
}

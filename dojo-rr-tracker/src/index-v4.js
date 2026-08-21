import RRTrackerV3 from "./index-v3.js";

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

export default class RRTrackerV4 extends RRTrackerV3 {
  async linkRiot(discordUserId, riotId, requestedRegion = "na") {
    const result = await super.linkRiot(discordUserId, riotId, requestedRegion);
    if (!result?.ok) return result;

    // A link is the setup fallback. The first manual /sync will replace this
    // baseline so "Start rank" represents the rank when tracking actually began.
    try {
      await ensureStartRankSchema(this.env.DB);
      const link = await getPlayerLink(this.env.DB, discordUserId);
      if (link?.player_id) {
        await this.env.DB.prepare(
          `INSERT INTO player_start_rank
            (player_id, start_rank_name, start_rr, started_at, source)
           VALUES (?, ?, ?, datetime('now'), 'link')
           ON CONFLICT(player_id) DO UPDATE SET
             start_rank_name = CASE WHEN player_start_rank.source IN ('earliest_tracked','current_fallback') THEN excluded.start_rank_name ELSE player_start_rank.start_rank_name END,
             start_rr = CASE WHEN player_start_rank.source IN ('earliest_tracked','current_fallback') THEN excluded.start_rr ELSE player_start_rank.start_rr END,
             started_at = CASE WHEN player_start_rank.source IN ('earliest_tracked','current_fallback') THEN excluded.started_at ELSE player_start_rank.started_at END,
             source = CASE WHEN player_start_rank.source IN ('earliest_tracked','current_fallback') THEN 'link' ELSE player_start_rank.source END`,
        )
          .bind(
            link.player_id,
            result.current_rank || null,
            result.current_rr == null ? null : Number(result.current_rr),
          )
          .run();
      }
    } catch (error) {
      console.warn("Could not save setup rank:", error);
    }

    return result;
  }

  async syncDiscordUser(discordUserId) {
    const result = await super.syncDiscordUser(discordUserId);
    if (!result?.ok) return result;

    try {
      await ensureStartRankSchema(this.env.DB);
      const link = await getPlayerLink(this.env.DB, discordUserId);
      if (link?.player_id) {
        const syncCount = await this.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM rr_sync_events WHERE discord_user_id = ?",
        )
          .bind(String(discordUserId))
          .first();

        if (Number(syncCount?.count || 0) === 1) {
          await this.env.DB.prepare(
            `INSERT INTO player_start_rank
              (player_id, start_rank_name, start_rr, started_at, source)
             VALUES (?, ?, ?, datetime('now'), 'first_sync')
             ON CONFLICT(player_id) DO UPDATE SET
               start_rank_name = excluded.start_rank_name,
               start_rr = excluded.start_rr,
               started_at = excluded.started_at,
               source = 'first_sync'`,
          )
            .bind(
              link.player_id,
              result.current_rank || null,
              result.current_rr == null ? null : Number(result.current_rr),
            )
            .run();
        }
      }
    } catch (error) {
      console.warn("Could not save first sync rank:", error);
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

      // Existing users may have been backfilled from their oldest stored match.
      // Upgrade that baseline to the rank they had when they first manually synced.
      if (!start || ["earliest_tracked", "current_fallback"].includes(String(start.source || ""))) {
        const inferred = await inferFirstSyncRank(this.env.DB, discordUserId, link.player_id, base);
        if (inferred) {
          await this.env.DB.prepare(
            `INSERT INTO player_start_rank
              (player_id, start_rank_name, start_rr, started_at, source)
             VALUES (?, ?, ?, ?, 'first_sync')
             ON CONFLICT(player_id) DO UPDATE SET
               start_rank_name = excluded.start_rank_name,
               start_rr = excluded.start_rr,
               started_at = excluded.started_at,
               source = 'first_sync'`,
          )
            .bind(
              link.player_id,
              inferred.rank_name,
              inferred.rr_after,
              inferred.started_at,
            )
            .run();

          start = {
            start_rank_name: inferred.rank_name,
            start_rr: inferred.rr_after,
            started_at: inferred.started_at,
            source: "first_sync",
          };
        }
      }

      const peak = await getPeakTrackedRank(this.env.DB, link.player_id);

      return {
        ...base,
        start_rank: start?.start_rank_name || base.start_rank || null,
        start_rr: start?.start_rr == null ? (base.start_rr ?? null) : Number(start.start_rr),
        start_rank_at: start?.started_at || base.start_rank_at || null,
        start_rank_source: start?.source || base.start_rank_source || null,
        peak_rank: peak?.rank_name || null,
        peak_rr: peak?.rr_after == null ? null : Number(peak.rr_after),
        peak_rank_at: peak?.game_timestamp || null,
      };
    } catch (error) {
      console.warn("Could not load first sync / peak rank:", error);
      return base;
    }
  }
}

async function inferFirstSyncRank(db, discordUserId, playerId, base) {
  const firstSync = await db.prepare(
    "SELECT synced_at FROM rr_sync_events WHERE discord_user_id = ? ORDER BY id ASC LIMIT 1",
  )
    .bind(String(discordUserId))
    .first();

  if (firstSync?.synced_at) {
    const normalized = normalizeSqliteTime(firstSync.synced_at);
    const match = await db.prepare(
      `SELECT rank_name, rr_after, game_timestamp
       FROM rr_matches
       WHERE player_id = ? AND game_timestamp <= ?
       ORDER BY game_timestamp DESC
       LIMIT 1`,
    )
      .bind(playerId, normalized)
      .first();

    if (match?.rank_name) {
      return {
        rank_name: match.rank_name,
        rr_after: match.rr_after == null ? null : Number(match.rr_after),
        started_at: firstSync.synced_at,
      };
    }

    return {
      rank_name: base.current_rank || null,
      rr_after: base.current_rr == null ? null : Number(base.current_rr),
      started_at: firstSync.synced_at,
    };
  }

  if (base.current_rank) {
    return {
      rank_name: base.current_rank,
      rr_after: base.current_rr == null ? null : Number(base.current_rr),
      started_at: new Date().toISOString(),
    };
  }

  return null;
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
    if (!best) {
      best = { ...row, score };
      continue;
    }

    const rr = row.rr_after == null ? -1 : Number(row.rr_after);
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

function normalizeSqliteTime(value) {
  const text = String(value || "");
  if (!text) return new Date().toISOString();
  if (text.includes("T")) return text;
  return `${text.replace(" ", "T")}Z`;
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

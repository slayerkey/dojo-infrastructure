import RRTrackerV15 from "./index-v15.js";

export default class RRTrackerV16 extends RRTrackerV15 {
  async linkRiot(discordUserId, riotId, requestedRegion = "na") {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureSwitchSchema(db);

    const discordId = normalizeDiscordId(discordUserId);
    const current = await readCurrentLink(db, discordId);
    const previous = current ? null : await readLastLinkHistory(db, discordId);

    const result = await super.linkRiot(discordId, riotId, requestedRegion);
    if (!result?.ok || !result.puuid) return result;

    // An in-place Riot rename keeps the exact same PUUID and therefore keeps the
    // existing leaderboard session. Only an actual account switch creates a reset.
    if (current) {
      return {
        ...result,
        leaderboard_reset: false,
      };
    }

    const samePreviousAccount = previous?.player_id
      && String(previous.player_id) === String(result.puuid);

    if (samePreviousAccount) {
      // If somebody unlinked and then changed their mind, reconnecting the exact same
      // Riot account restores the previous scoring session instead of manufacturing a
      // fresh reset.
      await db.prepare(
        `UPDATE dojo_riot_links
         SET scoring_started_at = ?, scoring_start_rank = ?, scoring_start_rr = ?
         WHERE discord_user_id = ?`,
      ).bind(
        previous.scoring_started_at || null,
        previous.scoring_start_rank || null,
        previous.scoring_start_rr == null ? null : Number(previous.scoring_start_rr),
        discordId,
      ).run();

      return {
        ...result,
        leaderboard_reset: false,
        restored_same_account: true,
        scoring_started_at: previous.scoring_started_at || null,
      };
    }

    if (previous?.player_id && String(previous.player_id) !== String(result.puuid)) {
      const resetAt = new Date().toISOString();
      await db.prepare(
        `UPDATE dojo_riot_links
         SET scoring_started_at = ?, scoring_start_rank = ?, scoring_start_rr = ?
         WHERE discord_user_id = ?`,
      ).bind(
        resetAt,
        result.current_rank || null,
        result.current_rr == null ? null : Number(result.current_rr),
        discordId,
      ).run();

      return {
        ...result,
        leaderboard_reset: true,
        scoring_started_at: resetAt,
      };
    }

    // First ever Riot link keeps the existing behavior: when Henrik has enough
    // history, the current period can be reconstructed from the beginning.
    return {
      ...result,
      leaderboard_reset: false,
      first_riot_link: true,
    };
  }

  async unlinkRiot(discordUserId) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureSwitchSchema(db);

    const discordId = normalizeDiscordId(discordUserId);
    const current = await readCurrentLink(db, discordId);
    const result = await super.unlinkRiot(discordId);
    if (!result?.ok || !current) return result;

    // V15 already writes the immutable link-history row. Add the scoring-session
    // metadata so reconnecting the same PUUID can restore continuity safely.
    await db.prepare(
      `UPDATE dojo_riot_link_history
       SET scoring_started_at = ?, scoring_start_rank = ?, scoring_start_rr = ?
       WHERE id = (
         SELECT id FROM dojo_riot_link_history
         WHERE discord_user_id = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
    ).bind(
      current.scoring_started_at || null,
      current.scoring_start_rank || null,
      current.scoring_start_rr == null ? null : Number(current.scoring_start_rr),
      discordId,
    ).run();

    return {
      ...result,
      leaderboard_session_preserved: true,
    };
  }

  async getCurrentRiotLink(discordUserId) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureSwitchSchema(db);
    const discordId = normalizeDiscordId(discordUserId);
    const row = await readCurrentLink(db, discordId);
    if (!row) return { ok: false, code: "NOT_LINKED", message: "No Riot account is currently linked." };
    return {
      ok: true,
      discord_user_id: discordId,
      player_id: String(row.player_id),
      riot_id: `${row.riot_name}#${row.riot_tag}`,
      scoring_started_at: row.scoring_started_at || null,
    };
  }

  async getLeaderboardSnapshot(viewerDiscordUserId = null) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureSwitchSchema(db);

    const month = currentMonthWindow();
    const snapshot = await getSwitchAwareLeaderboard(db, month, viewerDiscordUserId, "month");

    // Keep the already-frozen historical champion record. V14/V15 store this as an
    // immutable row, so a current account switch cannot rewrite a past winner.
    const previous = previousMonthWindow();
    let frozen = await this.getMonthlyChampion(previous.key);
    if (!frozen?.champion) {
      frozen = await super.freezePreviousMonthChampion();
    }
    snapshot.previous_month = previous.label;
    snapshot.previous_month_champion = frozen?.champion
      ? {
          discord_user_id: frozen.champion.discord_user_id,
          riot_id: frozen.champion.riot_id,
          monthly_rr: frozen.champion.monthly_rr,
          games_counted: frozen.champion.games_counted,
        }
      : null;
    return snapshot;
  }

  async getYearLeaderboardSnapshot(viewerDiscordUserId = null) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureSwitchSchema(db);
    return getSwitchAwareLeaderboard(db, currentYearWindow(), viewerDiscordUserId, "year");
  }
}

async function ensureSwitchSchema(db) {
  const linkInfo = await db.prepare("PRAGMA table_info(dojo_riot_links)").all();
  const linkColumns = new Set((linkInfo.results || []).map((row) => String(row?.name || "")));
  if (!linkColumns.has("scoring_started_at")) {
    await db.prepare("ALTER TABLE dojo_riot_links ADD COLUMN scoring_started_at TEXT").run();
  }
  if (!linkColumns.has("scoring_start_rank")) {
    await db.prepare("ALTER TABLE dojo_riot_links ADD COLUMN scoring_start_rank TEXT").run();
  }
  if (!linkColumns.has("scoring_start_rr")) {
    await db.prepare("ALTER TABLE dojo_riot_links ADD COLUMN scoring_start_rr INTEGER").run();
  }

  const historyInfo = await db.prepare("PRAGMA table_info(dojo_riot_link_history)").all();
  const historyColumns = new Set((historyInfo.results || []).map((row) => String(row?.name || "")));
  if (!historyColumns.has("scoring_started_at")) {
    await db.prepare("ALTER TABLE dojo_riot_link_history ADD COLUMN scoring_started_at TEXT").run();
  }
  if (!historyColumns.has("scoring_start_rank")) {
    await db.prepare("ALTER TABLE dojo_riot_link_history ADD COLUMN scoring_start_rank TEXT").run();
  }
  if (!historyColumns.has("scoring_start_rr")) {
    await db.prepare("ALTER TABLE dojo_riot_link_history ADD COLUMN scoring_start_rr INTEGER").run();
  }
}

function readCurrentLink(db, discordId) {
  return db.prepare(
    `SELECT l.player_id, l.linked_at, l.updated_at,
            l.scoring_started_at, l.scoring_start_rank, l.scoring_start_rr,
            p.riot_name, p.riot_tag, p.region
     FROM dojo_riot_links l
     JOIN players p ON p.id = l.player_id
     WHERE l.discord_user_id = ?`,
  ).bind(discordId).first();
}

function readLastLinkHistory(db, discordId) {
  return db.prepare(
    `SELECT player_id, riot_id, linked_at, unlinked_at,
            scoring_started_at, scoring_start_rank, scoring_start_rr
     FROM dojo_riot_link_history
     WHERE discord_user_id = ?
     ORDER BY id DESC
     LIMIT 1`,
  ).bind(discordId).first();
}

async function getSwitchAwareLeaderboard(db, window, viewerDiscordUserId, period) {
  const viewerId = String(viewerDiscordUserId || "");
  const isMonth = period === "month";
  const startIso = window.start.toISOString();
  const endIso = window.end.toISOString();

  const rows = await db.prepare(
    `WITH current_link AS (
       SELECT l.discord_user_id,
              l.player_id,
              l.scoring_started_at,
              l.scoring_start_rank,
              l.scoring_start_rr,
              p.riot_name,
              p.riot_tag
       FROM dojo_riot_links l
       JOIN players p ON p.id = l.player_id
     ),
     raw_identity_matches AS (
       SELECT r.discord_user_id,
              r.player_id,
              r.rr_change,
              r.rank_name,
              r.rr_after,
              r.game_timestamp
       FROM rr_matches r
       WHERE r.discord_user_id IS NOT NULL
     ),
     effective_matches AS (
       SELECT r.*
       FROM raw_identity_matches r
       LEFT JOIN current_link cl ON cl.discord_user_id = r.discord_user_id
       WHERE cl.discord_user_id IS NULL
          OR (cl.scoring_started_at IS NOT NULL AND cl.scoring_started_at >= ?)
          OR (
            r.player_id = cl.player_id
            AND (cl.scoring_started_at IS NULL OR r.game_timestamp >= cl.scoring_started_at)
          )
     ),
     display_matches AS (
       SELECT r.*
       FROM raw_identity_matches r
       LEFT JOIN current_link cl ON cl.discord_user_id = r.discord_user_id
       WHERE cl.discord_user_id IS NULL
          OR (cl.scoring_started_at IS NOT NULL AND cl.scoring_started_at >= ?)
          OR r.player_id = cl.player_id
     ),
     period_totals AS (
       SELECT discord_user_id,
              COALESCE(SUM(rr_change), 0) AS period_rr,
              COUNT(*) AS games_counted
       FROM effective_matches
       WHERE game_timestamp >= ? AND game_timestamp < ?
       GROUP BY discord_user_id
     ),
     latest_ranked AS (
       SELECT discord_user_id, player_id, rank_name, rr_after, game_timestamp,
              ROW_NUMBER() OVER (PARTITION BY discord_user_id ORDER BY game_timestamp DESC) AS rn
       FROM display_matches
       WHERE rank_name IS NOT NULL
     ),
     latest AS (
       SELECT discord_user_id, player_id, rank_name, rr_after, game_timestamp
       FROM latest_ranked
       WHERE rn = 1
     ),
     pre_period_ranked AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp,
              ROW_NUMBER() OVER (PARTITION BY discord_user_id ORDER BY game_timestamp DESC) AS rn
       FROM effective_matches
       WHERE rank_name IS NOT NULL AND game_timestamp < ?
     ),
     pre_period AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp
       FROM pre_period_ranked
       WHERE rn = 1
     ),
     period_scored AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp,
              CASE LOWER(TRIM(rank_name))
                WHEN 'iron 1' THEN 1 WHEN 'iron 2' THEN 2 WHEN 'iron 3' THEN 3
                WHEN 'bronze 1' THEN 4 WHEN 'bronze 2' THEN 5 WHEN 'bronze 3' THEN 6
                WHEN 'silver 1' THEN 7 WHEN 'silver 2' THEN 8 WHEN 'silver 3' THEN 9
                WHEN 'gold 1' THEN 10 WHEN 'gold 2' THEN 11 WHEN 'gold 3' THEN 12
                WHEN 'platinum 1' THEN 13 WHEN 'platinum 2' THEN 14 WHEN 'platinum 3' THEN 15
                WHEN 'diamond 1' THEN 16 WHEN 'diamond 2' THEN 17 WHEN 'diamond 3' THEN 18
                WHEN 'ascendant 1' THEN 19 WHEN 'ascendant 2' THEN 20 WHEN 'ascendant 3' THEN 21
                WHEN 'immortal 1' THEN 22 WHEN 'immortal 2' THEN 23 WHEN 'immortal 3' THEN 24
                WHEN 'radiant' THEN 25 ELSE 0 END AS rank_score
       FROM effective_matches
       WHERE rank_name IS NOT NULL AND game_timestamp >= ? AND game_timestamp < ?
     ),
     period_ranked AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp, rank_score,
              ROW_NUMBER() OVER (PARTITION BY discord_user_id ORDER BY game_timestamp ASC) AS start_rn,
              ROW_NUMBER() OVER (
                PARTITION BY discord_user_id
                ORDER BY rank_score DESC, COALESCE(rr_after, -1) DESC, game_timestamp ASC
              ) AS peak_rn
       FROM period_scored
     ),
     period_start AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp
       FROM period_ranked WHERE start_rn = 1
     ),
     period_peak AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp
       FROM period_ranked WHERE peak_rn = 1
     ),
     active_ids AS (
       SELECT l.discord_user_id
       FROM dojo_riot_links l
       JOIN dojo_members dm ON dm.discord_user_id = l.discord_user_id AND dm.active = 1
     ),
     candidates AS (
       SELECT discord_user_id FROM active_ids
       UNION
       SELECT discord_user_id FROM period_totals
     ),
     ranked AS (
       SELECT c.discord_user_id,
              COALESCE(cl.riot_name, lp.riot_name, 'Former member') AS riot_name,
              COALESCE(cl.riot_tag, lp.riot_tag, '') AS riot_tag,
              COALESCE(t.period_rr, 0) AS period_rr,
              COALESCE(t.games_counted, 0) AS games_counted,
              latest.rank_name AS current_rank,
              latest.rr_after AS current_rr,
              CASE
                WHEN cl.scoring_started_at IS NOT NULL
                 AND cl.scoring_started_at >= ?
                 AND cl.scoring_started_at < ? THEN 1
                WHEN pre.rank_name IS NOT NULL THEN 1
                ELSE 0
              END AS history_complete,
              CASE
                WHEN cl.scoring_started_at IS NOT NULL
                 AND cl.scoring_started_at >= ?
                 AND cl.scoring_started_at < ?
                  THEN COALESCE(cl.scoring_start_rank, ps.rank_name)
                ELSE COALESCE(pre.rank_name, ps.rank_name)
              END AS start_rank,
              CASE
                WHEN cl.scoring_started_at IS NOT NULL
                 AND cl.scoring_started_at >= ?
                 AND cl.scoring_started_at < ?
                  THEN COALESCE(cl.scoring_start_rr, ps.rr_after)
                ELSE COALESCE(pre.rr_after, ps.rr_after)
              END AS start_rr,
              CASE
                WHEN cl.scoring_started_at IS NOT NULL
                 AND cl.scoring_started_at >= ?
                 AND cl.scoring_started_at < ? THEN cl.scoring_started_at
                ELSE COALESCE(pre.game_timestamp, ps.game_timestamp)
              END AS start_rank_at,
              CASE
                WHEN cl.scoring_started_at IS NOT NULL
                 AND cl.scoring_started_at >= ?
                 AND cl.scoring_started_at < ? THEN 1
                ELSE 0
              END AS reset_in_period,
              pp.rank_name AS peak_rank,
              pp.rr_after AS peak_rr,
              pp.game_timestamp AS peak_rank_at,
              ROW_NUMBER() OVER (
                ORDER BY COALESCE(t.period_rr, 0) DESC,
                         COALESCE(t.games_counted, 0) DESC,
                         COALESCE(cl.riot_name, lp.riot_name, '') COLLATE NOCASE ASC
              ) AS position
       FROM candidates c
       LEFT JOIN period_totals t ON t.discord_user_id = c.discord_user_id
       LEFT JOIN latest ON latest.discord_user_id = c.discord_user_id
       LEFT JOIN players lp ON lp.id = latest.player_id
       LEFT JOIN pre_period pre ON pre.discord_user_id = c.discord_user_id
       LEFT JOIN period_start ps ON ps.discord_user_id = c.discord_user_id
       LEFT JOIN period_peak pp ON pp.discord_user_id = c.discord_user_id
       LEFT JOIN current_link cl ON cl.discord_user_id = c.discord_user_id
     )
     SELECT * FROM ranked ORDER BY position ASC`,
  ).bind(
    endIso,
    endIso,
    startIso,
    endIso,
    startIso,
    startIso,
    endIso,
    startIso,
    endIso,
    startIso,
    endIso,
    startIso,
    endIso,
    startIso,
    endIso,
    startIso,
    endIso,
  ).all();

  const entries = (rows.results || []).map((row) => {
    const tag = String(row.riot_tag || "");
    const riotId = tag ? `${row.riot_name}#${tag}` : String(row.riot_name || "Former member");
    return {
      position: Number(row.position || 0),
      discord_user_id: String(row.discord_user_id),
      riot_id: riotId,
      period_rr: Number(row.period_rr || 0),
      monthly_rr: isMonth ? Number(row.period_rr || 0) : undefined,
      yearly_rr: isMonth ? undefined : Number(row.period_rr || 0),
      games_counted: Number(row.games_counted || 0),
      current_rank: row.current_rank || null,
      current_rr: row.current_rr == null ? null : Number(row.current_rr),
      history_complete: Boolean(row.history_complete),
      start_rank: row.start_rank || null,
      start_rr: row.start_rr == null ? null : Number(row.start_rr),
      start_rank_at: row.start_rank_at || null,
      start_rank_source: row.reset_in_period
        ? "account_switch_reset"
        : row.start_rank
          ? (row.history_complete ? "pre_period_snapshot" : "first_period_match")
          : null,
      peak_rank: row.peak_rank || null,
      peak_rr: row.peak_rr == null ? null : Number(row.peak_rr),
      peak_rank_at: row.peak_rank_at || null,
      account_switch_reset: Boolean(row.reset_in_period),
    };
  });

  const viewer = viewerId ? entries.find((entry) => entry.discord_user_id === viewerId) : null;
  return {
    ok: true,
    period,
    label: window.label,
    month: isMonth ? window.label : undefined,
    year: isMonth ? undefined : window.label,
    total_players: entries.length,
    viewer_position: viewer?.position || null,
    entries,
    snapshot_at: new Date().toISOString(),
  };
}

function normalizeDiscordId(value) {
  const id = String(value || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Invalid Discord user ID");
  return id;
}

function currentMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    start,
    end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    label: start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

function previousMonthWindow(now = new Date()) {
  const current = currentMonthWindow(now);
  const start = new Date(Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1));
  return {
    start,
    end: current.start,
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    label: start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

function currentYearWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year + 1, 0, 1)),
    key: String(year),
    label: String(year),
  };
}

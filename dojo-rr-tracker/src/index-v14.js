import RRTrackerV13 from "./index-v13.js";

export default class RRTrackerV14 extends RRTrackerV13 {
  async getLeaderboardSnapshot(viewerDiscordUserId = null) {
    const snapshot = await super.getLeaderboardSnapshot(viewerDiscordUserId);
    if (!snapshot?.ok) return snapshot;

    const previous = previousMonthWindow();
    let frozen = await this.getMonthlyChampion(previous.key);
    if (!frozen?.champion) {
      frozen = await this.freezePreviousMonthChampion();
    }

    if (frozen?.champion) {
      snapshot.previous_month = frozen.champion.month_label;
      snapshot.previous_month_champion = {
        discord_user_id: frozen.champion.discord_user_id,
        riot_id: frozen.champion.riot_id,
        monthly_rr: frozen.champion.monthly_rr,
        games_counted: frozen.champion.games_counted,
      };
    }
    return snapshot;
  }

  async freezePreviousMonthChampion() {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureChampionSchema(db);

    const month = previousMonthWindow();
    const existing = await readChampion(db, month.key);
    if (existing) return { ok: true, created: false, champion: normalizeChampion(existing) };

    const calculated = await calculateChampion(db, month);
    if (!calculated) {
      return {
        ok: true,
        created: false,
        champion: null,
        message: `No tracked competitive games were found for ${month.label}.`,
      };
    }

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT OR IGNORE INTO monthly_champions
       (month_key, month_label, discord_user_id, player_id, riot_id, monthly_rr, games_counted, frozen_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'automatic_close')`,
    )
      .bind(
        month.key,
        month.label,
        calculated.discord_user_id,
        calculated.player_id,
        calculated.riot_id,
        calculated.monthly_rr,
        calculated.games_counted,
        now,
      )
      .run();

    const champion = await readChampion(db, month.key);
    return { ok: true, created: true, champion: champion ? normalizeChampion(champion) : null };
  }

  async getMonthlyChampion(monthKey) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    const month = parseMonthKey(monthKey);
    if (!month) return { ok: false, message: "Month must use YYYY-MM format." };
    await ensureChampionSchema(db);
    const row = await readChampion(db, month.key);
    return { ok: true, champion: row ? normalizeChampion(row) : null };
  }

  async setMonthlyChampion(monthKey, discordUserId, correctedBy = "owner") {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    const month = parseMonthKey(monthKey);
    if (!month) return { ok: false, message: "Month must use YYYY-MM format." };
    const discordId = String(discordUserId || "");
    if (!/^\d+$/.test(discordId)) return { ok: false, message: "Invalid Discord user ID." };

    await ensureChampionSchema(db);
    const link = await db.prepare(
      `SELECT l.player_id, p.riot_name, p.riot_tag
       FROM dojo_riot_links l
       JOIN players p ON p.id = l.player_id
       WHERE l.discord_user_id = ?`,
    )
      .bind(discordId)
      .first();

    if (!link?.player_id) {
      return {
        ok: false,
        message: "That Discord member does not have a Riot account linked in the RR tracker.",
      };
    }

    const totals = await db.prepare(
      `SELECT COALESCE(SUM(rr_change), 0) AS monthly_rr,
              COUNT(*) AS games_counted
       FROM rr_matches
       WHERE player_id = ?
         AND game_timestamp >= ?
         AND game_timestamp < ?`,
    )
      .bind(link.player_id, month.start.toISOString(), month.end.toISOString())
      .first();

    const now = new Date().toISOString();
    const riotId = `${link.riot_name}#${link.riot_tag}`;
    await db.prepare(
      `INSERT INTO monthly_champions
       (month_key, month_label, discord_user_id, player_id, riot_id, monthly_rr, games_counted, frozen_at, source, corrected_at, corrected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual_override', ?, ?)
       ON CONFLICT(month_key) DO UPDATE SET
         month_label = excluded.month_label,
         discord_user_id = excluded.discord_user_id,
         player_id = excluded.player_id,
         riot_id = excluded.riot_id,
         monthly_rr = excluded.monthly_rr,
         games_counted = excluded.games_counted,
         source = 'manual_override',
         corrected_at = excluded.corrected_at,
         corrected_by = excluded.corrected_by`,
    )
      .bind(
        month.key,
        month.label,
        discordId,
        link.player_id,
        riotId,
        Number(totals?.monthly_rr || 0),
        Number(totals?.games_counted || 0),
        now,
        now,
        String(correctedBy || "owner"),
      )
      .run();

    const champion = await readChampion(db, month.key);
    return { ok: true, champion: champion ? normalizeChampion(champion) : null };
  }
}

async function ensureChampionSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS monthly_champions (
       month_key TEXT PRIMARY KEY,
       month_label TEXT NOT NULL,
       discord_user_id TEXT NOT NULL,
       player_id TEXT,
       riot_id TEXT,
       monthly_rr INTEGER NOT NULL DEFAULT 0,
       games_counted INTEGER NOT NULL DEFAULT 0,
       frozen_at TEXT NOT NULL,
       source TEXT NOT NULL DEFAULT 'automatic_close',
       corrected_at TEXT,
       corrected_by TEXT
     )`,
  ).run();
}

async function readChampion(db, monthKey) {
  return db.prepare(
    `SELECT month_key, month_label, discord_user_id, player_id, riot_id,
            monthly_rr, games_counted, frozen_at, source, corrected_at, corrected_by
     FROM monthly_champions
     WHERE month_key = ?`,
  )
    .bind(monthKey)
    .first();
}

async function calculateChampion(db, month) {
  const row = await db.prepare(
    `WITH period_totals AS (
       SELECT player_id,
              COALESCE(SUM(rr_change), 0) AS monthly_rr,
              COUNT(*) AS games_counted
       FROM rr_matches
       WHERE game_timestamp >= ? AND game_timestamp < ?
       GROUP BY player_id
     )
     SELECT l.discord_user_id,
            l.player_id,
            p.riot_name,
            p.riot_tag,
            pt.monthly_rr,
            pt.games_counted
     FROM period_totals pt
     JOIN dojo_riot_links l ON l.player_id = pt.player_id
     JOIN players p ON p.id = pt.player_id
     ORDER BY pt.monthly_rr DESC,
              pt.games_counted DESC,
              p.riot_name COLLATE NOCASE ASC
     LIMIT 1`,
  )
    .bind(month.start.toISOString(), month.end.toISOString())
    .first();

  if (!row) return null;
  return {
    discord_user_id: String(row.discord_user_id),
    player_id: String(row.player_id),
    riot_id: `${row.riot_name}#${row.riot_tag}`,
    monthly_rr: Number(row.monthly_rr || 0),
    games_counted: Number(row.games_counted || 0),
  };
}

function normalizeChampion(row) {
  return {
    month_key: String(row.month_key),
    month_label: String(row.month_label),
    discord_user_id: String(row.discord_user_id),
    player_id: row.player_id ? String(row.player_id) : null,
    riot_id: row.riot_id || null,
    monthly_rr: Number(row.monthly_rr || 0),
    games_counted: Number(row.games_counted || 0),
    frozen_at: row.frozen_at || null,
    source: row.source || null,
    corrected_at: row.corrected_at || null,
    corrected_by: row.corrected_by || null,
  };
}

function previousMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    label: start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
    start,
    end,
  };
}

function parseMonthKey(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    label: start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
    start,
    end,
  };
}

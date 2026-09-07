import RRTrackerV14 from "./index-v14.js";

const HENRIK_API = "https://api.henrikdev.xyz";
const PLATFORM = "pc";
const ACCOUNT_LOOKUP_TIMEOUT_MS = 10000;

export default class RRTrackerV15 extends RRTrackerV14 {
  async linkRiot(discordUserId, riotId, requestedRegion = "na") {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureIdentitySchema(db);

    const discordId = normalizeDiscordId(discordUserId);
    const normalized = normalizeRiotIdInput(riotId);
    if (!normalized) {
      return { ok: false, code: "INVALID_RIOT_ID", message: "Use your Riot ID in the format Name#Tag." };
    }

    const parsed = splitRiotId(normalized);
    const existing = await db.prepare(
      `SELECT l.player_id, p.riot_name, p.riot_tag, p.region
       FROM dojo_riot_links l
       JOIN players p ON p.id = l.player_id
       WHERE l.discord_user_id = ?`,
    ).bind(discordId).first();

    // Riot name/tag changes do not change PUUID. If the member entered the renamed
    // version of the same account, update it in place instead of forcing an unlink.
    if (existing && !sameRiotId(existing, parsed)) {
      const resolved = await lookupRiotAccount(parsed.name, parsed.tag, this.env.HENRIK_API_KEY);
      if (!resolved.ok) return resolved;

      if (String(resolved.puuid) !== String(existing.player_id)) {
        return {
          ok: false,
          code: "ALREADY_LINKED",
          message: `Your Discord account is already linked to ${existing.riot_name}#${existing.riot_tag}. Run /unlinkriot first if you want to switch to a different Riot account.`,
          riot_id: `${existing.riot_name}#${existing.riot_tag}`,
        };
      }

      await db.prepare(
        `UPDATE players
         SET riot_name = ?, riot_tag = ?, region = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        resolved.name || parsed.name,
        resolved.tag || parsed.tag,
        resolved.region || existing.region || requestedRegion,
        existing.player_id,
      ).run();

      const result = await super.syncDiscordUser(discordId);
      if (result?.ok) {
        await stampMatches(db, result.puuid || existing.player_id, discordId);
        return { ...result, linked: true, already_linked: true, renamed_same_account: true };
      }
      return result;
    }

    const result = await super.linkRiot(discordId, normalized, requestedRegion);
    if (result?.ok && result.puuid) await stampMatches(db, result.puuid, discordId);
    return result;
  }

  async syncDiscordUser(discordUserId) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureIdentitySchema(db);
    const discordId = normalizeDiscordId(discordUserId);
    const result = await super.syncDiscordUser(discordId);
    if (result?.ok && result.puuid) await stampMatches(db, result.puuid, discordId);
    return result;
  }

  async unlinkRiot(discordUserId) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureIdentitySchema(db);
    const discordId = normalizeDiscordId(discordUserId);

    const current = await db.prepare(
      `SELECT l.player_id, l.linked_at, p.riot_name, p.riot_tag
       FROM dojo_riot_links l
       JOIN players p ON p.id = l.player_id
       WHERE l.discord_user_id = ?`,
    ).bind(discordId).first();

    if (!current?.player_id) {
      return { ok: false, code: "NOT_LINKED", message: "You do not currently have a Riot account linked." };
    }

    // Stamp every already-stored match before removing the current pointer. RR rows
    // remain owned by this Discord user forever, even if the Riot account is later
    // linked by someone else.
    await stampMatches(db, current.player_id, discordId);
    await db.prepare(
      `INSERT INTO dojo_riot_link_history
       (discord_user_id, player_id, riot_id, linked_at, unlinked_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).bind(
      discordId,
      current.player_id,
      `${current.riot_name}#${current.riot_tag}`,
      current.linked_at || new Date().toISOString(),
    ).run();

    await db.prepare("DELETE FROM dojo_riot_links WHERE discord_user_id = ?").bind(discordId).run();

    return {
      ok: true,
      unlinked: true,
      riot_id: `${current.riot_name}#${current.riot_tag}`,
      history_preserved: true,
    };
  }

  async getLeaderboardSnapshot(viewerDiscordUserId = null) {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureIdentitySchema(db);

    const month = currentMonthWindow();
    const snapshot = await getIdentityLeaderboard(db, month, viewerDiscordUserId, "month");
    const previous = previousMonthWindow();

    let frozen = await this.getMonthlyChampion(previous.key);
    if (!frozen?.champion) frozen = await this.freezePreviousMonthChampion();
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
    await ensureIdentitySchema(db);
    return getIdentityLeaderboard(db, currentYearWindow(), viewerDiscordUserId, "year");
  }

  async freezePreviousMonthChampion() {
    const db = this.env.DB;
    if (!db) return { ok: false, message: "D1 is not configured." };
    await ensureIdentitySchema(db);
    await ensureChampionSchema(db);

    const month = previousMonthWindow();
    const existing = await readChampion(db, month.key);
    if (existing) return { ok: true, created: false, champion: normalizeChampion(existing) };

    const board = await getIdentityLeaderboard(db, month, null, "month");
    const winner = board.entries?.[0] || null;
    if (!winner || Number(winner.games_counted || 0) <= 0) {
      return { ok: true, created: false, champion: null, message: `No tracked competitive games were found for ${month.label}.` };
    }

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT OR IGNORE INTO monthly_champions
       (month_key, month_label, discord_user_id, player_id, riot_id, monthly_rr, games_counted, frozen_at, source)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'automatic_close_identity_v15')`,
    ).bind(
      month.key,
      month.label,
      winner.discord_user_id,
      winner.riot_id,
      winner.monthly_rr,
      winner.games_counted,
      now,
    ).run();

    const champion = await readChampion(db, month.key);
    return { ok: true, created: true, champion: champion ? normalizeChampion(champion) : null };
  }
}

async function ensureIdentitySchema(db) {
  const info = await db.prepare("PRAGMA table_info(rr_matches)").all();
  const columns = Array.isArray(info?.results) ? info.results : [];
  if (!columns.some((column) => String(column?.name) === "discord_user_id")) {
    await db.prepare("ALTER TABLE rr_matches ADD COLUMN discord_user_id TEXT").run();
  }

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_rr_matches_discord_time ON rr_matches(discord_user_id, game_timestamp)",
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS dojo_riot_link_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       discord_user_id TEXT NOT NULL,
       player_id TEXT NOT NULL,
       riot_id TEXT,
       linked_at TEXT,
       unlinked_at TEXT NOT NULL
     )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS rr_identity_migrations (
       migration_key TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  ).run();

  const migrated = await db.prepare(
    "SELECT migration_key FROM rr_identity_migrations WHERE migration_key = 'backfill-discord-owner-v15'",
  ).first();
  if (!migrated) {
    await db.prepare(
      `UPDATE rr_matches
       SET discord_user_id = (
         SELECT l.discord_user_id
         FROM dojo_riot_links l
         WHERE l.player_id = rr_matches.player_id
         LIMIT 1
       )
       WHERE discord_user_id IS NULL
         AND EXISTS (
           SELECT 1 FROM dojo_riot_links l WHERE l.player_id = rr_matches.player_id
         )`,
    ).run();
    await db.prepare(
      "INSERT OR IGNORE INTO rr_identity_migrations (migration_key, applied_at) VALUES ('backfill-discord-owner-v15', datetime('now'))",
    ).run();
  }
}

async function stampMatches(db, playerId, discordId) {
  await db.prepare(
    `UPDATE rr_matches
     SET discord_user_id = ?
     WHERE player_id = ? AND discord_user_id IS NULL`,
  ).bind(String(discordId), String(playerId)).run();
}

async function getIdentityLeaderboard(db, window, viewerDiscordUserId, period) {
  const viewerId = String(viewerDiscordUserId || "");
  const isMonth = period === "month";
  const startIso = window.start.toISOString();
  const endIso = window.end.toISOString();

  const rows = await db.prepare(
    `WITH identity_matches AS (
       SELECT r.discord_user_id,
              r.player_id,
              r.rr_change,
              r.rank_name,
              r.rr_after,
              r.game_timestamp
       FROM rr_matches r
       WHERE r.discord_user_id IS NOT NULL
     ),
     period_totals AS (
       SELECT discord_user_id,
              COALESCE(SUM(rr_change), 0) AS period_rr,
              COUNT(*) AS games_counted
       FROM identity_matches
       WHERE game_timestamp >= ? AND game_timestamp < ?
       GROUP BY discord_user_id
     ),
     latest_ranked AS (
       SELECT discord_user_id, player_id, rank_name, rr_after, game_timestamp,
              ROW_NUMBER() OVER (PARTITION BY discord_user_id ORDER BY game_timestamp DESC) AS rn
       FROM identity_matches
       WHERE rank_name IS NOT NULL
     ),
     latest AS (
       SELECT discord_user_id, player_id, rank_name, rr_after, game_timestamp
       FROM latest_ranked WHERE rn = 1
     ),
     pre_period_ranked AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp,
              ROW_NUMBER() OVER (PARTITION BY discord_user_id ORDER BY game_timestamp DESC) AS rn
       FROM identity_matches
       WHERE rank_name IS NOT NULL AND game_timestamp < ?
     ),
     pre_period AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp
       FROM pre_period_ranked WHERE rn = 1
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
       FROM identity_matches
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
       SELECT discord_user_id, rank_name, rr_after, game_timestamp FROM period_ranked WHERE start_rn = 1
     ),
     period_peak AS (
       SELECT discord_user_id, rank_name, rr_after, game_timestamp FROM period_ranked WHERE peak_rn = 1
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
     current_link AS (
       SELECT l.discord_user_id, l.player_id, p.riot_name, p.riot_tag
       FROM dojo_riot_links l
       JOIN players p ON p.id = l.player_id
     ),
     ranked AS (
       SELECT c.discord_user_id,
              COALESCE(cl.riot_name, lp.riot_name, 'Former member') AS riot_name,
              COALESCE(cl.riot_tag, lp.riot_tag, '') AS riot_tag,
              COALESCE(t.period_rr, 0) AS period_rr,
              COALESCE(t.games_counted, 0) AS games_counted,
              latest.rank_name AS current_rank,
              latest.rr_after AS current_rr,
              CASE WHEN pre.rank_name IS NOT NULL THEN 1 ELSE 0 END AS history_complete,
              COALESCE(pre.rank_name, ps.rank_name) AS start_rank,
              COALESCE(pre.rr_after, ps.rr_after) AS start_rr,
              COALESCE(pre.game_timestamp, ps.game_timestamp) AS start_rank_at,
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
  ).bind(startIso, endIso, startIso, startIso, endIso).all();

  const entries = (rows.results || []).map((row) => {
    const riotTag = String(row.riot_tag || "");
    const riotId = riotTag ? `${row.riot_name}#${riotTag}` : String(row.riot_name || "Former member");
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
      start_rank_source: row.start_rank ? (row.history_complete ? "pre_period_snapshot" : "first_period_match") : null,
      peak_rank: row.peak_rank || null,
      peak_rr: row.peak_rr == null ? null : Number(row.peak_rr),
      peak_rank_at: row.peak_rank_at || null,
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

async function lookupRiotAccount(name, tag, apiKey) {
  const url = `${HENRIK_API}/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  let response;
  try {
    response = await Promise.race([
      fetch(url, { headers: { Authorization: apiKey, "Content-Type": "application/json" } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ACCOUNT_LOOKUP_TIMEOUT")), ACCOUNT_LOOKUP_TIMEOUT_MS)),
    ]);
  } catch (error) {
    return { ok: false, code: "ACCOUNT_LOOKUP_FAILED", message: "The Riot account lookup took too long. Try again in a moment.", error: String(error) };
  }

  let body = null;
  try { body = await response.json(); } catch {}
  if (response.status === 429) {
    return { ok: false, code: "RATE_LIMITED", message: "The Riot tracker is rate limited right now.", retry_after: Number(response.headers.get("retry-after") || 60) };
  }
  if (!response.ok || !body?.data?.puuid) {
    return { ok: false, code: "ACCOUNT_LOOKUP_FAILED", message: "Could not find that Riot account." };
  }
  return {
    ok: true,
    puuid: String(body.data.puuid),
    name: String(body.data.name || name),
    tag: String(body.data.tag || tag),
    region: String(body.data.region || "na").toLowerCase(),
  };
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

function readChampion(db, monthKey) {
  return db.prepare(
    `SELECT month_key, month_label, discord_user_id, player_id, riot_id,
            monthly_rr, games_counted, frozen_at, source, corrected_at, corrected_by
     FROM monthly_champions WHERE month_key = ?`,
  ).bind(monthKey).first();
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

function normalizeDiscordId(value) {
  const id = String(value || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Invalid Discord user ID");
  return id;
}

function normalizeRiotIdInput(riotId) {
  const value = String(riotId || "").trim();
  const separator = value.indexOf("#");
  if (separator <= 0) return null;
  const name = value.slice(0, separator).trim();
  const tag = value.slice(separator + 1).replace(/^#+/, "").trim();
  if (!name || !tag) return null;
  return `${name}#${tag}`;
}

function splitRiotId(value) {
  const index = value.indexOf("#");
  return { name: value.slice(0, index), tag: value.slice(index + 1) };
}

function sameRiotId(existing, next) {
  return String(existing.riot_name || "").toLowerCase() === String(next.name || "").toLowerCase()
    && String(existing.riot_tag || "").toLowerCase() === String(next.tag || "").toLowerCase();
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

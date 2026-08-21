import { WorkerEntrypoint } from "cloudflare:workers";

const HENRIK_API = "https://api.henrikdev.xyz";
const PLATFORM = "pc";

export default class RRTracker extends WorkerEntrypoint {
  async fetch(request) {
    const env = this.env;
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/test-player") {
      return handleTestPlayer(url, env, cors);
    }

    if (url.pathname === "/health") {
      return jsonResponse(await getHealth(env), 200, cors);
    }

    return jsonResponse(
      {
        worker: "dojo-rr-tracker",
        status: "ok",
        endpoints: {
          "GET /test-player?name=NAME&tag=TAG&region=na":
            "Look up a Riot account, sync recent competitive RR history into D1, and calculate the current month's net RR",
          "GET /health": "Health check",
        },
      },
      200,
      cors,
    );
  }

  async health() {
    return getHealth(this.env);
  }

  async setMemberActive(discordUserId, active) {
    const env = this.env;
    requireDb(env);
    await ensureSchema(env.DB);
    const discordId = normalizeDiscordId(discordUserId);

    await env.DB.prepare(
      "INSERT INTO dojo_members (discord_user_id, active, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(discord_user_id) DO UPDATE SET active = excluded.active, updated_at = datetime('now')",
    )
      .bind(discordId, active ? 1 : 0)
      .run();

    return { ok: true, discord_user_id: discordId, active: Boolean(active) };
  }

  async linkRiot(discordUserId, riotId, requestedRegion = "na") {
    const env = this.env;
    requireReady(env);
    await ensureSchema(env.DB);

    const discordId = normalizeDiscordId(discordUserId);
    const parsedId = parseRiotId(riotId);
    if (!parsedId) {
      return {
        ok: false,
        code: "INVALID_RIOT_ID",
        message: "Use your Riot ID in the format Name#Tag.",
      };
    }

    const existing = await env.DB.prepare(
      "SELECT l.player_id, p.riot_name, p.riot_tag FROM dojo_riot_links l JOIN players p ON p.id = l.player_id WHERE l.discord_user_id = ?",
    )
      .bind(discordId)
      .first();

    if (existing) {
      const existingRiotId = `${existing.riot_name}#${existing.riot_tag}`;
      if (
        existing.riot_name.toLowerCase() !== parsedId.name.toLowerCase() ||
        existing.riot_tag.toLowerCase() !== parsedId.tag.toLowerCase()
      ) {
        return {
          ok: false,
          code: "ALREADY_LINKED",
          message: `Your Discord account is already linked to ${existingRiotId}.`,
          riot_id: existingRiotId,
        };
      }
    }

    const syncResult = await syncRiotAccount({
      env,
      name: parsedId.name,
      tag: parsedId.tag,
      requestedRegion,
      includeDiagnostics: false,
    });

    if (!syncResult.ok) {
      return syncResult;
    }

    const playerUsedBy = await env.DB.prepare(
      "SELECT discord_user_id FROM dojo_riot_links WHERE player_id = ? AND discord_user_id <> ?",
    )
      .bind(syncResult.puuid, discordId)
      .first();

    if (playerUsedBy) {
      return {
        ok: false,
        code: "RIOT_ACCOUNT_IN_USE",
        message: "That Riot account is already linked to another Discord account.",
      };
    }

    await env.DB.prepare(
      "INSERT INTO dojo_riot_links (discord_user_id, player_id, linked_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now')) ON CONFLICT(discord_user_id) DO UPDATE SET player_id = excluded.player_id, updated_at = datetime('now')",
    )
      .bind(discordId, syncResult.puuid)
      .run();

    await env.DB.prepare(
      "INSERT INTO dojo_members (discord_user_id, active, updated_at) VALUES (?, 1, datetime('now')) ON CONFLICT(discord_user_id) DO UPDATE SET active = 1, updated_at = datetime('now')",
    )
      .bind(discordId)
      .run();

    return {
      ...syncResult,
      linked: true,
      already_linked: Boolean(existing),
    };
  }

  async syncDiscordUser(discordUserId) {
    const env = this.env;
    requireReady(env);
    await ensureSchema(env.DB);
    const discordId = normalizeDiscordId(discordUserId);

    const link = await env.DB.prepare(
      "SELECT p.riot_name, p.riot_tag, p.region FROM dojo_riot_links l JOIN players p ON p.id = l.player_id WHERE l.discord_user_id = ?",
    )
      .bind(discordId)
      .first();

    if (!link) {
      return {
        ok: false,
        code: "NOT_LINKED",
        message: "No Riot account is linked. Use /linkriot first.",
      };
    }

    return syncRiotAccount({
      env,
      name: link.riot_name,
      tag: link.riot_tag,
      requestedRegion: link.region || "na",
      includeDiagnostics: false,
    });
  }

  async getDiscordUserStats(discordUserId) {
    const env = this.env;
    requireDb(env);
    await ensureSchema(env.DB);
    const discordId = normalizeDiscordId(discordUserId);

    const link = await env.DB.prepare(
      "SELECT l.player_id, p.riot_name, p.riot_tag, p.region, p.last_synced_at FROM dojo_riot_links l JOIN players p ON p.id = l.player_id WHERE l.discord_user_id = ?",
    )
      .bind(discordId)
      .first();

    if (!link) {
      return {
        ok: false,
        code: "NOT_LINKED",
        message: "No Riot account is linked. Use /linkriot first.",
      };
    }

    return getPlayerStats(env.DB, link.player_id, link);
  }

  async getLeaderboard(limit = 10) {
    const env = this.env;
    requireDb(env);
    await ensureSchema(env.DB);

    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
    const { monthStart, monthEnd, monthKey, monthLabel } = monthWindow();

    const rows = await env.DB.prepare(
      `WITH monthly AS (
        SELECT player_id, COALESCE(SUM(rr_change), 0) AS monthly_rr, COUNT(*) AS games_counted
        FROM rr_matches
        WHERE game_timestamp >= ? AND game_timestamp < ?
        GROUP BY player_id
      ), latest_time AS (
        SELECT player_id, MAX(game_timestamp) AS game_timestamp
        FROM rr_matches
        GROUP BY player_id
      ), latest AS (
        SELECT r.player_id, r.rank_name, r.rr_after
        FROM rr_matches r
        JOIN latest_time t ON t.player_id = r.player_id AND t.game_timestamp = r.game_timestamp
      )
      SELECT l.discord_user_id, p.riot_name, p.riot_tag,
             COALESCE(m.monthly_rr, 0) AS monthly_rr,
             COALESCE(m.games_counted, 0) AS games_counted,
             latest.rank_name AS current_rank,
             latest.rr_after AS current_rr,
             COALESCE(s.history_complete, 0) AS history_complete
      FROM dojo_riot_links l
      JOIN dojo_members dm ON dm.discord_user_id = l.discord_user_id AND dm.active = 1
      JOIN players p ON p.id = l.player_id
      LEFT JOIN monthly m ON m.player_id = l.player_id
      LEFT JOIN latest ON latest.player_id = l.player_id
      LEFT JOIN player_month_state s ON s.player_id = l.player_id AND s.month_key = ?
      ORDER BY monthly_rr DESC, games_counted DESC, p.riot_name COLLATE NOCASE ASC
      LIMIT ?`,
    )
      .bind(monthStart.toISOString(), monthEnd.toISOString(), monthKey, safeLimit)
      .all();

    return {
      ok: true,
      month: monthLabel,
      entries: (rows.results || []).map((row, index) => ({
        position: index + 1,
        discord_user_id: String(row.discord_user_id),
        riot_id: `${row.riot_name}#${row.riot_tag}`,
        monthly_rr: Number(row.monthly_rr || 0),
        games_counted: Number(row.games_counted || 0),
        current_rank: row.current_rank || null,
        current_rr: row.current_rr == null ? null : Number(row.current_rr),
        history_complete: Boolean(row.history_complete),
      })),
    };
  }
}

async function handleTestPlayer(url, env, cors) {
  try {
    requireReady(env);
    await ensureSchema(env.DB);

    const name = url.searchParams.get("name");
    const tag = url.searchParams.get("tag");
    const requestedRegion = (url.searchParams.get("region") || "na").toLowerCase();

    if (!name || !tag) {
      return jsonResponse(
        { error: "Missing params. Usage: /test-player?name=NAME&tag=TAG&region=na" },
        400,
        cors,
      );
    }

    const result = await syncRiotAccount({
      env,
      name,
      tag,
      requestedRegion,
      includeDiagnostics: true,
    });

    return jsonResponse(result, result.ok ? 200 : result.http_status || 502, cors);
  } catch (error) {
    return jsonResponse({ error: error.message || String(error) }, 500, cors);
  }
}

async function syncRiotAccount({ env, name, tag, requestedRegion = "na", includeDiagnostics }) {
  const diag = {
    steps: [],
    rate_limit_headers: {},
    raw_mmr_first_entry: null,
  };

  const accountUrl =
    `${HENRIK_API}/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  const accountRes = await fetchHenrik(accountUrl, env.HENRIK_API_KEY);
  recordRateLimitHeaders(accountRes, diag);
  const accountBody = await readJsonResponse(accountRes);

  diag.steps.push({
    step: "account_lookup",
    http_status: accountRes.status,
    top_level_keys: objectKeys(accountBody),
    data_keys: objectKeys(accountBody?.data),
  });

  if (accountRes.status === 429) {
    return rpcRateLimitResult("Account lookup rate limited", accountRes, diag);
  }

  if (!accountRes.ok || !accountBody?.data) {
    return {
      ok: false,
      code: "ACCOUNT_LOOKUP_FAILED",
      message: "Could not find that Riot account.",
      http_status: accountRes.status || 502,
      diagnostics: includeDiagnostics ? diag.steps : undefined,
    };
  }

  const puuid = accountBody.data.puuid;
  const resolvedRegion = String(accountBody.data.region || requestedRegion).toLowerCase();
  const riotName = accountBody.data.name || name;
  const riotTag = accountBody.data.tag || tag;

  if (!puuid) {
    return {
      ok: false,
      code: "NO_PUUID",
      message: "Henrik returned the account but no PUUID.",
      http_status: 502,
    };
  }

  await env.DB.prepare(
    "INSERT INTO players (id, riot_name, riot_tag, puuid, region, platform, created_at, updated_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now')) ON CONFLICT(id) DO UPDATE SET riot_name = excluded.riot_name, riot_tag = excluded.riot_tag, puuid = excluded.puuid, region = excluded.region, platform = excluded.platform, updated_at = datetime('now')",
  )
    .bind(puuid, riotName, riotTag, puuid, resolvedRegion, PLATFORM)
    .run();

  const historyResult = await fetchMmrHistory({
    region: resolvedRegion,
    puuid,
    apiKey: env.HENRIK_API_KEY,
    diag,
  });

  if (historyResult.rateLimited) {
    return rpcRateLimitResult("MMR history rate limited", historyResult.response, diag);
  }

  if (!historyResult.ok) {
    return {
      ok: false,
      code: "MMR_HISTORY_FAILED",
      message: "Could not retrieve your ranked RR history.",
      http_status: historyResult.response?.status || 502,
      diagnostics: includeDiagnostics ? diag.steps : undefined,
    };
  }

  const entries = historyResult.entries;
  if (entries.length > 0) {
    diag.raw_mmr_first_entry = entries[0];
    diag.steps.push({ step: "first_history_entry", keys: objectKeys(entries[0]) });
  }

  const optionalColumns = await ensureOptionalRrColumns(env.DB);
  let newMatchesImported = 0;
  let alreadyKnownMatches = 0;
  let skippedMatches = 0;
  const parsedMatches = [];

  for (const entry of entries) {
    const parsed = parseHistoryEntry(entry, historyResult.version, puuid);
    if (!parsed) {
      skippedMatches += 1;
      continue;
    }

    const inserted = await insertMatch(env.DB, parsed, puuid, optionalColumns);
    if (inserted) newMatchesImported += 1;
    else alreadyKnownMatches += 1;
    parsedMatches.push(parsed);
  }

  await env.DB.prepare(
    "UPDATE players SET updated_at = datetime('now'), last_synced_at = datetime('now') WHERE id = ?",
  )
    .bind(puuid)
    .run();

  await updateMonthState(env.DB, puuid, parsedMatches);
  const stats = await getPlayerStats(env.DB, puuid, {
    riot_name: riotName,
    riot_tag: riotTag,
    region: resolvedRegion,
  });

  return {
    ok: true,
    status: "success",
    riot_id: `${riotName}#${riotTag}`,
    puuid,
    region: resolvedRegion,
    platform: PLATFORM,
    current_rank: stats.current_rank,
    current_rr: stats.current_rr,
    month: stats.month,
    monthly_rr: stats.monthly_rr,
    games_counted: stats.games_counted,
    history_complete: stats.history_complete,
    history_start_at: stats.history_start_at,
    new_matches_imported: newMatchesImported,
    already_known_matches: alreadyKnownMatches,
    skipped_matches: skippedMatches,
    last_synced_at: stats.last_synced_at,
    endpoint: historyResult.endpoint,
    rate_limit_headers: diag.rate_limit_headers,
    diagnostics: includeDiagnostics ? diag.steps : undefined,
    raw_mmr_first_entry: includeDiagnostics ? diag.raw_mmr_first_entry : undefined,
    parsed_matches: includeDiagnostics ? parsedMatches : undefined,
  };
}

async function getPlayerStats(db, playerId, playerRow = null) {
  const { monthStart, monthEnd, monthKey, monthLabel } = monthWindow();
  const player =
    playerRow?.riot_name
      ? playerRow
      : await db.prepare(
          "SELECT riot_name, riot_tag, region, last_synced_at FROM players WHERE id = ?",
        )
          .bind(playerId)
          .first();

  const monthly = await db.prepare(
    "SELECT COALESCE(SUM(rr_change), 0) AS total_rr, COUNT(*) AS match_count FROM rr_matches WHERE player_id = ? AND game_timestamp >= ? AND game_timestamp < ?",
  )
    .bind(playerId, monthStart.toISOString(), monthEnd.toISOString())
    .first();

  const latest = await db.prepare(
    "SELECT rank_name, rr_after, game_timestamp FROM rr_matches WHERE player_id = ? ORDER BY game_timestamp DESC LIMIT 1",
  )
    .bind(playerId)
    .first();

  const state = await db.prepare(
    "SELECT history_complete, history_start_at FROM player_month_state WHERE player_id = ? AND month_key = ?",
  )
    .bind(playerId, monthKey)
    .first();

  return {
    ok: true,
    riot_id: player ? `${player.riot_name}#${player.riot_tag}` : null,
    region: player?.region || null,
    current_rank: latest?.rank_name || null,
    current_rr: latest?.rr_after == null ? null : Number(latest.rr_after),
    month: monthLabel,
    monthly_rr: Number(monthly?.total_rr || 0),
    games_counted: Number(monthly?.match_count || 0),
    history_complete: Boolean(state?.history_complete),
    history_start_at: state?.history_start_at || null,
    last_synced_at: player?.last_synced_at || null,
  };
}

async function updateMonthState(db, playerId, parsedMatches) {
  const { monthStart, monthEnd, monthKey } = monthWindow();
  const inMonth = parsedMatches
    .filter((match) => {
      const date = new Date(match.timestamp);
      return date >= monthStart && date < monthEnd;
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (inMonth.length === 0) return;

  const oldest = inMonth[0].timestamp;
  const windowComplete = new Date(oldest).getTime() <= monthStart.getTime();
  const current = await db.prepare(
    "SELECT history_complete, history_start_at FROM player_month_state WHERE player_id = ? AND month_key = ?",
  )
    .bind(playerId, monthKey)
    .first();

  const earliest =
    current?.history_start_at && new Date(current.history_start_at) < new Date(oldest)
      ? current.history_start_at
      : oldest;
  const complete = Boolean(current?.history_complete) || windowComplete;

  await db.prepare(
    "INSERT INTO player_month_state (player_id, month_key, history_complete, history_start_at, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(player_id, month_key) DO UPDATE SET history_complete = excluded.history_complete, history_start_at = excluded.history_start_at, updated_at = datetime('now')",
  )
    .bind(playerId, monthKey, complete ? 1 : 0, earliest)
    .run();
}

async function fetchMmrHistory({ region, puuid, apiKey, diag }) {
  const v2Endpoint = `/valorant/v2/by-puuid/mmr-history/${encodeURIComponent(region)}/${PLATFORM}/${encodeURIComponent(puuid)}`;
  const v2Res = await fetchHenrik(`${HENRIK_API}${v2Endpoint}`, apiKey);
  recordRateLimitHeaders(v2Res, diag);
  const v2Body = await readJsonResponse(v2Res);
  const v2History = Array.isArray(v2Body?.data?.history) ? v2Body.data.history : null;

  diag.steps.push({
    step: "mmr_history_v2",
    http_status: v2Res.status,
    top_level_keys: objectKeys(v2Body),
    data_keys: objectKeys(v2Body?.data),
    history_length: v2History?.length ?? 0,
  });

  if (v2Res.status === 429) {
    return { ok: false, rateLimited: true, response: v2Res, body: v2Body };
  }

  if (v2Res.ok && v2History) {
    return {
      ok: true,
      rateLimited: false,
      response: v2Res,
      body: v2Body,
      entries: v2History,
      endpoint: v2Endpoint,
      version: "v2",
    };
  }

  const v1Endpoint = `/valorant/v1/by-puuid/mmr-history/${encodeURIComponent(region)}/${encodeURIComponent(puuid)}`;
  const v1Res = await fetchHenrik(`${HENRIK_API}${v1Endpoint}`, apiKey);
  recordRateLimitHeaders(v1Res, diag);
  const v1Body = await readJsonResponse(v1Res);
  const v1History = Array.isArray(v1Body?.data) ? v1Body.data : null;

  diag.steps.push({
    step: "mmr_history_v1_fallback",
    http_status: v1Res.status,
    top_level_keys: objectKeys(v1Body),
    history_length: v1History?.length ?? 0,
  });

  if (v1Res.status === 429) {
    return { ok: false, rateLimited: true, response: v1Res, body: v1Body };
  }

  return {
    ok: Boolean(v1Res.ok && v1History),
    rateLimited: false,
    response: v1Res,
    body: v1Body,
    entries: v1History || [],
    endpoint: v1Endpoint,
    version: "v1",
  };
}

function parseHistoryEntry(entry, version, puuid) {
  const rrChange = toInteger(
    version === "v2"
      ? entry?.last_change
      : entry?.mmr_change_to_last_game ?? entry?.last_change,
    0,
  );
  const rankName =
    version === "v2"
      ? entry?.tier?.name ?? "Unknown"
      : entry?.currenttierpatched ?? entry?.current_tier ?? entry?.rank ?? "Unknown";
  const rrAfter = toInteger(
    version === "v2"
      ? entry?.rr
      : entry?.ranking_in_tier ?? entry?.ranked_rating ?? entry?.rr,
    0,
  );
  const dateValue =
    version === "v1"
      ? entry?.date_raw ?? entry?.date ?? entry?.timestamp ?? entry?.unix_timestamp
      : entry?.date ?? entry?.date_raw ?? entry?.timestamp;
  const gameDate = parseTimestamp(dateValue);
  if (!gameDate) return null;

  const rawTimestamp = dateValue == null ? null : String(dateValue);
  const matchId =
    entry?.match_id ??
    entry?.id ??
    `${puuid}_${gameDate.toISOString()}_${rrChange}_${rankName}`;

  return {
    match_id: String(matchId),
    rr_change: rrChange,
    rr_after: rrAfter,
    rank: String(rankName),
    timestamp: gameDate.toISOString(),
    raw_timestamp: rawTimestamp,
    refunded_rr: nullableInteger(entry?.refunded_rr),
    was_derank_protected:
      typeof entry?.was_derank_protected === "boolean"
        ? entry.was_derank_protected
        : null,
  };
}

async function insertMatch(db, parsed, playerId, columns) {
  let result;
  if (columns.has("refunded_rr") && columns.has("was_derank_protected")) {
    result = await db.prepare(
      "INSERT INTO rr_matches (match_id, player_id, rr_change, rr_after, rank_name, game_timestamp, raw_timestamp, refunded_rr, was_derank_protected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(match_id, player_id) DO NOTHING",
    )
      .bind(
        parsed.match_id,
        playerId,
        parsed.rr_change,
        parsed.rr_after,
        parsed.rank,
        parsed.timestamp,
        parsed.raw_timestamp,
        parsed.refunded_rr,
        parsed.was_derank_protected == null ? null : parsed.was_derank_protected ? 1 : 0,
      )
      .run();
  } else {
    result = await db.prepare(
      "INSERT INTO rr_matches (match_id, player_id, rr_change, rr_after, rank_name, game_timestamp, raw_timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(match_id, player_id) DO NOTHING",
    )
      .bind(
        parsed.match_id,
        playerId,
        parsed.rr_change,
        parsed.rr_after,
        parsed.rank,
        parsed.timestamp,
        parsed.raw_timestamp,
      )
      .run();
  }
  return Number(result?.meta?.changes || 0) > 0;
}

async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      riot_name TEXT NOT NULL,
      riot_tag TEXT NOT NULL,
      puuid TEXT NOT NULL,
      region TEXT NOT NULL,
      platform TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TEXT
    )`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS rr_matches (
      match_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      rr_change INTEGER NOT NULL,
      rr_after INTEGER,
      rank_name TEXT,
      game_timestamp TEXT NOT NULL,
      raw_timestamp TEXT,
      refunded_rr INTEGER,
      was_derank_protected INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (match_id, player_id)
    )`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS dojo_riot_links (
      discord_user_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL UNIQUE,
      linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS dojo_members (
      discord_user_id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS player_month_state (
      player_id TEXT NOT NULL,
      month_key TEXT NOT NULL,
      history_complete INTEGER NOT NULL DEFAULT 0,
      history_start_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (player_id, month_key)
    )`,
  ).run();

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_rr_matches_player_time ON rr_matches(player_id, game_timestamp)",
  ).run();

  await ensureOptionalRrColumns(db);
}

async function ensureOptionalRrColumns(db) {
  const info = await db.prepare("PRAGMA table_info(rr_matches)").all();
  const columns = new Set((info.results || []).map((row) => row.name));

  if (!columns.has("refunded_rr")) {
    try {
      await db.prepare("ALTER TABLE rr_matches ADD COLUMN refunded_rr INTEGER").run();
      columns.add("refunded_rr");
    } catch (error) {
      console.warn("Could not add refunded_rr column:", error);
    }
  }

  if (!columns.has("was_derank_protected")) {
    try {
      await db.prepare("ALTER TABLE rr_matches ADD COLUMN was_derank_protected INTEGER").run();
      columns.add("was_derank_protected");
    } catch (error) {
      console.warn("Could not add was_derank_protected column:", error);
    }
  }

  return columns;
}

async function getHealth(env) {
  const checks = {
    worker: "dojo-rr-tracker",
    status: "ok",
    d1_bound: Boolean(env.DB),
    henrik_api_key_set: Boolean(env.HENRIK_API_KEY),
  };

  if (!env.DB) return checks;

  try {
    await ensureSchema(env.DB);
    const p = await env.DB.prepare("SELECT COUNT(*) AS count FROM players").first();
    const m = await env.DB.prepare("SELECT COUNT(*) AS count FROM rr_matches").first();
    const l = await env.DB.prepare("SELECT COUNT(*) AS count FROM dojo_riot_links").first();
    const { monthStart, monthEnd } = monthWindow();
    const mo = await env.DB.prepare(
      "SELECT COALESCE(SUM(rr_change), 0) AS total_rr, COUNT(*) AS match_count FROM rr_matches WHERE game_timestamp >= ? AND game_timestamp < ?",
    )
      .bind(monthStart.toISOString(), monthEnd.toISOString())
      .first();

    checks.player_count = Number(p?.count || 0);
    checks.match_count = Number(m?.count || 0);
    checks.linked_discord_count = Number(l?.count || 0);
    checks.current_month_rr = Number(mo?.total_rr || 0);
    checks.current_month_matches = Number(mo?.match_count || 0);
  } catch (error) {
    checks.status = "degraded";
    checks.d1_error = error.message || String(error);
  }

  return checks;
}

async function fetchHenrik(url, apiKey) {
  return fetch(url, {
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
  });
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function recordRateLimitHeaders(response, diag) {
  for (const [key, value] of response.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower.includes("ratelimit") ||
      lower.includes("rate-limit") ||
      lower.includes("retry-after")
    ) {
      diag.rate_limit_headers[key] = value;
    }
  }
}

function rpcRateLimitResult(message, response, diag) {
  const retryAfter =
    response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset") || null;
  return {
    ok: false,
    code: "RATE_LIMITED",
    message,
    http_status: 429,
    retry_after: retryAfter,
    rate_limit_headers: diag.rate_limit_headers,
  };
}

function parseRiotId(value) {
  const input = String(value || "").trim();
  const separator = input.lastIndexOf("#");
  if (separator <= 0 || separator === input.length - 1) return null;
  const name = input.slice(0, separator).trim();
  const tag = input.slice(separator + 1).trim();
  if (!name || !tag) return null;
  return { name, tag };
}

function normalizeDiscordId(value) {
  const id = String(value || "").trim();
  if (!/^\d{10,25}$/.test(id)) {
    throw new Error("Invalid Discord user ID");
  }
  return id;
}

function monthWindow(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd = new Date(Date.UTC(year, month + 1, 1));
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthLabel = `${date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${year}`;
  return { monthStart, monthEnd, monthKey, monthLabel };
}

function parseTimestamp(value) {
  if (value == null) return null;
  let date;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    date = new Date(milliseconds);
  } else {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function toInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableInteger(value) {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectKeys(value) {
  return value && typeof value === "object" ? Object.keys(value) : [];
}

function requireDb(env) {
  if (!env.DB) throw new Error("D1 binding DB is not configured");
}

function requireReady(env) {
  requireDb(env);
  if (!env.HENRIK_API_KEY) throw new Error("HENRIK_API_KEY is not configured");
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...extraHeaders,
    },
  });
}

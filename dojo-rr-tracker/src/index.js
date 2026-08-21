const HENRIK_API = "https://api.henrikdev.xyz";
const PLATFORM = "pc";

export default {
  async fetch(request, env) {
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
      return handleHealth(env, cors);
    }

    return jsonResponse(
      {
        worker: "dojo-rr-tracker",
        status: "experimental",
        endpoints: {
          "GET /test-player?name=NAME&tag=TAG&region=na":
            "Look up a Riot account, sync recent competitive RR history into D1, and calculate the current month's net RR",
          "GET /health": "Health check",
        },
      },
      200,
      cors,
    );
  },
};

async function handleTestPlayer(url, env, cors) {
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

  if (!env.DB) {
    return jsonResponse({ error: "D1 binding DB is not configured" }, 500, cors);
  }

  if (!env.HENRIK_API_KEY) {
    return jsonResponse({ error: "HENRIK_API_KEY is not configured" }, 500, cors);
  }

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
    return rateLimitedResponse("Account lookup rate limited", accountRes, diag, cors);
  }

  if (!accountRes.ok || !accountBody?.data) {
    return jsonResponse(
      {
        error: "Account lookup failed",
        status: accountRes.status,
        diagnostics: diag,
        raw_response: accountBody,
      },
      502,
      cors,
    );
  }

  const puuid = accountBody.data.puuid;
  const resolvedRegion = String(accountBody.data.region || requestedRegion).toLowerCase();
  const riotName = accountBody.data.name || name;
  const riotTag = accountBody.data.tag || tag;

  if (!puuid) {
    return jsonResponse(
      { error: "No PUUID found", diagnostics: diag, raw_response: accountBody },
      502,
      cors,
    );
  }

  const playerId = puuid;
  const playerInfo = {
    name: riotName,
    tag: riotTag,
    puuid,
    region: resolvedRegion,
    platform: PLATFORM,
    account_level: accountBody.data.account_level ?? null,
    card: accountBody.data.card
      ? {
          small: accountBody.data.card.small ?? null,
          large: accountBody.data.card.large ?? null,
        }
      : null,
  };

  await env.DB.prepare(
    "INSERT INTO players (id, riot_name, riot_tag, puuid, region, platform, created_at, updated_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now')) ON CONFLICT(id) DO UPDATE SET riot_name = excluded.riot_name, riot_tag = excluded.riot_tag, puuid = excluded.puuid, region = excluded.region, platform = excluded.platform, updated_at = datetime('now')",
  )
    .bind(playerId, riotName, riotTag, puuid, resolvedRegion, PLATFORM)
    .run();

  const historyResult = await fetchMmrHistory({
    region: resolvedRegion,
    puuid,
    apiKey: env.HENRIK_API_KEY,
    diag,
  });

  if (historyResult.rateLimited) {
    return rateLimitedResponse(
      "MMR history rate limited",
      historyResult.response,
      diag,
      cors,
    );
  }

  if (!historyResult.ok) {
    return jsonResponse(
      {
        error: "MMR history failed on v2 and v1 fallback",
        diagnostics: diag,
        raw_response: historyResult.body,
      },
      502,
      cors,
    );
  }

  const entries = historyResult.entries;
  if (entries.length > 0) {
    diag.raw_mmr_first_entry = entries[0];
    diag.steps.push({
      step: "first_history_entry",
      keys: objectKeys(entries[0]),
    });
  }

  const optionalColumns = await ensureOptionalRrColumns(env.DB);

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthLabel = `${now.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${now.getUTCFullYear()}`;

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

    const inserted = await insertMatch(env.DB, parsed, playerId, optionalColumns);

    if (inserted) {
      newMatchesImported += 1;
    } else {
      alreadyKnownMatches += 1;
    }

    parsedMatches.push(parsed);
  }

  await env.DB.prepare(
    "UPDATE players SET updated_at = datetime('now'), last_synced_at = datetime('now') WHERE id = ?",
  )
    .bind(playerId)
    .run();

  const monthly = await env.DB.prepare(
    "SELECT COALESCE(SUM(rr_change), 0) AS total_rr, COUNT(*) AS match_count FROM rr_matches WHERE player_id = ? AND game_timestamp >= ? AND game_timestamp < ?",
  )
    .bind(playerId, monthStart.toISOString(), monthEnd.toISOString())
    .first();

  const playerRow = await env.DB.prepare(
    "SELECT last_synced_at FROM players WHERE id = ?",
  )
    .bind(playerId)
    .first();

  const sortedParsed = [...parsedMatches].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const newest = sortedParsed[0] || null;
  const oldest = sortedParsed[sortedParsed.length - 1] || null;

  const historyStartAt = oldest?.timestamp ?? null;
  const historyComplete = Boolean(
    oldest && new Date(oldest.timestamp).getTime() <= monthStart.getTime(),
  );

  return jsonResponse(
    {
      status: "success",
      riot_id: `${riotName}#${riotTag}`,
      puuid,
      region: resolvedRegion,
      platform: PLATFORM,
      current_rank: newest?.rank ?? null,
      current_rr: newest?.rr_after ?? null,
      month: monthLabel,
      monthly_rr: Number(monthly?.total_rr ?? 0),
      games_counted: Number(monthly?.match_count ?? 0),
      history_complete: historyComplete,
      history_start_at: historyStartAt,
      new_matches_imported: newMatchesImported,
      already_known_matches: alreadyKnownMatches,
      skipped_matches: skippedMatches,
      last_synced_at: playerRow?.last_synced_at ?? null,
      endpoint: historyResult.endpoint,
      rate_limit_headers: diag.rate_limit_headers,
      diagnostics: diag.steps,
      raw_mmr_first_entry: diag.raw_mmr_first_entry,
      parsed_matches: parsedMatches,
    },
    200,
    cors,
  );
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
    return {
      ok: false,
      rateLimited: true,
      response: v2Res,
      body: v2Body,
      entries: [],
      endpoint: v2Endpoint,
      version: "v2",
    };
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
    return {
      ok: false,
      rateLimited: true,
      response: v1Res,
      body: v1Body,
      entries: [],
      endpoint: v1Endpoint,
      version: "v1",
    };
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
  if (!gameDate) {
    return null;
  }

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
    result = await db
      .prepare(
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
        parsed.was_derank_protected == null
          ? null
          : parsed.was_derank_protected
            ? 1
            : 0,
      )
      .run();
  } else {
    result = await db
      .prepare(
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

  return Number(result?.meta?.changes ?? 0) > 0;
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
      await db
        .prepare("ALTER TABLE rr_matches ADD COLUMN was_derank_protected INTEGER")
        .run();
      columns.add("was_derank_protected");
    } catch (error) {
      console.warn("Could not add was_derank_protected column:", error);
    }
  }

  return columns;
}

async function handleHealth(env, cors) {
  const checks = {
    worker: "dojo-rr-tracker",
    status: "ok",
    d1_bound: Boolean(env.DB),
    henrik_api_key_set: Boolean(env.HENRIK_API_KEY),
  };

  if (env.DB) {
    try {
      const p = await env.DB.prepare("SELECT COUNT(*) as count FROM players").first();
      const m = await env.DB.prepare("SELECT COUNT(*) as count FROM rr_matches").first();
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const mo = await env.DB
        .prepare(
          "SELECT COALESCE(SUM(rr_change), 0) as total_rr, COUNT(*) as match_count FROM rr_matches WHERE game_timestamp >= ? AND game_timestamp < ?",
        )
        .bind(monthStart.toISOString(), monthEnd.toISOString())
        .first();

      checks.player_count = Number(p?.count ?? 0);
      checks.match_count = Number(m?.count ?? 0);
      checks.current_month_rr = Number(mo?.total_rr ?? 0);
      checks.current_month_matches = Number(mo?.match_count ?? 0);
    } catch (error) {
      checks.status = "degraded";
      checks.d1_error = error.message;
    }
  }

  return jsonResponse(checks, 200, cors);
}

async function fetchHenrik(url, apiKey) {
  return fetch(url, {
    headers: {
      Authorization: apiKey,
      Accept: "application/json",
    },
  });
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { non_json_body: text };
  }
}

function recordRateLimitHeaders(res, diag) {
  for (const [key, value] of res.headers.entries()) {
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

function rateLimitedResponse(message, response, diag, cors) {
  return jsonResponse(
    {
      error: message,
      status: 429,
      retry_after: response.headers.get("retry-after"),
      rate_limit_headers: diag.rate_limit_headers,
      diagnostics: diag.steps,
    },
    429,
    cors,
  );
}

function parseTimestamp(value) {
  if (value == null) return null;

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(String(value));
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

function jsonResponse(body, status, cors) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(cors || {}),
    },
  });
}

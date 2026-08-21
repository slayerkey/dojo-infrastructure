export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/test-player") return handleTestPlayer(url, env, cors);
    if (url.pathname === "/health") return handleHealth(env, cors);
    return jsonResponse({ worker: "dojo-rr-tracker", status: "experimental", endpoints: { "GET /test-player?name=NAME&tag=TAG&region=na": "Look up player, fetch MMR history, store in D1, calculate net monthly RR", "GET /health": "Health check" } }, 200, cors);
  }
};

async function handleTestPlayer(url, env, cors) {
  const name = url.searchParams.get("name");
  const tag = url.searchParams.get("tag");
  const region = (url.searchParams.get("region") || "na").toLowerCase();
  if (!name || !tag) return jsonResponse({ error: "Missing params. Usage: /test-player?name=NAME&tag=TAG&region=na" }, 400, cors);
  if (!env.HENRIK_API_KEY) return jsonResponse({ error: "HENRIK_API_KEY not set. Add it in dashboard: Workers & Pages > dojo-rr-tracker > Settings > Variables and Secrets." }, 500, cors);
  const diag = { steps: [], rate_limit_headers: {}, raw_account_response: null, raw_mmr_first_entry: null };
  const HB = "https://api.henrikdev.xyz";
  const accountUrl = HB + "/valorant/v1/account/" + encodeURIComponent(name) + "/" + encodeURIComponent(tag);
  const accountRes = await fetchHenrik(accountUrl, env.HENRIK_API_KEY);
  recordRateLimitHeaders(accountRes, diag);
  let accountBody;
  try { accountBody = await accountRes.json(); } catch { const t = await accountRes.text(); return jsonResponse({ error: "Account lookup non-JSON", status: accountRes.status, body: t, diagnostics: diag }, 502, cors); }
  diag.steps.push({ step: "A_account_lookup", http_status: accountRes.status, top_level_keys: Object.keys(accountBody), data_keys: accountBody.data ? Object.keys(accountBody.data) : null });
  diag.raw_account_response = accountBody;
  if (!accountRes.ok || !accountBody.data) return jsonResponse({ error: "Account lookup failed", diagnostics: diag, raw_response: accountBody }, 502, cors);
  const puuid = accountBody.data.puuid;
  const resolvedRegion = accountBody.data.region || region;
  const riotName = accountBody.data.name || name;
  const riotTag = accountBody.data.tag || tag;
  if (!puuid) return jsonResponse({ error: "No PUUID found", diagnostics: diag, raw_response: accountBody }, 502, cors);
  const playerInfo = { name: riotName, tag: riotTag, puuid, region: resolvedRegion, account_level: accountBody.data.account_level ?? null, card: accountBody.data.card ? { small: accountBody.data.card.small, large: accountBody.data.card.large } : null };
  const playerId = puuid;
  await env.DB.prepare("INSERT INTO players (id, riot_name, riot_tag, puuid, region, platform, created_at, updated_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now')) ON CONFLICT(id) DO UPDATE SET riot_name = excluded.riot_name, riot_tag = excluded.riot_tag, puuid = excluded.puuid, region = excluded.region, platform = excluded.platform, updated_at = datetime('now'), last_synced_at = datetime('now')").bind(playerId, riotName, riotTag, puuid, resolvedRegion, "pc").run();
  const v3Url = HB + "/valorant/v3/by-puuid/mmr-history/" + resolvedRegion + "/" + puuid;
  let mmrRes = await fetchHenrik(v3Url, env.HENRIK_API_KEY);
  recordRateLimitHeaders(mmrRes, diag);
  let mmrBody;
  try { mmrBody = await mmrRes.json(); } catch { const t = await mmrRes.text(); return jsonResponse({ error: "MMR history non-JSON", status: mmrRes.status, body: t, diagnostics: diag }, 502, cors); }
  let mmrEndpointUsed = "v3/by-puuid/mmr-history";
  diag.steps.push({ step: "C_mmr_history_v3", http_status: mmrRes.status, top_level_keys: Object.keys(mmrBody), data_type: Array.isArray(mmrBody.data) ? "array" : typeof mmrBody.data, data_length: Array.isArray(mmrBody.data) ? mmrBody.data.length : (mmrBody.data ? Object.keys(mmrBody.data).length : 0) });
  if (!mmrRes.ok || !mmrBody.data) {
    const v1Url = HB + "/valorant/v1/mmr-history/" + resolvedRegion + "/" + encodeURIComponent(name) + "/" + encodeURIComponent(tag);
    mmrRes = await fetchHenrik(v1Url, env.HENRIK_API_KEY);
    recordRateLimitHeaders(mmrRes, diag);
    try { mmrBody = await mmrRes.json(); } catch { const t = await mmrRes.text(); return jsonResponse({ error: "MMR v1 non-JSON", status: mmrRes.status, body: t, diagnostics: diag }, 502, cors); }
    mmrEndpointUsed = "v1/mmr-history";
    diag.steps.push({ step: "C_mmr_history_v1_fallback", http_status: mmrRes.status, top_level_keys: Object.keys(mmrBody), data_type: Array.isArray(mmrBody.data) ? "array" : typeof mmrBody.data, data_length: Array.isArray(mmrBody.data) ? mmrBody.data.length : (mmrBody.data ? Object.keys(mmrBody.data).length : 0) });
  }
  if (!mmrRes.ok || !mmrBody.data) return jsonResponse({ error: "MMR history failed on all endpoints", diagnostics: diag, raw_response: mmrBody }, 502, cors);
  const entries = Array.isArray(mmrBody.data) ? mmrBody.data : [mmrBody.data];
  if (entries.length > 0) { diag.raw_mmr_first_entry = entries[0]; diag.steps.push({ step: "D_first_entry_keys", keys: Object.keys(entries[0]) }); }
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthName = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  let monthlyRR = 0, storedCount = 0, inMonthCount = 0, skippedCount = 0;
  const parsedMatches = [];
  for (const entry of entries) {
    const rrChange = parseInt(entry.mmr_change_to_last_game ?? entry.last_change ?? entry.rr_change ?? entry.change ?? entry.ranked_rating_change ?? 0, 10);
    const rankName = entry.current_tier ?? entry.tier ?? entry.rank ?? entry.current_rank ?? "Unknown";
    const rrAfter = parseInt(entry.ranking_in_tier ?? entry.ranked_rating ?? entry.elo ?? entry.current_elo ?? entry.rr ?? 0, 10);
    let gameDate = null, rawTimestamp = null;
    if (entry.date) { gameDate = new Date(entry.date); rawTimestamp = String(entry.date); }
    else if (entry.season_time) { gameDate = new Date(Number(entry.season_time)); rawTimestamp = String(entry.season_time); }
    else if (entry.timestamp) { gameDate = new Date(entry.timestamp); rawTimestamp = String(entry.timestamp); }
    else if (entry.unix_timestamp) { gameDate = new Date(Number(entry.unix_timestamp)); rawTimestamp = String(entry.unix_timestamp); }
    if (!gameDate || isNaN(gameDate.getTime())) { skippedCount++; continue; }
    const matchId = entry.match_id ?? entry.id ?? (puuid + "_" + rawTimestamp + "_" + rrChange + "_" + rankName);
    const gameTimestamp = gameDate.toISOString();
    const inMonth = gameDate >= monthStart && gameDate < monthEnd;
    if (inMonth) { monthlyRR += rrChange; inMonthCount++; }
    try { const result = await env.DB.prepare("INSERT INTO rr_matches (match_id, player_id, rr_change, rr_after, rank_name, game_timestamp, raw_timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(match_id, player_id) DO NOTHING").bind(matchId, playerId, rrChange, rrAfter, rankName, gameTimestamp, rawTimestamp).run(); if (result.meta && result.meta.changes > 0) storedCount++; } catch (e) {}
    parsedMatches.push({ match_id: matchId, rr_change: rrChange, rr_after: rrAfter, rank: rankName, timestamp: gameTimestamp, in_current_month: inMonth });
  }
  return jsonResponse({ status: "success", player: playerInfo, month: monthName + " " + now.getUTCFullYear(), monthly_rr: monthlyRR, matches_in_month: inMonthCount, total_matches_returned: entries.length, matches_stored_this_run: storedCount, matches_skipped: skippedCount, mmr_endpoint_used: mmrEndpointUsed, rate_limit_headers: diag.rate_limit_headers, diagnostics: diag.steps, raw_account_response: diag.raw_account_response, raw_mmr_first_entry: diag.raw_mmr_first_entry, parsed_matches: parsedMatches }, 200, cors);
}

async function handleHealth(env, cors) {
  const checks = { worker: "dojo-rr-tracker", status: "ok", d1_bound: !!env.DB, henrik_api_key_set: !!env.HENRIK_API_KEY };
  if (env.DB) {
    try {
      const p = await env.DB.prepare("SELECT COUNT(*) as count FROM players").all();
      checks.player_count = p.results[0] ? p.results[0].count : 0;
      const m = await env.DB.prepare("SELECT COUNT(*) as count FROM rr_matches").all();
      checks.match_count = m.results[0] ? m.results[0].count : 0;
      const now = new Date();
      const mo = await env.DB.prepare("SELECT COALESCE(SUM(rr_change), 0) as total_rr, COUNT(*) as match_count FROM rr_matches WHERE game_timestamp >= ? AND game_timestamp < ?").bind(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()).all();
      checks.current_month_rr = mo.results[0] ? mo.results[0].total_rr : 0;
      checks.current_month_matches = mo.results[0] ? mo.results[0].match_count : 0;
    } catch (e) { checks.d1_error = e.message; }
  }
  return jsonResponse(checks, 200, cors);
}

async function fetchHenrik(url, apiKey) {
  return fetch(url, { headers: { Authorization: apiKey, "Content-Type": "application/json" } });
}

function recordRateLimitHeaders(res, diag) {
  for (const [key, value] of res.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower.includes("ratelimit") || lower.includes("rate-limit") || lower.includes("retry-after")) diag.rate_limit_headers[key] = value;
  }
}

function jsonResponse(body, status, cors) {
  return new Response(JSON.stringify(body, null, 2), { status: status || 200, headers: { "Content-Type": "application/json", ...(cors || {}) } });
}

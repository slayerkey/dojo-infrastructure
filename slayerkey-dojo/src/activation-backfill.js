import { ACTIVATION_DESTINATIONS, MEMBER_PREFIX, STORAGE_PREFIX, applyActivationMessage, mergeTenureIntoRecord, seedTenureRecords } from "./activation-core.js";
import { identityFromGuildMember, identityFromMessage, mergeIdentityIntoRecord } from "./activation-v40-core.js";

const DISCORD_API = "https://discord.com/api/v10";
const BACKFILL_KEY = `${STORAGE_PREFIX}backfill`;
const BACKFILL_VERSION = 4;
const ROADMAP_CONFIG_KEY = "roadmap:v41:config";

export async function beginActivationBackfill(gateway) {
  let state = await gateway.ctx.storage.get(BACKFILL_KEY);
  if (!state || Number(state.version || 0) < BACKFILL_VERSION || state.status === "complete") state = freshState();
  else state = { ...state, status: "running", last_error: null, updated_at: new Date().toISOString() };
  await gateway.ctx.storage.put(BACKFILL_KEY, state);
  return state;
}

export async function getActivationBackfillStatus(gateway) {
  return (await gateway.ctx.storage.get(BACKFILL_KEY)) || { ...freshState(), status: "idle" };
}

export async function processActivationBackfillBatch(gateway) {
  let state = await gateway.ctx.storage.get(BACKFILL_KEY);
  // v4 is a one-time automatic reconciliation. Older completed backfills did not
  // seed every current Dojo-role member and therefore skipped their history.
  if (!state || Number(state.version || 0) < BACKFILL_VERSION) {
    state = freshState();
    await gateway.ctx.storage.put(BACKFILL_KEY, state);
  }
  if (state.status !== "running") return state;
  const pauseUntil = Date.parse(state.rate_limit_until || "");
  if (Number.isFinite(pauseUntil) && pauseUntil > Date.now()) return state;
  if (state.rate_limit_until) state.rate_limit_until = null;

  for (let step = 0; step < 3 && state.status === "running"; step += 1) {
    try {
      state = await processUnit(gateway, state);
    } catch (error) {
      if (error instanceof DiscordRateLimitError) {
        state.rate_limit_until = new Date(Date.now() + error.retryAfterMs).toISOString();
        state.updated_at = new Date().toISOString();
        await gateway.ctx.storage.put(BACKFILL_KEY, state);
        return state;
      }
      state.status = "error";
      state.last_error = safeError(error);
      state.updated_at = new Date().toISOString();
      await gateway.ctx.storage.put(BACKFILL_KEY, state);
      return state;
    }
  }
  return state;
}

async function processUnit(gateway, state) {
  if (state.phase === "seed") {
    state.seeded_tenure_members = await seedTenureRecords(gateway);
    state.seeded_role_members = await seedCurrentDojoRoleMembers(gateway);
    state.seeded_members = Math.max(state.seeded_tenure_members, state.seeded_role_members);
    state.destinations = await historicalDestinations(gateway);
    state.phase = "discover";
    state.updated_at = new Date().toISOString();
    await save(gateway, state);
    return state;
  }
  if (state.phase === "discover") return discoverSource(gateway, state);
  if (state.phase === "scan") return scanSource(gateway, state);
  if (state.phase === "riot") return observeRiotBatch(gateway, state);
  state.status = "complete"; state.phase = "complete"; state.completed_at = new Date().toISOString(); state.updated_at = state.completed_at;
  await save(gateway, state); return state;
}

async function discoverSource(gateway, state) {
  const destinations = Array.isArray(state.destinations) && state.destinations.length
    ? state.destinations
    : Object.entries(ACTIVATION_DESTINATIONS).map(([key, id]) => ({ key, id: String(id) }));
  if (state.destination_index >= destinations.length) {
    state.phase = "scan"; state.source_index = 0; state.message_before = null; state.discovery = null;
    state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
  }
  const destination = destinations[state.destination_index];
  const destinationKey = String(destination?.key || "");
  const destinationId = String(destination?.id || "");
  if (!state.discovery) {
    const channel = await discordRequest(`${DISCORD_API}/channels/${destinationId}`, gateway.env);
    const type = Number(channel?.type);
    if (type !== 15 && type !== 16) {
      addSource(state, { id: destinationId, destination_key: destinationKey, thread_owner_id: null, parent_id: null });
      state.destination_index += 1; state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
    }
    const active = await discordRequest(`${DISCORD_API}/guilds/${gateway.env.DISCORD_GUILD_ID}/threads/active`, gateway.env);
    for (const thread of Array.isArray(active?.threads) ? active.threads : []) {
      if (String(thread?.parent_id || "") === String(destinationId)) addSource(state, threadSource(thread, destinationKey, destinationId));
    }
    state.discovery = { destination_key: destinationKey, destination_id: String(destinationId), archived_before: null };
    state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
  }

  const q = new URLSearchParams({ limit: "100" });
  if (state.discovery.archived_before) q.set("before", state.discovery.archived_before);
  const page = await discordRequest(`${DISCORD_API}/channels/${state.discovery.destination_id}/threads/archived/public?${q}`, gateway.env);
  const threads = Array.isArray(page?.threads) ? page.threads : [];
  for (const thread of threads) addSource(state, threadSource(thread, state.discovery.destination_key, state.discovery.destination_id));
  if (page?.has_more && threads.length) {
    const last = threads[threads.length - 1];
    const next = last?.thread_metadata?.archive_timestamp || last?.archive_timestamp || null;
    if (!next || next === state.discovery.archived_before) throw new Error(`Could not advance archived thread cursor for ${state.discovery.destination_id}`);
    state.discovery.archived_before = next;
  } else {
    state.discovery = null; state.destination_index += 1;
  }
  state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
}

async function scanSource(gateway, state) {
  if (state.source_index >= state.sources.length) {
    state.phase = "riot"; state.riot_index = 0; state.message_before = null; state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
  }
  const source = state.sources[state.source_index];
  const q = new URLSearchParams({ limit: "100" });
  if (state.message_before) q.set("before", state.message_before);
  const messages = await discordRequest(`${DISCORD_API}/channels/${source.id}/messages?${q}`, gateway.env);
  const page = Array.isArray(messages) ? messages : [];
  for (const message of page) {
    if (!message?.author?.id || message.author.bot) continue;
    const userId = String(message.author.id);
    const key = `${MEMBER_PREFIX}${userId}`;
    const record = await gateway.ctx.storage.get(key);

    // The seed phase is the membership cohort boundary. Historical channel
    // participants who are not in that seeded cohort must never become activation
    // members merely because they posted in one of these Discord destinations.
    if (!record) continue;

    let next = applyActivationMessage(record, {
      message,
      destinationKey: source.destination_key,
      threadOwnerId: source.thread_owner_id,
      isThread: Boolean(source.parent_id),
      communitySource: ["community-help", "clips"].includes(String(source.destination_key || ""))
        ? String(source.destination_key)
        : null,
    });
    if (!next.activation_started_at && message.timestamp) {
      next.unknown_anchor_activity_seen_at = earliestHistoricalIso(next.unknown_anchor_activity_seen_at, message.timestamp);
    }
    next.updated_at = new Date().toISOString();
    await gateway.ctx.storage.put(key, next);
  }
  state.processed_messages += page.length;
  if (page.length < 100) {
    state.source_index += 1; state.processed_sources += 1; state.message_before = null;
  } else {
    const lastId = String(page[page.length - 1]?.id || "");
    if (!lastId || lastId === state.message_before) throw new Error(`Could not advance message cursor for ${source.id}`);
    state.message_before = lastId;
  }
  state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
}

async function observeRiotBatch(gateway, state) {
  const entries = [...(await gateway.ctx.storage.list({ prefix: MEMBER_PREFIX })).entries()];
  if (state.riot_index >= entries.length) {
    state.phase = "complete"; state.status = "complete"; state.completed_at = new Date().toISOString(); state.updated_at = state.completed_at; await save(gateway, state); return state;
  }
  for (const [key, value] of entries.slice(state.riot_index, state.riot_index + 10)) {
    const userId = String(key).slice(MEMBER_PREFIX.length);
    const result = await gateway.env.RR_TRACKER?.getCurrentRiotLink?.(userId).catch(() => null);
    const next = { ...(value || {}), riot_link_checked_at: new Date().toISOString(), riot_linked_current: Boolean(result?.ok) };
    if (result?.ok && !next.riot_linked_observed_at) {
      next.riot_linked_observed_at = next.riot_link_checked_at;
      next.riot_linked_source = "historical_current_state_observed";
    }
    next.updated_at = new Date().toISOString(); await gateway.ctx.storage.put(key, next);
  }
  state.riot_index += Math.min(10, entries.length - state.riot_index); state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
}

function freshState() {
  const now = new Date().toISOString();
  return { version: BACKFILL_VERSION, status: "running", phase: "seed", destination_index: 0, discovery: null, destinations: [], sources: [], source_index: 0,
    message_before: null, riot_index: 0, seeded_members: 0, seeded_tenure_members: 0, seeded_role_members: 0,
    processed_messages: 0, processed_sources: 0, rate_limit_until: null,
    last_error: null, started_at: now, completed_at: null, updated_at: now };
}
async function seedCurrentDojoRoleMembers(gateway) {
  const env = gateway.env || {};
  const guildId = String(env.DISCORD_GUILD_ID || "");
  const dojoRoleId = String(env.DISCORD_DOJO_ROLE_ID || "");
  if (!guildId || !dojoRoleId || !env.DISCORD_BOT_TOKEN) return 0;

  let after = "0";
  let count = 0;
  while (true) {
    const page = await discordRequest(
      `${DISCORD_API}/guilds/${guildId}/members?limit=1000&after=${encodeURIComponent(after)}`,
      env,
    );
    if (!Array.isArray(page)) break;
    for (const member of page) {
      const userId = String(member?.user?.id || "");
      const roles = Array.isArray(member?.roles) ? member.roles.map(String) : [];
      if (!userId || member?.user?.bot || !roles.includes(dojoRoleId)) continue;

      const key = `${MEMBER_PREFIX}${userId}`;
      const [current, tenure] = await Promise.all([
        gateway.ctx.storage.get(key),
        gateway.getTenureRecord?.(userId).catch(() => null),
      ]);
      let next = mergeTenureIntoRecord(current, userId, tenure);
      next = mergeIdentityIntoRecord(next, identityFromGuildMember(member));
      if (!tenure) {
        next.membership_active = true;
        next.cohort_source = next.cohort_source || "discord_dojo_role";
      }
      next.current_dojo_role_observed_at = new Date().toISOString();
      if (member?.joined_at && Number.isFinite(Date.parse(member.joined_at))) {
        next.discord_joined_at_evidence = new Date(member.joined_at).toISOString();
      }
      await gateway.ctx.storage.put(key, next);
      count += 1;
    }
    if (page.length < 1000) break;
    const last = String(page[page.length - 1]?.user?.id || "");
    if (!last || last === after) break;
    after = last;
  }
  return count;
}

async function historicalDestinations(gateway) {
  const result = [];
  const seen = new Set();
  for (const [key, id] of Object.entries(ACTIVATION_DESTINATIONS)) {
    const value = String(id || "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push({ key, id: value });
  }

  const config = await gateway.ctx.storage.get(ROADMAP_CONFIG_KEY).catch(() => null);
  for (const key of ["community_help", "clips"]) {
    const id = String(config?.channels?.[key] || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ key: key.replace("_", "-"), id });
  }
  return result;
}

function earliestHistoricalIso(a, b) {
  const av = a && Number.isFinite(Date.parse(a)) ? new Date(a).toISOString() : null;
  const bv = b && Number.isFinite(Date.parse(b)) ? new Date(b).toISOString() : null;
  if (!av) return bv;
  if (!bv) return av;
  return Date.parse(av) <= Date.parse(bv) ? av : bv;
}

function threadSource(thread, key, parent) { return { id: String(thread.id), destination_key: key, thread_owner_id: thread?.owner_id ? String(thread.owner_id) : null, parent_id: String(parent) }; }
function addSource(state, source) { if (source?.id && !state.sources.some((s) => String(s.id) === String(source.id))) state.sources.push(source); }
async function save(gateway, state) { await gateway.ctx.storage.put(BACKFILL_KEY, state); }

async function discordRequest(url, env, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (response.status === 429) {
    let body = null; try { body = await response.json(); } catch {}
    throw new DiscordRateLimitError(getRetryAfterMs(body, response.headers));
  }
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 240)}`);
  return response.status === 204 ? null : response.json();
}

export class DiscordRateLimitError extends Error { constructor(retryAfterMs) { super(`Discord rate limited for ${retryAfterMs}ms`); this.name = "DiscordRateLimitError"; this.retryAfterMs = retryAfterMs; } }
export function getRetryAfterMs(body, headers) {
  const bodySeconds = Number(body?.retry_after); const headerSeconds = Number(headers?.get?.("X-RateLimit-Reset-After"));
  const seconds = Math.max(Number.isFinite(bodySeconds) ? bodySeconds : 0, Number.isFinite(headerSeconds) ? headerSeconds : 0, 1);
  return Math.ceil(seconds * 1000);
}
function safeError(error) { return String(error?.message || error || "Unknown error").slice(0, 300); }

export const __test = Object.freeze({ getRetryAfterMs, historicalDestinations, seedCurrentDojoRoleMembers });

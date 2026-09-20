import { ACTIVATION_DESTINATIONS, MEMBER_PREFIX, STORAGE_PREFIX, applyActivationMessage, mergeTenureIntoRecord, seedTenureRecords } from "./activation-core.js";

const DISCORD_API = "https://discord.com/api/v10";
const BACKFILL_KEY = `${STORAGE_PREFIX}backfill`;

export async function beginActivationBackfill(gateway) {
  let state = await gateway.ctx.storage.get(BACKFILL_KEY);
  if (!state || state.status === "complete") state = freshState();
  else state = { ...state, status: "running", last_error: null, updated_at: new Date().toISOString() };
  await gateway.ctx.storage.put(BACKFILL_KEY, state);
  return state;
}

export async function getActivationBackfillStatus(gateway) {
  return (await gateway.ctx.storage.get(BACKFILL_KEY)) || { ...freshState(), status: "idle" };
}

export async function processActivationBackfillBatch(gateway) {
  let state = await gateway.ctx.storage.get(BACKFILL_KEY);
  if (!state || state.status !== "running") return state || null;
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
    state.seeded_members = await seedTenureRecords(gateway);
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
  const destinations = Object.entries(ACTIVATION_DESTINATIONS);
  if (state.destination_index >= destinations.length) {
    state.phase = "scan"; state.source_index = 0; state.message_before = null; state.discovery = null;
    state.updated_at = new Date().toISOString(); await save(gateway, state); return state;
  }
  const [destinationKey, destinationId] = destinations[state.destination_index];
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

    let next = record;
    if (!next.activation_started_at) {
      if (message.timestamp && (!next.unknown_anchor_activity_seen_at || Date.parse(message.timestamp) < Date.parse(next.unknown_anchor_activity_seen_at))) {
        next = { ...next, unknown_anchor_activity_seen_at: new Date(message.timestamp).toISOString() };
      }
    } else {
      next = applyActivationMessage(next, { message, destinationKey: source.destination_key, threadOwnerId: source.thread_owner_id });
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
  return { version: 3, status: "running", phase: "seed", destination_index: 0, discovery: null, sources: [], source_index: 0,
    message_before: null, riot_index: 0, seeded_members: 0, processed_messages: 0, processed_sources: 0, rate_limit_until: null,
    last_error: null, started_at: now, completed_at: null, updated_at: now };
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

export const __test = Object.freeze({ getRetryAfterMs });

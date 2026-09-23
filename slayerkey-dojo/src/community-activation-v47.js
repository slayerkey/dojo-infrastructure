import {
  ACTIVATION_DESTINATIONS,
  MEMBER_PREFIX,
  earliestIso,
  mergeTenureIntoRecord,
} from "./activation-core.js";
import {
  identityFromMessage,
  mergeIdentityIntoRecord,
} from "./activation-v40-core.js";

const DISCORD_API = "https://discord.com/api/v10";
const ROADMAP_CONFIG_KEY = "roadmap:v41:config";
const COMMUNITY_THREAD_PREFIX = "community:v47:thread:";
const TASK_STAGE_PREFIX = "taskstage:v47:member:";
const TASK_TAG_CACHE_KEY = "taskstage:v47:tags";
const TASK_SCAN_STATE_KEY = "taskstage:v47:last-scan";

export async function observeV47Message(gateway, message) {
  const userId = String(message?.author?.id || "");
  if (!userId || message?.author?.bot) return { ok: false, reason: "not_human" };

  const timestamp = normalizeIso(message?.timestamp);
  if (!timestamp) return { ok: false, reason: "invalid_timestamp" };

  const tenure = await gateway.getTenureRecord?.(userId).catch(() => null);
  const key = `${MEMBER_PREFIX}${userId}`;
  let record = await gateway.ctx.storage.get(key);
  if (!record && !tenure) return { ok: false, reason: "not_known_dojo_member" };

  record = mergeTenureIntoRecord(record, userId, tenure);
  record = mergeIdentityIntoRecord(record, identityFromMessage(message));

  const anchor = normalizeIso(record.activation_started_at);
  if (!anchor || Date.parse(timestamp) < Date.parse(anchor)) return { ok: false, reason: "before_anchor" };

  let changed = false;
  if (!record.first_any_message_at) {
    record.first_any_message_at = timestamp;
    changed = true;
  }

  const community = await isCommunityMessage(gateway, message);
  if (community && !record.first_community_message_at) {
    record.first_community_message_at = timestamp;
    record.first_community_message_source = community;
    changed = true;
  }

  if (changed) {
    record.updated_at = new Date().toISOString();
    await gateway.ctx.storage.put(key, record);
  }

  return {
    ok: true,
    changed,
    any_message: Boolean(record.first_any_message_at),
    community_message: Boolean(record.first_community_message_at),
  };
}

async function isCommunityMessage(gateway, message) {
  const config = await gateway.ctx.storage.get(ROADMAP_CONFIG_KEY);
  const channels = config?.channels || {};
  const communityIds = new Map([
    [String(channels.general || ACTIVATION_DESTINATIONS.general || ""), "general"],
    [String(channels.community_help || ""), "community-help"],
    [String(channels.clips || ""), "clips"],
  ].filter(([id]) => id));

  const channelId = String(message?.channel_id || "");
  if (!channelId) return null;
  if (communityIds.has(channelId)) return communityIds.get(channelId);

  const cacheKey = `${COMMUNITY_THREAD_PREFIX}${channelId}`;
  let parentId = await gateway.ctx.storage.get(cacheKey);
  if (parentId === null || parentId === undefined) {
    const channel = await discordJson(`${DISCORD_API}/channels/${channelId}`, gateway.env).catch(() => null);
    parentId = channel?.parent_id ? String(channel.parent_id) : "";
    await gateway.ctx.storage.put(cacheKey, parentId);
  }
  return communityIds.get(String(parentId || "")) || null;
}

export async function observeTaskThreadV47(gateway, thread) {
  const parentId = String(thread?.parent_id || "");
  if (parentId !== String(ACTIVATION_DESTINATIONS.training)) return { ok: false, reason: "not_training_forum" };

  const ownerId = String(thread?.owner_id || "");
  if (!ownerId) return { ok: false, reason: "missing_owner" };

  const tagMap = await getTaskTagMap(gateway);
  const applied = Array.isArray(thread?.applied_tags) ? thread.applied_tags.map(String) : [];
  const stages = applied
    .map((tagId) => {
      const label = tagMap[tagId] || null;
      const parsed = parseTaskStage(label);
      return parsed ? { ...parsed, tag_id: tagId } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.stage - a.stage);

  const highest = stages[0];
  if (!highest) return { ok: false, reason: "no_task_stage_tag" };

  const key = `${TASK_STAGE_PREFIX}${ownerId}`;
  const previous = await gateway.ctx.storage.get(key);
  if (Number(previous?.stage || 0) > highest.stage) {
    return { ok: true, changed: false, stage: previous };
  }

  const next = {
    discord_user_id: ownerId,
    stage: highest.stage,
    label: highest.label,
    tag_id: highest.tag_id,
    thread_id: String(thread?.id || ""),
    observed_at: new Date().toISOString(),
  };
  await gateway.ctx.storage.put(key, next);
  return { ok: true, changed: true, stage: next };
}

export async function scanTaskStagesV47(gateway) {
  const env = gateway.env;
  const forumId = String(ACTIVATION_DESTINATIONS.training);
  const guildId = String(env?.DISCORD_GUILD_ID || "");
  if (!env?.DISCORD_BOT_TOKEN || !guildId) throw new Error("Discord bot configuration is missing.");

  await getTaskTagMap(gateway, { force: true });

  let scanned = 0;
  let matched = 0;
  const seen = new Set();

  const active = await discordJson(`${DISCORD_API}/guilds/${guildId}/threads/active`, env);
  for (const thread of Array.isArray(active?.threads) ? active.threads : []) {
    if (String(thread?.parent_id || "") !== forumId || seen.has(String(thread?.id || ""))) continue;
    seen.add(String(thread.id));
    scanned += 1;
    const result = await observeTaskThreadV47(gateway, thread);
    if (result?.ok) matched += 1;
  }

  let before = null;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);
    const archive = await discordJson(
      `${DISCORD_API}/channels/${forumId}/threads/archived/public?${params.toString()}`,
      env,
    );
    const threads = Array.isArray(archive?.threads) ? archive.threads : [];
    for (const thread of threads) {
      if (seen.has(String(thread?.id || ""))) continue;
      seen.add(String(thread.id));
      scanned += 1;
      const result = await observeTaskThreadV47(gateway, thread);
      if (result?.ok) matched += 1;
    }

    if (!archive?.has_more || !threads.length) break;
    const last = threads[threads.length - 1];
    before = last?.thread_metadata?.archive_timestamp || null;
    if (!before) break;
  }

  const state = {
    scanned,
    matched,
    completed_at: new Date().toISOString(),
  };
  await gateway.ctx.storage.put(TASK_SCAN_STATE_KEY, state);
  return state;
}

export async function getTaskStageMapV47(gateway) {
  const rows = await gateway.ctx.storage.list({ prefix: TASK_STAGE_PREFIX });
  const result = {};
  for (const [key, value] of rows.entries()) {
    const id = String(key).slice(TASK_STAGE_PREFIX.length);
    if (id) result[id] = value;
  }
  return result;
}

export async function getTaskStageV47(gateway, discordUserId) {
  return (await gateway.ctx.storage.get(`${TASK_STAGE_PREFIX}${String(discordUserId || "")}`)) || null;
}

async function getTaskTagMap(gateway, { force = false } = {}) {
  const cached = await gateway.ctx.storage.get(TASK_TAG_CACHE_KEY);
  if (
    !force &&
    cached?.tags &&
    Number.isFinite(Date.parse(cached.updated_at)) &&
    Date.parse(cached.updated_at) > Date.now() - 6 * 60 * 60 * 1000
  ) return cached.tags;

  const forum = await discordJson(`${DISCORD_API}/channels/${ACTIVATION_DESTINATIONS.training}`, gateway.env);
  const tags = {};
  for (const tag of Array.isArray(forum?.available_tags) ? forum.available_tags : []) {
    if (tag?.id && tag?.name) tags[String(tag.id)] = String(tag.name);
  }
  await gateway.ctx.storage.put(TASK_TAG_CACHE_KEY, {
    tags,
    updated_at: new Date().toISOString(),
  });
  return tags;
}

export function parseTaskStage(label) {
  const text = String(label || "").trim();
  if (!text) return null;
  const numbered = /#\s*(\d+)/i.exec(text);
  if (numbered) {
    const stage = Number(numbered[1]);
    if (Number.isFinite(stage) && stage >= 1 && stage <= 99) return { stage, label: text };
  }
  const month = /month\s*(\d+)/i.exec(text);
  if (month) {
    const monthNumber = Number(month[1]);
    if (Number.isFinite(monthNumber) && monthNumber >= 1 && monthNumber <= 24) {
      // Month phases come after the seven Fundamentals tasks. The numeric stage
      // is internal ordering only; the member-facing digest uses the real tag label.
      return { stage: 7 + monthNumber, label: text };
    }
  }
  return null;
}

async function discordJson(url, env, options = {}) {
  let attempt = 0;
  while (attempt < 4) {
    attempt += 1;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (response.status === 429) {
      const body = await response.clone().json().catch(() => null);
      const retryMs = Math.max(1000, Math.ceil(Number(body?.retry_after || 1) * 1000));
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }
    if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 240)}`);
    return response.status === 204 ? null : response.json();
  }
  throw new Error("Discord API rate limit retry exhausted.");
}

function normalizeIso(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export const __test = Object.freeze({
  parseTaskStage,
});

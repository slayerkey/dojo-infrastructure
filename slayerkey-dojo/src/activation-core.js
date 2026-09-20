const DISCORD_API = "https://discord.com/api/v10";
export const STORAGE_PREFIX = "activation:v3:";
export const MEMBER_PREFIX = `${STORAGE_PREFIX}member:`;
export const THREAD_PREFIX = `${STORAGE_PREFIX}thread:`;
export const SEVEN_DAYS_MS = 7 * 86400000;

export const ACTIVATION_DESTINATIONS = Object.freeze({
  introductions: "1540019496314474566",
  general: "1532854321723478217",
  goals: "1538607897658003546",
  wins: "1532854569946583300",
  training: "1541188454010978315",
});

const DESTINATION_BY_ID = new Map(Object.entries(ACTIVATION_DESTINATIONS).map(([key, id]) => [String(id), key]));

export async function noteThreadEvent(gateway, payload) {
  if (!payload?.id) return;
  const parentId = String(payload.parent_id || "");
  await gateway.ctx.storage.put(`${THREAD_PREFIX}${payload.id}`, {
    parent_id: parentId || null,
    destination_key: DESTINATION_BY_ID.get(parentId) || null,
    owner_id: payload.owner_id ? String(payload.owner_id) : null,
    updated_at: new Date().toISOString(),
  });
}

export async function recordLiveActivationMessage(gateway, message) {
  const userId = String(message?.author?.id || "");
  if (!userId || message?.author?.bot) return { recorded: false, reason: "not_human" };
  const context = await resolveMessageContext(gateway, message);
  if (!context?.destination_key) return { recorded: false, reason: "not_activation_destination" };

  const tenure = await gateway.getTenureRecord?.(userId).catch(() => null);
  let record = await gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`);
  record = mergeTenureIntoRecord(record, userId, tenure);
  if (!record.activation_started_at) {
    record.unknown_anchor_activity_seen_at = earliestIso(record.unknown_anchor_activity_seen_at, message.timestamp);
    record.updated_at = new Date().toISOString();
    await gateway.ctx.storage.put(`${MEMBER_PREFIX}${userId}`, record);
    return { recorded: false, reason: "unknown_anchor" };
  }

  const next = applyActivationMessage(record, {
    message,
    destinationKey: context.destination_key,
    threadOwnerId: context.owner_id || null,
  });
  await gateway.ctx.storage.put(`${MEMBER_PREFIX}${userId}`, next);
  return { recorded: true, destination: context.destination_key };
}

export async function observeRiotLink(gateway, discordUserId, source = "observed") {
  const userId = String(discordUserId || "");
  if (!userId || !gateway.env?.RR_TRACKER?.getCurrentRiotLink) return { ok: false, reason: "tracker_unavailable" };
  const result = await gateway.env.RR_TRACKER.getCurrentRiotLink(userId).catch(() => null);
  const tenure = await gateway.getTenureRecord?.(userId).catch(() => null);
  let record = await gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`);
  record = mergeTenureIntoRecord(record, userId, tenure);
  record.riot_link_checked_at = new Date().toISOString();
  record.riot_linked_current = Boolean(result?.ok);
  if (result?.ok && !record.riot_linked_observed_at) {
    record.riot_linked_observed_at = record.riot_link_checked_at;
    record.riot_linked_source = source;
  }
  record.updated_at = new Date().toISOString();
  await gateway.ctx.storage.put(`${MEMBER_PREFIX}${userId}`, record);
  return { ok: true, linked: Boolean(result?.ok) };
}

export async function seedTenureRecords(gateway) {
  const tenures = await gateway.listTenureRecords?.().catch(() => []);
  for (const tenure of Array.isArray(tenures) ? tenures : []) {
    const userId = String(tenure?.discord_user_id || "");
    if (!userId) continue;
    const current = await gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`);
    await gateway.ctx.storage.put(`${MEMBER_PREFIX}${userId}`, mergeTenureIntoRecord(current, userId, tenure));
  }
  return Array.isArray(tenures) ? tenures.length : 0;
}

export async function buildActivationAudit(gateway) {
  const [stored, tenures] = await Promise.all([
    gateway.ctx.storage.list({ prefix: MEMBER_PREFIX }),
    gateway.listTenureRecords?.().catch(() => []),
  ]);
  const tenureById = new Map((Array.isArray(tenures) ? tenures : []).map((t) => [String(t?.discord_user_id || ""), t]));
  const records = [];
  for (const [key, value] of stored.entries()) {
    const userId = String(key).slice(MEMBER_PREFIX.length);
    records.push(mergeTenureIntoRecord(value, userId, tenureById.get(userId) || null));
    tenureById.delete(userId);
  }
  for (const [userId, tenure] of tenureById) if (userId) records.push(mergeTenureIntoRecord(null, userId, tenure));
  return buildAuditModel(records);
}

export function applyActivationMessage(record, { message, destinationKey, threadOwnerId = null }) {
  const next = { ...(record || {}) };
  const userId = String(message?.author?.id || next.discord_user_id || "");
  const timestamp = validIso(message?.timestamp) ? new Date(message.timestamp).toISOString() : null;
  const anchor = validIso(next.activation_started_at) ? new Date(next.activation_started_at).toISOString() : null;
  if (!userId || !timestamp || !anchor || Date.parse(timestamp) < Date.parse(anchor)) return next;

  const isThread = Boolean(threadOwnerId);
  const isThreadOwner = !isThread || String(threadOwnerId) === userId;
  const referencedAuthor = String(message?.referenced_message?.author?.id || "");

  if (destinationKey === "introductions") {
    if (isThread) {
      if (isThreadOwner) next.introduction_at = earliestIso(next.introduction_at, timestamp);
      else addIntroInteraction(next, String(threadOwnerId), timestamp, userId);
    } else if (message?.message_reference?.message_id) {
      if (referencedAuthor && referencedAuthor !== userId) addIntroInteraction(next, referencedAuthor, timestamp, userId);
    } else {
      next.introduction_at = earliestIso(next.introduction_at, timestamp);
    }
  } else if (destinationKey === "training" && isThreadOwner) {
    next.first_training_post_at = earliestIso(next.first_training_post_at, timestamp);
  } else if (destinationKey === "general") {
    next.first_general_message_at = earliestIso(next.first_general_message_at, timestamp);
  } else if (destinationKey === "goals" && isThreadOwner) {
    next.first_goal_at = earliestIso(next.first_goal_at, timestamp);
  } else if (destinationKey === "wins" && isThreadOwner) {
    next.first_win_at = earliestIso(next.first_win_at, timestamp);
  }
  next.updated_at = new Date().toISOString();
  return next;
}

function addIntroInteraction(record, targetId, timestamp, selfId) {
  if (!targetId || targetId === selfId) return;
  const targets = Array.isArray(record.intro_reply_targets) ? record.intro_reply_targets.map((v) => ({ ...v })) : [];
  const existing = targets.find((v) => String(v.user_id) === targetId);
  if (existing) existing.at = earliestIso(existing.at, timestamp);
  else targets.push({ user_id: targetId, at: timestamp });
  targets.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
  record.intro_reply_targets = targets;
  if (targets.length >= 2) record.replied_to_two_members_at = targets[1]?.at || null;
}

export function mergeTenureIntoRecord(record, userId, tenure) {
  const current = { ...(record || {}) };
  current.version = 3;
  current.discord_user_id = String(userId || current.discord_user_id || "");
  if (!current.created_at) current.created_at = new Date().toISOString();
  if (validIso(tenure?.first_eligible_at)) {
    current.activation_started_at = new Date(tenure.first_eligible_at).toISOString();
    current.activation_anchor_source = "tenure.first_eligible_at";
  } else if (!current.activation_started_at) {
    current.activation_started_at = null;
    current.activation_anchor_source = "unknown";
  }
  if (tenure && typeof tenure.active === "boolean") current.membership_active = tenure.active;
  current.updated_at = new Date().toISOString();
  return current;
}

export function deriveMember(record) {
  const anchor = validIso(record?.activation_started_at) ? new Date(record.activation_started_at).toISOString() : null;
  const firstWin = qualifiedAt(record?.first_win_at, anchor);
  const intro = qualifiedAt(record?.introduction_at, anchor);
  const training = qualifiedAt(record?.first_training_post_at, anchor);
  const general = qualifiedAt(record?.first_general_message_at, anchor);
  const goal = qualifiedAt(record?.first_goal_at, anchor);
  const twoReplies = qualifiedAt(record?.replied_to_two_members_at, anchor);
  const withinSeven = Boolean(firstWin && Date.parse(firstWin) <= Date.parse(anchor) + SEVEN_DAYS_MS);
  return {
    discord_user_id: String(record?.discord_user_id || ""), membership_active: record?.membership_active ?? null,
    activation_started_at: anchor, anchor_valid: Boolean(anchor),
    introduction_posted: Boolean(intro), replied_to_two_members: Boolean(twoReplies),
    first_training_post: Boolean(training), first_general_message: Boolean(general), goal_posted: Boolean(goal),
    first_win_posted: Boolean(firstWin), first_win_within_7_days: withinSeven,
    riot_linked: Boolean(record?.riot_linked_observed_at || record?.riot_linked_current),
    introduction_at: intro, replied_to_two_members_at: twoReplies, first_training_post_at: training,
    first_general_message_at: general, first_goal_at: goal, first_win_at: firstWin,
  };
}

export function buildAuditModel(records) {
  const members = records.filter((r) => r?.discord_user_id).map(deriveMember);
  const valid = members.filter((m) => m.anchor_valid);
  const definitions = [
    ["introduction_posted", "Introduction posted"], ["replied_to_two_members", "Replied to 2 members"],
    ["first_training_post", "First training post"], ["riot_linked", "Riot link observed"],
    ["first_general_message", "First general message"], ["goal_posted", "Goal posted"],
    ["first_win_posted", "First win posted"], ["first_win_within_7_days", "First win within 7 days"],
  ];
  const metrics = definitions.map(([key, label]) => {
    const population = key === "riot_linked" ? members : valid;
    const numerator = population.filter((m) => m[key]).length;
    return { key, label, numerator, denominator: population.length, percentage: population.length ? Math.round(numerator / population.length * 1000) / 10 : null };
  });
  const trainingHours = valid.filter((m) => m.first_training_post_at).map((m) => hoursBetween(m.activation_started_at, m.first_training_post_at)).filter(Number.isFinite);
  const winHours = valid.filter((m) => m.first_win_at).map((m) => hoursBetween(m.activation_started_at, m.first_win_at)).filter(Number.isFinite);
  return { generated_at: new Date().toISOString(), total_members: members.length, valid_anchor_members: valid.length,
    unknown_anchor_members: members.length - valid.length, metrics, median_hours_to_training: median(trainingHours), median_hours_to_win: median(winHours), members,
    riot_note: "Phase 1 Riot history is positive-only: current/prospectively observed links count as reached; an unlinked current state does not prove the member never linked before." };
}

async function resolveMessageContext(gateway, message) {
  const channelId = String(message?.channel_id || "");
  const direct = DESTINATION_BY_ID.get(channelId);
  if (direct) return { destination_key: direct, owner_id: null, parent_id: null };
  if (!channelId) return null;
  const cacheKey = `${THREAD_PREFIX}${channelId}`;
  const cached = await gateway.ctx.storage.get(cacheKey);
  if (cached) return cached.destination_key ? cached : null;
  const response = await fetch(`${DISCORD_API}/channels/${channelId}`, { headers: { Authorization: `Bot ${gateway.env.DISCORD_BOT_TOKEN}` } }).catch(() => null);
  if (!response?.ok) return null;
  const channel = await response.json();
  const parentId = String(channel?.parent_id || "");
  const value = { parent_id: parentId || null, destination_key: DESTINATION_BY_ID.get(parentId) || null,
    owner_id: channel?.owner_id ? String(channel.owner_id) : null, updated_at: new Date().toISOString() };
  await gateway.ctx.storage.put(cacheKey, value);
  return value.destination_key ? value : null;
}

function qualifiedAt(value, anchor) { return validIso(value) && validIso(anchor) && Date.parse(value) >= Date.parse(anchor) ? new Date(value).toISOString() : null; }
export function earliestIso(a, b) { const av = validIso(a) ? new Date(a).toISOString() : null; const bv = validIso(b) ? new Date(b).toISOString() : null; if (!av) return bv; if (!bv) return av; return Date.parse(av) <= Date.parse(bv) ? av : bv; }
function validIso(value) { return Boolean(value) && Number.isFinite(Date.parse(value)); }
function hoursBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / 3600000; }
function median(values) { if (!values.length) return null; const s = values.slice().sort((a,b)=>a-b), m=Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }

export const __test = Object.freeze({ applyActivationMessage, buildAuditModel, deriveMember, earliestIso, mergeTenureIntoRecord });

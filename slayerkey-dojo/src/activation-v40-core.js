export const DAY_MS = 86400000;
export const PHOENIX_OFFSET_MS = 7 * 60 * 60 * 1000;
export const CHECKIN_SNOOZE_MS = 7 * DAY_MS;

export function identityFromGuildMember(member, now = new Date().toISOString()) {
  const user = member?.user || {};
  return normalizeIdentity({
    discord_user_id: String(user?.id || ""),
    display_name: clean(member?.nick),
    global_name: clean(user?.global_name),
    username: clean(user?.username),
    last_identity_seen_at: now,
  });
}

export function identityFromMessage(message, now = new Date().toISOString()) {
  const author = message?.author || {};
  return normalizeIdentity({
    discord_user_id: String(author?.id || ""),
    display_name: clean(message?.member?.nick),
    global_name: clean(author?.global_name),
    username: clean(author?.username),
    last_identity_seen_at: now,
  });
}

export function mergeIdentityIntoRecord(record, identity) {
  const next = { ...(record || {}) };
  const value = normalizeIdentity(identity);
  if (!value.discord_user_id && !next.discord_user_id) return next;
  if (value.discord_user_id) next.discord_user_id = value.discord_user_id;
  for (const key of ["display_name", "global_name", "username", "last_identity_seen_at"]) {
    if (value[key]) next[key] = value[key];
  }
  return next;
}

export function resolveDisplayName(discordUserId, currentIdentity = null, storedRecord = null) {
  const id = String(discordUserId || currentIdentity?.discord_user_id || storedRecord?.discord_user_id || "");
  const candidates = [
    currentIdentity?.display_name,
    currentIdentity?.global_name,
    currentIdentity?.username,
    storedRecord?.display_name,
    storedRecord?.global_name,
    storedRecord?.username,
  ];
  for (const candidate of candidates) {
    const value = clean(candidate);
    if (value) return value;
  }
  return `Unknown member · Discord ID: ${id || "unknown"}`;
}

export function previousSevenPhoenixDateKeys(now = new Date()) {
  const shifted = new Date(now.getTime() - PHOENIX_OFFSET_MS);
  const localMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  const keys = [];
  for (let daysAgo = 1; daysAgo <= 7; daysAgo += 1) {
    keys.push(new Date(localMidnightUtc - daysAgo * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

export function summarizeActivity(currentMembers, totals = {}) {
  const byUser = {};
  let zero = 0;
  let low = 0;
  let active = 0;
  for (const member of Array.isArray(currentMembers) ? currentMembers : []) {
    const id = String(member?.user?.id || member?.discord_user_id || "");
    if (!id) continue;
    const count = Math.max(0, Number(totals?.[id] || 0));
    byUser[id] = count;
    if (count === 0) zero += 1;
    else if (count < 5) low += 1;
    else active += 1;
  }
  return { total: zero + low + active, zero, low, active, by_user: byUser };
}

export function buildActivationV40Model({
  records = [],
  currentMembers = [],
  totals = {},
  interventions = {},
  now = new Date(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const recordById = new Map(
    (Array.isArray(records) ? records : [])
      .filter((record) => record?.discord_user_id)
      .map((record) => [String(record.discord_user_id), record]),
  );
  const activity = summarizeActivity(currentMembers, totals);
  const currentIdentities = new Map();
  for (const member of Array.isArray(currentMembers) ? currentMembers : []) {
    const identity = identityFromGuildMember(member, new Date(safeNowMs).toISOString());
    if (identity.discord_user_id) currentIdentities.set(identity.discord_user_id, identity);
  }

  const queue = { day3: [], day7: [], stuck: [], dormant: [], attention: [] };
  let activatedWithinSeven = 0;
  let activationDenominator = 0;
  let everWin = 0;
  let stillNeedFirstWin = 0;
  let unknownStart = 0;

  for (const [userId, currentIdentity] of currentIdentities) {
    const record = recordById.get(userId) || { discord_user_id: userId };
    const anchor = validIso(record.activation_started_at) ? new Date(record.activation_started_at).toISOString() : null;
    const firstWin = qualifiedAt(record.first_win_at, anchor);
    const training = qualifiedAt(record.first_training_post_at, anchor);
    const goal = qualifiedAt(record.first_goal_at, anchor);
    const elapsedMs = anchor ? Math.max(0, safeNowMs - Date.parse(anchor)) : null;
    const elapsedDays = Number.isFinite(elapsedMs) ? Math.floor(elapsedMs / DAY_MS) : null;
    const withinSeven = Boolean(firstWin && Date.parse(firstWin) <= Date.parse(anchor) + 7 * DAY_MS);
    const activityCount = Number(activity.by_user[userId] || 0);
    const intervention = interventions?.[userId] || null;
    const snoozed = Boolean(
      validIso(intervention?.snooze_until) &&
      Date.parse(intervention.snooze_until) > safeNowMs,
    );
    const recentDay7Contact = Boolean(
      intervention?.status === "contacted_day7" &&
      validIso(intervention?.last_intervention_at) &&
      Date.parse(intervention.last_intervention_at) > safeNowMs - 7 * DAY_MS,
    );
    const displayName = resolveDisplayName(userId, currentIdentity, record);

    if (!anchor) unknownStart += 1;
    if (firstWin) everWin += 1;
    else stillNeedFirstWin += 1;

    if (anchor && elapsedMs >= 7 * DAY_MS) {
      activationDenominator += 1;
      if (withinSeven) activatedWithinSeven += 1;
    }

    const entry = {
      discord_user_id: userId,
      display_name: displayName,
      activation_started_at: anchor,
      days_since_activation: elapsedDays,
      first_training_post: Boolean(training),
      goal_posted: Boolean(goal),
      first_win_posted: Boolean(firstWin),
      first_win_within_7_days: withinSeven,
      messages_last_7_days: activityCount,
      last_intervention: intervention?.last_action || null,
      last_intervention_at: intervention?.last_intervention_at || null,
      status: intervention?.status || null,
      snooze_until: intervention?.snooze_until || null,
    };

    if (snoozed) continue;

    const isStuck = !firstWin && intervention?.status === "stuck";
    const isDay7NoWin = !firstWin && anchor && elapsedMs >= 7 * DAY_MS;
    const isDay3NoWin = !firstWin && anchor && elapsedMs >= 3 * DAY_MS && elapsedMs < 7 * DAY_MS;
    const isDormant = activityCount === 0;

    // These signals deliberately overlap. A member can be both "no first win"
    // and "0 messages in 7 days"; hiding one behind the other made the old
    // "Dormant" count misleading.
    if (isStuck) queue.stuck.push(entry);
    if (isDay7NoWin && !recentDay7Contact) queue.day7.push(entry);
    if (
      isDay3NoWin &&
      intervention?.status !== "contacted_day3" &&
      intervention?.status !== "contacted_day7"
    ) {
      queue.day3.push(entry);
    }
    if (isDormant) queue.dormant.push(entry);

    if (isStuck || isDay7NoWin || isDay3NoWin || isDormant) {
      queue.attention.push({
        ...entry,
        needs_first_win: !firstWin && Boolean(anchor) && elapsedMs >= 3 * DAY_MS,
        no_win_stage: isDay7NoWin ? "day7" : (isDay3NoWin ? "day3" : null),
        dormant: isDormant,
        stuck: isStuck,
      });
    }
  }

  for (const [key, list] of Object.entries(queue)) {
    list.sort((a, b) => {
      if (key === "attention") {
        const aPriority =
          (a.needs_first_win && a.dormant ? 4 : 0) +
          (a.no_win_stage === "day7" ? 2 : a.no_win_stage === "day3" ? 1 : 0) +
          (a.dormant ? 1 : 0);
        const bPriority =
          (b.needs_first_win && b.dormant ? 4 : 0) +
          (b.no_win_stage === "day7" ? 2 : b.no_win_stage === "day3" ? 1 : 0) +
          (b.dormant ? 1 : 0);
        if (aPriority !== bPriority) return bPriority - aPriority;
      }
      const aDays = Number.isFinite(a.days_since_activation) ? a.days_since_activation : -1;
      const bDays = Number.isFinite(b.days_since_activation) ? b.days_since_activation : -1;
      return bDays - aDays || a.display_name.localeCompare(b.display_name);
    });
  }

  return {
    generated_at: new Date(safeNowMs).toISOString(),
    current_members: currentIdentities.size,
    historical_members: recordById.size,
    unknown_current_start: unknownStart,
    activated_within_7_days: activatedWithinSeven,
    activation_denominator: activationDenominator,
    ever_posted_win: everWin,
    still_need_first_win: stillNeedFirstWin,
    engagement: activity,
    queue,
    needs_action: {
      day3: queue.day3.length,
      day7: queue.day7.length,
      stuck: queue.stuck.length,
      dormant: queue.dormant.length,
    },
  };
}

export function applyInterventionAction(previous, action, now = new Date().toISOString(), interactionId = null) {
  const current = { ...(previous || {}) };
  const id = interactionId ? String(interactionId) : null;
  if (id && current.last_interaction_id === id) {
    return { state: current, duplicate: true };
  }
  const timestamp = validIso(now) ? new Date(now).toISOString() : new Date().toISOString();
  const next = {
    ...current,
    last_action: action,
    last_intervention_at: timestamp,
    last_interaction_id: id,
  };

  if (action === "stuck") {
    next.status = "stuck";
    next.snooze_until = null;
  } else if (action === "snooze") {
    next.status = "snoozed";
    next.snooze_until = new Date(Date.parse(timestamp) + CHECKIN_SNOOZE_MS).toISOString();
  } else if (action === "win") {
    next.status = "activated";
    next.snooze_until = null;
  } else if (action === "contacted_day3" || action === "contacted_day7") {
    next.status = action;
    next.snooze_until = null;
  }
  return { state: next, duplicate: false };
}

export function validateTeamApplication(input = {}) {
  const region = clean(input.region)?.toUpperCase();
  const currentRank = clean(input.current_rank);
  const peakRank = clean(input.peak_rank);
  const roleAgents = clean(input.role_agents);
  const availability = clean(input.availability);
  const trackerLink = clean(input.tracker_link);
  const goal = clean(input.team_goal);

  if (!["NA", "EU"].includes(region)) throw new Error("Region must be NA or EU.");
  if (!currentRank || currentRank.length > 40) throw new Error("Current rank is required and must be 40 characters or fewer.");
  if (!peakRank || peakRank.length > 40) throw new Error("Peak rank is required and must be 40 characters or fewer.");
  if (!roleAgents || roleAgents.length > 200) throw new Error("Main role / agents is required and must be 200 characters or fewer.");
  if (!availability || availability.length > 400) throw new Error("Availability is required and must be 400 characters or fewer.");
  if (!trackerLink || trackerLink.length > 500 || !/^https?:\/\//i.test(trackerLink)) {
    throw new Error("Tracker link must be a valid http(s) URL.");
  }
  if (!goal || goal.length > 800) throw new Error("Team goal is required and must be 800 characters or fewer.");

  return {
    region,
    current_rank: currentRank,
    peak_rank: peakRank,
    role_agents: roleAgents,
    availability,
    tracker_link: trackerLink,
    team_goal: goal,
  };
}

export function isPrivateTextChannel(channel, guildId, parent = null) {
  if (Number(channel?.type) !== 0) return false;
  const everyoneId = String(guildId || "");
  if (!everyoneId) return false;

  // A channel-level @everyone overwrite takes precedence over the parent category.
  // This avoids accepting a channel that explicitly re-allows View Channel inside
  // an otherwise private category.
  const direct = everyoneViewState(channel?.permission_overwrites, everyoneId);
  if (direct) return direct === "deny";
  return everyoneViewState(parent?.permission_overwrites, everyoneId) === "deny";
}

function everyoneViewState(overwrites, everyoneId) {
  const row = (Array.isArray(overwrites) ? overwrites : [])
    .find((item) => String(item?.id || "") === everyoneId && Number(item?.type) === 0);
  if (!row) return null;
  try {
    const deny = BigInt(String(row.deny || "0"));
    const allow = BigInt(String(row.allow || "0"));
    if ((deny & 1024n) === 1024n) return "deny";
    if ((allow & 1024n) === 1024n) return "allow";
    return null;
  } catch {
    return null;
  }
}

export function formatPercent(numerator, denominator) {
  if (!denominator) return "n/a";
  return `${Math.round((Number(numerator) / Number(denominator)) * 1000) / 10}%`;
}

function normalizeIdentity(identity = {}) {
  return {
    discord_user_id: String(identity?.discord_user_id || ""),
    display_name: clean(identity?.display_name),
    global_name: clean(identity?.global_name),
    username: clean(identity?.username),
    last_identity_seen_at: validIso(identity?.last_identity_seen_at)
      ? new Date(identity.last_identity_seen_at).toISOString()
      : null,
  };
}

function qualifiedAt(value, anchor) {
  if (!validIso(value) || !validIso(anchor)) return null;
  if (Date.parse(value) < Date.parse(anchor)) return null;
  return new Date(value).toISOString();
}

function clean(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function validIso(value) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

export const __test = Object.freeze({
  qualifiedAt,
  validIso,
});

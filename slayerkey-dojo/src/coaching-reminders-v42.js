const DISCORD_API = "https://discord.com/api/v10";
const GUILD_ID = "1494446702378221590";
const REFERENCE_EVENT_ID = "1533227276974555176";
const CLASSROOM_VC = "https://discord.com/channels/1494446702378221590/1530226054210261032";
const GENERAL_CHANNEL_ID = "1532854321723478217";
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_DRIFT_MS = 3 * MINUTE_MS;

// Existing weekly coaching call: Saturdays at noon, Arizona local time.
// Send one reminder 30 minutes before the scheduled Discord event.
const SLOTS = Object.freeze([
  { minuteOfDay: 11 * 60 + 30, beforeMinutes: 30, label: "30 MINUTES" },
]);

export function dueCoachingSlot(now) {
  const phoenix = new Date(now.getTime() - SEVEN_HOURS_MS);
  if (phoenix.getUTCDay() !== 6) return null;
  const minuteOfDay = phoenix.getUTCHours() * 60 + phoenix.getUTCMinutes();
  return SLOTS.find((slot) => Math.abs(slot.minuteOfDay - minuteOfDay) <= 2) || null;
}

export function selectCoachingEvent(events, now, slot) {
  const list = Array.isArray(events) ? events : [];
  const candidates = list
    .filter((event) => Number(event?.status) === 1)
    .map((event) => ({
      event,
      startMs: Date.parse(String(event?.scheduled_start_time || "")),
    }))
    .filter(({ event, startMs }) =>
      Number.isFinite(startMs) &&
      Math.abs(startMs - now.getTime() - slot.beforeMinutes * MINUTE_MS) <= MAX_DRIFT_MS &&
      (String(event.id) === REFERENCE_EVENT_ID || /coaching|office[\s-]*hours?/i.test(String(event.name || "")))
    );
  // Fail closed if more than one plausible call is at the same time.
  const exact = candidates.filter(({ event }) => String(event.id) === REFERENCE_EVENT_ID);
  const pool = exact.length ? exact : candidates;
  return pool.length === 1 ? pool[0].event : null;
}

export function buildCoachingReminder(slot, event, guildId = GUILD_ID) {
  const eventUrl = "https://discord.com/events/" + guildId + "/" + event.id;
  return [
    "@everyone **COACHING CALL STARTS IN " + slot.label + "**",
    "Bring any clips or questions — we\'ll go through them live in **Classroom VC**.",
    "**Discord event:** " + eventUrl,
    "**Join the VC:** " + CLASSROOM_VC,
  ].join("\n");
}

async function discordJson(url, env, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: "Bot " + env.DISCORD_BOT_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error("Discord API " + response.status + ": " + (await response.text()).slice(0, 240));
  }
  return response.status === 204 ? null : response.json();
}

export async function runCoachingReminderScheduler(env, stub, now = new Date(), api = discordJson) {
  const slot = dueCoachingSlot(now);
  if (!slot) return { skipped: "outside_reminder_window" };
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID || !stub) {
    return { skipped: "missing_discord_configuration" };
  }
  const guildId = String(env.DISCORD_GUILD_ID);
  if (guildId !== GUILD_ID) return { skipped: "unexpected_guild" };

  const events = await api(DISCORD_API + "/guilds/" + guildId + "/scheduled-events", env);
  const event = selectCoachingEvent(events, now, slot);
  if (!event) return { skipped: "matching_live_coaching_event_not_found" };

  // General is the explicitly confirmed destination. Never fall back to #announcements.
  const channelId = GENERAL_CHANNEL_ID;

  const reminderKey = "coaching:v42:" + event.id + ":" + event.scheduled_start_time + ":" + slot.beforeMinutes;
  if (!(await stub.claimCoachingReminder(reminderKey))) return { skipped: "already_sent" };

  try {
    const payload = {
      content: buildCoachingReminder(slot, event, guildId),
      allowed_mentions: { parse: ["everyone"] },
    };
    await api(DISCORD_API + "/channels/" + channelId + "/messages", env, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { sent: true, channel_id: channelId, reminder: slot.beforeMinutes, event_id: String(event.id) };
  } catch (error) {
    // Retry on the next minute if Discord rejects or times out the send.
    await stub.releaseCoachingReminder(reminderKey).catch(() => {});
    throw error;
  }
}

export async function claimCoachingReminder(gateway, key) {
  return gateway.ctx.storage.transaction(async (txn) => {
    if (await txn.get(key)) return false;
    await txn.put(key, { claimed_at: new Date().toISOString() });
    return true;
  });
}

export async function releaseCoachingReminder(gateway, key) {
  await gateway.ctx.storage.delete(key);
}
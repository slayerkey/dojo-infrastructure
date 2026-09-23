import legacy, { DiscordGateway as DiscordGatewayV25 } from "./index-v25.js";
import { identityFromGuildMember, resolveDisplayName, summarizeActivity } from "./activation-v40-core.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const encoder = new TextEncoder();
const PHOENIX_OFFSET_MS = 7 * 60 * 60 * 1000;
const LOW_ACTIVITY_THRESHOLD = 5;

const ACTIVITY_COMMANDS = [
  {
    name: "activitysetup",
    description: "Post the weekly Dojo inactivity report in this channel at this time",
    type: 1,
  },
  {
    name: "activitycheck",
    description: "Post the Dojo activity report now",
    type: 1,
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegated = request.clone();
      let rawBody;
      let interaction;
      try {
        rawBody = await request.text();
        interaction = JSON.parse(rawBody);
      } catch {
        return legacy.fetch(delegated, env, ctx);
      }

      const command = interaction.type === 2 ? String(interaction.data?.name || "") : "";
      if (command !== "activitysetup" && command !== "activitycheck") {
        return legacy.fetch(delegated, env, ctx);
      }

      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      const userId = getInteractionUserId(interaction);
      if (!userId || userId !== String(env.DISCORD_OWNER_USER_ID || "")) {
        return ephemeralMessage("Only the Dojo owner can use this command.");
      }
      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This command only works in the Slayerkey Discord server.");
      }

      const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
      if (!stub) return ephemeralMessage("Activity tracking storage is unavailable.");

      if (command === "activitysetup") {
        const now = new Date();
        const schedule = phoenixScheduleParts(now);
        await stub.setActivityConfig({
          enabled: true,
          channel_id: String(interaction.channel_id || ""),
          weekday: schedule.weekday,
          hour: schedule.hour,
          minute: schedule.minute,
          configured_at: now.toISOString(),
        });
        return ephemeralMessage(
          `Weekly Dojo activity reports are set for this channel every **${schedule.weekday_name} at ${formatClock(schedule.hour, schedule.minute)} Arizona time**. Run **/activitycheck** anytime for a report right now.`,
        );
      }

      ctx.waitUntil(
        postActivityReport(env, String(interaction.channel_id || ""), { manual: true })
          .then((summary) => editOriginalInteraction(interaction, env, {
            content: `Activity report posted. **${summary.zero}** had 0 messages, **${summary.low}** had 1–4, and **${summary.active}** had 5+.`,
          }))
          .catch(async (error) => {
            console.error("activitycheck failed:", error);
            await editOriginalInteraction(interaction, env, {
              content: `Activity check failed: ${safeError(error)}`,
            }).catch(() => {});
          }),
      );
      return Response.json({ type: 5, data: { flags: EPHEMERAL } });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.activity_check = {
          version: "v26",
          scope: "members with the Dojo role only",
          message_content_stored: false,
          thresholds: { inactive: 0, low_activity: "1-4" },
          report_window: "previous 7 completed Arizona calendar days",
          commands: ["/activitysetup", "/activitycheck"],
        };
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const tasks = [runActivityScheduler(env)];
    if (typeof legacy.scheduled === "function") {
      tasks.push(Promise.resolve(legacy.scheduled(controller, env, ctx)));
    }
    await Promise.allSettled(tasks);
  },
};

export class DiscordGateway extends DiscordGatewayV25 {
  async handleGatewayMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {}

    if (
      payload?.op === 0 &&
      payload?.t === "MESSAGE_CREATE" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      !payload.d?.author?.bot
    ) {
      const roles = Array.isArray(payload.d?.member?.roles)
        ? payload.d.member.roles.map(String)
        : [];
      const dojoRoleId = String(this.env.DISCORD_DOJO_ROLE_ID || "");
      const userId = String(payload.d?.author?.id || "");
      if (dojoRoleId && userId && roles.includes(dojoRoleId)) {
        const timestamp = new Date(payload.d?.timestamp || Date.now());
        await this.incrementDojoActivity(userId, phoenixDateKey(timestamp));
      }
    }

    return super.handleGatewayMessage(raw);
  }

  async incrementDojoActivity(discordUserId, dateKey) {
    const id = String(discordUserId || "");
    const day = String(dateKey || "");
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false };
    const key = `activity:${day}:${id}`;
    const current = Number((await this.ctx.storage.get(key)) || 0);
    await this.ctx.storage.put(key, current + 1);
    return { ok: true, count: current + 1 };
  }

  async setActivityConfig(config) {
    const next = { ...(config || {}) };
    await this.ctx.storage.put("activity:config", next);
    if (next.configured_at) {
      await this.ctx.storage.put("activity:last_report_date", phoenixDateKey(new Date(next.configured_at)));
    }
    return { ok: true, config: next };
  }

  async getActivityConfig() {
    return (await this.ctx.storage.get("activity:config")) || null;
  }

  async claimActivityCommandDay(dayKey) {
    const key = "activity:commands:last_day";
    const current = await this.ctx.storage.get(key);
    if (String(current || "") === String(dayKey || "")) return false;
    await this.ctx.storage.put(key, String(dayKey || ""));
    return true;
  }

  async claimActivityReportDate(dateKey) {
    const key = "activity:last_report_date";
    const current = await this.ctx.storage.get(key);
    if (String(current || "") === String(dateKey || "")) return false;
    await this.ctx.storage.put(key, String(dateKey || ""));
    return true;
  }

  async releaseActivityReportDate(dateKey) {
    const key = "activity:last_report_date";
    const current = await this.ctx.storage.get(key);
    if (String(current || "") === String(dateKey || "")) await this.ctx.storage.delete(key);
    return true;
  }

  async getActivityCounts(dateKeys) {
    const totals = {};
    for (const dateKey of Array.isArray(dateKeys) ? dateKeys : []) {
      const rows = await this.ctx.storage.list({ prefix: `activity:${dateKey}:` });
      for (const [key, value] of rows) {
        const userId = String(key).split(":").pop();
        if (!userId) continue;
        totals[userId] = Number(totals[userId] || 0) + Number(value || 0);
      }
    }
    return totals;
  }

  async cleanupOldActivity(cutoffDateKey) {
    const rows = await this.ctx.storage.list({ prefix: "activity:" });
    const deletions = [];
    for (const [key] of rows) {
      const match = /^activity:(\d{4}-\d{2}-\d{2}):\d+$/.exec(String(key));
      if (match && match[1] < String(cutoffDateKey || "")) deletions.push(key);
    }
    if (deletions.length) await this.ctx.storage.delete(deletions);
    return { ok: true, deleted: deletions.length };
  }
}

async function runActivityScheduler(env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub || !env.DISCORD_BOT_TOKEN || !env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID) return;

  const now = new Date();
  const local = phoenixScheduleParts(now);
  const today = phoenixDateKey(now);

  const config = await stub.getActivityConfig().catch(() => null);
  if (!config?.enabled || !config.channel_id) return;

  const commandClaimed = await stub.claimActivityCommandDay(today).catch(() => false);
  if (commandClaimed) {
    await ensureActivityCommands(env).catch((error) => {
      console.error("Activity command registration failed:", error);
    });
  }
  if (
    Number(config.weekday) !== local.weekday ||
    Number(config.hour) !== local.hour ||
    Number(config.minute) !== local.minute
  ) return;

  const claimed = await stub.claimActivityReportDate(today).catch(() => false);
  if (!claimed) return;

  try {
    await postActivityReport(env, String(config.channel_id), { manual: false });
    const cutoff = phoenixDateKey(new Date(now.getTime() - 35 * 86400000));
    await stub.cleanupOldActivity(cutoff).catch(() => {});
  } catch (error) {
    await stub.releaseActivityReportDate(today).catch(() => {});
    console.error("Weekly activity report failed:", error);
    throw error;
  }
}

async function ensureActivityCommands(env) {
  const url = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
  const existing = await discordJson(url, env);
  const names = new Set((Array.isArray(existing) ? existing : []).map((item) => String(item?.name || "")));
  for (const command of ACTIVITY_COMMANDS) {
    if (names.has(command.name)) continue;
    await discordJson(url, env, {
      method: "POST",
      body: JSON.stringify(command),
      reason: `Register owner command /${command.name}`,
    });
  }
}

async function postActivityReport(env, channelId, { manual = false } = {}) {
  if (!channelId) throw new Error("No activity report channel is configured.");
  const members = await fetchDojoMembers(env);
  const dateKeys = previousSevenPhoenixDateKeys(new Date());
  const stub = env.DISCORD_GATEWAY.getByName("dojo-main");
  const totals = await stub.getActivityCounts(dateKeys);

  const summary = summarizeActivity(members, totals);
  const zero = [];
  const low = [];
  for (const member of members) {
    const id = String(member.user?.id || "");
    if (!id) continue;
    const count = Number(summary.by_user?.[id] || 0);
    const identity = identityFromGuildMember(member);
    const displayName = resolveDisplayName(id, identity, null);
    if (count === 0) zero.push({ id, count, display_name: displayName });
    else if (count < LOW_ACTIVITY_THRESHOLD) low.push({ id, count, display_name: displayName });
  }
  zero.sort((a, b) => a.display_name.localeCompare(b.display_name));
  low.sort((a, b) => a.count - b.count || a.display_name.localeCompare(b.display_name));

  const range = `${dateKeys[dateKeys.length - 1]} → ${dateKeys[0]}`;
  const lines = [
    `## ${manual ? "Dojo Activity Check" : "Weekly Dojo Activity Check"}`,
    `**Period:** ${range} (Arizona)`,
    `**Current Dojo members:** ${summary.total}`,
    `**0 messages:** ${summary.zero}`,
    `**1–4 messages:** ${summary.low}`,
    `**5+ messages:** ${summary.active}`,
    "",
  ];

  if (zero.length) {
    lines.push("### 🔴 No messages this week");
    for (const item of zero) lines.push(`${item.display_name} • 0 messages`);
    lines.push("");
  }
  if (low.length) {
    lines.push("### 🟡 Fewer than 5 messages");
    for (const item of low) lines.push(`${item.display_name} • ${item.count} message${item.count === 1 ? "" : "s"}`);
    lines.push("");
  }
  if (!zero.length && !low.length) {
    lines.push("✅ Everyone with the Dojo role sent at least 5 messages during this period.", "");
  }
  lines.push("Only current members with the Dojo role are included. Message content is not stored, only counts.");

  const chunks = chunkDiscordLines(lines, 1900);
  for (const content of chunks) await sendChannelMessage(channelId, content, env);
  return { checked: summary.total, zero: summary.zero, low: summary.low, active: summary.active };
}

async function fetchDojoMembers(env) {
  const dojoRoleId = String(env.DISCORD_DOJO_ROLE_ID || "");
  if (!dojoRoleId) throw new Error("DISCORD_DOJO_ROLE_ID is missing.");
  const result = [];
  let after = "0";

  while (true) {
    const url = `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members?limit=1000&after=${encodeURIComponent(after)}`;
    const page = await discordJson(url, env);
    if (!Array.isArray(page)) break;
    for (const member of page) {
      const roles = Array.isArray(member?.roles) ? member.roles.map(String) : [];
      if (!member?.user?.bot && roles.includes(dojoRoleId)) result.push(member);
    }
    if (page.length < 1000) break;
    const lastId = String(page[page.length - 1]?.user?.id || "");
    if (!lastId || lastId === after) break;
    after = lastId;
  }
  return result;
}

async function sendChannelMessage(channelId, content, env) {
  await discordJson(`${DISCORD_API}/channels/${channelId}/messages`, env, {
    method: "POST",
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
}

function previousSevenPhoenixDateKeys(now) {
  const shifted = new Date(now.getTime() - PHOENIX_OFFSET_MS);
  const localMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  const keys = [];
  for (let daysAgo = 1; daysAgo <= 7; daysAgo += 1) {
    keys.push(new Date(localMidnightUtc - daysAgo * 86400000).toISOString().slice(0, 10));
  }
  return keys;
}

function phoenixDateKey(date) {
  return new Date(date.getTime() - PHOENIX_OFFSET_MS).toISOString().slice(0, 10);
}

function phoenixScheduleParts(date) {
  const shifted = new Date(date.getTime() - PHOENIX_OFFSET_MS);
  const weekday = shifted.getUTCDay();
  return {
    weekday,
    weekday_name: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday],
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function formatClock(hour, minute) {
  const h = Number(hour);
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h % 12 || 12;
  return `${display}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function chunkDiscordLines(lines, maxLength) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function discordJson(url, env, options = {}) {
  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(options.reason);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = { ...(payload || {}), allowed_mentions: { parse: [] } };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not edit Discord interaction: ${response.status} ${(await response.text()).slice(0, 160)}`);
  }
}

async function verifyDiscordSignature(headers, rawBody, publicKeyHex) {
  const signature = headers.get("X-Signature-Ed25519");
  const timestamp = headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const normalized = String(hex || "").trim();
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error("Invalid hex value");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}
